/**
 * San RPC v2 Context Continuity DTOs.
 *
 * Stable projections of internal TurnDigest and ContextCheckpoint.
 * Internal entry IDs are exposed as opaque SourceRef strings.
 */
import type { Timestamp } from "../protocol/lifecycle";

// ============================================================================
// Continuity Snapshot
// ============================================================================

export interface ContinuitySnapshot {
	schemaVersion: 1;
	status: "stable" | "building" | "degraded" | "unavailable";
	statusReason?: string;
	usage: ContextUsageSnapshot;
	maintenance?: MaintenanceSnapshot;
	activeCheckpoint?: CheckpointSummary;
	recentDigestRefs: Array<{ turnId: string; createdAt: Timestamp; fallback: boolean }>;
	counters: { digests: number; checkpoints: number; evidence: number; retries: number };
}

export interface ContextUsageSnapshot {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface MaintenanceSnapshot {
	maintenanceId: string;
	kind: "context_full" | "handoff" | "shake" | "snapcompact";
	state: "running" | "completed" | "failed" | "cancelled" | "skipped";
	startedAt: Timestamp;
}

// ============================================================================
// Checkpoint
// ============================================================================

export interface CheckpointSummary {
	checkpointId: string;
	createdAt: Timestamp;
	digestCount: number;
	summary: CheckpointSummaryContent;
	sourceRefs: string[];
	tokenEstimate: number;
	tokenBudget: number;
	stability: "stable";
}

export interface CheckpointSummaryContent {
	userIntents: SummaryItem[];
	decisions: SummaryItem[];
	filesTouched: Array<SummaryItem & { action: "read" | "modified" | "created" | "deleted" | "unknown" }>;
	risks: SummaryItem[];
	nextSteps: SummaryItem[];
}

export interface SummaryItem {
	text: string;
	entryRefs?: string[];
}

// ============================================================================
// Turn Digest (stable DTO projection)
// ============================================================================

export interface TurnDigestDto {
	schemaVersion: 1;
	turnId: string;
	sessionId: string;
	createdAt: Timestamp;
	model?: string;
	userIntent: string;
	actionsTaken: string[];
	decisions: string[];
	filesTouched: Array<{ path: string; action: "read" | "modified" | "created" | "deleted" | "unknown" }>;
	toolEvidence: Array<{ tool: string; summary: string }>;
	factsLearned: string[];
	openQuestions: string[];
	risks: string[];
	nextSteps: string[];
	fallback: boolean;
	fallbackReason?: string;
}
