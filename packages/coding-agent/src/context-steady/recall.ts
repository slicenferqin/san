import { estimateTokens } from "@san/agent/compaction";
import type { MemoryBackendSearchItem } from "../memory-backend/types";
import type { SessionEntry } from "../session/session-entries";
import {
	type ContextHistorySearchOptions,
	type ContextHistorySearchResult,
	searchContextHistory,
} from "./history-search";
import { isContinuationPrompt, isDigestRelevantToPrompt } from "./relevance";
import { collectDigestRefs } from "./session";
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
	maxTokens?: number;
	memoryTypes?: readonly string[];
	scopeKeys?: readonly string[];
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
	const collectedDigests = collectDigestRefs(entries);
	const relevantDigests = isContinuationPrompt(currentPrompt)
		? collectedDigests
		: collectedDigests.filter(entry => isDigestRelevantToPrompt(currentPrompt, entry.digest));
	const digestLines =
		recentDigests > 0
			? relevantDigests
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
	const maxTokens =
		options.maxTokens === undefined ? Number.POSITIVE_INFINITY : clampNonNegativeInteger(options.maxTokens);
	if (maxItems === 0 || maxTokens === 0) return [];

	const seen = new Set<string>();
	const memoryTypes = new Set(options.memoryTypes ?? []);
	const scopeKeys = new Set(options.scopeKeys ?? []);
	const normalized: ContextRecallItem[] = [];
	let tokenEstimate = 0;
	for (const item of items) {
		if (item.memoryType && memoryTypes.size > 0 && !memoryTypes.has(item.memoryType)) continue;
		if (scopeKeys.size > 0 && (!item.scope || !scopeKeys.has(item.scope))) continue;
		const content = normalizeWhitespace(item.content);
		if (!content) continue;
		const key = recallItemKey({ ...item, content });
		if (seen.has(key)) continue;

		const recallItem: ContextRecallItem = { content };
		if (item.id !== undefined && item.id.trim().length > 0) recallItem.id = item.id;
		if (item.source !== undefined && item.source.trim().length > 0) recallItem.source = item.source;
		if (item.timestamp !== undefined && item.timestamp.trim().length > 0) recallItem.timestamp = item.timestamp;
		if (item.score !== undefined) recallItem.score = item.score;
		if (item.memoryType !== undefined && item.memoryType.trim().length > 0) recallItem.memoryType = item.memoryType;
		if (item.scope !== undefined && item.scope.trim().length > 0) recallItem.scope = item.scope;

		const itemTokens = estimateTokens({
			role: "user",
			content: JSON.stringify(recallItem),
			timestamp: Date.now(),
		});
		if (tokenEstimate + itemTokens > maxTokens) continue;
		seen.add(key);
		normalized.push(recallItem);
		tokenEstimate += itemTokens;
		if (normalized.length >= maxItems) break;
	}
	return normalized;
}

export function mergeContextSteadyRecallItems(
	backendItems: readonly MemoryBackendSearchItem[],
	localItems: readonly MemoryBackendSearchItem[],
	options: ContextSteadyRecallItemsOptions,
): ContextRecallItem[] {
	const interleaved: MemoryBackendSearchItem[] = [];
	const length = Math.max(backendItems.length, localItems.length);
	for (let index = 0; index < length; index++) {
		const backend = backendItems[index];
		if (backend) interleaved.push(backend);
		const local = localItems[index];
		if (local) interleaved.push(local);
	}
	return normalizeContextSteadyRecallItems(interleaved, options);
}

export interface ContextSteadyLocalRecallOptions {
	maxItems: number;
	maxTokens?: number;
	currentEntryId?: string;
	fallbackQuery?: string;
}

const LOCAL_RECALL_STOP_WORDS: Record<string, true> = {
	and: true,
	caused: true,
	continue: true,
	current: true,
	did: true,
	earlier: true,
	for: true,
	from: true,
	history: true,
	last: true,
	please: true,
	previous: true,
	previously: true,
	prior: true,
	prompt: true,
	recall: true,
	recent: true,
	resume: true,
	that: true,
	the: true,
	this: true,
	what: true,
	why: true,
	with: true,
};
const LOCAL_RECALL_CUE_RE =
	/(?:之前|上次|先前|前面|刚才|历史|原来|旧的|继续|恢复|回到|记得|失败原因|previous(?:ly)?|earlier|prior|last\s+time|history|resume|continue|again)/iu;
