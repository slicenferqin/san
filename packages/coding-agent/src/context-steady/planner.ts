import type { AgentMessage } from "@san/agent";
import { estimateTokens } from "@san/agent/compaction";
import type { SessionEntry } from "../session/session-entries";
import type { ContextPlanBudgetSettings } from "./budget";
import { resolveContextPlanBudget } from "./budget";
import { projectDigestTier, selectDigestTier } from "./decay";
import { renderContextPlanContent } from "./materialize";
import {
	type BuiltContextPlan,
	CONTEXT_PLAN_CUSTOM_TYPE,
	CONTEXT_PLAN_MESSAGE_TYPE,
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanAudit,
	type ContextPlanCoverageAudit,
	type ContextPlanDigestMaterial,
	type ContextPlanDigestSource,
	type ContextPlanGoalAnchorInput,
	type ContextPlanGoalAnchorMaterial,
	type ContextPlanMaterial,
	type ContextPlanRecallMaterial,
	type ContextPlanToolStubMaterial,
	type ContextSourceIndex,
} from "./plan-types";
import { evaluateContextPlanQualityGate } from "./quality-gate";
import {
	isCheckpointRelevantToPrompt,
	isContinuationPrompt,
	isDigestRelevantToPrompt,
	isTopicShiftPrompt,
} from "./relevance";
import { buildContextSourceIndex } from "./source-index";
import type { ContextPacketRecallLayer } from "./types";

export interface BuildContextPlanOptions {
	entries: readonly SessionEntry[];
	sessionId: string;
	requestKey: string;
	epochId: string;
	promptGeneration: number;
	settings: ContextPlanBudgetSettings;
	contextWindow: number;
	nonMessageTokens: number;
	baseRequiredEntryRefs?: readonly string[];
	currentPromptEntryRefs?: readonly string[];
	liveTailEntryRefs?: readonly string[];
	activeToolCallIds?: readonly string[];
	tokenEstimateByEntryRef?: ReadonlyMap<string, number>;
	projectedInputTokens?: number;
	activeEntryCount?: number;
	archivedEntryCount?: number;
	activeCutoffEntryId?: string;
	maintenanceId?: string;
	recoveryAttempt?: number;
	recall?: ContextPacketRecallLayer;
	maxDigestMaterials?: number;
	createdAt?: string;
	rebaseReason?: ContextPlanAudit["rebaseReason"];
	/** Current user prompt text for relevance / topic-shift material selection. */
	currentPromptText?: string;
	/**
	 * Stable-projection mode: pin the plan message at the payload head, freeze
	 * its bytes for the epoch, and keep recall out of the rendered plan (it
	 * ships via the independent volatile channel instead).
	 */
	stableProjection?: boolean;
	/**
	 * Epoch-frozen digest/checkpoint materials reused verbatim on a gate
	 * recompute — pressure rebuilds must not reselect history representation.
	 */
	frozenMaterials?: readonly ContextPlanMaterial[];
	/** M4 aged tool-output offload: stub old, large, non-protected results. */
	toolOutputOffload?: { minTokens: number };
	/** M4 image offload: replace earlier-turn image blocks with a re-reference marker. */
	offloadAgedImages?: boolean;
	/** 目标锚事实(宿主注入);缺省或 objective 为空时不产生锚材料。 */
	goalAnchor?: ContextPlanGoalAnchorInput;
}

function materialTokenEstimate(value: unknown): number {
	return estimateTokens({ role: "user", content: JSON.stringify(value), timestamp: Date.now() });
}

