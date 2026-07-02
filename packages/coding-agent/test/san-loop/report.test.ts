import { describe, expect, test } from "bun:test";
import {
	appendSanLoopEvent,
	appendSanLoopReviewReport,
	appendSanLoopRunSnapshot,
	createSanLoopEvent,
	createSanLoopRunSnapshot,
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopReviewReport,
	updateSanLoopRunSnapshot,
} from "../../src/san-loop";
import { SessionManager } from "../../src/session/session-manager";
import {
	buildSanLoopReportText,
	parseSanLoopArgs,
	parseSanLoopReportCount,
	sanLoopUsageText,
} from "../../src/slash-commands/helpers/san-loop-report";

function review(runId: string): SanLoopReviewReport {
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		reportId: "review-1",
		runId,
		createdAt: "2026-07-01T00:20:00.000Z",
		reviewer: "supervisor",
		verdict: "needs_fix",
		defects: [
			{
				defectId: "defect-1",
				severity: "high",
				title: "Missing retry cap",
				evidence: ["orchestrator accepted unlimited retry"],
				retryable: true,
				suggestedFix: "Clamp retries from settings",
			},
		],
		testsRun: ["bun test packages/coding-agent/test/san-loop"],
		evidence: ["test output showed failure"],
		retryable: true,
		requiredNextActions: ["Add retry cap"],
		confidence: "high",
	};
}

describe("San loop report", () => {
	test("renders latest run status with review and event evidence", () => {
		const session = SessionManager.inMemory();
		const run = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver mature execution loop",
			mode: "smart",
			runId: "loop_report",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		appendSanLoopRunSnapshot(session, run);
		appendSanLoopEvent(session, createSanLoopEvent(run, "run_created", "started loop", { eventId: "evt_1" }));
		const report = review(run.runId);
		appendSanLoopReviewReport(session, report);
		const updated = updateSanLoopRunSnapshot(run, {
			status: "retrying",
			updatedAt: "2026-07-01T00:25:00.000Z",
			reviewReports: [report],
			retryCount: 1,
		});
		appendSanLoopRunSnapshot(session, updated);

		const text = buildSanLoopReportText(session.getEntries());

		expect(text).toContain("San execution loop ledger (1/1 shown)");
		expect(text).toContain("## San Loop loop_report");
		expect(text).toContain("Status: retrying");
		expect(text).toContain("Active: yes");
		expect(text).toContain("Mode: smart");
		expect(text).toContain("Objective: Deliver mature execution loop");
		expect(text).toContain("Retries: 1/2");
		expect(text).toContain("Review reports: 1");
		expect(text).toContain("- needs_fix by supervisor; confidence=high; retryable=true");
		expect(text).toContain("defects=1");
		expect(text).toContain("next=Add retry cap");
		expect(text).toContain("- run_created: started loop");
		expect(text).toContain("Review entries: 1");
	});

	test("shows recent runs newest first with bounded count", () => {
		const session = SessionManager.inMemory();
		for (const id of ["loop_1", "loop_2", "loop_3"]) {
			appendSanLoopRunSnapshot(
				session,
				createSanLoopRunSnapshot({
					sessionId: "session-1",
					objective: id,
					runId: id,
					createdAt: `2026-07-01T00:0${id.at(-1)}:00.000Z`,
				}),
			);
		}

		const text = buildSanLoopReportText(session.getEntries(), { count: 2 });

		expect(text).toContain("San execution loop ledger (2/3 shown)");
		expect(text.indexOf("## San Loop loop_3")).toBeLessThan(text.indexOf("## San Loop loop_2"));
		expect(text).not.toContain("## San Loop loop_1");
	});

	test("reports empty state and parses status count", () => {
		expect(buildSanLoopReportText([])).toBe("No San execution loop runs found.");
		expect(parseSanLoopReportCount("")).toBe(1);
		expect(parseSanLoopReportCount("3")).toBe(3);
		expect(parseSanLoopReportCount("0")).toEqual({ error: sanLoopUsageText() });
		expect(parseSanLoopReportCount("21")).toEqual({ error: sanLoopUsageText() });
		expect(parseSanLoopReportCount("abc")).toEqual({ error: sanLoopUsageText() });
		expect(parseSanLoopArgs("run --mode deep ship mature loop")).toEqual({
			action: "run",
			mode: "deep",
			objective: "ship mature loop",
		});
		expect(parseSanLoopArgs("run ship mature loop")).toEqual({
			action: "run",
			objective: "ship mature loop",
		});
		expect(parseSanLoopArgs("stop")).toEqual({ action: "stop", runId: undefined });
		expect(parseSanLoopArgs("stop loop_report")).toEqual({ action: "stop", runId: "loop_report" });
		expect(parseSanLoopArgs("stop --all")).toEqual({ error: sanLoopUsageText() });
	});
});
