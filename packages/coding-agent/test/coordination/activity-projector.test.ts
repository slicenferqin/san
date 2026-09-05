import { describe, expect, test } from "bun:test";
import {
	projectCoordinationActivities,
	renderCoordinationActivityLine,
	renderCoordinationActivitySummary,
} from "../../src/coordination";
import type { TaskContractSnapshot } from "../../src/execution-control";
import type { SanLoopRunSnapshot } from "../../src/san-loop";
import type { WorkflowRun } from "../../src/workflows";

const contract = (status: TaskContractSnapshot["status"]): TaskContractSnapshot => ({
	contractId: "contract-1",
	scopeId: "scope-1",
	workKey: "work-1",
	strategyKey: "strategy-1",
	taskId: "task-1",
	schemaVersion: 1,
	status,
	heartbeatAt: 1,
	cursor: 0,
	revision: 0,
	createdAt: 1,
	updatedAt: 1,
});

const workflow = (status: WorkflowRun["status"]): WorkflowRun => ({
	runId: "run-1",
	workflowKind: "managed",
	workflowName: "release-check",
	workflowVersion: "1",
	sourceHash: "source",
	argsHash: "args",
	approvalRef: "approval",
	scopeKey: "/workspace",
	status,
	budget: {
		agentsStarted: 0,
		agentsCompleted: 0,
		tokensUsed: 0,
		startedAt: "2026-09-01T00:00:00.000Z",
		elapsedMs: 0,
		limits: { concurrency: 1, agentLimit: 1, tokenLimit: 1000, durationMs: 1000 },
	},
	deliveryState: "pending",
	currentPhase: "checks",
	nodes: [
		{
			nodeId: "node-1",
			callId: "call-1",
			phase: "checks",
			attempt: 1,
			inputHash: "input",
			status: status === "running" ? "running" : status === "completed" ? "completed" : "pending",
			agentRef: "agent-1",
		},
	],
	writeArtifacts: [],
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
});

const sanLoop = (status: SanLoopRunSnapshot["status"]): SanLoopRunSnapshot => ({
	schemaVersion: 1,
	revision: 1,
	runId: "loop-1",
	sessionId: "session-1",
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
	objective: "Validate the release",
	mode: "team",
	status,
	contextPacketRefs: [],
	assignments: [
		{
			assignmentId: "assignment-1",
			runId: "loop-1",
			createdAt: "2026-09-01T00:00:00.000Z",
			objective: "Validate the release",
			taskNodeIds: ["task-1"],
			instructions: "Run checks",
			acceptanceCriteria: [],
			contextRefs: [],
			checkRefs: [],
			status: status === "working" ? "in_progress" : status === "passed" ? "completed" : "pending",
		},
	],
	workerResults: [],
	reviewReports: [],
	decisions: [],
	budget: [],
	retryCount: 0,
	maxRetries: 1,
});

describe("CoordinationActivityProjector", () => {
	test("maps task completion and agent activity without mutating authority snapshots", () => {
		const taskContract = contract("completed");
		const activities = projectCoordinationActivities({
			tasks: [
				{
					contract: taskContract,
					label: "Inspect release",
					agent: { id: "agent-1", status: "idle" },
				},
			],
			messages: [{ activityId: "task:contract-1", messageId: "message-1" }],
		});

		expect(activities).toEqual([
			{
				activityId: "task:contract-1",
				label: "Inspect release",
				userState: "done",
				nextAction: "Review the result or continue with a follow-up.",
				primaryHandle: "agent-1",
				technicalRefs: {
					contractId: "contract-1",
					scopeId: "scope-1",
					agentId: "agent-1",
					messageIds: ["message-1"],
				},
			},
		]);
		expect(taskContract.status).toBe("completed");
	});

	test("maps workflow and San Loop terminal states to blocked or done conservatively", () => {
		const activities = projectCoordinationActivities({
			workflows: [{ run: workflow("blocked") }],
			sanLoops: [{ run: sanLoop("passed") }],
		});

		expect(activities.map(activity => [activity.activityId, activity.userState])).toEqual([
			["san-loop:loop-1", "done"],
			["workflow:run-1", "blocked"],
		]);
		expect(activities.find(activity => activity.activityId === "workflow:run-1")?.nextAction).toContain(
			"stopping reason",
		);
		expect(
			activities.find(activity => activity.activityId === "san-loop:loop-1")?.technicalRefs.assignmentIds,
		).toEqual(["assignment-1"]);
	});

	test("renders the default three-state summary without technical references", () => {
		const activities = projectCoordinationActivities({
			tasks: [{ contract: contract("running"), label: "Inspect release" }],
			workflows: [{ run: workflow("blocked") }],
		});

		const summary = renderCoordinationActivitySummary(activities);

		expect(summary).toContain("1 working, 1 blocked");
		expect(summary).toContain("Working: Inspect release");
		expect(summary).toContain("Blocked: release-check");
		expect(summary).not.toContain("contract-1");
		expect(summary).not.toContain("run-1");
	});

	test("renders blocked work before working work in the compact main-path line", () => {
		const activities = projectCoordinationActivities({
			tasks: [{ contract: contract("running"), label: "Inspect release" }],
			workflows: [{ run: workflow("blocked") }],
		});

		expect(renderCoordinationActivityLine(activities)).toBe(
			"Blocked: release-check — The workflow stopped before reaching its goal. Next: Review the stopping reason before retrying or changing the plan.",
		);
	});
});
