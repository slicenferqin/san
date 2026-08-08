import { logger } from "@san/utils";
import type { SessionEntry } from "../session/session-entries";
import { DurableScheduler } from "./durable-scheduler";
import { verifyAcceptanceGates } from "./evidence-gates";
import { ExecutionLedger, isTerminalExecutionState, StaleExecutionRevisionError } from "./execution-ledger";
import {
	ExecutionScopePersistence,
	type ExecutionScopeSessionManager,
	type ParsedExecutionScopeJournalRecord,
	readExecutionScopeJournal,
	rebuildExecutionScopeLedger,
} from "./persistence";
import { type HostObservation, stableValueFingerprint, toLedgerProgressObservation } from "./progress-classifier";
import {
	type ProviderHealthEvent,
	type ProviderHealthRegistry,
	type ProviderHealthSnapshot,
	providerHealthKeyId,
	providerHealthRefFromSnapshot,
	providerHealthSnapshotFromRef,
} from "./provider-health";
import { ExecutionScopeRegistry } from "./scope-registry";
import type { TaskContractChange, TaskContractRef, TaskContractRegistry, TaskContractSnapshot } from "./task-contract";
import type {
	EvidenceReceipt,
	EvidenceRef,
	ExecutionLedgerAppendResult,
	ExecutionScopeReference,
	ExecutionScopeSnapshot,
	ProviderHealthRef,
	StartExecutionScopeRequest,
} from "./types";
import type { WatchdogDecision } from "./watchdog";

let instanceCounter = 0;

export class ExecutionRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionRuntimeError";
	}
}

/** 运行时事件处理失败时携带的上下文：runtimeId/scopeId/event type 必须齐全，不得静默吞掉。 */
export interface ExecutionRuntimeEventErrorContext {
	readonly runtimeId: string;
	readonly scopeId?: string;
	/** 失败的 ledger record type、task change type 或 provider event type。 */
	readonly eventType?: string;
	readonly recordId?: string;
}

/**
 * 每个 root session 一个 runtime。仅回放传入的当前分支 entries，持有共享的
 * task/provider registries，同一时刻只拥有一个可写（active）scope。每个被接受的
 * ledger record 通过一个持久化订阅写入 session-manager journal。
 */
export interface ExecutionRuntimeOptions {
	readonly rootSessionId: string;
	/** 当前分支 session entries；只重建该分支的 journal。 */
	readonly branchEntries: readonly SessionEntry[];
	/** execution-scope journal 的 session-manager 持久化适配器。 */
	readonly sessionManager: ExecutionScopeSessionManager;
	/** 共享 task contract registry；root 的各 session 使用同一对象。 */
	readonly taskRegistry: TaskContractRegistry;
	/** 共享 provider health registry；root 的各 session 使用同一对象。 */
	readonly providerRegistry: ProviderHealthRegistry;
	/** 事件处理失败观察者；缺省为带运行时上下文的错误日志。 */
	readonly onEventError?: (error: unknown, context: ExecutionRuntimeEventErrorContext) => void;
	readonly now?: () => string;
}

export interface ExecutionScopeHandle {
	readonly scopeId: string;
	readonly rootSessionId: string;
	readonly logicalTurnId: string;
	readonly ledger: ExecutionLedger;
	snapshot(): Readonly<ExecutionScopeSnapshot>;
}

/**
 * 宿主两类事实的统一输入对象：真实 HostObservation（分类进度 + watchdog 决策）
 * 或 typed host evidence receipt（journal 证据，模型文本无法伪造）。
 */
export type RecordHostObservationInput =
	| { readonly scopeId: string; readonly observation: HostObservation }
	| { readonly scopeId: string; readonly receipt: EvidenceReceipt };

export type RecordHostObservationResult =
	| { readonly kind: "observation"; readonly decision: WatchdogDecision; readonly append: ExecutionLedgerAppendResult }
	| { readonly kind: "evidence"; readonly append: ExecutionLedgerAppendResult };

export interface FinishScopeOutcome {
	/** 调用方观察到的 CAS revision；过期 outcome 被拒绝。 */
	readonly expectedRevision: number;
	/**
	 * `needs_user` 有意不在此 outcome 中：只能通过
	 * DurableScheduler.applySupervisorDecision 携带 typed external blocker 进入。
	 * `no_provider_available` 由 provider pre-dispatch 无可用路径/circuit terminal 映射。
	 */
	readonly state: "completed" | "aborted_by_user" | "budget_exhausted" | "runtime_fault" | "no_provider_available";
}

export interface ExecutionRuntime {
	readonly runtimeId: string;
	readonly rootSessionId: string;
	readonly taskRegistry: TaskContractRegistry;
	readonly providerRegistry: ProviderHealthRegistry;

