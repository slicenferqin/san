import type { AgentMessage } from "@san/agent";
import type { ContextCheckpoint, ContextPacketRecallLayer, TurnDigest } from "./types";
import type { ContextWorkNoteProjection } from "./working-notes";

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
	| "working_note"
	| "live_tail"

	/** Audit-only: no runtime material exists; marks degraded history representation. */
	| "representation"
	| "goal_anchor";
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
	/**
	 * 最新一批尚未被模型消费的 toolResult entry:它们刚落地、还没有进入任何
	 * 已完成的模型回合,降级就等于删掉本轮唯一的新事实。保护到下一次真正
	 * 消费它们的模型请求为止,之后自然老去。
	 */
	latestBatchEntryRefs?: readonly string[];
	/**
	 * 已确认可读回原文的 stub 候选;undefined = 本轮不限制(提议 pass:宿主尚未
	 * 捕获)。应急降级只允许计入可替换的条目 —— 否则审计会声称回收了一个物化层
	 * 根本不会替换的输出。
	 */
	eligibleStubEntryRefs?: ReadonlySet<string>;
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

export interface ContextPlanReadIdentity {
	/** 调用 read 时使用的源路径与选择器；仅用于 provider projection。 */
	path: string;
	selector: string;
	/** 同一读取结果内容的稳定快照指纹。 */
	snapshot: string;
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
	/** 原始工具结果自身的失败状态(截断是另一回事):降级后必须仍然可见。 */
	isError?: boolean;
	/** 完全相同 read 结果的源身份,仅用于 provider projection 去重。 */
	readIdentity?: ContextPlanReadIdentity;
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

/**
 * Net-benefit gate outcome, measured on the final provider projection:
 * `rawProjectedTokens - projectedTokens` (plan wire cost included in the latter).
 * `withdrawn: true` means only derived replacement was revoked — raw history,
 * the current prompt, and tool calls are untouched.
 */
export interface ContextPlanNetBenefitAudit {
	rawProjectedTokens: number;
	projectedTokens: number;
	netBenefit: number;
	withdrawn: boolean;
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
	netBenefit?: ContextPlanNetBenefitAudit;
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
	toolName?: string;
	path?: string;
	/** Replacement kind; previews retain fresh output instead of aging it. */
	stubKind?: "superseded" | "emergency" | "aged" | "duplicate" | "preview";
	/** Per-result body bytes, chosen only when the complete request cannot fit. */
	previewBytes?: number;
	/**
	 * 原文恢复入口(宿主在替换前确认可读)。**没有**该字段的条目不允许被投影替换:
	 * 无法保证读回原文时,唯一安全的行为是保留原始结果不动。
	 */
	recovery?: ContextPlanToolStubRecovery;
	coveredEntryRefs: string[];
}

/**
 * 降级 stub 的原文恢复入口。`artifactId` 必须能被 read 工具按
 * `artifact://<id>` 解析回原文,否则不得写入该字段(stub 不得声称一个读不回来的副本)。
 */
export interface ContextPlanToolStubRecovery {
	kind: "artifact";
	artifactId: string;
	/**
	 * 引用来源语义。`existing` 是历史里本就存在的同一份原文引用(该 toolResult
	 * 自己 meta 里的 artifactId,或本会话内已可见的引用),`captured` 是宿主在
	 * 替换前落盘并验证可读的本条原文。两者都能读回,但 `existing` 的 id 不保证
	 * 是"本条输出刚产生时"的快照,文案不得把它当成当前文件内容的替代。
	 */
	source: "existing" | "captured";
}

/** 调用方(会话宿主)注入的目标锚事实;objective 为空时不建锚材料。 */
export interface ContextPlanGoalAnchorInput {
	/** 权威用户目标原文(不可变契约的 authoritative turn 文本,调用方截断)。 */
	objective: string;
	/** todo 进度快照行(如 "[x] 完成 A"),调用方压平并截断。 */
	todoLines?: readonly string[];
	/** 未满足的 before-done 证据门描述(skill 证据链会话)。 */
	pendingGates?: readonly string[];
}

/**
 * 目标锚材料(graph/goal-fidelity 研究方案 A):把不可变契约目标与进度快照
 * 作为常驻一等材料渲染进每次请求的 plan 消息 — 模型每步看见目标,但谁也
 * 改不了目标。永不参与预算裁剪(fit 只裁 recall/digest/checkpoint),
 * 永不授权 coverage。
 */
export interface ContextPlanGoalAnchorMaterial {
	audit: ContextPlanMaterialAudit;
	objective: string;
	todoLines: string[];
	pendingGates: string[];
	/** 最新 digest 的 nextSteps(planner 内部补充)。 */
	nextSteps: string[];
	coveredEntryRefs: string[];
}

export interface ContextPlanWorkingNoteMaterial {
	audit: ContextPlanMaterialAudit;
	note: ContextWorkNoteProjection;
	coveredEntryRefs: string[];
}

export type ContextPlanMaterial =
	| ContextPlanDigestMaterial
	| ContextPlanCheckpointMaterial
	| ContextPlanRecallMaterial
	| ContextPlanToolStubMaterial
	| ContextPlanWorkingNoteMaterial
	| ContextPlanGoalAnchorMaterial;

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
	/**
	 * 从历史中直接可见的 artifact 引用:assistant 工具参数里的
	 * `artifact://<id>` 和 toolResult.details.meta.truncation.artifactId。
	 * 让降级 stub 复用**已经存在**的原文引用,而不是把只是"显示截断"的
	 * 结果误判成内容已丢失。
	 */
	artifactRefs?: ContextPlanArtifactRef[];
}

