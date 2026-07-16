import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { generateFallbackDigest } from "./fallback";
import { extractSpanMessages } from "./session";
import {
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	CONTEXT_SEGMENT_SCHEMA_VERSION,
	type ContextSegment,
	type ContextSegmentAuthority,
	type ContextSegmentMaintenancePhase,
	type ContextSegmentMaintenanceReason,
} from "./types";

interface BuildContextSegmentOptions {
	entries: readonly SessionEntry[];
	sessionId: string;
	firstKeptEntryId: string;
	promptGeneration: number;
	maintenanceId: string;
	reason: ContextSegmentMaintenanceReason;
	phase: ContextSegmentMaintenancePhase;
	authority: ContextSegmentAuthority;
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	tokensAfter?: number;
}

export interface ContextSegmentDigestInput {
	messages: unknown[];
	segmentEntryId?: string;
	estimatedTokens: number;
	trimmedMessages: number;
}

function userEntryIdBefore(entries: readonly SessionEntry[], beforeIndex: number): string | undefined {
	for (let index = beforeIndex; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") return entry.id;
	}
	return undefined;
}

function estimateUnknownTokens(value: unknown): number {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		serialized = String(value);
	}
	return Math.max(1, Math.ceil(serialized.length / 4));
}

function checkpointText(segment: ContextSegment, maxTokens: number): string {
	const checkpoint = segment.checkpoint;
	const content = [
		"[San Context Segment]",
		`logicalTurnId: ${segment.logicalTurnId}`,
		`segmentId: ${segment.segmentId}`,
		`userIntent: ${checkpoint.userIntent}`,
		`summary: ${segment.summary}`,
		`decisions: ${checkpoint.decisions.join(" | ") || "none"}`,
		`risks: ${checkpoint.risks.join(" | ") || "none"}`,
		`nextSteps: ${checkpoint.nextSteps.join(" | ") || "none"}`,
		`files: ${checkpoint.filesTouched.map(file => `${file.action}:${file.path}`).join(" | ") || "none"}`,
	].join("\n");
	const maxChars = Math.max(256, Math.floor(maxTokens) * 4);
	return content.length <= maxChars ? content : `${content.slice(0, Math.max(0, maxChars - 20))}\n[segment truncated]`;
}

function boundMessages(messages: readonly unknown[], maxTokens: number): ContextSegmentDigestInput {
	const estimates = messages.map(estimateUnknownTokens);
	const total = estimates.reduce((sum, estimate) => sum + estimate, 0);
	if (maxTokens <= 0 || total <= maxTokens) {
		return { messages: [...messages], estimatedTokens: total, trimmedMessages: 0 };
	}
	const firstUserIndex = messages.findIndex(message => {
		return !!message && typeof message === "object" && "role" in message && message.role === "user";
	});
	const selected = new Set<number>();
	let used = 0;
	if (firstUserIndex >= 0 && estimates[firstUserIndex] <= maxTokens) {
		selected.add(firstUserIndex);
		used += estimates[firstUserIndex];
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		if (selected.has(index)) continue;
		const estimate = estimates[index];
		if (used + estimate > maxTokens) continue;
		selected.add(index);
		used += estimate;
	}
	const bounded = [...selected].sort((left, right) => left - right).map(index => messages[index]);
	return {
		messages: bounded,
		estimatedTokens: used,
		trimmedMessages: Math.max(0, messages.length - bounded.length),
	};
}

export function collectContextSegmentRefs(
	entries: readonly SessionEntry[],
): Array<{ entryId: string; segment: ContextSegment }> {
	const refs: Array<{ entryId: string; segment: ContextSegment }> = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CONTEXT_SEGMENT_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		if (!("schemaVersion" in data) || !("segmentId" in data) || !("source" in data)) continue;
		refs.push({ entryId: entry.id, segment: data as ContextSegment });
	}
	return refs;
}

