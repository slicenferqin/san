import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { EventSequencer } from "@san/coding-agent/modes/rpc-v2/event-sequencer";
import type { SessionId } from "@san/coding-agent/modes/rpc-v2/protocol/ids";
import { RpcV2SessionManager } from "@san/coding-agent/modes/rpc-v2/session-manager";
import { RpcV2StateStore } from "@san/coding-agent/modes/rpc-v2/state-store";
import { createAgentSession } from "@san/coding-agent/sdk";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import * as sessionListing from "@san/coding-agent/session/session-listing";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeWithRetries } from "@san/utils";

const tempDirectories: string[] = [];
const authStorages: AuthStorage[] = [];

interface ReadOnlyFixture {
	directory: string;
	session: AgentSession;
	manager: RpcV2SessionManager;
	sessionFile: string;
	sessionId: SessionId;
}

async function createReadOnlyFixture(): Promise<ReadOnlyFixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-read-only-events-"));
	tempDirectories.push(directory);
	const sessionManager = SessionManager.create(directory, path.join(directory, "sessions"));
	sessionManager.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
	await sessionManager.ensureOnDisk();
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Read-only test Session was not persisted");
	const sessionId = sessionManager.getSessionId() as SessionId;

	const authStorage = await AuthStorage.create(path.join(directory, "auth.db"));
	authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage,
		modelRegistry,
		model: getBundledModel("openai", "gpt-4o-mini"),
		sessionManager,
		sessionAccess: "read_only",
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	const manager = new RpcV2SessionManager({
		runtimeId: "runtime_read_only_events",
		initialHandle: { session },
	});
	return { directory, session, manager, sessionFile, sessionId };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});
describe("RPC v2 read-only event refresh", () => {
	test("reads events appended by another runtime after the initial attach", async () => {
		const { directory, manager, session, sessionFile, sessionId } = await createReadOnlyFixture();
		vi.spyOn(sessionListing, "listAllSessions").mockResolvedValue([
			{
				path: sessionFile,
				id: sessionId,
				cwd: directory,
				created: new Date("2026-08-26T00:00:00.000Z"),
				modified: new Date("2026-08-26T00:00:00.000Z"),
				messageCount: 1,
				size: 1,
				firstMessage: "request",
				allMessagesText: "request",
				status: "pending",
			},
		]);
		try {
			await manager.open({ sessionId, access: "read_only" });
			const before = await manager.listEvents({ sessionId });
			const store = new RpcV2StateStore(sessionFile, sessionId);
			const loaded = await store.load();
			const event = new EventSequencer(sessionId, loaded.state.lastSequence).emit(
				"session.notice",
				{ level: "info", code: "notice", message: "new event" },
				{ durability: "durable" },
			);
			await store.appendEvent(event);
			loaded.state.lastSequence = event.sequence;
			loaded.state.revision += 1;
			await store.saveState(loaded.state);

			const after = await manager.listEvents({ sessionId, afterSequence: before.lastSequence });
			expect(after.events).toEqual([event]);
			expect(after.firstSequence).toBe(event.sequence);
			expect(after.lastSequence).toBe(event.sequence);
		} finally {
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});
});
