/**
 * San RPC v2 Run and Queue DTOs.
 */

import type { MessageId, OperationId, QueueItemId, RunId, SessionId, TurnId } from "../protocol/ids";
import type { DurationMs, QueueItemStatus, RunStatus, Timestamp } from "../protocol/lifecycle";

// ============================================================================
// Run
// ============================================================================

export interface RunSnapshot {
	runId: RunId;
	status: RunStatus;
	userMessageId: MessageId;
	startedAt?: Timestamp;
	finishedAt?: Timestamp;
	currentTurnId?: TurnId;
	reason?: string;
	usage?: RunUsage;
}

export interface RunUsage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	durationMs?: DurationMs;
}

// ============================================================================
// Queue
// ============================================================================

export interface QueueItem {
	queueItemId: QueueItemId;
	sessionId: SessionId;
	createdAt: Timestamp;
	position: number;
	status: QueueItemStatus;
	contentPreview: string;
	imageCount: number;
	promotedRunId?: RunId;
	sourceOperationId: OperationId;
}

// ============================================================================
// Run control params
// ============================================================================

export interface RunStartParams {
	sessionId: SessionId;
	leaseId: string;
	content: ContentPart[];
	model?: { provider: string; modelId: string };
	thinking?: string;
	goal?: string;
	meta: { idempotencyKey: string };
}

export interface RunSteerParams {
	sessionId: SessionId;
	leaseId: string;
	runId: RunId;
	content: ContentPart[];
	delivery: "immediate" | "next_safe_point";
	meta: { idempotencyKey: string };
}

export interface RunFollowUpParams {
	sessionId: SessionId;
	leaseId: string;
	content: ContentPart[];
	meta: { idempotencyKey: string };
}

export interface RunReplaceParams {
	sessionId: SessionId;
	leaseId: string;
	expectedRunId: RunId;
	content: ContentPart[];
	meta: { idempotencyKey: string };
}

export interface RunAbortParams {
	sessionId: SessionId;
	leaseId: string;
	runId: RunId;
	reason: "user" | "close" | "shutdown";
	meta: { idempotencyKey: string };
}

// ============================================================================
// Content parts (shared with resources)
// ============================================================================

import type { InputResourceRef } from "./resources";

export type ContentPart =
	| { type: "text"; text: string }
	| { type: "image"; resource: InputResourceRef; detail?: "auto" | "low" | "high"; alt?: string }
	| { type: "resource"; resource: InputResourceRef; purpose: "input" | "reference" };
