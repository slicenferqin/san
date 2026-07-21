/**
 * San RPC v2 lifecycle state machines.
 *
 * Defines the valid states and transitions for Session, Run, Approval,
 * Interaction, and Queue entities. Invalid transitions are protocol errors.
 */

// ============================================================================
// Session
// ============================================================================

export type SessionAccess = "closed" | "opening" | "ready" | "recovering" | "read_only" | "corrupt" | "locked";

export type SessionPersistedStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

// ============================================================================
// Run
// ============================================================================

export type RunActiveStatus =
	| "accepted"
	| "running"
	| "waiting_approval"
	| "waiting_input"
	| "retry_wait"
	| "compacting";

export type RunTerminalStatus = "completed" | "failed" | "aborted" | "interrupted";

export type RunStatus = RunActiveStatus | RunTerminalStatus;

const RUN_ACTIVE: ReadonlySet<string> = new Set<RunActiveStatus>([
	"accepted",
	"running",
	"waiting_approval",
	"waiting_input",
	"retry_wait",
	"compacting",
]);

const RUN_TERMINAL: ReadonlySet<string> = new Set<RunTerminalStatus>(["completed", "failed", "aborted", "interrupted"]);

export function isRunActive(status: RunStatus): status is RunActiveStatus {
	return RUN_ACTIVE.has(status);
}

export function isRunTerminal(status: RunStatus): status is RunTerminalStatus {
	return RUN_TERMINAL.has(status);
}

/**
 * Valid Run state transitions.
 * Key is current state, value is the set of states it can move to.
 */
export const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
	accepted: new Set(["running", "aborted", "interrupted"]),
	running: new Set([
		"waiting_approval",
		"waiting_input",
		"retry_wait",
		"compacting",
		"completed",
		"failed",
		"aborted",
		"interrupted",
	]),
	waiting_approval: new Set(["running", "aborted", "interrupted"]),
	waiting_input: new Set(["running", "aborted", "interrupted"]),
	retry_wait: new Set(["running", "failed", "aborted", "interrupted"]),
	compacting: new Set(["running", "completed", "failed", "aborted", "interrupted"]),
	completed: new Set(),
	failed: new Set(),
	aborted: new Set(),
	interrupted: new Set(),
};

export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
	return RUN_TRANSITIONS[from].has(to);
}

// ============================================================================
// Queue
// ============================================================================

export type QueueItemStatus = "queued" | "cancelled" | "promoted";

// ============================================================================
// Approval
// ============================================================================

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";

const APPROVAL_TERMINAL: ReadonlySet<string> = new Set(["allowed", "denied", "expired", "cancelled"]);

export function isApprovalTerminal(status: ApprovalStatus): boolean {
	return APPROVAL_TERMINAL.has(status);
}

// ============================================================================
// Interaction
// ============================================================================

export type InteractionStatus = "pending" | "answered" | "cancelled" | "expired";

const INTERACTION_TERMINAL: ReadonlySet<string> = new Set(["answered", "cancelled", "expired"]);

export function isInteractionTerminal(status: InteractionStatus): boolean {
	return INTERACTION_TERMINAL.has(status);
}

// ============================================================================
// Recovery
// ============================================================================

export type RecoveryReason = "runtime_crash" | "unclean_shutdown" | "stale_lease" | "incomplete_run" | "journal_repair";

export type RecoveryStrategy = "continue" | "mark_aborted" | "read_only";

// ============================================================================
// Mutation Meta
// ============================================================================

export interface MutationMeta {
	idempotencyKey: string;
	expectedRevision?: number;
}

// ============================================================================
// Time conventions
// ============================================================================

/**
 * All absolute timestamps are RFC 3339 UTC strings (e.g. "2026-07-20T14:35:08.421Z").
 * All durations are integer milliseconds.
 */
export type Timestamp = string;
export type DurationMs = number;
