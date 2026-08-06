import type { SessionEntry } from "../session/session-entries";
import { ExecutionLedger } from "./execution-ledger";
import { normalizeProviderBaseUrl } from "./provider-health";
import type {
	AcceptanceGate,
	AcceptanceVerifier,
	EvidenceRef,
	EvidenceVerifierKind,
	ExecutionAssignment,
	ExecutionLedgerRecord,
	ExecutionRequestFact,
	ExecutionScopeSnapshot,
	ExecutionScopeState,
	ExecutionStrategy,
	ImmutableObjectiveContract,
	ProgressObservation,
	ProviderHealthRef,
	SupervisorDecisionRef,
	SupervisorExternalBlocker,
	UsageTelemetry,
} from "./types";
import { EXECUTION_SCOPE_CUSTOM_TYPE, EXECUTION_SCOPE_SCHEMA_VERSION, emptyUsageTelemetry } from "./types";

/** Session-manager subset used by the execution-scope journal. */
export interface ExecutionScopeSessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries?(): readonly SessionEntry[];
}

export interface ExecutionScopeEventJournalRecord {
	readonly schemaVersion: typeof EXECUTION_SCOPE_SCHEMA_VERSION;
	readonly journalType: "event";
	readonly record: ExecutionLedgerRecord;
}

export interface ExecutionScopeSnapshotJournalRecord {
	readonly schemaVersion: typeof EXECUTION_SCOPE_SCHEMA_VERSION;
	readonly journalType: "snapshot";
	readonly snapshotId: string;
	readonly coveredRevision: number;
	readonly snapshot: ExecutionScopeSnapshot;
}

export type ExecutionScopeJournalRecord = ExecutionScopeEventJournalRecord | ExecutionScopeSnapshotJournalRecord;

export type ParsedExecutionScopeJournalRecord = ExecutionScopeJournalRecord & { readonly entryId?: string };

export interface RebuildExecutionScopeOptions {
	readonly scopeId?: string;
	readonly initialSnapshot?: ExecutionScopeSnapshot;
	readonly now?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
	return isNumber(value) && Number.isInteger(value);
}

function isExecutionScopeState(value: unknown): value is ExecutionScopeState {
	return (
		value === "running" ||
		value === "suspected_stall" ||
		value === "diagnosing" ||
		value === "recovering" ||
		value === "waiting_for_provider" ||
		value === "waiting_for_external_resource" ||
		value === "needs_user" ||
		value === "completed" ||
		value === "aborted_by_user" ||
		value === "runtime_fault"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value);
}

function sanitizeObjectiveContract(contract: ImmutableObjectiveContract): ImmutableObjectiveContract {
	return {
		ref: {
			contractId: contract.ref.contractId,
			revision: contract.ref.revision,
			contractHash: contract.ref.contractHash,
			clauseRefs: [...contract.ref.clauseRefs],
		},
		authoritativeUserTurnId: contract.authoritativeUserTurnId,
		source: "authoritative_user",
	};
}

function sanitizeVerifier(verifier: AcceptanceVerifier): AcceptanceVerifier {
	switch (verifier.kind) {
		case "command":
			return { kind: "command", checkId: verifier.checkId, expectedExitCode: verifier.expectedExitCode };
		case "browser":
			return { kind: "browser", scenarioId: verifier.scenarioId, assertionIds: [...verifier.assertionIds] };
		case "api":
			return { kind: "api", requestId: verifier.requestId, assertionIds: [...verifier.assertionIds] };
		case "artifact":
			return { kind: "artifact", artifactKind: verifier.artifactKind, schemaId: verifier.schemaId };
		case "review":
			return {
				kind: "review",
				rubricId: verifier.rubricId,
				requiredEvidenceKinds: [...verifier.requiredEvidenceKinds],
			};
		case "external":
			return { kind: "external", dependencyId: verifier.dependencyId };
	}
}

function sanitizeEvidence(evidence: EvidenceRef): EvidenceRef {
	return {
		evidenceId: evidence.evidenceId,
		kind: evidence.kind,
		receiptRef: evidence.receiptRef,
		...(evidence.receiptId === undefined ? {} : { receiptId: evidence.receiptId }),
		...(evidence.gateId === undefined ? {} : { gateId: evidence.gateId }),
		...(evidence.contractRevision === undefined ? {} : { contractRevision: evidence.contractRevision }),
		...(evidence.assignmentId === undefined ? {} : { assignmentId: evidence.assignmentId }),
		...(evidence.strategyKey === undefined ? {} : { strategyKey: evidence.strategyKey }),
		...(evidence.freshnessRevision === undefined ? {} : { freshnessRevision: evidence.freshnessRevision }),
	};
}

