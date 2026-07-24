import type { SessionEntry } from "../session/session-entries";
import { type SanLoopCheck, selectSanLoopChecks } from "./checks";
import {
	abortSanLoopRun,
	acknowledgeSanLoopAbort,
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
	SanLoopReviewVerdict,
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

export interface SanLoopRoleBudget {
	maxTokens?: number;
	maxCost?: number;
	maxProviderRequests?: number;
}

export interface SanLoopCommanderInvocation {
	run: SanLoopRunSnapshot;
	mode: SanLoopMode;
	signal?: AbortSignal;
	latestReview?: SanLoopReviewReport;
	checks?: readonly SanLoopCheck[];
	budget?: SanLoopRoleBudget;
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
	budget?: SanLoopRoleBudget;
}

export interface SanLoopSupervisorInvocation {
	run: SanLoopRunSnapshot;
	assignments: readonly SanLoopWorkerAssignment[];
	workerResults: readonly SanLoopWorkerResult[];
	mode: SanLoopMode;
	signal?: AbortSignal;
	oracleReview?: SanLoopReviewReport;
	checks?: readonly SanLoopCheck[];
	budget?: SanLoopRoleBudget;
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
	/** Hard cap on total tokens across all subagent calls in this run. */
	maxTokens?: number;
	/** Hard cap on estimated cost (USD) across all subagent calls in this run. */
	maxCost?: number;
	/** Hard wall-clock cap (ms) from run start to next role call. */
	maxDurationMs?: number;
	/** Hard cap on provider request count across all subagent calls in this run. */
	maxProviderRequests?: number;
	/** Fraction of turn budget reserved for review roles (oracle/supervisor). */
	reserveRatio?: number;
	/** Modes where Oracle is allowed even if the mode pipeline includes it. */
	oracleEnabledInModes?: readonly SanLoopMode[];
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
	mapper: (item: T, index: number, signal: AbortSignal) => Promise<U>,
): Promise<U[]> {
	if (items.length === 0) return [];
	const results: U[] = [];
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const batchController = new AbortController();
	const batchSignal = AbortSignal.any([signal, batchController.signal]);
	let firstError: { error: unknown } | undefined;
	const workers = Array.from({ length: workerCount }, async () => {
		while (!batchSignal.aborted && nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				batchSignal.throwIfAborted();
				results[index] = await mapper(items[index]!, index, batchSignal);
			} catch (error) {
				if (!firstError) {
					firstError = { error };
					batchController.abort(error);
				}
				return;
			}
		}
	});
	await Promise.all(workers);
	if (firstError) throw firstError.error;
	signal.throwIfAborted();
	return results;
}

