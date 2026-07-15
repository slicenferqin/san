import type { SessionEntry } from "../session/session-entries";
import { type SanLoopCheck, selectSanLoopChecks } from "./checks";
import {
	abortSanLoopRun,
	acknowledgeSanLoopAbort,
	appendSanLoopReviewReport,
	findLatestSanLoopRun,
	isSanLoopTerminalStatus,
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
	signal?: AbortSignal;
	latestReview?: SanLoopReviewReport;
	checks?: readonly SanLoopCheck[];
}

export interface SanLoopCommanderResult {
	plan: SanLoopPlanInput;
	assignments?: readonly SanLoopAssignmentInput[];
}

export interface SanLoopWorkerInvocation {
	run: SanLoopRunSnapshot;
	assignment: SanLoopWorkerAssignment;
	mode: SanLoopMode;
	signal?: AbortSignal;
	checks?: readonly SanLoopCheck[];
}

export interface SanLoopSupervisorInvocation {
	run: SanLoopRunSnapshot;
	assignments: readonly SanLoopWorkerAssignment[];
	workerResults: readonly SanLoopWorkerResult[];
	mode: SanLoopMode;
	signal?: AbortSignal;
	oracleReview?: SanLoopReviewReport;
	checks?: readonly SanLoopCheck[];
}

export interface SanLoopAgentExecutor {
	commander(invocation: SanLoopCommanderInvocation): Promise<SanLoopCommanderResult>;
	worker(invocation: SanLoopWorkerInvocation): Promise<SanLoopWorkerResultInput>;
	supervisor(invocation: SanLoopSupervisorInvocation): Promise<SanLoopReviewInput>;
	oracle?(invocation: SanLoopSupervisorInvocation): Promise<SanLoopReviewInput>;
	usage?(): SanLoopExecutorUsage;
}

export interface SanLoopExecutorUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
	durationMs: number;
	providerRequests: number;
}

export interface RunSanLoopOptions {
	sessionManager: SanLoopSessionManager;
	objective: string;
	executor: SanLoopAgentExecutor;
	mode?: SanLoopMode;
	maxRetries?: number;
	maxWorkers?: number;
	maxTurns?: number;
	contextPlanRefs?: readonly string[];
	contextPacketRefs?: readonly string[];
	runId?: string;
	signal?: AbortSignal;
	checks?: readonly SanLoopCheck[];
}

export interface RunSanLoopResult {
	run: SanLoopRunSnapshot;
	runCreated: RecordSanLoopRunResult;
	transitions: RecordSanLoopTransitionResult[];
	reviewEntryIds: string[];
}

interface ActiveSanLoopRun {
	controller: AbortController;
	completion: Promise<void>;
}

const activeSanLoopRuns = new Map<string, ActiveSanLoopRun>();

export function isSanLoopRunning(runId: string): boolean {
	return activeSanLoopRuns.has(runId);
}

export function cancelRunningSanLoop(runId: string): Promise<void> | undefined {
	const active = activeSanLoopRuns.get(runId);
	if (!active) return undefined;
	active.controller.abort(new Error(`San execution loop ${runId} cancellation requested.`));
	return active.completion;
}