function sanitizeGate(gate: AcceptanceGate): AcceptanceGate {
	return {
		gateId: gate.gateId,
		contractRef: {
			contractId: gate.contractRef.contractId,
			revision: gate.contractRef.revision,
			contractHash: gate.contractRef.contractHash,
			clauseRefs: [...gate.contractRef.clauseRefs],
		},
		contractRevision: gate.contractRevision,
		...(gate.contractHash === undefined ? {} : { contractHash: gate.contractHash }),
		objectiveClauseRefs: [...gate.objectiveClauseRefs],
		verifier: sanitizeVerifier(gate.verifier),
		status: gate.status,
		evidenceRefs: gate.evidenceRefs.map(sanitizeEvidence),
		...(gate.assignmentId === undefined ? {} : { assignmentId: gate.assignmentId }),
		...(gate.freshnessRevision === undefined ? {} : { freshnessRevision: gate.freshnessRevision }),
		...(gate.required === undefined ? {} : { required: gate.required }),
	};
}

function sanitizeAssignment(assignment: ExecutionAssignment): ExecutionAssignment {
	return {
		assignmentId: assignment.assignmentId,
		scopeId: assignment.scopeId,
		workKey: assignment.workKey,
		strategyKey: assignment.strategyKey,
		strategyRevision: assignment.strategyRevision,
		objectiveClauseRefs: [...assignment.objectiveClauseRefs],
		status: assignment.status,
	};
}

function sanitizeStrategy(strategy: ExecutionStrategy): ExecutionStrategy {
	return {
		strategyId: strategy.strategyId,
		scopeId: strategy.scopeId,
		strategyKey: strategy.strategyKey,
		revision: strategy.revision,
		hypothesisRef: strategy.hypothesisRef,
		expectedEvidenceRefs: [...strategy.expectedEvidenceRefs],
		...(strategy.independenceKey === undefined ? {} : { independenceKey: strategy.independenceKey }),
		status: strategy.status,
	};
}

function sanitizeHealth(health: ProviderHealthRef): ProviderHealthRef {
	return {
		providerKey: health.providerKey,
		endpoint: normalizeProviderBaseUrl(health.endpoint),
		normalizedUrl: normalizeProviderBaseUrl(health.normalizedUrl),
		...(health.modelKey === undefined ? {} : { modelKey: health.modelKey }),
		state: health.state,
		healthRevision: health.healthRevision,
		generation: health.generation,
		...(health.terminalReceiptRef === undefined ? {} : { terminalReceiptRef: health.terminalReceiptRef }),
	};
}

function sanitizeDecision(decision: SupervisorDecisionRef): SupervisorDecisionRef {
	return {
		decisionId: decision.decisionId,
		scopeId: decision.scopeId,
		basisRevision: decision.basisRevision,
		basisHash: decision.basisHash,
		action: decision.action,
		evidenceRefs: [...decision.evidenceRefs],
		invalidatedHypothesisRefs: [...decision.invalidatedHypothesisRefs],
		confidence: decision.confidence,
		createdAt: decision.createdAt,
		...(decision.externalBlocker === undefined
			? {}
			: {
					externalBlocker: {
						kind: "external",
						dependencyId: decision.externalBlocker.dependencyId,
						evidenceRef: decision.externalBlocker.evidenceRef,
					},
				}),
	};
}

function sanitizeRequest(request: ExecutionRequestFact): ExecutionRequestFact {
	return {
		requestId: request.requestId,
		status: request.status,
		startedAt: request.startedAt,
		...(request.finishedAt === undefined ? {} : { finishedAt: request.finishedAt }),
		interrupted: request.interrupted,
	};
}

function sanitizeProgress(observation: ProgressObservation): ProgressObservation {
	return {
		observationId: observation.observationId,
		progressClass: observation.progressClass,
		fingerprint: observation.fingerprint,
		revision: observation.revision,
		...(observation.strategyKey === undefined ? {} : { strategyKey: observation.strategyKey }),
		...(observation.failureFingerprint === undefined ? {} : { failureFingerprint: observation.failureFingerprint }),
		...(observation.cursor === undefined ? {} : { cursor: observation.cursor }),
	};
}

