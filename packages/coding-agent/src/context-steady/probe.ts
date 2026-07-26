import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssistantMessage } from "@san/ai";
import type { ToolProgressGuardSnapshot } from "./tool-progress-guard";
import type {
	ActiveContinuationState,
	ContextMaintenanceAction,
	ContextMaintenanceTrigger,
	ContextSummarySource,
} from "./types";

export const CONTEXT_PROBE_SCHEMA_VERSION = 3;

export type ContextProbeRequestKind = "agent" | "turn_digest" | "compaction" | "maintenance";

export interface ContextProbeMaintenanceDecision {
	maintenanceId: string;
	primaryTrigger: ContextMaintenanceTrigger;
	matchedTriggers: ContextMaintenanceTrigger[];
	action: ContextMaintenanceAction | "shake";
	segmentDeltaTokens?: number;
	segmentElapsedMs?: number;
}

export interface ContextProbeCompactionObservation {
	tokensBefore?: number;
	tokensAfter?: number;
	summaryInputTokens?: number;
	summaryOutputTokens?: number;
	summarySource?: ContextSummarySource;
}

export interface ContextProbeRecord {
	schemaVersion: typeof CONTEXT_PROBE_SCHEMA_VERSION;
	timestamp: string;
	sessionId: string;
	sessionFile: string;
	request: {
		kind: ContextProbeRequestKind;
		stopReason?: AssistantMessage["stopReason"];
		responseId?: string;
		upstreamProvider?: string;
		errorMessage?: string;
		errorStatus?: number;
		errorId?: number;
	};
	model: { provider: string; id: string; contextWindow: number };
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		promptTokens: number;
		cacheReadRate: number;
	};
	context: {
		steadyEnabled: boolean;
		activeEstimatedTokens: number;
		rawJournalEstimatedTokens: number;
		archivedEstimatedTokens: number;
		nativeCompactionStrategy: string;
		nativeCompactionThresholdTokens: number;
		rawJournalWouldTriggerNativeCompaction: boolean;
		steadyTargetTokens: number;
	};
	maintenance: {
		compactionCount: number;
		segmentCount: number;
		latestCompactionId?: string;
		latestSegmentId?: string;
		maintenanceId?: string;
		primaryTrigger?: ContextMaintenanceTrigger;
		matchedTriggers?: ContextMaintenanceTrigger[];
		action?: ContextMaintenanceAction | "shake";
		segmentDeltaTokens?: number;
		segmentElapsedMs?: number;
	};
	compaction?: ContextProbeCompactionObservation;
	authority: {
		activeUserEntryId?: string;
		authorityStateInjected: boolean;
		forbiddenGoalField: boolean;
		executionClaimConflictCount: number;
	};
	convergence: Pick<
		ToolProgressGuardSnapshot,
		"actionRepeatCount" | "noEvidenceCount" | "uniqueResourceCount" | "softRedirects" | "forcedFinalizations"
	>;
	cache: {
		promptCacheKey: string;
		prefixFingerprint: string;
		prefixChanged: boolean;
	};
}

export interface BuildContextProbeSnapshotOptions {
	timestamp?: string;
	sessionId: string;
	sessionFile: string;
	contextWindow: number;
	steadyEnabled: boolean;
	activeEstimatedTokens: number;
	rawJournalEstimatedTokens: number;
	nativeCompactionStrategy: string;
	nativeCompactionThresholdTokens: number;
	steadyTargetTokens: number;
	compactionIds: readonly string[];
	segmentIds: readonly string[];
	prefixFingerprint: string;
	previousPrefixFingerprint?: string;
	maintenanceDecision?: ContextProbeMaintenanceDecision;
	compaction?: ContextProbeCompactionObservation;
	authorityState?: ActiveContinuationState;
	convergence?: ToolProgressGuardSnapshot;
}

export interface BuildContextProbeRecordOptions extends BuildContextProbeSnapshotOptions {
	requestKind: Exclude<ContextProbeRequestKind, "maintenance">;
	assistant: AssistantMessage;
}

export interface BuildContextMaintenanceProbeRecordOptions extends BuildContextProbeSnapshotOptions {
	model: { provider: string; id: string };
	maintenanceDecision: ContextProbeMaintenanceDecision;
}

/** 与主会话 JSONL 分离，避免探针记录进入模型上下文或改变 branch 语义。 */
export function contextProbeFilePath(sessionFile: string): string {
	const extension = path.extname(sessionFile);
	return extension.length > 0
		? `${sessionFile.slice(0, -extension.length)}.context-probe.jsonl`
		: `${sessionFile}.context-probe.jsonl`;
}

export async function appendContextProbeRecord(sessionFile: string, record: ContextProbeRecord): Promise<void> {
	await fs.appendFile(contextProbeFilePath(sessionFile), `${JSON.stringify(record)}\n`, "utf8");
}

