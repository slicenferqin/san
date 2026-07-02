import {
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopBudgetSnapshot,
	type SanLoopDecision,
	type SanLoopDefect,
	type SanLoopEventType,
	type SanLoopMode,
	type SanLoopPlan,
	type SanLoopReviewReport,
	type SanLoopReviewVerdict,
	type SanLoopRunSnapshot,
	type SanLoopStatus,
	type SanLoopTaskNode,
	type SanLoopWorkerAssignment,
	type SanLoopWorkerResult,
} from "./types";

export interface SanLoopModePolicy {
	mode: SanLoopMode;
	maxRetries: number;
	maxWorkers: number;
	remainingTurns: number;
	requireOracle: boolean;
}

export interface SanLoopPlanInput {
	objective?: string;
	constraints?: readonly string[];
	acceptanceCriteria?: readonly string[];
	taskGraph?: readonly SanLoopTaskNode[];
	checkPlan?: readonly string[];
	riskRegister?: readonly string[];
}

export interface SanLoopAssignmentInput {
	assignmentId?: string;
	objective: string;
	taskNodeIds: readonly string[];
	instructions: string;
	acceptanceCriteria?: readonly string[];
	contextRefs?: readonly string[];
	checkRefs?: readonly string[];
	createdAt?: string;
}

export interface SanLoopWorkerResultInput {
	resultId?: string;
	assignmentId: string;
	status: SanLoopWorkerResult["status"];
	summary: string;
	changedFiles?: readonly string[];
	commandsRun?: readonly SanLoopWorkerResult["commandsRun"][number][];
	verification?: readonly string[];
	risks?: readonly string[];
	createdAt?: string;
}

export interface SanLoopReviewInput {
	reportId?: string;
	reviewer: SanLoopReviewReport["reviewer"];
	verdict: SanLoopReviewVerdict;
	defects?: readonly SanLoopDefect[];
	testsRun?: readonly string[];
	evidence?: readonly string[];
	retryable?: boolean;
	requiredNextActions?: readonly string[];
	confidence?: SanLoopReviewReport["confidence"];
	assignmentId?: string;
	createdAt?: string;
}

export interface SanLoopTransition {
	run: SanLoopRunSnapshot;
	eventType: SanLoopEventType;
	eventSummary: string;
	retryExhausted: boolean;
}

