import type { AsyncJob } from "../async";
import type { TaskContractSnapshot } from "../execution-control/task-contract";
import type { AgentRef } from "../registry/agent-registry";
import type { SanLoopRunSnapshot } from "../san-loop/types";
import type { WorkflowNode, WorkflowRun } from "../workflows/types";

export type CoordinationUserState = "working" | "done" | "blocked";

export interface CoordinationTechnicalRefs {
	readonly contractId?: string;
	readonly scopeId?: string;
	readonly jobId?: string;
	readonly agentId?: string;
	readonly runId?: string;
	readonly nodeIds?: readonly string[];
	readonly assignmentIds?: readonly string[];
	readonly messageIds?: readonly string[];
}

export interface CoordinationActivity {
	readonly activityId: string;
	readonly label: string;
	readonly userState: CoordinationUserState;
	readonly progress?: string;
	readonly nextAction: string;
	readonly primaryHandle?: string;
	readonly technicalRefs: CoordinationTechnicalRefs;
}

export interface CoordinationTaskSource {
	readonly contract: Readonly<TaskContractSnapshot>;
	readonly label?: string;
	readonly job?: Pick<AsyncJob, "id" | "status" | "label" | "agentId">;
	readonly agent?: Pick<AgentRef, "id" | "status" | "activity">;
}

export interface CoordinationWorkflowSource {
	readonly run: Readonly<WorkflowRun>;
	readonly label?: string;
}

export interface CoordinationSanLoopSource {
	readonly run: Readonly<SanLoopRunSnapshot>;
	readonly label?: string;
}

export interface CoordinationMessageSource {
	readonly activityId: string;
	readonly messageId: string;
}

export interface CoordinationActivitySources {
	readonly tasks?: readonly CoordinationTaskSource[];
	readonly workflows?: readonly CoordinationWorkflowSource[];
	readonly sanLoops?: readonly CoordinationSanLoopSource[];
	readonly messages?: readonly CoordinationMessageSource[];
}

function displayLabel(value: string | undefined, fallback: string): string {
	const normalized = value?.replace(/[\u0000\s]+/gu, " ").trim();
	return normalized || fallback;
}

function messageIdsFor(
	activityId: string,
	messages: readonly CoordinationMessageSource[],
): readonly string[] | undefined {
	const ids = messages.filter(message => message.activityId === activityId).map(message => message.messageId);
	return ids.length > 0 ? ids : undefined;
}

function refsWithMessages(
	refs: CoordinationTechnicalRefs,
	activityId: string,
	messages: readonly CoordinationMessageSource[],
): CoordinationTechnicalRefs {
	const messageIds = messageIdsFor(activityId, messages);
	return messageIds ? { ...refs, messageIds } : refs;
}

function taskActivity(
	source: CoordinationTaskSource,
	messages: readonly CoordinationMessageSource[],
): CoordinationActivity {
	const { contract, job, agent } = source;
	const activityId = `task:${contract.contractId}`;
	const label = displayLabel(source.label ?? job?.label, "Task");
	const primaryHandle = agent?.id ?? job?.agentId;
	const refs = refsWithMessages(
		{
			contractId: contract.contractId,
			scopeId: contract.scopeId,
			...(job?.id ? { jobId: job.id } : {}),
			...(primaryHandle ? { agentId: primaryHandle } : {}),
		},
		activityId,
		messages,
	);

	if (contract.status === "completed") {
		return {
			activityId,
			label,
			userState: "done",
			nextAction: "Review the result or continue with a follow-up.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}
	if (contract.status === "failed") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The task stopped without completing.",
			nextAction: "Review the failure and decide whether to retry.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}
	if (contract.status === "cancelled" || contract.status === "rejected") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The task did not complete.",
			nextAction: "Decide whether to restart the task.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}

	const progress = agent?.activity ?? (job?.status === "running" ? job.label : undefined);
	return {
		activityId,
		label,
		userState: "working",
		...(progress ? { progress: displayLabel(progress, "Working") } : {}),
		nextAction: "Wait for the task to finish; send a follow-up only if needed.",
		...(primaryHandle ? { primaryHandle } : {}),
		technicalRefs: refs,
	};
}

function activeWorkflowNode(run: WorkflowRun): WorkflowNode | undefined {
	return run.nodes.find(node => node.status === "running" || node.status === "scheduled");
}

function workflowActivity(
	source: CoordinationWorkflowSource,
	messages: readonly CoordinationMessageSource[],
): CoordinationActivity {
	const { run } = source;
	const activityId = `workflow:${run.runId}`;
	const activeNode = activeWorkflowNode(run);
	const primaryHandle = activeNode?.agentRef;
	const refs = refsWithMessages(
		{
			runId: run.runId,
			nodeIds: run.nodes.map(node => node.nodeId),
			...(primaryHandle ? { agentId: primaryHandle } : {}),
		},
		activityId,
		messages,
	);
	const label = displayLabel(source.label ?? run.workflowName, "Workflow");

	if (run.status === "completed") {
		return {
			activityId,
			label,
			userState: "done",
			progress: "The workflow completed.",
			nextAction: "Review the result and apply any pending delivery action.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}
	if (run.status === "pending") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The workflow is waiting for approval.",
			nextAction: "Approve the workflow to start it.",
			technicalRefs: refs,
		};
	}
	if (run.status === "paused") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The workflow is paused.",
			nextAction: "Resume the workflow or stop it.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}
	if (run.status === "failed" || run.status === "cancelled" || run.status === "blocked") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The workflow stopped before reaching its goal.",
			nextAction: "Review the stopping reason before retrying or changing the plan.",
			...(primaryHandle ? { primaryHandle } : {}),
			technicalRefs: refs,
		};
	}

	const completedNodes = run.nodes.filter(node => node.status === "completed").length;
	const progress = `${completedNodes} of ${run.nodes.length} steps complete${run.currentPhase ? `; ${displayLabel(run.currentPhase, "working")}` : ""}.`;
	return {
		activityId,
		label,
		userState: "working",
		progress,
		nextAction: "Continue the workflow until it reaches a final state.",
		...(primaryHandle ? { primaryHandle } : {}),
		technicalRefs: refs,
	};
}

