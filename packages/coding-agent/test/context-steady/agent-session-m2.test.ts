/**
 * Context Steady State M2 — AgentSession ContextPacket integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry, CustomMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	TURN_DIGEST_CUSTOM_TYPE,
} from "../../src/context-steady/types";
import {
	findLatestSanLoopRun,
	recordSanLoopRunCreated,
	SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
	SAN_LOOP_EVENT_CUSTOM_TYPE,
} from "../../src/san-loop";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
	"san.contextSteady.qualityWindowTokens": 0,
	"san.contextSteady.reserveRatio": 0.2,
	"san.contextSteady.contextPacket.enabled": true,
	"san.contextSteady.contextPacket.maxTokens": 2000,
	"san.contextSteady.checkpoint.enabled": true,
	"san.contextSteady.checkpoint.everyTurns": 8,
	"san.contextSteady.checkpoint.maxTokens": 12000,
};

const echoToolSchema = {
	type: "object",
	properties: {
		value: { type: "string" },
	},
	required: ["value"],
	additionalProperties: false,
} as const;

function echoParams(input: unknown): { value: string } {
	if (input && typeof input === "object" && "value" in input && typeof input.value === "string") {
		return { value: input.value };
	}
	throw new Error("Invalid echo params");
}

const echoTool: AgentTool<typeof echoToolSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo a value for context steady tests.",
	parameters: echoToolSchema,
	async execute(_toolCallId, params) {
		const parsed = echoParams(params);
		return {
			content: [{ type: "text", text: `echo:${parsed.value}` }],
			details: parsed,
		};
	},
};

function customEntries(sessionManager: SessionManager, customType: string): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

function customMessageEntries(sessionManager: SessionManager, customType: string): CustomMessageEntry[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === customType,
		);
}

describe("Context Steady State M2 — AgentSession ContextPacket integration", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-packet-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages) {
			await authStorage.close();
		}
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	it("injects the previous turn digest into the next real user prompt and writes debug entry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: context => ({
				content: [`seen ${context.messages.length} messages`],
			}),
		});
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
		await session.prompt("Fix the parser bug");
		await session.waitForIdle();

		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(1);
		expect(
			mock.calls[0]?.context.messages.some(message =>
				JSON.stringify(message.content).includes("<san_context_packet>"),
			),
		).toBe(false);

		await session.prompt("Continue with tests");
		await session.waitForIdle();

		const secondCallMessages = mock.calls[1]!.context.messages;
		const packetMessage = secondCallMessages.find(message =>
			JSON.stringify(message.content).includes("<san_context_packet>"),
		);
		expect(packetMessage).toBeDefined();
		expect(packetMessage?.role).toBe("developer");
		expect(JSON.stringify(packetMessage?.content)).toContain("Fix the parser bug");

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries).toHaveLength(1);
		const packetData = debugEntries[0]!.data as Record<string, unknown>;
		expect(packetData.injectedMessageCustomType).toBe(CONTEXT_PACKET_MESSAGE_TYPE);
		expect(packetData.digestRefs).toHaveLength(1);
		expect(packetData.tokenBudget).toBe(2000);
		expect(packetData.budget).toEqual({
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 2000,
			configuredPacketMaxTokens: 2000,
		});
		const layers = packetData.layers as Array<Record<string, unknown>>;
		expect(layers[0]?.tokenBudget).toBe(2000);

		const injectedEntries = customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE);
		expect(injectedEntries).toHaveLength(1);
		expect(injectedEntries[0]!.display).toBe(false);
		expect(injectedEntries[0]!.details).toEqual({
			packetId: packetData.packetId,
			digestRefs: packetData.digestRefs,
		});

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const secondDigest = digests[1]!.data as Record<string, unknown>;
		const secondDigestSource = secondDigest.source as Record<string, string>;
		const fromEntry = sessionManager.getEntry(secondDigestSource.fromEntryId);
		expect(fromEntry?.type).toBe("message");
	});

	it("injects latest San execution loop role context into real user prompts", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		recordSanLoopRunCreated(sessionManager, {
			sessionId: sessionManager.getSessionId(),
			runId: "loop_agent_session",
			objective: "Ship mature v0.2 loop",
			mode: "smart",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.executionLoop.enabled": true,
			"san.executionLoop.ledger.enabled": true,
			"san.executionLoop.ledger.persistRolePackets": true,
			"san.executionLoop.roleContext.tokenBudget": 1200,
			"san.executionLoop.roleContext.maxEvents": 4,
			"san.executionLoop.roleContext.maxDecisions": 4,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Continue the San loop");
		await session.waitForIdle();

		const promptContent = JSON.stringify(mock.calls[0]!.context.messages);
		expect(promptContent).toContain("san_execution_loop_context");
		expect(promptContent).toContain("commander");
		expect(promptContent).toContain("Ship mature v0.2 loop");
		const loopPackets = customEntries(sessionManager, SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE);
		expect(loopPackets).toHaveLength(1);
		const packetData = loopPackets[0]!.data as Record<string, unknown>;
		expect(packetData).toMatchObject({
			runId: "loop_agent_session",
			role: "commander",
			tokenBudget: 1200,
		});
	});

	it("recovers active San execution loop runs as blocked on session construction", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		recordSanLoopRunCreated(sessionManager, {
			sessionId: sessionManager.getSessionId(),
			runId: "loop_recover_session",
			objective: "Recover interrupted v0.2 loop",
			mode: "smart",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.executionLoop.enabled": true,
			"san.executionLoop.ledger.enabled": true,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const latest = findLatestSanLoopRun(sessionManager.getEntries());
		expect(latest?.data).toMatchObject({
			runId: "loop_recover_session",
			status: "blocked",
			finalVerdict: undefined,
		});
		const events = customEntries(sessionManager, SAN_LOOP_EVENT_CUSTOM_TYPE);
		expect(events.at(-1)?.data).toMatchObject({
			runId: "loop_recover_session",
			type: "recovered",
			data: { previousStatus: "planning" },
		});
	});

	it("replaces packet-covered raw transcript before provider send", async () => {
		const rawUserMarker = "RAW_USER_CONTEXT_STEADY_PRUNE_MARKER";
		const rawAssistantMarker = "RAW_ASSISTANT_CONTEXT_STEADY_PRUNE_MARKER";
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [`First answer ${rawAssistantMarker}`] }, { content: ["Second answer"] }],
		});
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
		await session.prompt(`Layer one baseline task ${"x".repeat(260)} ${rawUserMarker}`);
		await session.waitForIdle();
		const firstProviderPayload = JSON.stringify(mock.calls[0]!.context.messages);
		expect(firstProviderPayload).toContain(rawUserMarker);
		expect(firstProviderPayload).not.toContain("<san_context_packet>");

		await session.prompt("Continue after provider pruning");
		await session.waitForIdle();

		const secondProviderPayload = JSON.stringify(mock.calls[1]!.context.messages);
		expect(secondProviderPayload).toContain("<san_context_packet>");
		expect(secondProviderPayload).toContain("Layer one baseline task");
		expect(secondProviderPayload).toContain("Continue after provider pruning");
		expect(secondProviderPayload).not.toContain(rawUserMarker);
		expect(secondProviderPayload).not.toContain(rawAssistantMarker);

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries).toHaveLength(1);
		const packetData = debugEntries[0]!.data as Record<string, unknown>;
		expect(packetData.digestRefs).toHaveLength(1);
	});

	it("does not inject ContextPacket when context packet setting is disabled", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.contextPacket.enabled": false,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First");
		await session.waitForIdle();
		await session.prompt("Second");
		await session.waitForIdle();

		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(2);
		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);
		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(0);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				JSON.stringify(message.content).includes("<san_context_packet>"),
			),
		).toBe(false);
	});

	it("uses the default latest-five digest ledger window", async () => {
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
		for (let index = 1; index <= 6; index++) {
			await session.prompt(`M2 default window task ${index}`);
			await session.waitForIdle();
		}

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries).toHaveLength(5);
		const finalPacket = debugEntries.at(-1)!.data as Record<string, unknown>;
		const finalRefs = finalPacket.digestRefs as string[];
		expect(finalRefs).toHaveLength(5);

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		expect(finalRefs).toEqual(digests.slice(0, 5).map(entry => entry.id));
		expect(finalPacket.trimDecisions).toEqual([]);

		const finalPacketMessage = mock.calls
			.at(-1)!
			.context.messages.find(message => JSON.stringify(message.content).includes("<san_context_packet>"));
		expect(
			mock.calls
				.at(-1)!
				.context.messages.filter(message => JSON.stringify(message.content).includes("<san_context_packet>")),
		).toHaveLength(1);
		const finalPacketContent = JSON.stringify(finalPacketMessage?.content);
		expect(finalPacketContent).toContain("M2 default window task 1");
		expect(finalPacketContent).toContain("M2 default window task 5");
		expect(finalPacketContent).not.toContain("M2 default window task 6");
	});

	it("does not replay stale persisted ContextPacket injections into later active turns", async () => {
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
		await session.prompt("M10 replay first turn");
		await session.waitForIdle();
		await session.prompt("M10 replay second turn");
		await session.waitForIdle();
		await session.prompt("M10 replay third turn");
		await session.waitForIdle();

		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(2);
		const activeContext = sessionManager.buildSessionContext();
		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(JSON.stringify(activeContext.messages)).not.toContain("<san_context_packet>");
		expect(JSON.stringify(transcriptContext.messages)).toContain("<san_context_packet>");

		const thirdCallPackets = mock.calls[2]!.context.messages.filter(message =>
			JSON.stringify(message.content).includes("<san_context_packet>"),
		);
		expect(thirdCallPackets).toHaveLength(1);
		const thirdPacketText = JSON.stringify(thirdCallPackets[0]!.content);
		expect(thirdPacketText).toContain("M10 replay first turn");
		expect(thirdPacketText).toContain("M10 replay second turn");
		expect(thirdPacketText).not.toContain("M10 replay third turn");
	});

	it("derives the injected ContextPacket budget from quality window settings", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 220,
			"san.contextSteady.reserveRatio": 0.25,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const budgetPressure = "x".repeat(140);
		await session.prompt(`M3 quality window baseline ${budgetPressure} one`);
		await session.waitForIdle();
		await session.prompt(`M3 quality window baseline ${budgetPressure} two`);
		await session.waitForIdle();
		await session.prompt("M3 quality window baseline three");
		await session.waitForIdle();

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries.length).toBeGreaterThan(0);
		const finalPacket = debugEntries.at(-1)!.data as Record<string, unknown>;
		expect(finalPacket.tokenBudget).toBe(165);
		expect(finalPacket.budget).toEqual({
			qualityWindowTokens: 220,
			reserveRatio: 0.25,
			reservedTokens: 55,
			packetTokenBudget: 165,
			configuredPacketMaxTokens: 2000,
		});
		expect(finalPacket.tokenEstimate as number).toBeLessThanOrEqual(165);
		const layers = finalPacket.layers as Array<Record<string, unknown>>;
		expect(layers[0]?.tokenBudget).toBe(165);
		expect(finalPacket.trimDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					layer: "turn_digest_ledger",
					reason: "token_budget",
				}),
			]),
		);
	});

	it("writes stable checkpoints and injects them before the append-only digest tail", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.checkpoint.everyTurns": 2,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("M4 checkpoint stable task one");
		await session.waitForIdle();
		await session.prompt("M4 checkpoint stable task two");
		await session.waitForIdle();

		const checkpointEntries = customEntries(sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE);
		expect(checkpointEntries).toHaveLength(1);
		const checkpointData = checkpointEntries[0]!.data as Record<string, unknown>;
		expect(checkpointData.entryRefs).toEqual(
			customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE).map(entry => entry.id),
		);
		expect(checkpointData.stability).toBe("stable");
		expect(checkpointData.cachePriority).toBe("high");

		await session.prompt("M4 checkpoint stable task three");
		await session.waitForIdle();
		await session.prompt("M4 checkpoint stable task four");
		await session.waitForIdle();

		const packetEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		const finalPacket = packetEntries.at(-1)!.data as Record<string, unknown>;
		expect(finalPacket.checkpointRef).toBe(checkpointEntries[0]!.id);
		const layers = finalPacket.layers as Array<Record<string, unknown>>;
		expect(layers.map(layer => layer.name)).toEqual(["stable_checkpoint", "turn_digest_ledger"]);
		expect(layers[0]).toMatchObject({
			entryRefs: [checkpointEntries[0]!.id],
			stability: "stable",
			cachePriority: "high",
		});
		expect(layers[1]).toMatchObject({
			stability: "append-only",
			cachePriority: "medium",
		});
		expect(finalPacket.trimDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					layer: "turn_digest_ledger",
					reason: "checkpoint_covered",
					omitted: 2,
				}),
			]),
		);

		const finalPacketMessage = mock.calls
			.at(-1)!
			.context.messages.find(message => JSON.stringify(message.content).includes("<san_context_packet>"));
		const finalPacketContent = JSON.stringify(finalPacketMessage?.content);
		expect(finalPacketContent).toContain("Stable checkpoint");
		expect(finalPacketContent).toContain("M4 checkpoint stable task one");
		expect(finalPacketContent).toContain("M4 checkpoint stable task three");
		expect(finalPacketContent).not.toContain("M4 checkpoint stable task four");
	});

	it("injects read-only recalled memory as a volatile ContextPacket layer", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mockModel = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mockModel.stream,
			convertToLlm,
		});
		const search = vi.fn(async () => ({
			backend: "mnemopi" as const,
			query: "Recall San project decisions",
			count: 1,
			items: [
				{
					id: "mem-1",
					content: "San project decision: keep planning documents in HTML",
					source: "mnemopi",
					timestamp: "2026-06-30T00:00:00.000Z",
					score: 0.92,
				},
			],
		}));
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return "static memory instructions";
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				throw new Error("San recall should not use memory system-prompt injection");
			},
			search,
			async save() {
				throw new Error("San recall should not write memory");
			},
		};
		vi.restoreAllMocks();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"memory.backend": "mnemopi",
			"san.contextSteady.recall.enabled": true,
			"san.contextSteady.recall.maxItems": 2,
			"san.contextSteady.recall.maxTokens": 500,
			"san.contextSteady.recall.maxQueryChars": 2000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Recall San project decisions");
		await session.waitForIdle();

		expect(search).toHaveBeenCalledTimes(1);
		const firstCallMessages = mockModel.calls[0]!.context.messages;
		const packetMessage = firstCallMessages.find(message =>
			JSON.stringify(message.content).includes("<san_context_packet>"),
		);
		expect(packetMessage).toBeDefined();
		const packetContent = JSON.stringify(packetMessage?.content);
		expect(packetContent).toContain("Retrieved context");
		expect(packetContent).toContain("San project decision: keep planning documents in HTML");
		expect(packetContent).toContain("Treat retrieved context as read-only background memory");

		const packetEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(packetEntries).toHaveLength(1);
		const packetData = packetEntries[0]!.data as Record<string, unknown>;
		expect(packetData.digestRefs).toEqual([]);
		expect(packetData.recallRefs).toEqual(["mem-1"]);
		expect(packetData.recallQuery).toBe("Recall San project decisions");
		const layers = packetData.layers as Array<Record<string, unknown>>;
		expect(layers.map(layer => layer.name)).toEqual(["turn_digest_ledger", "retrieved_context"]);
		expect(layers[1]).toMatchObject({
			entryRefs: ["mem-1"],
			stability: "volatile",
			cachePriority: "low",
			tokenBudget: 500,
		});
	});

	it("restores stable system prompt when San recall replaces legacy memory prompt injection", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mockModel = createMockModel({
			responses: [{ content: ["First done"] }, { content: ["Second done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Stable base"], tools: [] },
			streamFn: mockModel.stream,
			convertToLlm,
		});
		const search = vi.fn(async () => ({
			backend: "mnemopi" as const,
			query: "Second prompt",
			count: 1,
			items: [
				{
					id: "mem-1",
					content: "San recall belongs in the volatile ContextPacket layer",
					source: "mnemopi",
				},
			],
		}));
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
			async beforeAgentStartPrompt() {
				return "<memories>legacy volatile memory injection</memories>";
			},
			search,
		};
		vi.restoreAllMocks();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"memory.backend": "mnemopi",
			"san.contextSteady.enabled": false,
			"san.contextSteady.recall.maxQueryChars": 2000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First prompt");
		await session.waitForIdle();
		expect(mockModel.calls[0]!.context.systemPrompt).toEqual([
			"Stable base",
			"<memories>legacy volatile memory injection</memories>",
		]);

		settings.override("san.contextSteady.enabled", true);
		settings.override("san.contextSteady.recall.enabled", true);
		await session.prompt("Second prompt");
		await session.waitForIdle();

		expect(search).toHaveBeenCalledTimes(1);
		expect(mockModel.calls[1]!.context.systemPrompt).toEqual(["Stable base"]);
		const secondPromptContent = JSON.stringify(mockModel.calls[1]!.context.messages);
		expect(secondPromptContent).toContain("Retrieved context");
		expect(secondPromptContent).toContain("San recall belongs in the volatile ContextPacket layer");
		expect(secondPromptContent).not.toContain("legacy volatile memory injection");
	});

	it("uses recent digest context for San recall queries and deduplicates recall items", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mockModel = createMockModel({
			responses: [{ content: ["First done"] }, { content: ["Second done"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mockModel.stream,
			convertToLlm,
		});
		const search = vi.fn(async (_context, query: string) => ({
			backend: "mnemopi" as const,
			query,
			count: 3,
			items: [
				{
					id: "mem-1",
					content: "San recall should use recent digest context",
					source: "mnemopi",
					score: 0.95,
				},
				{
					id: "mem-1",
					content: "San recall should use recent digest context",
					source: "mnemopi",
					score: 0.4,
				},
				{
					content: "   ",
					source: "mnemopi",
				},
				{
					id: "mem-2",
					content: "Stable checkpoint content must stay before recall",
					source: "mnemopi",
				},
			],
		}));
		const fakeBackend: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
			search,
			async save() {
				throw new Error("San recall should not write memory");
			},
		};
		vi.restoreAllMocks();
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"memory.backend": "mnemopi",
			"san.contextSteady.recall.enabled": true,
			"san.contextSteady.recall.maxItems": 3,
			"san.contextSteady.recall.maxTokens": 500,
			"san.contextSteady.recall.maxQueryChars": 2000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Write the first San digest");
		await session.waitForIdle();
		await session.prompt("Continue recall quality work");
		await session.waitForIdle();

		expect(search).toHaveBeenCalledTimes(2);
		const secondQuery = search.mock.calls[1]![1];
		expect(secondQuery).toContain("Recent San turn digests:");
		expect(secondQuery).toContain("Write the first San digest");
		expect(secondQuery).toContain("Current prompt:");
		expect(secondQuery).toContain("Continue recall quality work");

		const packetEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		const finalPacket = packetEntries.at(-1)!.data as Record<string, unknown>;
		expect(finalPacket.recallRefs).toEqual(["mem-1", "mem-2"]);
		const layers = finalPacket.layers as Array<Record<string, unknown>>;
		expect(layers.at(-1)).toMatchObject({
			name: "retrieved_context",
			entryRefs: ["mem-1", "mem-2"],
			stability: "volatile",
			cachePriority: "low",
		});
	});

	it("writes a digest for a tool-using turn after injecting ContextPacket", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["First done"] },
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "probe" } }] },
				{ content: ["Final answer after tool"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
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
		await session.prompt("Remember the baseline");
		await session.waitForIdle();
		await session.prompt("Continue the baseline with a tool, then conclude");
		await session.waitForIdle();

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		expect(digests).toHaveLength(2);
		const secondDigest = digests[1]!.data as Record<string, unknown>;
		expect(secondDigest.userIntent).toBe("Continue the baseline with a tool, then conclude");
		expect(JSON.stringify(secondDigest.toolEvidence)).toContain("echo");

		const source = secondDigest.source as Record<string, string>;
		const fromEntry = sessionManager.getEntry(source.fromEntryId);
		const toEntry = sessionManager.getEntry(source.toEntryId);
		expect(fromEntry?.type).toBe("message");
		expect(toEntry?.type).toBe("message");
		expect(fromEntry && "message" in fromEntry ? fromEntry.message.role : undefined).toBe("user");
		expect(toEntry && "message" in toEntry ? toEntry.message.role : undefined).toBe("assistant");
		const toMessageContent =
			toEntry?.type === "message" && toEntry.message.role === "assistant"
				? JSON.stringify(toEntry.message.content)
				: "";
		expect(toMessageContent).toContain("Final answer after tool");

		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(1);
		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(1);
	});
});
