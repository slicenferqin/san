import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AstFindResult, astGrep, GrepOutputMode, type GrepResult, grep } from "@san/natives";
import { LspTool } from "../lsp";
import type { ToolSession } from "../tools";
import { throwIfAborted } from "../tools/tool-errors";
import type {
	CodeIntelligenceProvider,
	CodeIntelligenceProviderId,
	CodeIntelligenceResult,
	ExploreRequest,
	SourceLineRange,
	SourceWindowHint,
} from "./types";

const FALLBACK_TIMEOUT_MS = 20_000;
const LSP_TIMEOUT_SECONDS = 3;
const MAX_QUERY_TERMS = 8;
const MAX_TERM_LENGTH = 160;

const QUERY_STOP_WORDS = new Set([
	"a",
	"about",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"code",
	"does",
	"file",
	"find",
	"for",
	"from",
	"how",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"the",
	"this",
	"to",
	"what",
	"where",
	"which",
	"with",
]);

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerm(value: string): string {
	return value
		.trim()
		.replace(/^[`'"([{<]+|[`'"\])}>.,;!?，。；！？：]+$/g, "")
		.trim();
}

function isHighSignalTerm(value: string): boolean {
	return /[A-Z0-9_$./\\:-]/.test(value) || /[\p{L}\p{N}]_[\p{L}\p{N}_]/u.test(value);
}

/** Deterministic query-to-search-term projection used by the no-index path. */
export function extractExploreTerms(query: string): string[] {
	const candidates: string[] = [];
	for (const match of query.matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
		if (match[1]) candidates.push(match[1]);
	}
	for (const match of query.matchAll(/[$_\p{L}][$_\p{L}\p{N}./\\:-]*/gu)) {
		candidates.push(match[0]);
	}

	const unique: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const term = normalizeTerm(candidate);
		const key = term.toLowerCase();
		if (term.length < 2 || term.length > MAX_TERM_LENGTH || QUERY_STOP_WORDS.has(key) || seen.has(key)) continue;
		seen.add(key);
		unique.push(term);
	}
	unique.sort((left, right) => Number(isHighSignalTerm(right)) - Number(isHighSignalTerm(left)));

	if (unique.length === 0) {
		const fallback = normalizeTerm(query);
		if (fallback.length >= 2 && fallback.length <= MAX_TERM_LENGTH) unique.push(fallback);
	}
	return unique.slice(0, MAX_QUERY_TERMS);
}

function resolveMatchPath(scopePath: string, scopeIsFile: boolean, matchPath: string): string {
	if (scopeIsFile) return scopePath;
	return path.isAbsolute(matchPath) ? path.resolve(matchPath) : path.resolve(scopePath, matchPath);
}

function addRange(byPath: Map<string, SourceLineRange[]>, filePath: string, startLine: number, endLine: number): void {
	const ranges = byPath.get(filePath) ?? [];
	ranges.push({ startLine: Math.max(1, startLine), endLine: Math.max(1, endLine) });
	byPath.set(filePath, ranges);
}

function addAstMatches(
	byPath: Map<string, SourceLineRange[]>,
	result: AstFindResult,
	scopePath: string,
	scopeIsFile: boolean,
): void {
	for (const match of result.matches) {
		addRange(
			byPath,
			resolveMatchPath(scopePath, scopeIsFile, match.path),
			Math.max(1, match.startLine - 2),
			match.endLine + 2,
		);
	}
}

function addGrepMatches(
	byPath: Map<string, SourceLineRange[]>,
	result: GrepResult,
	scopePath: string,
	scopeIsFile: boolean,
): void {
	for (const match of result.matches) {
		const before = match.contextBefore?.[0]?.lineNumber ?? match.lineNumber;
		const after = match.contextAfter?.at(-1)?.lineNumber ?? match.lineNumber;
		addRange(byPath, resolveMatchPath(scopePath, scopeIsFile, match.path), before, after);
	}
}

interface LspSearchResult {
	locations: Array<{ path: string; line: number }>;
	relationships: string[];
}

function parseLspSymbols(text: string, cwd: string): LspSearchResult {
	const locations: Array<{ path: string; line: number }> = [];
	const relationships: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = Bun.stripANSI(rawLine).trim();
		const location = /@\s+(.+):(\d+):(\d+)\s*$/.exec(line);
		if (!location) continue;
		const rawPath = location[1];
		const lineNumber = Number(location[2]);
		if (!rawPath || !Number.isFinite(lineNumber)) continue;
		locations.push({ path: path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath), line: lineNumber });
		relationships.push(`LSP symbol: ${line}`);
	}
	return { locations, relationships };
}

