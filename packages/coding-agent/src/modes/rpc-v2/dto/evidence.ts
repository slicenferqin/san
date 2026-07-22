/**
 * San RPC v2 Evidence Ledger DTOs.
 */

import type { EventId, EvidenceId, RunId, SessionId, ToolCallId, TurnId } from "../protocol/ids";
import type { DurationMs, Timestamp } from "../protocol/lifecycle";
import type { ArtifactRef } from "./resources";

// ============================================================================
// Evidence Record
// ============================================================================

export interface EvidenceRecord {
	schemaVersion: 1;
	evidenceId: EvidenceId;
	sessionId: SessionId;
	runId?: RunId;
	turnId?: TurnId;
	createdAt: Timestamp;
	kind: EvidenceKind;
	verdict: EvidenceVerdict;
	title: string;
	summary: string;
	source: EvidenceSource;
	details?: EvidenceDetails;
	artifacts?: ArtifactRef[];
}

export type EvidenceKind =
	| "command_result"
	| "test_result"
	| "file_change"
	| "tool_result"
	| "approval_decision"
	| "checkpoint"
	| "subagent_report"
	| "host_observation";

export type EvidenceVerdict = "passed" | "failed" | "informational" | "unknown";

export interface EvidenceSource {
	kind: "deterministic_tool" | "san_runtime" | "model_summary" | "desktop_host";
	eventId?: EventId;
	sequence?: number;
	entryIds?: string[];
	toolCallId?: ToolCallId;
}

export interface EvidenceDetails {
	command?: string;
	cwd?: string;
	exitCode?: number;
	durationMs?: DurationMs;
	path?: string;
}