function latestReview(run: SanLoopRunSnapshot): SanLoopReviewReport | undefined {
	return run.reviewReports.at(-1);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
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

function usageBudgetBlockedTransition(run: SanLoopRunSnapshot, reason: string): SanLoopTransition {
	const createdAt = new Date().toISOString();
	return {
		run: updateSanLoopRunSnapshot(run, {
			status: "blocked",
			updatedAt: createdAt,
			finalVerdict: "blocked",
			budget: [...run.budget, { createdAt, state: "blocked", remainingTurns: run.budget.at(-1)?.remainingTurns }],
		}),
		eventType: "blocked",
		eventSummary: `San execution loop exhausted usage budget: ${reason}.`,
		retryExhausted: false,
	};
}

interface SanLoopUsageLimits {
	maxTokens?: number;
	maxCost?: number;
	maxDurationMs?: number;
	maxProviderRequests?: number;
	startedAtMs: number;
}

function hasExclusiveUsageBudget(limits: SanLoopUsageLimits): boolean {
	return limits.maxTokens !== undefined || limits.maxCost !== undefined || limits.maxProviderRequests !== undefined;
}

function remainingRoleBudget(executor: SanLoopAgentExecutor, limits: SanLoopUsageLimits): SanLoopRoleBudget {
	const usage = executor.usage?.();
	return {
		maxTokens:
			limits.maxTokens === undefined
				? undefined
				: Math.max(0, Math.floor(limits.maxTokens - (usage?.totalTokens ?? 0))),
		maxCost: limits.maxCost === undefined ? undefined : Math.max(0, limits.maxCost - (usage?.cost ?? 0)),
		maxProviderRequests:
			limits.maxProviderRequests === undefined
				? undefined
				: Math.max(0, Math.floor(limits.maxProviderRequests - (usage?.providerRequests ?? 0))),
	};
}

function splitIntegerBudget(total: number, index: number, count: number): number {
	const normalized = Math.max(0, Math.floor(total));
	const base = Math.floor(normalized / count);
	return base + (index < normalized % count ? 1 : 0);
}

function splitRoleBudget(budget: SanLoopRoleBudget, index: number, count: number): SanLoopRoleBudget {
	return {
		maxTokens: budget.maxTokens === undefined ? undefined : splitIntegerBudget(budget.maxTokens, index, count),
		maxCost:
			budget.maxCost === undefined
				? undefined
				: index === count - 1
					? Math.max(0, budget.maxCost - (budget.maxCost / count) * (count - 1))
					: budget.maxCost / count,
		maxProviderRequests:
			budget.maxProviderRequests === undefined
				? undefined
				: splitIntegerBudget(budget.maxProviderRequests, index, count),
	};
}

function budgetedWorkerWaveSize(readyCount: number, maxWorkers: number, budget: SanLoopRoleBudget): number {
	let count = Math.min(readyCount, maxWorkers);
	if (budget.maxTokens !== undefined) count = Math.min(count, Math.floor(budget.maxTokens));
	if (budget.maxProviderRequests !== undefined) count = Math.min(count, Math.floor(budget.maxProviderRequests));
	return Math.max(0, count);
}

function checkUsageBudget(
	executor: SanLoopAgentExecutor,
	run: SanLoopRunSnapshot,
	limits: SanLoopUsageLimits,
): SanLoopTransition | undefined {
	const usage = executor.usage?.();
	const wallClockMs = Date.now() - limits.startedAtMs;
	if (typeof limits.maxDurationMs === "number" && wallClockMs >= limits.maxDurationMs) {
		return usageBudgetBlockedTransition(run, `wall-clock ${wallClockMs}ms >= ${limits.maxDurationMs}ms`);
	}
	if (!usage) return undefined;
	if (typeof limits.maxTokens === "number" && usage.totalTokens >= limits.maxTokens) {
		return usageBudgetBlockedTransition(run, `tokens ${usage.totalTokens} >= ${limits.maxTokens}`);
	}
	if (typeof limits.maxCost === "number" && usage.cost >= limits.maxCost) {
		return usageBudgetBlockedTransition(run, `cost ${usage.cost.toFixed(4)} >= ${limits.maxCost}`);
	}
	if (typeof limits.maxProviderRequests === "number" && usage.providerRequests >= limits.maxProviderRequests) {
		return usageBudgetBlockedTransition(
			run,
			`provider requests ${usage.providerRequests} >= ${limits.maxProviderRequests}`,
		);
	}
	return undefined;
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
	const maxWorkers = positiveInteger(options.maxWorkers, policy.maxWorkers);
	const totalTurns = positiveInteger(options.maxTurns, policy.remainingTurns);
	const reserveRatio =
		options.reserveRatio === undefined || !Number.isFinite(options.reserveRatio)
			? 0
			: Math.min(0.9, Math.max(0, options.reserveRatio));
	let remainingTurns = totalTurns;
	if (options.runId && activeSanLoopRuns.has(options.runId)) {
		throw new Error(`Cannot start San execution loop ${options.runId}: another active run already uses this id.`);
	}
	const runCreated = recordSanLoopRunCreated(options.sessionManager, {
		sessionId: options.sessionManager.getSessionId(),
		objective: options.objective,
		mode,
		runId: options.runId,
		maxRetries: nonNegativeInteger(options.maxRetries, policy.maxRetries),
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
	let reviewReserve = 0;
	const blockForBudget = () => {
		const blockedRecord = recordSanLoopTransition(options.sessionManager, budgetBlockedTransition(run), {
			actor: "commander",
			data: { remainingTurns, reserveRatio, reviewReserve },
		});
		transitions.push(blockedRecord);
		run = blockedRecord.run;
	};
	const spendTurns = (count: number, phase: "work" | "review" = "work"): boolean => {
		if (remainingTurns < count) return false;
		if (phase === "work" && remainingTurns - count < reviewReserve) return false;
		remainingTurns -= count;
		if (phase === "review") reviewReserve = Math.max(0, reviewReserve - count);
		return true;
	};
	const blockForUsageBudget = (reason: SanLoopTransition) => {
		const blockedRecord = recordSanLoopTransition(options.sessionManager, reason, {
			actor: "commander",
			data: { usage: options.executor.usage?.() },
		});
		transitions.push(blockedRecord);
		run = blockedRecord.run;
	};
	const usageLimits: SanLoopUsageLimits = {
		maxTokens: options.maxTokens,
		maxCost: options.maxCost,
		maxDurationMs: options.maxDurationMs,
		maxProviderRequests: options.maxProviderRequests,
		startedAtMs: Date.now(),
	};
	const tryEnforceUsageBudget = (): boolean => {
		const blocked = checkUsageBudget(options.executor, run, usageLimits);
		if (!blocked) return false;
		blockForUsageBudget(blocked);
		return true;
	};

	try {
		const hasCommander = policy.pipeline.includes("commander");
		const hasSupervisor = policy.pipeline.includes("supervisor");
		const oracleAllowedBySettings =
			options.oracleEnabledInModes === undefined || options.oracleEnabledInModes.includes(mode);
		const hasOracle =
			policy.pipeline.includes("oracle") && oracleAllowedBySettings && Boolean(options.executor.oracle);
		// P1-01: requireOracle=true is an execution constraint. Missing Oracle
		// executor blocks the run — no silent degradation to team pipeline.
		if (policy.requireOracle && !hasOracle) {
			const blockedReason = !oracleAllowedBySettings
				? `Oracle disabled for mode '${mode}' by oracleEnabledInModes setting`
				: `Oracle executor not available for mode '${mode}' which requires Oracle (requireOracle=${policy.requireOracle})`;
			const blocked = recordSanLoopTransition(
				options.sessionManager,
				{
					run: updateSanLoopRunSnapshot(run, {
						status: "blocked",
						updatedAt: new Date().toISOString(),
						finalVerdict: "blocked",
						budget: [...run.budget, { createdAt: new Date().toISOString(), state: "blocked", remainingTurns }],
					}),
					eventType: "blocked",
					eventSummary: blockedReason,
					retryExhausted: false,
				},
				{
					actor: "commander",
					data: {
						requiresOracle: true,
						hasExecutor: Boolean(options.executor.oracle),
						oracleAllowedBySettings,
					},
				},
			);
			transitions.push(blocked);
			run = blocked.run;
			return { run, runCreated, transitions, reviewEntryIds };
		}
		reviewReserve = hasSupervisor || hasOracle ? Math.max(0, Math.ceil(totalTurns * reserveRatio)) : 0;

		executionLoop: while (true) {
			signal.throwIfAborted();
			if (!spendTurns(1)) {
				blockForBudget();
				break;
			}
			if (tryEnforceUsageBudget()) break;

			let batchAssignments: SanLoopWorkerAssignment[];

			if (hasCommander) {
				if (tryEnforceUsageBudget()) break;
				const commanderResult = await options.executor.commander({
					run,
					mode,
					signal,
					latestReview: latestReview(run),
					checks: selectSanLoopChecks(options.checks ?? [], { role: "commander" }),
					budget: hasExclusiveUsageBudget(usageLimits)
						? remainingRoleBudget(options.executor, usageLimits)
						: undefined,
				});
				signal.throwIfAborted();
				const planned = withExecutorUsage(
					withBudgetRemaining(applySanLoopPlan(run, commanderResult.plan), remainingTurns),
					options.executor,
				);
				const plannedRecord = recordSanLoopTransition(options.sessionManager, planned, { actor: "commander" });
				transitions.push(plannedRecord);
				run = plannedRecord.run;
				if (tryEnforceUsageBudget()) break;

				const assignmentInputs = deriveAssignments(run, commanderResult);
				const dispatched = withBudgetRemaining(dispatchSanLoopAssignments(run, assignmentInputs), remainingTurns);
				const dispatchedRecord = recordSanLoopTransition(options.sessionManager, dispatched, {
					actor: "commander",
				});
				transitions.push(dispatchedRecord);
				run = dispatchedRecord.run;
				if (run.status === "blocked") break;
				batchAssignments = run.assignments.slice(-assignmentInputs.length);
			} else {
				// Solo / single-agent: synthetic plan and assignment from objective.
				const planInput: SanLoopPlanInput = {
					objective: run.objective,
					acceptanceCriteria: ["Task completed successfully."],
					taskGraph: [
						{
							id: "solo",
							title: run.objective,
							status: "pending",
							dependsOn: [],
							acceptanceCriteria: ["Task completed successfully."],
							checkRefs: [],
						},
					],
					riskRegister: [],
				};
				const planned = withExecutorUsage(
					withBudgetRemaining(applySanLoopPlan(run, planInput), remainingTurns),
					options.executor,
				);
				const plannedRecord = recordSanLoopTransition(options.sessionManager, planned, { actor: "commander" });
				transitions.push(plannedRecord);
				run = plannedRecord.run;

				const assignmentInputs: SanLoopAssignmentInput[] = [
					{
						taskNodeIds: ["solo"],
						objective: run.objective,
						instructions: `Complete: ${run.objective}`,
						acceptanceCriteria: ["Task completed successfully."],
						checkRefs: [],
					},
				];
				const dispatched = withBudgetRemaining(dispatchSanLoopAssignments(run, assignmentInputs), remainingTurns);
				const dispatchedRecord = recordSanLoopTransition(options.sessionManager, dispatched, {
					actor: "commander",
				});
				transitions.push(dispatchedRecord);
				run = dispatchedRecord.run;
				if (run.status === "blocked") break;
				batchAssignments = run.assignments.slice(-assignmentInputs.length);
			}

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
				const exclusiveBudget = hasExclusiveUsageBudget(usageLimits)
					? remainingRoleBudget(options.executor, usageLimits)
					: undefined;
				const waveSize = exclusiveBudget
					? budgetedWorkerWaveSize(readyAssignments.length, maxWorkers, exclusiveBudget)
					: readyAssignments.length;
				if (waveSize === 0) {
					blockForUsageBudget(
						usageBudgetBlockedTransition(run, "remaining usage budget cannot fund another worker"),
					);
					break executionLoop;
				}
				const waveAssignments = readyAssignments.slice(0, waveSize);
				if (!spendTurns(waveAssignments.length)) {
					blockForBudget();
					break executionLoop;
				}
				if (tryEnforceUsageBudget()) break executionLoop;
				const workerResultInputs = await mapWithLimit(
					waveAssignments,
					maxWorkers,
					signal,
					(assignment, index, workerSignal) =>
						options.executor.worker({
							run,
							assignment,
							mode,
							signal: workerSignal,
							checks: selectSanLoopChecks(options.checks ?? [], { role: "worker" }),
							budget: exclusiveBudget
								? splitRoleBudget(exclusiveBudget, index, waveAssignments.length)
								: undefined,
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
				if (tryEnforceUsageBudget()) break executionLoop;
				for (const assignment of waveAssignments) {
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
				for (const assignment of waveAssignments) {
					for (const taskId of assignment.taskNodeIds) completedTaskIds.add(taskId);
				}
			}

			let oracleReview: SanLoopReviewReport | undefined;
			if (hasOracle) {
				if (!options.executor.oracle) {
					blockForBudget();
					break;
				}
				if (!spendTurns(1, "review")) {
					blockForBudget();
					break;
				}
				if (tryEnforceUsageBudget()) break;
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
					budget: hasExclusiveUsageBudget(usageLimits)
						? remainingRoleBudget(options.executor, usageLimits)
						: undefined,
				});
				signal.throwIfAborted();
				if (oracleInput.reviewer !== "oracle") {
					throw new Error(`San Oracle returned reviewer ${oracleInput.reviewer}; expected oracle.`);
				}
				const oracleReviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, oracleInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
						}),
						remainingTurns,
					),
					options.executor,
				);
				oracleReview = oracleReviewed.run.reviewReports.at(-1);
				const oracleRecord = recordSanLoopTransition(options.sessionManager, oracleReviewed, {
					actor: "oracle",
					review: oracleReview,
				});
				if (oracleRecord.reviewEntryId) reviewEntryIds.push(oracleRecord.reviewEntryId);
				transitions.push(oracleRecord);
				run = oracleRecord.run;
				if (tryEnforceUsageBudget()) break;
			}

			if (hasSupervisor) {
				if (!spendTurns(1, "review")) {
					blockForBudget();
					break;
				}
				if (tryEnforceUsageBudget()) break;
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
					budget: hasExclusiveUsageBudget(usageLimits)
						? remainingRoleBudget(options.executor, usageLimits)
						: undefined,
				});
				signal.throwIfAborted();
				if (reviewInput.reviewer !== "supervisor") {
					throw new Error(`San Supervisor returned reviewer ${reviewInput.reviewer}; expected supervisor.`);
				}
				const reviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, reviewInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
						}),
						remainingTurns,
					),
					options.executor,
				);
				const review = reviewed.run.reviewReports.at(-1);
				// P0-01: Budget must be checked BEFORE any terminal pass is written.
				// If over budget, persist a single blocked envelope (optionally
				// carrying the review for audit) and never write status=passed.
				const postReviewBudget = checkUsageBudget(options.executor, run, usageLimits);
				if (postReviewBudget) {
					const blockedRecord = recordSanLoopTransition(
						options.sessionManager,
						{
							run: {
								...reviewed.run,
								status: "blocked",
								finalVerdict: "blocked",
							},
							eventType: "blocked",
							eventSummary: postReviewBudget.eventSummary,
							retryExhausted: false,
						},
						{
							actor: review?.reviewer ?? "supervisor",
							review,
							data: { usage: options.executor.usage?.(), blockedBy: "post_review_budget" },
						},
					);
					if (blockedRecord.reviewEntryId) reviewEntryIds.push(blockedRecord.reviewEntryId);
					transitions.push(blockedRecord);
					run = blockedRecord.run;
					break;
				}
				const reviewedRecord = recordSanLoopTransition(options.sessionManager, reviewed, {
					actor: review?.reviewer ?? "supervisor",
					review,
				});
				if (reviewedRecord.reviewEntryId) reviewEntryIds.push(reviewedRecord.reviewEntryId);
				transitions.push(reviewedRecord);
				run = reviewedRecord.run;
				if (run.status !== "retrying") break;
			} else {
				// No Supervisor in pipeline: auto-finalize from worker results.
				if (tryEnforceUsageBudget()) break;
				const workerResults = run.workerResults.filter(result =>
					batchAssignments.some(assignment => assignment.assignmentId === result.assignmentId),
				);
				const hasFailures = workerResults.some(result => result.status !== "completed");
				const autoVerdict: SanLoopReviewVerdict = hasFailures ? "blocked" : "pass";
				const reviewInput: SanLoopReviewInput = {
					reviewer: "supervisor",
					verdict: autoVerdict,
					defects: hasFailures
						? [
								{
									defectId: "solo-worker-failed",
									severity: "blocker",
									title: "Worker did not complete successfully.",
									evidence: workerResults.filter(r => r.status !== "completed").map(r => r.summary),
									retryable: false,
								},
							]
						: [],
					testsRun: workerResults.flatMap(result => result.commandsRun.map(c => c.command)),
					evidence: workerResults.flatMap(result => result.verification),
					retryable: false,
					requiredNextActions: [],
					confidence: hasFailures ? "low" : "high",
				};
				const reviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, reviewInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
						}),
						remainingTurns,
					),
					options.executor,
				);
				const review = reviewed.run.reviewReports.at(-1);
				const postReviewBudget = checkUsageBudget(options.executor, run, usageLimits);
				if (postReviewBudget) {
					const blockedRecord = recordSanLoopTransition(
						options.sessionManager,
						{
							run: {
								...reviewed.run,
								status: "blocked",
								finalVerdict: "blocked",
							},
							eventType: "blocked",
							eventSummary: postReviewBudget.eventSummary,
							retryExhausted: false,
						},
						{
							actor: review?.reviewer ?? "supervisor",
							review,
							data: { usage: options.executor.usage?.(), blockedBy: "post_review_budget" },
						},
					);
					if (blockedRecord.reviewEntryId) reviewEntryIds.push(blockedRecord.reviewEntryId);
					transitions.push(blockedRecord);
					run = blockedRecord.run;
					break;
				}
				const reviewedRecord = recordSanLoopTransition(options.sessionManager, reviewed, {
					actor: review?.reviewer ?? "supervisor",
					review,
				});
				if (reviewedRecord.reviewEntryId) reviewEntryIds.push(reviewedRecord.reviewEntryId);
				transitions.push(reviewedRecord);
				run = reviewedRecord.run;
				break;
			}
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
