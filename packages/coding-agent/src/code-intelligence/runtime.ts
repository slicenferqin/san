import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatHashlineHeader } from "@san/hashline";
import {
	canonicalSnapshotKey,
	getFileSnapshotStore,
	recordSeenLines,
	SNAPSHOT_MAX_BYTES,
} from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { ToolSession } from "../tools";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { replaceTabs } from "../tools/render-utils";
import { throwIfAborted } from "../tools/tool-errors";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { CodeGraphProvider } from "./codegraph-provider";
import { LocalCodeIntelligenceProvider } from "./fallback-provider";
import type {
	CodeIntelligenceProvider,
	CodeIntelligenceResult,
	ExploreBackReference,
	ExploreRequest,
	ExploreResultDetails,
	ExploreSourceWindow,
	SourceLineRange,
} from "./types";

const MIN_OUTPUT_CHARS = 12_000;
const MID_OUTPUT_CHARS = 18_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_METADATA_ITEMS = 80;
const MAX_METADATA_ITEM_CHARS = 600;
const TRUNCATION_NOTICE = "[Explore output truncated at its hard character budget; narrow the query or path for more.]";

export interface CodeIntelligenceRuntimeOptions {
	codeGraphProvider?: CodeIntelligenceProvider | null;
	fallbackProvider?: CodeIntelligenceProvider;
	/** Test/embedding seam. Normal sessions use the adaptive 12–24K budget. */
	maxOutputChars?: number;
}

interface SeenRange extends SourceLineRange {
	evidenceRef: string;
}

interface MaterializedFile {
	absolutePath: string;
	displayPath: string;
	lines: string[];
	ranges: SourceLineRange[];
	fingerprint: string;
	snapshotTag?: string;
}

interface PendingWindow {
	file: MaterializedFile;
	range: SourceLineRange;
}

class OutputBudget {
	readonly #parts: string[] = [];
	#length = 0;

	constructor(readonly maxChars: number) {}

	#separatorLength(): number {
		return this.#parts.length > 0 ? 2 : 0;
	}

	available(reserveNotice = true): number {
		const reserve = reserveNotice ? TRUNCATION_NOTICE.length + 2 : 0;
		return Math.max(0, this.maxChars - this.#length - this.#separatorLength() - reserve);
	}

	append(block: string, reserveNotice = true): boolean {
		if (!block) return true;
		if (block.length > this.available(reserveNotice)) return false;
		this.#parts.push(block);
		this.#length += block.length + (this.#parts.length > 1 ? 2 : 0);
		return true;
	}

	appendLineBlock(header: string, lines: readonly string[]): number {
		const available = this.available(true);
		if (available <= header.length + 1) return 0;
		let block = header;
		let count = 0;
		for (const line of lines) {
			const next = `${block}\n${line}`;
			if (next.length > available) break;
			block = next;
			count += 1;
		}
		if (count === 0) return 0;
		this.append(block, true);
		return count;
	}

	finish(truncated: boolean): string {
		if (truncated) this.append(TRUNCATION_NOTICE, false);
		return this.#parts.join("\n\n");
	}
}