function sanitizeRecord(record: ExecutionLedgerRecord): ExecutionLedgerRecord {
	const base = {
		recordId: record.recordId,
		scopeId: record.scopeId,
		rootSessionId: record.rootSessionId,
		logicalTurnId: record.logicalTurnId,
		revision: record.revision,
		occurredAt: record.occurredAt,
		...(record.objectiveContract ? { objectiveContract: sanitizeObjectiveContract(record.objectiveContract) } : {}),
	};
	switch (record.type) {
		case "scope_started":
			return {
				...base,
				type: "scope_started",
				...(record.objectiveContract
					? { objectiveContract: sanitizeObjectiveContract(record.objectiveContract) }
					: {}),
			};
		case "objective_contract_bound":
			return {
				...base,
				type: "objective_contract_bound",
				objectiveContract: sanitizeObjectiveContract(record.objectiveContract),
			};
		case "state_changed":
			return { ...base, type: "state_changed", state: record.state };
		case "acceptance_gate_recorded":
			return { ...base, type: "acceptance_gate_recorded", gate: sanitizeGate(record.gate) };
		case "evidence_recorded":
			return { ...base, type: "evidence_recorded", evidence: sanitizeEvidence(record.evidence) };
		case "assignment_recorded":
			return { ...base, type: "assignment_recorded", assignment: sanitizeAssignment(record.assignment) };
		case "strategy_recorded":
			return { ...base, type: "strategy_recorded", strategy: sanitizeStrategy(record.strategy) };
		case "usage_recorded":
			return {
				...base,
				type: "usage_recorded",
				delta: {
					...(record.delta.inputTokens === undefined ? {} : { inputTokens: record.delta.inputTokens }),
					...(record.delta.outputTokens === undefined ? {} : { outputTokens: record.delta.outputTokens }),
					...(record.delta.cacheReadTokens === undefined ? {} : { cacheReadTokens: record.delta.cacheReadTokens }),
					...(record.delta.cacheWriteTokens === undefined
						? {}
						: { cacheWriteTokens: record.delta.cacheWriteTokens }),
					...(record.delta.totalTokens === undefined ? {} : { totalTokens: record.delta.totalTokens }),
					...(record.delta.cost === undefined ? {} : { cost: record.delta.cost }),
					...(record.delta.durationMs === undefined ? {} : { durationMs: record.delta.durationMs }),
					...(record.delta.providerRequests === undefined
						? {}
						: { providerRequests: record.delta.providerRequests }),
					...(record.delta.assignmentCount === undefined ? {} : { assignmentCount: record.delta.assignmentCount }),
				},
			};
		case "provider_health_recorded":
			return { ...base, type: "provider_health_recorded", health: sanitizeHealth(record.health) };
		case "supervisor_decision_recorded":
			return { ...base, type: "supervisor_decision_recorded", decision: sanitizeDecision(record.decision) };
		case "request_started":
			return {
				...base,
				type: "request_started",
				requestId: record.requestId,
				...(record.interrupted ? { interrupted: true } : {}),
			};
		case "request_finished":
			return { ...base, type: "request_finished", requestId: record.requestId, status: record.status };
		case "progress_observed":
			return { ...base, type: "progress_observed", observation: sanitizeProgress(record.observation) };
	}
}

function sanitizeUsage(usage: UsageTelemetry): UsageTelemetry {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		totalTokens: usage.totalTokens,
		cost: usage.cost,
		durationMs: usage.durationMs,
		providerRequests: usage.providerRequests,
		assignmentCount: usage.assignmentCount,
		...(usage.updatedAt === undefined ? {} : { updatedAt: usage.updatedAt }),
	};
}

function sanitizeSnapshot(snapshot: ExecutionScopeSnapshot): ExecutionScopeSnapshot {
	return {
		schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
		scopeId: snapshot.scopeId,
		rootSessionId: snapshot.rootSessionId,
		logicalTurnId: snapshot.logicalTurnId,
		revision: snapshot.revision,
		state: snapshot.state,
		...(snapshot.objectiveContract
			? { objectiveContract: sanitizeObjectiveContract(snapshot.objectiveContract) }
			: {}),
		gates: snapshot.gates.map(sanitizeGate),
		evidenceRefs: snapshot.evidenceRefs.map(sanitizeEvidence),
		assignments: snapshot.assignments.map(sanitizeAssignment),
		strategies: snapshot.strategies.map(sanitizeStrategy),
		usage: sanitizeUsage(snapshot.usage),
		providerHealth: snapshot.providerHealth.map(sanitizeHealth),
		supervisorDecisions: snapshot.supervisorDecisions.map(sanitizeDecision),
		requests: snapshot.requests.map(sanitizeRequest),
		progress: snapshot.progress.map(sanitizeProgress),
		recordIds: [...snapshot.recordIds],
		updatedAt: snapshot.updatedAt,
	};
}

export function serializeExecutionScopeRecord(record: ExecutionLedgerRecord): ExecutionScopeEventJournalRecord {
	return {
		schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
		journalType: "event",
		record: sanitizeRecord(record),
	};
}

export function serializeExecutionScopeSnapshot(
	snapshot: ExecutionScopeSnapshot,
	snapshotId = `snapshot:${snapshot.scopeId}:${snapshot.revision}`,
): ExecutionScopeSnapshotJournalRecord {
	return {
		schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
		journalType: "snapshot",
		snapshotId,
		coveredRevision: snapshot.revision,
		snapshot: sanitizeSnapshot(snapshot),
	};
}

export function serializeExecutionScopeJournalRecord(record: ExecutionScopeJournalRecord): ExecutionScopeJournalRecord {
	return record.journalType === "event"
		? serializeExecutionScopeRecord(record.record)
		: serializeExecutionScopeSnapshot(record.snapshot, record.snapshotId);
}

export function appendExecutionScopeRecord(
	sessionManager: ExecutionScopeSessionManager,
	record: ExecutionLedgerRecord,
): string {
	return sessionManager.appendCustomEntry(EXECUTION_SCOPE_CUSTOM_TYPE, serializeExecutionScopeRecord(record));
}

export function appendExecutionScopeSnapshot(
	sessionManager: ExecutionScopeSessionManager,
	snapshot: ExecutionScopeSnapshot,
	snapshotId?: string,
): string {
	return sessionManager.appendCustomEntry(
		EXECUTION_SCOPE_CUSTOM_TYPE,
		serializeExecutionScopeSnapshot(snapshot, snapshotId),
	);
}

