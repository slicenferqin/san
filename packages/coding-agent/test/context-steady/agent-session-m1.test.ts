/**
 * Context Steady State M1 — AgentSession integration tests.
 *
 * Tests verify the M1 contract through a real AgentSession lifecycle:
 * 1. Normal user turn produces exactly one san.turn_digest custom entry
 * 2. session_stop continuation produces a single consolidated digest
 * 3. Aborted turn produces a digest (the turn did settle)
 * 4. digest entries do not appear in LLM context
 * 5. Disabled settings produce no digest
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { TURN_DIGEST_CUSTOM_TYPE } from "../../src/context-steady/types";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
};

function extractDigestEntries(sessionManager: SessionManager): CustomEntry[] {
	const branch = sessionManager.getBranch();
	return branch.filter(
		(e): e is CustomEntry => e.type === "custom" && (e as CustomEntry).customType === TURN_DIGEST_CUSTOM_TYPE,
	) as CustomEntry[];
}

describe("Context Steady State M1 — AgentSession integration", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-steady-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const as of authStorages) {
			await as.close();
		}
		removeSyncWithRetries(tempDir);
		vi.restoreAllMocks();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Test 1: Normal user turn
	// ═══════════════════════════════════════════════════════════════════════

	it("writes exactly one san.turn_digest for a normal user turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First message");
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(1);
		expect(digests[0]?.customType).toBe(TURN_DIGEST_CUSTOM_TYPE);
		expect(digests[0]?.data).toBeDefined();
	});

	it("digest source span covers from user entry to final assistant entry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Fix the bug in main.ts");
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(1);

		const data = digests[0]!.data as Record<string, unknown>;
		const source = data.source as Record<string, string>;

		const branch = sessionManager.getBranch();

		expect(source).toHaveProperty("fromEntryId");
		expect(source).toHaveProperty("toEntryId");
		expect(source.fromEntryId).toBeTruthy();
		expect(source.toEntryId).toBeTruthy();

		// fromEntryId must correspond to the current turn's first user message entry
		const fromEntry = branch.find(e => e.id === source.fromEntryId);
		expect(fromEntry).toBeDefined();
		expect(fromEntry!.type).toBe("message");
		const fromMsg = "message" in fromEntry! ? (fromEntry as unknown as Record<string, unknown>).message : undefined;
		expect(fromMsg).toBeDefined();
		expect((fromMsg as Record<string, unknown>).role).toBe("user");

		// toEntryId must correspond to the current turn's final assistant message entry
		const toEntry = branch.find(e => e.id === source.toEntryId);
		expect(toEntry).toBeDefined();
		expect(toEntry!.type).toBe("message");
		const toMsg = "message" in toEntry! ? (toEntry as unknown as Record<string, unknown>).message : undefined;
		expect(toMsg).toBeDefined();
		expect((toMsg as Record<string, unknown>).role).toBe("assistant");

		// The from entry must appear before the to entry
		const fromIndex = branch.findIndex(e => e.id === source.fromEntryId);
		const toIndex = branch.findIndex(e => e.id === source.toEntryId);
		expect(fromIndex).toBeGreaterThanOrEqual(0);
		expect(toIndex).toBeGreaterThan(fromIndex);
	});

	it("digest custom entry does not appear as a message in LLM context", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First message");
		await session.waitForIdle();

		// Make another prompt call and verify the digest entry is NOT in the
		// messages sent to the LLM. We check mock.calls[1] (the second prompt).
		await session.prompt("Second message");
		await session.waitForIdle();

		// mock.calls has 2 entries (one per prompt)
		const llmMessages = mock.calls.flatMap(call => call.context.messages);

		// CustomEntry (type=custom, customType=san.turn_digest) should never
		// appear in LLM messages. The digest content is stored separately on
		// the session entry and only read via session helpers.
		for (const msg of llmMessages) {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			expect(content).not.toContain("san.turn_digest");
		}
	});

	it("does not write digest when contextSteady is disabled", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "san.contextSteady.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First message");
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(0);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Test 2: session_stop continuation
	// ═══════════════════════════════════════════════════════════════════════

	it("session_stop continuation writes single consolidated digest covering full logical turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});

		const sessionStops: Array<{ stop_hook_active: boolean }> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { stop_hook_active: boolean }) => {
				sessionStops.push(event);
				if (sessionStops.length === 1) {
					return Promise.resolve({ continue: true, additionalContext: "Keep going." });
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		await session.prompt("Fix the bug");
		await session.waitForIdle();

		// Verify session_stop was called exactly twice (original + continuation)
		expect(sessionStops).toHaveLength(2);
		expect(sessionStops[0]?.stop_hook_active).toBe(false);
		expect(sessionStops[1]?.stop_hook_active).toBe(true);

		// Exactly one digest for the entire logical turn
		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(1);

		const data = digests[0]!.data as Record<string, unknown>;
		const source = data.source as Record<string, string>;

		const branch = sessionManager.getBranch();
		const fromIdx = branch.findIndex(e => e.id === source.fromEntryId);
		const toIdx = branch.findIndex(e => e.id === source.toEntryId);
		expect(fromIdx).toBeGreaterThanOrEqual(0);
		expect(toIdx).toBeGreaterThan(fromIdx);

		// The digest should cover the FULL logical turn from original user prompt
		// through the continuation, not just the continuation cycle.
		// userIntent should NOT be "System-driven continuation" if the original
		// user prompt is included.
		expect(data.userIntent).not.toBe("System-driven continuation");
		expect(data.userIntent).toContain("Fix the bug");

		// The span must include the continuation custom_message
		const contIdx = branch.findIndex(
			e =>
				e.type === "custom_message" &&
				(e as unknown as Record<string, string>).customType === "session-stop-continuation",
		);
		expect(fromIdx).toBeLessThanOrEqual(contIdx);
		expect(toIdx).toBeGreaterThanOrEqual(contIdx);

		// The span must include the final assistant message
		const lastMsgIdx = branch.findLastIndex(e => e.type === "message" && "message" in e);
		expect(toIdx).toBeGreaterThanOrEqual(lastMsgIdx);
	});

	it("session_stop continuation produces one digest, not two", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});

		const emitSessionStop = vi.fn(() => {
			if (emitSessionStop.mock.calls.length === 1) {
				return Promise.resolve({ continue: true, additionalContext: "Continue." });
			}
			return Promise.resolve(undefined);
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop,
		} as unknown as ExtensionRunner;

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		await session.prompt("Do something");
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(1);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Test 3: Aborted turn
	// ═══════════════════════════════════════════════════════════════════════

	it("aborted turn writes a digest (turn did settle)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const localAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
				});
				if (options?.signal) {
					options.signal.addEventListener(
						"abort",
						() => {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						},
						{ once: true },
					);
				}
				return stream;
			},
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent: localAgent, sessionManager, settings, modelRegistry });
		const promptPromise = session.prompt("Do something").catch(() => {});
		await Bun.sleep(10);
		await session.abort();
		await promptPromise;
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		// An aborted turn still settled — the agent loop finished its maintenance
		// path. The digest captures whatever happened up to the abort point.
		expect(digests.length).toBeGreaterThanOrEqual(1);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Test 4: Disabled settings
	// ═══════════════════════════════════════════════════════════════════════

	it("handles disabled settings without writing digest", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "san.contextSteady.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("Message");
		await session.waitForIdle();
		expect(extractDigestEntries(sessionManager)).toHaveLength(0);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Test 5: Regression — agent_end hook side effect does not pollute toEntryId
	// ═══════════════════════════════════════════════════════════════════════

	it("toEntryId is not polluted by agent_end hook that appends entries", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = {
			emit: vi.fn(async (event: { type: string }) => {
				// Simulate an extension that writes a custom entry on agent_end.
				// This advances the session leaf and would shift toEntryId if
				// settledLeafId were not captured before the notification.
				if (event.type === "agent_end") {
					(sessionManager as unknown as { appendCustomEntry(ct: string, d?: unknown): string }).appendCustomEntry(
						"test.agent_end_side_effect",
						{},
					);
				}
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn(() => false),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		await session.prompt("Fix the bug");
		await session.waitForIdle();

		const digests = extractDigestEntries(sessionManager);
		expect(digests).toHaveLength(1);

		const data = digests[0]!.data as Record<string, unknown>;
		const source = data.source as Record<string, string>;
		const branch = sessionManager.getBranch();

		// toEntryId must point to the final assistant message, not the
		// test.agent_end_side_effect custom entry (the side-effect entry
		// comes later in the branch).
		const toEntry = branch.find(e => e.id === source.toEntryId);
		expect(toEntry).toBeDefined();
		expect(toEntry!.type).toBe("message");
		const toMsg = "message" in toEntry! ? (toEntry as unknown as Record<string, unknown>).message : undefined;
		expect((toMsg as Record<string, unknown>).role).toBe("assistant");

		// The side-effect entry must exist in the branch AFTER the toEntry
		const toIdx = branch.findIndex(e => e.id === source.toEntryId);
		const sideEffectIdx = branch.findIndex(
			e =>
				e.type === "custom" && (e as unknown as Record<string, string>).customType === "test.agent_end_side_effect",
		);
		expect(sideEffectIdx).toBeGreaterThan(toIdx);
	});
});
