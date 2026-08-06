/**
 * Host-owned execution-control facts.
 *
 * These types deliberately contain references, hashes and bounded facts only. They
 * do not carry prompts, model output, credentials or tool output. The execution
 * ledger and its journal are therefore safe to replay independently of an LLM
 * context transcript.
 */

export const EXECUTION_SCOPE_SCHEMA_VERSION = 1 as const;
export const EXECUTION_SCOPE_CUSTOM_TYPE = "san.execution_scope" as const;

export type ExecutionScopeState =
	| "running"
	| "suspected_stall"
	| "diagnosing"
	| "recovering"
	| "waiting_for_provider"
	| "waiting_for_external_resource"
	| "needs_user"
	| "completed"
	| "aborted_by_user"
	| "runtime_fault";

export type ProgressClass = "activity" | "progress" | "regression" | "blocker";

export type EvidenceVerifierKind = "command" | "browser" | "api" | "artifact" | "review" | "external";

export type AcceptanceGateStatus = "unknown" | "pass" | "fail" | "blocked";

export type ExecutionAssignmentStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "parked";

export type ExecutionStrategyStatus = "proposed" | "active" | "retired" | "rejected";

export type ProviderHealthState = "closed" | "open" | "half_open";

export type SupervisorAction = "continue" | "replan" | "reassign" | "switch_route" | "park" | "needs_user" | "abstain";

export type SupervisorConfidence = "low" | "medium" | "high";

export interface SupervisorExternalBlocker {
	readonly kind: "external";
	readonly dependencyId: string;
	readonly evidenceRef: string;
}

export type ExecutionRequestStatus = "started" | "completed" | "failed" | "interrupted";

export interface ExecutionScopeIdentity {
	readonly scopeId: string;
	readonly rootSessionId: string;
	readonly logicalTurnId: string;
}

/** A reference to the immutable contract supplied by an authoritative user turn. */
export interface ObjectiveContractRef {
	readonly contractId: string;
	readonly revision: number;
	readonly contractHash: string;
	readonly clauseRefs: readonly string[];
}

/**
 * The only accepted source of a new objective contract. A summary or model
 * message can carry references to this value but cannot create or replace it.
 */
export interface ImmutableObjectiveContract {
	readonly ref: ObjectiveContractRef;
	readonly authoritativeUserTurnId: string;
	readonly source: "authoritative_user";
}

export interface CommandAcceptanceVerifier {
	readonly kind: "command";
	/** Stable check reference; command text is intentionally not persisted. */
	readonly checkId: string;
	readonly expectedExitCode: number;
}

export interface BrowserAcceptanceVerifier {
	readonly kind: "browser";
	readonly scenarioId: string;
	readonly assertionIds: readonly string[];
}

export interface ApiAcceptanceVerifier {
	readonly kind: "api";
	readonly requestId: string;
	readonly assertionIds: readonly string[];
}

export interface ArtifactAcceptanceVerifier {
	readonly kind: "artifact";
	readonly artifactKind: string;
	readonly schemaId: string;
}

export interface ReviewAcceptanceVerifier {
	readonly kind: "review";
	readonly rubricId: string;
	readonly requiredEvidenceKinds: readonly EvidenceVerifierKind[];
}

export interface ExternalAcceptanceVerifier {
	readonly kind: "external";
	readonly dependencyId: string;
}

export type AcceptanceVerifier =
	| CommandAcceptanceVerifier
	| BrowserAcceptanceVerifier
	| ApiAcceptanceVerifier
	| ArtifactAcceptanceVerifier
	| ReviewAcceptanceVerifier
	| ExternalAcceptanceVerifier;
export type EvidenceReceiptOutcome = "pass" | "fail" | "passed" | "failed";