function materialId(prefix: string, entryId: string): string {
	return `${prefix}_${entryId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function buildRecallMaterial(recall: ContextPacketRecallLayer | undefined): ContextPlanRecallMaterial | undefined {
	if (!recall || recall.items.length === 0) return undefined;
	const id = `recall_${crypto.randomUUID().slice(-12)}`;
	return {
		audit: {
			materialId: id,
			kind: "recall",
			representation: "recall",
			entryRefs: recall.items.map((item, index) => item.id ?? `recall:${index + 1}`),
			tokenEstimate: materialTokenEstimate(recall),
			reason: "retrieved context for current request",
		},
		recall,
		coveredEntryRefs: [],
	};
}

function estimateExactEntry(sourceIndex: ContextSourceIndex, entryId: string): number {
	const exact = sourceIndex.exactEntries.find(entry => entry.entryId === entryId);
	return exact ? estimateTokens(exact.message) : 0;
}

function buildExactAuditMaterials(
	sourceIndex: ContextSourceIndex,
	protectedEntryRefs: readonly string[],
): ContextPlanAudit["materials"] {
	return protectedEntryRefs
		.filter(entryRef => sourceIndex.entryIds.includes(entryRef))
		.map(entryRef => ({
			materialId: materialId("exact", entryRef),
			kind: "exact",
			representation: "exact",
			entryRefs: [entryRef],
			tokenEstimate: estimateExactEntry(sourceIndex, entryRef),
			reason: "protected exact context",
		}));
}

function buildEvidenceStubAuditMaterials(sourceIndex: ContextSourceIndex): ContextPlanAudit["materials"] {
	return sourceIndex.fileEvidence.map(source => ({
		materialId: materialId("evidence", source.entryId),
		kind: "file_evidence",
		representation: "evidence_stub",
		entryRefs: [source.entryId],
		tokenEstimate: materialTokenEstimate(source.paths),
		reason: "file evidence stub",
	}));
}

/** Stub 替换文本很小且尺寸稳定;审计用固定估算,避免为它渲染真实模板。 */
const TOOL_STUB_TOKEN_ESTIMATE = 40;

/** 目标锚各字段的裁剪上限:锚必须恒小(几百 token 封顶),永不与内容材料争预算。 */
const GOAL_ANCHOR_LIMITS = {
	objectiveChars: 480,
	todoLines: 8,
	pendingGates: 4,
	nextSteps: 3,
	lineChars: 160,
} as const;

function clampAnchorLine(value: string): string {
	return value.length <= GOAL_ANCHOR_LIMITS.lineChars ? value : `${value.slice(0, GOAL_ANCHOR_LIMITS.lineChars - 1)}…`;
}

/**
 * 目标锚材料(goal-fidelity 方案 A):不可变契约目标 + 进度快照,每次请求
 * 常驻 plan 消息。fit 只裁 recall/digest/checkpoint,锚天然不可裁;不授权
 * coverage。objective 为空不建锚。
 */
function buildGoalAnchorMaterial(
	input: ContextPlanGoalAnchorInput | undefined,
	sourceIndex: ContextSourceIndex,
): ContextPlanGoalAnchorMaterial | undefined {
	const objective = input?.objective.trim();
	if (!objective) return undefined;
	const latestDigest = sourceIndex.digests.at(-1)?.digest;
	const material: ContextPlanGoalAnchorMaterial = {
		audit: {
			materialId: `goal_anchor_${crypto.randomUUID().slice(-12)}`,
			kind: "goal_anchor",
			representation: "exact",
			entryRefs: [],
			tokenEstimate: 0,
			reason: "host-pinned objective and progress anchor (immutable contract projection)",
		},
		objective:
			objective.length <= GOAL_ANCHOR_LIMITS.objectiveChars
				? objective
				: `${objective.slice(0, GOAL_ANCHOR_LIMITS.objectiveChars - 1)}…`,
		todoLines: (input?.todoLines ?? []).slice(0, GOAL_ANCHOR_LIMITS.todoLines).map(clampAnchorLine),
		pendingGates: (input?.pendingGates ?? []).slice(0, GOAL_ANCHOR_LIMITS.pendingGates).map(clampAnchorLine),
		nextSteps: (latestDigest?.nextSteps ?? []).slice(0, GOAL_ANCHOR_LIMITS.nextSteps).map(clampAnchorLine),
		coveredEntryRefs: [],
	};
	material.audit.tokenEstimate = materialTokenEstimate(material);
	return material;
}

/**
 * Superseded mutation 的表示降级材料(magic-context 研究 §4.4):同一文件
 * 存在更晚完整 mutation 时,旧 toolResult 的 diff/输出已无信息量,物化层
 * 将其替换为小型 stub。保护集内的 entry(活跃文件、最近工具对等 quality
 * gate 八项保护)一律跳过;不授权 coverage,不参与省略路径。
 */
function buildToolStubMaterials(
	sourceIndex: ContextSourceIndex,
	protectedEntryRefs: readonly string[],
	emergencyStubEntryRefs: readonly string[] = [],
	agedOffload?: {
		tokenEstimateByEntryRef?: ReadonlyMap<string, number>;
		minTokens: number;
		budgetTokens: number;
	},
): ContextPlanToolStubMaterial[] {
	const protectedRefs = new Set(protectedEntryRefs);
	const materials: ContextPlanToolStubMaterial[] = [];
	const stubbedResultRefs = new Set<string>();
	for (const pair of sourceIndex.toolPairs) {
		if (pair.supersededByToolCallId === undefined || pair.resultEntryId === undefined) continue;
		if (protectedRefs.has(pair.resultEntryId)) continue;
		if (pair.assistantEntryId !== undefined && protectedRefs.has(pair.assistantEntryId)) continue;
		stubbedResultRefs.add(pair.resultEntryId);
		materials.push({
			audit: {
				materialId: materialId("tool_stub", pair.resultEntryId),
				kind: "tool_pair",
				representation: "evidence_stub",
				entryRefs: [pair.resultEntryId],
				tokenEstimate: TOOL_STUB_TOKEN_ESTIMATE,
				reason: `superseded ${pair.toolName ?? "mutation"} output for ${pair.path ?? "unknown path"}`,
			},
			toolCallId: pair.toolCallId,
			resultEntryId: pair.resultEntryId,
			...(pair.toolName ? { toolName: pair.toolName } : {}),
			...(pair.path ? { path: pair.path } : {}),
			stubKind: "superseded",
			coveredEntryRefs: [],
		});
	}
	// 应急降级档(§4.3):quality gate 判定的可挽回集合;superseded 已覆盖的
	// 条目不重复建材料。
	if (emergencyStubEntryRefs.length > 0) {
		const pairByResultRef = new Map(
			sourceIndex.toolPairs
				.filter(pair => pair.resultEntryId !== undefined)
				.map(pair => [pair.resultEntryId as string, pair]),
		);
		for (const resultEntryId of emergencyStubEntryRefs) {
			if (stubbedResultRefs.has(resultEntryId)) continue;
			const pair = pairByResultRef.get(resultEntryId);
			if (!pair) continue;
			stubbedResultRefs.add(resultEntryId);
			materials.push({
				audit: {
					materialId: materialId("tool_stub", resultEntryId),
					kind: "tool_pair",
					representation: "evidence_stub",
					entryRefs: [resultEntryId],
					tokenEstimate: TOOL_STUB_TOKEN_ESTIMATE,
					reason: `emergency pressure downgrade of ${pair.toolName ?? "tool"} output`,
				},
				toolCallId: pair.toolCallId,
				resultEntryId,
				...(pair.toolName ? { toolName: pair.toolName } : {}),
				...(pair.path ? { path: pair.path } : {}),
				stubKind: "emergency",
				coveredEntryRefs: [],
			});
		}
	}
	// 完全相同的 read 源身份只保留一份 provider 原文。若 quality gate
	// 保护了多个相同副本，保留最新受保护副本并把其余替换为可重读 stub：
	// 内容快照一致，所以这是表示去重而不是语义省略。journal/tool pair 不变。
	if (agedOffload) {
		const duplicateGroups = new Map<string, typeof sourceIndex.toolPairs>();
		for (const pair of sourceIndex.toolPairs) {
			const identity = pair.readIdentity;
			if (pair.toolName !== "read" || !pair.complete || pair.resultEntryId === undefined || identity === undefined)
				continue;
			const key = `${identity.path}\0${identity.selector}\0${identity.snapshot}`;
			const group = duplicateGroups.get(key);
			if (group) group.push(pair);
			else duplicateGroups.set(key, [pair]);
		}
		for (const group of duplicateGroups.values()) {
			if (group.length < 2) continue;
			const retainedPair =
				group.findLast(
					pair =>
						pair.resultEntryId !== undefined &&
						(protectedRefs.has(pair.resultEntryId) ||
							(pair.assistantEntryId !== undefined && protectedRefs.has(pair.assistantEntryId))),
				) ?? group.at(-1);
			const retainedResultEntryId = retainedPair?.resultEntryId;
			if (!retainedResultEntryId) continue;
			for (const pair of group) {
				if (pair.resultEntryId === undefined || pair.resultEntryId === retainedResultEntryId) continue;
				if (stubbedResultRefs.has(pair.resultEntryId)) continue;
				const identity = pair.readIdentity;
				if (!identity) continue;
				stubbedResultRefs.add(pair.resultEntryId);
				materials.push({
					audit: {
						materialId: materialId("tool_stub", pair.resultEntryId),
						kind: "tool_pair",
						representation: "evidence_stub",
						entryRefs: [pair.resultEntryId],
						tokenEstimate: TOOL_STUB_TOKEN_ESTIMATE,
						reason: `duplicate read output for ${identity.path}`,
					},
					toolCallId: pair.toolCallId,
					resultEntryId: pair.resultEntryId,
					toolName: "read",
					path: identity.path,
					stubKind: "duplicate",
					coveredEntryRefs: [],
				});
			}
		}
	}

	// 常规年龄卸载档(M4):保护集之外、超出最小体积的旧完整工具输出
	// oldest-first 换成可重读引用 stub,直到预算耗尽。消息保留、仅内容
	// 降级;原文永在 journal。live tail 已在保护集内,近期结果不受影响。
	if (agedOffload) {
		let reclaimed = 0;
		for (const pair of sourceIndex.toolPairs) {
			if (agedOffload.budgetTokens > 0 && reclaimed >= agedOffload.budgetTokens) break;
			if (!pair.complete || pair.resultEntryId === undefined) continue;
			if (stubbedResultRefs.has(pair.resultEntryId)) continue;
			if (protectedRefs.has(pair.resultEntryId)) continue;
			if (pair.assistantEntryId !== undefined && protectedRefs.has(pair.assistantEntryId)) continue;
			const estimate = Math.max(0, Math.floor(agedOffload.tokenEstimateByEntryRef?.get(pair.resultEntryId) ?? 0));
			if (estimate < agedOffload.minTokens) continue;
			const reclaimable = estimate - TOOL_STUB_TOKEN_ESTIMATE;
			if (reclaimable <= 0) continue;
			stubbedResultRefs.add(pair.resultEntryId);
			reclaimed += reclaimable;
			materials.push({
				audit: {
					materialId: materialId("tool_stub", pair.resultEntryId),
					kind: "tool_pair",
					representation: "evidence_stub",
					entryRefs: [pair.resultEntryId],
					tokenEstimate: TOOL_STUB_TOKEN_ESTIMATE,
					reason: `aged ${pair.toolName ?? "tool"} output offload (${estimate} tokens; re-readable via ${pair.path ?? "session journal"})`,
				},
				toolCallId: pair.toolCallId,
				resultEntryId: pair.resultEntryId,
				...(pair.toolName ? { toolName: pair.toolName } : {}),
				...(pair.path ? { path: pair.path } : {}),
				stubKind: "aged",
				coveredEntryRefs: [],
			});
		}
	}
	return materials;
}

/** Non-continuation prompts use relevance to drop unrelated derived history. */
function checkpointRelevanceRequired(promptText: string): boolean {
	const topicShift = promptText.length > 0 && isTopicShiftPrompt(promptText);
	const continuation = promptText.length > 0 && isContinuationPrompt(promptText);
	// Explicit topic shift always drops; natural topic changes use soft relevance.
	return promptText.length > 0 && (topicShift || !continuation);
}

function digestRelevanceRequired(promptText: string): boolean {
	return checkpointRelevanceRequired(promptText);
}

/** Shared digest-material construction for planner and checkpoint-restore paths. */
function buildDigestMaterial(
	source: ContextPlanDigestSource,
	ageRank: number,
	contextPressure: number,
): ContextPlanDigestMaterial {
	const canCoverSource = source.digest.fallback !== true;
	// Decay 选级:候选集旧→新有序,ageRank 0 = 最新。渲染粒度随年龄与
	// 预算压力确定性降级;coverage 授权与粒度无关(原文可经 context_expand 取回)。
	const tier = selectDigestTier(ageRank, contextPressure);
	return {
		audit: {
			materialId: materialId("digest", source.entryId),
			kind: "turn_digest",
			representation: "digest",
			entryRefs: [source.entryId],
			tokenEstimate: materialTokenEstimate(projectDigestTier(source.digest, tier)),
			reason: `${canCoverSource ? "recent settled turn digest" : "fallback digest for reference only"} (tier: ${tier})`,
		},
		entryId: source.entryId,
		digest: source.digest,
		coveredEntryRefs: canCoverSource ? source.sourceEntryRefs : [],
		tier,
	};
}

function buildMaterials(
	sourceIndex: ContextSourceIndex,
	maxDigestMaterials: number,
	recall: ContextPacketRecallLayer | undefined,
	planTokenBudget: number,
	currentPromptText: string | undefined,
	contextPressure: number,
): ContextPlanMaterial[] {
	const materials: ContextPlanMaterial[] = [];
	let remainingBudget = Math.max(0, Math.floor(planTokenBudget));
	const latestCheckpoint = sourceIndex.checkpoints.at(-1);
	const coveredDigestRefs = new Set(latestCheckpoint?.coveredDigestEntryRefs ?? []);
	const promptText = currentPromptText?.trim() ?? "";
	const topicShift = promptText.length > 0 && isTopicShiftPrompt(promptText);
	const continuation = promptText.length > 0 && isContinuationPrompt(promptText);
	// Non-continuation prompts use relevance to drop unrelated derived history.
	// Explicit topic shift always drops; natural topic changes use soft relevance.
	const requireRelevance = promptText.length > 0 && (topicShift || !continuation);
	const includeCheckpoint =
		!!latestCheckpoint &&
		(!requireRelevance || isCheckpointRelevantToPrompt(promptText, latestCheckpoint.checkpoint));
	if (latestCheckpoint && includeCheckpoint) {
		const checkpointEstimate = latestCheckpoint.checkpoint.tokenEstimate;
		materials.push({
			audit: {
				materialId: materialId("checkpoint", latestCheckpoint.entryId),
				kind: "checkpoint",
				representation: "checkpoint",
				entryRefs: [latestCheckpoint.entryId],
				tokenEstimate: latestCheckpoint.checkpoint.tokenEstimate,
				reason: "latest stable checkpoint",
			},
			entryId: latestCheckpoint.entryId,
			checkpoint: latestCheckpoint.checkpoint,
			// Source-index already strips fallback-digest spans from coverage.
			coveredEntryRefs: latestCheckpoint.coveredSourceEntryRefs,
		});
		remainingBudget -= checkpointEstimate;
	}

	const selectedDigests = sourceIndex.digests
		.filter(source => !coveredDigestRefs.has(source.entryId) || !includeCheckpoint)
		.filter(source => !requireRelevance || isDigestRelevantToPrompt(promptText, source.digest))
		.slice(-Math.max(0, Math.floor(maxDigestMaterials)));
	for (const [index, source] of selectedDigests.entries()) {
		const canCoverSource = source.digest.fallback !== true;
		// Decay 选级:selectedDigests 旧→新有序,ageRank 0 = 最新。渲染粒度
		// 随年龄与预算压力确定性降级;coverage 授权与粒度无关(原文可经
		// context_expand 取回)。
		const ageRank = selectedDigests.length - 1 - index;
		const tier = selectDigestTier(ageRank, contextPressure);
		const estimate = materialTokenEstimate(projectDigestTier(source.digest, tier));
		if (estimate > remainingBudget) continue;
		const material: ContextPlanDigestMaterial = {
			audit: {
				materialId: materialId("digest", source.entryId),
				kind: "turn_digest",
				representation: "digest",
				entryRefs: [source.entryId],
				tokenEstimate: estimate,
				reason: `${canCoverSource ? "recent settled turn digest" : "fallback digest for reference only"} (tier: ${tier})`,
			},
			entryId: source.entryId,
			digest: source.digest,
			coveredEntryRefs: canCoverSource ? source.sourceEntryRefs : [],
			tier,
		};
		materials.push(material);
		remainingBudget -= estimate;
	}

	const recallMaterial = buildRecallMaterial(recall);
	if (recallMaterial && recallMaterial.audit.tokenEstimate <= remainingBudget) materials.push(recallMaterial);
	return materials;
}

function buildCoveredCheckpointDigestMaterials(
	sourceIndex: ContextSourceIndex,
	maxDigestMaterials: number,
	currentPromptText: string | undefined,
	contextPressure: number,
): ContextPlanDigestMaterial[] {
	const latestCheckpoint = sourceIndex.checkpoints.at(-1);
	if (!latestCheckpoint) return [];
	const coveredDigestRefs = new Set(latestCheckpoint.coveredDigestEntryRefs);
	const promptText = currentPromptText?.trim() ?? "";
	const requireRelevance = digestRelevanceRequired(promptText);
	const selectedDigests = sourceIndex.digests
		.filter(source => coveredDigestRefs.has(source.entryId))
		.filter(source => !requireRelevance || isDigestRelevantToPrompt(promptText, source.digest))
		.slice(-Math.max(0, Math.floor(maxDigestMaterials)));
	return selectedDigests.map((source, index) =>
		buildDigestMaterial(source, selectedDigests.length - 1 - index, contextPressure),
	);
}

/**
 * Drop lowest-priority derived materials until the rendered plan fits planTokenBudget.
 * Protected exact/live materials are not part of this rendered content.
 */
function fitMaterialsToPlanBudget(
	materials: ContextPlanMaterial[],
	planTokenBudget: number,
	buildAudit: (materials: ContextPlanMaterial[]) => ContextPlanAudit,
	coveredCheckpointDigests: readonly ContextPlanDigestMaterial[],
): { materials: ContextPlanMaterial[]; audit: ContextPlanAudit; renderedContent: string; tokenEstimate: number } {
	let selected = materials;
	let restoredCheckpointDigests = false;
	for (;;) {
		const audit = buildAudit(selected);
		const renderedContent = renderContextPlanContent({ audit, materials: selected });
		const tokenEstimate = estimateContextPlanWireTokens(renderedContent);
		if (planTokenBudget <= 0 || tokenEstimate <= planTokenBudget) {
			return { materials: selected, audit, renderedContent, tokenEstimate };
		}
		if (selected.length === 0) return { materials: selected, audit, renderedContent, tokenEstimate };
		// Drop recall first, then oldest digests. If the checkpoint itself still
		// cannot fit, restore the digest candidates it had suppressed before
		// continuing the same final-wire fitting loop.
		const recallIndex = selected.findIndex(material => "recall" in material);
		if (recallIndex >= 0) {
			selected = selected.filter((_, index) => index !== recallIndex);
			continue;
		}
		const firstDigestIndex = selected.findIndex(material => "digest" in material);
		if (firstDigestIndex >= 0) {
			selected = selected.filter((_, index) => index !== firstDigestIndex);
			continue;
		}
		const checkpointIndex = selected.findIndex(material => "checkpoint" in material);
		if (checkpointIndex >= 0) {
			selected = selected.filter((_, index) => index !== checkpointIndex);
			if (!restoredCheckpointDigests) {
				// Prepend (oldest first) so the subsequent drop-oldest iterations
				// sacrifice restored covered digests before fresher uncovered ones.
				const presentDigestRefs = new Set(
					selected.flatMap(material => ("digest" in material ? [material.entryId] : [])),
				);
				selected = [
					...coveredCheckpointDigests.filter(material => !presentDigestRefs.has(material.entryId)),
					...selected,
				];
				restoredCheckpointDigests = true;
			}
			continue;
		}
		return { materials: selected, audit, renderedContent, tokenEstimate };
	}
}

function buildOmittedAuditMaterials(
	sourceIndex: ContextSourceIndex,
	runtimeMaterials: readonly ContextPlanMaterial[],
	checkpointExcludedByRelevance: boolean,
): ContextPlanAudit["materials"] {
	const representedDigestRefs = new Set(
		runtimeMaterials.flatMap(material => ("digest" in material ? [material.entryId] : [])),
	);
	const admittedCheckpoint = runtimeMaterials.find(material => "checkpoint" in material);
	const checkpointCoveredRefs = new Set(
		admittedCheckpoint && "checkpoint" in admittedCheckpoint
			? (sourceIndex.checkpoints.find(checkpoint => checkpoint.entryId === admittedCheckpoint.entryId)
					?.coveredDigestEntryRefs ?? [])
			: [],
	);
	const omittedDigests: ContextPlanAudit["materials"] = sourceIndex.digests
		.filter(source => !representedDigestRefs.has(source.entryId) && !checkpointCoveredRefs.has(source.entryId))
		.map(source => ({
			materialId: materialId("omitted", source.entryId),
			kind: "turn_digest",
			representation: "omitted",
			entryRefs: [source.entryId],
			tokenEstimate: materialTokenEstimate(source.digest),
			reason: "outside ContextPlan material budget or window",
		}));
	const latestCheckpoint = sourceIndex.checkpoints.at(-1);
	const checkpointAdmitted =
		latestCheckpoint !== undefined &&
		runtimeMaterials.some(material => "checkpoint" in material && material.entryId === latestCheckpoint.entryId);
	const checkpointOmission: ContextPlanAudit["materials"] =
		!latestCheckpoint || checkpointAdmitted
			? []
			: [
					{
						materialId: materialId("omitted_checkpoint", latestCheckpoint.entryId),
						kind: "checkpoint",
						representation: "omitted",
						entryRefs: [latestCheckpoint.entryId],
						tokenEstimate: latestCheckpoint.checkpoint.tokenEstimate,
						reason: checkpointExcludedByRelevance
							? "checkpoint excluded by prompt relevance gate"
							: "checkpoint did not fit the final ContextPlan wire budget",
					},
				];
	// No checkpoint AND no digest made it in while history existed to represent:
	// surface the degradation instead of letting representation silently vanish.
	const representationDegraded =
		runtimeMaterials.every(material => !("checkpoint" in material || "digest" in material)) &&
		sourceIndex.digests.length > 0;
	const degradationEntry: ContextPlanAudit["materials"] = representationDegraded
		? [
				{
					materialId: `representation_${latestCheckpoint?.entryId ?? "none"}`,
					kind: "representation",
					representation: "omitted",
					entryRefs: [],
					tokenEstimate: 0,
					reason:
						"history representation degraded: no checkpoint or turn digest admitted; recall is the only derived context",
				},
			]
		: [];
	return [...omittedDigests, ...checkpointOmission, ...degradationEntry];
}

function coverageForMaterials(
	materials: readonly ContextPlanMaterial[],
	protectedEntryRefs: readonly string[],
	entryIds: readonly string[],
): ContextPlanCoverageAudit[] {
	const protectedRefs = new Set(protectedEntryRefs);
	const validEntryIds = new Set(entryIds);
	const coverage: ContextPlanCoverageAudit[] = [];
	for (const material of materials) {
		const sourceEntryRefs = material.coveredEntryRefs.filter(
			entryRef => validEntryIds.has(entryRef) && !protectedRefs.has(entryRef),
		);
		if (sourceEntryRefs.length === 0) continue;
		coverage.push({
			sourceEntryRefs,
			replacementMaterialId: material.audit.materialId,
			reason: material.audit.reason,
		});
	}
	return coverage;
}

export function buildContextPlan(options: BuildContextPlanOptions): BuiltContextPlan {
	const sourceIndex = buildContextSourceIndex(options.entries);
	const steadyBudget = resolveContextPlanBudget({
		settings: options.settings,
		contextWindow: options.contextWindow,
		nonMessageTokens: options.nonMessageTokens,
	});
	const initialGate = evaluateContextPlanQualityGate({
		sourceIndex,
		tokenEstimateByEntryRef: options.tokenEstimateByEntryRef,
		baseRequiredEntryRefs: options.baseRequiredEntryRefs,
		currentPromptEntryRefs: options.currentPromptEntryRefs,
		liveTailEntryRefs: options.liveTailEntryRefs,
		activeToolCallIds: options.activeToolCallIds,
		messageBudget: steadyBudget.messageBudget,
		controlMax: steadyBudget.controlMax,
		burstCeiling: steadyBudget.burstCeiling,
		nonMessageTokens: steadyBudget.nonMessageTokens,
		projectedInputTokens: options.projectedInputTokens,
		activeEntryCount: options.activeEntryCount,
		archivedEntryCount: options.archivedEntryCount,
		activeCutoffEntryId: options.activeCutoffEntryId,
		maintenanceId: options.maintenanceId,
		recoveryAttempt: options.recoveryAttempt,
	});
	const shouldSelectBurst = initialGate.outcome === "burst_required";
	const budget = resolveContextPlanBudget({
		settings: options.settings,
		contextWindow: options.contextWindow,
		nonMessageTokens: options.nonMessageTokens,
		qualityBurstRequired: shouldSelectBurst,
	});
	const qualityGate = evaluateContextPlanQualityGate({
		sourceIndex,
		tokenEstimateByEntryRef: options.tokenEstimateByEntryRef,
		baseRequiredEntryRefs: options.baseRequiredEntryRefs,
		currentPromptEntryRefs: options.currentPromptEntryRefs,
		liveTailEntryRefs: options.liveTailEntryRefs,
		activeToolCallIds: options.activeToolCallIds,
		messageBudget: budget.messageBudget,
		controlMax: budget.controlMax,
		burstCeiling: budget.burstCeiling,
		nonMessageTokens: budget.nonMessageTokens,
		projectedInputTokens: options.projectedInputTokens,
		activeEntryCount: options.activeEntryCount,
		archivedEntryCount: options.archivedEntryCount,
		activeCutoffEntryId: options.activeCutoffEntryId,
		maintenanceId: options.maintenanceId,
		recoveryAttempt: options.recoveryAttempt,
	});
	// Decay 压力信号:整体投影输入占用率。projectedInputTokens 是调用方对
	// 物化后 payload 的真实估算;缺省(如早期调用)回退到保护集占用。
	const pressureBasis = options.projectedInputTokens ?? qualityGate.selectedInputTokens;
	const contextPressure = budget.messageBudget > 0 ? pressureBasis / budget.messageBudget : 0;
	// Stable-projection keeps recall out of the rendered plan (volatile channel)
	// and reuses epoch-frozen materials verbatim on gate recomputes so a
	// pressure rebuild never reselects the history representation.
	const candidateMaterials = options.frozenMaterials
		? [...options.frozenMaterials]
		: buildMaterials(
				sourceIndex,
				options.maxDigestMaterials ?? 5,
				options.stableProjection === true ? undefined : options.recall,
				budget.planTokenBudget,
				options.currentPromptText,
				contextPressure,
			);
	// 目标锚置于材料列表最前:渲染在 plan 消息头部,且 fit 裁剪(只认
	// recall/digest/checkpoint 字段)永远碰不到它。
	const goalAnchorMaterial = buildGoalAnchorMaterial(options.goalAnchor, sourceIndex);
	if (goalAnchorMaterial) candidateMaterials.unshift(goalAnchorMaterial);
	const promptText = options.currentPromptText?.trim() ?? "";
	const topicShift = promptText.length > 0 && isTopicShiftPrompt(promptText);
	const naturalTopicChange =
		promptText.length > 0 &&
		!isContinuationPrompt(promptText) &&
		!topicShift &&
		sourceIndex.digests.length > 0 &&
		// 仅当所有历史摘要都与当前请求无关时，才判定为自然话题切换。
		!sourceIndex.digests.some(source => isDigestRelevantToPrompt(promptText, source.digest));
	const planId = `plan_${crypto.randomUUID().slice(-12)}`;
	const createdAt = options.createdAt ?? new Date().toISOString();
	const latestCheckpoint = sourceIndex.checkpoints.at(-1);
	const checkpointExcludedByRelevance =
		latestCheckpoint !== undefined &&
		checkpointRelevanceRequired(promptText) &&
		!isCheckpointRelevantToPrompt(promptText, latestCheckpoint.checkpoint);
	const buildAudit = (materials: ContextPlanMaterial[]): ContextPlanAudit => {
		const coverage = coverageForMaterials(materials, qualityGate.protectedEntryRefs, sourceIndex.entryIds);
		return {
			schemaVersion: CONTEXT_PLAN_SCHEMA_VERSION,
			planId,
			sessionId: options.sessionId,
			epochId: options.epochId,
			...(options.rebaseReason
				? { rebaseReason: options.rebaseReason }
				: topicShift || naturalTopicChange
					? { rebaseReason: "topic_shift" }
					: {}),
			promptGeneration: options.promptGeneration,
			createdAt,
			budget,
			qualityGate,
			materials: [
				...materials.map(material => material.audit),
				...buildExactAuditMaterials(sourceIndex, qualityGate.protectedEntryRefs),
				...buildEvidenceStubAuditMaterials(sourceIndex),
				...buildOmittedAuditMaterials(sourceIndex, materials, checkpointExcludedByRelevance),
			],
			coverage,
		};
	};
	// Render the complete final audit for each candidate. Never string-slice a
	// covering replacement after coverage is assigned (C-04/C-05 atomicity).
	const fitted = fitMaterialsToPlanBudget(
		candidateMaterials,
		budget.planTokenBudget,
		buildAudit,
		buildCoveredCheckpointDigestMaterials(
			sourceIndex,
			options.maxDigestMaterials ?? 5,
			options.currentPromptText,
			contextPressure,
		),
	);
	// Tool stubs 不进 plan 渲染与 planTokenBudget fitting:它们作用于 payload
	// 投影(替换,不省略),在 fitting 定型后追加并补录审计。
	const toolStubMaterials = buildToolStubMaterials(
		sourceIndex,
		qualityGate.protectedEntryRefs,
		qualityGate.emergencyStubEntryRefs ?? [],
		options.toolOutputOffload
			? {
					tokenEstimateByEntryRef: options.tokenEstimateByEntryRef,
					minTokens: options.toolOutputOffload.minTokens,
					// Aged offload is steady-state reclaim, not pressure recovery: cap it
					// at a quarter of the message budget so one plan never rewrites most
					// of the history payload in a single request.
					budgetTokens: Math.max(0, Math.floor(budget.messageBudget / 4)),
				}
			: undefined,
	);
	const materials = [...fitted.materials, ...toolStubMaterials];
	const audit: ContextPlanAudit = {
		...fitted.audit,
		materials: [...fitted.audit.materials, ...toolStubMaterials.map(material => material.audit)],
	};
	const renderedContent = fitted.renderedContent;
	const tokenEstimate = fitted.tokenEstimate;
	const message: AgentMessage = {
		role: "custom",
		customType: CONTEXT_PLAN_MESSAGE_TYPE,
		content: renderedContent,
		display: false,
		details: { planId: audit.planId, customType: CONTEXT_PLAN_CUSTOM_TYPE },
		attribution: "agent",
		timestamp: Date.now(),
	};
	return {
		audit,
		materials,
		sourceIndex,
		requestKey: options.requestKey,
		renderedContent,
		message,
		tokenEstimate,
		coverageEntryRefs: audit.coverage.flatMap(item => item.sourceEntryRefs),
		...(options.stableProjection === true ? { projectionMode: "pinned" as const } : {}),
		...(options.offloadAgedImages === true ? { offloadAgedImages: true } : {}),
	};
}

/**
 * Net-benefit gate (measured on the final provider projection):
 * `rawProjectedTokens - projectedTokens`, where the latter already includes the
 * plan wire cost. A non-positive plan is withdrawn — only derived replacement
 * is revoked; raw history, the current prompt, and tool calls are untouched.
 * Steady-state ("pass") plans only: burst/hard-pressure paths need every
 * reclaim they can get, so withdrawing there could worsen the pressure.
 * Recall-bearing plans are exempt: recall is additive retrieved context, not a
 * replacement, so the token difference understates its value — the stable /
 * volatile channel split owns that accounting instead.
 */
export function applyContextPlanNetBenefitGate(
	plan: BuiltContextPlan,
	projection: { rawProjectedTokens: number; projectedTokens: number },
): BuiltContextPlan {
	const netBenefit = projection.rawProjectedTokens - projection.projectedTokens;
	const carriesVolatileContext = plan.materials.some(material => "recall" in material);
	const withdrawn = !carriesVolatileContext && plan.audit.qualityGate.outcome === "pass" && netBenefit <= 0;
	return {
		...plan,
		audit: {
			...plan.audit,
			netBenefit: {
				rawProjectedTokens: projection.rawProjectedTokens,
				projectedTokens: projection.projectedTokens,
				netBenefit,
				withdrawn,
			},
		},
		...(withdrawn ? { withdrawn: true } : {}),
	};
}

function estimateContextPlanWireTokens(renderedContent: string): number {
	return estimateTokens({ role: "user", content: renderedContent, attribution: "agent", timestamp: Date.now() });
}
