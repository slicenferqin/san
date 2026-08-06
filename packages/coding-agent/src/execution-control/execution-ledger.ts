import { logger } from "@san/utils";
import type {
	AcceptanceGate,
	EvidenceRef,
	ExecutionAssignment,
	ExecutionLedgerAppendOptions,
	ExecutionLedgerAppendResult,
	ExecutionLedgerEvent,
	ExecutionLedgerOptions,
	ExecutionLedgerRecord,
	ExecutionLedgerSubscriber,
	ExecutionLedgerSubscriberErrorHandler,
	ExecutionRequestFact,
	ExecutionScopeSnapshot,
	ExecutionScopeState,
	ExecutionStrategy,
	ImmutableObjectiveContract,
	ObjectiveContractRef,
	ProgressObservation,
	ProviderHealthRef,
	SupervisorDecisionRef,
	UsageTelemetry,
	UsageTelemetryDelta,
} from "./types";
import { emptyUsageTelemetry } from "./types";

const TERMINAL_STATES: readonly ExecutionScopeState[] = ["completed", "aborted_by_user", "runtime_fault"];

function isTerminalState(state: ExecutionScopeState): boolean {
	return TERMINAL_STATES.includes(state);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function freezeDeep<T>(value: T): T {
	if (!isObject(value) || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeDeep(child);
	return Object.freeze(value);
}

function cloneFrozen<T>(value: T): T {
	return freezeDeep(structuredClone(value));
}

function stableSerialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `${value.toString()}n`;
	if (typeof value === "undefined") return "undefined";
	if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(",")}]`;
	if (isObject(value)) {
		const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
	}
	return JSON.stringify(String(value));
}

function eventDigest(event: ExecutionLedgerEvent): string {
	const {
		occurredAt: _occurredAt,
		scopeId: _scopeId,
		rootSessionId: _rootSessionId,
		logicalTurnId: _logicalTurnId,
		revision: _revision,
		objectiveContract: _objectiveContract,
		...content
	} = event as ExecutionLedgerRecord;
	return stableSerialize(content);
}

function sameValue(left: unknown, right: unknown): boolean {
	return stableSerialize(left) === stableSerialize(right);
}

function ensureFiniteNonNegative(name: string, value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0) throw new ExecutionLedgerError(`${name} must be finite and non-negative`);
	return value;
}

function addUsage(current: UsageTelemetry, delta: UsageTelemetryDelta, updatedAt: string): UsageTelemetry {
	const inputTokens = ensureFiniteNonNegative("inputTokens", delta.inputTokens);
	const outputTokens = ensureFiniteNonNegative("outputTokens", delta.outputTokens);
	const cacheReadTokens = ensureFiniteNonNegative("cacheReadTokens", delta.cacheReadTokens);
	const cacheWriteTokens = ensureFiniteNonNegative("cacheWriteTokens", delta.cacheWriteTokens);
	const totalTokens = ensureFiniteNonNegative(
		"totalTokens",
		delta.totalTokens === undefined ? inputTokens + outputTokens : delta.totalTokens,
	);
	return {
		inputTokens: current.inputTokens + inputTokens,
		outputTokens: current.outputTokens + outputTokens,
		cacheReadTokens: current.cacheReadTokens + cacheReadTokens,
		cacheWriteTokens: current.cacheWriteTokens + cacheWriteTokens,
		totalTokens: current.totalTokens + totalTokens,
		cost: current.cost + ensureFiniteNonNegative("cost", delta.cost),
		durationMs: current.durationMs + ensureFiniteNonNegative("durationMs", delta.durationMs),
		providerRequests: current.providerRequests + ensureFiniteNonNegative("providerRequests", delta.providerRequests),
		assignmentCount: current.assignmentCount + ensureFiniteNonNegative("assignmentCount", delta.assignmentCount),
		updatedAt,
	};
}

function updateById<T, K extends keyof T>(items: readonly T[], key: K, value: T): readonly T[] {
	const valueId = value[key];
	const index = items.findIndex(item => item[key] === valueId);
	if (index < 0) return [...items, value];
	return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function getById<T, K extends keyof T>(items: readonly T[], key: K, value: T[K]): T | undefined {
	return items.find(item => item[key] === value);
}

function objectiveRefsEqual(left: ObjectiveContractRef, right: ObjectiveContractRef): boolean {
	return sameValue(left, right);
}

function objectiveContractsEqual(left: ImmutableObjectiveContract, right: ImmutableObjectiveContract): boolean {
	return sameValue(left, right);
}

function scopeContractRef(snapshot: ExecutionScopeSnapshot): ObjectiveContractRef | undefined {
	return snapshot.objectiveContract?.ref;
}

export class ExecutionLedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionLedgerError";
	}
}

export class StaleExecutionRevisionError extends ExecutionLedgerError {
	readonly expectedRevision: number;
	readonly actualRevision: number;

	constructor(expectedRevision: number, actualRevision: number) {
		super(`Stale execution revision: expected ${expectedRevision}, current revision is ${actualRevision}.`);
		this.name = "StaleExecutionRevisionError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class ImmutableObjectiveContractError extends ExecutionLedgerError {
	constructor(message: string) {
		super(message);
		this.name = "ImmutableObjectiveContractError";
	}
}

export class TerminalExecutionStateError extends ExecutionLedgerError {
	readonly state: ExecutionScopeState;

	constructor(state: ExecutionScopeState) {
		super(`Execution scope is terminal with state ${state}; terminal state cannot be reversed.`);
		this.name = "TerminalExecutionStateError";
		this.state = state;
	}
}

export class DuplicateExecutionRecordError extends ExecutionLedgerError {
	readonly recordId: string;

	constructor(recordId: string) {
		super(`Execution record ${recordId} was already recorded with different facts.`);
		this.name = "DuplicateExecutionRecordError";
		this.recordId = recordId;
	}
}

interface MutableExecutionScopeSnapshot extends ExecutionScopeSnapshot {
	readonly revision: number;
}

/**
 * Append-only host fact ledger for one root execution scope.
 *
 * `append()` is the only mutating operation. Every accepted event receives the
 * next revision. Duplicate record identities are no-ops, while a caller that
 * supplies an out-of-date expected revision is rejected with a CAS error.
 */
export class ExecutionLedger {
	readonly #identity: {
		readonly scopeId: string;
		readonly rootSessionId: string;
		readonly logicalTurnId: string;
	};
	readonly #now: () => string;
	#snapshot: Readonly<ExecutionScopeSnapshot>;
	#records: Readonly<ExecutionLedgerRecord>[] = [];
	#recordDigests = new Map<string, string>();
	#knownRecordIds = new Set<string>();
	#subscribers = new Set<ExecutionLedgerSubscriber>();
	readonly #onSubscriberError: ExecutionLedgerSubscriberErrorHandler;

	constructor(options: ExecutionLedgerOptions) {
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#onSubscriberError =
			options.onSubscriberError ??
			((error, record) => {
				logger.error("Execution ledger subscriber failed", {
					scopeId: record.scopeId,
					recordId: record.recordId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		const snapshot = options.initialSnapshot;
		const scopeId = snapshot?.scopeId ?? options.scopeId;
		const rootSessionId = snapshot?.rootSessionId ?? options.rootSessionId;
		const logicalTurnId = snapshot?.logicalTurnId ?? options.logicalTurnId;
		if (!scopeId || !rootSessionId || !logicalTurnId) {
			throw new ExecutionLedgerError("ExecutionLedger requires scopeId, rootSessionId and logicalTurnId.");
		}
		if (
			snapshot &&
			(snapshot.scopeId !== scopeId ||
				snapshot.rootSessionId !== rootSessionId ||
				snapshot.logicalTurnId !== logicalTurnId)
		) {
			throw new ExecutionLedgerError("Initial execution snapshot identity does not match ledger identity.");
		}
		if (
			options.objectiveContract &&
			snapshot?.objectiveContract &&
			!objectiveContractsEqual(options.objectiveContract, snapshot.objectiveContract)
		) {
			throw new ImmutableObjectiveContractError("Initial execution snapshot objective contract cannot be replaced.");
		}
		this.#identity = { scopeId, rootSessionId, logicalTurnId };
		const initial = snapshot ?? {
			schemaVersion: 1,
			scopeId,
			rootSessionId,
			logicalTurnId,
			revision: 0,
			state: options.initialState ?? "running",
			objectiveContract: options.objectiveContract,
			gates: [],
			evidenceRefs: [],
			assignments: [],
			strategies: [],
			usage: emptyUsageTelemetry(),
			providerHealth: [],
			supervisorDecisions: [],
			requests: [],
			progress: [],
			recordIds: [],
			updatedAt: this.#now(),
		};
		this.#snapshot = cloneFrozen(initial);
		for (const recordId of this.#snapshot.recordIds) this.#knownRecordIds.add(recordId);
	}

	static replay(records: readonly ExecutionLedgerRecord[], options?: ExecutionLedgerOptions): ExecutionLedger {
		const first = records[0];
		if (!first && !options?.initialSnapshot) {
			throw new ExecutionLedgerError("Cannot replay an empty execution ledger without an initial snapshot.");
		}
		const ledger = new ExecutionLedger({
			...options,
			scopeId: options?.scopeId ?? first?.scopeId,
			rootSessionId: options?.rootSessionId ?? first?.rootSessionId,
			logicalTurnId: options?.logicalTurnId ?? first?.logicalTurnId,
		});
		for (const record of records) ledger.appendPersisted(record);
		return ledger;
	}

	get scopeId(): string {
		return this.#identity.scopeId;
	}

	get rootSessionId(): string {
		return this.#identity.rootSessionId;
	}

	get logicalTurnId(): string {
		return this.#identity.logicalTurnId;
	}

	get revision(): number {
		return this.#snapshot.revision;
	}

	get state(): ExecutionScopeState {
		return this.#snapshot.state;
	}

	getSnapshot(): Readonly<ExecutionScopeSnapshot> {
		return this.#snapshot;
	}

	snapshot(): Readonly<ExecutionScopeSnapshot> {
		return this.#snapshot;
	}

	entries(): readonly Readonly<ExecutionLedgerRecord>[] {
		return this.#records.map(record => cloneFrozen(record));
	}

	records(): readonly Readonly<ExecutionLedgerRecord>[] {
		return this.entries();
	}

	getRecord(recordId: string): Readonly<ExecutionLedgerRecord> | undefined {
		const record = this.#records.find(candidate => candidate.recordId === recordId);
		return record ? cloneFrozen(record) : undefined;
	}

	subscribe(subscriber: ExecutionLedgerSubscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	append(event: ExecutionLedgerEvent, options?: ExecutionLedgerAppendOptions | number): ExecutionLedgerAppendResult {
		const expectedRevision = typeof options === "number" ? options : options?.expectedRevision;
		this.#validateEventIdentity(event);
		const existing = this.#records.find(record => record.recordId === event.recordId);
		if (existing) {
			if (this.#recordDigests.get(event.recordId) !== eventDigest(event)) {
				throw new DuplicateExecutionRecordError(event.recordId);
			}
			return this.#duplicateResult(existing);
		}
		if (this.#knownRecordIds.has(event.recordId)) {
			return this.#duplicateResult(this.#recordFromInput(event));
		}
		if (expectedRevision !== undefined && expectedRevision !== this.revision) {
			throw new StaleExecutionRevisionError(expectedRevision, this.revision);
		}
		const occurredAt = event.occurredAt ?? this.#now();
		const record = cloneFrozen({
			...event,
			...this.#identity,
			...(this.#snapshot.objectiveContract ? { objectiveContract: this.#snapshot.objectiveContract } : {}),
			revision: this.revision + 1,
			occurredAt,
		}) as ExecutionLedgerRecord;
		return this.#appendRecord(record);
	}

	/** Apply a previously persisted record without assigning a new revision. */
	appendPersisted(record: ExecutionLedgerRecord): ExecutionLedgerAppendResult {
		this.#validatePersistedIdentity(record);
		const existing = this.#records.find(candidate => candidate.recordId === record.recordId);
		if (existing) {
			if (this.#recordDigests.get(record.recordId) !== eventDigest(record)) {
				throw new DuplicateExecutionRecordError(record.recordId);
			}
			return this.#duplicateResult(existing);
		}
		if (this.#knownRecordIds.has(record.recordId)) return this.#duplicateResult(record);
		if (record.revision !== this.revision + 1) {
			throw new StaleExecutionRevisionError(this.revision + 1, record.revision);
		}
		this.#validateRecordContract(record);
		return this.#appendRecord(cloneFrozen(record));
	}

	#appendRecord(record: Readonly<ExecutionLedgerRecord>): ExecutionLedgerAppendResult {
		const baseSnapshot =
			this.#snapshot.objectiveContract || !record.objectiveContract
				? this.#snapshot
				: (cloneFrozen({
						...this.#snapshot,
						objectiveContract: record.objectiveContract,
					}) as Readonly<ExecutionScopeSnapshot>);
		const reduced = this.#reduce(baseSnapshot, record);
		const next = cloneFrozen({
			...reduced,
			revision: record.revision,
			updatedAt: record.occurredAt,
			recordIds: [...baseSnapshot.recordIds, record.recordId],
		}) as Readonly<ExecutionScopeSnapshot>;
		this.#snapshot = next;
		this.#records.push(record);
		this.#knownRecordIds.add(record.recordId);
		this.#recordDigests.set(record.recordId, eventDigest(record));
		const result: ExecutionLedgerAppendResult = {
			accepted: true,
			duplicate: false,
			revision: record.revision,
			record,
			snapshot: next,
		};
		this.#notify(record, next);
		return result;
	}

	#notify(record: Readonly<ExecutionLedgerRecord>, snapshot: Readonly<ExecutionScopeSnapshot>): void {
		for (const subscriber of [...this.#subscribers]) {
			try {
				subscriber(record, snapshot);
			} catch (error) {
				this.#onSubscriberError(error, record, snapshot);
			}
		}
	}

	#duplicateResult(record: Readonly<ExecutionLedgerRecord>): ExecutionLedgerAppendResult {
		return {
			accepted: false,
			duplicate: true,
			revision: record.revision,
			record,
			snapshot: this.#snapshot,
		};
	}

	#recordFromInput(event: ExecutionLedgerEvent): Readonly<ExecutionLedgerRecord> {
		return cloneFrozen({
			...event,
			...this.#identity,
			...(this.#snapshot.objectiveContract ? { objectiveContract: this.#snapshot.objectiveContract } : {}),
			revision: this.revision,
			occurredAt: event.occurredAt ?? this.#now(),
		}) as Readonly<ExecutionLedgerRecord>;
	}

	#validateEventIdentity(event: ExecutionLedgerEvent): void {
		if (!event.recordId) throw new ExecutionLedgerError("Execution events require a recordId.");
		if (event.scopeId !== undefined && event.scopeId !== this.scopeId) {
			throw new ExecutionLedgerError(
				`Execution event ${event.recordId} belongs to scope ${event.scopeId}, not ${this.scopeId}.`,
			);
		}
	}

	#validatePersistedIdentity(record: ExecutionLedgerRecord): void {
		this.#validateEventIdentity(record);
		if (
			record.scopeId !== this.scopeId ||
			record.rootSessionId !== this.rootSessionId ||
			record.logicalTurnId !== this.logicalTurnId
		) {
			throw new ExecutionLedgerError(`Execution record ${record.recordId} belongs to a different scope identity.`);
		}
		if (!Number.isInteger(record.revision) || record.revision < 1) {
			throw new ExecutionLedgerError(`Execution record ${record.recordId} has an invalid revision.`);
		}
	}

	#validateRecordContract(record: ExecutionLedgerRecord): void {
		if (!record.objectiveContract) return;
		if (record.objectiveContract.source !== "authoritative_user") {
			throw new ImmutableObjectiveContractError(
				"Execution objective contracts must come from an authoritative user turn.",
			);
		}
		if (!this.#snapshot.objectiveContract) return;
		if (!objectiveContractsEqual(this.#snapshot.objectiveContract, record.objectiveContract)) {
			throw new ImmutableObjectiveContractError("Execution objective contract is immutable for a scope.");
		}
	}

	#reduce(
		snapshot: Readonly<ExecutionScopeSnapshot>,
		record: Readonly<ExecutionLedgerRecord>,
	): MutableExecutionScopeSnapshot {
		let next: MutableExecutionScopeSnapshot = { ...snapshot };
		const event = record;
		switch (event.type) {
			case "scope_started":
				if (snapshot.revision !== 0)
					throw new ExecutionLedgerError("scope_started must be the first execution record.");
				if (event.objectiveContract) next = this.#bindContract(next, event.objectiveContract);
				break;
			case "objective_contract_bound":
				next = this.#bindContract(next, event.objectiveContract);
				break;
			case "state_changed":
				if (isTerminalState(snapshot.state)) throw new TerminalExecutionStateError(snapshot.state);
				if (
					event.state === "completed" &&
					snapshot.gates.some(gate => gate.required !== false && gate.status !== "pass")
				) {
					throw new ExecutionLedgerError(
						"An execution scope cannot complete while an acceptance gate is not passed.",
					);
				}
				next = { ...next, state: event.state };
				break;
			case "acceptance_gate_recorded":
				this.#validateGate(next, event.gate);
				next = { ...next, gates: this.#upsertGate(next.gates, event.gate) };
				break;
			case "evidence_recorded":
				this.#validateEvidence(next, event.evidence);
				next = { ...next, evidenceRefs: this.#upsertEvidence(next.evidenceRefs, event.evidence) };
				break;
			case "assignment_recorded":
				this.#validateNestedScope(event.assignment.scopeId);
				next = { ...next, assignments: this.#upsertAssignment(next.assignments, event.assignment) };
				break;
			case "strategy_recorded":
				this.#validateNestedScope(event.strategy.scopeId);
				next = { ...next, strategies: this.#upsertStrategy(next.strategies, event.strategy) };
				break;
			case "usage_recorded":
				next = { ...next, usage: addUsage(next.usage, event.delta, record.occurredAt) };
				break;
			case "provider_health_recorded":
				next = { ...next, providerHealth: this.#upsertProviderHealth(next.providerHealth, event.health) };
				break;
			case "supervisor_decision_recorded":
				this.#validateNestedScope(event.decision.scopeId);
				next = { ...next, supervisorDecisions: this.#upsertDecision(next.supervisorDecisions, event.decision) };
				break;
			case "request_started":
				next = {
					...next,
					requests: this.#startRequest(
						next.requests,
						event.requestId,
						event.interrupted === true,
						record.occurredAt,
					),
				};
				break;
			case "request_finished":
				next = {
					...next,
					requests: this.#finishRequest(next.requests, event.requestId, event.status, record.occurredAt),
				};
				break;
			case "progress_observed":
				next = { ...next, progress: this.#upsertProgress(next.progress, event.observation) };
				break;
		}
		return next;
	}

	#bindContract(
		snapshot: MutableExecutionScopeSnapshot,
		contract: ImmutableObjectiveContract,
	): MutableExecutionScopeSnapshot {
		if (contract.source !== "authoritative_user") {
			throw new ImmutableObjectiveContractError(
				"Execution objective contracts must come from an authoritative user turn.",
			);
		}
		if (!snapshot.objectiveContract) return { ...snapshot, objectiveContract: cloneFrozen(contract) };
		if (!objectiveContractsEqual(snapshot.objectiveContract, contract)) {
			throw new ImmutableObjectiveContractError("Execution objective contract is immutable for a scope.");
		}
		return snapshot;
	}

	#validateGate(snapshot: MutableExecutionScopeSnapshot, gate: AcceptanceGate): void {
		if (gate.status !== "unknown" && gate.status !== "pass" && gate.status !== "fail" && gate.status !== "blocked") {
			throw new ExecutionLedgerError(`Acceptance gate ${gate.gateId} has an unknown status.`);
		}
		if (gate.contractRevision !== gate.contractRef.revision) {
			throw new ExecutionLedgerError(`Acceptance gate ${gate.gateId} has mismatched contract revision.`);
		}
		const contract = scopeContractRef(snapshot);
		if (contract && !objectiveRefsEqual(contract, gate.contractRef)) {
			throw new ImmutableObjectiveContractError(
				`Acceptance gate ${gate.gateId} is bound to a different objective contract.`,
			);
		}
		for (const evidence of gate.evidenceRefs) {
			if (evidence.gateId !== gate.gateId || evidence.contractRevision !== gate.contractRevision) {
				throw new ExecutionLedgerError(`Evidence ${evidence.evidenceId} is not bound to gate ${gate.gateId}.`);
			}
		}
	}

	#validateEvidence(snapshot: MutableExecutionScopeSnapshot, evidence: EvidenceRef): void {
		if (!evidence.gateId) return;
		const gate = getById(snapshot.gates, "gateId", evidence.gateId);
		if (!gate) return;
		if (evidence.contractRevision !== gate.contractRevision) {
			throw new ExecutionLedgerError(
				`Evidence ${evidence.evidenceId} has a stale contract revision for gate ${gate.gateId}.`,
			);
		}
	}

	#validateNestedScope(scopeId: string): void {
		if (scopeId !== this.scopeId)
			throw new ExecutionLedgerError(`Nested execution fact belongs to scope ${scopeId}, not ${this.scopeId}.`);
	}

	#upsertGate(gates: readonly AcceptanceGate[], gate: AcceptanceGate): readonly AcceptanceGate[] {
		const existing = getById(gates, "gateId", gate.gateId);
		if (!existing) return [...gates, cloneFrozen(gate)];
		if (
			existing.contractRevision !== gate.contractRevision ||
			!objectiveRefsEqual(existing.contractRef, gate.contractRef)
		) {
			throw new ImmutableObjectiveContractError(`Acceptance gate ${gate.gateId} cannot change contract binding.`);
		}
		if (existing.status === "pass" && gate.status !== "pass") {
			throw new ExecutionLedgerError(`Acceptance gate ${gate.gateId} cannot regress after passing.`);
		}
		return updateById(gates, "gateId", cloneFrozen(gate));
	}

	#upsertEvidence(evidenceRefs: readonly EvidenceRef[], evidence: EvidenceRef): readonly EvidenceRef[] {
		const existing = getById(evidenceRefs, "evidenceId", evidence.evidenceId);
		if (existing && !sameValue(existing, evidence))
			throw new ExecutionLedgerError(`Evidence ${evidence.evidenceId} cannot change.`);
		if (existing) return evidenceRefs;
		return [...evidenceRefs, cloneFrozen(evidence)];
	}

	#upsertAssignment(
		assignments: readonly ExecutionAssignment[],
		assignment: ExecutionAssignment,
	): readonly ExecutionAssignment[] {
		const existing = getById(assignments, "assignmentId", assignment.assignmentId);
		if (
			existing &&
			(existing.scopeId !== assignment.scopeId ||
				existing.workKey !== assignment.workKey ||
				existing.strategyKey !== assignment.strategyKey ||
				existing.strategyRevision !== assignment.strategyRevision ||
				!sameValue(existing.objectiveClauseRefs, assignment.objectiveClauseRefs))
		) {
			throw new ExecutionLedgerError(`Assignment ${assignment.assignmentId} identity cannot change.`);
		}
		return updateById(assignments, "assignmentId", cloneFrozen(assignment));
	}

	#upsertStrategy(
		strategies: readonly ExecutionStrategy[],
		strategy: ExecutionStrategy,
	): readonly ExecutionStrategy[] {
		const existing = getById(strategies, "strategyId", strategy.strategyId);
		if (
			existing &&
			(existing.strategyKey !== strategy.strategyKey ||
				existing.revision !== strategy.revision ||
				existing.hypothesisRef !== strategy.hypothesisRef ||
				existing.independenceKey !== strategy.independenceKey ||
				!sameValue(existing.expectedEvidenceRefs, strategy.expectedEvidenceRefs))
		) {
			throw new ExecutionLedgerError(`Strategy ${strategy.strategyId} identity cannot change.`);
		}
		return updateById(strategies, "strategyId", cloneFrozen(strategy));
	}

	#upsertProviderHealth(
		healthRefs: readonly ProviderHealthRef[],
		health: ProviderHealthRef,
	): readonly ProviderHealthRef[] {
		const route = `${health.providerKey}\u0000${health.normalizedUrl}\u0000${health.modelKey ?? ""}`;
		const existing = healthRefs.find(
			candidate =>
				`${candidate.providerKey}\u0000${candidate.normalizedUrl}\u0000${candidate.modelKey ?? ""}` === route,
		);
		if (existing && health.healthRevision < existing.healthRevision) {
			throw new ExecutionLedgerError(`Provider health revision for ${route} is stale.`);
		}
		if (existing && health.healthRevision === existing.healthRevision) {
			if (!sameValue(existing, health)) {
				throw new ExecutionLedgerError(`Provider health revision for ${route} cannot change.`);
			}
			return healthRefs;
		}
		if (!existing) return [...healthRefs, cloneFrozen(health)];
		return healthRefs.map(candidate =>
			`${candidate.providerKey}\u0000${candidate.normalizedUrl}\u0000${candidate.modelKey ?? ""}` === route
				? cloneFrozen(health)
				: candidate,
		);
	}

	#upsertDecision(
		decisions: readonly SupervisorDecisionRef[],
		decision: SupervisorDecisionRef,
	): readonly SupervisorDecisionRef[] {
		const existing = getById(decisions, "decisionId", decision.decisionId);
		if (existing && !sameValue(existing, decision))
			throw new ExecutionLedgerError(`Supervisor decision ${decision.decisionId} cannot change.`);
		if (existing) return decisions;
		return [...decisions, cloneFrozen(decision)];
	}

	#startRequest(
		requests: readonly ExecutionRequestFact[],
		requestId: string,
		interrupted: boolean,
		startedAt: string,
	): readonly ExecutionRequestFact[] {
		const existing = getById(requests, "requestId", requestId);
		if (!existing) return [...requests, { requestId, status: "started", startedAt, interrupted }];
		if (existing.status !== "started" && !interrupted) {
			throw new ExecutionLedgerError(`Request ${requestId} was already finished.`);
		}
		return updateById(requests, "requestId", {
			...existing,
			interrupted: existing.interrupted || interrupted,
		});
	}

	#finishRequest(
		requests: readonly ExecutionRequestFact[],
		requestId: string,
		status: "completed" | "failed" | "interrupted",
		finishedAt: string,
	): readonly ExecutionRequestFact[] {
		const existing = getById(requests, "requestId", requestId);
		if (!existing)
			return [
				...requests,
				{ requestId, status, startedAt: finishedAt, finishedAt, interrupted: status === "interrupted" },
			];
		if (existing.status !== "started") {
			if (existing.status === status) return requests;
			throw new ExecutionLedgerError(`Request ${requestId} cannot change after finishing.`);
		}
		return updateById(requests, "requestId", {
			...existing,
			status,
			finishedAt,
			interrupted: existing.interrupted || status === "interrupted",
		});
	}

	#upsertProgress(
		progress: readonly ProgressObservation[],
		observation: ProgressObservation,
	): readonly ProgressObservation[] {
		const existing = getById(progress, "observationId", observation.observationId);
		if (existing && !sameValue(existing, observation))
			throw new ExecutionLedgerError(`Progress observation ${observation.observationId} cannot change.`);
		if (existing) return progress;
		return [...progress, cloneFrozen(observation)];
	}
}

export function isTerminalExecutionState(state: ExecutionScopeState): boolean {
	return isTerminalState(state);
}
