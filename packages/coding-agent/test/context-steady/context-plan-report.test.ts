/**
 * Context Steady State — ContextPlan audit report tests.
 */

import { describe, expect, test } from "bun:test";
import {
	CONTEXT_PLAN_CUSTOM_TYPE,
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanAudit,
} from "../../src/context-steady/plan-types";
import type { SessionEntry } from "../../src/session/session-entries";
import {
	buildContextPlanReportText,
	parseContextPlanReportCount,
} from "../../src/slash-commands/helpers/context-plan-report";

function entryBase(id: string) {
	return {
		id,
		parentId: null,
		timestamp: "2026-07-12T00:00:00.000Z",
	};
}

function plan(overrides: Partial<ContextPlanAudit> = {}): ContextPlanAudit {
	return {
		schemaVersion: CONTEXT_PLAN_SCHEMA_VERSION,
		planId: "plan_test",
		sessionId: "session-1",
		epochId: "epoch-1",
		promptGeneration: 7,
		createdAt: "2026-07-12T00:00:00.000Z",
		budget: {
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			steadyTarget: 240_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			selectedInputLimit: 320_000,
			selectedInputMode: "burst",
			messageBudget: 300_000,
			planTokenBudget: 2_000,
			reserveTokens: 100_000,
			reserveRatio: 0.2,
		},
		qualityGate: {
			outcome: "burst_required",
			reasons: ["protected_entries_exceed_control_band"],
			protectedEntryRefs: ["u-current"],
			missingEntryRefs: [],
			requiredBurstTokens: 10_000,
		},
		materials: [
			{
				materialId: "checkpoint_ck1",
				kind: "checkpoint",
				representation: "checkpoint",
				entryRefs: ["ck1"],
				tokenEstimate: 300,
				reason: "latest stable checkpoint",
			},
			{
				materialId: "digest_d2",
				kind: "turn_digest",
				representation: "digest",
				entryRefs: ["d2"],
				tokenEstimate: 120,
				reason: "recent settled turn digest",
			},
		],
		coverage: [
			{
				replacementMaterialId: "digest_d2",
				sourceEntryRefs: ["u1", "a1"],
				reason: "recent settled turn digest",
			},
		],
		...overrides,
	};
}

function planEntry(id: string, data: ContextPlanAudit): SessionEntry {
	return {
		...entryBase(id),
		type: "custom",
		customType: CONTEXT_PLAN_CUSTOM_TYPE,
		data,
	};
}

describe("ContextPlan audit report", () => {
	test("renders latest plan budget, quality gate, materials, and coverage", () => {
		const report = buildContextPlanReportText([planEntry("plan-entry", plan())]);

		expect(report).toContain("San ContextPlan audit view (1/1 shown)");
		expect(report).toContain("## ContextPlan plan_test");
		expect(report).toContain("Audit entry: plan-entry");
		expect(report).toContain("- selectedInput=burst:320,000");
		expect(report).toContain("- outcome=burst_required");
		expect(report).toContain("- protected=u-current");
		expect(report).toContain("- requiredBurstTokens=10,000");
		expect(report).toContain(
			"- checkpoint_ck1: checkpoint/checkpoint; refs=ck1; tokens=300; reason=latest stable checkpoint",
		);
		expect(report).toContain(
			"- digest_d2: digest/turn_digest; refs=d2; tokens=120; reason=recent settled turn digest",
		);
		expect(report).toContain("- digest_d2; covers=u1, a1; reason=recent settled turn digest");
	});

	test("shows recent plans newest first with bounded count", () => {
		const entries = [
			planEntry("plan-1", plan({ planId: "plan_1" })),
			planEntry("plan-2", plan({ planId: "plan_2" })),
			planEntry("plan-3", plan({ planId: "plan_3" })),
		];

		const report = buildContextPlanReportText(entries, { count: 2 });

		expect(report).toContain("San ContextPlan audit view (2/3 shown)");
		expect(report.indexOf("## ContextPlan plan_3")).toBeLessThan(report.indexOf("## ContextPlan plan_2"));
		expect(report).not.toContain("## ContextPlan plan_1");
	});

	test("reports an empty state when no plans exist", () => {
		expect(buildContextPlanReportText([])).toBe("No San ContextPlan audit entries found.");
	});

	test("parses optional plan report counts", () => {
		expect(parseContextPlanReportCount("")).toBe(1);
		expect(parseContextPlanReportCount("3")).toBe(3);
		expect(parseContextPlanReportCount("0")).toEqual({ error: "Usage: /context plan [1-20]" });
		expect(parseContextPlanReportCount("21")).toEqual({ error: "Usage: /context plan [1-20]" });
		expect(parseContextPlanReportCount("abc")).toEqual({ error: "Usage: /context plan [1-20]" });
	});
});
