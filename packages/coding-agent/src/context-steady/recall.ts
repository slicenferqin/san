import type { MemoryBackendSearchItem } from "../memory-backend/types";
import type { SessionEntry } from "../session/session-entries";
import { collectDigestRefs } from "./packet";
import type { ContextRecallItem, TurnDigest } from "./types";

interface DigestEntryRef {
	entryId: string;
	digest: TurnDigest;
}

export interface ContextSteadyRecallQueryOptions {
	recentDigests: number;
	maxQueryChars: number;
}

export interface ContextSteadyRecallItemsOptions {
	maxItems: number;
}

function clampNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function clampString(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function digestContextLine(entry: DigestEntryRef): string | undefined {
	const parts = [entry.digest.userIntent, ...entry.digest.decisions.slice(0, 2), ...entry.digest.nextSteps.slice(0, 1)]
		.map(normalizeWhitespace)
		.filter(Boolean);
	if (parts.length === 0) return undefined;
	return `- ${entry.entryId}: ${parts.join(" | ")}`;
}

export function buildContextSteadyRecallQuery(
	entries: readonly SessionEntry[],
	currentPrompt: string,
	options: ContextSteadyRecallQueryOptions,
): string {
	const latest = normalizeWhitespace(currentPrompt);
	if (!latest) return "";

	const maxQueryChars = clampNonNegativeInteger(options.maxQueryChars);
	if (maxQueryChars === 0) return "";

	const recentDigests = Math.max(0, Math.floor(options.recentDigests));
	const digestLines =
		recentDigests > 0
			? collectDigestRefs(entries)
					.slice(-recentDigests)
					.map(digestContextLine)
					.filter((line): line is string => line !== undefined)
			: [];

	if (digestLines.length === 0) return clampString(latest, maxQueryChars);

	const suffix = `Current prompt:\n${latest}`;
	const header = "Recent San turn digests:";
	let kept = [...digestLines];
	let query = `${header}\n${kept.join("\n")}\n\n${suffix}`;
	while (kept.length > 0 && query.length > maxQueryChars) {
		kept = kept.slice(1);
		query = `${header}\n${kept.join("\n")}\n\n${suffix}`;
	}
	if (query.length <= maxQueryChars) return query;
	return clampString(latest, maxQueryChars);
}

function recallItemKey(item: MemoryBackendSearchItem): string {
	const id = item.id?.trim();
	if (id) return `id:${id}`;
	const source = item.source?.trim() ?? "";
	return `content:${source}:${normalizeWhitespace(item.content).toLowerCase()}`;
}

export function normalizeContextSteadyRecallItems(
	items: readonly MemoryBackendSearchItem[],
	options: ContextSteadyRecallItemsOptions,
): ContextRecallItem[] {
	const maxItems = clampNonNegativeInteger(options.maxItems);
	if (maxItems === 0) return [];

	const seen = new Set<string>();
	const normalized: ContextRecallItem[] = [];
	for (const item of items) {
		const content = normalizeWhitespace(item.content);
		if (!content) continue;
		const key = recallItemKey({ ...item, content });
		if (seen.has(key)) continue;
		seen.add(key);
		const recallItem: ContextRecallItem = { content };
		if (item.id !== undefined && item.id.trim().length > 0) recallItem.id = item.id;
		if (item.source !== undefined && item.source.trim().length > 0) recallItem.source = item.source;
		if (item.timestamp !== undefined && item.timestamp.trim().length > 0) recallItem.timestamp = item.timestamp;
		if (item.score !== undefined) recallItem.score = item.score;
		normalized.push(recallItem);
		if (normalized.length >= maxItems) break;
	}
	return normalized;
}