function parseObjectiveContract(value: unknown): ImmutableObjectiveContract | undefined {
	if (!isRecord(value) || value.source !== "authoritative_user" || !isString(value.authoritativeUserTurnId))
		return undefined;
	if (
		!isRecord(value.ref) ||
		!isString(value.ref.contractId) ||
		!isInteger(value.ref.revision) ||
		!isString(value.ref.contractHash)
	)
		return undefined;
	if (!Array.isArray(value.ref.clauseRefs) || !value.ref.clauseRefs.every(isString)) return undefined;
	return {
		ref: {
			contractId: value.ref.contractId,
			revision: value.ref.revision,
			contractHash: value.ref.contractHash,
			clauseRefs: [...value.ref.clauseRefs],
		},
		authoritativeUserTurnId: value.authoritativeUserTurnId,
		source: "authoritative_user",
	};
}

function parseEvidence(value: unknown): EvidenceRef | undefined {
	if (!isRecord(value) || !isString(value.evidenceId) || !isString(value.kind) || !isString(value.receiptRef))
		return undefined;
	if (!["command", "browser", "api", "artifact", "review", "external"].includes(value.kind)) return undefined;
	return {
		evidenceId: value.evidenceId,
		kind: value.kind as EvidenceRef["kind"],
		receiptRef: value.receiptRef,
		...(isString(value.receiptId) ? { receiptId: value.receiptId } : {}),
		...(isString(value.gateId) ? { gateId: value.gateId } : {}),
		...(isInteger(value.contractRevision) ? { contractRevision: value.contractRevision } : {}),
		...(isString(value.assignmentId) ? { assignmentId: value.assignmentId } : {}),
		...(isString(value.strategyKey) ? { strategyKey: value.strategyKey } : {}),
		...(isInteger(value.freshnessRevision) ? { freshnessRevision: value.freshnessRevision } : {}),
	};
}

function parseVerifier(value: unknown): AcceptanceVerifier | undefined {
	if (!isRecord(value) || !isString(value.kind)) return undefined;
	switch (value.kind) {
		case "command":
			if (!isString(value.checkId) || !isNumber(value.expectedExitCode)) return undefined;
			return { kind: "command", checkId: value.checkId, expectedExitCode: value.expectedExitCode };
		case "browser":
			if (!isString(value.scenarioId) || !Array.isArray(value.assertionIds) || !value.assertionIds.every(isString))
				return undefined;
			return { kind: "browser", scenarioId: value.scenarioId, assertionIds: [...value.assertionIds] };
		case "api":
			if (!isString(value.requestId) || !Array.isArray(value.assertionIds) || !value.assertionIds.every(isString))
				return undefined;
			return { kind: "api", requestId: value.requestId, assertionIds: [...value.assertionIds] };
		case "artifact":
			if (!isString(value.artifactKind) || !isString(value.schemaId)) return undefined;
			return { kind: "artifact", artifactKind: value.artifactKind, schemaId: value.schemaId };
		case "review":
			if (
				!isString(value.rubricId) ||
				!Array.isArray(value.requiredEvidenceKinds) ||
				!value.requiredEvidenceKinds.every(item =>
					["command", "browser", "api", "artifact", "review", "external"].includes(String(item)),
				)
			)
				return undefined;
			return {
				kind: "review",
				rubricId: value.rubricId,
				requiredEvidenceKinds: [...value.requiredEvidenceKinds] as EvidenceVerifierKind[],
			};
		case "external":
			if (!isString(value.dependencyId)) return undefined;
			return { kind: "external", dependencyId: value.dependencyId };
		default:
			return undefined;
	}
}

function parseGate(value: unknown): AcceptanceGate | undefined {
	if (!isRecord(value) || !isString(value.gateId) || !isInteger(value.contractRevision)) return undefined;
	const contract = parseObjectiveContract({
		source: "authoritative_user",
		authoritativeUserTurnId: "gate",
		ref: value.contractRef,
	});
	const verifier = parseVerifier(value.verifier);
	if (
		!contract ||
		!verifier ||
		!Array.isArray(value.objectiveClauseRefs) ||
		!value.objectiveClauseRefs.every(isString)
	)
		return undefined;
	if (!Array.isArray(value.evidenceRefs)) return undefined;
	const evidenceRefs = value.evidenceRefs.map(parseEvidence);
	if (evidenceRefs.some(item => item === undefined)) return undefined;
	let status: AcceptanceGate["status"];
	switch (value.status) {
		case "unknown":
		case "pending":
			status = "unknown";
			break;
		case "pass":
		case "passed":
			status = "pass";
			break;
		case "fail":
		case "failed":
			status = "fail";
			break;
		case "blocked":
			status = "blocked";
			break;
		default:
			return undefined;
	}
	return {
		gateId: value.gateId,
		contractRef: contract.ref,
		contractRevision: value.contractRevision,
		objectiveClauseRefs: [...value.objectiveClauseRefs],
		verifier,
		status,
		...(isString(value.contractHash) ? { contractHash: value.contractHash } : {}),
		...(isString(value.assignmentId) ? { assignmentId: value.assignmentId } : {}),
		...(isInteger(value.freshnessRevision) ? { freshnessRevision: value.freshnessRevision } : {}),
		...(typeof value.required === "boolean" ? { required: value.required } : {}),
		evidenceRefs: evidenceRefs as EvidenceRef[],
	};
}

