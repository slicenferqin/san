/**
 * ContextPlan materializer contract tests.
 */

import { describe, expect, test } from "bun:test";
import { materializeContextPlanMessages } from "../../src/context-steady/materialize";
import {
	type BuiltContextPlan,
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanMaterial,
} from "../../src/context-steady/plan-types";
import {
	CONTEXT_PACKET_MESSAGE_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "../../src/context-steady/types";

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function digestMaterial(materialId = "m1", entryId = "d1", coveredEntryRefs: string[] = ["u1"]): ContextPlanMaterial {
	const digest: TurnDigest = {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: "turn-1",
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId: "u1", toEntryId: "u1", promptGeneration: 1 },
		userIntent: "old user intent",
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [],
		fallback: true,
	};
	return {
		audit: {
			materialId,
			kind: "turn_digest",
			representation: "digest",
			entryRefs: [entryId],
			tokenEstimate: 10,
			reason: "covered by digest",
		},
		entryId,
		digest,
		coveredEntryRefs,
	};
}

function plan(overrides: Partial<BuiltContextPlan> = {}): BuiltContextPlan {
	const material = digestMaterial();
	return {
		audit: {
			schemaVersion: CONTEXT_PLAN_SCHEMA_VERSION,
			planId: "plan-1",
			sessionId: "s1",
			epochId: "epoch-1",
			promptGeneration: 1,
			createdAt: "2026-07-12T00:00:00.000Z",
			budget: {
				contextWindow: 500_000,
				nonMessageTokens: 10_000,
				steadyTarget: 240_000,
				controlMax: 260_000,
				burstCeiling: 320_000,
				selectedInputLimit: 260_000,
				selectedInputMode: "steady",
				messageBudget: 250_000,
				planTokenBudget: 20_000,
				reserveTokens: 100_000,
				reserveRatio: 0.2,
			},
			qualityGate: { outcome: "pass", reasons: [], protectedEntryRefs: [], missingEntryRefs: [] },
			materials: [material.audit],
			coverage: [{ sourceEntryRefs: ["u1"], replacementMaterialId: "m1", reason: "digest replacement" }],
		},
		materials: [material],
		sourceIndex: {
			exactEntries: [
				{
					kind: "exact",
					entryId: "u1",
					message: { role: "user", content: "old raw user", timestamp: 1 },
				},
				{
					kind: "exact",
					entryId: "u2",
					message: { role: "user", content: "current prompt", timestamp: 2 },
				},
			],
			turnBundles: [],
			toolPairs: [],
			fileEvidence: [],
			attachments: [],
			digests: [],
			checkpoints: [],
			entryIds: ["u1", "u2"],
		},
		requestKey: "request-1",
		renderedContent: "context plan",
		message: {
			role: "custom",
			customType: "san.context_plan.injected",
			content: "context plan",
			display: false,
			timestamp: 3,
		},
		tokenEstimate: 10,
		coverageEntryRefs: ["u1"],
		...overrides,
	};
}

const asMessages = (messages: Record<string, unknown>[]) =>
	messages as unknown as Parameters<typeof materializeContextPlanMessages>[0];
const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof materializeContextPlanMessages>[1];

describe("materializeContextPlanMessages", () => {
	test("removes covered raw entries only when audit coverage points to existing replacement material", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 2, provider: "x", model: "x" };

		const projected = materializeContextPlanMessages(
			asMessages([oldUser, currentUser]),
			asEntries([messageEntry("u1", oldUser), messageEntry("u2", currentUser)]),
			plan(),
		);

		expect(JSON.stringify(projected)).not.toContain("old raw user");
		expect(JSON.stringify(projected)).toContain("context plan");
		expect(JSON.stringify(projected)).toContain("current prompt");
	});

	test("preserves raw entries when coverage lacks replacement material", () => {
		const oldUser = { role: "user", content: "must survive", timestamp: 1, provider: "x", model: "x" };
		const currentUser = { role: "user", content: "current prompt", timestamp: 2, provider: "x", model: "x" };
		const unsafePlan = plan({
			materials: [],
			audit: { ...plan().audit, materials: [], coverage: [] },
		});

		const projected = materializeContextPlanMessages(
			asMessages([oldUser, currentUser]),
			asEntries([messageEntry("u1", oldUser), messageEntry("u2", currentUser)]),
			unsafePlan,
		);

		expect(JSON.stringify(projected)).toContain("must survive");
		expect(JSON.stringify(projected)).toContain("context plan");
	});

	test("preserves duplicate active messages beyond explicit coverage", () => {
		const duplicateA = { role: "user", content: "same prompt", timestamp: 1, provider: "x", model: "x" };
		const duplicateB = { role: "user", content: "same prompt", timestamp: 1, provider: "x", model: "x" };

		const projected = materializeContextPlanMessages(
			asMessages([duplicateA, duplicateB]),
			asEntries([messageEntry("u1", duplicateA)]),
			plan(),
		);

		expect(projected).toHaveLength(2);
		expect(JSON.stringify(projected)).toContain("same prompt");
		expect(JSON.stringify(projected)).toContain("context plan");
	});

	test("strips prior derived packet and plan messages before inserting current plan", () => {
		const oldPacket = {
			role: "custom",
			customType: CONTEXT_PACKET_MESSAGE_TYPE,
			content: "old packet",
			display: false,
			timestamp: 1,
		};
		const oldPlan = {
			role: "custom",
			customType: "san.context_plan.injected",
			content: "old plan",
			display: false,
			timestamp: 2,
		};
		const currentUser = { role: "user", content: "current prompt", timestamp: 3, provider: "x", model: "x" };

		const projected = materializeContextPlanMessages(
			asMessages([oldPacket, oldPlan, currentUser]),
			asEntries([]),
			plan(),
		);
		const text = JSON.stringify(projected);

		expect(text).not.toContain("old packet");
		expect(text).not.toContain("old plan");
		expect(text).toContain("context plan");
		expect(text).toContain("current prompt");
	});
});
