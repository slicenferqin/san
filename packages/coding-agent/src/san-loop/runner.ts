import { type DurableSupervisorDecision, supervisorDecisionBasis } from "../execution-control/durable-scheduler";
import { isTerminalExecutionState, StaleExecutionRevisionError } from "../execution-control/execution-ledger";
import type { ExecutionRuntime } from "../execution-control/execution-runtime";
import { stableFailureFingerprint } from "../execution-control/progress-classifier";
import type { TaskContractIdentity, TaskContractStatus } from "../execution-control/task-contract";
import type { AcceptanceGate, ObjectiveContractRef } from "../execution-control/types";
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
	SanLoopRole,
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
	/** Shared host-owned execution runtime bound to this run's root scope. */
	executionRuntime: ExecutionRuntime;
	/** Fixed root execution scope id; children must not start/sync/dispose it. */
	executionScopeId: string;
	/** Immutable objective binding used by typed acceptance evidence. */
	objectiveContract?: ObjectiveContractRef;
	contractRevision?: number;
	contractHash?: string;
	objectiveClauseRefs?: readonly string[];
	acceptanceGates?: readonly AcceptanceGate[];
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
		objectiveContract: options.objectiveContract,
		contractRevision: options.contractRevision,
		contractHash: options.contractHash,
		objectiveClauseRefs: options.objectiveClauseRefs ? [...options.objectiveClauseRefs] : undefined,
		acceptanceGates: options.acceptanceGates ? [...options.acceptanceGates] : undefined,
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
	const scopeHandle = () => options.executionRuntime.getScope(options.executionScopeId);
	const finalizeScopeState = (
		state: "completed" | "aborted_by_user" | "budget_exhausted" | "runtime_fault" | "no_provider_available",
	) => {
		const handle = scopeHandle();
		if (!handle) return;
		const snapshot = handle.snapshot();
		// 显式终态处理：scope 已终态时不再追加 finish 事件。
		if (isTerminalExecutionState(snapshot.state)) return;
		try {
			options.executionRuntime.finishScope(options.executionScopeId, {
				expectedRevision: snapshot.revision,
				state,
			});
		} catch (error) {
			// CAS 过期时仅以权威快照重试一次；其余错误如实上抛，绝不吞掉。
			if (error instanceof StaleExecutionRevisionError) {
				const fresh = handle.snapshot();
				if (isTerminalExecutionState(fresh.state)) return;
				options.executionRuntime.finishScope(options.executionScopeId, {
					expectedRevision: fresh.revision,
					state,
				});
				return;
			}
			throw error;
		}
	};
	const finalizeBudgetExhausted = () => {
		finalizeScopeState("budget_exhausted");
	};
	const finalizeCompletedScope = (): boolean => {
		const handle = scopeHandle();
		if (!handle) return false;
		const snapshot = handle.snapshot();
		if (snapshot.state === "completed") return true;
		if (isTerminalExecutionState(snapshot.state)) return false;
		// completed 只凭 host evidence gates：required gate 未全部 pass 或缺少
		// host evidence 时保持运行，San run 也不得向用户报告 passed。
		const requiredGates = snapshot.gates.filter(gate => gate.required !== false);
		const gatesPassed =
			requiredGates.length > 0 &&
			requiredGates.every(gate => gate.status === "pass" && gate.evidenceRefs.length > 0);
		if (!gatesPassed) return false;
		finalizeScopeState("completed");
		return handle.snapshot().state === "completed";
	};
	const recordWorkerHostFacts = (workerResult: SanLoopWorkerResult, assignment: SanLoopWorkerAssignment) => {
		const contract = options.executionRuntime.taskRegistry.derive({
			scopeId: options.executionScopeId,
			workKey: assignment.assignmentId,
			strategyKey: `san-loop:${mode}:worker`,
		});
		if (workerResult.status !== "completed") {
			// 失败以稳定指纹上报 watchdog；同一失败产生稳定 signature，绝不伪造进度。
			options.executionRuntime.recordHostObservation({
				scopeId: options.executionScopeId,
				observation: {
					type: "failure",
					signature: stableFailureFingerprint(
						`${contract.workKey}\u0000${contract.strategyKey}\u0000${workerResult.summary}`,
					),
					workKey: contract.workKey,
					strategyKey: contract.strategyKey,
					assignmentId: assignment.assignmentId,
					retryable: false,
				},
			});
			return;
		}
		for (const receipt of workerResult.evidenceReceipts ?? []) {
			// typed host evidence receipt：runtime 写入 ledger evidence，并在
			// verifier 校验通过后推进绑定的 acceptance gate。
			options.executionRuntime.recordHostObservation({
				scopeId: options.executionScopeId,
				receipt,
			});
		}
		for (const receipt of workerResult.evidenceReceipts ?? []) {
			// 完成证据同步为 watchdog 观察（进度事实）；heartbeat 仅 activity。
			// observationId 显式取 receipt id：workKey/strategyKey/cursor 相同的
			// 多条证据指纹一致，缺 observationId 会与 worker 完成观察在 ledger 冲突。
			options.executionRuntime.recordHostObservation({
				scopeId: options.executionScopeId,
				observation: {
					type: "evidence",
					observationId: receipt.receiptId,
					evidenceId: receipt.receiptId,
					evidenceKind: receipt.kind,
					...(receipt.gateId === undefined ? {} : { gateId: receipt.gateId }),
					receiptRef: receipt.receiptId,
					workKey: contract.workKey,
					strategyKey: contract.strategyKey,
					assignmentId: receipt.assignmentId ?? assignment.assignmentId,
					cursor: workerResult.resultId,
				},
			});
		}
	};
	const recordBlockedTransition = (
		transition: SanLoopTransition,
		actor: SanLoopRole,
		data?: Record<string, unknown>,
	) => {
		const blockedRecord = recordSanLoopTransition(options.sessionManager, transition, { actor, data });
		transitions.push(blockedRecord);
		run = blockedRecord.run;
	};
	const roleDispatchBlocked = (role: SanLoopRole, reason: string) => {
		const createdAt = new Date().toISOString();
		recordBlockedTransition(
			{
				run: updateSanLoopRunSnapshot(run, {
					status: "blocked",
					updatedAt: createdAt,
					finalVerdict: "blocked",
					budget: [...run.budget, { createdAt, state: "blocked", remainingTurns }],
				}),
				eventType: "blocked",
				eventSummary: reason,
				retryExhausted: false,
			},
			"commander",
			{ blockedBy: "dispatch_gate", role },
		);
	};
	const bindPassedTransitionToScope = (transition: SanLoopTransition): SanLoopTransition => {
		if (transition.run.status !== "passed" || finalizeCompletedScope()) return transition;
		const createdAt = new Date().toISOString();
		return {
			...transition,
			run: updateSanLoopRunSnapshot(transition.run, {
				status: "blocked",
				updatedAt: createdAt,
				finalVerdict: "blocked",
				budget: [...transition.run.budget, { createdAt, state: "blocked", remainingTurns }],
			}),
			eventType: "blocked",
			eventSummary: "Host evidence gates are not satisfied; pass finalization is blocked.",
			retryExhausted: false,
		};
	};
	const tryScopeGate = (): boolean => {
		const snapshot = scopeHandle()?.snapshot();
		if (!snapshot) return false;
		let reason: string | undefined;
		if (snapshot.state === "needs_user") {
			reason = "Execution scope is waiting for user input; role dispatch is blocked.";
		} else if (isTerminalExecutionState(snapshot.state)) {
			reason = `Execution scope is terminal (${snapshot.state}); role dispatch is blocked.`;
		} else {
			const providers = options.executionRuntime.providerRegistry.all();
			// 空 registry 表示尚无 provider 观测，不得提前判定 no_provider_available；
			// 仅当存在已知 route 且全部不可 dispatch 时才终止。可用性由 registry 按
			// 注入 clock 纯查询判定：open 未到期 / half_open 已有在途 probe 均不可。
			const hasViableRoute = options.executionRuntime.providerRegistry.hasDispatchableRoute();
			if (providers.length > 0 && !hasViableRoute) {
				finalizeScopeState("no_provider_available");
				reason = "No provider route is available; role dispatch is blocked until a route recovers.";
			}
		}
		if (reason === undefined) return false;
		const createdAt = new Date().toISOString();
		recordBlockedTransition(
			{
				run: updateSanLoopRunSnapshot(run, {
					status: "blocked",
					updatedAt: createdAt,
					finalVerdict: "blocked",
					budget: [...run.budget, { createdAt, state: "blocked", remainingTurns }],
				}),
				eventType: "blocked",
				eventSummary: reason,
				retryExhausted: false,
			},
			"commander",
			{ blockedBy: "scope_gate", scopeState: snapshot.state },
		);
		return true;
	};
	const blockForBudget = (finalizeScope = true) => {
		if (finalizeScope) finalizeBudgetExhausted();
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
		finalizeBudgetExhausted();
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
	const workerContracts = new Map<string, TaskContractIdentity>();
	const terminalTaskStatuses = new Set<TaskContractStatus>(["completed", "failed", "cancelled", "rejected"]);
	const workerContractInput = (assignment: SanLoopWorkerAssignment) => ({
		scopeId: options.executionScopeId,
		workKey: assignment.assignmentId,
		strategyKey: `san-loop:${mode}:worker`,
		taskId: assignment.taskNodeIds[0],
	});
	const registerWorkerContract = (assignment: SanLoopWorkerAssignment): TaskContractIdentity => {
		const input = workerContractInput(assignment);
		const admission = options.executionRuntime.taskRegistry.admit({
			...input,
			semantic: assignment.objective,
		});
		workerContracts.set(assignment.assignmentId, admission.contract);
		return admission.contract;
	};
	const setWorkerContractStatus = (assignmentId: string, status: TaskContractStatus): void => {
		const contract = workerContracts.get(assignmentId);
		if (!contract) return;
		const current = options.executionRuntime.taskRegistry.get(contract);
		if (!current || terminalTaskStatuses.has(current.status)) return;
		options.executionRuntime.taskRegistry.setStatus(contract, status);
	};
	const cancelOpenWorkerContracts = (): void => {
		for (const [assignmentId, contract] of workerContracts) {
			const current = options.executionRuntime.taskRegistry.get(contract);
			if (current?.status === "queued" || current?.status === "running") {
				options.executionRuntime.taskRegistry.setStatus(contract, "cancelled");
			}
			workerContracts.delete(assignmentId);
		}
	};
	const roleContractKey = (role: SanLoopRole) => ({
		scopeId: options.executionScopeId,
		workKey: `${run.runId}:${role}`,
		strategyKey: `san-loop:${mode}:${role}`,
		taskId: `${run.runId}:${role}`,
	});
	const admittedRoleContracts = new Set<SanLoopRole>();
	const releaseRoleContract = (role: SanLoopRole): void => {
		options.executionRuntime.taskRegistry.remove(roleContractKey(role));
		admittedRoleContracts.delete(role);
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
		let scheduler = options.executionRuntime.schedulerFor(options.executionScopeId);
		reviewReserve = hasSupervisor || hasOracle ? Math.max(0, Math.ceil(totalTurns * reserveRatio)) : 0;
		let roleCallSequence = 0;
		const recordRoleHostFact = (
			role: SanLoopRole,
			assignmentId: string,
			cursor: string,
			evidenceRefs: readonly string[] = [],
		) => {
			// 角色完成是模型 yield 事实，只计 activity；host-owned typed receipts
			// 才记录 evidence 进度。失败/取消在 catch 分支以稳定 failure signature
			// 上报，绝不静默吞掉。
			options.executionRuntime.recordHostObservation({
				scopeId: options.executionScopeId,
				observation: {
					type: "activity",
					observationId: cursor,
					...(evidenceRefs.length > 0 ? { expectedEvidenceRefs: evidenceRefs } : {}),
					workKey: `${run.runId}:${role}`,
					strategyKey: `san-loop:${mode}:${role}`,
					assignmentId,
					cursor,
				},
			});
		};
		const admitRoleAssignment = (role: SanLoopRole): string | undefined => {
			const roleAssignmentId = `${run.runId}:${role}:${roleCallSequence++}`;
			// 角色使用稳定 TaskContract identity 准入；同一契约已准入（reused）
			// 表示重复派发，不得再次执行角色。
			const admission = options.executionRuntime.taskRegistry.admit({
				...roleContractKey(role),
				semantic: `san-loop ${mode} ${role} 角色调用`,
			});
			if (admission.kind === "reused") return undefined;
			admittedRoleContracts.add(role);
			// 任何 agent/provider 网络调用之前完成调度准入；被拒时同步释放
			// role contract，避免预算或 scheduler gate 留下幽灵准入。
			if (!scheduler.admitDispatch(roleAssignmentId).admitted) {
				releaseRoleContract(role);
				return undefined;
			}
			return roleAssignmentId;
		};
		executionLoop: while (true) {
			signal.throwIfAborted();
			// 分支可能被外部 syncBranch 重建：每次迭代确认 scheduler 仍绑定当前
			// ledger，确保后续所有决策（准入/派发/观察）使用新 ledger。
			{
				const current = options.executionRuntime.schedulerFor(options.executionScopeId);
				if (current !== scheduler) scheduler = current;
			}
			if (tryScopeGate()) break;
			// 角色派发准入必须在任何 turn/usage 预算预留与 provider 网络调用之前。
			let commanderAssignmentId: string | undefined;
			if (hasCommander) {
				commanderAssignmentId = admitRoleAssignment("commander");
				if (commanderAssignmentId === undefined) {
					roleDispatchBlocked(
						"commander",
						"Commander dispatch was denied by the execution scheduler admission gate.",
					);
					break;
				}
			}
			if (!spendTurns(1)) {
				blockForBudget();
				break;
			}
			if (tryEnforceUsageBudget()) break;

			let batchAssignments: SanLoopWorkerAssignment[];

			if (hasCommander) {
				if (tryEnforceUsageBudget()) break;
				const commanderResult = await scheduler.executeAssignment(commanderAssignmentId!, () =>
					options.executor.commander({
						run,
						mode,
						signal,
						latestReview: latestReview(run),
						checks: selectSanLoopChecks(options.checks ?? [], { role: "commander" }),
						budget: hasExclusiveUsageBudget(usageLimits)
							? remainingRoleBudget(options.executor, usageLimits)
							: undefined,
					}),
				);
				signal.throwIfAborted();
				const planned = withExecutorUsage(
					withBudgetRemaining(applySanLoopPlan(run, commanderResult.plan), remainingTurns),
					options.executor,
				);
				const plannedRecord = recordSanLoopTransition(options.sessionManager, planned, { actor: "commander" });
				transitions.push(plannedRecord);
				run = plannedRecord.run;
				recordRoleHostFact(
					"commander",
					commanderAssignmentId!,
					`${run.runId}:commander:${run.retryCount}`,
					plannedRecord.run.plan?.checkPlan ?? [],
				);
				releaseRoleContract("commander");
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

			// host gate templates 在 assignment 已知后物化：gateId 永远追加
			// assignmentId。重入时复用原 gate/freshness，不得以同 recordId 改绑。
			const materializeAcceptanceGates = (assignments: SanLoopWorkerAssignment[]): void => {
				const templates = options.acceptanceGates ?? [];
				if (templates.length === 0 || assignments.length === 0) return;
				const handle = scopeHandle();
				if (!handle) return;
				const freshnessRevision = handle.snapshot().revision;
				const materialized = new Map<string, AcceptanceGate>();
				for (const gate of templates) {
					for (const assignment of assignments) {
						const gateId = `${gate.gateId}:${assignment.assignmentId}`;
						const existing = handle.snapshot().gates.find(candidate => candidate.gateId === gateId);
						if (existing) {
							const existingHash = existing.contractHash ?? existing.contractRef.contractHash;
							const templateHash = gate.contractHash ?? gate.contractRef.contractHash;
							if (
								existing.assignmentId !== assignment.assignmentId ||
								existing.contractRevision !== gate.contractRevision ||
								existing.contractRef.contractId !== gate.contractRef.contractId ||
								existingHash !== templateHash ||
								JSON.stringify(existing.contractRef.clauseRefs) !==
									JSON.stringify(gate.contractRef.clauseRefs) ||
								JSON.stringify(existing.objectiveClauseRefs) !== JSON.stringify(gate.objectiveClauseRefs) ||
								(existing.required !== false) !== (gate.required !== false) ||
								JSON.stringify(existing.verifier) !== JSON.stringify(gate.verifier)
							) {
								throw new Error(`Acceptance gate ${gateId} has a conflicting materialized binding.`);
							}
							materialized.set(gateId, existing);
							continue;
						}
						const bound: AcceptanceGate = {
							...gate,
							gateId,
							assignmentId: assignment.assignmentId,
							freshnessRevision,
						};
						handle.ledger.append({
							recordId: `gate:${options.executionScopeId}:${gateId}`,
							type: "acceptance_gate_recorded",
							gate: bound,
						});
						materialized.set(gateId, bound);
					}
				}
				run = { ...run, acceptanceGates: [...materialized.values()] };
			};
			materializeAcceptanceGates(batchAssignments);
			for (const assignment of batchAssignments) registerWorkerContract(assignment);
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
				scheduler.setRunnableNodes(pendingAssignments.flatMap(assignment => assignment.taskNodeIds));
				const batchWorkerResults: SanLoopWorkerResult[] = [];
				const reusedAssignments: SanLoopWorkerAssignment[] = [];
				const dispatchAssignments: SanLoopWorkerAssignment[] = [];
				let recoveryUsed = false;
				let recoveryPassed = false;
				let watchdogBlockedReason: string | undefined;
				for (const assignment of waveAssignments) {
					if (watchdogBlockedReason) break;
					const contract = options.executionRuntime.taskRegistry.derive({
						scopeId: options.executionScopeId,
						workKey: assignment.assignmentId,
						strategyKey: `san-loop:${mode}:worker`,
					});
					const decision = scheduler.enforce({
						observation: {
							type: "activity",
							assignmentId: assignment.assignmentId,
							workKey: contract.workKey,
							strategyKey: contract.strategyKey,
							requestKind: "assignment",
						},
						ledgerRevision: scheduler.ledger.revision,
					});
					if (decision.action === "reuse_duplicate") {
						const prior = run.workerResults.find(result => result.assignmentId === assignment.assignmentId);
						if (prior) {
							reusedAssignments.push(assignment);
							batchWorkerResults.push(prior);
						} else {
							watchdogBlockedReason = `Assignment ${assignment.assignmentId} is a duplicate without a reusable result.`;
						}
						continue;
					}
					if (decision.action === "reject_duplicate") {
						watchdogBlockedReason = `Assignment ${assignment.assignmentId} was rejected as a duplicate; no respawn.`;
						continue;
					}
					if (decision.action === "suppress_unchanged_poll") {
						watchdogBlockedReason =
							"No host progress signal changed; waiting for an external event before dispatching.";
						continue;
					}
					if (decision.action === "none" || decision.action === "stale_diagnosis") {
						// 同一契约已有先例结果时绝不再次执行（reused 语义）：复用既有
						// 结果，保证 scheduler 重建后 duplicate 判定与 watchdog 一致。
						const prior = run.workerResults.find(result => result.assignmentId === assignment.assignmentId);
						if (prior) {
							reusedAssignments.push(assignment);
							batchWorkerResults.push(prior);
						} else {
							dispatchAssignments.push(assignment);
						}
						continue;
					}
					if (decision.action === "repair_state_drift") {
						options.executionRuntime.syncBranch(options.sessionManager.getEntries());
						// syncBranch 重建 ledger：旧 scheduler 已失效，必须重新取得
						// scope scheduler，后续重试与决策全部基于新 ledger。
						scheduler = options.executionRuntime.schedulerFor(options.executionScopeId);
						const retried = scheduler.enforce({
							observation: {
								type: "activity",
								assignmentId: assignment.assignmentId,
								workKey: contract.workKey,
								strategyKey: contract.strategyKey,
								requestKind: "assignment",
							},
							ledgerRevision: scheduler.ledger.revision,
						});
						if (retried.action === "repair_state_drift") {
							watchdogBlockedReason = `Assignment ${assignment.assignmentId} state drift did not resolve after runtime sync.`;
						} else {
							dispatchAssignments.push(assignment);
						}
						continue;
					}
					if (decision.action === "diagnose") {
						if (recoveryUsed) {
							watchdogBlockedReason = "Stalled strategy already received its one bounded supervisor recovery.";
							continue;
						}
						recoveryUsed = true;
						const recoveryAssignmentId = admitRoleAssignment("supervisor");
						if (recoveryAssignmentId === undefined) {
							watchdogBlockedReason =
								"Supervisor recovery dispatch was denied by the execution scheduler admission gate.";
							continue;
						}
						if (!spendTurns(1, "review")) {
							blockForBudget();
							break executionLoop;
						}
						const recoveryInput = await scheduler.executeAssignment(recoveryAssignmentId, () =>
							options.executor.supervisor({
								run,
								assignments: [assignment],
								workerResults: run.workerResults.filter(result =>
									batchAssignments.some(candidate => candidate.assignmentId === result.assignmentId),
								),
								mode,
								signal,
								checks: selectSanLoopChecks(options.checks ?? [], { role: "supervisor" }),
								budget: hasExclusiveUsageBudget(usageLimits)
									? remainingRoleBudget(options.executor, usageLimits)
									: undefined,
							}),
						);
						signal.throwIfAborted();
						if (recoveryInput.reviewer !== "supervisor") {
							throw new Error(`San recovery returned reviewer ${recoveryInput.reviewer}; expected supervisor.`);
						}
						const recovered = bindPassedTransitionToScope(
							withExecutorUsage(
								withBudgetRemaining(
									applySanLoopReview(run, recoveryInput, {
										currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
										scopeId: options.executionScopeId,
									}),
									remainingTurns,
								),
								options.executor,
							),
						);
						const recoveredReview = recovered.run.reviewReports.at(-1);
						const recoveredRecord = recordSanLoopTransition(options.sessionManager, recovered, {
							actor: "supervisor",
							review: recoveredReview,
						});
						if (recoveredRecord.reviewEntryId) reviewEntryIds.push(recoveredRecord.reviewEntryId);
						transitions.push(recoveredRecord);
						run = recoveredRecord.run;
						if (recoveredReview) {
							recordRoleHostFact(
								"supervisor",
								recoveryAssignmentId,
								recoveredReview.reportId,
								recoveredReview.evidenceRefs,
							);
						}
						releaseRoleContract("supervisor");
						if (run.status === "passed" || run.status === "blocked") {
							recoveryPassed = true;
						} else if (run.status !== "retrying") {
							watchdogBlockedReason = "Supervisor recovery did not clear the stalled strategy.";
						}
					}
				}
				for (const assignment of reusedAssignments) {
					const prior = batchWorkerResults.find(result => result.assignmentId === assignment.assignmentId);
					setWorkerContractStatus(assignment.assignmentId, prior?.status === "completed" ? "completed" : "failed");
				}
				if (recoveryPassed) break executionLoop;
				if (watchdogBlockedReason) {
					const createdAt = new Date().toISOString();
					recordBlockedTransition(
						{
							run: updateSanLoopRunSnapshot(run, {
								status: "blocked",
								updatedAt: createdAt,
								finalVerdict: "blocked",
								budget: [...run.budget, { createdAt, state: "blocked", remainingTurns }],
							}),
							eventType: "blocked",
							eventSummary: watchdogBlockedReason,
							retryExhausted: false,
						},
						"commander",
						{ blockedBy: "watchdog" },
					);
					break executionLoop;
				}
				if (dispatchAssignments.length > 0) {
					const admitted = dispatchAssignments.filter(
						assignment => scheduler.admitDispatch(assignment.assignmentId).admitted,
					);
					dispatchAssignments.length = 0;
					dispatchAssignments.push(...admitted);
				}
				if (dispatchAssignments.length === 0 && reusedAssignments.length === 0) {
					// 全部派发被准入门拒绝：记录确定性 blocked，不静默中断。
					const createdAt = new Date().toISOString();
					recordBlockedTransition(
						{
							run: updateSanLoopRunSnapshot(run, {
								status: "blocked",
								updatedAt: createdAt,
								finalVerdict: "blocked",
								budget: [...run.budget, { createdAt, state: "blocked", remainingTurns }],
							}),
							eventType: "blocked",
							eventSummary: "All worker dispatches were denied by the execution scheduler admission gate.",
							retryExhausted: false,
						},
						"commander",
						{ blockedBy: "dispatch_gate", role: "worker" },
					);
					break executionLoop;
				}
				if (tryScopeGate()) break executionLoop;
				if (!spendTurns(dispatchAssignments.length)) {
					blockForBudget();
					break executionLoop;
				}
				if (tryEnforceUsageBudget()) break executionLoop;
				const workerResultInputs = await mapWithLimit(
					dispatchAssignments,
					maxWorkers,
					signal,
					async (assignment, index, workerSignal) => {
						setWorkerContractStatus(assignment.assignmentId, "running");
						const runWorker = () =>
							options.executor.worker({
								run,
								assignment,
								mode,
								signal: workerSignal,
								checks: selectSanLoopChecks(options.checks ?? [], { role: "worker" }),
								budget: exclusiveBudget
									? splitRoleBudget(exclusiveBudget, index, dispatchAssignments.length)
									: undefined,
							});
						try {
							const result = await scheduler.executeAssignment(assignment.assignmentId, runWorker);
							setWorkerContractStatus(
								assignment.assignmentId,
								result.status === "completed" ? "completed" : "failed",
							);
							return result;
						} catch (error) {
							setWorkerContractStatus(assignment.assignmentId, workerSignal.aborted ? "cancelled" : "failed");
							throw error;
						}
					},
				);
				signal.throwIfAborted();
				for (const workerInput of workerResultInputs) {
					const worked = withExecutorUsage(
						withBudgetRemaining(recordSanLoopWorkerResult(run, workerInput), remainingTurns),
						options.executor,
					);
					const workedRecord = recordSanLoopTransition(options.sessionManager, worked, { actor: "worker" });
					transitions.push(workedRecord);
					run = workedRecord.run;
					const workerResult = run.workerResults.at(-1);
					if (workerResult) {
						batchWorkerResults.push(workerResult);
						const workerAssignment = dispatchAssignments.find(
							candidate => candidate.assignmentId === workerInput.assignmentId,
						);
						if (workerAssignment) recordWorkerHostFacts(workerResult, workerAssignment);
					}
				}
				if (tryEnforceUsageBudget()) break executionLoop;
				for (const assignment of [...dispatchAssignments, ...reusedAssignments]) {
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
				for (const assignment of [...dispatchAssignments, ...reusedAssignments]) {
					for (const taskId of assignment.taskNodeIds) completedTaskIds.add(taskId);
				}
			}

			let oracleReview: SanLoopReviewReport | undefined;
			if (hasOracle) {
				const oracle = options.executor.oracle;
				if (!oracle) {
					blockForBudget();
					break;
				}
				if (tryScopeGate()) break;
				const oracleAssignmentId = admitRoleAssignment("oracle");
				if (oracleAssignmentId === undefined) {
					roleDispatchBlocked("oracle", "Oracle dispatch was denied by the execution scheduler admission gate.");
					break;
				}
				if (!spendTurns(1, "review")) {
					blockForBudget();
					break;
				}
				if (tryEnforceUsageBudget()) break;
				const oracleInput = await scheduler.executeAssignment(oracleAssignmentId!, () =>
					oracle({
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
					}),
				);
				signal.throwIfAborted();
				if (oracleInput.reviewer !== "oracle") {
					throw new Error(`San Oracle returned reviewer ${oracleInput.reviewer}; expected oracle.`);
				}
				const oracleReviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, oracleInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
							scopeId: options.executionScopeId,
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
				if (oracleReview) {
					recordRoleHostFact("oracle", oracleAssignmentId, oracleReview.reportId, oracleReview.evidenceRefs);
				}
				releaseRoleContract("oracle");
				if (tryEnforceUsageBudget()) break;
			}

			if (hasSupervisor) {
				if (tryScopeGate()) break;
				const supervisorAssignmentId = admitRoleAssignment("supervisor");
				if (supervisorAssignmentId === undefined) {
					roleDispatchBlocked(
						"supervisor",
						"Supervisor dispatch was denied by the execution scheduler admission gate.",
					);
					break;
				}
				if (!spendTurns(1, "review")) {
					blockForBudget();
					break;
				}
				if (tryEnforceUsageBudget()) break;
				const reviewInput = await scheduler.executeAssignment(supervisorAssignmentId!, () =>
					options.executor.supervisor({
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
					}),
				);
				signal.throwIfAborted();
				if (reviewInput.reviewer !== "supervisor") {
					throw new Error(`San Supervisor returned reviewer ${reviewInput.reviewer}; expected supervisor.`);
				}
				const reviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, reviewInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
							scopeId: options.executionScopeId,
						}),
						remainingTurns,
					),
					options.executor,
				);
				const review = reviewed.run.reviewReports.at(-1);
				if (review) {
					recordRoleHostFact("supervisor", supervisorAssignmentId, review.reportId, review.evidenceRefs);
				}
				releaseRoleContract("supervisor");
				if (reviewInput.externalBlocker && review?.verdict === "blocked") {
					// needs_user 只凭 typed external blocker 经 scheduler 进入；内部
					// 依赖阻塞保持 diagnose/blocked，绝不视为外部等待。
					scheduler.setRunnableNodes([]);
					const blocker = reviewInput.externalBlocker;
					const basis = supervisorDecisionBasis(scheduler.ledger);
					const decision: DurableSupervisorDecision = {
						decisionId: `review:${review.reportId}`,
						scopeId: options.executionScopeId,
						basisRevision: basis.revision,
						basisHash: basis.hash,
						action: "needs_user",
						evidenceRefs: [blocker.evidenceRef],
						invalidatedHypothesisRefs: [],
						confidence: review.confidence,
						createdAt: review.createdAt,
						externalBlocker: blocker,
					};
					scheduler.applySupervisorDecision(decision);
				}
				// P0-01：预算检查必须先于任何终态 pass 写入；超预算时只持久化
				// 单个 blocked envelope（可携带 review 供审计），绝不写入 status=passed。
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
					finalizeBudgetExhausted();
					break;
				}
				const scopeBoundReview = bindPassedTransitionToScope(reviewed);
				const reviewedRecord = recordSanLoopTransition(options.sessionManager, scopeBoundReview, {
					actor: review?.reviewer ?? "supervisor",
					review,
				});
				if (reviewedRecord.reviewEntryId) reviewEntryIds.push(reviewedRecord.reviewEntryId);
				transitions.push(reviewedRecord);
				run = reviewedRecord.run;
				if (run.status !== "retrying") break;
			} else {
				// 无 Supervisor 的流水线：由 worker 结果自动收尾。
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
					evidenceRefs: workerResults.flatMap(result =>
						(result.evidenceReceipts ?? []).map(receipt => receipt.receiptId),
					),
					retryable: false,
					requiredNextActions: [],
					confidence: hasFailures ? "low" : "high",
				};
				const reviewed = withExecutorUsage(
					withBudgetRemaining(
						applySanLoopReview(run, reviewInput, {
							currentBatchAssignmentIds: batchAssignments.map(a => a.assignmentId),
							scopeId: options.executionScopeId,
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
					finalizeBudgetExhausted();
					break;
				}
				const scopeBoundReview = bindPassedTransitionToScope(reviewed);
				const reviewedRecord = recordSanLoopTransition(options.sessionManager, scopeBoundReview, {
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
		// 未捕获的角色/worker 失败或取消以稳定指纹上报 watchdog（进度事实）；
		// 观测写入失败时保持原始错误为最终错误，不覆盖也不静默吞掉。
		try {
			options.executionRuntime.recordHostObservation({
				scopeId: options.executionScopeId,
				observation: {
					type: "failure",
					signature: stableFailureFingerprint(
						signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error),
					),
					workKey: `${run.runId}:runtime`,
					strategyKey: `san-loop:${mode}:runtime`,
					retryable: false,
				},
			});
		} catch {
			// 观测写入失败不得掩盖原始错误。
		}
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
			finalizeScopeState("aborted_by_user");
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
			finalizeScopeState("runtime_fault");
		}
		throw error;
	} finally {
		cancelOpenWorkerContracts();
		for (const role of [...admittedRoleContracts]) releaseRoleContract(role);
		if (activeSanLoopRuns.get(runCreated.run.runId) === activeRun) activeSanLoopRuns.delete(runCreated.run.runId);
		completion.resolve();
	}
}