function parseAssignment(value: unknown): ExecutionAssignment | undefined {
	if (
		!isRecord(value) ||
		!isString(value.assignmentId) ||
		!isString(value.scopeId) ||
		!isString(value.workKey) ||
		!isString(value.strategyKey) ||
		!isInteger(value.strategyRevision) ||
		!Array.isArray(value.objectiveClauseRefs) ||
		!value.objectiveClauseRefs.every(isString) ||
		!["pending", "running", "completed", "blocked", "failed", "parked"].includes(String(value.status))
	)
		return undefined;
	return {
		assignmentId: value.assignmentId,
		scopeId: value.scopeId,
		workKey: value.workKey,
		strategyKey: value.strategyKey,
		strategyRevision: value.strategyRevision,
		objectiveClauseRefs: [...value.objectiveClauseRefs],
		status: value.status as ExecutionAssignment["status"],
	};
}

function parseStrategy(value: unknown): ExecutionStrategy | undefined {
	if (
		!isRecord(value) ||
		!isString(value.strategyId) ||
		!isString(value.scopeId) ||
		!isString(value.strategyKey) ||
		!isInteger(value.revision) ||
		!isString(value.hypothesisRef) ||
		!Array.isArray(value.expectedEvidenceRefs) ||
		!value.expectedEvidenceRefs.every(isString) ||
		(value.independenceKey !== undefined && !isString(value.independenceKey)) ||
		!["proposed", "active", "retired", "rejected"].includes(String(value.status))
	)
		return undefined;
	return {
		strategyId: value.strategyId,
		scopeId: value.scopeId,
		strategyKey: value.strategyKey,
		revision: value.revision,
		hypothesisRef: value.hypothesisRef,
		expectedEvidenceRefs: [...value.expectedEvidenceRefs],
		...(isString(value.independenceKey) ? { independenceKey: value.independenceKey } : {}),
		status: value.status as ExecutionStrategy["status"],
	};
}

function parseHealth(value: unknown): ProviderHealthRef | undefined {
	if (
		!isRecord(value) ||
		!isString(value.providerKey) ||
		!isString(value.endpoint) ||
		!isString(value.normalizedUrl) ||
		(value.modelKey !== undefined && !isString(value.modelKey)) ||
		!isString(value.state) ||
		!["closed", "open", "half_open"].includes(value.state) ||
		!isInteger(value.healthRevision) ||
		!isInteger(value.generation)
	)
		return undefined;
	return {
		providerKey: value.providerKey,
		endpoint: value.endpoint,
		normalizedUrl: value.normalizedUrl,
		...(isString(value.modelKey) ? { modelKey: value.modelKey } : {}),
		state: value.state as ProviderHealthRef["state"],
		healthRevision: value.healthRevision,
		generation: value.generation,
		...(isString(value.terminalReceiptRef) ? { terminalReceiptRef: value.terminalReceiptRef } : {}),
	};
}

function parseDecision(value: unknown): SupervisorDecisionRef | undefined {
	if (
		!isRecord(value) ||
		!isString(value.decisionId) ||
		!isString(value.scopeId) ||
		!isInteger(value.basisRevision) ||
		!isString(value.basisHash) ||
		!isString(value.action) ||
		!["continue", "replan", "reassign", "switch_route", "park", "needs_user", "abstain"].includes(value.action) ||
		!Array.isArray(value.evidenceRefs) ||
		!value.evidenceRefs.every(isString) ||
		!Array.isArray(value.invalidatedHypothesisRefs) ||
		!value.invalidatedHypothesisRefs.every(isString) ||
		!isString(value.confidence) ||
		!["low", "medium", "high"].includes(value.confidence) ||
		!isString(value.createdAt)
	)
		return undefined;
	const externalBlocker = value.externalBlocker;
	let parsedExternalBlocker: SupervisorExternalBlocker | undefined;
	if (externalBlocker !== undefined) {
		if (
			!isRecord(externalBlocker) ||
			externalBlocker.kind !== "external" ||
			!isString(externalBlocker.dependencyId) ||
			!isString(externalBlocker.evidenceRef)
		)
			return undefined;
		parsedExternalBlocker = {
			kind: "external",
			dependencyId: externalBlocker.dependencyId,
			evidenceRef: externalBlocker.evidenceRef,
		};
	}
	return {
		decisionId: value.decisionId,
		scopeId: value.scopeId,
		basisRevision: value.basisRevision,
		basisHash: value.basisHash,
		action: value.action as SupervisorDecisionRef["action"],
		evidenceRefs: [...value.evidenceRefs],
		invalidatedHypothesisRefs: [...value.invalidatedHypothesisRefs],
		confidence: value.confidence as SupervisorDecisionRef["confidence"],
		createdAt: value.createdAt,
		...(parsedExternalBlocker === undefined ? {} : { externalBlocker: parsedExternalBlocker }),
	};
}