	/** 开启（或重新激活）一个 authoritative turn 的 scope 并使其成为 active。 */
	startScope(request: StartExecutionScopeRequest): ExecutionScopeHandle;
	activeScopeId(): string | undefined;
	getScope(scopeId: string): ExecutionScopeHandle | undefined;
	/** 绑定 materialized scope 的 scheduler；async child 可持其固定 scope 的 scheduler。 */
	schedulerFor(scopeId: string): DurableScheduler;
	/**
	 * 在任何网络工作之前登记 provider 请求：先过该 scope scheduler 的 dispatch
	 * gate（拒绝则不写 started、零网络），gate 通过后 journal request_started 并
	 * 捕获请求归属；晚到的 provider 终结回调路由回捕获 scope，即使 active 已切换。
	 * 未注册的请求结果绝不猜测进任何 scope。
	 */
	registerProviderDispatch(scopeId: string, requestId: string, assignmentId?: string): void;
	/**
	 * 向指定 materialized scope 记录宿主事实：真实 HostObservation 走该 scope
	 * scheduler 的 enforce（watchdog 决策 + 写 progress_observed）；typed host
	 * evidence receipt 写 evidence 并在 verifier 校验通过后推进绑定的 gate。
	 */
	recordHostObservation(input: RecordHostObservationInput): RecordHostObservationResult;
	/** 将 provider health snapshot 写入 active scope 的 ledger（脱敏投影）。 */
	recordProviderSnapshot(snapshot: ProviderHealthSnapshot): ExecutionLedgerAppendResult;
	/** 释放旧分支状态并从传入 entries 重建 scope/task/provider。 */
	syncBranch(entries: readonly SessionEntry[]): void;
	/** 以 revision CAS 将 active scope 转入终态。 */
	finishScope(scopeId: string, outcome: FinishScopeOutcome): ExecutionLedgerAppendResult;
	/** 幂等；拒绝后续所有写入并释放全部订阅。 */
	dispose(): void;
}

interface ScopeLedger {
	readonly scopeId: string;
	readonly ledger: ExecutionLedger;
}

interface MaterializedScope extends ScopeLedger {
	scheduler?: DurableScheduler;
	unsubscribe: () => void;
}

/** provider 派发注册：requestId/assignmentId 分表映射到捕获该请求的 scope。 */
interface ProviderDispatchRegistration {
	readonly scopeId: string;
	readonly requestId: string;
	readonly assignmentId?: string;
}

function scopeIdFromJournal(journal: readonly ParsedExecutionScopeJournalRecord[]): string | undefined {
	// active 恢复优先按最后一次权威 scope 激活（scope_started）语义：晚到的旧
	// scope 事件落在新 scope 之后也不会抢 active。分支 journal 压缩后 marker
	// 可能被丢弃（compactExecutionScopeJournal 只保留最新快照 + 后续事件），
	// 此时回退到最后一个 journal snapshot 的 scopeId —— 快照按 session 顺序
	// 落盘，最后的快照即最后一次被固化的 scope，符合"最后激活者胜"。
	let activeScopeId: string | undefined;
	let lastSnapshotScopeId: string | undefined;
	for (const entry of journal) {
		if (entry.journalType === "event" && entry.record.type === "scope_started") {
			activeScopeId = entry.record.scopeId;
		} else if (entry.journalType === "snapshot") {
			lastSnapshotScopeId = entry.snapshot.scopeId;
		}
	}
	return activeScopeId ?? lastSnapshotScopeId;
}

function contractKey(identity: Pick<TaskContractRef, "scopeId" | "workKey" | "strategyKey">): string {
	return `${identity.scopeId}\u0000${identity.workKey}\u0000${identity.strategyKey}`;
}

function healthRouteKey(health: Pick<ProviderHealthRef, "providerKey" | "normalizedUrl" | "modelKey">): string {
	return `${health.providerKey}\u0000${health.normalizedUrl}\u0000${health.modelKey ?? ""}`;
}

/**
 * 分支 references（按 journal 顺序；每个 root 最后一个 reference 作为 current）。
 * 快照与事件都作为同序基线：compaction 后仅剩快照时同样可恢复。
 */
function scopeReferencesFromJournal(journal: readonly ParsedExecutionScopeJournalRecord[]): ExecutionScopeReference[] {
	const byScopeId = new Map<string, ExecutionScopeReference>();
	for (const entry of journal) {
		if (entry.journalType === "event") {
			const record = entry.record;
			if (!record.objectiveContract || byScopeId.has(record.scopeId)) continue;
			byScopeId.set(record.scopeId, {
				scopeId: record.scopeId,
				rootSessionId: record.rootSessionId,
				logicalTurnId: record.logicalTurnId,
				objectiveContract: record.objectiveContract,
				createdAt: record.occurredAt,
			});
			continue;
		}
		const snapshot = entry.snapshot;
		if (!snapshot.objectiveContract || byScopeId.has(snapshot.scopeId)) continue;
		byScopeId.set(snapshot.scopeId, {
			scopeId: snapshot.scopeId,
			rootSessionId: snapshot.rootSessionId,
			logicalTurnId: snapshot.logicalTurnId,
			objectiveContract: snapshot.objectiveContract,
			createdAt: snapshot.updatedAt,
		});
	}
	return [...byScopeId.values()];
}

