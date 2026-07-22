/**
 * San RPC v2 Integration, Execution Profile, Settings, and Subagent DTOs.
 */

import type { IntegrationId, RunId, ToolCallId } from "../protocol/ids";
import type { DurationMs, Timestamp } from "../protocol/lifecycle";
import type { ArtifactRef } from "./resources";

// ============================================================================
// Integration (Skill / MCP / Extension)
// ============================================================================

export interface IntegrationRef {
	integrationId: IntegrationId;
	kind: "skill" | "mcp" | "extension";
	name?: string;
}

export interface IntegrationSummary extends IntegrationRef {
	schemaVersion: 1;
	displayName: string;
	source: "builtin" | "user" | "workspace" | "managed";
	enabled: boolean;
	mutable: boolean;
	revision: number;
	effect: "immediate" | "restart_required";
	health: IntegrationHealth;
	auth: IntegrationAuth;
	tools?: Array<{ name: string; description?: string; inputSchemaId?: string }>;
}

export interface IntegrationHealth {
	status: "healthy" | "degraded" | "failed" | "unknown";
	checkedAt?: Timestamp;
	reasonCode?: string;
	message?: string;
}

export interface IntegrationAuth {
	status: "not_required" | "required" | "authenticated" | "expired";
	providerId?: string;
}

// ============================================================================
// Execution Profile
// ============================================================================

export interface ExecutionProfile {
	profileId: string;
	name: string;
	description: string;
	availability: "available" | "degraded" | "unavailable";
	reasonCode?: string;
	capabilities: string[];
	recommendedFor: string[];
}

// ============================================================================
// Session Runtime Settings
// ============================================================================

export interface SessionRuntimeSettings {
	schemaVersion: 1;
	revision: number;
	executionProfile: EffectiveSetting<string>;
	autoRetry: EffectiveSetting<AutoRetryConfig>;
	contextMaintenance: EffectiveSetting<ContextMaintenanceConfig>;
}

export interface EffectiveSetting<T> {
	configured?: T;
	effective: T;
	source: "builtin" | "global" | "workspace" | "session";
	mutable: boolean;
	restartRequired: boolean;
}

export interface AutoRetryConfig {
	enabled: boolean;
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	cancellable: boolean;
}

export interface ContextMaintenanceConfig {
	mode: "automatic" | "manual" | "disabled";
	triggerPercent?: number;
	strategy?: string;
}

// ============================================================================
// Subagent
// ============================================================================

export interface SubagentSnapshot {
	subagentId: string;
	index: number;
	agent: string;
	agentSource: "bundled" | "user" | "project";
	description?: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task?: string;
	assignment?: string;
	parentToolCallId?: ToolCallId;
	runId?: RunId;
	lastUpdate: Timestamp;
	progress?: SubagentProgress;
}

export interface SubagentProgress {
	currentTool?: string;
	toolCount: number;
	tokens: number;
	cost: number;
	durationMs: DurationMs;
	retryState?: { attempt: number; delayMs: number; error: string };
}

// ============================================================================
// Diagnostics
// ============================================================================

export interface DiagnosticsSnapshot {
	schemaVersion: 1;
	generatedAt: Timestamp;
	redaction: { profile: "strict"; version: number; removedFieldCount: number };
	runtime: { version: string; protocolVersion: string; uptimeMs: DurationMs; exitState?: string };
	capabilities: { revision: number; enabled: string[]; unavailable: string[] };
	sessions: { activeCount: number; lockedCount: number; lastSequences: Record<string, number> };
	integrations: Array<{
		integrationId: string;
		kind: string;
		health: string;
		enabled: boolean;
		lastErrorReason?: string;
	}>;
	recentErrors: Array<{ reason: string; category: string; correlationId: string; at: Timestamp }>;
	artifact?: ArtifactRef;
}