function mergeLineRanges(ranges: readonly SourceLineRange[]): SourceLineRange[] {
	const sorted = ranges
		.filter(range => Number.isFinite(range.startLine) && Number.isFinite(range.endLine))
		.map(range => ({
			startLine: Math.max(1, Math.floor(Math.min(range.startLine, range.endLine))),
			endLine: Math.max(1, Math.floor(Math.max(range.startLine, range.endLine))),
		}))
		.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: SourceLineRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

function subtractCovered(range: SourceLineRange, covered: readonly SeenRange[]): SourceLineRange[] {
	let remaining: SourceLineRange[] = [{ ...range }];
	for (const seen of covered) {
		const next: SourceLineRange[] = [];
		for (const candidate of remaining) {
			if (seen.endLine < candidate.startLine || seen.startLine > candidate.endLine) {
				next.push(candidate);
				continue;
			}
			if (seen.startLine > candidate.startLine) {
				next.push({ startLine: candidate.startLine, endLine: seen.startLine - 1 });
			}
			if (seen.endLine < candidate.endLine) {
				next.push({ startLine: seen.endLine + 1, endLine: candidate.endLine });
			}
		}
		remaining = next;
		if (remaining.length === 0) break;
	}
	return remaining;
}

function safeSourceLine(value: string): string {
	return replaceTabs(Bun.stripANSI(value)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function safeMetadata(value: string): string {
	return safeSourceLine(value).replace(/\s+/g, " ").trim().slice(0, MAX_METADATA_ITEM_CHARS);
}

function normalizeMetadata(values: readonly string[]): string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = safeMetadata(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(normalized);
		if (output.length >= MAX_METADATA_ITEMS) break;
	}
	return output;
}

function isWithinRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveScope(requestPath: string): Promise<{ path: string; root: string; isFile: boolean }> {
	const resolved = path.resolve(requestPath);
	const stat = await fs.stat(resolved);
	const isFile = stat.isFile();
	const realPath = await fs.realpath(resolved);
	return { path: realPath, root: isFile ? path.dirname(realPath) : realPath, isFile };
}

async function resolveProviderPath(
	rawPath: string,
	scope: { path: string; root: string; isFile: boolean },
): Promise<string | null> {
	const cleaned = rawPath.replace(/^`|`$/g, "").trim();
	if (!cleaned) return null;
	const candidate = scope.isFile
		? scope.path
		: path.isAbsolute(cleaned)
			? path.resolve(cleaned)
			: path.resolve(scope.root, cleaned);
	try {
		const realPath = await fs.realpath(candidate);
		if (scope.isFile ? realPath !== scope.path : !isWithinRoot(realPath, scope.root)) return null;
		const stat = await fs.stat(realPath);
		return stat.isFile() ? realPath : null;
	} catch {
		return null;
	}
}

function adaptiveOutputChars(configured: number, repositoryFileCount: number | undefined, maxFiles: number): number {
	if (configured > 0) return Math.min(MAX_OUTPUT_CHARS, Math.max(MIN_OUTPUT_CHARS, Math.floor(configured)));
	if (repositoryFileCount !== undefined) {
		if (repositoryFileCount <= 500) return MIN_OUTPUT_CHARS;
		if (repositoryFileCount <= 5_000) return MID_OUTPUT_CHARS;
		return MAX_OUTPUT_CHARS;
	}
	if (maxFiles <= 4) return MIN_OUTPUT_CHARS;
	if (maxFiles <= 8) return MID_OUTPUT_CHARS;
	return MAX_OUTPUT_CHARS;
}

export function resolveExploreOutputChars(
	configured: number,
	repositoryFileCount: number | undefined,
	maxFiles: number,
): number {
	return adaptiveOutputChars(configured, repositoryFileCount, maxFiles);
}

function meaningfulResult(result: CodeIntelligenceResult | null): result is CodeIntelligenceResult {
	return Boolean(
		result && (result.sourceWindows.length > 0 || result.relationships.length > 0 || result.blastRadius.length > 0),
	);
}

function appendListSection(writer: OutputBudget, heading: string, values: readonly string[]): boolean {
	if (values.length === 0) return true;
	if (!writer.append(`### ${heading}`)) return false;
	for (const value of values) {
		if (!writer.append(`- ${value}`)) return false;
	}
	return true;
}

export class CodeIntelligenceRuntime {
	readonly #codeGraphProvider: CodeIntelligenceProvider | null;
	readonly #fallbackProvider: CodeIntelligenceProvider;
	readonly #maxOutputCharsOverride: number | undefined;
	readonly #seenByFingerprint = new Map<string, SeenRange[]>();
	#callCounter = 0;

	constructor(
		private readonly session: ToolSession,
		options?: CodeIntelligenceRuntimeOptions,
	) {
		this.#codeGraphProvider =
			options?.codeGraphProvider === undefined ? new CodeGraphProvider(session) : options.codeGraphProvider;
		this.#fallbackProvider = options?.fallbackProvider ?? new LocalCodeIntelligenceProvider(session);
		this.#maxOutputCharsOverride = options?.maxOutputChars;
	}

	async #selectProvider(request: ExploreRequest, signal?: AbortSignal): Promise<CodeIntelligenceResult> {
		if (this.#codeGraphProvider) {
			try {
				const result = await this.#codeGraphProvider.explore(request, signal);
				if (meaningfulResult(result)) return result;
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof Error && error.name === "AbortError") throw error;
			}
		}
		return this.#fallbackProvider.explore(request, signal).then(
			result =>
				result ?? {
					provider: "text-fallback",
					freshness: "unavailable",
					sourceWindows: [],
					relationships: [],
					blastRadius: [],
				},
		);
	}

	async #materializeFiles(
		request: ExploreRequest,
		result: CodeIntelligenceResult,
		signal?: AbortSignal,
	): Promise<MaterializedFile[]> {
		const scope = await resolveScope(request.path);
		const displayCwd = await fs.realpath(this.session.cwd).catch(() => path.resolve(this.session.cwd));
		const grouped = new Map<string, SourceLineRange[]>();
		for (const hint of result.sourceWindows) {
			throwIfAborted(signal);
			const absolutePath = await resolveProviderPath(hint.path, scope);
			if (!absolutePath) continue;
			const ranges = grouped.get(absolutePath) ?? [];
			ranges.push(...hint.ranges);
			grouped.set(absolutePath, ranges);
		}

		const files: MaterializedFile[] = [];
		for (const [absolutePath, hintedRanges] of grouped) {
			if (files.length >= request.maxFiles) break;
			throwIfAborted(signal);
			try {
				const content = normalizeToLF(await Bun.file(absolutePath).text());
				if (content.includes("\0")) continue;
				const lines = content.split("\n");
				const ranges = mergeLineRanges(hintedRanges)
					.map(range => ({
						startLine: Math.min(lines.length, range.startLine),
						endLine: Math.min(lines.length, range.endLine),
					}))
					.filter(range => range.startLine >= 1 && range.endLine >= range.startLine);
				if (ranges.length === 0) continue;
				const fingerprint = `${content.length}:${Bun.hash(content).toString(16)}`;
				const snapshotTag =
					Buffer.byteLength(content) <= SNAPSHOT_MAX_BYTES
						? getFileSnapshotStore(this.session).record(canonicalSnapshotKey(absolutePath), content)
						: undefined;
				files.push({
					absolutePath,
					displayPath: formatPathRelativeToCwd(absolutePath, displayCwd),
					lines,
					ranges,
					fingerprint,
					snapshotTag,
				});
			} catch {
				// A provider pointer may race a delete/rename. Omit that window and
				// continue with other current-disk evidence.
			}
		}
		return files;
	}

	#partitionWindows(files: readonly MaterializedFile[]): {
		pending: PendingWindow[];
		backReferences: ExploreBackReference[];
	} {
		const pending: PendingWindow[] = [];
		const backReferences: ExploreBackReference[] = [];
		const seenBackReferences = new Set<string>();
		for (const file of files) {
			const key = `${file.absolutePath}\0${file.fingerprint}`;
			const seen = this.#seenByFingerprint.get(key) ?? [];
			for (const range of file.ranges) {
				for (const prior of seen) {
					const startLine = Math.max(range.startLine, prior.startLine);
					const endLine = Math.min(range.endLine, prior.endLine);
					if (startLine > endLine) continue;
					const backReferenceKey = `${file.displayPath}:${startLine}:${endLine}:${prior.evidenceRef}`;
					if (seenBackReferences.has(backReferenceKey)) continue;
					seenBackReferences.add(backReferenceKey);
					backReferences.push({ path: file.displayPath, startLine, endLine, evidenceRef: prior.evidenceRef });
				}
				for (const uncovered of subtractCovered(range, seen)) pending.push({ file, range: uncovered });
			}
		}
		return { pending, backReferences };
	}

	#recordSeen(file: MaterializedFile, window: ExploreSourceWindow): void {
		const key = `${file.absolutePath}\0${file.fingerprint}`;
		const seen = this.#seenByFingerprint.get(key) ?? [];
		seen.push({ startLine: window.startLine, endLine: window.endLine, evidenceRef: window.evidenceRef });
		this.#seenByFingerprint.set(key, seen);
		if (file.snapshotTag) {
			recordSeenLines(
				this.session,
				file.absolutePath,
				file.snapshotTag,
				Array.from({ length: window.endLine - window.startLine + 1 }, (_, index) => window.startLine + index),
			);
		}
	}

	async explore(
		request: ExploreRequest,
		configuredMaxOutputChars: number,
		signal?: AbortSignal,
	): Promise<{ text: string; details: ExploreResultDetails }> {
		throwIfAborted(signal);
		const result = await this.#selectProvider(request, signal);
		const files = await this.#materializeFiles(request, result, signal);
		const { pending, backReferences } = this.#partitionWindows(files);
		const relationships = normalizeMetadata(result.relationships);
		const blastRadius = normalizeMetadata(result.blastRadius);
		const pendingFiles = result.pendingFiles?.map(value => safeMetadata(value)).filter(Boolean);
		const maxOutputChars =
			this.#maxOutputCharsOverride ??
			adaptiveOutputChars(configuredMaxOutputChars, result.repositoryFileCount, request.maxFiles);
		const writer = new OutputBudget(Math.max(512, Math.floor(maxOutputChars)));
		this.#callCounter += 1;
		const callId = this.#callCounter;
		const sourceWindows: ExploreSourceWindow[] = [];
		const evidenceRefs: string[] = [];
		let truncated = false;

		writer.append(`## Explore\nprovider: ${result.provider}\nfreshness: ${result.freshness}`, true);
		if (result.freshness === "pending-files") {
			writer.append(
				`[Freshness: pending-files] Source windows below were re-read from the current disk. Graph relationships are hints until pending files are indexed.${pendingFiles?.length ? ` Pending: ${pendingFiles.join(", ")}` : ""}`,
				true,
			);
		} else if (result.freshness === "stale-index") {
			writer.append(
				"[Freshness: stale-index] Source windows below are current-disk reads; graph relationships and blast radius are hints only.",
				true,
			);
		} else if (result.freshness === "unavailable") {
			writer.append("[Freshness: unavailable] No current source evidence matched this query.", true);
		}

		if (pending.length > 0) writer.append("### Source windows", true);
		const hashLines = resolveFileDisplayMode(this.session).hashLines;
		for (const candidate of pending) {
			const evidenceRef = `explore-ref:${callId}.${sourceWindows.length + 1}`;
			const { file, range } = candidate;
			const bodyLines = file.lines.slice(range.startLine - 1, range.endLine).map((line, index) => {
				const lineNumber = range.startLine + index;
				return hashLines
					? `${lineNumber}:${safeSourceLine(line ?? "")}`
					: `${lineNumber}|${safeSourceLine(line ?? "")}`;
			});
			const fileHeader =
				hashLines && file.snapshotTag
					? formatHashlineHeader(file.displayPath, file.snapshotTag)
					: `#### ${file.displayPath}`;
			const emittedLines = writer.appendLineBlock(`ref: ${evidenceRef}\n${fileHeader}`, bodyLines);
			if (emittedLines === 0) {
				truncated = true;
				break;
			}
			const window: ExploreSourceWindow = {
				path: file.displayPath,
				startLine: range.startLine,
				endLine: range.startLine + emittedLines - 1,
				evidenceRef,
				snapshotTag: file.snapshotTag,
			};
			sourceWindows.push(window);
			evidenceRefs.push(evidenceRef);
			this.#recordSeen(file, window);
			if (emittedLines < bodyLines.length) {
				truncated = true;
				break;
			}
		}

		if (!truncated && !appendListSection(writer, "Blast radius", blastRadius)) truncated = true;
		if (!truncated && !appendListSection(writer, "Relationships", relationships)) truncated = true;
		if (!truncated && backReferences.length > 0) {
			if (!writer.append("### Back-references", true)) {
				truncated = true;
			} else {
				for (const reference of backReferences) {
					if (
						!writer.append(
							`- ${reference.path}:${reference.startLine}-${reference.endLine} -> ${reference.evidenceRef}`,
							true,
						)
					) {
						truncated = true;
						break;
					}
				}
			}
		}
		if (!truncated && pending.length === 0 && backReferences.length === 0 && result.freshness !== "unavailable") {
			writer.append("No source windows were returned; relationships above are provider hints only.", true);
		}

		const text = writer.finish(truncated);
		const details: ExploreResultDetails = {
			provider: result.provider,
			freshness: result.freshness,
			sourceWindows,
			relationships,
			blastRadius,
			evidenceRefs,
			pendingFiles: pendingFiles?.length ? pendingFiles : undefined,
			backReferences: backReferences.length > 0 ? backReferences : undefined,
			truncated,
			maxOutputChars: writer.maxChars,
			outputChars: text.length,
		};
		return { text, details };
	}
}