function sanLoopActivity(
	source: CoordinationSanLoopSource,
	messages: readonly CoordinationMessageSource[],
): CoordinationActivity {
	const { run } = source;
	const activityId = `san-loop:${run.runId}`;
	const completedAssignments = run.assignments.filter(assignment => assignment.status === "completed").length;
	const activeAssignment = run.assignments.find(assignment => assignment.status === "in_progress");
	const refs = refsWithMessages(
		{
			runId: run.runId,
			assignmentIds: run.assignments.map(assignment => assignment.assignmentId),
		},
		activityId,
		messages,
	);
	const label = displayLabel(source.label ?? run.objective, "San execution");

	if (run.status === "passed") {
		return {
			activityId,
			label,
			userState: "done",
			progress: "The quality checks passed.",
			nextAction: "Review the completed result.",
			technicalRefs: refs,
		};
	}
	if (run.status === "blocked" || run.status === "failed" || run.status === "aborted" || run.status === "aborting") {
		return {
			activityId,
			label,
			userState: "blocked",
			progress: "The execution loop needs attention before it can finish.",
			nextAction: "Review the latest result and choose whether to recover or stop.",
			technicalRefs: refs,
		};
	}

	const phase = run.status === "planning" ? "planning" : run.status;
	const progress = `${completedAssignments} of ${run.assignments.length} assignments complete; ${displayLabel(phase, "working")}.`;
	return {
		activityId,
		label,
		userState: "working",
		progress,
		nextAction: activeAssignment
			? "Continue the active assignment and wait for the next review step."
			: "Continue the execution loop until it reaches a final state.",
		technicalRefs: refs,
	};
}

/** Read-only, deterministic projection from authority snapshots to user state. */
export class CoordinationActivityProjector {
	project(sources: CoordinationActivitySources = {}): CoordinationActivity[] {
		const messages = sources.messages ?? [];
		const activities = [
			...(sources.tasks ?? []).map(task => taskActivity(task, messages)),
			...(sources.workflows ?? []).map(workflow => workflowActivity(workflow, messages)),
			...(sources.sanLoops ?? []).map(run => sanLoopActivity(run, messages)),
		];
		return activities.sort((left, right) => left.activityId.localeCompare(right.activityId));
	}
}

export function projectCoordinationActivities(sources: CoordinationActivitySources = {}): CoordinationActivity[] {
	return new CoordinationActivityProjector().project(sources);
}

export function renderCoordinationActivitySummary(activities: readonly CoordinationActivity[]): string {
	if (activities.length === 0) return "No active coordinated work.";
	const working = activities.filter(activity => activity.userState === "working");
	const blocked = activities.filter(activity => activity.userState === "blocked");
	const done = activities.filter(activity => activity.userState === "done");
	const headline = [
		working.length > 0 ? `${working.length} working` : undefined,
		blocked.length > 0 ? `${blocked.length} blocked` : undefined,
		done.length > 0 ? `${done.length} done` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join(", ");
	const lines = activities.map(activity => {
		const status = activity.userState === "working" ? "Working" : activity.userState === "done" ? "Done" : "Blocked";
		const progress = activity.progress ? ` — ${activity.progress}` : "";
		return `- ${status}: ${activity.label}${progress} Next: ${activity.nextAction}`;
	});
	return [`Coordinated work: ${headline}.`, ...lines].join("\n");
}

/** Render one novice-facing status line; technical references stay out of the main surface. */
export function renderCoordinationActivityLine(activities: readonly CoordinationActivity[]): string | undefined {
	const blocked = activities.find(activity => activity.userState === "blocked");
	if (blocked) {
		return `Blocked: ${blocked.label}${blocked.progress ? ` — ${blocked.progress}` : ""} Next: ${blocked.nextAction}`;
	}
	const working = activities.filter(activity => activity.userState === "working");
	if (working.length > 0) {
		const first = working[0];
		const remainder = working.length > 1 ? ` (+${working.length - 1} more)` : "";
		return `Working: ${first.label}${remainder}${first.progress ? ` — ${first.progress}` : ""}`;
	}
	const done = activities.find(activity => activity.userState === "done");
	return done ? `Done: ${done.label}${done.progress ? ` — ${done.progress}` : ""}` : undefined;
}
