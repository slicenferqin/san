import { describe, expect, test } from "bun:test";
import { runSanLoopDogfood } from "../../src/san-loop/dogfood";

describe("San loop dogfood verifier", () => {
	test("passes deterministic v0.2 mature execution loop checks", async () => {
		const summary = await runSanLoopDogfood();

		expect(summary.ok).toBe(true);
		expect(summary.runs).toBe(6);
		expect(summary.passedRuns).toBe(2);
		expect(summary.blockedRuns).toBe(3);
		expect(summary.abortedRuns).toBe(1);
		expect(summary.recoveredRuns).toBe(1);
		expect(summary.reviewReports).toBe(5);
		expect(summary.events).toBeGreaterThanOrEqual(25);
		expect(summary.scenarios.map(scenario => scenario.status)).toEqual([
			"passed",
			"passed",
			"blocked",
			"blocked",
			"blocked",
			"aborted",
		]);
		expect(summary.scenarios[1]?.retryCount).toBe(1);
		expect(summary.scenarios[1]?.events).toContain("retry_requested");
		expect(summary.scenarios[2]?.reviews).toBe(2);
		expect(summary.scenarios[2]?.events).toContain("finalized");
		expect(summary.scenarios[3]?.events).toContain("blocked");
		expect(summary.scenarios[3]?.reviews).toBe(0);
		expect(summary.scenarios[4]?.events).toContain("recovered");
		expect(summary.scenarios[5]?.events).toContain("aborted");
		expect(summary.reportText).toContain("San execution loop ledger (5/6 shown)");
		expect(summary.reportText).toContain("Status: passed");
		expect(summary.reportText).toContain("Status: blocked");
		expect(summary.reportText).toContain("Status: aborted");
		expect(summary.reportText).toContain("Active: no");
	});
});