/**
 * 每个 scope/work/strategy 最新完整 contract snapshot；removal tombstone 优先。
 * 快照记录是该 scope 在 coveredRevision 的完整基线（full snapshots 原样恢复），
 * 之后的事件/tombstone 再按序叠加。
 */
function taskContractsFromJournal(journal: readonly ParsedExecutionScopeJournalRecord[]): TaskContractSnapshot[] {
	const byScope = new Map<string, Map<string, TaskContractSnapshot>>();
	for (const entry of journal) {
		if (entry.journalType === "snapshot") {
			// 快照携带该 scope 的完整契约基线（full snapshots），直接整体替换。
			const baseline = new Map<string, TaskContractSnapshot>();
			for (const contract of entry.snapshot.taskContracts) {
				if (contract.scopeId !== entry.snapshot.scopeId) continue;
				baseline.set(contractKey(contract), contract);
			}
			byScope.set(entry.snapshot.scopeId, baseline);
			continue;
		}
		if (entry.record.type !== "task_contract_recorded") continue;
		const contract = entry.record.contract;
		let scopeContracts = byScope.get(contract.scopeId);
		if (!scopeContracts) {
			scopeContracts = new Map();
			byScope.set(contract.scopeId, scopeContracts);
		}
		if (entry.record.removed === true) scopeContracts.delete(contractKey(contract));
		else scopeContracts.set(contractKey(contract), contract);
	}
	const restored: TaskContractSnapshot[] = [];
	for (const scopeContracts of byScope.values()) restored.push(...scopeContracts.values());
	return restored;
}

/** 每个 route 最新脱敏 provider health snapshot；快照是完整基线，事件按序叠加。 */
function providerHealthFromJournal(journal: readonly ParsedExecutionScopeJournalRecord[]): ProviderHealthSnapshot[] {
	const byRoute = new Map<string, ProviderHealthSnapshot>();
	for (const entry of journal) {
		if (entry.journalType === "snapshot") {
			// 快照是分支在 coveredRevision 的完整 provider 基线：先清空旧 route
			// 映射，避免已不在快照中的 route 残留（跨 scope/跨分支继承）。
			byRoute.clear();
			for (const health of entry.snapshot.providerHealth)
				byRoute.set(healthRouteKey(health), providerHealthSnapshotFromRef(health));
			continue;
		}
		if (entry.record.type !== "provider_health_recorded") continue;
		byRoute.set(healthRouteKey(entry.record.health), providerHealthSnapshotFromRef(entry.record.health));
	}
	return [...byRoute.values()];
}

export class ExecutionRuntimeImpl implements ExecutionRuntime {
	readonly runtimeId: string;
	readonly rootSessionId: string;
	readonly taskRegistry: TaskContractRegistry;
	readonly providerRegistry: ProviderHealthRegistry;
	readonly #now: () => string;
	readonly #scopeRegistry: ExecutionScopeRegistry;
	readonly #persistence: ExecutionScopePersistence;
	readonly #onEventError: (error: unknown, context: ExecutionRuntimeEventErrorContext) => void;
	#branchEntries: readonly SessionEntry[];
	#activeScopeId?: string;
	/** 分支内所有带活持久化订阅的 scope；active 切换后仍然保留以便晚到事件路由。 */
	readonly #materialized = new Map<string, MaterializedScope>();
	/** provider 派发注册（requestId 与 assignmentId 分表）：捕获该请求的 scope。 */
	readonly #dispatchesByRequestId = new Map<string, ProviderDispatchRegistration>();
	readonly #dispatchesByAssignmentId = new Map<string, ProviderDispatchRegistration>();
	/** 每个 scope 已见的 typed host receipts（供 review gate 组合校验；branch 切换即清）。 */
	readonly #receiptsByScope = new Map<string, Map<string, EvidenceReceipt>>();
	#taskUnsubscribe?: () => void;
	#providerUnsubscribe?: () => void;
	#disposed = false;

