import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ContextCheckpoint, ContextPacketRecallLayer, TurnDigest } from "./types";

export const CONTEXT_PLAN_SCHEMA_VERSION = 1;
export const CONTEXT_PLAN_CUSTOM_TYPE = "san.context_plan";
export const CONTEXT_PLAN_MESSAGE_TYPE = "san.context_plan.injected";

export type ContextPlanSourceKind =
	| "exact"
	| "turn_bundle"
	| "tool_pair"
	| "file_evidence"
	| "attachment"
	| "turn_digest"
	| "checkpoint"
	| "recall"
	| "live_tail";
export type ContextPlanRepresentation = "exact" | "evidence_stub" | "digest" | "checkpoint" | "recall" | "omitted";
export type ContextPlanQualityOutcome = "pass" | "burst_required" | "hard_pressure";

export interface ContextPlanBudgetAudit {
	contextWindow: number;
	nonMessageTokens: number;
	steadyTarget: number;
	controlMax: number;
	burstCeiling: number;
	selectedInputLimit: number;
	selectedInputMode: "steady" | "burst";
	messageBudget: number;
	planTokenBudget: number;
	reserveTokens: number;
	reserveRatio: number;
}

export interface ContextPlanQualityGateAudit {
	outcome: ContextPlanQualityOutcome;
	reasons: string[];
	protectedEntryRefs: string[];
	missingEntryRefs: string[];
	requiredBurstTokens?: number;
	projectedInputTokens?: number;
	projectedInputLimit?: number;
}

export interface ContextPlanQualityGateOptions {
	sourceIndex: ContextSourceIndex;
	tokenEstimateByEntryRef?: ReadonlyMap<string, number>;
	baseRequiredEntryRefs?: readonly string[];
	currentPromptEntryRefs?: readonly string[];
	liveTailEntryRefs?: readonly string[];
	activeToolCallIds?: readonly string[];
	messageBudget: number;
	controlMax: number;
	burstCeiling: number;
	nonMessageTokens: number;
	projectedInputTokens?: number;
}

export interface ContextPlanMaterialAudit {
	materialId: string;
	kind: ContextPlanSourceKind;
	representation: ContextPlanRepresentation;
	entryRefs: string[];
	tokenEstimate: number;
	reason: string;
}

export interface ContextPlanExactSource {
	kind: "exact";
	entryId: string;
	message: AgentMessage;
}

export interface ContextPlanTurnBundleSource {
	kind: "turn_bundle";
	entryIds: string[];
	userEntryId?: string;
}

export interface ContextPlanToolPairSource {
	kind: "tool_pair";
	entryIds: string[];
	toolCallId: string;
	toolName?: string;
	assistantEntryId?: string;
	resultEntryId?: string;
	complete: boolean;
}

export interface ContextPlanFileEvidenceSource {
	kind: "file_evidence";
	entryId: string;
	paths: string[];
}

export interface ContextPlanAttachmentSource {
	kind: "attachment";
	entryId: string;
	customType: string;
}

export interface ContextPlanCoverageAudit {
	sourceEntryRefs: string[];
	replacementMaterialId: string;
	reason: string;
}

export interface ContextPlanAudit {
	schemaVersion: typeof CONTEXT_PLAN_SCHEMA_VERSION;
	planId: string;
	sessionId: string;
	epochId: string;
	rebaseReason?: ContextCheckpoint["rebaseReason"];
	promptGeneration: number;
	createdAt: string;
	budget: ContextPlanBudgetAudit;
	qualityGate: ContextPlanQualityGateAudit;
	materials: ContextPlanMaterialAudit[];
	coverage: ContextPlanCoverageAudit[];
}

export interface ContextPlanDigestMaterial {
	audit: ContextPlanMaterialAudit;
	entryId: string;
	digest: TurnDigest;
	coveredEntryRefs: string[];
}

export interface ContextPlanCheckpointMaterial {
	audit: ContextPlanMaterialAudit;
	entryId: string;
	checkpoint: ContextCheckpoint;
	coveredEntryRefs: string[];
}

export interface ContextPlanRecallMaterial {
	audit: ContextPlanMaterialAudit;
	recall: ContextPacketRecallLayer;
	coveredEntryRefs: string[];
}

export type ContextPlanMaterial = ContextPlanDigestMaterial | ContextPlanCheckpointMaterial | ContextPlanRecallMaterial;

export interface ContextPlanDigestSource {
	entryId: string;
	digest: TurnDigest;
	sourceEntryRefs: string[];
}

export interface ContextPlanCheckpointSource {
	entryId: string;
	checkpoint: ContextCheckpoint;
	coveredDigestEntryRefs: string[];
	coveredSourceEntryRefs: string[];
}

export interface ContextSourceIndex {
	exactEntries: ContextPlanExactSource[];
	turnBundles: ContextPlanTurnBundleSource[];
	toolPairs: ContextPlanToolPairSource[];
	fileEvidence: ContextPlanFileEvidenceSource[];
	attachments: ContextPlanAttachmentSource[];
	digests: ContextPlanDigestSource[];
	checkpoints: ContextPlanCheckpointSource[];
	entryIds: string[];
}

export interface BuiltContextPlan {
	audit: ContextPlanAudit;
	materials: ContextPlanMaterial[];
	sourceIndex: ContextSourceIndex;
	requestKey: string;
	renderedContent: string;
	message: AgentMessage;
	tokenEstimate: number;
	coverageEntryRefs: string[];
}

export interface ContextPlanCoverageValidationIssue {
	code:
		| "coverage_without_material"
		| "coverage_missing_source_ref"
		| "coverage_outside_material"
		| "coverage_duplicate_source_ref"
		| "material_audit_missing"
		| "material_audit_mismatch";
	message: string;
	materialId?: string;
	entryRef?: string;
}

export interface ContextPlanCoverageValidationResult {
	valid: boolean;
	coveredEntryRefs: string[];
	issues: ContextPlanCoverageValidationIssue[];
}
