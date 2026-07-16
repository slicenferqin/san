/**
 * Real AgentSession multi-turn dogfood for ContextPlan runtime contracts.
 * Complements the pure dogfood simulator with provider calls, tool loop,
 * status/plan sharing, and branch-safe checkpoints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { CONTEXT_PLAN_CUSTOM_TYPE, CONTEXT_PLAN_MESSAGE_TYPE } from "../../src/context-steady/plan-types";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	type ContextSegment,
	TURN_DIGEST_CUSTOM_TYPE,
} from "../../src/context-steady/types";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
	"san.contextSteady.qualityWindowTokens": 240_000,
	"san.contextSteady.burstWindowTokens": 320_000,
	"san.contextSteady.reserveRatio": 0.2,
	"san.contextSteady.contextPlan.enabled": true,
	"san.contextSteady.contextPlan.recentDigests": 5,
	"san.contextSteady.contextPlan.maxTokens": 3000,
	"san.contextSteady.checkpoint.enabled": true,
	"san.contextSteady.checkpoint.everyTurns": 4,
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

const echoTool: AgentTool<typeof echoToolSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo a value for dogfood tool-loop coverage.",
	parameters: echoToolSchema,
	async execute(_toolCallId, params) {
		const value =
			params && typeof params === "object" && "value" in params && typeof params.value === "string"
				? params.value
				: "ok";
		return {
			content: [{ type: "text", text: `echo:${value}` }],
			details: { value },
		};
	},
};

function customEntries(sessionManager: SessionManager, customType: string): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

describe("Context Steady AgentSession dogfood runtime", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-dogfood-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages) await authStorage.close();
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	it("runs multi-turn provider steps with plan audits, digests, checkpoints, and tool loop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const responses: Array<Record<string, unknown>> = [];
		for (let turn = 1; turn <= 8; turn++) {
			if (turn === 3) {
				responses.push({
					content: [{ type: "toolCall", id: `call_dog_${turn}`, name: "echo", arguments: { value: `t${turn}` } }],
				});
				responses.push({ content: [`tool loop complete turn ${turn}`] });
			} else {
				responses.push({ content: [`dogfood turn ${turn} done`] });
			}
		}
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Dogfood"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		for (let turn = 1; turn <= 8; turn++) {
			await session.prompt(`Dogfood turn ${turn}: continue San context steady implementation`);
			await session.waitForIdle();
		}

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const plans = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		const checkpoints = customEntries(sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE);

		expect(digests.length).toBeGreaterThanOrEqual(8);
		expect(plans.length).toBeGreaterThanOrEqual(8);
		expect(checkpoints.length).toBeGreaterThanOrEqual(1);
		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);

		// No active packet engine injection; plan is ephemeral on the wire only.
		const lastProviderPayload = JSON.stringify(mock.calls.at(-1)!.context.messages);
		expect(lastProviderPayload).toContain("<san_context_plan>");
		expect(lastProviderPayload).not.toContain("<san_context_packet>");
		expect(
			sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === CONTEXT_PLAN_MESSAGE_TYPE),
		).toBe(false);
		expect(
			sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === CONTEXT_PACKET_MESSAGE_TYPE),
		).toBe(false);

		// Tool loop exercised a second provider call within one turn.
		expect(mock.calls.length).toBeGreaterThan(8);

		// Status/breakdown remains available after multi-turn dogfood (may be estimate-only
		// when mock usage is zero; still must not throw and should expose a finite number).
		const breakdown = session.getContextBreakdown();
		expect(breakdown).toBeDefined();
		expect(typeof breakdown?.usedTokens).toBe("number");
		expect(Number.isFinite(breakdown?.usedTokens)).toBe(true);

		// Checkpoint epoch/rebase metadata present.
		const checkpointData = checkpoints.at(-1)!.data as {
			epochId?: string;
			rebaseReason?: string;
			coveredSourceEntryRefs?: string[];
		};
		expect(checkpointData.epochId).toBeTruthy();
		expect(checkpointData.rebaseReason).toBeTruthy();

		// Latest plan audit should prefer real journal refs after remap (no pending_*).
		const latestPlan = plans.at(-1)!.data as {
			qualityGate?: { protectedEntryRefs?: string[]; outcome?: string };
			budget?: { steadyTarget?: number; burstCeiling?: number };
		};
		expect(latestPlan.qualityGate?.outcome).toBeDefined();
		const protectedRefs = latestPlan.qualityGate?.protectedEntryRefs ?? [];
		expect(protectedRefs.every(ref => !ref.startsWith("pending_"))).toBe(true);
		const branchIds = new Set(sessionManager.getBranch().map(entry => entry.id));
		expect(protectedRefs.every(ref => branchIds.has(ref))).toBe(true);
		expect(latestPlan.budget?.steadyTarget).toBe(240_000);
		expect(latestPlan.budget?.burstCeiling).toBe(320_000);
	});

	it("keeps a 60-call logical turn running across recursive Segment maintenance", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled dogfood model");
		const model = { ...bundled, contextWindow: 50_000, maxTokens: 4_000 };
		const responses: Array<Record<string, unknown>> = [];
		for (let call = 1; call <= 60; call++) {
			responses.push({
				content: [
					{
						type: "toolCall",
						id: `segment_call_${call}`,
						name: "echo",
						arguments: { value: `${"segment-payload-".repeat(90)}${call}` },
					},
				],
				usage: { input: call * 750, output: 20, totalTokens: call * 750 + 20 },
			});
		}
		responses.push({ content: ["all 60 tool calls completed"] });
		const mock = createMockModel({ responses });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `Recursive segment summary through ${preparation.messagesToSummarize.length} messages.`,
			shortSummary: "Long tool turn compacted",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Segment stress dogfood"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 8_000,
			"san.contextSteady.burstWindowTokens": 12_000,
			"san.contextSteady.segment.enabled": true,
			"san.contextSteady.segment.maxDigestInputTokens": 10_000,
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 40_000,
			"compaction.keepRecentTokens": 2_500,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "segment-stress-auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "segment-stress-models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("执行包含 60 次工具调用的长任务，中间维护上下文但不要停止");
		await session.waitForIdle();

		const segments = customEntries(sessionManager, CONTEXT_SEGMENT_CUSTOM_TYPE).map(
			entry => entry.data as ContextSegment,
		);
		expect(mock.calls).toHaveLength(61);
		expect(compactSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(segments.length).toBeGreaterThanOrEqual(2);
		expect(new Set(segments.map(segment => segment.logicalTurnId)).size).toBe(1);
		expect(segments.every(segment => !("budget" in segment))).toBe(true);
		expect(session.messages.at(-1)?.role).toBe("assistant");
		expect(JSON.stringify(session.messages.at(-1))).toContain("all 60 tool calls completed");
		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(1);
	});

	it("records topic_shift rebase on explicit topic change", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Dogfood"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.prompt("Implement auth middleware for the API gateway");
		await session.waitForIdle();
		await session.prompt("new topic: compare unrelated language models");
		await session.waitForIdle();

		const plans = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		const shifted = plans
			.map(entry => entry.data as { rebaseReason?: string })
			.filter(data => data.rebaseReason === "topic_shift");
		expect(shifted.length).toBeGreaterThan(0);

		const lastPayload = JSON.stringify(mock.calls.at(-1)!.context.messages);
		// Explicit topic shift should not keep injecting the old auth digest intent.
		// (Plan shell may still appear; digest body should drop.)
		expect(lastPayload.includes("auth middleware") && lastPayload.includes("userIntent: Implement")).toBe(false);
	});
});
