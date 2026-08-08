import type { AcceptanceGate, EvidenceReceipt, ObjectiveContractRef } from "../execution-control/types";

/**
 * San v0.2 execution loop ledger types.
 *
 * These records are persisted as CustomEntry data. They do not enter the LLM
 * context directly; role-specific prompts consume rendered views instead.
 */

export const SAN_LOOP_SCHEMA_VERSION = 1;
export const SAN_LOOP_RUN_CUSTOM_TYPE = "san.loop_run";
export const SAN_LOOP_EVENT_CUSTOM_TYPE = "san.loop_event";
export const SAN_LOOP_REVIEW_CUSTOM_TYPE = "san.review_report";
export const SAN_LOOP_TRANSITION_CUSTOM_TYPE = "san.loop_transition";
export const SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE = "san.loop_context_packet";

export const SAN_LOOP_MODES = ["solo", "team", "council"] as const;
export type SanLoopMode = (typeof SAN_LOOP_MODES)[number];

export type LegacySanLoopMode = "rush" | "smart" | "deep";

export const SAN_LOOP_LEGACY_MODE_ALIASES: Record<LegacySanLoopMode, SanLoopMode> = {
	rush: "solo",
	smart: "team",
	deep: "council",
};

export function normalizeSanLoopMode(value: unknown): SanLoopMode | undefined {
	if (value === "solo" || value === "team" || value === "council") return value;
	if (value === "rush" || value === "smart" || value === "deep") return SAN_LOOP_LEGACY_MODE_ALIASES[value];
	return undefined;
}

export type SanLoopStatus =
	| "planning"
	| "dispatching"
	| "working"
	| "reviewing"
	| "retrying"
	| "aborting"
	| "blocked"
	| "passed"
	| "failed"
	| "aborted";

export type SanLoopRole = "commander" | "worker" | "supervisor" | "oracle";

export type SanLoopReviewVerdict = "pass" | "needs_fix" | "blocked" | "out_of_scope";

export type SanLoopTaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

export type SanLoopAssignmentStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

export type SanLoopEventType =
	| "run_created"
	| "plan_created"
	| "assignment_created"
	| "worker_completed"
	| "review_completed"
	| "retry_requested"
	| "abort_requested"
	| "blocked"
	| "aborted"
	| "failed"
	| "finalized"
	| "recovered";

export interface SanLoopTaskNode {
	id: string;
	title: string;
	status: SanLoopTaskStatus;
	description?: string;
	dependsOn: string[];
	acceptanceCriteria: string[];
	checkRefs: string[];
	assignedRole?: SanLoopRole;
}

export interface SanLoopPlan {
	objective: string;
	constraints: string[];
	acceptanceCriteria: string[];
	taskGraph: SanLoopTaskNode[];
	checkPlan: string[];
	riskRegister: string[];
}

export interface SanLoopWorkerAssignment {
	assignmentId: string;
	runId: string;
	createdAt: string;
	objective: string;
	taskNodeIds: string[];
	instructions: string;
	acceptanceCriteria: string[];
	contextRefs: string[];
	checkRefs: string[];
	status: SanLoopAssignmentStatus;
}

export interface SanLoopCommandEvidence {
	command: string;
	exitCode?: number;
	summary: string;
	/**
	 * Provenance of this receipt.
	 * - `host`: observed from a host-owned tool execution (e.g. bash tool result)
	 * - `model`: claimed by the worker yield payload (untrusted for pass gates)
	 * Missing source is treated as untrusted.
	 */
	source?: "host" | "model";
}

export interface SanLoopWorkerResult {
	resultId: string;
	runId: string;
	assignmentId: string;
	createdAt: string;
	status: "completed" | "blocked" | "failed";
	summary: string;
	changedFiles: string[];
	commandsRun: SanLoopCommandEvidence[];
	/** Host-created bounded receipts; legacy sessions may omit this field. */
	evidenceReceipts?: EvidenceReceipt[];
	verification: string[];
	risks: string[];
}

