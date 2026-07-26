import type { Usage } from "@san/ai";
import type { NestedRepoPatch, WorktreeBaseline } from "../task/worktree";

/** v0.4 deliberately exposes exactly two product kinds. */
export type WorkflowKind = "managed" | "ad_hoc";

export type WorkflowSourceProvider = "san" | "claude" | "session";
export type WorkflowSourceLevel = "user" | "project" | "session";
export type WorkflowWriteMode = "read_only" | "isolated_write";

export type WorkflowJsonPrimitive = null | boolean | number | string;
export type WorkflowJsonValue = WorkflowJsonPrimitive | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

/** JSON Schema subset accepted for workflow arguments and structured agent output. */
export interface WorkflowJsonSchema {
	type?: "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";
	title?: string;
	description?: string;
	properties?: Record<string, WorkflowJsonSchema>;
	required?: string[];
	items?: WorkflowJsonSchema;
	additionalProperties?: boolean | WorkflowJsonSchema;
	enum?: WorkflowJsonValue[];
	const?: WorkflowJsonValue;
	minItems?: number;
	maxItems?: number;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	pattern?: string;
	anyOf?: WorkflowJsonSchema[];
	oneOf?: WorkflowJsonSchema[];
}

export interface WorkflowLimits {
	concurrency: number;
	agentLimit: number;
	tokenLimit: number;
	durationMs: number;
}

export interface WorkflowPermissionManifest {
	writeMode: WorkflowWriteMode;
	/** Exact tool names the workflow may pass to subagents. An empty list means no tools. */
	tools: string[];
}

export interface WorkflowMeta {
	name: string;
	description: string;
	version: string;
	argsSchema?: WorkflowJsonSchema;
	permissions: WorkflowPermissionManifest;
	limits: WorkflowLimits;
}

export interface WorkflowDefinitionSource {
	provider: WorkflowSourceProvider;
	level: WorkflowSourceLevel;
	path?: string;
	scopeKey: string;
}

export interface DiscoveredWorkflowSource {
	name: string;
	path: string;
	sourceText: string;
	sourceHash: string;
	provider: Exclude<WorkflowSourceProvider, "session">;
	level: Exclude<WorkflowSourceLevel, "session">;
	scopeKey: string;
	directoryDepth: number;
}

export interface ManagedWorkflow {
	kind: "managed";
	meta: WorkflowMeta;
	source: WorkflowDefinitionSource;
	sourceText: string;
	sourceHash: string;
	argsSchemaHash: string;
	permissionManifestHash: string;
}

export type AdHocDraftStatus = "draft" | "approved" | "rejected" | "expired" | "consumed";

export interface AdHocWorkflowDraft {
	kind: "ad_hoc";
	draftId: string;
	taskRef: string;
	name: string;
	description: string;
	humanSummary: string;
	sourceText: string;
	sourceHash: string;
	args?: WorkflowJsonValue;
	argsHash: string;
	argsSchema?: WorkflowJsonSchema;
	argsSchemaHash: string;
	permissions: WorkflowPermissionManifest;
	permissionManifestHash: string;
	limits: WorkflowLimits;
	scopeKey: string;
	createdAt: string;
	expiresAt: string;
	status: AdHocDraftStatus;
}

export interface ManagedWorkflowApprovalKey {
	workflowKind: "managed";
	name: string;
	version: string;
	sourceHash: string;
	argsSchemaHash: string;
	scopeKey: string;
	permissionManifestHash: string;
	concurrencyLimit: number;
	agentLimit: number;
	tokenLimit: number;
	durationMs: number;
	writeMode: WorkflowWriteMode;
}

export interface AdHocWorkflowApprovalKey {
	workflowKind: "ad_hoc";
	draftId: string;
	taskRef: string;
	sourceHash: string;
	argsHash: string;
	argsSchemaHash: string;
	scopeKey: string;
	permissionManifestHash: string;
	concurrencyLimit: number;
	agentLimit: number;
	tokenLimit: number;
	durationMs: number;
	writeMode: WorkflowWriteMode;
	expiresAt: string;
}

export type WorkflowApprovalKey = ManagedWorkflowApprovalKey | AdHocWorkflowApprovalKey;

export interface WorkflowApprovalRecord {
	approvalId: string;
	keyHash: string;
	key: WorkflowApprovalKey;
	approvedAt: string;
	approvedBy: "user";
	revokedAt?: string;
	consumedAt?: string;
}

