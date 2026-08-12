import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AppendOnlyContextManager } from "@san/agent";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@san/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@san/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { EventBus } from "@san/coding-agent/utils/event-bus";
import { TempDir } from "@san/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession dispose 终态释放", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@san-dispose-release-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(
		sessionManager = SessionManager.inMemory(tempDir.path()),
		extensionRunner?: ExtensionRunner,
	): AgentSession {
		const agent = new Agent({
			initialState: { systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("释放消息、append-only transcript、session entries 与 raw SSE", async () => {
		const current = createSession();
		const payload = "x".repeat(4096);
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: payload }], timestamp: Date.now() },
		];
		current.agent.replaceMessages(messages);
		const appendOnlyContext = new AppendOnlyContextManager();
		appendOnlyContext.syncMessages([{ role: "user", content: payload }]);
		current.agent.setAppendOnlyContext(appendOnlyContext);
		current.sessionManager.appendMessage({ role: "user", content: payload, timestamp: Date.now() });
		current.rawSseDebugBuffer.recordEvent({
			event: "content_block_delta",
			data: `data: ${payload}`,
			raw: ["event: content_block_delta", `data: ${payload}`],
		});

		expect(current.agent.state.messages).not.toHaveLength(0);
		expect(appendOnlyContext.log).not.toHaveLength(0);
		expect(current.sessionManager.getEntries()).not.toHaveLength(0);
		expect(current.rawSseDebugBuffer.snapshot().records).not.toHaveLength(0);

		await current.dispose();

		expect(current.agent.state.messages).toHaveLength(0);
		expect(current.agent.appendOnlyContext).toBeUndefined();
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.rawSseDebugBuffer.snapshot().records).toHaveLength(0);
		expect(current.rawSseDebugBuffer.toRawText()).toBe("");
	});

	it("deadline 后 seal 旧 manager，并在迟到事件结束后再次释放内存", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		const reached = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let lateTitleAccepted: boolean | undefined;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.on("message_end", async () => {
					reached.resolve();
					await resume.promise;
					lateTitleAccepted = await sessionManager.setSessionName("late-title", "user");
					sessionManager.appendCustomEntry("late-custom", { note: "dropped" });
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"slow-message-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const current = createSession(sessionManager, extensionRunner);

		const terminalMessage = createAssistantMessage("late persist");
		current.agent.emitExternalEvent({ type: "message_end", message: terminalMessage });
		await reached.promise;

		let releaseCalls = 0;
		const finalized = Promise.withResolvers<void>();
		const realRelease = sessionManager.releaseRetainedEntries.bind(sessionManager);
		vi.spyOn(sessionManager, "releaseRetainedEntries").mockImplementation(() => {
			realRelease();
			releaseCalls++;
			if (releaseCalls === 2) finalized.resolve();
		});

		await current.dispose({ drainTimeoutMs: 20 });
		expect(releaseCalls).toBe(1);
		const bytesAfterDispose = await Bun.file(sessionFile).text();
		const revived = await SessionManager.open(sessionFile, path.dirname(sessionFile));

		resume.resolve();
		await finalized.promise;
		expect(current.agent.state.messages).toHaveLength(0);
		expect(sessionManager.getEntries()).toHaveLength(0);
		expect(lateTitleAccepted).toBe(false);
		expect(await Bun.file(sessionFile).text()).toBe(bytesAfterDispose);

		revived.appendMessage({ role: "user", content: "post-revive", timestamp: Date.now() });
		await revived.flush();
		await revived.close();
		const reread = await SessionManager.open(sessionFile, path.dirname(sessionFile));
		const serialized = JSON.stringify(reread.getEntries());
		expect(serialized).toContain("seed");
		expect(serialized).toContain("post-revive");
		expect(serialized).not.toContain("late persist");
		expect(serialized).not.toContain("late-title");
		expect(serialized).not.toContain("late-custom");
		await reread.close();
	});
});
