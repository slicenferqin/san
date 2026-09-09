import type { AgentMessage } from "@san/agent";
import type { SessionEntry } from "../session/session-entries";
import { contextContentText, contextMessageText } from "./message-text";
import { CONTEXT_PLAN_MESSAGE_TYPE } from "./plan-types";
import { CONTEXT_CONTINUATION_MESSAGE_TYPE, CONTEXT_PACKET_MESSAGE_TYPE, CONTEXT_RECALL_MESSAGE_TYPE } from "./types";

export const CONTEXT_SOURCE_REF_PREFIX = "source:";

export interface ContextHistorySearchHit {
	readonly ref: string;
	readonly entryId: string;
	readonly role: string;
	readonly toolName?: string;
	readonly excerpt: string;
	readonly matchedTerms: string[];
	readonly score: number;
}

export interface ContextHistorySearchResult {
	readonly query: string;
	readonly hits: ContextHistorySearchHit[];
	readonly total: number;
}

export interface ContextHistorySearchOptions {
	readonly limit?: number;
	readonly maxExcerptChars?: number;
}

export function makeContextSourceRef(entryId: string): string {
	return `${CONTEXT_SOURCE_REF_PREFIX}${entryId}`;
}

export function parseContextSourceRef(ref: string): string | undefined {
	if (!ref.startsWith(CONTEXT_SOURCE_REF_PREFIX)) return undefined;
	const entryId = ref.slice(CONTEXT_SOURCE_REF_PREFIX.length).trim();
	return entryId.length > 0 ? entryId : undefined;
}

