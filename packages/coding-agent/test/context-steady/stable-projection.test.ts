/**
 * Stable-projection (M2) contracts: pinned plan position, epoch-frozen bytes,
 * and the volatile recall channel. Flag-gated; default-off behavior is covered
 * by the M1/M2 integration suites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@san/agent";
import type { AssistantMessage } from "@san/ai";
import * as ai from "@san/ai";
import { createMockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import {
	buildContextRecallMessage,
	estimateContextPlanProjectedTokens,
	materializeContextPlanMessages,
} from "@san/coding-agent/context-steady/materialize";
import { buildContextPlan } from "@san/coding-agent/context-steady/planner";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import type { CustomEntry } from "@san/coding-agent/session/session-entries";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";
import { CONTEXT_PLAN_CUSTOM_TYPE, CONTEXT_PLAN_MESSAGE_TYPE } from "../../src/context-steady/plan-types";
import { TURN_DIGEST_CUSTOM_TYPE } from "../../src/context-steady/types";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.activationThresholdTokens": 0,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
	"san.contextSteady.digest.llm.enabled": true,
	"san.contextSteady.digest.llm.modelRole": "anthropic/claude-sonnet-4-5",
	"san.contextSteady.qualityWindowTokens": 240_000,
	"san.contextSteady.burstWindowTokens": 320_000,
	"san.contextSteady.reserveRatio": 0.2,
	"san.contextSteady.contextPlan.enabled": true,
	"san.contextSteady.contextPlan.recentDigests": 5,
	"san.contextSteady.contextPlan.maxTokens": 3000,
	"san.contextSteady.contextPlan.recentExactTokens": 0,
	"san.contextSteady.contextPlan.stableProjection": true,
	"san.contextSteady.checkpoint.enabled": true,
	"san.contextSteady.checkpoint.everyTurns": 8,
	"san.contextSteady.checkpoint.maxTokens": 12000,
};

/** Net-benefit padding: covered raw history must outweigh the plan wire cost. */
const RAW_BODY = "alpha beta gamma delta epsilon zeta ".repeat(96);

function digestAssistant(turn: number, prefix: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `digest_${prefix}_${turn}`,
				name: "record_turn_digest",
				arguments: {
					userIntent: `${prefix} turn ${turn}: continue the settled implementation`,
					actionsTaken: [`Completed settled turn ${turn}.`],
					decisions: ["Keep the stable checkpoint before the digest tail."],
					filesTouched: [],
					factsLearned: [`Invariant ${turn} remained valid.`],
					openQuestions: [],
					risks: [],
					nextSteps: [`Continue turn ${turn + 1}.`],
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

function authoritativeDigestSpy(prefix: string) {
	let turn = 0;
	return vi.spyOn(ai, "completeSimple").mockImplementation(async () => digestAssistant(++turn, prefix));
}

type ProviderCall = { context: { messages: unknown[] } };

function planMessagesOf(call: ProviderCall): unknown[] {
	return call.context.messages;
}

function isPlanMessage(message: unknown): boolean {
	return JSON.stringify((message as { content?: unknown }).content ?? "").includes("<san_context_plan>");
}

function customEntries(sessionManager: SessionManager, customType: string): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

async function createSession(settings: Record<string, unknown>) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
		convertToLlm,
	});
	const sessionManager = SessionManager.inMemory();
	const isolated = Settings.isolated(settings);
	const authStorage = await AuthStorage.create(path.join(shared.tempDir, "auth.db"));
	shared.authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(shared.tempDir, "models.yml"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	shared.session = new AgentSession({ agent, sessionManager, settings: isolated, modelRegistry });
	return { session: shared.session, sessionManager, mock };
}

const shared: {
	session: AgentSession | undefined;
	tempDir: string;
	authStorages: AuthStorage[];
} = { session: undefined, tempDir: "", authStorages: [] };

