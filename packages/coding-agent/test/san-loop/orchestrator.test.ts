import { describe, expect, test } from "bun:test";
import type { SanLoopDefect, SanLoopRole, SanLoopTaskNode } from "../../src/san-loop";
import {
	applySanLoopPlan,
	applySanLoopReview,
	createSanLoopRunSnapshot,
	defaultSanLoopModePolicy,
	dispatchSanLoopAssignments,
	recordSanLoopWorkerResult,
} from "../../src/san-loop";

const CREATED_AT = "2026-07-01T00:00:00.000Z";

function taskNode(id: string): SanLoopTaskNode {
	return {
		id,
		title: `Task ${id}`,
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: ["passes focused verification"],
		checkRefs: ["supervisor-gate"],
	};
}

describe("San loop orchestrator", () => {
	test("defines mode policies for mature loop execution depth", () => {
		expect(defaultSanLoopModePolicy("solo")).toMatchObject({
			mode: "solo",
			maxRetries: 1,
			maxWorkers: 1,
			remainingTurns: 3,
			requireOracle: false,
			pipeline: ["worker"],
		});
		expect(defaultSanLoopModePolicy("council")).toMatchObject({
			maxRetries: 3,
			maxWorkers: 6,
			requireOracle: true,
		});
		expect(defaultSanLoopModePolicy("rush").mode).toBe("solo");
	});

	test("moves a run from planning through worker review readiness", () => {
		const run = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver v0.2 loop",
			mode: "team",
			runId: "loop_orchestrator",
			createdAt: CREATED_AT,
		});
		const planned = applySanLoopPlan(
			run,
			{
				constraints: ["preserve session history", "preserve session history"],
				acceptanceCriteria: ["ledger is append-only"],
				taskGraph: [taskNode("p4-orchestrator")],
				checkPlan: ["supervisor-gate"],
				riskRegister: ["agent fan-out may drift"],
			},
			{ createdAt: "2026-07-01T00:01:00.000Z" },
		);

		expect(planned.eventType).toBe("plan_created");
		expect(planned.run.status).toBe("dispatching");
		expect(planned.run.plan?.constraints).toEqual(["preserve session history"]);
		expect(planned.run.decisions.at(-1)?.nextAction).toBe("dispatch_workers");

		const dispatched = dispatchSanLoopAssignments(
			planned.run,
			[
				{
					assignmentId: "assign-1",
					objective: "Implement orchestrator",
					taskNodeIds: ["p4-orchestrator"],
					instructions: "Add transition helpers and tests.",
					acceptanceCriteria: ["focused tests pass"],
					contextRefs: ["ctx-1"],
					checkRefs: ["supervisor-gate"],
					createdAt: "2026-07-01T00:02:00.000Z",
				},
			],
			{ createdAt: "2026-07-01T00:02:00.000Z" },
		);

		expect(dispatched.eventType).toBe("assignment_created");
		expect(dispatched.run.status).toBe("working");
		expect(dispatched.run.assignments).toMatchObject([
			{
				assignmentId: "assign-1",
				status: "pending",
				taskNodeIds: ["p4-orchestrator"],
				contextRefs: ["ctx-1"],
			},
		]);

		const completed = recordSanLoopWorkerResult(
			dispatched.run,
			{
				resultId: "result-1",
				assignmentId: "assign-1",
				status: "completed",
				summary: "Orchestrator helpers added.",
				changedFiles: ["packages/coding-agent/src/san-loop/orchestrator.ts"],
				commandsRun: [{ command: "bun test test/san-loop", exitCode: 0, summary: "passed", source: "host" }],
				verification: ["focused tests pass"],
				createdAt: "2026-07-01T00:03:00.000Z",
			},
			{ createdAt: "2026-07-01T00:03:00.000Z" },
		);

		expect(completed.eventType).toBe("worker_completed");
		expect(completed.run.status).toBe("reviewing");
		expect(completed.run.assignments[0]?.status).toBe("completed");
		expect(completed.run.workerResults[0]?.changedFiles).toEqual([
			"packages/coding-agent/src/san-loop/orchestrator.ts",
		]);
	});

	test("turns retryable review defects into bounded retries", () => {
		const run = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver v0.2 loop",
			mode: "solo",
			runId: "loop_retry",
			createdAt: CREATED_AT,
			maxRetries: 1,
		});
		const defect: SanLoopDefect = {
			defectId: "defect-1",
			severity: "high",
			title: "Missing verification",
			evidence: ["No focused test result in worker evidence"],
			retryable: true,
			suggestedFix: "Run focused San loop tests",
		};

		const firstReview = applySanLoopReview(
			run,
			{
				reportId: "review-1",
				reviewer: "supervisor",
				verdict: "needs_fix",
				defects: [defect],
				requiredNextActions: ["rerun focused tests"],
				confidence: "high",
				createdAt: "2026-07-01T00:04:00.000Z",
			},
			{ createdAt: "2026-07-01T00:04:00.000Z" },
		);

		expect(firstReview.eventType).toBe("retry_requested");
		expect(firstReview.run.status).toBe("retrying");
		expect(firstReview.run.retryCount).toBe(1);
		expect(firstReview.run.finalVerdict).toBeUndefined();

		const secondReview = applySanLoopReview(
			firstReview.run,
			{
				reportId: "review-2",
				reviewer: "supervisor",
				verdict: "needs_fix",
				defects: [defect],
				requiredNextActions: ["manual intervention"],
				confidence: "high",
				createdAt: "2026-07-01T00:05:00.000Z",
			},
			{ createdAt: "2026-07-01T00:05:00.000Z" },
		);

		expect(secondReview.retryExhausted).toBe(true);
		expect(secondReview.run.status).toBe("failed");
		expect(secondReview.run.retryCount).toBe(1);
		expect(secondReview.run.finalVerdict).toBe("needs_fix");
	});

	test("finalizes a passing supervisor review only with successful worker commands", () => {
		const base = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver v0.2 loop",
			runId: "loop_pass",
			createdAt: CREATED_AT,
		});
		const withWorker = recordSanLoopWorkerResult(base, {
			resultId: "result-pass",
			assignmentId: "assign-1",
			status: "completed",
			summary: "Worker finished with tests.",
			commandsRun: [{ command: "bun test", exitCode: 0, summary: "passed", source: "host" }],
		}).run;

		const reviewed = applySanLoopReview(
			withWorker,
			{
				reportId: "review-pass",
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: ["bun test test/san-loop"],
				evidence: ["all focused tests passed"],
				confidence: "high",
				createdAt: "2026-07-01T00:06:00.000Z",
			},
			{ createdAt: "2026-07-01T00:06:00.000Z" },
		);

		expect(reviewed.eventType).toBe("finalized");
		expect(reviewed.run.status).toBe("passed");
		expect(reviewed.run.finalVerdict).toBe("pass");
		expect(reviewed.run.reviewReports[0]?.testsRun).toEqual(["bun test test/san-loop"]);
		expect(reviewed.run.decisions.at(-1)?.nextAction).toBe("finalize");
	});

	test("blocks pass when worker commands failed even if review is empty-pass", () => {
		const base = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Reject failed command evidence",
			runId: "loop_fail_cmd",
			createdAt: CREATED_AT,
		});
		const withWorker = recordSanLoopWorkerResult(base, {
			resultId: "result-fail-cmd",
			assignmentId: "assign-1",
			status: "completed",
			summary: "Worker reported a failing test.",
			commandsRun: [{ command: "bun test", exitCode: 1, summary: "failed", source: "host" }],
		}).run;

		const reviewed = applySanLoopReview(
			withWorker,
			{
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: [],
				evidence: [],
				confidence: "high",
			},
			{ createdAt: "2026-07-01T00:06:00.000Z" },
		);

		expect(reviewed.run.status).toBe("blocked");
		expect(reviewed.run.finalVerdict).toBe("blocked");
		expect(reviewed.run.reviewReports.at(-1)?.defects.some(d => d.defectId === "host-evidence-gate-blocked")).toBe(
			true,
		);
	});

	test("does not unlock pass with successful commands from a previous retry", () => {
		const base = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Reject stale retry evidence",
			runId: "loop_stale_evidence",
			createdAt: CREATED_AT,
		});
		const afterFirst = recordSanLoopWorkerResult(base, {
			resultId: "result-attempt-1",
			assignmentId: "assign-1",
			status: "completed",
			summary: "First attempt had tests.",
			commandsRun: [{ command: "bun test", exitCode: 0, summary: "passed", source: "host" }],
		}).run;
		const afterSecond = recordSanLoopWorkerResult(afterFirst, {
			resultId: "result-attempt-2",
			assignmentId: "assign-2",
			status: "completed",
			summary: "Second attempt ran no commands.",
			commandsRun: [],
		}).run;

		const reviewed = applySanLoopReview(
			afterSecond,
			{
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: [],
				evidence: [],
				confidence: "high",
			},
			{ createdAt: "2026-07-01T00:06:00.000Z", currentBatchAssignmentIds: ["assign-2"] },
		);

		expect(reviewed.run.status).toBe("blocked");
		expect(reviewed.run.finalVerdict).toBe("blocked");
		expect(reviewed.run.reviewReports.at(-1)?.defects.some(d => d.defectId === "host-evidence-gate-blocked")).toBe(
			true,
		);
	});

	test("blocks pass when worker only claims model-sourced commandsRun", () => {
		const base = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Reject model self-reported commands",
			runId: "loop_model_claim",
			createdAt: CREATED_AT,
		});
		const withWorker = recordSanLoopWorkerResult(base, {
			resultId: "result-model-claim",
			assignmentId: "assign-1",
			status: "completed",
			summary: "Worker claimed tests without host receipts.",
			commandsRun: [{ command: "bun test", exitCode: 0, summary: "passed", source: "model" }],
		}).run;

		const reviewed = applySanLoopReview(
			withWorker,
			{
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: ["bun test"],
				evidence: ["model claimed pass"],
				confidence: "high",
			},
			{ createdAt: "2026-07-01T00:06:00.000Z" },
		);

		expect(reviewed.run.status).toBe("blocked");
		expect(reviewed.run.finalVerdict).toBe("blocked");
		expect(reviewed.run.reviewReports.at(-1)?.defects.some(d => d.defectId === "host-evidence-gate-blocked")).toBe(
			true,
		);
	});

	test("does not share mutable pipeline arrays across policy lookups", () => {
		const first = defaultSanLoopModePolicy("solo");
		(first.pipeline as SanLoopRole[]).push("supervisor");
		expect(defaultSanLoopModePolicy("solo").pipeline).toEqual(["worker"]);
	});
});