function taskAssignment(run: SanLoopRunSnapshot, task: SanLoopTaskNode): SanLoopAssignmentInput {
	return {
		assignmentId: `${run.runId}_${task.id}`,
		objective: task.title,
		taskNodeIds: [task.id],
		instructions: task.description?.trim() || task.title,
		acceptanceCriteria: task.acceptanceCriteria,
		checkRefs: task.checkRefs,
		contextRefs: run.contextPlanRefs && run.contextPlanRefs.length > 0 ? run.contextPlanRefs : run.contextPacketRefs,
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
	signal: AbortSignal,
	mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	const results: U[] = [];
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			signal.throwIfAborted();
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

function withExecutorUsage(transition: SanLoopTransition, executor: SanLoopAgentExecutor): SanLoopTransition {
	const usage = executor.usage?.();
	if (!usage) return transition;
	const latest = transition.run.budget.at(-1);
	if (!latest) return transition;
	return {
		...transition,
		run: {
			...transition.run,
			budget: [
				...transition.run.budget.slice(0, -1),
				{
					...latest,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					totalTokens: usage.totalTokens,
					cost: usage.cost,
					durationMs: usage.durationMs,
					providerRequests: usage.providerRequests,
				},
			],
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

function workerGateTransition(
	run: SanLoopRunSnapshot,
	workerResults: readonly SanLoopWorkerResult[],
): SanLoopTransition {
	const createdAt = new Date().toISOString();
	const failed = workerResults.filter(result => result.status === "failed");
	const blocked = workerResults.filter(result => result.status === "blocked");
	const status = failed.length > 0 ? "failed" : "blocked";
	const affected = [...failed, ...blocked].map(result => result.assignmentId);
	return {
		run: updateSanLoopRunSnapshot(run, {
			status,
			updatedAt: createdAt,
			finalVerdict: "blocked",
			budget: [...run.budget, { createdAt, state: status, remainingTurns: run.budget.at(-1)?.remainingTurns }],
		}),
		eventType: status,
		eventSummary: `San execution loop stopped before review because worker assignments did not complete: ${affected.join(", ")}.`,
		retryExhausted: false,
	};
}

function dependencyBlockedTransition(
	run: SanLoopRunSnapshot,
	assignments: readonly SanLoopWorkerAssignment[],
): SanLoopTransition {
	const createdAt = new Date().toISOString();
	return {
		run: updateSanLoopRunSnapshot(run, {
			status: "blocked",
			updatedAt: createdAt,
			finalVerdict: "blocked",
			budget: [...run.budget, { createdAt, state: "blocked", remainingTurns: run.budget.at(-1)?.remainingTurns }],
		}),
		eventType: "blocked",
		eventSummary: `San execution loop cannot schedule assignments because dependencies are unresolved: ${assignments.map(assignment => assignment.assignmentId).join(", ")}.`,
		retryExhausted: false,
	};
}

function executionFailedTransition(run: SanLoopRunSnapshot, error: unknown): SanLoopTransition {
	const createdAt = new Date().toISOString();
	const message = error instanceof Error ? error.message : String(error);
	return {
		run: updateSanLoopRunSnapshot(run, {
			status: "failed",
			updatedAt: createdAt,
			finalVerdict: "blocked",
			budget: [...run.budget, { createdAt, state: "failed", remainingTurns: run.budget.at(-1)?.remainingTurns }],
		}),
		eventType: "failed",
		eventSummary: `San execution loop failed with an unhandled executor error: ${message}`,
		retryExhausted: false,
	};
}

function assignmentDependencies(run: SanLoopRunSnapshot, assignment: SanLoopWorkerAssignment): string[] {
	const ownedTasks = new Set(assignment.taskNodeIds);
	const taskById = new Map(run.plan?.taskGraph.map(task => [task.id, task]));
	return Array.from(
		new Set(
			assignment.taskNodeIds
				.flatMap(taskId => taskById.get(taskId)?.dependsOn ?? [])
				.filter(taskId => !ownedTasks.has(taskId)),
		),
	);
}

export async function runSanLoop(options: RunSanLoopOptions): Promise<RunSanLoopResult> {
	const mode = options.mode ?? "team";
	const policy = defaultSanLoopModePolicy(mode);
	const maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? policy.maxWorkers));
	let remainingTurns = positiveInteger(options.maxTurns, policy.remainingTurns);
	if (options.runId && activeSanLoopRuns.has(options.runId)) {
		throw new Error(`Cannot start San execution loop ${options.runId}: another active run already uses this id.`);
	}
	const runCreated = recordSanLoopRunCreated(options.sessionManager, {
		sessionId: options.sessionManager.getSessionId(),
		objective: options.objective,
		mode,
		runId: options.runId,
		maxRetries: options.maxRetries ?? policy.maxRetries,
		initialRemainingTurns: remainingTurns,
		contextPlanRefs: options.contextPlanRefs ? [...options.contextPlanRefs] : [],
		contextPacketRefs: options.contextPacketRefs ? [...options.contextPacketRefs] : [],
	});
	let run = runCreated.run;
	const transitions: RecordSanLoopTransitionResult[] = [];
	const reviewEntryIds: string[] = [];
	const cancellationController = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, cancellationController.signal])
		: cancellationController.signal;
	const completion = Promise.withResolvers<void>();
	const activeRun: ActiveSanLoopRun = {
		controller: cancellationController,
		completion: completion.promise,
	};
	activeSanLoopRuns.set(run.runId, activeRun);
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

	try {
		executionLoop: while (true) {
			signal.throwIfAborted();
			if (!spendTurns(1)) {
				blockForBudget();
				break;
			}
			const commanderResult = await options.executor.commander({
				run,
				mode,
				signal,
				latestReview: latestReview(run),
				checks: selectSanLoopChecks(options.checks ?? [], { role: "commander" }),
			});
			signal.throwIfAborted();
			const planned = withExecutorUsage(
				withBudgetRemaining(applySanLoopPlan(run, commanderResult.plan), remainingTurns),
				options.executor,
			);
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
			const pendingAssignments = [...batchAssignments];
			const completedTaskIds = new Set(
				run.plan?.taskGraph.filter(task => task.status === "completed").map(task => task.id),
			);
			while (pendingAssignments.length > 0) {
				signal.throwIfAborted();
				const readyAssignments = pendingAssignments.filter(assignment =>
					assignmentDependencies(run, assignment).every(dependency => completedTaskIds.has(dependency)),
				);
				if (readyAssignments.length === 0) {
					const blockedRecord = recordSanLoopTransition(
						options.sessionManager,
						dependencyBlockedTransition(run, pendingAssignments),
						{ actor: "commander" },
					);
					transitions.push(blockedRecord);
					run = blockedRecord.run;
					break executionLoop;
				}
				if (!spendTurns(readyAssignments.length)) {
					blockForBudget();
					break executionLoop;
				}
				const workerResultInputs = await mapWithLimit(readyAssignments, maxWorkers, signal, assignment =>
					options.executor.worker({
						run,
						assignment,
						mode,
						signal,
						checks: selectSanLoopChecks(options.checks ?? [], { role: "worker" }),
					}),
				);
				signal.throwIfAborted();
				const batchWorkerResults: SanLoopWorkerResult[] = [];
				for (const workerInput of workerResultInputs) {
					const worked = withExecutorUsage(
						withBudgetRemaining(recordSanLoopWorkerResult(run, workerInput), remainingTurns),
						options.executor,
					);
					const workedRecord = recordSanLoopTransition(options.sessionManager, worked, { actor: "worker" });
					transitions.push(workedRecord);
					run = workedRecord.run;
					const workerResult = run.workerResults.at(-1);
					if (workerResult) batchWorkerResults.push(workerResult);
				}
				for (const assignment of readyAssignments) {
					const index = pendingAssignments.findIndex(
						candidate => candidate.assignmentId === assignment.assignmentId,
					);
					if (index >= 0) pendingAssignments.splice(index, 1);
				}
				if (batchWorkerResults.some(workerResult => workerResult.status !== "completed")) {
					const failedRecord = recordSanLoopTransition(
						options.sessionManager,
						workerGateTransition(run, batchWorkerResults),
						{ actor: "worker", refs: batchWorkerResults.map(result => result.resultId) },
					);
					transitions.push(failedRecord);
					run = failedRecord.run;
					break executionLoop;
				}
				for (const assignment of readyAssignments) {
					for (const taskId of assignment.taskNodeIds) completedTaskIds.add(taskId);
				}
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
					workerResults: run.workerResults.filter(result =>
						batchAssignments.some(assignment => assignment.assignmentId === result.assignmentId),
					),
					mode,
					signal,
					checks: selectSanLoopChecks(options.checks ?? [], {
						role: "oracle",
						paths: run.workerResults.flatMap(result => result.changedFiles),
					}),
				});
				signal.throwIfAborted();
				if (oracleInput.reviewer !== "oracle") {
					throw new Error(`San Oracle returned reviewer ${oracleInput.reviewer}; expected oracle.`);
				}
				const oracleReviewed = withExecutorUsage(
					withBudgetRemaining(applySanLoopReview(run, oracleInput), remainingTurns),
					options.executor,
				);
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
			}

			if (!spendTurns(1)) {
				blockForBudget();
				break;
			}
			const reviewInput = await options.executor.supervisor({
				run,
				assignments: batchAssignments,
				workerResults: run.workerResults.filter(result =>
					batchAssignments.some(assignment => assignment.assignmentId === result.assignmentId),
				),
				mode,
				signal,
				oracleReview,
				checks: selectSanLoopChecks(options.checks ?? [], {
					role: "supervisor",
					paths: run.workerResults.flatMap(result => result.changedFiles),
				}),
			});
			signal.throwIfAborted();
			if (reviewInput.reviewer !== "supervisor") {
				throw new Error(`San Supervisor returned reviewer ${reviewInput.reviewer}; expected supervisor.`);
			}
			const reviewed = withExecutorUsage(
				withBudgetRemaining(applySanLoopReview(run, reviewInput), remainingTurns),
				options.executor,
			);
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
	} catch (error) {
		const latest = findLatestSanLoopRun(options.sessionManager.getEntries(), run.runId)?.data ?? run;
		if (signal.aborted) {
			if (latest.status === "aborting") {
				const acknowledged = acknowledgeSanLoopAbort(options.sessionManager, latest);
				transitions.push(acknowledged);
				run = acknowledged.run;
			} else if (!isSanLoopTerminalStatus(latest.status)) {
				const aborted = abortSanLoopRun(options.sessionManager, latest, {
					reason: `San execution loop ${latest.runId} was cancelled before completion.`,
				});
				transitions.push(aborted);
				run = aborted.run;
			} else {
				run = latest;
			}
			return { run, runCreated, transitions, reviewEntryIds };
		}
		if (!isSanLoopTerminalStatus(latest.status)) {
			const failed = recordSanLoopTransition(
				options.sessionManager,
				withExecutorUsage(executionFailedTransition(latest, error), options.executor),
				{
					actor: "commander",
				},
			);
			run = failed.run;
		}
		throw error;
	} finally {
		if (activeSanLoopRuns.get(runCreated.run.runId) === activeRun) activeSanLoopRuns.delete(runCreated.run.runId);
		completion.resolve();
	}
}