function isWithinCwd(filePath: string, cwd: string): boolean {
	const relative = path.relative(path.resolve(cwd), path.resolve(filePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runLspSearch(
	session: ToolSession,
	request: ExploreRequest,
	term: string | undefined,
	signal?: AbortSignal,
): Promise<LspSearchResult | null> {
	if (!term || session.enableLsp === false || !session.settings.get("lsp.enabled")) return null;
	if (!isWithinCwd(request.path, session.cwd)) return null;
	const result = await new LspTool(session).execute(
		"explore-lsp-symbols",
		{ action: "symbols", file: "*", query: term, timeout: LSP_TIMEOUT_SECONDS },
		signal,
	);
	const text = result.content
		.filter(item => item.type === "text")
		.map(item => item.text)
		.join("\n");
	return parseLspSymbols(text, session.cwd);
}

export class LocalCodeIntelligenceProvider implements CodeIntelligenceProvider {
	constructor(private readonly session: ToolSession) {}

	async explore(request: ExploreRequest, signal?: AbortSignal): Promise<CodeIntelligenceResult> {
		throwIfAborted(signal);
		const scopePath = path.resolve(request.path);
		const scopeStat = await fs.stat(scopePath);
		const scopeIsFile = scopeStat.isFile();
		const terms = extractExploreTerms(request.query);
		const pattern = terms.map(escapeRegex).join("|");
		const structuralTerm = terms.find(term => /^[$_\p{L}][$_\p{L}\p{N}]*$/u.test(term));
		const maxMatches = Math.max(20, request.maxFiles * 10);

		const astPromise = structuralTerm
			? astGrep({
					patterns: [structuralTerm],
					path: scopePath,
					limit: maxMatches,
					offset: 0,
					includeMeta: false,
					signal,
					timeoutMs: FALLBACK_TIMEOUT_MS,
				})
			: Promise.resolve(null);
		const grepPromise = pattern
			? grep({
					pattern,
					path: scopePath,
					ignoreCase: false,
					hidden: true,
					gitignore: true,
					maxCount: maxMatches,
					maxCountPerFile: 10,
					contextBefore: 2,
					contextAfter: 2,
					mode: GrepOutputMode.Content,
					signal,
					timeoutMs: FALLBACK_TIMEOUT_MS,
				})
			: Promise.resolve(null);
		const lspPromise = runLspSearch(this.session, request, structuralTerm, signal);

		const [astSettled, grepSettled, lspSettled] = await Promise.allSettled([astPromise, grepPromise, lspPromise]);
		throwIfAborted(signal);

		const astResult = astSettled.status === "fulfilled" ? astSettled.value : null;
		const grepResult = grepSettled.status === "fulfilled" ? grepSettled.value : null;
		const lspResult = lspSettled.status === "fulfilled" ? lspSettled.value : null;
		const byPath = new Map<string, SourceLineRange[]>();
		if (astResult) addAstMatches(byPath, astResult, scopePath, scopeIsFile);
		if (grepResult) addGrepMatches(byPath, grepResult, scopePath, scopeIsFile);
		if (lspResult) {
			for (const location of lspResult.locations) {
				addRange(byPath, location.path, Math.max(1, location.line - 3), location.line + 3);
			}
		}

		const sourceWindows: SourceWindowHint[] = Array.from(byPath, ([windowPath, ranges]) => ({
			path: windowPath,
			ranges,
		})).slice(0, request.maxFiles);
		const provider: CodeIntelligenceProviderId =
			(astResult?.matches.length ?? 0) > 0 || (lspResult?.locations.length ?? 0) > 0 ? "lsp-ast" : "text-fallback";
		const occurrenceFiles = sourceWindows.length;
		const relationships = lspResult?.relationships.slice(0, 20) ?? [];
		if (astResult && astResult.totalMatches > 0) {
			relationships.push(
				`AST occurrences: ${astResult.totalMatches} match(es) across ${astResult.filesWithMatches} file(s).`,
			);
		}
		const blastRadius =
			occurrenceFiles > 0
				? [
						`Fallback heuristic: ${occurrenceFiles} current-disk occurrence file(s); call/import semantics require a fresh graph or targeted LSP references.`,
					]
				: [];
		const repositoryFileCount = Math.max(astResult?.filesSearched ?? 0, grepResult?.filesSearched ?? 0);

		return {
			provider,
			freshness: sourceWindows.length > 0 || relationships.length > 0 ? "fresh" : "unavailable",
			sourceWindows,
			relationships,
			blastRadius,
			repositoryFileCount: repositoryFileCount > 0 ? repositoryFileCount : undefined,
		};
	}
}