function buildContextProbeRecordBase(
	options: BuildContextProbeSnapshotOptions,
	request: ContextProbeRecord["request"],
	model: ContextProbeRecord["model"],
	usage: ContextProbeRecord["usage"],
): ContextProbeRecord {
	const rawJournalEstimatedTokens = Math.max(options.activeEstimatedTokens, options.rawJournalEstimatedTokens);
	const latestCompactionId = options.compactionIds.at(-1);
	const latestSegmentId = options.segmentIds.at(-1);
	const authorityAudit = options.authorityState?.summaryAuthority;
	const convergence = options.convergence;
	return {
		schemaVersion: CONTEXT_PROBE_SCHEMA_VERSION,
		timestamp: options.timestamp ?? new Date().toISOString(),
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		request,
		model,
		usage,
		context: {
			steadyEnabled: options.steadyEnabled,
			activeEstimatedTokens: options.activeEstimatedTokens,
			rawJournalEstimatedTokens,
			archivedEstimatedTokens: Math.max(0, rawJournalEstimatedTokens - options.activeEstimatedTokens),
			nativeCompactionStrategy: options.nativeCompactionStrategy,
			nativeCompactionThresholdTokens: options.nativeCompactionThresholdTokens,
			rawJournalWouldTriggerNativeCompaction:
				options.nativeCompactionThresholdTokens > 0 &&
				rawJournalEstimatedTokens >= options.nativeCompactionThresholdTokens,
			steadyTargetTokens: options.steadyTargetTokens,
		},
		maintenance: {
			compactionCount: options.compactionIds.length,
			segmentCount: options.segmentIds.length,
			...(latestCompactionId ? { latestCompactionId } : {}),
			...(latestSegmentId ? { latestSegmentId } : {}),
			...(options.maintenanceDecision
				? {
						maintenanceId: options.maintenanceDecision.maintenanceId,
						primaryTrigger: options.maintenanceDecision.primaryTrigger,
						matchedTriggers: options.maintenanceDecision.matchedTriggers,
						action: options.maintenanceDecision.action,
						...(options.maintenanceDecision.segmentDeltaTokens === undefined
							? {}
							: { segmentDeltaTokens: options.maintenanceDecision.segmentDeltaTokens }),
						...(options.maintenanceDecision.segmentElapsedMs === undefined
							? {}
							: { segmentElapsedMs: options.maintenanceDecision.segmentElapsedMs }),
					}
				: {}),
		},
		...(options.compaction ? { compaction: options.compaction } : {}),
		authority: {
			...(options.authorityState ? { activeUserEntryId: options.authorityState.activeUserEntryId } : {}),
			authorityStateInjected: options.authorityState !== undefined,
			forbiddenGoalField: authorityAudit?.forbiddenGoalField ?? false,
			executionClaimConflictCount: authorityAudit?.executionClaimConflictCount ?? 0,
		},
		convergence: {
			actionRepeatCount: convergence?.actionRepeatCount ?? 0,
			noEvidenceCount: convergence?.noEvidenceCount ?? 0,
			uniqueResourceCount: convergence?.uniqueResourceCount ?? 0,
			softRedirects: convergence?.softRedirects ?? 0,
			forcedFinalizations: convergence?.forcedFinalizations ?? 0,
		},
		cache: {
			promptCacheKey: options.sessionId,
			prefixFingerprint: options.prefixFingerprint,
			prefixChanged:
				options.previousPrefixFingerprint !== undefined &&
				options.previousPrefixFingerprint !== options.prefixFingerprint,
		},
	};
}

export function buildContextProbeRecord(options: BuildContextProbeRecordOptions): ContextProbeRecord {
	const assistantUsage = options.assistant.usage;
	const promptTokens = assistantUsage.input + assistantUsage.cacheRead + assistantUsage.cacheWrite;
	const usage: ContextProbeRecord["usage"] = {
		input: assistantUsage.input,
		output: assistantUsage.output,
		cacheRead: assistantUsage.cacheRead,
		cacheWrite: assistantUsage.cacheWrite,
		promptTokens,
		cacheReadRate: promptTokens > 0 ? assistantUsage.cacheRead / promptTokens : 0,
	};
	const compaction =
		options.requestKind === "compaction"
			? {
					...options.compaction,
					summaryInputTokens: options.compaction?.summaryInputTokens ?? promptTokens,
					summaryOutputTokens: options.compaction?.summaryOutputTokens ?? assistantUsage.output,
				}
			: options.compaction;
	return buildContextProbeRecordBase(
		{ ...options, ...(compaction ? { compaction } : {}) },
		{
			kind: options.requestKind,
			stopReason: options.assistant.stopReason,
			...(options.assistant.responseId ? { responseId: options.assistant.responseId } : {}),
			...(options.assistant.upstreamProvider ? { upstreamProvider: options.assistant.upstreamProvider } : {}),
			...(options.assistant.errorMessage ? { errorMessage: options.assistant.errorMessage } : {}),
			...(options.assistant.errorStatus !== undefined ? { errorStatus: options.assistant.errorStatus } : {}),
			...(options.assistant.errorId !== undefined ? { errorId: options.assistant.errorId } : {}),
		},
		{ provider: options.assistant.provider, id: options.assistant.model, contextWindow: options.contextWindow },
		usage,
	);
}

/** 物理维护完成后的零 usage 审计记录，用于精确关联 before/after 与摘要请求成本。 */
export function buildContextMaintenanceProbeRecord(
	options: BuildContextMaintenanceProbeRecordOptions,
): ContextProbeRecord {
	return buildContextProbeRecordBase(
		options,
		{ kind: "maintenance" },
		{ ...options.model, contextWindow: options.contextWindow },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0, cacheReadRate: 0 },
	);
}
