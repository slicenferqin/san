/**
 * Context Steady State M2 — AgentSession ContextPlan integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { applySanBrainMutation } from "@oh-my-pi/pi-coding-agent/brain/commands";
import { appendSanBrainExperienceCandidate } from "@oh-my-pi/pi-coding-agent/brain/ledger";
import { SanBrainStore } from "@oh-my-pi/pi-coding-agent/brain/store";
import type { SanBrainExperienceCandidate } from "@oh-my-pi/pi-coding-agent/brain/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSearchOptions,
} from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { computeNonMessageTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry, CustomMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	CONTEXT_PLAN_CUSTOM_TYPE,
	CONTEXT_PLAN_MESSAGE_TYPE,
	type ContextPlanAudit,
} from "../../src/context-steady/plan-types";
import { type ContextProbeRecord, contextProbeFilePath } from "../../src/context-steady/probe";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	type ContextSegment,
	TURN_DIGEST_CUSTOM_TYPE,
} from "../../src/context-steady/types";
import {
	findLatestSanLoopRun,
	rebuildSanLoopLedger,
	recordSanLoopRunCreated,
	SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
} from "../../src/san-loop";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.activationThresholdTokens": 0,
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

describe("Context Steady State M2 — AgentSession ContextPlan integration", () => {
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

	it("injects the previous turn digest into the next real user prompt and writes plan audit", async () => {
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
		const planMessage = secondCallMessages.find(message =>
			JSON.stringify(message.content).includes("<san_context_plan>"),
		);
		expect(planMessage).toBeDefined();
		expect(planMessage?.role).toBe("user");
		expect(JSON.stringify(planMessage?.content)).toContain("Fix the parser bug");

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(planEntries.length).toBeGreaterThanOrEqual(1);
		const planData = planEntries.at(-1)!.data as Record<string, unknown>;
		const materials = planData.materials as Array<Record<string, unknown>>;
		expect(materials.map(material => material.representation)).toContain("digest");
		expect(planData.budget).toMatchObject({ reserveRatio: 0.2, planTokenBudget: 2000 });
		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);
		expect(customMessageEntries(sessionManager, CONTEXT_PLAN_MESSAGE_TYPE)).toHaveLength(0);

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const secondDigest = digests[1]!.data as Record<string, unknown>;
		const secondDigestSource = secondDigest.source as Record<string, string>;
		const fromEntry = sessionManager.getEntry(secondDigestSource.fromEntryId);
		expect(fromEntry?.type).toBe("message");
	});

	it("keeps the emitted quality-gated ContextPlan within its configured wire budget", async () => {
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
			"san.contextSteady.contextPlan.maxTokens": 135,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("first budgeted context turn");
		await session.waitForIdle();
		await session.prompt("continue the budgeted context turn");
		await session.waitForIdle();

		const planMessage = mock.calls[1]!.context.messages.find(message => {
			return JSON.stringify(message.content).includes("<san_context_plan>");
		});
		expect(planMessage).toBeDefined();
		expect(planMessage?.role).toBe("user");
		const planContent =
			typeof planMessage?.content === "string"
				? planMessage.content
				: Array.isArray(planMessage?.content)
					? planMessage.content
							.filter((block): block is { type: "text"; text: string } => {
								return block.type === "text" && typeof block.text === "string";
							})
							.map(block => block.text)
							.join("\n")
					: "";
		expect(estimateTokens({ role: "user", content: planContent, timestamp: Date.now() })).toBeLessThanOrEqual(135);

		const audit = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)!.data as {
			budget: { planTokenBudget: number };
			qualityGate: { projectedInputTokens?: number };
		};
		expect(audit.budget.planTokenBudget).toBe(135);
		expect(audit.qualityGate.projectedInputTokens).toBeGreaterThan(0);
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
			mode: "team",
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
			mode: "team",
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
		const events = rebuildSanLoopLedger(sessionManager.getEntries()).events;
		expect(events.at(-1)?.data).toMatchObject({
			runId: "loop_recover_session",
			type: "recovered",
			data: { previousStatus: "planning" },
		});
	});

	it("keeps fallback-digest raw transcript while adding ContextPlan reference", async () => {
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
		expect(secondProviderPayload).toContain("<san_context_plan>");
		expect(secondProviderPayload).toContain("Layer one baseline task");
		expect(secondProviderPayload).toContain("Continue after provider pruning");
		expect(secondProviderPayload).toContain(rawUserMarker);
		expect(secondProviderPayload).toContain(rawAssistantMarker);

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(planEntries.length).toBeGreaterThan(0);
		const planData = planEntries.at(-1)!.data as Record<string, unknown>;
		expect(planData.coverage).toEqual([]);
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
		expect(customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE)).toHaveLength(0);
		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(0);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				JSON.stringify(message.content).includes("<san_context_packet>"),
			),
		).toBe(false);
	});

	it("prefers ContextPlan settings over legacy ContextPacket aliases", async () => {
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
			"san.contextSteady.contextPacket.recentDigests": 1,
			"san.contextSteady.contextPacket.maxTokens": 10,
			"san.contextSteady.contextPlan.enabled": true,
			"san.contextSteady.contextPlan.recentDigests": 2,
			"san.contextSteady.contextPlan.maxTokens": 1234,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Plan alias task one");
		await session.waitForIdle();
		await session.prompt("Plan alias task two");
		await session.waitForIdle();
		await session.prompt("Plan alias task three");
		await session.waitForIdle();

		const finalProviderPayload = JSON.stringify(mock.calls.at(-1)!.context.messages);
		expect(finalProviderPayload).toContain("<san_context_plan>");
		const finalPlan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)!.data as Record<string, unknown>;
		expect(finalPlan.budget).toMatchObject({ planTokenBudget: 1234 });
		const digestMaterials = (finalPlan.materials as Array<Record<string, unknown>>).filter(
			material => material.representation === "digest",
		);
		expect(digestMaterials).toHaveLength(2);
	});

	it("uses the default latest-five digest material window", async () => {
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

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(planEntries).toHaveLength(6);
		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const finalPlan = planEntries.at(-1)!.data as Record<string, unknown>;
		const digestMaterials = (finalPlan.materials as Array<Record<string, unknown>>).filter(
			material => material.representation === "digest",
		);
		expect(digestMaterials.map(material => (material.entryRefs as string[])[0])).toEqual(
			digests.slice(0, 5).map(entry => entry.id),
		);

		const finalPacketMessages = mock.calls
			.at(-1)!
			.context.messages.filter(message => JSON.stringify(message.content).includes("<san_context_plan>"));
		expect(finalPacketMessages).toHaveLength(1);
		const finalPacketContent = JSON.stringify(finalPacketMessages.map(message => message.content));
		expect(finalPacketContent).toContain("M2 default window task 1");
		expect(finalPacketContent).toContain("M2 default window task 5");
		expect(finalPacketContent).not.toContain("M2 default window task 6");
	});

	it("does not replay stale persisted ContextPlan audits into later active turns", async () => {
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

		expect(customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE)).toHaveLength(3);
		expect(customMessageEntries(sessionManager, CONTEXT_PLAN_MESSAGE_TYPE)).toHaveLength(0);
		const activeContext = sessionManager.buildSessionContext();
		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(JSON.stringify(activeContext.messages)).not.toContain("<san_context_plan>");
		expect(JSON.stringify(transcriptContext.messages)).not.toContain("<san_context_plan>");

		const thirdCallPackets = mock.calls[2]!.context.messages.filter(message =>
			JSON.stringify(message.content).includes("<san_context_plan>"),
		);
		expect(thirdCallPackets).toHaveLength(1);
		const thirdPacketText = JSON.stringify(thirdCallPackets.map(message => message.content));
		expect(thirdPacketText).toContain("M10 replay first turn");
		expect(thirdPacketText).toContain("M10 replay second turn");
		expect(thirdPacketText).not.toContain("M10 replay third turn");
	});

	it("records the ContextPlan budget from quality window settings", async () => {
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

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(planEntries.length).toBeGreaterThan(0);
		const finalPlan = planEntries.at(-1)!.data as Record<string, unknown>;
		expect(finalPlan.budget).toMatchObject({ steadyTarget: 220, reserveRatio: 0.25 });
		expect(finalPlan.materials).toEqual(
			expect.arrayContaining([expect.objectContaining({ representation: "digest" })]),
		);
	});

	it("writes stable checkpoints and includes them before the digest tail in ContextPlan", async () => {
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
		let checkpointRebaseCloseCount = 0;
		const checkpointProviderState: ProviderSessionState = {
			close() {
				checkpointRebaseCloseCount += 1;
			},
		};
		session.providerSessionState.set("checkpoint-rebase", checkpointProviderState);

		await session.prompt("M4 checkpoint stable task three");
		await session.waitForIdle();
		expect(checkpointRebaseCloseCount).toBe(1);
		expect(session.providerSessionState.has("checkpoint-rebase")).toBe(false);

		let duplicateRebaseCloseCount = 0;
		session.providerSessionState.set("same-checkpoint-rebase", {
			close() {
				duplicateRebaseCloseCount += 1;
			},
		} satisfies ProviderSessionState);
		await session.prompt("M4 checkpoint stable task four");
		await session.waitForIdle();
		expect(duplicateRebaseCloseCount).toBe(0);
		session.providerSessionState.delete("same-checkpoint-rebase");

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		const planData = planEntries.map(entry => entry.data as Record<string, unknown>);
		const checkpointPlan = planData.find(plan => {
			const materials = plan.materials as Array<Record<string, unknown>> | undefined;
			return (
				materials?.some(
					material =>
						material.representation === "checkpoint" &&
						(material.entryRefs as string[]).includes(checkpointEntries[0]!.id),
				) === true && materials.some(material => material.representation === "digest")
			);
		});
		expect(checkpointPlan).toBeDefined();
		const checkpointMaterials = checkpointPlan!.materials as Array<Record<string, unknown>>;
		const contextMaterials = checkpointMaterials.filter(material =>
			["checkpoint", "digest"].includes(material.representation as string),
		);
		expect(contextMaterials.map(material => material.representation)).toEqual(["checkpoint", "digest"]);
		expect(contextMaterials[0]).toMatchObject({
			entryRefs: [checkpointEntries[0]!.id],
			representation: "checkpoint",
		});
		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		expect(contextMaterials[1]).toMatchObject({
			entryRefs: [digests[2]!.id],
			representation: "digest",
		});
		expect(checkpointMaterials).toEqual(
			expect.arrayContaining([expect.objectContaining({ representation: "exact" })]),
		);
		const finalPlanMessages = mock.calls
			.at(-1)!
			.context.messages.filter(message => JSON.stringify(message.content).includes("<san_context_plan>"));
		const finalPlanContent = JSON.stringify(finalPlanMessages.map(message => message.content));
		expect(finalPlanContent).toContain("Stable checkpoints");
		expect(finalPlanContent).toContain("M4 checkpoint stable task one");
		expect(finalPlanContent).toContain("M4 checkpoint stable task three");
		expect(finalPlanContent).not.toContain("M4 checkpoint stable task four");
	});

	it("injects read-only recalled memory as ContextPlan recall material", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mockModel = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mockModel.stream,
			convertToLlm,
		});
		const search = vi.fn(
			async (_context: MemoryBackendOperationContext, _query: string, options?: MemoryBackendSearchOptions) => ({
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
						scope: options?.scopeKeys?.[0],
					},
				],
			}),
		);
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
		const planMessage = firstCallMessages.find(message =>
			JSON.stringify(message.content).includes("<san_context_plan>"),
		);
		expect(planMessage).toBeDefined();
		const planContent = JSON.stringify(planMessage?.content);
		expect(planContent).toContain("Retrieved context");
		expect(planContent).toContain("San project decision: keep planning documents in HTML");
		expect(planContent).toContain("read-only background data");

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(planEntries).toHaveLength(1);
		const planData = planEntries[0]!.data as Record<string, unknown>;
		const materials = planData.materials as Array<Record<string, unknown>>;
		expect(materials).toContainEqual(expect.objectContaining({ representation: "recall", entryRefs: ["mem-1"] }));
		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);
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
		const search = vi.fn(
			async (_context: MemoryBackendOperationContext, _query: string, options?: MemoryBackendSearchOptions) => ({
				backend: "mnemopi" as const,
				query: "Second prompt",
				count: 1,
				items: [
					{
						id: "mem-1",
						content: "San recall belongs in the volatile ContextPacket layer",
						source: "mnemopi",
						scope: options?.scopeKeys?.[0],
					},
				],
			}),
		);
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
		const search = vi.fn(
			async (_context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) => ({
				backend: "mnemopi" as const,
				query,
				count: 3,
				items: [
					{
						id: "mem-1",
						content: "San recall should use recent digest context",
						source: "mnemopi",
						score: 0.95,
						scope: options?.scopeKeys?.[0],
					},
					{
						id: "mem-1",
						content: "San recall should use recent digest context",
						source: "mnemopi",
						score: 0.4,
						scope: options?.scopeKeys?.[0],
					},
					{
						content: "   ",
						source: "mnemopi",
						scope: options?.scopeKeys?.[0],
					},
					{
						id: "mem-2",
						content: "Stable checkpoint content must stay before recall",
						source: "mnemopi",
						scope: options?.scopeKeys?.[0],
					},
				],
			}),
		);
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

		const planEntries = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		const finalPlan = planEntries.at(-1)!.data as Record<string, unknown>;
		const recallMaterial = (finalPlan.materials as Array<Record<string, unknown>>).find(
			material => material.representation === "recall",
		);
		expect(recallMaterial).toMatchObject({ entryRefs: ["mem-1", "mem-2"] });
	});

	it("writes a digest for a tool-using turn after injecting ContextPlan", async () => {
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

		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).length).toBeGreaterThan(0);
		expect(customMessageEntries(sessionManager, CONTEXT_PLAN_MESSAGE_TYPE)).toHaveLength(0);
	});

	it("re-gates tool-loop provider calls against the burst ceiling", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const huge = "Z".repeat(400_000);
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call_huge", name: "echo", arguments: { value: "seed" } }],
				},
				{ content: ["should not reach second provider call"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 8_000,
			"san.contextSteady.burstWindowTokens": 12_000,
			"san.contextSteady.contextPlan.maxTokens": 2_000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		// Oversized tool result forces second provider projection past burst ceiling.
		const largeEcho: AgentTool<typeof echoToolSchema, { value: string }> = {
			...echoTool,
			async execute(_toolCallId, params) {
				const parsed = echoParams(params);
				return {
					content: [{ type: "text", text: `echo:${parsed.value}:${huge}` }],
					details: parsed,
				};
			},
		};
		agent.setTools([largeEcho]);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("tool loop ceiling probe");
		await session.waitForIdle();
		// First provider call may happen; the second call after huge tool result must not.
		expect(mock.calls).toHaveLength(1);
		const hardPressureAudits = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).filter(entry => {
			const data = entry.data as { qualityGate?: { outcome?: string; projectedInputTokens?: number } };
			return data.qualityGate?.outcome === "hard_pressure";
		});
		expect(hardPressureAudits.length).toBeGreaterThan(0);
		const gate = hardPressureAudits.at(-1)!.data as {
			qualityGate: { projectedInputTokens?: number; projectedInputLimit?: number };
		};
		expect((gate.qualityGate.projectedInputTokens ?? 0) > (gate.qualityGate.projectedInputLimit ?? 0)).toBe(true);
	});

	it("does not double-count stored history when re-gating a legal tool-loop tail", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		// ~700k chars ≈ ~175k tokens — under default 260k control / 320k burst when counted once.
		const legalHuge = "Y".repeat(700_000);
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call_legal", name: "echo", arguments: { value: "seed" } }],
				},
				{ content: ["legal tool tail accepted"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 240_000,
			"san.contextSteady.burstWindowTokens": 320_000,
			"san.contextSteady.contextPlan.maxTokens": 3_000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const largeEcho: AgentTool<typeof echoToolSchema, { value: string }> = {
			...echoTool,
			async execute(_toolCallId, params) {
				const parsed = echoParams(params);
				return {
					content: [{ type: "text", text: `echo:${parsed.value}:${legalHuge}` }],
					details: parsed,
				};
			},
		};
		agent.setTools([largeEcho]);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("legal tool loop tail probe");
		await session.waitForIdle();

		// Second provider call must run; double-counting would falsely hard-pressure at ~350k.
		expect(mock.calls.length).toBe(2);
		const hardPressureAudits = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).filter(entry => {
			const data = entry.data as { qualityGate?: { outcome?: string } };
			return data.qualityGate?.outcome === "hard_pressure";
		});
		expect(hardPressureAudits).toHaveLength(0);
		// Second call context must include the large tool result (counted once, not 2x).
		const secondPayload = JSON.stringify(mock.calls[1]!.context.messages);
		expect(secondPayload).toContain("echo:seed:");
		expect(secondPayload.length).toBeGreaterThan(500_000);
	});

	it("keeps ContextPlan bytes stable while a legal tool-loop tail grows inside the control band", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolPayload = "Q".repeat(20_000);
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call_control", name: "echo", arguments: { value: "seed" } }],
				},
				{ content: ["control-band tool tail accepted"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 8_000,
			"san.contextSteady.burstWindowTokens": 12_000,
			"san.contextSteady.contextPlan.maxTokens": 2_000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const controlEcho: AgentTool<typeof echoToolSchema, { value: string }> = {
			...echoTool,
			async execute(_toolCallId, params) {
				const parsed = echoParams(params);
				return {
					content: [{ type: "text", text: `echo:${parsed.value}:${toolPayload}` }],
					details: parsed,
				};
			},
		};
		agent.setTools([controlEcho]);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("control-band tool tail probe");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const plan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)?.data as ContextPlanAudit;
		const secondProviderTokens =
			computeNonMessageTokens(session) +
			mock.calls[1]!.context.messages.reduce(
				(sum, message) => sum + estimateTokens(message as unknown as AgentMessage),
				0,
			);

		expect(secondProviderTokens).toBeGreaterThan(0);
		expect(secondProviderTokens).toBeLessThanOrEqual(plan.qualityGate.projectedInputLimit ?? 0);
		expect(secondProviderTokens).toBeGreaterThan(plan.qualityGate.projectedInputTokens ?? -1);
		const planMessages = mock.calls.map(call =>
			call.context.messages.find(message => JSON.stringify(message).includes("<san_context_plan>")),
		);
		expect(planMessages[0]).toBeDefined();
		expect(JSON.stringify(planMessages[1])).toBe(JSON.stringify(planMessages[0]));
	});

	it("appends Segment checkpoints without starting physical compaction", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call_noop_1", name: "echo", arguments: { value: "one" } }] },
				{ content: [{ type: "toolCall", id: "call_noop_2", name: "echo", arguments: { value: "two" } }] },
				{ content: ["no-op maintenance probe complete"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.probe.enabled": true,
			"san.contextSteady.segment.maxTokens": 1,
			"san.contextSteady.segment.maxDurationMs": 0,
			"san.contextSteady.qualityWindowTokens": 240_000,
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 190_000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "noop-auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "noop-models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		let maintenanceStarts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") maintenanceStarts++;
		});

		await session.prompt("run the no-op maintenance probe");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(maintenanceStarts).toBe(0);
		const segments = customEntries(sessionManager, CONTEXT_SEGMENT_CUSTOM_TYPE).map(
			entry => entry.data as ContextSegment,
		);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		expect(segments.every(segment => segment.authority === "checkpoint")).toBe(true);
		expect(segments.every(segment => segment.maintenance.action === "checkpoint")).toBe(true);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const probeFile = contextProbeFilePath(sessionFile);
		let records: ContextProbeRecord[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			const file = Bun.file(probeFile);
			if (await file.exists()) records = Bun.JSONL.parse(await file.text()) as ContextProbeRecord[];
			if (records.some(record => record.request.kind === "maintenance")) break;
			await Bun.sleep(1);
		}
		const maintenanceRecords = records.filter(record => record.request.kind === "maintenance");
		expect(maintenanceRecords.length).toBeGreaterThanOrEqual(1);
		expect(
			maintenanceRecords.every(
				record =>
					record.maintenance.primaryTrigger === "segment_tokens" &&
					record.maintenance.action === "checkpoint" &&
					record.authority.authorityStateInjected,
			),
		).toBe(true);
	});

	it("rebuilds the active plan after pre-prompt compaction rewrites history", async () => {
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...bundledModel, contextWindow: 100_000, maxTokens: 16_000 };
		const mock = createMockModel({ responses: [{ content: ["pre-prompt rewrite accepted"] }] });
		const seedText = "seed-context ".repeat(3_000);
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: seedText }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "seed completed" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 3_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [seedUser, seedAssistant] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.autoContinue": false,
			"compaction.thresholdTokens": 1_000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 1,
			"contextPromotion.enabled": false,
			"san.contextSteady.qualityWindowTokens": 20_000,
			"san.contextSteady.burstWindowTokens": 30_000,
			"san.contextSteady.contextPlan.maxTokens": 2_000,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "PRE_PROMPT_COMPACTION_MARKER",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("continue after context maintenance");
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(mock.calls).toHaveLength(1);
		const providerPayload = JSON.stringify(mock.calls[0]!.context.messages);
		expect(providerPayload).toContain("PRE_PROMPT_COMPACTION_MARKER");
		const plan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)?.data as ContextPlanAudit;
		const providerTokens =
			computeNonMessageTokens(session) +
			mock.calls[0]!.context.messages.reduce(
				(sum, message) => sum + estimateTokens(message as unknown as AgentMessage),
				0,
			);
		expect(plan.qualityGate.projectedInputTokens).toBe(providerTokens);
	});

	it("builds checkpoints only from the active branch", async () => {
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
			"san.contextSteady.checkpoint.everyTurns": 1,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("OFF_BRANCH_SECRET_REQUIREMENT please remember");
		await session.waitForIdle();
		const offBranchLeaf = sessionManager.getLeafId();
		expect(offBranchLeaf).toBeTruthy();

		// Branch from the root-side user entry so the discarded path stays off-branch.
		const firstUser = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		expect(firstUser).toBeDefined();
		const parentId = firstUser!.parentId;
		if (parentId) sessionManager.branch(parentId);
		else sessionManager.resetLeaf();

		await session.prompt("active branch request about parser");
		await session.waitForIdle();
		await session.prompt("active branch follow-up");
		await session.waitForIdle();

		const checkpoints = customEntries(sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE);
		expect(checkpoints.length).toBeGreaterThan(0);
		const latest = checkpoints.at(-1)!.data as {
			summary?: { userIntents?: Array<{ text?: string }> };
		};
		const intents = (latest.summary?.userIntents ?? []).map(item => item.text ?? "").join("\n");
		expect(intents).not.toContain("OFF_BRANCH_SECRET_REQUIREMENT");
		expect(intents).toContain("active branch");
	});

	it("persists hard-pressure audit and the refused prompt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["should not run"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 2_000,
			"san.contextSteady.burstWindowTokens": 3_000,
			"san.contextSteady.contextPlan.maxTokens": 500,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const refused = `HARD_PRESSURE_PROMPT ${"x".repeat(40_000)}`;
		await expect(session.prompt(refused)).rejects.toThrow(/hard pressure/i);
		expect(mock.calls).toHaveLength(0);

		const plans = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(plans.length).toBeGreaterThan(0);
		const plan = plans.at(-1)!.data as ContextPlanAudit;
		expect(plan.qualityGate.outcome).toBe("hard_pressure");
		expect((plan.qualityGate.projectedInputTokens ?? 0) > (plan.qualityGate.projectedInputLimit ?? 0)).toBe(true);
		expect(plan.budget.planTokenBudget).toBe(500);
		for (const coverage of plan.coverage) {
			expect(plan.materials.some(material => material.materialId === coverage.replacementMaterialId)).toBe(true);
		}
		const protectedRefs = plan.qualityGate.protectedEntryRefs;
		expect(protectedRefs.some(ref => !ref.startsWith("pending_"))).toBe(true);

		const userEntries = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user");
		expect(userEntries.some(entry => JSON.stringify(entry).includes("HARD_PRESSURE_PROMPT"))).toBe(true);
		// Same-session agent state must also retain the refused prompt for recovery.
		expect(JSON.stringify(session.messages).includes("HARD_PRESSURE_PROMPT")).toBe(true);
	});

	it("keeps refused hard-pressure prompt visible to the next same-session provider call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: ["recovered follow-up"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 2_000,
			"san.contextSteady.burstWindowTokens": 3_000,
			"san.contextSteady.contextPlan.maxTokens": 500,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const marker = "HARD_REFUSED_MARKER";
		await expect(session.prompt(`${marker} ${"x".repeat(40_000)}`)).rejects.toThrow(/hard pressure/i);
		expect(JSON.stringify(session.messages)).toContain(marker);

		// Rebuild session settings with a large window so the follow-up can send.
		// Settings.isolated values may be frozen; dispose and recreate with shared manager.
		await session.dispose();
		const mock2 = createMockModel({ responses: [{ content: ["recovered follow-up"] }] });
		const agent2 = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock2.stream,
			convertToLlm,
		});
		// Seed agent messages from journal so recovery is same-process equivalent to reload.
		const recoveredSettings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 240_000,
			"san.contextSteady.burstWindowTokens": 320_000,
			"san.contextSteady.contextPlan.maxTokens": 3_000,
		});
		session = new AgentSession({
			agent: agent2,
			sessionManager,
			settings: recoveredSettings,
			modelRegistry,
		});
		// Sync agent state from branch journal (same-session recovery path after hard pressure).
		const branchMessages = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => (entry as { message: (typeof session.messages)[number] }).message);
		agent2.replaceMessages(branchMessages);

		await session.prompt("continue the refused task briefly");
		await session.waitForIdle();

		expect(mock2.calls.length).toBeGreaterThan(0);
		const payload = JSON.stringify(mock2.calls.at(-1)!.context.messages);
		expect(payload).toContain(marker);
		expect(payload).toContain("continue the refused task briefly");
	});

	it("applies an approved Brain recall policy through the real session and records its audit", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const search = vi.fn(async (_context, query: string) => ({
			backend: "mnemopi" as const,
			query,
			count: 1,
			items: [
				{
					id: "risk-memory",
					content: "A prior release retry failed.",
					memoryType: "episodic",
					scope: "user:user:local",
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
		};
		vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(fakeBackend);
		const sessionManager = SessionManager.inMemory();
		const candidate: SanBrainExperienceCandidate = {
			schemaVersion: 1,
			candidateId: "risk-recall-policy",
			scope: { kind: "user", key: "user:local", resolverVersion: 1 },
			type: "recall",
			selector: { roles: ["primary"], taskFamilies: ["release"] },
			action: { kind: "recall_policy", queryTemplateId: "risk-history-v1" },
			taskTags: ["release"],
			claimKey: "recall:release-risk",
			dedupeKey: "recall:release-risk:v1",
			conflictKey: "recall:release-risk",
			repeatCount: 2,
			confidence: 0.95,
			impact: "low",
			sensitivity: "normal",
			evidence: [],
			createdAt: "2026-07-11T08:00:00.000Z",
		};
		appendSanBrainExperienceCandidate(sessionManager, candidate);
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"memory.backend": "mnemopi",
			"san.contextSteady.recall.enabled": true,
			"san.brain.enabled": true,
			"san.brain.mode": "activation",
			"san.brain.capture.enabled": false,
		});
		vi.spyOn(settings, "getAgentDir").mockReturnValue(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const store = new SanBrainStore(path.join(tempDir, "brain.sqlite"));
		try {
			store.syncSessionEntries(sessionManager.getSessionId(), sessionManager.getEntries());
			applySanBrainMutation(store, sessionManager, { action: "approve", id: candidate.candidateId });
		} finally {
			store.close();
		}

		await session.prompt("Review the release failure before retrying.");
		await session.waitForIdle();

		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0]?.[1]).toContain("Prior failures, recovery outcomes, and required checks");
		const recallAudit = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === "san.brain.recall");
		expect(recallAudit?.type === "custom" ? recallAudit.data : undefined).toMatchObject({
			policyVersion: "brain-m6-recall-v1",
			selectedPolicyIds: [candidate.candidateId],
			queryTemplateId: "risk-history-v1",
			backend: "mnemopi",
			outcome: "applied",
			resultCount: 1,
		});
		const plan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)?.data as Record<string, unknown>;
		const recallMaterial = (plan.materials as Array<Record<string, unknown>>).find(
			material => material.representation === "recall",
		);
		expect(recallMaterial).toMatchObject({ entryRefs: ["risk-memory"] });
	});
});
