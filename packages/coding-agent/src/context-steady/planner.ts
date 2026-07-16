import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionEntry } from "../session/session-entries";
import type { ContextPlanBudgetSettings } from "./budget";
import { resolveContextPlanBudget } from "./budget";
import { renderContextPlanContent } from "./materialize";
import {
	type BuiltContextPlan,
	CONTEXT_PLAN_CUSTOM_TYPE,
	CONTEXT_PLAN_MESSAGE_TYPE,
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanAudit,
	type ContextPlanCoverageAudit,
	type ContextPlanDigestMaterial,
	type ContextPlanMaterial,
	type ContextPlanRecallMaterial,
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

function buildMaterials(
	sourceIndex: ContextSourceIndex,
	maxDigestMaterials: number,
	recall: ContextPacketRecallLayer | undefined,
	planTokenBudget: number,
	currentPromptText: string | undefined,
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
		if (checkpointEstimate <= remainingBudget) {
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
	}

	const selectedDigests = sourceIndex.digests
		.filter(source => !coveredDigestRefs.has(source.entryId) || !includeCheckpoint)
		.filter(source => !requireRelevance || isDigestRelevantToPrompt(promptText, source.digest))
		.slice(-Math.max(0, Math.floor(maxDigestMaterials)));
	for (const source of selectedDigests) {
		const canCoverSource = source.digest.fallback !== true;
		const estimate = materialTokenEstimate(source.digest);
		if (estimate > remainingBudget) continue;
		const material: ContextPlanDigestMaterial = {
			audit: {
				materialId: materialId("digest", source.entryId),
				kind: "turn_digest",
				representation: "digest",
				entryRefs: [source.entryId],
				tokenEstimate: estimate,
				reason: canCoverSource ? "recent settled turn digest" : "fallback digest for reference only",
			},
			entryId: source.entryId,
			digest: source.digest,
			coveredEntryRefs: canCoverSource ? source.sourceEntryRefs : [],
		};
		materials.push(material);
		remainingBudget -= estimate;
	}

	const recallMaterial = buildRecallMaterial(recall);
	if (recallMaterial && recallMaterial.audit.tokenEstimate <= remainingBudget) materials.push(recallMaterial);
	return materials;
}

/**
 * Drop lowest-priority derived materials until the rendered plan fits planTokenBudget.
 * Protected exact/live materials are not part of this rendered content.
 */
function fitMaterialsToPlanBudget(
	materials: ContextPlanMaterial[],
	planTokenBudget: number,
	buildAudit: (materials: ContextPlanMaterial[]) => ContextPlanAudit,
): { materials: ContextPlanMaterial[]; audit: ContextPlanAudit; renderedContent: string; tokenEstimate: number } {
	let selected = materials;
	for (;;) {
		const audit = buildAudit(selected);
		const renderedContent = renderContextPlanContent({ audit, materials: selected });
		const tokenEstimate = estimateContextPlanWireTokens(renderedContent);
		if (planTokenBudget <= 0 || tokenEstimate <= planTokenBudget || selected.length === 0) {
			return { materials: selected, audit, renderedContent, tokenEstimate };
		}
		// Drop recall first, then oldest digests, then checkpoint last.
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
			continue;
		}
		return { materials: selected, audit, renderedContent, tokenEstimate };
	}
}

function buildOmittedAuditMaterials(
	sourceIndex: ContextSourceIndex,
	runtimeMaterials: readonly ContextPlanMaterial[],
): ContextPlanAudit["materials"] {
	const representedDigestRefs = new Set(
		runtimeMaterials.flatMap(material => ("digest" in material ? [material.entryId] : [])),
	);
	const checkpointCoveredRefs = new Set(sourceIndex.checkpoints.at(-1)?.coveredDigestEntryRefs ?? []);
	return sourceIndex.digests
		.filter(source => !representedDigestRefs.has(source.entryId) && !checkpointCoveredRefs.has(source.entryId))
		.map(source => ({
			materialId: materialId("omitted", source.entryId),
			kind: "turn_digest",
			representation: "omitted",
			entryRefs: [source.entryId],
			tokenEstimate: materialTokenEstimate(source.digest),
			reason: "outside ContextPlan material budget or window",
		}));
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
	const candidateMaterials = buildMaterials(
		sourceIndex,
		options.maxDigestMaterials ?? 5,
		options.recall,
		budget.planTokenBudget,
		options.currentPromptText,
	);
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
				...buildOmittedAuditMaterials(sourceIndex, materials),
			],
			coverage,
		};
	};
	// Render the complete final audit for each candidate. Never string-slice a
	// covering replacement after coverage is assigned (C-04/C-05 atomicity).
	const fitted = fitMaterialsToPlanBudget(candidateMaterials, budget.planTokenBudget, buildAudit);
	const materials = fitted.materials;
	const audit = fitted.audit;
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
	};
}

function estimateContextPlanWireTokens(renderedContent: string): number {
	return estimateTokens({ role: "user", content: renderedContent, attribution: "agent", timestamp: Date.now() });
}
