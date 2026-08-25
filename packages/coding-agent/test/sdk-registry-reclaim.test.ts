import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentLifecycleManager } from "@san/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@san/coding-agent/registry/agent-registry";
import { createAgentSession } from "@san/coding-agent/sdk";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

/**
 * createAgentSession pre-registration vs. a pre-existing registry ref:
 * same-generation re-entry (revive/resume, same id + sessionFile) refreshes the
 * ref in place; a fresh construction over a provably dead parked corpse reclaims
 * it and registers a new generation; over a live/adopted/cold-revivable ref it
 * fails closed instead of silently overwriting the existing generation.
 */
describe("createAgentSession registry corpse handling", () => {
	const tempDirs: string[] = [];
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});
	afterAll(() => {
		sharedAuthStorage.close();
	});
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function makeTempProject(): { cwd: string; agentDir: string; sessionsDir: string } {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-reclaim-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		const sessionsDir = path.join(agentDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		return { cwd, agentDir, sessionsDir };
	}

	function commonSessionOptions(
		project: { cwd: string; agentDir: string },
		sessionManager: SessionManager,
		id: string,
	) {
		return {
			cwd: project.cwd,
			agentDir: project.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sessionManager,
			agentId: id,
			parentTaskPrefix: id,
		};
	}

	it("same-generation re-entry (revive/resume) refreshes the parked ref in place, preserving identity", async () => {
		const project = makeTempProject();
		const id = `Reentry-${Snowflake.next()}`;
		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file for the revived manager");

		// The parked corpse: same id, same sessionFile — the agent being revived.
		const corpse = AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const { session } = await createAgentSession(commonSessionOptions(project, manager, id));

		try {
			const ref = AgentRegistry.global().get(id);
			// The SAME ref object survived — identity and createdAt preserved.
			expect(ref).toBe(corpse);
			expect(ref?.createdAt).toBe(corpse.createdAt);
			expect(ref?.status).toBe("running");
			expect(ref?.session).toBe(session);
		} finally {
			await session.dispose();
		}
		// Dispose of a sub session unregisters the ref.
		expect(AgentRegistry.global().get(id)).toBeUndefined();
	});

	it("fresh construction over a provably dead parked corpse reclaims it and registers a new generation", async () => {
		const project = makeTempProject();
		const id = `Reclaim-${Snowflake.next()}`;
		// The persisted factory definitively declines: the corpse is dead.
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async () => undefined, 0);
		const corpse = AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/Corpse-Dead.jsonl",
			status: "parked",
		});

		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		const { session } = await createAgentSession(commonSessionOptions(project, manager, id));

		try {
			const ref = AgentRegistry.global().get(id);
			expect(ref).toBeDefined();
			expect(ref).not.toBe(corpse);
			expect(ref?.session).toBe(session);
		} finally {
			await session.dispose();
		}
	});

	it("fresh construction over a cold-revivable ref fails closed: the corpse stays registered and parked", async () => {
		const project = makeTempProject();
		const id = `Revivable-${Snowflake.next()}`;
		// The persisted factory CAN rebuild the parked subagent — probe succeeds.
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async () => async () => ({}) as AgentSession,
			0,
		);
		const corpse = AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/tmp/Corpse-Revivable.jsonl",
			status: "parked",
		});

		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		await expect(createAgentSession(commonSessionOptions(project, manager, id))).rejects.toThrow(
			/already registered/,
		);

		// Preserved: still registered, still parked, identity untouched.
		const ref = AgentRegistry.global().get(id);
		expect(ref).toBe(corpse);
		expect(ref?.status).toBe("parked");
		expect(ref?.session).toBeNull();
		await manager.close();
	});

	it("fresh construction over a live ref fails closed and leaves it messageable", async () => {
		const project = makeTempProject();
		const id = `Live-${Snowflake.next()}`;
		const liveSession = {} as AgentSession;
		const live = AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: liveSession,
			sessionFile: "/tmp/Live.jsonl",
			status: "idle",
		});

		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		await expect(createAgentSession(commonSessionOptions(project, manager, id))).rejects.toThrow(
			/already registered/,
		);

		const ref = AgentRegistry.global().get(id);
		expect(ref).toBe(live);
		expect(ref?.session).toBe(liveSession);
		expect(ref?.status).toBe("idle");
		await manager.close();
	});

	it("fresh construction over an abandoned quiescent main supersedes it", async () => {
		const project = makeTempProject();
		const id = `Abandoned-Main-${Snowflake.next()}`;
		const managerA = SessionManager.create(project.cwd, project.sessionsDir);
		const abandoned = await createAgentSession({
			...commonSessionOptions(project, managerA, id),
			parentTaskPrefix: undefined,
		});
		// Intentionally NOT disposed: the caller abandoned the session. The
		// long-standing SDK contract lets a later same-id construction replace
		// it instead of failing.

		const managerB = SessionManager.create(project.cwd, project.sessionsDir);
		const { session: successor } = await createAgentSession({
			...commonSessionOptions(project, managerB, id),
			parentTaskPrefix: undefined,
		});

		const ref = AgentRegistry.global().get(id);
		expect(ref?.kind).toBe("main");
		expect(ref?.session).toBe(successor);
		expect(ref?.session).not.toBe(abandoned.session);

		// Generation safety: a LATE dispose of the abandoned (superseded)
		// generation must not unregister — or otherwise disturb — the
		// successor generation's ref.
		await abandoned.session.dispose();
		const refAfterOldDispose = AgentRegistry.global().get(id);
		expect(refAfterOldDispose).toBe(ref);
		expect(refAfterOldDispose?.session).toBe(successor);

		await successor.dispose();
		expect(AgentRegistry.global().get(id)).toBeUndefined();
	});

	it("fresh construction over an in-flight main registration (no session attached yet) fails closed", async () => {
		const project = makeTempProject();
		const id = `InFlight-Main-${Snowflake.next()}`;
		const inFlight = AgentRegistry.global().register({
			id,
			displayName: "Main",
			kind: "main",
			parentId: undefined,
			session: null,
			sessionFile: null,
			status: "running",
		});

		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		await expect(
			createAgentSession({ ...commonSessionOptions(project, manager, id), parentTaskPrefix: undefined }),
		).rejects.toThrow(/already registered/);

		// The collision is left intact for the in-flight construction to finish.
		const ref = AgentRegistry.global().get(id);
		expect(ref).toBe(inFlight);
		expect(ref?.session).toBeNull();
		await manager.close();
	});

	it("fresh construction over a main with in-flight work (streaming) fails closed", async () => {
		const project = makeTempProject();
		const id = `Streaming-Main-${Snowflake.next()}`;
		const busy = AgentRegistry.global().register({
			id,
			displayName: "Main",
			kind: "main",
			parentId: undefined,
			session: { isStreaming: true } as AgentSession,
			sessionFile: "/tmp/Streaming-Main.jsonl",
			status: "running",
		});

		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		await expect(
			createAgentSession({ ...commonSessionOptions(project, manager, id), parentTaskPrefix: undefined }),
		).rejects.toThrow(/already registered/);

		const ref = AgentRegistry.global().get(id);
		expect(ref).toBe(busy);
		await manager.close();
	});
	it("fresh construction reuses an id freed by a previous release without ever colliding", async () => {
		const project = makeTempProject();
		const id = `Reuse-${Snowflake.next()}`;
		// First generation ran and was released (unregistered).
		AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: null,
			status: "running",
		});
		AgentRegistry.global().unregister(id);
		expect(AgentRegistry.global().get(id)).toBeUndefined();

		// A fresh spawn with the same id registers a brand-new generation.
		const manager = SessionManager.create(project.cwd, project.sessionsDir);
		const { session } = await createAgentSession(commonSessionOptions(project, manager, id));

		try {
			expect(AgentRegistry.global().get(id)?.status).toBe("running");
			expect(AgentRegistry.global().get(id)?.session).toBe(session);
		} finally {
			await session.dispose();
		}
	});
});
