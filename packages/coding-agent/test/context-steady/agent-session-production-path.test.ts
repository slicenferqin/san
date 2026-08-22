/**
 * Production-path acceptance contracts for the Context Steady 240K rewrite.
 *
 * These tests intentionally exercise AgentSession rather than the deterministic
 * planner dogfood so provider payloads, request snapshots, digest fallbacks,
 * compaction, and resume all participate in the same lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@san/agent";
import * as compactionModule from "@san/agent/compaction";
import { estimateTokens } from "@san/agent/compaction";
import type { AssistantMessage, Context, Message, ProviderSessionState } from "@san/ai";
import * as ai from "@san/ai";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { computeNonMessageTokens } from "@san/coding-agent/modes/utils/context-usage";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import type { CustomEntry } from "@san/coding-agent/session/session-entries";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";
import type { ContextPlanAudit } from "../../src/context-steady/plan-types";
import { CONTEXT_PLAN_CUSTOM_TYPE } from "../../src/context-steady/plan-types";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_MAINTENANCE_CUSTOM_TYPE,
	CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE,
	type ContextCheckpoint,
	type ContextMaintenanceAudit,
	type ContextSteadyActivation,
	TURN_DIGEST_CUSTOM_TYPE,
	type TurnDigest,
} from "../../src/context-steady/types";

const PRODUCTION_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.activationThresholdTokens": 0,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
	"san.contextSteady.qualityWindowTokens": 240_000,
	"san.contextSteady.burstWindowTokens": 320_000,
	"san.contextSteady.reserveRatio": 0.2,
	"san.contextSteady.contextPlan.enabled": true,
	"san.contextSteady.contextPlan.recentDigests": 5,
	"san.contextSteady.contextPlan.maxTokens": 3000,
	"san.contextSteady.contextPlan.recentExactTokens": 3000,
	"san.contextSteady.contextPlan.liveTailTokens": 6000,
	"san.contextSteady.checkpoint.enabled": true,
	"san.contextSteady.checkpoint.everyTurns": 4,
	"san.contextSteady.checkpoint.maxTokens": 12000,
	"compaction.autoContinue": false,
	"contextPromotion.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
};

interface RequestObservation {
	providerTokens: number;
	statusTokens: number | undefined;
}

interface RuntimeHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	observations: RequestObservation[];
}

function customEntries(sessionManager: SessionManager, customType: string): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

function providerMessageTokens(messages: readonly Message[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message as unknown as AgentMessage), 0);
}

function messageText(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap(block =>
			block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
}

function contextPlanText(context: Context): string {
	return context.messages.map(messageText).find(text => text.includes("<san_context_plan>")) ?? "";
}

function contextPlanWireTokens(context: Context): number {
	return estimateTokens({ role: "user", content: contextPlanText(context), timestamp: 0 });
}

function rawMarkersInPayload(context: Context, prefix: string, turns: number): string[] {
	const payload = JSON.stringify(context.messages);
	return Array.from({ length: turns }, (_, index) => `${prefix}_${index + 1}`).filter(marker => {
		return new RegExp(`${marker}(?!\\d)`).test(payload);
	});
}

function digestAssistant(turn: number, prefix: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `digest_${prefix}_${turn}`,
				name: "record_turn_digest",
				arguments: {
					userIntent: `${prefix} turn ${turn}: continue bounded context implementation`,
					actionsTaken: [`Completed bounded production-path turn ${turn}.`],
					decisions: ["Keep the stable checkpoint before the bounded digest tail."],
					filesTouched: [],
					factsLearned: [`Production-path invariant ${turn} remained valid.`],
					openQuestions: [],
					risks: [],
					nextSteps: [`Continue ${prefix} turn ${turn + 1}.`],
					memoryCandidates: [],
				},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function normalizeProviderMessages(messages: readonly Message[]): unknown {
	return JSON.parse(
		JSON.stringify(messages, (key, value) => {
			if (key === "timestamp" || key === "responseId" || key === "duration") return undefined;
			return value;
		}),
	);
}

describe("Context Steady production-path completion", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-production-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		for (const authStorage of authStorages.splice(0).reverse()) await authStorage.close();
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	async function createHarness(
		settingsValues: Parameters<typeof Settings.isolated>[0],
		options: { persisted?: boolean; contextWindow?: number; responsePrefix?: string; sessionFile?: string } = {},
	): Promise<RuntimeHarness> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled production-path test model");
		const model = options.contextWindow ? { ...bundled, contextWindow: options.contextWindow } : bundled;
		const observations: RequestObservation[] = [];
		let activeSession: AgentSession | undefined;
		const mock = createMockModel({
			handler: context => {
				const providerTokens = activeSession
					? computeNonMessageTokens(activeSession) + providerMessageTokens(context.messages)
					: 0;
				observations.push({
					providerTokens,
					statusTokens: activeSession?.getContextBreakdown()?.usedTokens,
				});
				return {
					content: [`${options.responsePrefix ?? "production"} response ${observations.length}`],
					usage: { input: providerTokens, totalTokens: providerTokens },
				};
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Context Steady production acceptance"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionDir = path.join(tempDir, `sessions-${sessions.length}`);
		const sessionManager = options.sessionFile
			? await SessionManager.open(options.sessionFile, undefined, undefined, { suppressBreadcrumb: true })
			: options.persisted
				? SessionManager.create(tempDir, sessionDir)
				: SessionManager.inMemory(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, `models-${authStorages.length}.yml`));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(settingsValues),
			modelRegistry,
		});
		activeSession = session;
		sessions.push(session);
		return { session, sessionManager, mock, observations };
	}

	it("keeps a 20-turn LLM-digest session bounded across resume with one shared request snapshot", async () => {
		let digestTurn = 0;
		const digestSpy = vi
			.spyOn(ai, "completeSimple")
			.mockImplementation(async () => digestAssistant(++digestTurn, "LLM bounded"));
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "unexpected ContextPlan compaction",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const harness = await createHarness(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.digest.llm.enabled": true,
				"san.contextSteady.digest.llm.modelRole": "anthropic/claude-sonnet-4-5",
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 16_000,
				"compaction.keepRecentTokens": 1000,
			},
			{ persisted: true, responsePrefix: "LLM bounded" },
		);
		const rawBody = "alpha beta gamma delta epsilon zeta ".repeat(160);

		for (let turn = 1; turn <= 20; turn++) {
			await harness.session.prompt(
				`LLM bounded turn ${turn}: continue the same implementation ${rawBody} LLM_RAW_END_${turn}`,
			);
			await harness.session.waitForIdle();
			if (turn === 10) {
				await harness.sessionManager.flush();
				await harness.session.reload();
			}
		}

		const digests = customEntries(harness.sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const plans = customEntries(harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		const checkpoints = customEntries(harness.sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE);
		expect(harness.mock.calls).toHaveLength(20);
		expect(digestSpy).toHaveBeenCalledTimes(20);
		expect(digests).toHaveLength(20);
		expect(digests.every(entry => (entry.data as TurnDigest).fallback === false)).toBe(true);
		expect(plans).toHaveLength(20);
		expect(plans.some(entry => (entry.data as ContextPlanAudit).qualityGate.outcome === "pass")).toBe(true);
		expect(checkpoints.length).toBeGreaterThanOrEqual(4);
		expect(compactSpy).toHaveBeenCalledTimes(0);

		for (let index = 0; index < plans.length; index++) {
			const audit = plans[index]!.data as ContextPlanAudit;
			const call = harness.mock.calls[index]!;
			const observation = harness.observations[index]!;
			expect(contextPlanWireTokens(call.context)).toBeLessThanOrEqual(audit.budget.planTokenBudget);
			expect(observation.providerTokens).toBe(audit.qualityGate.projectedInputTokens ?? -1);
			expect(observation.statusTokens).toBe(observation.providerTokens);
			expect(observation.providerTokens).toBeLessThanOrEqual(audit.qualityGate.projectedInputLimit ?? 0);
		}

		const rawStoredTokens =
			computeNonMessageTokens(harness.session) +
			harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const finalObservation = harness.observations.at(-1)!;
		expect(rawStoredTokens).toBeGreaterThan(16_000);
		expect(finalObservation.providerTokens).toBeLessThan(rawStoredTokens);
		expect(rawMarkersInPayload(harness.mock.calls.at(-1)!.context, "LLM_RAW_END", 20).length).toBeLessThanOrEqual(4);

		const resumePlan = plans
			.map(entry => entry.data as ContextPlanAudit)
			.find(audit => audit.rebaseReason === "resume");
		expect(resumePlan).toBeDefined();
		expect(JSON.stringify(harness.mock.calls[10]!.context.messages)).toContain("LLM bounded turn 10");

		const latestPlan = plans.at(-1)!.data as ContextPlanAudit;
		const activeDerived = latestPlan.materials.filter(material =>
			["checkpoint", "digest", "recall"].includes(material.representation),
		);
		expect(activeDerived.length).toBeLessThanOrEqual(6);
		const checkpointMaterial = activeDerived.find(material => material.representation === "checkpoint");
		const digestEntryRefs = new Set(
			activeDerived.filter(material => material.representation === "digest").flatMap(material => material.entryRefs),
		);
		expect(checkpointMaterial).toBeDefined();
		const checkpointEntry = harness.sessionManager.getEntry(checkpointMaterial!.entryRefs[0]!);
		expect(checkpointEntry?.type).toBe("custom");
		const checkpoint = (checkpointEntry as CustomEntry).data as ContextCheckpoint;
		expect(checkpoint.entryRefs.some(entryRef => digestEntryRefs.has(entryRef))).toBe(false);
	});

	it("forwards the configured digest model thinking selector to the side request", async () => {
		const digestSpy = vi
			.spyOn(ai, "completeSimple")
			.mockImplementation(async () => digestAssistant(1, "Configured digest effort"));
		const harness = await createHarness({
			...PRODUCTION_SETTINGS,
			"san.contextSteady.digest.llm.enabled": true,
			"san.contextSteady.digest.llm.modelRole": "anthropic/claude-sonnet-4-5:high",
		});

		await harness.session.prompt("Use the configured digest effort.");
		await harness.session.waitForIdle();

		const digestCall = digestSpy.mock.calls.find(
			([, , options]) => options?.metadata?.sanSideRequest === "context_steady.turn_digest",
		);
		expect(digestCall?.[2]?.reasoning).toBe(ai.Effort.High);
		expect(digestCall?.[2]?.disableReasoning).toBe(false);
	});

	it("bounds 20 fallback-only turns by compacting before the plan needs the burst band", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Fallback-only history compacted at the ContextPlan safety boundary.",
			shortSummary: "Fallback history compacted",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const harness = await createHarness(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.digest.llm.enabled": false,
				"san.contextSteady.qualityWindowTokens": 18_000,
				"san.contextSteady.burstWindowTokens": 24_000,
				"san.contextSteady.contextPlan.maxTokens": 1500,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 200_000,
				"compaction.keepRecentTokens": 1000,
			},
			{ contextWindow: 500_000, responsePrefix: "fallback bounded" },
		);
		const rawBody = "alpha beta gamma delta epsilon zeta ".repeat(180);

		for (let turn = 1; turn <= 20; turn++) {
			await harness.session.prompt(
				`Fallback bounded turn ${turn}: continue the same implementation ${rawBody} FALLBACK_RAW_END_${turn}`,
			);
			await harness.session.waitForIdle();
		}

		const digests = customEntries(harness.sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const plans = customEntries(harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(harness.mock.calls).toHaveLength(20);
		expect(compactSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(digests).toHaveLength(20);
		expect(digests.every(entry => (entry.data as TurnDigest).fallback === true)).toBe(true);
		expect(plans.every(entry => (entry.data as ContextPlanAudit).qualityGate.outcome !== "hard_pressure")).toBe(true);

		const finalAudit = plans.at(-1)!.data as ContextPlanAudit;
		const maintenanceAudits = customEntries(harness.sessionManager, CONTEXT_MAINTENANCE_CUSTOM_TYPE).map(
			entry => entry.data as ContextMaintenanceAudit,
		);
		const finalCall = harness.mock.calls.at(-1)!;
		const finalObservation = harness.observations.at(-1)!;
		expect(finalObservation.providerTokens).toBe(finalAudit.qualityGate.projectedInputTokens ?? -1);
		expect(finalObservation.statusTokens).toBe(finalObservation.providerTokens);
		expect(finalObservation.providerTokens).toBeLessThanOrEqual(finalAudit.qualityGate.projectedInputLimit ?? 0);
		expect(contextPlanWireTokens(finalCall.context)).toBeLessThanOrEqual(finalAudit.budget.planTokenBudget);
		expect(finalAudit.qualityGate.archivedEntryCount).toBeGreaterThan(0);
		expect(finalAudit.qualityGate.activeCutoffEntryId).toBeTruthy();
		// The pre-turn gate compacts while the plan is still inside its control band, so neither
		// the burst band nor the hard-pressure rescue is ever needed. While the two gates
		// disagreed, this same run escalated to `burst_required` for three consecutive turns and
		// was saved only by the emergency recovery pass, at 23,851 of 24,000 projected tokens.
		// Total compactions are unchanged — one — the fix moved when it happens, not how often.
		expect(plans.map(entry => (entry.data as ContextPlanAudit).qualityGate.outcome)).not.toContain("burst_required");
		expect(maintenanceAudits).toHaveLength(0);
		// Raw survivors must be a contiguous recent tail — everything older is projected into
		// digests and checkpoints. Compacting at the control band instead of at the burst ceiling
		// moves the cut earlier (before turn 12, not turn 15), so the reclaimed budget flows back
		// into verbatim recency: more raw turns kept under the same token ceiling, not fewer.
		const rawTurns = rawMarkersInPayload(finalCall.context, "FALLBACK_RAW_END", 20).map(marker =>
			Number(marker.slice("FALLBACK_RAW_END_".length)),
		);
		expect(rawTurns.length).toBeLessThanOrEqual(12);
		expect(rawTurns).toEqual(Array.from({ length: rawTurns.length }, (_, index) => 21 - rawTurns.length + index));
		expect(
			customEntries(harness.sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE).every(entry => {
				return ((entry.data as ContextCheckpoint).coveredSourceEntryRefs ?? []).length === 0;
			}),
		).toBe(true);
	});

	it("recovers a single-step jump past the burst ceiling instead of refusing the turn", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "History compacted to absorb a single oversized prompt.",
			shortSummary: "History compacted for oversized prompt",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const harness = await createHarness(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.digest.llm.enabled": false,
				"san.contextSteady.qualityWindowTokens": 18_000,
				"san.contextSteady.burstWindowTokens": 24_000,
				"san.contextSteady.contextPlan.maxTokens": 1500,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 200_000,
				"compaction.keepRecentTokens": 1000,
			},
			{ contextWindow: 500_000, responsePrefix: "jump bounded" },
		);
		const rawBody = "alpha beta gamma delta epsilon zeta ".repeat(180);

		// Ten ordinary turns settle inside the control band, so the pre-turn steady gate has
		// nothing to do and the accumulation never reaches the burst ceiling on its own.
		for (let turn = 1; turn <= 10; turn++) {
			await harness.session.prompt(`Jump bounded turn ${turn}: continue the same work ${rawBody}`);
			await harness.session.waitForIdle();
		}
		const settledPlans = customEntries(harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE);
		expect(settledPlans.every(entry => (entry.data as ContextPlanAudit).qualityGate.outcome === "pass")).toBe(true);
		expect(compactSpy.mock.calls).toHaveLength(0);

		// One prompt then clears the whole control→burst margin in a single step — a window
		// shrink or a pasted payload does the same thing. No gate can pre-empt this, so the
		// pre-turn hard-pressure recovery has to reclaim the history and let the turn through.
		await harness.session.prompt(
			`Jump bounded overflow: ${"alpha beta gamma delta epsilon zeta ".repeat(1200)} JUMP_RAW_END`,
		);
		await harness.session.waitForIdle();

		const maintenanceAudits = customEntries(harness.sessionManager, CONTEXT_MAINTENANCE_CUSTOM_TYPE).map(
			entry => entry.data as ContextMaintenanceAudit,
		);
		expect(maintenanceAudits.map(audit => audit.state)).toEqual(["maintenance", "recovered"]);
		expect(maintenanceAudits.every(audit => audit.phase === "pre_turn")).toBe(true);
		expect(maintenanceAudits.every(audit => audit.reason === "hard_pressure")).toBe(true);
		expect(compactSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Recovery must produce a sendable request, not a refusal.
		expect(harness.mock.calls).toHaveLength(11);
		const finalAudit = customEntries(harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)!
			.data as ContextPlanAudit;
		expect(finalAudit.qualityGate.outcome).not.toBe("hard_pressure");
		const finalObservation = harness.observations.at(-1)!;
		expect(finalObservation.providerTokens).toBeLessThanOrEqual(finalAudit.qualityGate.projectedInputLimit ?? 0);
	});

	it("sends a complete covering plan in the burst band while keeping its wire cap", async () => {
		let digestTurn = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => digestAssistant(++digestTurn, "Burst contract"));
		const harness = await createHarness({
			...PRODUCTION_SETTINGS,
			"san.contextSteady.digest.llm.enabled": true,
			"san.contextSteady.digest.llm.modelRole": "anthropic/claude-sonnet-4-5",
			"san.contextSteady.qualityWindowTokens": 10_000,
			"san.contextSteady.burstWindowTokens": 18_000,
			"san.contextSteady.contextPlan.maxTokens": 3000,
			"san.contextSteady.contextPlan.recentExactTokens": 0,
			"san.contextSteady.checkpoint.everyTurns": 100,
		});

		for (let turn = 1; turn <= 5; turn++) {
			await harness.session.prompt(`Burst contract turn ${turn}: establish the covered baseline`);
			await harness.session.waitForIdle();
		}
		await harness.session.prompt(
			`Continue Burst contract turn 6 and preserve this required prompt ${"alpha beta gamma delta epsilon zeta ".repeat(1250)}`,
		);
		await harness.session.waitForIdle();

		const audit = customEntries(harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)!.data as ContextPlanAudit;
		const call = harness.mock.calls.at(-1)!;
		const planText = contextPlanText(call.context);
		expect(audit.qualityGate.outcome).toBe("burst_required");
		expect(audit.coverage.length).toBeGreaterThan(0);
		expect(contextPlanWireTokens(call.context)).toBeLessThanOrEqual(audit.budget.planTokenBudget);
		expect(harness.observations.at(-1)!.providerTokens).toBe(audit.qualityGate.projectedInputTokens ?? -1);
		expect(harness.observations.at(-1)!.providerTokens).toBeLessThanOrEqual(
			audit.qualityGate.projectedInputLimit ?? 0,
		);
		for (const coverage of audit.coverage) {
			expect(audit.materials.some(material => material.materialId === coverage.replacementMaterialId)).toBe(true);
			expect(planText).toContain(coverage.replacementMaterialId);
		}
		expect(planText).toContain("Burst contract turn 1");
	});

	it("keeps below-threshold sessions provider- and journal-equivalent to native", async () => {
		async function run(settings: Parameters<typeof Settings.isolated>[0]) {
			const harness = await createHarness(settings, { responsePrefix: "dormant parity" });
			await harness.session.prompt("Dormant parity turn one");
			await harness.session.waitForIdle();
			await harness.session.prompt("Dormant parity turn two");
			await harness.session.waitForIdle();
			return harness;
		}

		const baseline = await run({
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const finalBaselineMessage = baseline.session.messages.at(-1);
		expect(finalBaselineMessage?.role).toBe("assistant");
		const activationThresholdTokens =
			Math.max(...baseline.observations.map(observation => observation.providerTokens)) +
			estimateTokens(finalBaselineMessage!) +
			1;
		const dormant = await run({
			...PRODUCTION_SETTINGS,
			"san.contextSteady.activationThresholdTokens": activationThresholdTokens,
		});

		expect(dormant.mock.calls).toHaveLength(baseline.mock.calls.length);
		for (let index = 0; index < baseline.mock.calls.length; index++) {
			expect(normalizeProviderMessages(dormant.mock.calls[index]!.context.messages)).toEqual(
				normalizeProviderMessages(baseline.mock.calls[index]!.context.messages),
			);
		}
		expect(customEntries(dormant.sessionManager, CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(dormant.sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(dormant.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(dormant.sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE)).toHaveLength(0);
	});

	it("latches threshold activation and restores it from the dedicated session marker", async () => {
		const activationThresholdTokens = 10_000;
		const initial = await createHarness(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.activationThresholdTokens": activationThresholdTokens,
				"san.contextSteady.digest.enabled": false,
				"san.contextSteady.contextPlan.enabled": false,
				"san.contextSteady.checkpoint.enabled": false,
				"san.contextSteady.segment.enabled": false,
			},
			{ persisted: true, responsePrefix: "activation latch" },
		);

		await initial.session.prompt("Remain below the Context Steady activation threshold.");
		await initial.session.waitForIdle();
		expect(initial.observations[0]?.providerTokens).toBeLessThan(activationThresholdTokens);
		expect(customEntries(initial.sessionManager, CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE)).toHaveLength(0);

		await initial.session.prompt(
			`Cross the Context Steady activation threshold now. ${"alpha beta gamma delta epsilon zeta ".repeat(3500)}`,
		);
		await initial.session.waitForIdle();

		const activationEntries = customEntries(initial.sessionManager, CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE);
		expect(activationEntries).toHaveLength(1);
		const activationEntry = activationEntries[0];
		expect(activationEntry).toBeDefined();
		if (!activationEntry) throw new Error("Expected a Context Steady activation entry");
		const activation = activationEntry.data as ContextSteadyActivation;
		expect(activation).toMatchObject({
			schemaVersion: 1,
			activationThresholdTokens,
		});
		expect(activation.observedInputTokens).toBeGreaterThanOrEqual(activationThresholdTokens);
		expect(customEntries(initial.sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(initial.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE)).toHaveLength(0);

		await initial.sessionManager.flush();
		const sessionFile = initial.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const resumed = await createHarness(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.activationThresholdTokens": 1_000_000,
				"san.contextSteady.digest.enabled": false,
			},
			{ sessionFile: sessionFile!, responsePrefix: "activation resume" },
		);

		await resumed.session.prompt("Use the restored Context Steady activation latch.");
		await resumed.session.waitForIdle();

		// No digests exist in this session (digest was disabled for the initial
		// turns), so the plan cannot be net-positive and is withdrawn from the
		// wire — the persisted plan audit is the proof the steady pipeline ran.
		expect(contextPlanText(resumed.mock.calls[0]!.context)).not.toContain("<san_context_plan>");
		expect(customEntries(resumed.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).length).toBeGreaterThanOrEqual(1);
		const resumedAudit = customEntries(resumed.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)!.data as {
			netBenefit?: { withdrawn: boolean };
		};
		expect(resumedAudit.netBenefit?.withdrawn).toBe(true);
		expect(customEntries(resumed.sessionManager, CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE)).toHaveLength(1);
	});

	it("preserves non-steady provider payloads, journal writes, and provider sessions when disabled", async () => {
		async function run(settings: Parameters<typeof Settings.isolated>[0], suffix: string) {
			const harness = await createHarness(settings, { responsePrefix: "disabled parity" });
			let closeCount = 0;
			const providerState: ProviderSessionState = {
				close() {
					closeCount += 1;
				},
			};
			harness.session.providerSessionState.set(`disabled-${suffix}`, providerState);
			await harness.session.prompt("Disabled parity turn one");
			await harness.session.waitForIdle();
			await harness.session.prompt("Disabled parity turn two");
			await harness.session.waitForIdle();
			return { harness, closeCount };
		}

		const baseline = await run(
			{
				"todo.enabled": false,
				"todo.reminders": false,
			},
			"baseline",
		);
		const disabled = await run(
			{
				...PRODUCTION_SETTINGS,
				"san.contextSteady.enabled": false,
			},
			"explicit",
		);

		expect(disabled.harness.mock.calls).toHaveLength(baseline.harness.mock.calls.length);
		for (let index = 0; index < baseline.harness.mock.calls.length; index++) {
			expect(normalizeProviderMessages(disabled.harness.mock.calls[index]!.context.messages)).toEqual(
				normalizeProviderMessages(baseline.harness.mock.calls[index]!.context.messages),
			);
		}
		expect(customEntries(disabled.harness.sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(disabled.harness.sessionManager, CONTEXT_PLAN_CUSTOM_TYPE)).toHaveLength(0);
		expect(customEntries(disabled.harness.sessionManager, CONTEXT_CHECKPOINT_CUSTOM_TYPE)).toHaveLength(0);
		expect(disabled.closeCount).toBe(0);
	});
});
