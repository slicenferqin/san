import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssistantMessage } from "@oh-my-pi/pi-ai";

export const CONTEXT_PROBE_SCHEMA_VERSION = 2;

export type ContextProbeRequestKind = "agent" | "turn_digest" | "compaction";

export interface ContextProbeRecord {
	schemaVersion: typeof CONTEXT_PROBE_SCHEMA_VERSION;
	timestamp: string;
	sessionId: string;
	sessionFile: string;
	request: {
		kind: ContextProbeRequestKind;
		stopReason: AssistantMessage["stopReason"];
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
	};
	cache: {
		promptCacheKey: string;
		prefixFingerprint: string;
		prefixChanged: boolean;
	};
}

export interface BuildContextProbeRecordOptions {
	timestamp?: string;
	sessionId: string;
	sessionFile: string;
	requestKind: ContextProbeRequestKind;
	assistant: AssistantMessage;
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

export function buildContextProbeRecord(options: BuildContextProbeRecordOptions): ContextProbeRecord {
	const usage = options.assistant.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const cacheReadRate = promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
	const rawJournalEstimatedTokens = Math.max(options.activeEstimatedTokens, options.rawJournalEstimatedTokens);
	const latestCompactionId = options.compactionIds.at(-1);
	const latestSegmentId = options.segmentIds.at(-1);
	return {
		schemaVersion: CONTEXT_PROBE_SCHEMA_VERSION,
		timestamp: options.timestamp ?? new Date().toISOString(),
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		request: {
			kind: options.requestKind,
			stopReason: options.assistant.stopReason,
			...(options.assistant.responseId ? { responseId: options.assistant.responseId } : {}),
			...(options.assistant.upstreamProvider ? { upstreamProvider: options.assistant.upstreamProvider } : {}),
			...(options.assistant.errorMessage ? { errorMessage: options.assistant.errorMessage } : {}),
			...(options.assistant.errorStatus !== undefined ? { errorStatus: options.assistant.errorStatus } : {}),
			...(options.assistant.errorId !== undefined ? { errorId: options.assistant.errorId } : {}),
		},
		model: {
			provider: options.assistant.provider,
			id: options.assistant.model,
			contextWindow: options.contextWindow,
		},
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			promptTokens,
			cacheReadRate,
		},
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
