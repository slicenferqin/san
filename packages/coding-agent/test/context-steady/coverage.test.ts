/**
 * ContextPlan coverage validator contract tests.
 */

import { describe, expect, test } from "bun:test";
import { validateContextPlanCoverage } from "../../src/context-steady/coverage";
import {
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanAudit,
	type ContextPlanMaterial,
	type ContextSourceIndex,
} from "../../src/context-steady/plan-types";
import { TURN_DIGEST_SCHEMA_VERSION, type TurnDigest } from "../../src/context-steady/types";

function digestMaterial(materialId = "m1"): ContextPlanMaterial {
	const digest: TurnDigest = {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: "turn-1",
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId: "u1", toEntryId: "a1", promptGeneration: 1 },
		userIntent: "covered turn",
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
			entryRefs: ["d1"],
			tokenEstimate: 10,
			reason: "digest covers settled turn",
		},
		entryId: "d1",
		digest,
		coveredEntryRefs: ["u1", "a1"],
	};
}

function sourceIndex(entryIds: string[] = ["u1", "a1", "d1"]): ContextSourceIndex {
	return {
		exactEntries: [],
		turnBundles: [],
		toolPairs: [],
		fileEvidence: [],
		attachments: [],
		digests: [],
		checkpoints: [],
		entryIds,
	};
}

function audit(materials: ContextPlanMaterial[] = [digestMaterial()]): ContextPlanAudit {
	return {
		schemaVersion: CONTEXT_PLAN_SCHEMA_VERSION,
		planId: "plan-1",
		sessionId: "s1",
		epochId: "epoch-1",
		promptGeneration: 1,
		createdAt: "2026-07-12T00:00:00.000Z",
		budget: {
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			steadyTarget: 240_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			selectedInputLimit: 260_000,
			selectedInputMode: "steady",
			messageBudget: 240_000,
			planTokenBudget: 20_000,
			reserveTokens: 100_000,
			reserveRatio: 0.2,
		},
		qualityGate: {
			outcome: "pass",
			reasons: [],
			protectedEntryRefs: [],
			missingEntryRefs: [],
			requiredTokens: 0,
			selectedInputTokens: 20_000,
			activeEntryCount: 2,
			archivedEntryCount: 0,
		},
		materials: materials.map(material => material.audit),
		coverage: [{ sourceEntryRefs: ["u1", "a1"], replacementMaterialId: "m1", reason: "digest replacement" }],
	};
}

describe("validateContextPlanCoverage", () => {
	test("accepts coverage that points to existing material and indexed sources", () => {
		const material = digestMaterial();
		const result = validateContextPlanCoverage({
			audit: audit([material]),
			materials: [material],
			sourceIndex: sourceIndex(),
		});

		expect(result.valid).toBe(true);
		expect(result.coveredEntryRefs).toEqual(["u1", "a1"]);
		expect(result.issues).toEqual([]);
	});

	test("rejects coverage that references missing replacement material", () => {
		const material = digestMaterial();
		const invalidAudit = audit([material]);
		invalidAudit.coverage = [{ sourceEntryRefs: ["u1"], replacementMaterialId: "missing", reason: "bad coverage" }];

		const result = validateContextPlanCoverage({
			audit: invalidAudit,
			materials: [material],
			sourceIndex: sourceIndex(),
		});

		expect(result.valid).toBe(false);
		expect(result.coveredEntryRefs).toEqual([]);
		expect(result.issues.map(issue => issue.code)).toEqual(["coverage_without_material"]);
	});

	test("rejects coverage that references entries outside the source index", () => {
		const material = digestMaterial();
		const invalidAudit = audit([material]);
		invalidAudit.coverage = [
			{ sourceEntryRefs: ["u1", "missing-entry"], replacementMaterialId: "m1", reason: "bad ref" },
		];

		const result = validateContextPlanCoverage({
			audit: invalidAudit,
			materials: [material],
			sourceIndex: sourceIndex(),
		});

		expect(result.valid).toBe(false);
		expect(result.coveredEntryRefs).toEqual(["u1"]);
		expect(result.issues.map(issue => issue.code)).toEqual(["coverage_missing_source_ref"]);
	});

	test("rejects runtime material that is absent from audit materials", () => {
		const material = digestMaterial();
		const invalidAudit = audit([]);
		invalidAudit.coverage = [];

		const result = validateContextPlanCoverage({
			audit: invalidAudit,
			materials: [material],
			sourceIndex: sourceIndex(),
		});

		expect(result.valid).toBe(false);
		expect(result.issues.map(issue => issue.code)).toEqual(["material_audit_missing"]);
	});

	test("rejects coverage that claims refs outside the replacement material", () => {
		const material = digestMaterial();
		const invalidAudit = audit([material]);
		invalidAudit.coverage = [{ sourceEntryRefs: ["u2"], replacementMaterialId: "m1", reason: "bad ref" }];

		const result = validateContextPlanCoverage({
			audit: invalidAudit,
			materials: [material],
			sourceIndex: sourceIndex(["u1", "a1", "u2", "d1"]),
		});

		expect(result.valid).toBe(false);
		expect(result.coveredEntryRefs).toEqual([]);
		expect(result.issues.map(issue => issue.code)).toEqual(["coverage_outside_material"]);
	});

	test("rejects duplicate source coverage across materials", () => {
		const first = digestMaterial("m1");
		const second = { ...digestMaterial("m2"), coveredEntryRefs: ["u1"] };
		const invalidAudit = audit([first, second]);
		invalidAudit.coverage = [
			{ sourceEntryRefs: ["u1"], replacementMaterialId: "m1", reason: "first" },
			{ sourceEntryRefs: ["u1"], replacementMaterialId: "m2", reason: "second" },
		];

		const result = validateContextPlanCoverage({
			audit: invalidAudit,
			materials: [first, second],
			sourceIndex: sourceIndex(),
		});

		expect(result.valid).toBe(false);
		expect(result.coveredEntryRefs).toEqual(["u1"]);
		expect(result.issues.map(issue => issue.code)).toEqual(["coverage_duplicate_source_ref"]);
	});
});
