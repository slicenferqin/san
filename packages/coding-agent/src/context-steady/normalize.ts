/**
 * Schema normalization for TurnDigest objects.
 *
 * Ensures LLM-generated digests conform to the TurnDigest schema.
 * Missing fields are filled with sensible defaults; string and array
 * lengths are capped to prevent unbounded growth in the session journal.
 */

import type { TurnDigest, TurnDigestFile, TurnDigestMemoryCandidate, TurnDigestToolEvidence } from "./types";
import { TURN_DIGEST_SCHEMA_VERSION } from "./types";

/** Maximum lengths for string fields. */
const MAX_USER_INTENT_LENGTH = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_ITEM_LENGTH = 200;
const MAX_FILE_ITEMS = 50;
const MAX_FILE_PATH_LENGTH = 500;
const MAX_FILE_REASON_LENGTH = 200;
const MAX_TOOL_SUMMARY_LENGTH = 200;
const MAX_MEMORY_CANDIDATE_CONTENT_LENGTH = 500;

function clampString(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function clampStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		if (result.length >= maxItems) break;
		if (typeof item === "string") {
			result.push(clampString(item, maxItemLength));
		}
	}
	return result;
}

function clampFileArray(value: unknown): TurnDigestFile[] {
	if (!Array.isArray(value)) return [];
	const result: TurnDigestFile[] = [];
	const validActions = new Set(["read", "modified", "created", "deleted", "unknown"]);

	for (const item of value) {
		if (result.length >= MAX_FILE_ITEMS) break;
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const path = clampString(obj.path, MAX_FILE_PATH_LENGTH);
		if (!path) continue;
		const action = validActions.has(obj.action as string) ? (obj.action as TurnDigestFile["action"]) : "unknown";
		const reason = typeof obj.reason === "string" ? clampString(obj.reason, MAX_FILE_REASON_LENGTH) : undefined;
		result.push({ path, action, ...(reason ? { reason } : {}) });
	}
	return result;
}

function clampToolEvidenceArray(value: unknown): TurnDigestToolEvidence[] {
	if (!Array.isArray(value)) return [];
	const result: TurnDigestToolEvidence[] = [];

	for (const item of value) {
		if (result.length >= MAX_ARRAY_ITEMS) break;
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const tool = clampString(obj.tool, 50);
		if (!tool) continue;
		const summary = clampString(obj.summary, MAX_TOOL_SUMMARY_LENGTH);
		const entryIds = clampStringArray(obj.entryIds, MAX_ARRAY_ITEMS, 100);
		result.push({ tool, summary, ...(entryIds.length > 0 ? { entryIds } : {}) });
	}
	return result;
}

function clampMemoryCandidateArray(value: unknown): TurnDigestMemoryCandidate[] {
	if (!Array.isArray(value)) return [];
	const result: TurnDigestMemoryCandidate[] = [];
	const validTypes = new Set(["preference", "project_fact", "decision", "workflow", "other"]);

	for (const item of value) {
		if (result.length >= MAX_ARRAY_ITEMS) break;
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const content = clampString(obj.content, MAX_MEMORY_CANDIDATE_CONTENT_LENGTH);
		if (!content) continue;
		const type = validTypes.has(obj.type as string) ? (obj.type as TurnDigestMemoryCandidate["type"]) : "other";
		const importance =
			typeof obj.importance === "number" && Number.isFinite(obj.importance)
				? Math.max(0, Math.min(1, obj.importance))
				: 0.5;
		result.push({ content, type, importance });
	}
	return result;
}

function clampTokenStats(value: unknown): TurnDigest["tokenStats"] {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	const input = typeof obj.input === "number" ? obj.input : undefined;
	const output = typeof obj.output === "number" ? obj.output : undefined;
	const cacheRead = typeof obj.cacheRead === "number" ? obj.cacheRead : undefined;
	const cacheWrite = typeof obj.cacheWrite === "number" ? obj.cacheWrite : undefined;
	const total = typeof obj.total === "number" ? obj.total : undefined;

	// Return undefined if no useful stats
	if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
		return undefined;
	}
	return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Normalize a (possibly LLM-generated) TurnDigest to schema conformance.
 * Fields that are missing or invalid are filled with defaults.
 * String and array lengths are capped.
 */
export function normalizeDigest(raw: unknown, fallbackFields: Partial<TurnDigest>): TurnDigest {
	const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: fallbackFields.turnId ?? "",
		sessionId: fallbackFields.sessionId ?? "",
		createdAt: fallbackFields.createdAt ?? new Date().toISOString(),
		model: typeof obj.model === "string" ? obj.model : fallbackFields.model,
		source: fallbackFields.source ?? {
			sessionId: "",
			fromEntryId: "",
			toEntryId: "",
			promptGeneration: 0,
		},
		userIntent: clampString(obj.userIntent, MAX_USER_INTENT_LENGTH) || "Unknown",
		actionsTaken: clampStringArray(obj.actionsTaken, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		decisions: clampStringArray(obj.decisions, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		filesTouched: clampFileArray(obj.filesTouched),
		toolEvidence: clampToolEvidenceArray(obj.toolEvidence),
		factsLearned: clampStringArray(obj.factsLearned, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		openQuestions: clampStringArray(obj.openQuestions, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		risks: clampStringArray(obj.risks, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		nextSteps: clampStringArray(obj.nextSteps, MAX_ARRAY_ITEMS, MAX_STRING_ITEM_LENGTH),
		memoryCandidates: clampMemoryCandidateArray(obj.memoryCandidates),
		tokenStats: clampTokenStats(obj.tokenStats),
		fallback: obj.fallback === true || (fallbackFields.fallback ?? false),
	};
}