describe("Context Steady stable projection", () => {
	beforeEach(() => {
		shared.tempDir = path.join(os.tmpdir(), `pi-stable-projection-${Snowflake.next()}`);
		fs.mkdirSync(shared.tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (shared.session) await shared.session.dispose();
		for (const authStorage of shared.authStorages) await authStorage.close();
		vi.restoreAllMocks();
		removeSyncWithRetries(shared.tempDir);
		shared.session = undefined;
		shared.authStorages = [];
	});

	it("pins the plan at the payload head and keeps bytes and prefix stable within an epoch", async () => {
		authoritativeDigestSpy("stable epoch");
		const { session, sessionManager, mock } = await createSession(BASE_SETTINGS);

		await session.prompt(`Continue stable epoch turn one ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt(`Continue stable epoch turn two ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt("Continue stable epoch turn three");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		// Turn 1 has no settled digests: its plan is net-negative and withdrawn —
		// the raw turn ships without any plan message. Stability starts at the
		// first turn that actually carries the frozen plan.
		expect(isPlanMessage(planMessagesOf(mock.calls[0])[0]!)).toBe(false);
		// The plan message is the first payload message on every carrying call.
		for (const call of mock.calls.slice(1)) {
			expect(isPlanMessage(planMessagesOf(call)[0]!)).toBe(true);
		}
		// Frozen bytes: turns 2 and 3 ship the identical plan message.
		expect(JSON.stringify(planMessagesOf(mock.calls[2])[0])).toBe(JSON.stringify(planMessagesOf(mock.calls[1])[0]));
		// Monotone prefix: call 2's payload extends call 1's without rewriting it.
		const prefix = planMessagesOf(mock.calls[2]).slice(0, planMessagesOf(mock.calls[1]).length);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(planMessagesOf(mock.calls[1])));
		// Frozen artifact ⇒ no re-layout and no duplicate audits for the epoch:
		// one withdrawn audit from the first turn, one admitted audit from the
		// turn that first carried the frozen plan — and nothing after it.
		const audits = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).map(
			entry => (entry.data as { netBenefit?: { withdrawn?: boolean } }).netBenefit,
		);
		expect(audits).toHaveLength(2);
		expect(audits[0]?.withdrawn).toBe(true);
		expect(audits[1]?.withdrawn).toBe(false);
	});

	it("rebuilds the stable plan after a hard-pressure refusal instead of freezing the refused plan", async () => {
		authoritativeDigestSpy("pressure rebase");
		const { session, sessionManager, mock } = await createSession({
			...BASE_SETTINGS,
			"san.contextSteady.qualityWindowTokens": 2_000,
			"san.contextSteady.burstWindowTokens": 3_000,
			"san.contextSteady.contextPlan.maxTokens": 500,
		});

		await session.prompt(`Warm up the stable plan ${RAW_BODY}`);
		await session.waitForIdle();
		await expect(session.prompt(`HARD_PRESSURE_PROMPT ${"x".repeat(40_000)}`)).rejects.toThrow(/hard pressure/i);

		const refusedPlan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)?.data as
			| { qualityGate?: { outcome?: string } }
			| undefined;
		expect(refusedPlan?.qualityGate?.outcome).toBe("hard_pressure");

		// Make the persisted refused prompt fit so the next request can exercise
		// the pending budget-pressure rebase instead of failing a second time.
		session.settings.override("san.contextSteady.qualityWindowTokens", 240_000);
		session.settings.override("san.contextSteady.burstWindowTokens", 320_000);
		await session.prompt("Continue after the hard-pressure refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const latestPlan = customEntries(sessionManager, CONTEXT_PLAN_CUSTOM_TYPE).at(-1)?.data as
			| { rebaseReason?: string; qualityGate?: { outcome?: string } }
			| undefined;
		expect(latestPlan?.rebaseReason).toBe("budget_pressure");
		expect(latestPlan?.qualityGate?.outcome).not.toBe("hard_pressure");
	});

	it("re-lays the plan out when a new checkpoint opens a new epoch, then freezes again", async () => {
		authoritativeDigestSpy("epoch flip");
		const { session, sessionManager, mock } = await createSession({
			...BASE_SETTINGS,
			"san.contextSteady.checkpoint.everyTurns": 2,
		});

		await session.prompt(`Continue epoch flip turn one ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt(`Continue epoch flip turn two ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt(`Continue epoch flip turn three ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt("Continue epoch flip turn four");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(4);
		// A checkpoint landed after turn 2: turn 3's plan is a new layout that
		// includes the checkpoint material, differing from turn 2's plan.
		const turnTwoPlan = JSON.stringify(planMessagesOf(mock.calls[1])[0]);
		const turnThreePlan = JSON.stringify(planMessagesOf(mock.calls[2])[0]);
		const turnFourPlan = JSON.stringify(planMessagesOf(mock.calls[3])[0]);
		expect(turnThreePlan).not.toBe(turnTwoPlan);
		expect(turnThreePlan).toContain("checkpoint");
		// The new epoch freezes again: turns 3 and 4 share identical plan bytes.
		expect(turnFourPlan).toBe(turnThreePlan);
	});

	it("re-lays the plan out on an explicit topic shift and freezes the new epoch", async () => {
		authoritativeDigestSpy("topic shift");
		const { session, mock } = await createSession(BASE_SETTINGS);

		await session.prompt(`Continue topic shift turn one ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt(`Continue topic shift turn two ${RAW_BODY}`);
		await session.waitForIdle();
		// Explicit topic shift: epoch boundary. Relevance drops the digests, so the
		// re-laid plan is empty and net-negative — withdrawn from the wire.
		await session.prompt("Ignore previous context and start a fresh investigation");
		await session.waitForIdle();
		await session.prompt(`Continue topic shift turn four ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt("Continue topic shift turn five");
		await session.waitForIdle();

		const planBytes = mock.calls.map(call =>
			JSON.stringify(call.context.messages.find(message => isPlanMessage(message)) ?? null),
		);
		const [first, planA, shifted, planB, frozenB] = planBytes;
		expect(first).toBe("null"); // no digests yet: withdrawn
		expect(shifted).toBe("null"); // topic shift: relevance-excluded, withdrawn
		expect(planA).not.toBe("null");
		expect(planB).not.toBe("null");
		expect(planB).not.toBe(planA); // new epoch re-laid the plan
		expect(frozenB).toBe(planB); // ...and the new epoch froze again
	});

	it("re-lays the plan out when the model context window changes mid-session", async () => {
		authoritativeDigestSpy("window flip");
		const { session, mock } = await createSession(BASE_SETTINGS);

		await session.prompt(`Continue window flip turn one ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt(`Continue window flip turn two ${RAW_BODY}`);
		await session.waitForIdle();
		const beforeSwitch = JSON.stringify(mock.calls[1]!.context.messages.find(message => isPlanMessage(message)));

		const smallerWindow = getBundledModel("anthropic", "claude-haiku-4-5")!;
		await session.setModel(smallerWindow);
		await session.prompt(`Continue window flip turn three ${RAW_BODY}`);
		await session.waitForIdle();
		await session.prompt("Continue window flip turn four");
		await session.waitForIdle();

		const afterSwitch = JSON.stringify(mock.calls[2]!.context.messages.find(message => isPlanMessage(message)));
		const frozenAfterSwitch = JSON.stringify(mock.calls[3]!.context.messages.find(message => isPlanMessage(message)));
		expect(afterSwitch).not.toBe(beforeSwitch); // window change is an epoch boundary
		expect(frozenAfterSwitch).toBe(afterSwitch); // the new epoch froze again
	});

	it("retains a strictly longer provider prefix across turns than the legacy floating mode", async () => {
		const runScenario = async (stable: boolean) => {
			authoritativeDigestSpy(stable ? "prefix stable" : "prefix legacy");
			const { session, mock } = await createSession({
				...BASE_SETTINGS,
				"san.contextSteady.contextPlan.stableProjection": stable,
			});
			for (let turn = 1; turn <= 4; turn++) {
				await session.prompt(`Continue prefix probe turn ${turn} ${RAW_BODY}`);
				await session.waitForIdle();
			}
			const payloads = mock.calls.map(call => call.context.messages as unknown[]);
			const prefixLength = (a: unknown[], b: unknown[]) => {
				let index = 0;
				while (index < a.length && index < b.length && JSON.stringify(a[index]) === JSON.stringify(b[index])) {
					index += 1;
				}
				return index;
			};
			// Retention = how much of each payload survives into the next one.
			const retention = payloads
				.slice(0, -1)
				.map((payload, index) => prefixLength(payload, payloads[index + 1]!) / payload.length);
			const planBytes = payloads.map(messages => JSON.stringify(messages.find(m => isPlanMessage(m)) ?? null));
			const distinctPlanBytes = new Set(planBytes.filter(bytes => bytes !== "null")).size;
			await session.dispose();
			return { retention, distinctPlanBytes, payloads };
		};

		const legacy = await runScenario(false);
		const stable = await runScenario(true);

		// The first transition rewrites by necessity (turn 1 ships no plan; the
		// net-benefit gate admits it only once a digest settles). From the first
		// plan-carrying turn on: legacy floating mode cuts every payload at the
		// churning plan position, stable mode retains each payload in full.
		for (const [index, ratio] of stable.retention.slice(1).entries()) {
			expect(ratio).toBe(1);
			expect(legacy.retention[index + 1] ?? 0).toBeLessThan(1);
		}
		// One frozen artifact for the epoch vs a fresh layout per turn.
		expect(stable.distinctPlanBytes).toBe(1);
		expect(legacy.distinctPlanBytes).toBeGreaterThan(1);
	});

	it("keeps recall out of the rendered plan and ships it as an independent volatile message", () => {
		const recall = {
			query: "continue the parser fix",
			items: [{ content: "recalled fact about the parser", source: "brain", score: 0.9 }],
			tokenBudget: 1000,
		};
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Continue the parser fix", timestamp: 1, provider: "x", model: "x" },
			},
		] as unknown as Parameters<typeof buildContextPlan>[0]["entries"];
		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: {
				qualityWindowTokens: 240_000,
				reserveRatio: 0.2,
				planMaxTokens: 3000,
				burstWindowTokens: 320_000,
			},
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u1"],
			currentPromptText: "Continue the parser fix",
			recall,
			stableProjection: true,
		});

		expect(plan.projectionMode).toBe("pinned");
		expect(plan.materials.some(material => "recall" in material)).toBe(false);
		expect(plan.renderedContent).not.toContain("recalled fact about the parser");

		const recallMessage = buildContextRecallMessage(recall);
		expect(recallMessage).toMatchObject({ role: "custom", customType: "san.context_recall.injected" });
		expect(String((recallMessage as { content: unknown }).content)).toContain("recalled fact about the parser");

		const currentUser = entries[0]!.type === "message" ? entries[0].message : undefined;
		const projected = materializeContextPlanMessages(
			currentUser ? [currentUser] : ([] as never),
			entries,
			plan,
			recallMessage,
		);
		// Pinned plan at the head; volatile recall right before the current user.
		expect(projected[0]).toMatchObject({ customType: CONTEXT_PLAN_MESSAGE_TYPE });
		expect(projected.at(-2)).toMatchObject({ customType: "san.context_recall.injected" });
		expect(projected.at(-1)).toMatchObject({ role: "user" });

		// Estimate parity: the projection estimator counts the recall channel
		// exactly like the materializer ships it (plan + raw + recall).
		const withRecall = estimateContextPlanProjectedTokens(
			currentUser ? [currentUser] : ([] as never),
			entries,
			plan,
			recallMessage,
		);
		const withoutRecall = estimateContextPlanProjectedTokens(
			currentUser ? [currentUser] : ([] as never),
			entries,
			plan,
			undefined,
		);
		expect(withRecall).toBeGreaterThan(withoutRecall);

		// A prior recall injection is stripped on the next projection.
		const nextProjected = materializeContextPlanMessages(
			[...projected, { role: "user", content: "next", timestamp: 2 } as never],
			entries,
			plan,
			undefined,
		);
		expect(
			nextProjected.filter(
				message => (message as { customType?: string }).customType === "san.context_recall.injected",
			),
		).toHaveLength(0);
	});
});