	constructor(options: ExecutionRuntimeOptions) {
		this.rootSessionId = options.rootSessionId;
		this.runtimeId = `runtime:${options.rootSessionId}:${++instanceCounter}`;
		this.taskRegistry = options.taskRegistry;
		this.providerRegistry = options.providerRegistry;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#onEventError =
			options.onEventError ??
			((error, context) => {
				logger.error("Execution runtime event handling failed", {
					...context,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		this.#scopeRegistry = new ExecutionScopeRegistry({ now: this.#now });
		this.#persistence = new ExecutionScopePersistence(options.sessionManager);
		this.#branchEntries = [...options.branchEntries];
		// 订阅先于分支恢复挂载，避免漏掉生命周期事件；reset/cleared 标记事件被
		// 处理器忽略，因此恢复本身绝不会写回 journal。
		this.#taskUnsubscribe = this.taskRegistry.subscribe(change => this.#onTaskChange(change));
		this.#providerUnsubscribe = this.providerRegistry.subscribe(event => this.#onProviderEvent(event));
		const journal = readExecutionScopeJournal(this.#branchEntries);
		this.#restoreRegistries(journal);
		const activeScopeId = scopeIdFromJournal(journal);
		if (activeScopeId) this.#materializeActive(activeScopeId);
	}

	startScope(request: StartExecutionScopeRequest): ExecutionScopeHandle {
		this.#assertWritable();
		const reference = this.#scopeRegistry.startAuthoritativeTurn(request);
		if (this.#activeScopeId === reference.scopeId) {
			const current = this.#materialized.get(reference.scopeId);
			if (current) return this.#handleFor(current);
		}
		const existing = this.#rebuild(reference.scopeId);
		if (existing) {
			this.#activate(reference.scopeId, existing);
			return this.#handleFor(this.#requireScope(reference.scopeId));
		}
		const ledger = new ExecutionLedger({
			scopeId: reference.scopeId,
			rootSessionId: reference.rootSessionId,
			logicalTurnId: reference.logicalTurnId,
			objectiveContract: reference.objectiveContract,
			now: this.#now,
			onSubscriberError: (error, record) =>
				this.#onEventError(error, {
					runtimeId: this.runtimeId,
					scopeId: record.scopeId,
					eventType: record.type,
					recordId: record.recordId,
				}),
		});
		this.#activate(reference.scopeId, ledger);
		ledger.append({
			recordId: `scope:${reference.scopeId}:started`,
			type: "scope_started",
			objectiveContract: reference.objectiveContract,
		});
		// 新 turn 继承共享 registry 当前的脱敏 health 作为 journal 基线，保证该
		// turn 无 provider 事件时，重启/分支恢复也不会丢失 provider 状态。
		for (const snapshot of this.providerRegistry.all()) {
			ledger.append({
				recordId: `provider-health:${providerHealthKeyId(snapshot.key)}:${snapshot.healthRevision}`,
				type: "provider_health_recorded",
				health: providerHealthRefFromSnapshot(snapshot),
			});
		}
		return this.#handleFor(this.#requireScope(reference.scopeId));
	}

	activeScopeId(): string | undefined {
		// active 指针只用于 UI/无显式 root 回退；读取与写入均按 materialized scope 解析。
		return this.#activeScopeId;
	}

	getScope(scopeId: string): ExecutionScopeHandle | undefined {
		const scope = this.#materialized.get(scopeId);
		return scope ? this.#handleFor(scope) : undefined;
	}

	schedulerFor(scopeId: string): DurableScheduler {
		// 每个 materialized scope 持有独立 scheduler：async child 固定 scope 在根
		// 会话切到新 scope 后仍可继续派发/观察，互不干扰。
		const scope = this.#requireScope(scopeId);
		if (!scope.scheduler) {
			scope.scheduler = new DurableScheduler({ ledger: scope.ledger });
			this.#seedWatchdogDuplicates(scope);
			this.#refreshRunnableNodes(scope);
		}
		return scope.scheduler;
	}

	registerProviderDispatch(scopeId: string, requestId: string, assignmentId?: string): void {
		this.#assertWritable();
		if (!requestId) throw new ExecutionRuntimeError("Provider dispatch registration requires a requestId.");
		const scope = this.#requireScope(scopeId);
		if (isTerminalExecutionState(scope.ledger.state)) {
			throw new ExecutionRuntimeError(
				`Execution scope ${scopeId} is terminal with state ${scope.ledger.state}; late provider dispatches are rejected.`,
			);
		}
		if (this.#dispatchesByRequestId.has(requestId)) {
			throw new ExecutionRuntimeError(`Provider request ${requestId} is already registered for dispatch.`);
		}
		// 零网络前置 gate：terminal/needs_user/窗口/in-flight/租约均在此拒绝，
		// 拒绝时不写 request_started 也不放行网络调用。
		if (assignmentId !== undefined && assignmentId.length > 0) {
			const scheduler = this.schedulerFor(scopeId);
			const admission = scheduler.admitDispatch(assignmentId);
			if (!admission.admitted) {
				throw new ExecutionRuntimeError(
					`Provider dispatch for assignment ${assignmentId} was rejected by the scheduler gate: ${admission.reason ?? "unknown"}.`,
				);
			}
			if (!admission.inFlight) scheduler.startAssignment(assignmentId);
		}
		scope.ledger.append({
			recordId: `request:${requestId}:started`,
			type: "request_started",
			requestId,
		});
		const registration: ProviderDispatchRegistration = {
			scopeId,
			requestId,
			...(assignmentId !== undefined && assignmentId.length > 0 ? { assignmentId } : {}),
		};
		this.#dispatchesByRequestId.set(requestId, registration);
		if (registration.assignmentId !== undefined) {
			this.#dispatchesByAssignmentId.set(registration.assignmentId, registration);
		}
	}

	recordHostObservation(input: RecordHostObservationInput): RecordHostObservationResult {
		this.#assertWritable();
		const scope = this.#requireScope(input.scopeId);
		if (isTerminalExecutionState(scope.ledger.state)) {
			throw new ExecutionRuntimeError(
				`Execution scope ${scope.scopeId} is terminal with state ${scope.ledger.state}; late host observations are rejected.`,
			);
		}
		if ("receipt" in input) return this.#recordEvidenceReceipt(scope, input.receipt);
		const scheduler = this.schedulerFor(scope.scopeId);
		const decision = scheduler.enforce(input.observation);
		const observation = toLedgerProgressObservation(decision.classification, scope.ledger.revision);
		const append = scope.ledger.append({
			type: "progress_observed",
			recordId: `progress-record:${observation.observationId}:${observation.revision}`,
			observation,
		});
		return { kind: "observation", decision, append };
	}

	#recordEvidenceReceipt(scope: MaterializedScope, receipt: EvidenceReceipt): RecordHostObservationResult {
		if (receipt.source !== "host") {
			throw new ExecutionRuntimeError(
				`Evidence receipt ${receipt.receiptId} is not host-owned; model text cannot satisfy a host evidence gate.`,
			);
		}
		if (receipt.scopeId !== scope.scopeId) {
			throw new ExecutionRuntimeError(
				`Evidence receipt ${receipt.receiptId} is bound to scope ${receipt.scopeId}, not the materialized scope ${scope.scopeId}.`,
			);
		}
		const snapshot = scope.ledger.getSnapshot();
		const gate = snapshot.gates.find(candidate => candidate.gateId === receipt.gateId);
		if (gate === undefined) {
			throw new ExecutionRuntimeError(
				`Host evidence receipt ${receipt.receiptId} refers to unknown gate ${receipt.gateId}.`,
			);
		}
		// 外部依赖收据（含 fail/failed 阻塞证据）在 append 前校验 gate/verifier/
		// dependency 绑定，避免错 dependency 的 receipt 被 needs_user 阻塞路径使用。
		if (
			receipt.kind === "external" &&
			(gate.verifier.kind !== "external" || receipt.dependencyId !== gate.verifier.dependencyId)
		) {
			throw new ExecutionRuntimeError(
				`Host evidence receipt ${receipt.receiptId} is external but its dependency does not bind to gate ${receipt.gateId}.`,
			);
		}
		const receipts = this.#receiptsFor(scope.scopeId);
		const priorReceipt = receipts.get(receipt.receiptId);
		if (priorReceipt && stableValueFingerprint(priorReceipt) !== stableValueFingerprint(receipt)) {
			throw new ExecutionRuntimeError(`Host evidence receipt ${receipt.receiptId} cannot change after recording.`);
		}
		const evidence: EvidenceRef = {
			evidenceId: receipt.receiptId,
			kind: receipt.kind,
			receiptRef: receipt.receiptId,
			gateId: receipt.gateId,
			contractRevision: receipt.contractRevision,
			...(receipt.assignmentId === undefined ? {} : { assignmentId: receipt.assignmentId }),
			freshnessRevision: receipt.freshnessRevision,
		};
		const passing = receipt.outcome === "pass" || receipt.outcome === "passed";
		let gateUpdate: typeof gate | undefined;
		if (passing || receipt.kind === "external") {
			// 失败的 external receipt 证明“依赖仍阻塞”，不是 gate pass。校验时仅
			// 临时投影成 passing outcome，以复用完整的 contract/freshness/assignment/
			// verifier 身份检查；持久化仍保留原始失败 outcome，gate 标记 blocked。
			const verificationReceipt = passing ? receipt : { ...receipt, outcome: "pass" as const };
			const verificationGate = {
				...gate,
				required: true,
				status: "pass" as const,
				evidenceRefs: [evidence],
			};
			const verdict = verifyAcceptanceGates({
				scopeId: scope.scopeId,
				contractRevision: gate.contractRevision,
				contractHash: gate.contractHash ?? gate.contractRef.contractHash,
				freshnessRevision: receipt.freshnessRevision,
				gates: [verificationGate],
				receipts: [
					...[...receipts.values()].filter(candidate => candidate.receiptId !== receipt.receiptId),
					verificationReceipt,
				],
				assignmentIds: gate.assignmentId === undefined ? undefined : [gate.assignmentId],
			});
			if (!verdict.passed) {
				throw new ExecutionRuntimeError(
					`Host evidence receipt ${receipt.receiptId} failed verification for gate ${gate.gateId}: ${verdict.reasons.join("; ")}`,
				);
			}
			if (passing && gate.status !== "pass") {
				gateUpdate = { ...gate, status: "pass", evidenceRefs: [evidence] };
			} else if (!passing && gate.status !== "pass") {
				gateUpdate = {
					...gate,
					status: "blocked",
					evidenceRefs: gate.evidenceRefs.some(ref => ref.evidenceId === evidence.evidenceId)
						? gate.evidenceRefs
						: [...gate.evidenceRefs, evidence],
				};
			}
		}
		let result = scope.ledger.append({
			recordId: `evidence:${receipt.receiptId}`,
			type: "evidence_recorded",
			evidence,
		});
		receipts.set(receipt.receiptId, receipt);
		if (gateUpdate === undefined) return { kind: "evidence", append: result };
		result = scope.ledger.append({
			recordId: `gate:${gate.gateId}:${gateUpdate.status}:${receipt.receiptId}`,
			type: "acceptance_gate_recorded",
			gate: gateUpdate,
		});
		return { kind: "evidence", append: result };
	}

	recordProviderSnapshot(snapshot: ProviderHealthSnapshot): ExecutionLedgerAppendResult {
		this.#assertWritable();
		// 无 scopeId 参数的宿主快照按 active 回退；请求归属路径走 provider 事件。
		const active = this.#activeScope();
		if (!active) throw new ExecutionRuntimeError("Execution runtime has no active scope for provider snapshots.");
		if (isTerminalExecutionState(active.ledger.state)) {
			throw new ExecutionRuntimeError(
				`Execution scope ${active.scopeId} is terminal with state ${active.ledger.state}; late provider snapshots are rejected.`,
			);
		}
		return active.ledger.append({
			recordId: `provider-health:${providerHealthKeyId({
				provider: snapshot.provider,
				normalizedUrl: snapshot.normalizedUrl,
				modelId: snapshot.modelId,
			})}:${snapshot.healthRevision}`,
			type: "provider_health_recorded",
			health: providerHealthRefFromSnapshot(snapshot),
		});
	}

	syncBranch(entries: readonly SessionEntry[]): void {
		this.#assertWritable();
		this.#releaseActive();
		this.#branchEntries = [...entries];
		const journal = readExecutionScopeJournal(this.#branchEntries);
		this.#restoreRegistries(journal, { force: true });
		const activeScopeId = scopeIdFromJournal(journal);
		if (activeScopeId) this.#materializeActive(activeScopeId);
	}

	finishScope(scopeId: string, outcome: FinishScopeOutcome): ExecutionLedgerAppendResult {
		this.#assertWritable();
		const scope = this.#requireScope(scopeId);
		const ledger = scope.ledger;
		// expectedRevision CAS 优先：即使 scope 已 terminal，stale 调用也必须报
		// stale，不得进入 terminal/完成等其他检查。
		if (outcome.expectedRevision !== ledger.revision) {
			throw new StaleExecutionRevisionError(outcome.expectedRevision, ledger.revision);
		}
		if (isTerminalExecutionState(ledger.state)) {
			throw new ExecutionRuntimeError(
				`Execution scope ${scopeId} is already terminal with state ${ledger.state}; late finish events are rejected.`,
			);
		}
		if (outcome.state === "completed") {
			const requiredGates = ledger.getSnapshot().gates.filter(gate => gate.required !== false);
			if (requiredGates.length === 0) {
				throw new ExecutionRuntimeError(
					`Execution scope ${scopeId} cannot complete without at least one required acceptance gate.`,
				);
			}
			const notPassed = requiredGates.find(gate => gate.status !== "pass");
			if (notPassed) {
				throw new ExecutionRuntimeError(
					`Execution scope ${scopeId} cannot complete while acceptance gate ${notPassed.gateId} is not passed.`,
				);
			}
			const noEvidence = requiredGates.find(gate => gate.evidenceRefs.length === 0);
			if (noEvidence) {
				throw new ExecutionRuntimeError(
					`Execution scope ${scopeId} cannot complete while acceptance gate ${noEvidence.gateId} has no host evidence.`,
				);
			}
		}
		// 先把仍 started 的请求标为 interrupted（连带 finishAssignment 与 route
		// 清理），再以更新后的 revision 追加 terminal state_changed。
		for (const request of ledger.getSnapshot().requests) {
			if (request.status !== "started") continue;
			ledger.append({
				recordId: `request:${request.requestId}:finished:interrupted`,
				type: "request_finished",
				requestId: request.requestId,
				status: "interrupted",
			});
			const registration = this.#dispatchesByRequestId.get(request.requestId);
			if (registration !== undefined) {
				if (registration.assignmentId !== undefined) {
					scope.scheduler?.finishAssignment(registration.assignmentId);
				}
				this.#clearDispatch(registration);
			}
		}
		const result = ledger.append(
			{ recordId: `finish:${scopeId}:${ledger.revision + 1}`, type: "state_changed", state: outcome.state },
			{ expectedRevision: ledger.revision },
		);
		this.#persistence.appendSnapshot(ledger.snapshot());
		return result;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#releaseActive();
		this.#taskUnsubscribe?.();
		this.#taskUnsubscribe = undefined;
		this.#providerUnsubscribe?.();
		this.#providerUnsubscribe = undefined;
	}

	#restoreRegistries(
		journal: readonly ParsedExecutionScopeJournalRecord[],
		options: { readonly force?: boolean } = {},
	): void {
		// 分支恢复完全由 journal 驱动；registry 发出的 reset/cleared 标记事件被
		// 生命周期处理器忽略，因此恢复绝不会写回 journal。真实 syncBranch cutover
		// 必须 force：即使两个分支的 refs 完全相同，也要结算旧分支的 waiter/
		// probes/wakes，避免跨分支残留；constructor 首次挂载无需 force。
		this.#scopeRegistry.reset(scopeReferencesFromJournal(journal));
		this.taskRegistry.reset(taskContractsFromJournal(journal), options);
		this.providerRegistry.reset(providerHealthFromJournal(journal), options);
	}

	#materializeActive(scopeId: string): void {
		const ledger = this.#rebuild(scopeId);
		if (ledger) this.#activate(scopeId, ledger);
	}

	#rebuild(scopeId: string): ExecutionLedger | undefined {
		return rebuildExecutionScopeLedger(this.#branchEntries, { scopeId, now: this.#now });
	}

	#activate(scopeId: string, ledger: ExecutionLedger): void {
		// 仅替换同一 scope 的 ledger 实例时才释放旧 scheduler（其 watchdog 订阅
		// 绑定旧 ledger 实例）；不同 materialized scope 的 scheduler 独立并存，
		// 支持 async child 在根会话切到新 scope 后继续 provider/task 工作。
		const existing = this.#materialized.get(scopeId);
		if (existing) {
			existing.scheduler?.watchdog.dispose();
			existing.unsubscribe();
		}
		this.#materialized.set(scopeId, {
			scopeId,
			ledger,
			unsubscribe: ledger.subscribe(record => {
				try {
					this.#persistence.append(record);
				} catch (error) {
					this.#onEventError(error, {
						runtimeId: this.runtimeId,
						scopeId: record.scopeId,
						eventType: record.type,
						recordId: record.recordId,
					});
				}
			}),
		});
		this.#activeScopeId = scopeId;
	}

	/** 完整分支拆除：释放所有 scheduler、materialized 订阅、缓存与派发映射。 */
	#releaseActive(): void {
		this.#activeScopeId = undefined;
		for (const scope of this.#materialized.values()) {
			scope.scheduler?.watchdog.dispose();
			scope.unsubscribe();
		}
		this.#materialized.clear();
		this.#dispatchesByRequestId.clear();
		this.#dispatchesByAssignmentId.clear();
		this.#receiptsByScope.clear();
	}
	#onTaskChange(change: TaskContractChange): void {
		// reset 标记分支恢复而非生命周期变更，绝不能写回 journal。
		if (this.#disposed || change.type === "reset") return;
		const contract = change.snapshot;
		const target = this.#materialized.get(contract.scopeId);
		if (!target) return;
		// 终态 scope 的晚到事件被拒绝：ledger 保持不变。
		if (isTerminalExecutionState(target.ledger.state)) return;
		try {
			const removed = change.type === "removed";
			target.ledger.append({
				recordId: removed
					? `task-contract:${contract.contractId}:${contract.revision}:removed`
					: `task-contract:${contract.contractId}:${contract.revision}`,
				type: "task_contract_recorded",
				contract,
				...(removed ? { removed: true } : {}),
			});
			// 任何已 materialized 且有 scheduler 的 scope 都要刷新 runnable 节点：
			// A/B 并发时非 active child scope 不能因不是 active 而失去 runnable 更新。
			if (target.scheduler !== undefined) this.#refreshRunnableNodes(target);
		} catch (error) {
			this.#onEventError(error, {
				runtimeId: this.runtimeId,
				scopeId: target.scopeId,
				eventType: `task:${change.type}`,
			});
		}
	}

	#onProviderEvent(event: ProviderHealthEvent): void {
		// cleared/reset 标记分支恢复且不携带 health snapshot。
		if (this.#disposed || event.type === "cleared" || event.type === "reset") return;
		const target = this.#scopeForProviderEvent(event);
		if (!target || event.snapshot === undefined) return;
		// 终态 scope 的晚到事件被拒绝：ledger 保持不变。
		if (isTerminalExecutionState(target.ledger.state)) return;
		try {
			target.ledger.append({
				recordId: `provider-health:${providerHealthKeyId(event.snapshot.key)}:${event.snapshot.healthRevision}`,
				type: "provider_health_recorded",
				health: providerHealthRefFromSnapshot(event.snapshot),
			});
		} catch (error) {
			this.#onEventError(error, {
				runtimeId: this.runtimeId,
				scopeId: target.scopeId,
				eventType: `provider:${event.type}`,
			});
		}
		// 请求终结事件映射 request_finished。record id 以 requestId 命名，即使
		// health record 因同 revision 去重，请求生命周期也不会被吞掉。
		const registration = this.#registrationFor(event);
		const outcome = this.#terminalOutcome(event);
		if (registration === undefined || outcome === undefined) return;
		try {
			target.ledger.append({
				recordId: `request:${registration.requestId}:finished:${outcome}`,
				type: "request_finished",
				requestId: registration.requestId,
				status: outcome,
			});
			if (registration.assignmentId !== undefined) {
				target.scheduler?.finishAssignment(registration.assignmentId);
			}
			// 仅 terminal 后清 route：普通 state-change 事件保留捕获关系。
			this.#clearDispatch(registration);
		} catch (error) {
			this.#onEventError(error, {
				runtimeId: this.runtimeId,
				scopeId: target.scopeId,
				eventType: `provider:${event.type}`,
			});
		}
	}

	/**
	 * 将 provider 事件路由到捕获其请求的 scope：已注册的请求结果进入捕获 scope
	 * （该 scope 不再 materialized 时丢弃）；带归属但未注册的结果绝不猜测；只有
	 * 无请求归属的宿主本地事实（route-level state-change）回退到 active scope。
	 */
	#scopeForProviderEvent(event: ProviderHealthEvent): MaterializedScope | undefined {
		const registration = this.#registrationFor(event);
		if (registration !== undefined) {
			const captured = this.#materialized.get(registration.scopeId);
			if (!captured) return undefined;
			return captured;
		}
		if (event.requestId !== undefined || event.assignment !== undefined) return undefined;
		return this.#activeScope();
	}

	/** 事件归属解析：requestId 优先，其次 parked/resumed 的 assignmentId。 */
	#registrationFor(event: ProviderHealthEvent): ProviderDispatchRegistration | undefined {
		if (event.requestId !== undefined) {
			const byRequest = this.#dispatchesByRequestId.get(event.requestId);
			if (byRequest !== undefined) return byRequest;
		}
		if (event.assignment !== undefined) {
			const byAssignment = this.#dispatchesByAssignmentId.get(event.assignment.assignmentId);
			if (byAssignment !== undefined) return byAssignment;
		}
		return undefined;
	}

	/** 请求生命周期的终结事件；普通 state-change 事件（half_open/wake/heartbeat 等）不终结。 */
	#terminalOutcome(event: ProviderHealthEvent): "completed" | "failed" | "interrupted" | undefined {
		switch (event.type) {
			case "request_completed":
				return "completed";
			case "request_failed":
				return "failed";
			case "request_interrupted":
				return "interrupted";
			default:
				return undefined;
		}
	}

	#clearDispatch(registration: ProviderDispatchRegistration): void {
		this.#dispatchesByRequestId.delete(registration.requestId);
		if (registration.assignmentId !== undefined) {
			this.#dispatchesByAssignmentId.delete(registration.assignmentId);
		}
	}

	/** 用恢复出的 contracts 播种 watchdog 的重复身份，使 replay 后 enforce 返回 reuse_duplicate。 */
	#seedWatchdogDuplicates(scope: MaterializedScope): void {
		if (!scope.scheduler) return;
		for (const contract of this.taskRegistry.list(scope.scopeId)) {
			scope.scheduler.observe({
				workKey: contract.workKey,
				strategyKey: contract.strategyKey,
				assignmentId: contract.contractId,
				requestKind: "assignment",
				duplicateCandidate: true,
				// 与真实观察区分，避免污染 poll fingerprint 的重复计数。
				cursor: "runtime:seed",
			});
		}
	}

	#refreshRunnableNodes(scope: MaterializedScope): void {
		if (!scope.scheduler) return;
		const runnable = this.taskRegistry
			.list(scope.scopeId)
			.filter(contract => contract.status === "queued")
			.map(contract => contract.contractId);
		scope.scheduler.setRunnableNodes(runnable);
	}

	#receiptsFor(scopeId: string): Map<string, EvidenceReceipt> {
		let receipts = this.#receiptsByScope.get(scopeId);
		if (!receipts) {
			receipts = new Map();
			this.#receiptsByScope.set(scopeId, receipts);
		}
		return receipts;
	}

	#activeScope(): MaterializedScope | undefined {
		if (this.#activeScopeId === undefined) return undefined;
		return this.#materialized.get(this.#activeScopeId);
	}

	#requireScope(scopeId: string): MaterializedScope {
		const scope = this.#materialized.get(scopeId);
		if (!scope) {
			throw new ExecutionRuntimeError(`Execution scope ${scopeId} is not materialized in this runtime.`);
		}
		return scope;
	}
	#assertWritable(): void {
		if (this.#disposed) throw new ExecutionRuntimeError("Execution runtime is disposed; writes are rejected.");
	}
	#handleFor(scope: MaterializedScope): ExecutionScopeHandle {
		return {
			scopeId: scope.scopeId,
			rootSessionId: scope.ledger.rootSessionId,
			logicalTurnId: scope.ledger.logicalTurnId,
			ledger: scope.ledger,
			snapshot: () => scope.ledger.getSnapshot(),
		};
	}
}

export function createExecutionRuntime(options: ExecutionRuntimeOptions): ExecutionRuntime {
	return new ExecutionRuntimeImpl(options);
}