/** Common host-owned binding carried by every receipt that can satisfy a gate. */
export interface EvidenceReceiptBase {
	readonly receiptId: string;
	readonly kind: EvidenceVerifierKind;
	readonly source: "host";
	readonly scopeId: string;
	readonly gateId: string;
	readonly contractRevision: number;
	readonly contractHash: string;
	readonly assignmentId?: string;
	readonly freshnessRevision: number;
	readonly outcome: EvidenceReceiptOutcome;
	/** Host observation time; no command output, response body or secret is retained. */
	readonly timestamp: string;
}

export interface CommandEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "command";
	readonly checkId: string;
	readonly exitCode: number;
}

export interface BrowserAssertionResult {
	readonly assertionId: string;
	readonly passed: boolean;
}

export interface BrowserEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "browser";
	readonly scenarioId: string;
	readonly assertionIds: readonly string[];
	readonly assertionResults?: readonly BrowserAssertionResult[];
	/** Legacy host adapters may call the result list `assertions`. */
	readonly assertions?: readonly BrowserAssertionResult[];
}

export interface ApiEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "api";
	readonly requestId: string;
	readonly assertionIds: readonly string[];
	readonly assertionResults?: readonly BrowserAssertionResult[];
	/** Legacy host adapters may call the result list `assertions`. */
	readonly assertions?: readonly BrowserAssertionResult[];
}

export interface ArtifactEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "artifact";
	readonly artifactKind: string;
	readonly schemaId: string;
}

export interface ReviewEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "review";
	readonly rubricId: string;
	readonly requiredEvidenceKinds: readonly EvidenceVerifierKind[];
	/** References to other host receipts, never embedded review text. */
	readonly evidenceRefs?: readonly string[];
}

export interface ExternalEvidenceReceipt extends EvidenceReceiptBase {
	readonly kind: "external";
	readonly dependencyId: string;
}

/** Typed, bounded host fact. Raw command/API/browser output and secrets are excluded. */
export type EvidenceReceipt =
	| CommandEvidenceReceipt
	| BrowserEvidenceReceipt
	| ApiEvidenceReceipt
	| ArtifactEvidenceReceipt
	| ReviewEvidenceReceipt
	| ExternalEvidenceReceipt;

export type AcceptanceEvidenceReceipt = EvidenceReceipt;
/** A host-owned receipt reference; no receipt body is stored here. */
export interface EvidenceRef {
	readonly evidenceId: string;
	readonly kind: EvidenceVerifierKind;
	readonly receiptRef: string;
	/** Optional explicit receipt identity accepted for legacy readers. */
	readonly receiptId?: string;
	readonly gateId?: string;
	readonly contractRevision?: number;
	readonly assignmentId?: string;
	readonly strategyKey?: string;
	readonly freshnessRevision?: number;
}

export interface AcceptanceGate {
	readonly gateId: string;
	readonly contractRef: ObjectiveContractRef;
	readonly contractRevision: number;
	/** Redundant bounded copy for adapters that do not retain contractRef. */
	readonly contractHash?: string;
	readonly objectiveClauseRefs: readonly string[];
	readonly verifier: AcceptanceVerifier;
	readonly status: AcceptanceGateStatus;
	readonly evidenceRefs: readonly EvidenceRef[];
	readonly assignmentId?: string;
	readonly freshnessRevision?: number;
	readonly required?: boolean;
}

export interface ExecutionStrategyRef {
	readonly strategyKey: string;
	readonly revision: number;
	readonly hypothesisRef: string;
	readonly expectedEvidenceRefs: readonly string[];
	readonly independenceKey?: string;
}

export interface ExecutionStrategy extends ExecutionStrategyRef {
	readonly strategyId: string;
	readonly scopeId: string;
	readonly status: ExecutionStrategyStatus;
}

export interface ExecutionAssignmentRef {
	readonly assignmentId: string;
	readonly scopeId: string;
	readonly workKey: string;
	readonly strategyKey: string;
}

export interface ExecutionAssignment extends ExecutionAssignmentRef {
	readonly strategyRevision: number;
	readonly objectiveClauseRefs: readonly string[];
	readonly status: ExecutionAssignmentStatus;
}