interface SearchRecord {
	readonly entryId: string;
	readonly role: string;
	readonly toolName?: string;
	readonly text: string;
	readonly normalizedText: string;
	readonly position: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageSearchText(message: AgentMessage): { text: string; role: string; toolName?: string } {
	if (!isRecord(message)) return { text: "", role: "unknown" };
	const role = stringValue(message.role) ?? "unknown";
	const toolName = stringValue(message.toolName);
	const text = [contextMessageText(message, { includeError: true }), toolName].filter(Boolean).join("\n");
	return { text, role, toolName };
}
const DERIVED_CUSTOM_MESSAGE_TYPES: Record<string, true> = {
	[CONTEXT_CONTINUATION_MESSAGE_TYPE]: true,
	[CONTEXT_PACKET_MESSAGE_TYPE]: true,
	[CONTEXT_PLAN_MESSAGE_TYPE]: true,
	[CONTEXT_RECALL_MESSAGE_TYPE]: true,
};
function entrySearchRecord(entry: SessionEntry, position: number): SearchRecord | undefined {
	if (entry.type === "message") {
		const message = messageSearchText(entry.message);
		if (message.role === "custom" && typeof entry.message === "object" && entry.message !== null) {
			const customType = (entry.message as unknown as Record<string, unknown>).customType;
			if (typeof customType === "string" && DERIVED_CUSTOM_MESSAGE_TYPES[customType]) return undefined;
		}
		const text = message.text;
		return {
			entryId: entry.id,
			role: message.role,
			toolName: message.toolName,
			text,
			normalizedText: normalize(text),
			position,
		};
	}
	if (entry.type !== "custom_message") return undefined;
	if (entry.customType && DERIVED_CUSTOM_MESSAGE_TYPES[entry.customType]) return undefined;
	const role = "custom";
	const toolName = undefined;
	const text = [contextContentText(entry.content), entry.customType].filter(Boolean).join("\n");
	return { entryId: entry.id, role, toolName, text, normalizedText: normalize(text), position };
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function queryTerms(query: string): string[] {
	const normalized = normalize(query.trim());
	if (!normalized) return [];
	const parts = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
	return [...new Set(parts.filter(Boolean))];
}

function termMatchesAt(text: string, term: string, at: number): boolean {
	const before = at > 0 ? text[at - 1] : "";
	const after = text[at + term.length] ?? "";
	if (/\d/u.test(term[0] ?? "") && /\d/u.test(before)) return false;
	if (/\d/u.test(term.at(-1) ?? "") && /\d/u.test(after)) return false;
	return true;
}

function hasTerm(text: string, term: string): boolean {
	let offset = 0;
	while (true) {
		const found = text.indexOf(term, offset);
		if (found < 0) return false;
		if (termMatchesAt(text, term, found)) return true;
		offset = found + Math.max(term.length, 1);
	}
}

function occurrenceCount(text: string, term: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const found = text.indexOf(term, offset);
		if (found < 0) return count;
		if (termMatchesAt(text, term, found)) count++;
		offset = found + Math.max(term.length, 1);
	}
}

function excerpt(text: string, terms: readonly string[], maxChars: number): string {
	const safeMax = Math.max(80, Math.min(maxChars, 2_000));
	if (text.length <= safeMax) return text;
	const normalizedText = normalize(text);
	let matchAt = Number.POSITIVE_INFINITY;
	for (const term of terms) {
		const at = normalizedText.indexOf(term);
		if (at >= 0) matchAt = Math.min(matchAt, at);
	}
	if (!Number.isFinite(matchAt)) matchAt = 0;
	const radius = Math.floor(safeMax / 2);
	const start = Math.max(0, Math.min(matchAt - radius, text.length - safeMax));
	const end = Math.min(text.length, start + safeMax);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function searchRecords(
	records: readonly SearchRecord[],
	query: string,
	options: ContextHistorySearchOptions,
): ContextHistorySearchResult {
	const terms = queryTerms(query);
	if (terms.length === 0) return { query, hits: [], total: 0 };
	const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 8), 20));
	const maxExcerptChars = Math.max(80, Math.min(Math.floor(options.maxExcerptChars ?? 480), 2_000));
	const matches: ContextHistorySearchHit[] = [];
	for (const record of records) {
		if (!record.text) continue;
		const searchable = record.normalizedText;
		const normalizedQuery = normalize(query.trim());
		const hasPunctuation = /[^\p{L}\p{N}\s]/u.test(normalizedQuery);
		const matchedTerms = terms.filter(term => hasTerm(searchable, term));
		if (hasPunctuation) {
			if (!searchable.includes(normalizedQuery)) continue;
		} else if (matchedTerms.length !== terms.length) continue;
		const phrase = normalize(query.trim());
		const phraseCount = phrase.length > 0 ? occurrenceCount(searchable, phrase) : 0;
		const score =
			matchedTerms.reduce((sum, term) => sum + occurrenceCount(searchable, term), 0) + phraseCount * terms.length;
		matches.push({
			ref: makeContextSourceRef(record.entryId),
			entryId: record.entryId,
			role: record.role,
			toolName: record.toolName,
			excerpt: excerpt(record.text, matchedTerms, maxExcerptChars),
			matchedTerms,
			score,
		});
	}
	const positions = new Map(records.map(record => [record.entryId, record.position]));
	matches.sort(
		(left, right) =>
			right.score - left.score || (positions.get(right.entryId) ?? -1) - (positions.get(left.entryId) ?? -1),
	);
	return { query, hits: matches.slice(0, limit), total: matches.length };
}

export class ContextHistoryIndex {
	#branchIds: string[] = [];
	#branchEntries: readonly SessionEntry[] = [];
	#records: SearchRecord[] = [];

	update(branch: readonly SessionEntry[]): void {
		let common = 0;
		while (
			common < this.#branchEntries.length &&
			common < branch.length &&
			this.#branchEntries[common] === branch[common] &&
			this.#branchIds[common] === branch[common]?.id
		)
			common++;
		if (common < this.#branchEntries.length || branch.length < this.#branchEntries.length) {
			this.#branchIds = this.#branchIds.slice(0, common);
			this.#records = this.#records.filter(record => record.position < common);
		}
		for (let position = common; position < branch.length; position++) {
			const entry = branch[position]!;
			this.#branchIds.push(entry.id);
			const record = entrySearchRecord(entry, position);
			if (record) this.#records.push(record);
		}
		this.#branchEntries = branch.slice();
	}

	search(query: string, options: ContextHistorySearchOptions = {}): ContextHistorySearchResult {
		return searchRecords(this.#records, query, options);
	}
}

export function searchContextHistory(
	branch: readonly SessionEntry[],
	query: string,
	options: ContextHistorySearchOptions = {},
): ContextHistorySearchResult {
	const records: SearchRecord[] = [];
	for (let position = 0; position < branch.length; position++) {
		const record = entrySearchRecord(branch[position]!, position);
		if (record) records.push(record);
	}
	return searchRecords(records, query, options);
}