export interface ContextPlanArtifactRef {
	/** 可由 read 工具解析回逐字节原文的 artifact id(纯数字)。 */
	artifactId: string;
	/** 该引用的来源 journal entry(assistant toolCall 或 toolResult)。 */
	entryId?: string;
	/** toolCallId,用于把引用关联回工具对。 */
	toolCallId?: string;
	/**
	 * 引用的来源语义。`result_metadata` 是**该结果自身**的原文引用,可以安全地
	 * 当作这条 result 的恢复入口;`assistant_tool_call` 只是某个 assistant 参数
	 * 里出现过的 URL(例如模型自己 `read artifact://7`),它属于那次调用的**输入**,
	 * 不是这次结果的字节副本,复用它会把另一份内容冒充成本条输出。
	 */
	origin: "assistant_tool_call" | "result_metadata";
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
	/**
	 * Net-benefit gate rejected the plan: materialization must skip coverage,
	 * stub substitution, and plan-message injection (raw history preserved).
	 */
	withdrawn?: boolean;
	/**
	 * "pinned" (stable-projection mode): the plan message is injected at the
	 * payload head and its bytes are frozen for the whole epoch. "floating"
	 * (legacy): injected before the last user message, rebuilt per turn.
	 */
	projectionMode?: "floating" | "pinned";
	/**
	 * Session-level stable-epoch identity stamped by AgentSession when the plan
	 * is laid out (rebase checkpoint + compaction + window + topic-shift epoch).
	 * Same key ⇒ the frozen artifact is reusable verbatim.
	 */
	epochKey?: string;
	/**
	 * Projection offload switches carried on the plan so every materialize /
	 * estimate path applies them uniformly: aged tool outputs are stub materials
	 * (no flag needed here); images are content substitution below.
	 */
	offloadAgedImages?: boolean;
	/**
	 * Pressure-valve preview truncations applied to tool results (per entry:
	 * bytes). Carried on the plan so re-gates in the same epoch re-apply the
	 * same truncation to those entries instead of resurrecting an oversized
	 * body once a newer result displaces it from the latest batch.
	 */
	previewTruncatedToolResults?: Array<{ resultEntryId: string; previewBytes: number }>;
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