export interface UsageTelemetry {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly durationMs: number;
	readonly providerRequests: number;
	readonly assignmentCount: number;
	readonly updatedAt?: string;
}

export interface UsageTelemetryDelta {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens?: number;
	readonly cost?: number;
	readonly durationMs?: number;
	readonly providerRequests?: number;
	readonly assignmentCount?: number;
}

export interface ProviderHealthRef {
	readonly providerKey: string;
	readonly endpoint: string;
	readonly normalizedUrl: string;
	readonly modelKey?: string;
	readonly state: ProviderHealthState;
	readonly healthRevision: number;
	readonly generation: number;
	readonly terminalReceiptRef?: string;
}

export interface SupervisorDecisionRef {
	readonly decisionId: string;
	readonly scopeId: string;
	readonly basisRevision: number;
	readonly basisHash: string;
	readonly action: SupervisorAction;
	readonly evidenceRefs: readonly string[];
	readonly invalidatedHypothesisRefs: readonly string[];
	readonly confidence: SupervisorConfidence;
	readonly createdAt: string;
	readonly externalBlocker?: SupervisorExternalBlocker;
}

export interface ExecutionRequestFact {
	readonly requestId: string;
	readonly status: ExecutionRequestStatus;
	readonly startedAt: string;
	readonly finishedAt?: string;
	/** True when the host restarted while this request was active. */
	readonly interrupted: boolean;
}

export interface ProgressObservation {
	readonly observationId: string;
	readonly progressClass: ProgressClass;
	readonly fingerprint: string;
	readonly revision: number;
	readonly strategyKey?: string;
	readonly failureFingerprint?: string;
	readonly cursor?: string;
}

export interface ExecutionScopeSnapshot extends ExecutionScopeIdentity {
	readonly schemaVersion: typeof EXECUTION_SCOPE_SCHEMA_VERSION;
	readonly revision: number;
	readonly state: ExecutionScopeState;
	readonly objectiveContract?: ImmutableObjectiveContract;
	readonly gates: readonly AcceptanceGate[];
	readonly evidenceRefs: readonly EvidenceRef[];
	readonly assignments: readonly ExecutionAssignment[];
	readonly strategies: readonly ExecutionStrategy[];
	readonly usage: UsageTelemetry;
	readonly providerHealth: readonly ProviderHealthRef[];
	readonly supervisorDecisions: readonly SupervisorDecisionRef[];
	readonly requests: readonly ExecutionRequestFact[];
	readonly progress: readonly ProgressObservation[];
	/** Record identities included by this snapshot, used for compacted replay. */
	readonly recordIds: readonly string[];
	readonly updatedAt: string;
}

export interface ExecutionLedgerEventBase {
	readonly recordId: string;
	readonly occurredAt?: string;
	/** Optional on input; the ledger fills and validates it. */
	readonly scopeId?: string;
}

export interface ScopeStartedEvent extends ExecutionLedgerEventBase {
	readonly type: "scope_started";
	readonly objectiveContract?: ImmutableObjectiveContract;
}

export interface ObjectiveContractBoundEvent extends ExecutionLedgerEventBase {
	readonly type: "objective_contract_bound";
	readonly objectiveContract: ImmutableObjectiveContract;
}

export interface ExecutionStateChangedEvent extends ExecutionLedgerEventBase {
	readonly type: "state_changed";
	readonly state: ExecutionScopeState;
}

export interface AcceptanceGateRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "acceptance_gate_recorded";
	readonly gate: AcceptanceGate;
}

export interface EvidenceRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "evidence_recorded";
	readonly evidence: EvidenceRef;
}

export interface AssignmentRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "assignment_recorded";
	readonly assignment: ExecutionAssignment;
}

export interface StrategyRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "strategy_recorded";
	readonly strategy: ExecutionStrategy;
}

export interface UsageRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "usage_recorded";
	readonly delta: UsageTelemetryDelta;
}

export interface ProviderHealthRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "provider_health_recorded";
	readonly health: ProviderHealthRef;
}