export type WorkflowRunStatus =
	| "pending"
	| "approved"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked";

export type WorkflowNodeStatus =
	| "pending"
	| "scheduled"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked"
	| "unknown";

export type WorkflowDeliveryState = "pending" | "delivering" | "delivered" | "blocked";
export type WorkflowWriteArtifactStatus =
	| "pending"
	| "reviewed"
	| "applying"
	| "applied"
	| "rejected"
	| "blocked"
	| "unknown";

export interface WorkflowBudgetSnapshot {
	agentsStarted: number;
	agentsCompleted: number;
	tokensUsed: number;
	startedAt: string;
	elapsedMs: number;
	limits: WorkflowLimits;
}

export interface WorkflowNode {
	nodeId: string;
	callId: string;
	phase: string;
	attempt: number;
	inputHash: string;
	status: WorkflowNodeStatus;
	agentRef?: string;
	resultRef?: string;
	usage?: Usage;
	startedAt?: string;
	committedAt?: string;
	error?: string;
}

/** Safe metadata exposed in run status; filesystem paths and baseline contents remain host-private. */
export interface WorkflowWriteArtifact {
	artifactId: string;
	nodeId: string;
	callId: string;
	agentRef: string;
	status: WorkflowWriteArtifactStatus;
	patchHash: string;
	baselineHash: string;
	byteLength: number;
	hasNestedChanges: boolean;
	capturedAt: string;
	reviewedAt?: string;
	appliedAt?: string;
	rejectedAt?: string;
	blockedReason?: string;
}

export interface WorkflowRun {
	runId: string;
	workflowKind: WorkflowKind;
	workflowName: string;
	workflowVersion?: string;
	sourceHash: string;
	argsHash: string;
	approvalRef: string;
	scopeKey: string;
	status: WorkflowRunStatus;
	budget: WorkflowBudgetSnapshot;
	deliveryState: WorkflowDeliveryState;
	deliveryId?: string;
	currentPhase: string;
	nodes: WorkflowNode[];
	writeArtifacts: WorkflowWriteArtifact[];
	createdAt: string;
	updatedAt: string;
	result?: WorkflowJsonValue;
	error?: string;
}

export type WorkflowEventType =
	| "draft_created"
	| "draft_rejected"
	| "draft_expired"
	| "version_published"
	| "version_revoked"
	| "run_approved"
	| "run_started"
	| "phase_started"
	| "node_scheduled"
	| "agent_started"
	| "agent_completed"
	| "agent_failed"
	| "node_committed"
	| "write_captured"
	| "write_reviewed"
	| "write_apply_started"
	| "write_applied"
	| "write_rejected"
	| "write_blocked"
	| "write_unknown"
	| "run_paused"
	| "run_resumed"
	| "run_cancelled"
	| "run_blocked"
	| "run_completed"
	| "run_failed"
	| "result_delivery_prepared"
	| "result_delivered";

export interface WorkflowEvent {
	eventId: string;
	runId?: string;
	sequence: number;
	type: WorkflowEventType;
	timestamp: string;
	payload: Record<string, WorkflowJsonValue>;
}

export interface WorkflowAgentRequest {
	callId: string;
	nodeId: string;
	/** 所有可能影响本次调用结果的已审批输入哈希。 */
	inputHash: string;
	phase: string;
	/** Exact absolute execution directory bound to the user's approval. */
	scopeKey: string;
	prompt: string;
	agent?: string;
	model?: string | string[];
	label?: string;
	schema?: WorkflowJsonSchema;
	allowedTools: string[];
	writeMode: WorkflowWriteMode;
	/** Aggregate token budget still available when this node starts. */
	remainingTokenBudget: number;
	signal: AbortSignal;
}

export interface WorkflowAgentResult {
	agentId: string;
	value: WorkflowJsonValue;
	text: string;
	usage?: Usage;
	durationMs: number;
	patchPath?: string;
	branchName?: string;
	changesApplied?: boolean | null;
	/** Host-only isolated output. Workflow scripts can never observe this object. */
	writeArtifact?: WorkflowWriteArtifactCandidate;
}

export interface WorkflowWriteArtifactCandidate {
	repoRoot: string;
	artifactRoot: string;
	patchPath: string;
	scopeKey: string;
	baseline: WorktreeBaseline;
	nestedPatches: NestedRepoPatch[];
}

export interface WorkflowAgentBridge {
	run(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
}
