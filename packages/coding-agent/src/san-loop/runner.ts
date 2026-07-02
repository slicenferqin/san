import type { SessionEntry } from "../session/session-entries";
import {
	appendSanLoopReviewReport,
	type RecordSanLoopRunResult,
	type RecordSanLoopTransitionResult,
	recordSanLoopRunCreated,
	recordSanLoopTransition,
	updateSanLoopRunSnapshot,
} from "./ledger";
import {
	applySanLoopPlan,
	applySanLoopReview,
	defaultSanLoopModePolicy,
	dispatchSanLoopAssignments,
	recordSanLoopWorkerResult,
	type SanLoopAssignmentInput,
	type SanLoopPlanInput,
	type SanLoopReviewInput,
	type SanLoopTransition,
	type SanLoopWorkerResultInput,
} from "./orchestrator";
import type {
	SanLoopMode,
	SanLoopReviewReport,
	SanLoopRunSnapshot,
	SanLoopTaskNode,
	SanLoopWorkerAssignment,
	SanLoopWorkerResult,
} from "./types";

interface SanLoopSessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): readonly SessionEntry[];
	getSessionId(): string;
}

export interface SanLoopCommanderInvocation {
	run: SanLoopRunSnapshot;
	mode: SanLoopMode;
	latestReview?: SanLoopReviewReport;
}

export interface SanLoopCommanderResult {
	plan: SanLoopPlanInput;
	assignments?: readonly SanLoopAssignmentInput[];
}

export interface SanLoopWorkerInvocation {
	run: SanLoopRunSnapshot;
	assignment: SanLoopWorkerAssignment;
	mode: SanLoopMode;
}

export interface SanLoopSupervisorInvocation {
	run: SanLoopRunSnapshot;
	assignments: readonly SanLoopWorkerAssignment[];
	workerResults: readonly SanLoopWorkerResult[];
	mode: SanLoopMode;
	oracleReview?: SanLoopReviewReport;
}

export interface SanLoopAgentExecutor {
	commander(invocation: SanLoopCommanderInvocation): Promise<SanLoopCommanderResult>;
	worker(invocation: SanLoopWorkerInvocation): Promise<SanLoopWorkerResultInput>;
	supervisor(invocation: SanLoopSupervisorInvocation): Promise<SanLoopReviewInput>;
	oracle?(invocation: SanLoopSupervisorInvocation): Promise<SanLoopReviewInput>;
}

export interface RunSanLoopOptions {
	sessionManager: SanLoopSessionManager;
	objective: string;
	executor: SanLoopAgentExecutor;
	mode?: SanLoopMode;
	maxRetries?: number;
	maxWorkers?: number;
	maxTurns?: number;
	contextPacketRefs?: readonly string[];
	runId?: string;
}

export interface RunSanLoopResult {
	run: SanLoopRunSnapshot;
	runCreated: RecordSanLoopRunResult;
	transitions: RecordSanLoopTransitionResult[];
	reviewEntryIds: string[];
}

function taskAssignment(run: SanLoopRunSnapshot, task: SanLoopTaskNode): SanLoopAssignmentInput {
	return {
		assignmentId: `${run.runId}_${task.id}`,
		objective: task.title,
		taskNodeIds: [task.id],
		instructions: task.description?.trim() || task.title,
		acceptanceCriteria: task.acceptanceCriteria,
		checkRefs: task.checkRefs,
		contextRefs: run.contextPacketRefs,
	};
}

function deriveAssignments(run: SanLoopRunSnapshot, commanderResult: SanLoopCommanderResult): SanLoopAssignmentInput[] {
	if (commanderResult.assignments && commanderResult.assignments.length > 0) {
		return commanderResult.assignments.map(assignment => ({ ...assignment }));
	}
	const taskGraph = commanderResult.plan.taskGraph ?? [];
	return taskGraph.map(task => taskAssignment(run, task));
}

