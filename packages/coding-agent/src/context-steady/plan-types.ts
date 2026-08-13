import type { AgentMessage } from "@san/agent";
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
	requiredTokens: number;
	selectedInputTokens: number;
	activeEntryCount: number;
	archivedEntryCount: number;
	activeCutoffEntryId?: string;
	maintenanceId?: string;
	recoveryAttempt?: number;
	requiredBurstTokens?: number;
	projectedInputTokens?: number;
	projectedInputLimit?: number;
	/** 应急降级档:hard_pressure 前把这些非保护已闭合工具输出降为 stub 可挽回超额。 */
	emergencyStubEntryRefs?: string[];
	/** 应急降级预计挽回的 token(estimates 缺失的候选按 0 计)。 */
	emergencyStubReclaimedTokens?: number;
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
	activeEntryCount?: number;
	archivedEntryCount?: number;
	activeCutoffEntryId?: string;
	maintenanceId?: string;
	recoveryAttempt?: number;
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
	/** 文件修改类工具的目标路径(从 toolCall 参数提取;仅 mutation 工具设置)。 */
	path?: string;
	/** 同一路径后续又有完整 mutation 时,指向取代它的那次调用。 */
	supersededByToolCallId?: string;
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
	/** 渲染粒度(decay 选级;缺省 full)。coverage 语义与粒度无关。 */
	tier?: "full" | "compact" | "anchor";
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

/**
 * Superseded mutation 的表示降级材料:物化层把 `resultEntryId` 对应的
 * toolResult 内容替换为小型 stub(保留 tool 配对),消息本身不省略。
 * 刻意不授权 coverage(`coveredEntryRefs` 恒为空)— 它走"替换"而非"省略",
 * 不进 coverage 校验的省略路径。
 */
export interface ContextPlanToolStubMaterial {
	audit: ContextPlanMaterialAudit;
	toolCallId: string;
	resultEntryId: string;
	path?: string;
	/** 降级来源:superseded(同文件后续 mutation)或 emergency(压力应急档)。 */
	stubKind?: "superseded" | "emergency";
	coveredEntryRefs: string[];
}

export type ContextPlanMaterial =
	| ContextPlanDigestMaterial
	| ContextPlanCheckpointMaterial
	| ContextPlanRecallMaterial
	| ContextPlanToolStubMaterial;

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
	message: Extract<AgentMessage, { role: "custom" }>;
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
