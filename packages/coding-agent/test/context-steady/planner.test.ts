/**
 * ContextPlan planner contract tests.
 */

import { describe, expect, test } from "bun:test";
import { materializeContextPlanMessages } from "../../src/context-steady/materialize";
import { applyContextPlanNetBenefitGate, buildContextPlan } from "../../src/context-steady/planner";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_CHECKPOINT_SCHEMA_VERSION,
	type ContextCheckpoint,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "../../src/context-steady/types";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

function digest(
	turnId: string,
	fromEntryId: string,
	toEntryId: string,
	userIntent = "old turn",
	fallback = false,
): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId, toEntryId, promptGeneration: 1 },
		userIntent,
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [],
		fallback,
	};
}

function checkpoint(entryRefs: string[]): ContextCheckpoint {
	return {
		schemaVersion: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
		checkpointId: "checkpoint-1",
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		entryRefs,
		fromDigestEntryId: entryRefs[0] ?? "d1",
		toDigestEntryId: entryRefs.at(-1) ?? "d1",
		digestCount: entryRefs.length,
		summary: {
			userIntents: [{ text: "checkpointed turn", entryRefs }],
			decisions: [],
			filesTouched: [],
			risks: [],
			nextSteps: [],
		},
		tokenEstimate: 10,
		tokenBudget: 100,
		stability: "stable",
		cachePriority: "high",
	};
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextPlan>[0]["entries"];
const asMessages = (messages: Record<string, unknown>[]) =>
	messages as unknown as Parameters<typeof materializeContextPlanMessages>[0];

describe("buildContextPlan", () => {
	test("builds a materialized digest plan that covers settled raw history but keeps current prompt exact", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = { role: "assistant", content: "old raw assistant", timestamp: 2, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1")),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const projected = materializeContextPlanMessages(asMessages([oldUser, oldAssistant, currentUser]), entries, plan);
		const text = JSON.stringify(projected);

		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).toEqual(["u1", "a1"]);
		expect(plan.audit.qualityGate.protectedEntryRefs).toEqual(["u2"]);
		expect(text).not.toContain("old raw user");
		expect(text).not.toContain("old raw assistant");
		expect(text).toContain("current prompt");
		expect(text).toContain("san_context_plan");
	});

	test("excludes protected active tool pair entries from digest coverage", () => {
		const user = { role: "user", content: "edit file", timestamp: 1, provider: "x", model: "x" };
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-edit", name: "edit", arguments: { filePath: "src/app.ts" } }],
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const result = {
			role: "toolResult",
			toolCallId: "tc-edit",
			toolName: "edit",
			content: "patched",
			timestamp: 3,
			provider: "x",
			model: "x",
		};
		const current = { role: "user", content: "continue", timestamp: 4, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", user),
			messageEntry("a1", assistant),
			messageEntry("tr1", result),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "tr1")),
			messageEntry("u2", current),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			activeToolCallIds: ["tc-edit"],
		});

		expect(plan.audit.qualityGate.protectedEntryRefs).toEqual(["u2", "a1", "tr1"]);
		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).toEqual(["u1"]);
	});

	test("selects latest checkpoint plus uncovered digest tail without duplicate coverage", () => {
		const entries = asEntries([
			messageEntry("u1", { role: "user", content: "first", timestamp: 1, provider: "x", model: "x" }),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "first task")),
			customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint(["d1"])),
			messageEntry("u2", { role: "user", content: "second", timestamp: 3, provider: "x", model: "x" }),
			messageEntry("a2", { role: "assistant", content: "done", timestamp: 4, provider: "x", model: "x" }),
			customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "u2", "a2", "second task")),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
		});

		expect(plan.audit.materials.map(material => material.representation)).toEqual(["checkpoint", "digest"]);
		expect(plan.audit.materials.map(material => material.entryRefs)).toEqual([["ck1"], ["d2"]]);
		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).toEqual(["u1", "a1", "u2", "a2"]);
	});

	test("keeps covered digests eligible when a relevant checkpoint cannot enter the plan", () => {
		const entries = asEntries([
			messageEntry("u1", { role: "user", content: "first", timestamp: 1, provider: "x", model: "x" }),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "first task")),
			customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, {
				...checkpoint(["d1"]),
				summary: {
					userIntents: Array.from({ length: 8 }, (_, index) => ({
						text: `checkpoint item ${index} ${"x".repeat(120)}`,
						entryRefs: ["d1"],
					})),
					decisions: [],
					filesTouched: [],
					risks: [],
					nextSteps: [],
				},
				tokenEstimate: 10_000,
			}),
			messageEntry("u2", { role: "user", content: "second", timestamp: 3, provider: "x", model: "x" }),
			messageEntry("a2", { role: "assistant", content: "done", timestamp: 4, provider: "x", model: "x" }),
			customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "u2", "a2", "second task")),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: { ...SETTINGS, planMaxTokens: 200 },
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
		});

		expect(plan.materials.some(material => "checkpoint" in material)).toBe(false);
		expect(plan.materials.flatMap(material => ("digest" in material ? [material.entryId] : []))).toEqual(["d1"]);
		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).toEqual(["u1", "a1"]);
		expect(
			plan.audit.materials.find(
				material => material.entryRefs.includes("ck1") && material.representation === "omitted",
			),
		).toMatchObject({ kind: "checkpoint" });
	});

	test("records quality burst selection when required protected material exceeds steady budget", () => {
		const entries = asEntries([
			messageEntry("spec", { role: "user", content: "long spec", timestamp: 1, provider: "x", model: "x" }),
			messageEntry("prompt", { role: "user", content: "current prompt", timestamp: 2, provider: "x", model: "x" }),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			baseRequiredEntryRefs: ["spec"],
			currentPromptEntryRefs: ["prompt"],
			tokenEstimateByEntryRef: new Map([
				["spec", 180_000],
				["prompt", 80_000],
			]),
		});

		expect(plan.audit.budget.selectedInputMode).toBe("burst");
		expect(plan.audit.qualityGate.outcome).toBe("burst_required");
		expect(plan.audit.qualityGate.protectedEntryRefs).toEqual(["spec", "prompt"]);
	});

	test("distinguishes relevance exclusion from budget omission in the checkpoint audit and notes degraded representation", () => {
		const entries = asEntries([
			messageEntry("u1", { role: "user", content: "first", timestamp: 1, provider: "x", model: "x" }),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "first task")),
			customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint(["d1"])),
			messageEntry("u2", {
				role: "user",
				content: "ignore previous context and start fresh",
				timestamp: 3,
				provider: "x",
				model: "x",
			}),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			currentPromptText: "ignore previous context and start fresh",
		});

		expect(plan.materials.some(material => "checkpoint" in material || "digest" in material)).toBe(false);
		expect(plan.audit.materials.find(material => material.materialId.includes("ck1"))).toMatchObject({
			kind: "checkpoint",
			representation: "omitted",
			reason: "checkpoint excluded by prompt relevance gate",
		});
		expect(plan.audit.materials.find(material => material.kind === "representation")).toMatchObject({
			representation: "omitted",
			reason: expect.stringContaining("history representation degraded"),
		});
	});

	test("net benefit gate withdraws a steady plan that costs more than it saves", () => {
		const entries = asEntries([
			messageEntry("u1", { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" }),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1")),
			messageEntry("u2", { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" }),
		]);
		const base = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		expect(base.audit.qualityGate.outcome).toBe("pass");

		const withdrawn = applyContextPlanNetBenefitGate(base, {
			rawProjectedTokens: 1_000,
			projectedTokens: 1_100,
		});
		expect(withdrawn.withdrawn).toBe(true);
		expect(withdrawn.audit.netBenefit).toMatchObject({ netBenefit: -100, withdrawn: true });

		const kept = applyContextPlanNetBenefitGate(base, { rawProjectedTokens: 1_100, projectedTokens: 800 });
		expect(kept.withdrawn).toBeUndefined();
		expect(kept.audit.netBenefit).toMatchObject({ netBenefit: 300, withdrawn: false });

		// Pressure outcomes need every reclaim they can get: never withdrawn there.
		const pressured = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			projectedInputTokens: 5_000_000,
		});
		expect(pressured.audit.qualityGate.outcome).toBe("hard_pressure");
		expect(
			applyContextPlanNetBenefitGate(pressured, { rawProjectedTokens: 1_000, projectedTokens: 2_000 }).withdrawn,
		).toBeUndefined();
	});

	test("withdrawn plan materializes raw history without plan message or omission", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1")),
			messageEntry("u2", currentUser),
		]);
		const base = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const withdrawn = applyContextPlanNetBenefitGate(base, { rawProjectedTokens: 0, projectedTokens: 100 });

		const projected = materializeContextPlanMessages(
			asMessages([oldUser, oldAssistant, currentUser]),
			entries,
			withdrawn,
		);

		expect(projected).toHaveLength(3);
		const text = JSON.stringify(projected);
		expect(text).toContain("old raw user");
		expect(text).not.toContain("san_context_plan");
	});

	test("carries epoch and rebase reason into the plan audit", () => {
		const plan = buildContextPlan({
			entries: asEntries([]),
			sessionId: "s1",
			requestKey: "r1",
			epochId: "epoch_s1",
			rebaseReason: "resume",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
		});

		expect(plan.audit).toMatchObject({ epochId: "epoch_s1", rebaseReason: "resume" });
	});

	test("keeps fallback digest material as reference without deleting raw source", () => {
		const oldUser = { role: "user", content: "fallback raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = {
			role: "assistant",
			content: "fallback raw assistant",
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "fallback turn", true)),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const projected = materializeContextPlanMessages(asMessages([oldUser, oldAssistant, currentUser]), entries, plan);
		const text = JSON.stringify(projected);

		expect(
			plan.audit.materials.some(material => material.reason.startsWith("fallback digest for reference only")),
		).toBe(true);
		expect(plan.audit.coverage).toEqual([]);
		expect(text).toContain("fallback raw user");
		expect(text).toContain("fallback raw assistant");
	});

	test("does not grant fallback digests coverage authority through a checkpoint material", () => {
		const oldUser = { role: "user", content: "fallback raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = {
			role: "assistant",
			content: "fallback raw assistant",
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "fallback turn", true)),
			customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, {
				...checkpoint(["d1"]),
				coveredSourceEntryRefs: ["u1", "a1"],
			}),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const projected = materializeContextPlanMessages(asMessages([oldUser, oldAssistant, currentUser]), entries, plan);
		const text = JSON.stringify(projected);

		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).not.toContain("u1");
		expect(plan.audit.coverage.flatMap(item => item.sourceEntryRefs)).not.toContain("a1");
		expect(text).toContain("fallback raw user");
		expect(text).toContain("fallback raw assistant");
	});

	test("enforces planMaxTokens by dropping whole materials, not string-slicing coverage", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = { role: "assistant", content: "old raw assistant", timestamp: 2, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry(
				"d1",
				TURN_DIGEST_CUSTOM_TYPE,
				digest("t1", "u1", "a1", `long digest ${"x".repeat(400)} for wire cap`),
			),
			messageEntry("u2", currentUser),
		]);

		const uncapped = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: { ...SETTINGS, planMaxTokens: 40 },
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
		});
		const projected = materializeContextPlanMessages(asMessages([oldUser, oldAssistant, currentUser]), entries, plan);
		const text = JSON.stringify(projected);

		expect(uncapped.tokenEstimate).toBeGreaterThan(40);
		// Tight cap drops the digest material entirely → no coverage, raw retained.
		expect(plan.audit.coverage).toEqual([]);
		expect(text).toContain("old raw user");
		expect(text).toContain("old raw assistant");
		// If any covering material remains, its replacement body must still be whole.
		for (const material of plan.materials) {
			if (material.coveredEntryRefs.length === 0) continue;
			if ("digest" in material) {
				expect(plan.renderedContent).toContain(material.digest.userIntent.slice(0, 40));
			}
		}
	});

	test("fits the final quality-gated ContextPlan wire content within planMaxTokens", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = { role: "assistant", content: "old raw assistant", timestamp: 2, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "completed parser repair")),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: { ...SETTINGS, planMaxTokens: 135 },
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			projectedInputTokens: 270_000,
		});

		expect(plan.audit.qualityGate).toMatchObject({
			outcome: "burst_required",
			projectedInputTokens: 270_000,
		});
		expect(plan.tokenEstimate).toBeLessThanOrEqual(plan.audit.budget.planTokenBudget);
	});

	test("drops unrelated digests on natural topic change without explicit new-topic marker", () => {
		const oldUser = {
			role: "user",
			content: "legacy security audit of auth middleware",
			timestamp: 1,
			provider: "x",
			model: "x",
		};
		const oldAssistant = {
			role: "assistant",
			content: "security audit complete",
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const currentUser = {
			role: "user",
			content: "compare unrelated language models",
			timestamp: 3,
			provider: "x",
			model: "x",
		};
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "legacy security audit")),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			currentPromptText: "compare unrelated language models",
		});

		expect(plan.materials.some(material => "digest" in material)).toBe(false);
		expect(plan.audit.rebaseReason).toBe("topic_shift");
	});

	test("does not mark a topic shift when at least one historical digest remains relevant", () => {
		const entries = asEntries([
			messageEntry("u1", {
				role: "user",
				content: "prepare database migration",
				timestamp: 1,
				provider: "x",
				model: "x",
			}),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "prepare database migration")),
			messageEntry("u2", {
				role: "user",
				content: "implement auth middleware",
				timestamp: 3,
				provider: "x",
				model: "x",
			}),
			messageEntry("a2", { role: "assistant", content: "done", timestamp: 4, provider: "x", model: "x" }),
			customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "u2", "a2", "implement auth middleware")),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 3,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptText: "fix auth middleware regression",
		});

		expect(plan.audit.rebaseReason).toBeUndefined();
		expect(plan.materials.flatMap(material => ("digest" in material ? [material.entryId] : []))).toEqual(["d2"]);
	});

	test("treats delivery of current local changes as continuation", () => {
		const entries = asEntries([
			messageEntry("u1", {
				role: "user",
				content: "implement auth middleware",
				timestamp: 1,
				provider: "x",
				model: "x",
			}),
			messageEntry("a1", { role: "assistant", content: "done", timestamp: 2, provider: "x", model: "x" }),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "implement auth middleware")),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptText: "把当前本地的变更都提交推送吧",
		});

		expect(plan.audit.rebaseReason).toBeUndefined();
		expect(plan.materials.some(material => "digest" in material && material.entryId === "d1")).toBe(true);
	});

	test("drops derived materials on explicit topic shift", () => {
		const oldUser = { role: "user", content: "implement auth middleware", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = {
			role: "assistant",
			content: "auth middleware done",
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const currentUser = {
			role: "user",
			content: "new topic: compare unrelated language models",
			timestamp: 3,
			provider: "x",
			model: "x",
		};
		const entries = asEntries([
			messageEntry("u1", oldUser),
			messageEntry("a1", oldAssistant),
			customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", "implement auth middleware")),
			customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint(["d1"])),
			messageEntry("u2", currentUser),
		]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			currentPromptText: "new topic: compare unrelated language models",
		});

		expect(plan.audit.rebaseReason).toBe("topic_shift");
		expect(plan.materials.some(material => "digest" in material)).toBe(false);
		expect(plan.materials.some(material => "checkpoint" in material)).toBe(false);
	});
});