function parseProgress(value: unknown): ProgressObservation | undefined {
	if (
		!isRecord(value) ||
		!isString(value.observationId) ||
		!isString(value.progressClass) ||
		!isString(value.fingerprint) ||
		!isInteger(value.revision)
	)
		return undefined;
	if (!["activity", "progress", "regression", "blocker"].includes(value.progressClass)) return undefined;
	return {
		observationId: value.observationId,
		progressClass: value.progressClass as ProgressObservation["progressClass"],
		fingerprint: value.fingerprint,
		revision: value.revision,
		...(isString(value.strategyKey) ? { strategyKey: value.strategyKey } : {}),
		...(isString(value.failureFingerprint) ? { failureFingerprint: value.failureFingerprint } : {}),
		...(isString(value.cursor) ? { cursor: value.cursor } : {}),
	};
}

function parseRecord(value: unknown): ExecutionLedgerRecord | undefined {
	if (
		!isRecord(value) ||
		!isString(value.recordId) ||
		!isString(value.scopeId) ||
		!isString(value.rootSessionId) ||
		!isString(value.logicalTurnId) ||
		!isInteger(value.revision) ||
		value.revision < 1 ||
		!isString(value.occurredAt) ||
		!isString(value.type)
	)
		return undefined;
	const objectiveContract =
		value.objectiveContract === undefined ? undefined : parseObjectiveContract(value.objectiveContract);
	if (value.objectiveContract !== undefined && !objectiveContract) return undefined;
	const base = {
		recordId: value.recordId,
		scopeId: value.scopeId,
		rootSessionId: value.rootSessionId,
		logicalTurnId: value.logicalTurnId,
		revision: value.revision,
		occurredAt: value.occurredAt,
		...(objectiveContract ? { objectiveContract } : {}),
	};
	switch (value.type) {
		case "scope_started": {
			const objectiveContract =
				value.objectiveContract === undefined ? undefined : parseObjectiveContract(value.objectiveContract);
			if (value.objectiveContract !== undefined && !objectiveContract) return undefined;
			return { ...base, type: "scope_started", ...(objectiveContract ? { objectiveContract } : {}) };
		}
		case "objective_contract_bound": {
			const objectiveContract = parseObjectiveContract(value.objectiveContract);
			return objectiveContract ? { ...base, type: "objective_contract_bound", objectiveContract } : undefined;
		}
		case "state_changed":
			return isExecutionScopeState(value.state) ? { ...base, type: "state_changed", state: value.state } : undefined;
		case "acceptance_gate_recorded": {
			const gate = parseGate(value.gate);
			return gate ? { ...base, type: "acceptance_gate_recorded", gate } : undefined;
		}
		case "evidence_recorded": {
			const evidence = parseEvidence(value.evidence);
			return evidence ? { ...base, type: "evidence_recorded", evidence } : undefined;
		}
		case "assignment_recorded": {
			const assignment = parseAssignment(value.assignment);
			return assignment ? { ...base, type: "assignment_recorded", assignment } : undefined;
		}
		case "strategy_recorded": {
			const strategy = parseStrategy(value.strategy);
			return strategy ? { ...base, type: "strategy_recorded", strategy } : undefined;
		}
		case "usage_recorded": {
			const delta = value.delta;
			if (!isRecord(delta)) return undefined;
			const fields = [
				"inputTokens",
				"outputTokens",
				"cacheReadTokens",
				"cacheWriteTokens",
				"totalTokens",
				"cost",
				"durationMs",
				"providerRequests",
				"assignmentCount",
			];
			if (!fields.every(field => delta[field] === undefined || isNumber(delta[field]))) return undefined;
			return { ...base, type: "usage_recorded", delta } as ExecutionLedgerRecord;
		}
		case "provider_health_recorded": {
			const health = parseHealth(value.health);
			return health ? { ...base, type: "provider_health_recorded", health } : undefined;
		}
		case "supervisor_decision_recorded": {
			const decision = parseDecision(value.decision);
			return decision ? { ...base, type: "supervisor_decision_recorded", decision } : undefined;
		}
		case "request_started":
			return isString(value.requestId)
				? {
						...base,
						type: "request_started",
						requestId: value.requestId,
						...(value.interrupted === true ? { interrupted: true } : {}),
					}
				: undefined;
		case "request_finished":
			return isString(value.requestId) &&
				(value.status === "completed" || value.status === "failed" || value.status === "interrupted")
				? { ...base, type: "request_finished", requestId: value.requestId, status: value.status }
				: undefined;
		case "progress_observed": {
			const observation = parseProgress(value.observation);
			return observation ? { ...base, type: "progress_observed", observation } : undefined;
		}
		default:
			return undefined;
	}
}