export interface SanLoopDefect {
	defectId: string;
	severity: "low" | "medium" | "high" | "blocker";
	title: string;
	evidence: string[];
	retryable: boolean;
	suggestedFix?: string;
}

export interface SanLoopReviewReport {
	schemaVersion: typeof SAN_LOOP_SCHEMA_VERSION;
	reportId: string;
	runId: string;
	createdAt: string;
	reviewer: "supervisor" | "oracle";
	verdict: SanLoopReviewVerdict;
	defects: SanLoopDefect[];
	testsRun: string[];
	evidence: string[];
	/** Supervisor-reported receipt identities; host verification resolves them. */
	evidenceRefs?: string[];
	retryable: boolean;
	requiredNextActions: string[];
	confidence: "low" | "medium" | "high";
	assignmentId?: string;
}

export interface SanLoopDecision {
	decisionId: string;
	runId: string;
	createdAt: string;
	actor: SanLoopRole;
	decision: string;
	rationale: string;
	nextAction?: string;
}

export interface SanLoopBudgetSnapshot {
	createdAt: string;
	state: SanLoopStatus;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	cost?: number;
	durationMs?: number;
	providerRequests?: number;
	remainingTurns?: number;
}
export interface SanLoopRunSnapshot {
	schemaVersion: typeof SAN_LOOP_SCHEMA_VERSION;
	revision: number;
	runId: string;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	objective: string;
	mode: SanLoopMode;
	status: SanLoopStatus;
	contextPlanRefs?: string[];
	/** Legacy ContextPacket refs kept for old session readability. */
	contextPacketRefs: string[];
	/** Immutable objective binding used by typed acceptance evidence. */
	objectiveContract?: ObjectiveContractRef;
	contractRevision?: number;
	contractHash?: string;
	objectiveClauseRefs?: string[];
	acceptanceGates?: AcceptanceGate[];
	evidenceReceipts?: EvidenceReceipt[];
	plan?: SanLoopPlan;
	assignments: SanLoopWorkerAssignment[];
	workerResults: SanLoopWorkerResult[];
	reviewReports: SanLoopReviewReport[];
	decisions: SanLoopDecision[];
	budget: SanLoopBudgetSnapshot[];
	retryCount: number;
	maxRetries: number;
	finalVerdict?: SanLoopReviewVerdict;
}

export interface SanLoopEvent {
	schemaVersion: typeof SAN_LOOP_SCHEMA_VERSION;
	eventId: string;
	runId: string;
	sessionId: string;
	createdAt: string;
	type: SanLoopEventType;
	summary: string;
	actor?: SanLoopRole;
	refs: string[];
	data?: Record<string, unknown>;
}

/** Atomic run/event/review binding persisted as a single custom entry. */
export interface SanLoopTransitionEnvelope {
	schemaVersion: typeof SAN_LOOP_SCHEMA_VERSION;
	run: SanLoopRunSnapshot;
	event: SanLoopEvent;
	review?: SanLoopReviewReport;
}

export interface SanLoopRoleContextPacketDebug {
	schemaVersion: typeof SAN_LOOP_SCHEMA_VERSION;
	packetId: string;
	runId: string;
	sessionId: string;
	createdAt: string;
	role: SanLoopRole;
	sourceContextPlanRefs?: string[];
	/** Legacy ContextPacket refs kept for old session readability. */
	sourceContextPacketRefs: string[];
	entryRefs: string[];
	tokenEstimate: number;
	tokenBudget: number;
	trimmed: number;
}

export interface SanLoopEntryRef<T> {
	entryId: string;
	timestamp: string;
	data: T;
}

export interface SanLoopLedger {
	runs: SanLoopEntryRef<SanLoopRunSnapshot>[];
	events: SanLoopEntryRef<SanLoopEvent>[];
	reviews: SanLoopEntryRef<SanLoopReviewReport>[];
	rolePackets: SanLoopEntryRef<SanLoopRoleContextPacketDebug>[];
	latestRun?: SanLoopEntryRef<SanLoopRunSnapshot>;
}