export interface SupervisorDecisionRecordedEvent extends ExecutionLedgerEventBase {
	readonly type: "supervisor_decision_recorded";
	readonly decision: SupervisorDecisionRef;
}

export interface RequestStartedEvent extends ExecutionLedgerEventBase {
	readonly type: "request_started";
	readonly requestId: string;
	readonly interrupted?: boolean;
}

export interface RequestFinishedEvent extends ExecutionLedgerEventBase {
	readonly type: "request_finished";
	readonly requestId: string;
	readonly status: "completed" | "failed" | "interrupted";
}

export interface ProgressObservedEvent extends ExecutionLedgerEventBase {
	readonly type: "progress_observed";
	readonly observation: ProgressObservation;
}

export type ExecutionLedgerEvent =
	| ScopeStartedEvent
	| ObjectiveContractBoundEvent
	| ExecutionStateChangedEvent
	| AcceptanceGateRecordedEvent
	| EvidenceRecordedEvent
	| AssignmentRecordedEvent
	| StrategyRecordedEvent
	| UsageRecordedEvent
	| ProviderHealthRecordedEvent
	| SupervisorDecisionRecordedEvent
	| RequestStartedEvent
	| RequestFinishedEvent
	| ProgressObservedEvent;

/** A journal-ready event with host-assigned monotonic revision and identity. */
export type ExecutionLedgerRecord = ExecutionLedgerEvent &
	ExecutionScopeIdentity & {
		readonly revision: number;
		readonly occurredAt: string;
		/** Repeated bounded contract reference keeps event-only journals recoverable. */
		readonly objectiveContract?: ImmutableObjectiveContract;
	};

export interface ExecutionLedgerAppendOptions {
	readonly expectedRevision?: number;
}

export interface ExecutionLedgerAppendResult {
	readonly accepted: boolean;
	readonly duplicate: boolean;
	readonly revision: number;
	readonly record: Readonly<ExecutionLedgerRecord>;
	readonly snapshot: Readonly<ExecutionScopeSnapshot>;
}

export type ExecutionLedgerSubscriberErrorHandler = (
	error: unknown,
	record: Readonly<ExecutionLedgerRecord>,
	snapshot: Readonly<ExecutionScopeSnapshot>,
) => void;

export type ExecutionLedgerSubscriber = (
	record: Readonly<ExecutionLedgerRecord>,
	snapshot: Readonly<ExecutionScopeSnapshot>,
) => void;

export interface ExecutionLedgerOptions {
	readonly scopeId?: string;
	readonly rootSessionId?: string;
	readonly logicalTurnId?: string;
	readonly objectiveContract?: ImmutableObjectiveContract;
	readonly initialState?: ExecutionScopeState;
	readonly initialSnapshot?: ExecutionScopeSnapshot;
	readonly now?: () => string;
	readonly onSubscriberError?: ExecutionLedgerSubscriberErrorHandler;
}

export interface ExecutionScopeReference extends ExecutionScopeIdentity {
	readonly objectiveContract: ImmutableObjectiveContract;
	readonly createdAt: string;
}

export type ScopeContinuationKind =
	| "authoritative_user"
	| "steering"
	| "compaction"
	| "handoff"
	| "request_recovery"
	| "model_summary";

export interface ResolveExecutionScopeRequest {
	readonly rootSessionId: string;
	readonly logicalTurnId?: string;
	readonly kind: ScopeContinuationKind;
	readonly objectiveContract?: ImmutableObjectiveContract;
	readonly continuationOfScopeId?: string;
}

export interface StartExecutionScopeRequest {
	readonly rootSessionId: string;
	readonly logicalTurnId: string;
	readonly objectiveContract: ImmutableObjectiveContract;
}

export interface ExecutionScopeRegistryOptions {
	readonly now?: () => string;
}

export function emptyUsageTelemetry(): UsageTelemetry {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: 0,
		durationMs: 0,
		providerRequests: 0,
		assignmentCount: 0,
	};
}