function parseSnapshot(value: unknown): ExecutionScopeSnapshot | undefined {
	if (
		!isRecord(value) ||
		!isString(value.scopeId) ||
		!isString(value.rootSessionId) ||
		!isString(value.logicalTurnId) ||
		!isInteger(value.revision) ||
		value.revision < 0 ||
		!isExecutionScopeState(value.state)
	)
		return undefined;
	const objectiveContract =
		value.objectiveContract === undefined ? undefined : parseObjectiveContract(value.objectiveContract);
	if (value.objectiveContract !== undefined && !objectiveContract) return undefined;
	const gates = Array.isArray(value.gates) ? value.gates.map(parseGate) : [];
	const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(parseEvidence) : [];
	const assignments = Array.isArray(value.assignments) ? value.assignments.map(parseAssignment) : [];
	const strategies = Array.isArray(value.strategies) ? value.strategies.map(parseStrategy) : [];
	const providerHealth = Array.isArray(value.providerHealth) ? value.providerHealth.map(parseHealth) : [];
	const supervisorDecisions = Array.isArray(value.supervisorDecisions)
		? value.supervisorDecisions.map(parseDecision)
		: [];
	const progress = Array.isArray(value.progress) ? value.progress.map(parseProgress) : [];
	if (
		[
			...gates,
			...evidenceRefs,
			...assignments,
			...strategies,
			...providerHealth,
			...supervisorDecisions,
			...progress,
		].some(item => item === undefined)
	)
		return undefined;
	const usageValue = isRecord(value.usage) ? value.usage : {};
	const usage = {
		...emptyUsageTelemetry(),
		...Object.fromEntries(
			[
				"inputTokens",
				"outputTokens",
				"cacheReadTokens",
				"cacheWriteTokens",
				"totalTokens",
				"cost",
				"durationMs",
				"providerRequests",
				"assignmentCount",
			]
				.filter(field => isNumber(usageValue[field]))
				.map(field => [field, usageValue[field]]),
		),
		...(isString(usageValue.updatedAt) ? { updatedAt: usageValue.updatedAt } : {}),
	} as UsageTelemetry;
	return {
		schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
		scopeId: value.scopeId,
		rootSessionId: value.rootSessionId,
		logicalTurnId: value.logicalTurnId,
		revision: value.revision,
		state: value.state,
		...(objectiveContract ? { objectiveContract } : {}),
		gates: gates as AcceptanceGate[],
		evidenceRefs: evidenceRefs as EvidenceRef[],
		assignments: assignments as ExecutionAssignment[],
		strategies: strategies as ExecutionStrategy[],
		usage,
		providerHealth: providerHealth as ProviderHealthRef[],
		supervisorDecisions: supervisorDecisions as SupervisorDecisionRef[],
		requests: Array.isArray(value.requests)
			? value.requests.filter(isRecord).flatMap(item =>
					isString(item.requestId) &&
					isString(item.startedAt) &&
					(item.status === "started" ||
						item.status === "completed" ||
						item.status === "failed" ||
						item.status === "interrupted")
						? [
								{
									requestId: item.requestId,
									status: item.status,
									startedAt: item.startedAt,
									...(isString(item.finishedAt) ? { finishedAt: item.finishedAt } : {}),
									interrupted: item.interrupted === true,
								},
							]
						: [],
				)
			: [],
		progress: progress as ProgressObservation[],
		recordIds: Array.isArray(value.recordIds) ? value.recordIds.filter(isString) : [],
		updatedAt: isString(value.updatedAt) ? value.updatedAt : "",
	};
}

export function parseExecutionScopeJournalRecord(value: unknown): ExecutionScopeJournalRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== undefined && value.schemaVersion !== EXECUTION_SCOPE_SCHEMA_VERSION) return undefined;
	if (value.journalType === "event") {
		const record = parseRecord(value.record);
		return record ? { schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION, journalType: "event", record } : undefined;
	}
	if (value.journalType === "snapshot") {
		const snapshot = parseSnapshot(value.snapshot);
		if (
			!snapshot ||
			!isString(value.snapshotId) ||
			!isInteger(value.coveredRevision) ||
			value.coveredRevision !== snapshot.revision
		)
			return undefined;
		return {
			schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
			journalType: "snapshot",
			snapshotId: value.snapshotId,
			coveredRevision: value.coveredRevision,
			snapshot,
		};
	}
	// Early foundation builds wrote the event fields directly under custom data.
	const legacyRecord = parseRecord(value);
	return legacyRecord
		? { schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION, journalType: "event", record: legacyRecord }
		: undefined;
}

export function readExecutionScopeJournal(
	entries: readonly SessionEntry[],
): readonly ParsedExecutionScopeJournalRecord[] {
	const result: ParsedExecutionScopeJournalRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== EXECUTION_SCOPE_CUSTOM_TYPE) continue;
		const parsed = parseExecutionScopeJournalRecord(entry.data);
		if (parsed) result.push({ ...parsed, entryId: entry.id });
	}
	return result;
}