/** 在 compaction 提交后持久化一个不带执行预算的 segment 边界。 */
export function buildContextSegment(options: BuildContextSegmentOptions): ContextSegment | undefined {
	const firstKeptIndex = options.entries.findIndex(entry => entry.id === options.firstKeptEntryId);
	if (firstKeptIndex <= 0) return undefined;
	const logicalTurnId = userEntryIdBefore(options.entries, firstKeptIndex - 1);
	if (!logicalTurnId) return undefined;

	const previousSegment = collectContextSegmentRefs(options.entries)
		.map(ref => ref.segment)
		.filter(segment => segment.logicalTurnId === logicalTurnId)
		.at(-1);
	const previousToIndex = previousSegment
		? options.entries.findIndex(entry => entry.id === previousSegment.source.toEntryId)
		: -1;
	const logicalTurnIndex = options.entries.findIndex(entry => entry.id === logicalTurnId);
	const fromIndex = Math.max(logicalTurnIndex, previousToIndex + 1);
	const toIndex = firstKeptIndex - 1;
	if (fromIndex < 0 || fromIndex > toIndex) return undefined;

	const fromEntryId = options.entries[fromIndex]?.id;
	const toEntryId = options.entries[toIndex]?.id;
	if (!fromEntryId || !toEntryId) return undefined;
	const source = {
		sessionId: options.sessionId,
		fromEntryId,
		toEntryId,
		promptGeneration: options.promptGeneration,
		userEntryId: logicalTurnId,
	};
	const messages = extractSpanMessages(options.entries, fromEntryId, toEntryId);
	if (messages.length === 0) return undefined;
	const segmentId = `segment_${crypto.randomUUID().slice(-12)}`;
	const fallback = generateFallbackDigest(
		messages as Parameters<typeof generateFallbackDigest>[0],
		source,
		segmentId,
		options.sessionId,
	);

	return {
		schemaVersion: CONTEXT_SEGMENT_SCHEMA_VERSION,
		segmentId,
		logicalTurnId,
		sessionId: options.sessionId,
		createdAt: new Date().toISOString(),
		status: "closed",
		authority: options.authority,
		source: {
			fromEntryId,
			toEntryId,
			firstKeptEntryId: options.firstKeptEntryId,
			promptGeneration: options.promptGeneration,
		},
		maintenance: {
			maintenanceId: options.maintenanceId,
			reason: options.reason,
			phase: options.phase,
			tokensBefore: options.tokensBefore,
			...(options.tokensAfter === undefined ? {} : { tokensAfter: options.tokensAfter }),
		},
		summary: options.summary,
		...(options.shortSummary ? { shortSummary: options.shortSummary } : {}),
		checkpoint: {
			userIntent: fallback.userIntent,
			actionsTaken: fallback.actionsTaken,
			decisions: fallback.decisions,
			filesTouched: fallback.filesTouched,
			toolEvidence: fallback.toolEvidence,
			factsLearned: fallback.factsLearned,
			openQuestions: fallback.openQuestions,
			risks: fallback.risks,
			nextSteps: fallback.nextSteps,
			...(fallback.tokenStats ? { tokenStats: fallback.tokenStats } : {}),
		},
	};
}

export function appendContextSegment(sessionManager: ReadonlySessionManager, segment: ContextSegment): string {
	return sessionManager.appendCustomEntry(CONTEXT_SEGMENT_CUSTOM_TYPE, segment);
}

/**
 * 构造最终 TurnDigest 的有界输入：最新 segment summary 是递归 frontier，
 * 后面只拼接 firstKeptEntryId 之后的活跃尾部，不再重读整条原始 turn。
 */
export function buildContextSegmentDigestInput(
	entries: readonly SessionEntry[],
	fromEntryId: string,
	toEntryId: string,
	maxTokens: number,
): ContextSegmentDigestInput {
	const fromIndex = entries.findIndex(entry => entry.id === fromEntryId);
	const toIndex = entries.findIndex(entry => entry.id === toEntryId);
	const fullMessages = extractSpanMessages(entries, fromEntryId, toEntryId);
	if (fromIndex < 0 || toIndex < fromIndex || maxTokens <= 0) {
		return boundMessages(fullMessages, maxTokens);
	}

	const latest = collectContextSegmentRefs(entries)
		.filter(ref => {
			const segmentFrom = entries.findIndex(entry => entry.id === ref.segment.source.fromEntryId);
			const segmentTo = entries.findIndex(entry => entry.id === ref.segment.source.toEntryId);
			return segmentFrom >= fromIndex && segmentTo >= segmentFrom && segmentTo <= toIndex;
		})
		.at(-1);
	if (!latest) {
		return boundMessages(fullMessages, maxTokens);
	}

	const segmentBudget = Math.max(256, Math.min(Math.floor(maxTokens * 0.35), 32_000));
	const segmentMessage = {
		role: "custom",
		content: checkpointText(latest.segment, segmentBudget),
		timestamp: Date.parse(latest.segment.createdAt),
		provider: "context-steady",
		model: "segment",
		customType: CONTEXT_SEGMENT_CUSTOM_TYPE,
		entryId: latest.entryId,
	};
	const tail = extractSpanMessages(entries, latest.segment.source.firstKeptEntryId, toEntryId);
	const selectedTail: unknown[] = [];
	let used = estimateUnknownTokens(segmentMessage);
	for (let index = tail.length - 1; index >= 0; index--) {
		const message = tail[index];
		const estimate = estimateUnknownTokens(message);
		if (used + estimate > maxTokens && selectedTail.length > 0) break;
		if (used + estimate > maxTokens) continue;
		selectedTail.unshift(message);
		used += estimate;
	}
	return {
		messages: [segmentMessage, ...selectedTail],
		segmentEntryId: latest.entryId,
		estimatedTokens: used,
		trimmedMessages: Math.max(0, fullMessages.length - selectedTail.length),
	};
}
