import { describe, expect, test } from "bun:test";
import { runWorkflowDeterministicDogfood } from "../../src/workflows/dogfood";

describe("San v0.4 Workflow deterministic dogfood", () => {
	test("repeats five Managed SOPs and keeps Ad-hoc approval and delivery single-use", async () => {
		const summary = await runWorkflowDeterministicDogfood();

		expect(summary).toMatchObject({
			ok: true,
			managedSops: 5,
			managedRuns: 25,
			adHocDrafts: 20,
			adHocRevisions: 10,
			adHocRuns: 10,
			unapprovedAgentsStarted: 0,
			rejectedDraftAgentsStarted: 0,
			stableManagedNodeGraphs: true,
			duplicateDeliveries: 0,
			adHocApprovalReuses: 0,
			tokenRolloutStatus: "insufficient_data",
		});
		expect(summary.checks.find(check => check.name === "ad_hoc_once")?.detail).toContain("10 distinct tasks");
		expect(summary.checks.every(check => check.ok)).toBe(true);
		expect(summary.reportText).toContain("Real-model token rollout gate: insufficient_data");
	});
});