function scopeIdFromJournal(record: ParsedExecutionScopeJournalRecord): string {
	return record.journalType === "event" ? record.record.scopeId : record.snapshot.scopeId;
}

export function rebuildExecutionScopeLedger(
	entries: readonly SessionEntry[],
	options: RebuildExecutionScopeOptions = {},
): ExecutionLedger | undefined {
	const allJournal = readExecutionScopeJournal(entries);
	const requestedScopeId =
		options.scopeId ??
		options.initialSnapshot?.scopeId ??
		(allJournal[0] ? scopeIdFromJournal(allJournal[0]) : undefined);
	const journal = allJournal.filter(
		record => requestedScopeId === undefined || scopeIdFromJournal(record) === requestedScopeId,
	);
	if (journal.length === 0 && !options.initialSnapshot) return undefined;
	const snapshots = journal.filter(
		(record): record is ParsedExecutionScopeJournalRecord & ExecutionScopeSnapshotJournalRecord =>
			record.journalType === "snapshot",
	);
	const latestSnapshot = snapshots.reduce<ExecutionScopeSnapshotJournalRecord | undefined>(
		(latest, current) => (!latest || current.coveredRevision > latest.coveredRevision ? current : latest),
		undefined,
	);
	const events = journal.filter(
		(record): record is ParsedExecutionScopeJournalRecord & ExecutionScopeEventJournalRecord =>
			record.journalType === "event",
	);
	const first = events[0]?.record;
	const initialSnapshot = latestSnapshot?.snapshot ?? options.initialSnapshot;
	const ledger = new ExecutionLedger({
		initialSnapshot,
		scopeId: initialSnapshot?.scopeId ?? first?.scopeId,
		rootSessionId: initialSnapshot?.rootSessionId ?? first?.rootSessionId,
		logicalTurnId: initialSnapshot?.logicalTurnId ?? first?.logicalTurnId,
		now: options.now,
	});
	for (const event of events) {
		if (latestSnapshot && event.record.revision <= latestSnapshot.coveredRevision) continue;
		ledger.appendPersisted(event.record);
	}
	return ledger;
}

export function rebuildAllExecutionScopeLedgers(
	entries: readonly SessionEntry[],
	options: Omit<RebuildExecutionScopeOptions, "scopeId" | "initialSnapshot"> = {},
): ReadonlyMap<string, ExecutionLedger> {
	const scopeIds = new Set(readExecutionScopeJournal(entries).map(scopeIdFromJournal));
	const ledgers = new Map<string, ExecutionLedger>();
	for (const scopeId of scopeIds) {
		const ledger = rebuildExecutionScopeLedger(entries, { ...options, scopeId });
		if (ledger) ledgers.set(scopeId, ledger);
	}
	return ledgers;
}

export function replayExecutionScope(
	entries: readonly SessionEntry[],
	options: RebuildExecutionScopeOptions = {},
): ExecutionLedger | undefined {
	return rebuildExecutionScopeLedger(entries, options);
}

export function compactExecutionScopeJournal(
	journal: readonly ParsedExecutionScopeJournalRecord[],
	snapshot: ExecutionScopeSnapshot,
): readonly ExecutionScopeJournalRecord[] {
	let base = snapshot;
	let baseId = `snapshot:${snapshot.scopeId}:${snapshot.revision}`;
	for (const record of journal) {
		if (
			record.journalType === "snapshot" &&
			record.snapshot.scopeId === snapshot.scopeId &&
			record.coveredRevision > base.revision
		) {
			base = record.snapshot;
			baseId = record.snapshotId;
		}
	}
	const compacted: ExecutionScopeJournalRecord[] = [serializeExecutionScopeSnapshot(base, baseId)];
	for (const record of journal) {
		if (
			record.journalType === "event" &&
			record.record.scopeId === base.scopeId &&
			record.record.revision > base.revision
		) {
			compacted.push(serializeExecutionScopeRecord(record.record));
		}
	}
	return compacted;
}

export class ExecutionScopePersistence {
	readonly #sessionManager: ExecutionScopeSessionManager;

	constructor(sessionManager: ExecutionScopeSessionManager) {
		this.#sessionManager = sessionManager;
	}

	append(record: ExecutionLedgerRecord): string {
		return appendExecutionScopeRecord(this.#sessionManager, record);
	}

	appendSnapshot(snapshot: ExecutionScopeSnapshot, snapshotId?: string): string {
		return appendExecutionScopeSnapshot(this.#sessionManager, snapshot, snapshotId);
	}

	read(scopeId?: string): readonly ParsedExecutionScopeJournalRecord[] {
		const entries = this.#sessionManager.getEntries?.() ?? [];
		return readExecutionScopeJournal(entries).filter(
			record => scopeId === undefined || scopeIdFromJournal(record) === scopeId,
		);
	}

	replay(scopeId?: string, options: Omit<RebuildExecutionScopeOptions, "scopeId"> = {}): ExecutionLedger | undefined {
		const entries = this.#sessionManager.getEntries?.() ?? [];
		return rebuildExecutionScopeLedger(entries, { ...options, scopeId });
	}
}
