/**
 * San RPC v2 Approval and Permission DTOs.
 */

import type { ApprovalId, RunId, SessionId, ToolCallId, TurnId } from "../protocol/ids";
import type { ApprovalStatus, MutationMeta, Timestamp } from "../protocol/lifecycle";
import type { IntegrationRef } from "./integration";

// ============================================================================
// Approval Request
// ============================================================================

export interface ApprovalRequest {
	schemaVersion: 1;
	approvalId: ApprovalId;
	sessionId: SessionId;
	runId: RunId;
	turnId?: TurnId;
	toolCallId?: ToolCallId;
	requestAction: ApprovalRequestAction;
	createdAt: Timestamp;
	expiresAt?: Timestamp;
	status: ApprovalStatus;
	title: string;
	summary: string;
	risk: ApprovalRisk;
	tool?: ApprovalToolInfo;
	targets: ApprovalTarget[];
	policySnapshot: ApprovalPolicySnapshot;
	allowedDecisions: Array<"allow" | "deny">;
	allowedScopes: ApprovalScope[];
	fingerprint: string;
	invalidation: string[];
}

export type ApprovalRequestAction = "tool_execute" | "resource_access" | "integration_manage" | "host_action";

export type ApprovalScope = "once" | "session" | "workspace" | "global";

export interface ApprovalRisk {
	tier: "read" | "write" | "exec";
	level: "low" | "medium" | "high" | "critical";
	irreversible: boolean;
	reasons: string[];
}

export interface ApprovalToolInfo {
	name: string;
	label: string;
	intent?: string;
	operationKind: string;
	integration?: IntegrationRef;
	arguments: { schemaId?: string; value: JsonValue; redactedPaths: string[] };
	argumentsSummary: string;
	cwd?: string;
}

export interface ApprovalTarget {
	kind: "path" | "command" | "url" | "resource" | "integration";
	display: string;
	canonical?: string;
	workspaceRelative?: string;
	exists?: boolean;
	sensitivity?: "normal" | "sensitive" | "secret";
	destructive?: boolean;
}

export interface ApprovalPolicySnapshot {
	source: "builtin" | "global" | "workspace" | "session" | "request_override";
	ruleId?: string;
	matchedFingerprint?: string;
	effectiveDecision: "ask" | "allow" | "deny";
	canPersistRule: boolean;
	rationale?: string;
}

// ============================================================================
// Approval Decision
// ============================================================================

export interface ApprovalDecisionParams {
	sessionId: SessionId;
	leaseId: string;
	approvalId: ApprovalId;
	decision: "allow" | "deny";
	scope: ApprovalScope;
	persistRule: boolean;
	comment?: string;
	meta: MutationMeta;
}

// ============================================================================
// Permission Policy
// ============================================================================

export interface PermissionPolicySnapshot {
	schemaVersion: 1;
	scope: "session" | "workspace" | "global";
	scopeId?: string;
	revision: number;
	defaults: Record<"read" | "write" | "exec", "ask" | "allow" | "deny">;
	rules: PermissionRule[];
	restartRequired?: boolean;
}

export interface PermissionRule {
	ruleId: string;
	decision: "allow" | "deny";
	fingerprint: string;
	toolName?: string;
	operationKind?: string;
	targetPattern?: string;
	riskCeiling?: "low" | "medium" | "high";
	createdAt: Timestamp;
	sourceApprovalId?: ApprovalId;
	mutable: boolean;
	sourceScope?: "session" | "workspace" | "global";
	sourceScopeId?: string;
	shadowedByRuleId?: string;
}

// ============================================================================
// Approval Preset
// ============================================================================

/** Server-owned permission preset; clients render these instead of guessing policy mappings. */
export interface ApprovalPreset {
	presetId: string;
	label: string;
	description: string;
	defaults: Record<"read" | "write" | "exec", "ask" | "allow" | "deny">;
}

// ============================================================================
// JSON value helper
// ============================================================================

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
