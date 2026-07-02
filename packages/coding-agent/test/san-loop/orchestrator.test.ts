import { describe, expect, test } from "bun:test";
import type { SanLoopDefect, SanLoopTaskNode } from "../../src/san-loop";
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
		expect(defaultSanLoopModePolicy("rush")).toEqual({
			mode: "rush",
			maxRetries: 1,
			maxWorkers: 2,
			remainingTurns: 4,
			requireOracle: false,
		});
		expect(defaultSanLoopModePolicy("deep")).toMatchObject({
			maxRetries: 3,
			maxWorkers: 6,
			requireOracle: true,
		});
	});

	test("moves a run from planning through worker review readiness", () => {
		const run = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver v0.2 loop",
			mode: "smart",
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
				commandsRun: [{ command: "bun test test/san-loop", exitCode: 0, summary: "passed" }],
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
			mode: "rush",
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

	test("finalizes a passing supervisor review", () => {
		const run = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Deliver v0.2 loop",
			runId: "loop_pass",
			createdAt: CREATED_AT,
		});

		const reviewed = applySanLoopReview(
			run,
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
});