const DEFAULT_POLICIES: Record<SanLoopMode, SanLoopModePolicy> = {
	rush: {
		mode: "rush",
		maxRetries: 1,
		maxWorkers: 2,
		remainingTurns: 4,
		requireOracle: false,
	},
	smart: {
		mode: "smart",
		maxRetries: 2,
		maxWorkers: 4,
		remainingTurns: 8,
		requireOracle: false,
	},
	deep: {
		mode: "deep",
		maxRetries: 3,
		maxWorkers: 6,
		remainingTurns: 12,
		requireOracle: true,
	},
};

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${Bun.randomUUIDv7()}`;
}

function unique(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	return Array.from(new Set(values.map(value => value.trim()).filter(value => value.length > 0)));
}

function cloneTaskNode(task: SanLoopTaskNode): SanLoopTaskNode {
	return {
		...task,
		dependsOn: unique(task.dependsOn),
		acceptanceCriteria: unique(task.acceptanceCriteria),
		checkRefs: unique(task.checkRefs),
	};
}

function appendBudget(run: SanLoopRunSnapshot, status: SanLoopStatus, createdAt: string): SanLoopBudgetSnapshot[] {
	const latestRemaining = run.budget.at(-1)?.remainingTurns;
	const remainingTurns =
		latestRemaining === undefined
			? defaultSanLoopModePolicy(run.mode).remainingTurns
			: Math.max(0, latestRemaining - 1);
	return [...run.budget, { createdAt, state: status, remainingTurns }];
}

function appendDecision(
	run: SanLoopRunSnapshot,
	decision: Omit<SanLoopDecision, "decisionId" | "runId" | "createdAt"> & {
		decisionId?: string;
		createdAt: string;
	},
): SanLoopDecision[] {
	return [
		...run.decisions,
		{
			decisionId: decision.decisionId ?? newId("loop_decision"),
			runId: run.runId,
			createdAt: decision.createdAt,
			actor: decision.actor,
			decision: decision.decision,
			rationale: decision.rationale,
			nextAction: decision.nextAction,
		},
	];
}

function updateAssignmentStatus(
	assignments: readonly SanLoopWorkerAssignment[],
	assignmentId: string,
	status: SanLoopWorkerAssignment["status"],
): SanLoopWorkerAssignment[] {
	return assignments.map(assignment =>
		assignment.assignmentId === assignmentId ? { ...assignment, status } : { ...assignment },
	);
}

export function defaultSanLoopModePolicy(mode: SanLoopMode): SanLoopModePolicy {
	const policy = DEFAULT_POLICIES[mode];
	return { ...policy };
}

export function normalizeSanLoopPlan(run: SanLoopRunSnapshot, input: SanLoopPlanInput): SanLoopPlan {
	return {
		objective: input.objective?.trim() || run.objective,
		constraints: unique(input.constraints),
		acceptanceCriteria: unique(input.acceptanceCriteria),
		taskGraph: input.taskGraph?.map(cloneTaskNode) ?? [],
		checkPlan: unique(input.checkPlan),
		riskRegister: unique(input.riskRegister),
	};
}

export function applySanLoopPlan(
	run: SanLoopRunSnapshot,
	input: SanLoopPlanInput,
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const plan = normalizeSanLoopPlan(run, input);
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: "dispatching",
			plan,
			budget: appendBudget(run, "dispatching", createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: "commander",
				decision: "Accepted execution plan",
				rationale: `${plan.taskGraph.length} task(s), ${plan.checkPlan.length} check(s), ${plan.riskRegister.length} risk(s).`,
				nextAction: "dispatch_workers",
			}),
		},
		eventType: "plan_created",
		eventSummary: `Commander created a plan with ${plan.taskGraph.length} task(s).`,
		retryExhausted: false,
	};
}

export function createSanLoopWorkerAssignments(
	run: SanLoopRunSnapshot,
	inputs: readonly SanLoopAssignmentInput[],
): SanLoopWorkerAssignment[] {
	return inputs.map(input => ({
		assignmentId: input.assignmentId ?? newId("loop_assignment"),
		runId: run.runId,
		createdAt: input.createdAt ?? nowIso(),
		objective: input.objective.trim(),
		taskNodeIds: unique(input.taskNodeIds),
		instructions: input.instructions.trim(),
		acceptanceCriteria: unique(input.acceptanceCriteria),
		contextRefs: unique(input.contextRefs),
		checkRefs: unique(input.checkRefs),
		status: "pending",
	}));
}

export function dispatchSanLoopAssignments(
	run: SanLoopRunSnapshot,
	inputs: readonly SanLoopAssignmentInput[],
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const assignments = createSanLoopWorkerAssignments(run, inputs);
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: assignments.length > 0 ? "working" : "blocked",
			assignments: [...run.assignments, ...assignments],
			budget: appendBudget(run, assignments.length > 0 ? "working" : "blocked", createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: "commander",
				decision: assignments.length > 0 ? "Dispatched worker assignments" : "Blocked before dispatch",
				rationale:
					assignments.length > 0
						? `${assignments.length} worker assignment(s) created.`
						: "No worker assignment inputs were available.",
				nextAction: assignments.length > 0 ? "collect_worker_results" : "request_human_input",
			}),
		},
		eventType: assignments.length > 0 ? "assignment_created" : "blocked",
		eventSummary:
			assignments.length > 0
				? `Commander dispatched ${assignments.length} worker assignment(s).`
				: "Commander could not dispatch any worker assignment.",
		retryExhausted: false,
	};
}

export function createSanLoopWorkerResult(
	run: SanLoopRunSnapshot,
	input: SanLoopWorkerResultInput,
): SanLoopWorkerResult {
	return {
		resultId: input.resultId ?? newId("loop_result"),
		runId: run.runId,
		assignmentId: input.assignmentId,
		createdAt: input.createdAt ?? nowIso(),
		status: input.status,
		summary: input.summary.trim(),
		changedFiles: unique(input.changedFiles),
		commandsRun: input.commandsRun ? input.commandsRun.map(command => ({ ...command })) : [],
		verification: unique(input.verification),
		risks: unique(input.risks),
	};
}

export function recordSanLoopWorkerResult(
	run: SanLoopRunSnapshot,
	input: SanLoopWorkerResultInput,
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const result = createSanLoopWorkerResult(run, { ...input, createdAt: input.createdAt ?? createdAt });
	const assignmentStatus: SanLoopWorkerAssignment["status"] =
		result.status === "completed" ? "completed" : result.status === "blocked" ? "blocked" : "failed";
	const nextStatus: SanLoopStatus = result.status === "completed" ? "reviewing" : result.status;
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: nextStatus,
			assignments: updateAssignmentStatus(run.assignments, result.assignmentId, assignmentStatus),
			workerResults: [...run.workerResults, result],
			budget: appendBudget(run, nextStatus, createdAt),
		},
		eventType: result.status === "completed" ? "worker_completed" : "blocked",
		eventSummary: `Worker ${result.assignmentId} ${result.status}: ${result.summary}`,
		retryExhausted: false,
	};
}

export function createSanLoopReviewReport(run: SanLoopRunSnapshot, input: SanLoopReviewInput): SanLoopReviewReport {
	const retryable = input.retryable ?? input.verdict === "needs_fix";
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		reportId: input.reportId ?? newId("loop_review"),
		runId: run.runId,
		createdAt: input.createdAt ?? nowIso(),
		reviewer: input.reviewer,
		verdict: input.verdict,
		defects: input.defects ? input.defects.map(defect => ({ ...defect, evidence: unique(defect.evidence) })) : [],
		testsRun: unique(input.testsRun),
		evidence: unique(input.evidence),
		retryable,
		requiredNextActions: unique(input.requiredNextActions),
		confidence: input.confidence ?? "medium",
		assignmentId: input.assignmentId,
	};
}

export function applySanLoopReview(
	run: SanLoopRunSnapshot,
	input: SanLoopReviewInput,
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const report = createSanLoopReviewReport(run, { ...input, createdAt: input.createdAt ?? createdAt });
	const retryableNeedsFix = report.verdict === "needs_fix" && report.retryable;
	const retryExhausted = retryableNeedsFix && run.retryCount >= run.maxRetries;
	const nextStatus: SanLoopStatus =
		report.verdict === "pass"
			? "passed"
			: report.verdict === "blocked" || report.verdict === "out_of_scope"
				? "blocked"
				: retryExhausted
					? "failed"
					: "retrying";
	const retryCount = nextStatus === "retrying" ? run.retryCount + 1 : run.retryCount;
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: nextStatus,
			reviewReports: [...run.reviewReports, report],
			finalVerdict:
				nextStatus === "passed" || nextStatus === "failed" || nextStatus === "blocked"
					? report.verdict
					: run.finalVerdict,
			retryCount,
			budget: appendBudget(run, nextStatus, createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: report.reviewer,
				decision: `Review verdict: ${report.verdict}`,
				rationale:
					report.defects.length > 0 ? `${report.defects.length} defect(s) reported.` : "No defects reported.",
				nextAction:
					nextStatus === "retrying"
						? "retry_worker"
						: nextStatus === "passed"
							? "finalize"
							: nextStatus === "failed"
								? "stop_failed"
								: "request_human_input",
			}),
		},
		eventType:
			nextStatus === "retrying" ? "retry_requested" : nextStatus === "passed" ? "finalized" : "review_completed",
		eventSummary: `${report.reviewer} review ${report.verdict}; next status ${nextStatus}.`,
		retryExhausted,
	};
}