const LOCAL_RECALL_CUE_REMOVE_RE =
	/(?:之前|上次|先前|前面|刚才|历史|原来|旧的|继续|恢复|回到|记得|这个|那个|一下|看下|帮我|请|previous(?:ly)?|earlier|prior|last\s+time|history|resume|continue|again)/giu;

function localRecallQueries(currentPrompt: string, fallbackQuery?: string): string[] {
	const termPattern = /source:[\p{L}\p{N}_.:/-]+|[\p{L}\p{N}_.:/-]{3,}/giu;
	const promptTerms = currentPrompt.replace(LOCAL_RECALL_CUE_REMOVE_RE, " ").toLowerCase().match(termPattern) ?? [];
	const structured = promptTerms.some(term => /\d|[_.:/-]/u.test(term));
	if (!isContinuationPrompt(currentPrompt) && !LOCAL_RECALL_CUE_RE.test(currentPrompt) && !structured) return [];

	const candidates = [...promptTerms];
	if ((isContinuationPrompt(currentPrompt) || candidates.length === 0) && fallbackQuery) {
		candidates.push(...(fallbackQuery.toLowerCase().match(termPattern) ?? []));
	}
	const unique: string[] = [];
	for (const rawTerm of candidates) {
		const term = rawTerm.replace(/^[_.:/-]+|[_.:/-]+$/gu, "");
		if (
			!term ||
			LOCAL_RECALL_STOP_WORDS[term] ||
			/^digest[_-]|^turn[_-]|^source:/u.test(term) ||
			unique.includes(term)
		)
			continue;
		unique.push(term);
	}
	unique.sort(
		(left, right) =>
			Number(/\d|[_.:/-]/u.test(right)) - Number(/\d|[_.:/-]/u.test(left)) || right.length - left.length,
	);
	return unique.slice(0, 8);
}

/** Search only the supplied branch journal; this is lexical, not semantic. */
export function recallFromContextSearch(
	searchContext: (query: string, options?: ContextHistorySearchOptions) => ContextHistorySearchResult,
	currentPrompt: string,
	options: ContextSteadyLocalRecallOptions,
): ContextRecallItem[] {
	const maxItems = clampNonNegativeInteger(options.maxItems);
	const maxTokens =
		options.maxTokens === undefined ? Number.POSITIVE_INFINITY : clampNonNegativeInteger(options.maxTokens);
	if (maxItems === 0 || maxTokens === 0) return [];
	const queries = localRecallQueries(currentPrompt, options.fallbackQuery);
	if (queries.length === 0) return [];

	const matches = new Map<
		string,
		{ item: ContextRecallItem; score: number; firstQueryIndex: number; firstHitIndex: number }
	>();
	for (const [queryIndex, query] of queries.entries()) {
		const search = searchContext(query, { limit: 20, maxExcerptChars: 1200 });
		for (const [hitIndex, hit] of search.hits.entries()) {
			if (hit.entryId === options.currentEntryId) continue;
			if (hit.role !== "user" && hit.role !== "assistant" && hit.role !== "toolResult") continue;
			const weightedScore = hit.score + (queries.length - queryIndex) * 2;
			const previous = matches.get(hit.entryId);
			if (previous) {
				previous.score += weightedScore;
				continue;
			}
			matches.set(hit.entryId, {
				item: {
					id: hit.entryId,
					source: hit.ref,
					content: hit.excerpt,
					memoryType: "context-journal",
					scope: "branch-local",
					score: weightedScore,
				},
				score: weightedScore,
				firstQueryIndex: queryIndex,
				firstHitIndex: hitIndex,
			});
		}
	}
	const items = [...matches.values()]
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.firstQueryIndex - right.firstQueryIndex ||
				left.firstHitIndex - right.firstHitIndex,
		)
		.map(match => ({ ...match.item, score: match.score }));
	return normalizeContextSteadyRecallItems(items, { maxItems, maxTokens });
}

/** Search only the supplied branch journal; this is lexical, not semantic. */
export function recallFromContextBranch(
	entries: readonly SessionEntry[],
	currentPrompt: string,
	options: ContextSteadyLocalRecallOptions,
): ContextRecallItem[] {
	return recallFromContextSearch(
		(query, searchOptions) => searchContextHistory(entries, query, searchOptions),
		currentPrompt,
		options,
	);
}
