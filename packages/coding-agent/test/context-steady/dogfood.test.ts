import { describe, expect, test } from "bun:test";
import { runContextSteadyDogfood } from "../../src/context-steady/dogfood";

describe("Context steady dogfood verifier", () => {
	test("passes the deterministic ContextPlan dogfood acceptance checks", () => {
		const summary = runContextSteadyDogfood();

		expect(summary.ok).toBe(true);
		expect(summary.turns).toBe(20);
		expect(summary.digests).toBe(20);
		expect(summary.checkpoints).toBeGreaterThanOrEqual(1);
		expect(summary.plans).toBe(1);
		expect(summary.injectedMessages).toBe(0);
		expect(summary.finalPlanRepresentations).toContain("checkpoint");
		expect(summary.finalPlanRepresentations).toContain("digest");
		expect(summary.finalPlanRepresentations).toContain("recall");
		expect(summary.finalPlanDigestRefs.length).toBeGreaterThan(0);
		expect(summary.finalPlanCheckpointRef).toBeDefined();
		expect(summary.finalPlanRecallRefs).toEqual(["mem-html-docs", "mem-cache-order"]);
		expect(summary.finalPlanTokenEstimate).toBeLessThanOrEqual(summary.finalPlanTokenBudget);
		expect(summary.materializedMessageCount).toBeLessThan(summary.transcriptMessageCount);
		expect(summary.reportText).toContain("San ContextPlan audit view (1/1 shown)");
		expect(summary.reportText).toContain("ContextPlan");
		expect(summary.reportText).toContain("Budget:");
		expect(summary.reportText).toContain("Materials:");
	});

	test("surfaces failed acceptance checks without throwing", () => {
		const summary = runContextSteadyDogfood({ turns: 2, checkpointEveryTurns: 10 });

		expect(summary.ok).toBe(false);
		expect(summary.assertions).toContainEqual({
			name: "checkpoint exists",
			ok: false,
			detail: "0 checkpoints",
		});
		expect(
			summary.assertions.some(
				assertion => assertion.name === "stable prefix before dynamic layers" && !assertion.ok,
			),
		).toBe(true);
	});
});
