/**
 * San RPC v2 Session Event envelope and event data types.
 *
 * Every event emitted on the v2 protocol is wrapped in a SessionEvent
 * envelope with stable identity, ordering, and durability classification.
 */

import type { ContextMaintenanceTrigger } from "../../../context-steady/types";

import type {
	ApprovalId,
	EventId,
	EvidenceId,
	MessageId,
	OperationId,
	QueueItemId,
	RunId,
	SessionId,
	ToolCallId,
	TurnId,
} from "../protocol/ids";
import type { RunStatus, Timestamp } from "../protocol/lifecycle";
import type { ApprovalRequest } from "./approval";
import type { InteractionRequest } from "./interaction";
import type { QueueItem } from "./run";

// ============================================================================
// Event Envelope
// ============================================================================

export interface SessionEvent<T = unknown> {
	schemaVersion: 1;
	eventId: EventId;
	sessionId: SessionId;
	sequence: number;
	timestamp: Timestamp;
	runId?: RunId;
	turnId?: TurnId;
	type: SessionEventType;
	durability: "durable" | "transient";
	causation?: EventCausation;
	data: T;
}

export interface EventCausation {
	operationId?: OperationId;
	parentEventId?: EventId;
}

// ============================================================================
// Event Type Catalog
// ============================================================================

export type SessionEventType =
	// Session
	| "session.opened"
	| "session.closed"
	| "session.deleted"
	| "session.title.changed"
	| "session.recovery.available"
	| "session.recovered"
	| "session.corrupt"
	// Run
	| "run.accepted"
	| "run.started"
	| "run.state.changed"
	| "run.completed"
	| "run.failed"
	| "run.aborted"
	| "run.interrupted"
	// Turn
	| "turn.started"
	| "turn.completed"
	// Message
	| "message.started"
	| "message.delta"
	| "message.completed"
	// Tool
	| "tool.queued"
	| "tool.started"
	| "tool.progress"
	| "tool.completed"
	| "tool.cancelled"
	// Queue
	| "queue.item.added"
	| "queue.item.cancelled"
	| "queue.item.promoted"
	| "queue.settings.changed"
	// Approval
	| "approval.requested"
	| "approval.resolved"
	| "approval.expired"
	| "approval.cancelled"
	| "approval.rule.changed"
	// Interaction
	| "interaction.requested"
	| "interaction.answered"
	| "interaction.cancelled"
	| "interaction.expired"
	// Todo / Goal
	| "todo.changed"
	| "todo.reminder"
	| "goal.changed"
	| "planMode.changed"
	// Subagent
	| "subagent.started"
	| "subagent.progress"
	| "subagent.completed"
	| "subagent.failed"
	| "subagent.aborted"
	| "subagent.event"
	// Context
	| "context.usage.changed"
	| "context.health.changed"
	| "context.maintenance.started"
	| "context.maintenance.completed"
	| "context.checkpoint.created"
	| "context.digest.created"
	// Retry
	| "retry.started"
	| "retry.cancelled"
	| "retry.completed"
	| "retry.fallback.applied"
	| "retry.fallback.succeeded"
	// Integration / Auth
	| "integration.changed"
	| "integration.health.changed"
	| "auth.login.state.changed"
	// Evidence
	| "evidence.recorded"
	// Notice
	| "session.notice";

// ============================================================================
// Event Data Types (selected key events)
// ============================================================================

export interface RunAcceptedData {
	runId: RunId;
	operationId: OperationId;
	acceptedAt: Timestamp;
}

export interface RunStartedData {
	runId: RunId;
	turnId: TurnId;
}

export interface RunStateChangedData {
	runId: RunId;
	previousStatus: RunStatus;
	status: RunStatus;
	reason?: string;
}

export interface RunTerminalData {
	runId: RunId;
	status: "completed" | "failed" | "aborted" | "interrupted";
	reason?: string;
	finishedAt: Timestamp;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number };
}

export interface MessageStartedData {
	messageId: MessageId;
	role: string;
}

export interface MessageDeltaData {
	messageId: MessageId;
	delta: string;
	/** Absent for answer text; "thinking" for reasoning-channel deltas (opt-in via stream.configure). */
	channel?: "thinking";
}

export interface MessageCompletedData {
	messageId: MessageId;
	role: string;
	/** Visible text persisted with the completion event, bounded by the active-message wire limit. */
	content: string;
	contentLength: number;
	truncated: boolean;
}

export interface ToolStartedData {
	toolCallId: ToolCallId;
	toolName: string;
	category?: string;
	intent?: string;
}

export interface ToolCompletedData {
	toolCallId: ToolCallId;
	toolName: string;
	outcome: "success" | "error" | "cancelled";
	/** Stable bounded completion label emitted by the adapter. */
	summary: string;
	artifactRef?: string;
	/** Primary file path the tool touched (edit/write family), when the result reports one. */
	path?: string;
	/** Bounded human-readable result preview — a unified diff for edit tools. */
	preview?: string;
	/** True when `preview` was truncated to the wire bound. */
	previewTruncated?: boolean;
}

export interface ContextMaintenanceStartedData {
	maintenanceId: string;
	kind: "context-full" | "handoff" | "shake" | "snapcompact";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	primaryTrigger: ContextMaintenanceTrigger;
	matchedTriggers: ContextMaintenanceTrigger[];
}

export interface ContextMaintenanceCompletedData {
	maintenanceId: string;
	kind: "context-full" | "handoff" | "shake" | "snapcompact";
	aborted: boolean;
	skipped?: boolean;
	willRetry: boolean;
	errorMessage?: string;
}

export interface ApprovalRequestedData {
	approval: ApprovalRequest;
}

export interface ApprovalResolvedData {
	approvalId: ApprovalId;
	decision: "allow" | "deny";
	scope: string;
	persistedRule?: boolean;
}

export interface InteractionRequestedData {
	interaction: InteractionRequest;
}

export interface QueueItemAddedData {
	item: QueueItem;
}

export interface QueueItemPromotedData {
	queueItemId: QueueItemId;
	runId: RunId;
}

export interface EvidenceRecordedData {
	evidenceId: EvidenceId;
	kind: string;
	verdict: string;
	title: string;
}

export interface SessionNoticeData {
	level: "info" | "warning" | "error";
	code: string;
	message: string;
	source?: string;
	details?: Record<string, unknown>;
}