async function mapWithLimit<T, U>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	const results: U[] = [];
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapper(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

function latestReview(run: SanLoopRunSnapshot): SanLoopReviewReport | undefined {
	return run.reviewReports.at(-1);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function withBudgetRemaining(transition: SanLoopTransition, remainingTurns: number): SanLoopTransition {
	const latest = transition.run.budget.at(-1);
	const budget = latest
		? [...transition.run.budget.slice(0, -1), { ...latest, remainingTurns }]
		: [{ createdAt: transition.run.updatedAt, state: transition.run.status, remainingTurns }];
	return {
		...transition,
		run: {
			...transition.run,
			budget,
		},
	};
}

function budgetBlockedTransition(run: SanLoopRunSnapshot): SanLoopTransition {
	const createdAt = new Date().toISOString();
	return {
		run: updateSanLoopRunSnapshot(run, {
			status: "blocked",
			updatedAt: createdAt,
			finalVerdict: "blocked",
			budget: [...run.budget, { createdAt, state: "blocked", remainingTurns: 0 }],
		}),
		eventType: "blocked",
		eventSummary: "San execution loop exhausted the configured turn budget.",
		retryExhausted: false,
	};
}

export async function runSanLoop(options: RunSanLoopOptions): Promise<RunSanLoopResult> {
	const mode = options.mode ?? "smart";
	const policy = defaultSanLoopModePolicy(mode);
	const maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? policy.maxWorkers));
	let remainingTurns = positiveInteger(options.maxTurns, policy.remainingTurns);
	const runCreated = recordSanLoopRunCreated(options.sessionManager, {
		sessionId: options.sessionManager.getSessionId(),
		objective: options.objective,
		mode,
		runId: options.runId,
		maxRetries: options.maxRetries ?? policy.maxRetries,
		initialRemainingTurns: remainingTurns,
		contextPacketRefs: options.contextPacketRefs ? [...options.contextPacketRefs] : [],
	});
	let run = runCreated.run;
	const transitions: RecordSanLoopTransitionResult[] = [];
	const reviewEntryIds: string[] = [];
	const blockForBudget = () => {
		const blockedRecord = recordSanLoopTransition(options.sessionManager, budgetBlockedTransition(run), {
			actor: "commander",
			data: { remainingTurns },
		});
		transitions.push(blockedRecord);
		run = blockedRecord.run;
	};
	const spendTurns = (count: number): boolean => {
		if (remainingTurns < count) return false;
		remainingTurns -= count;
		return true;
	};

	while (true) {
		if (!spendTurns(1)) {
			blockForBudget();
			break;
		}
		const commanderResult = await options.executor.commander({
			run,
			mode,
			latestReview: latestReview(run),
		});
		const planned = withBudgetRemaining(applySanLoopPlan(run, commanderResult.plan), remainingTurns);
		const plannedRecord = recordSanLoopTransition(options.sessionManager, planned, { actor: "commander" });
		transitions.push(plannedRecord);
		run = plannedRecord.run;

		const assignmentInputs = deriveAssignments(run, commanderResult);
		const dispatched = withBudgetRemaining(dispatchSanLoopAssignments(run, assignmentInputs), remainingTurns);
		const dispatchedRecord = recordSanLoopTransition(options.sessionManager, dispatched, { actor: "commander" });
		transitions.push(dispatchedRecord);
		run = dispatchedRecord.run;
		if (run.status === "blocked") break;

		const batchAssignments = run.assignments.slice(-assignmentInputs.length);
		if (!spendTurns(batchAssignments.length)) {
			blockForBudget();
			break;
		}
		const workerResultInputs = await mapWithLimit(batchAssignments, maxWorkers, assignment =>
			options.executor.worker({ run, assignment, mode }),
		);
		for (const workerInput of workerResultInputs) {
			const worked = withBudgetRemaining(recordSanLoopWorkerResult(run, workerInput), remainingTurns);
			const workedRecord = recordSanLoopTransition(options.sessionManager, worked, { actor: "worker" });
			transitions.push(workedRecord);
			run = workedRecord.run;
		}

		let oracleReview: SanLoopReviewReport | undefined;
		if (policy.requireOracle) {
			if (!options.executor.oracle) {
				blockForBudget();
				break;
			}
			if (!spendTurns(1)) {
				blockForBudget();
				break;
			}
			const oracleInput = await options.executor.oracle({
				run,
				assignments: batchAssignments,
				workerResults: run.workerResults,
				mode,
			});
			const oracleReviewed = withBudgetRemaining(applySanLoopReview(run, oracleInput), remainingTurns);
			oracleReview = oracleReviewed.run.reviewReports.at(-1);
			const oracleReviewEntryId = oracleReview
				? appendSanLoopReviewReport(options.sessionManager, oracleReview)
				: undefined;
			if (oracleReviewEntryId) reviewEntryIds.push(oracleReviewEntryId);
			const oracleRecord = recordSanLoopTransition(options.sessionManager, oracleReviewed, {
				actor: "oracle",
				refs: oracleReviewEntryId ? [oracleReviewEntryId] : undefined,
			});
			transitions.push(oracleRecord);
			run = oracleRecord.run;
			if (run.status !== "passed") break;
		}

		if (!spendTurns(1)) {
			blockForBudget();
			break;
		}
		const reviewInput = await options.executor.supervisor({
			run,
			assignments: batchAssignments,
			workerResults: run.workerResults,
			mode,
			oracleReview,
		});
		const reviewed = withBudgetRemaining(applySanLoopReview(run, reviewInput), remainingTurns);
		const review = reviewed.run.reviewReports.at(-1);
		const reviewEntryId = review ? appendSanLoopReviewReport(options.sessionManager, review) : undefined;
		if (reviewEntryId) reviewEntryIds.push(reviewEntryId);
		const reviewedRecord = recordSanLoopTransition(options.sessionManager, reviewed, {
			actor: review?.reviewer ?? "supervisor",
			refs: reviewEntryId ? [reviewEntryId] : undefined,
		});
		transitions.push(reviewedRecord);
		run = reviewedRecord.run;
		if (run.status !== "retrying") break;
	}

	return { run, runCreated, transitions, reviewEntryIds };
}
