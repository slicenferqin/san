/**
 * Session-bound file snapshot store.
 *
 * Used by `read` and `search` to record exactly what the model saw, and by
 * the hashline patcher to verify or recover from stale section tags (file
 * changed externally between read and edit, or a prior in-session edit
 * advanced the tag). The store is the {@link InMemorySnapshotStore}
 * from `@san/hashline`; the only coding-agent-specific concern here
 * is wiring it onto the per-session owner object.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@san/hashline";
import { normalizeToLF } from "./normalize";

/**
 * Upper bound on the file size we snapshot. A section tag is a content hash of
 * the *whole* file, so minting one means holding the full normalized text in
 * the store. Files above this cap emit no `[path#tag]` header — line-anchored
 * editing of multi-megabyte files is out of scope under the full-content model.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

interface FileSnapshotStoreOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

/**
 * Look up (or lazily create) the file snapshot store attached to a session.
 * Storage lives on `session.fileSnapshotStore` so it ages out exactly with
 * the session itself.
 */
export function getFileSnapshotStore(session: FileSnapshotStoreOwner): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}

/**
 * Canonicalize an absolute path into the stable key the snapshot store uses.
 *
 * Different code paths reach the snapshot store via different path forms:
 * `read local://foo.md` records under the file's `fs.realpath` (the local
 * protocol handler resolves symlinks); a subsequent `edit` may address the
 * same artifact via `local://foo.md`, whose resolver does NOT realpath, or
 * via the absolute path returned in the `[path#tag]` header. macOS adds the
 * same hazard at the working-tree level (`/tmp/...` vs `/private/tmp/...`).
 * Collapsing every key through `realpath` makes those forms fuse onto one
 * snapshot entry, so a freshly-minted tag is never rejected as stale just
 * because the lookup spelled the same file differently.
 *
 * Non-existent paths (new-file writes) fall back to a realpath of the parent
 * directory + basename, then to the input. This keeps creates and updates on
 * the same canonical key.
 */
export function canonicalSnapshotKey(absolutePath: string): string {
	try {
		return fs.realpathSync.native(absolutePath);
	} catch {
		try {
			const parent = fs.realpathSync.native(path.dirname(absolutePath));
			return path.join(parent, path.basename(absolutePath));
		} catch {
			return absolutePath;
		}
	}
}

/**
 * Read the full text of `absolutePath` (within {@link SNAPSHOT_MAX_BYTES}),
 * record it as a version snapshot, and return its content-hash tag. Returns
 * `undefined` when the file exceeds the cap or cannot be read — callers then
 * omit the section header so the model never sees a tag it can't anchor against.
 *
 * Producers that only displayed a slice of the file (range reads, search hits)
 * use this to mint a whole-file tag: the displayed lines stay partial, but the
 * tag fingerprints the entire file so a follow-up edit anchored at any line
 * validates whenever the live file is byte-identical to what was read. Raw
 * reads pass `seenLines` even though they do not emit a header, letting a prior
 * or later same-content hashline tag inherit the raw range's provenance.
 */
export async function recordFileSnapshot(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	seenLines?: Iterable<number>,
): Promise<string | undefined> {
	try {
		const file = Bun.file(absolutePath);
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const text = await file.text();
		// A stat-then-read race on a growing file is not worth a second guard:
		// the caller prints the tag either way, and an oversized body only means
		// the store skipped provenance.
		return recordSnapshotTextInternal(session, absolutePath, text, seenLines);
	} catch {
		return undefined;
	}
}
/**
 * Sync twin of {@link recordFileSnapshot} for content the caller already holds
 * (an editor buffer, a resumed session). Same contract, including the staged
 * provenance hand-off.
 */
export function recordSnapshotText(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	fullText: string,
	seenLines?: Iterable<number>,
): void {
	recordSnapshotTextInternal(session, absolutePath, fullText, seenLines);
}

/**
 * Mint (or reuse) the snapshot for `text` and hand its seen-line claim to the
 * active provenance scope. The lines are deliberately *not* attached here: the
 * tag must exist before the caller prints it, but a later stage can still
 * shorten the body those lines describe, and an eager record is exactly the
 * thing that authorizes lines the model never received. An empty `seenLines`
 * records a known-zero observation; only `undefined` leaves provenance unknown.
 */
function recordSnapshotTextInternal(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	sourceText: string,
	seenLines?: Iterable<number>,
): string | undefined {
	const normalized = normalizeToLF(sourceText);
	const lines = seenLines === undefined ? undefined : Array.from(seenLines);
	// The snapshot is minted first because the caller prints the tag before the
	// body is delivered; the claim is staged so the lines land only on a tag the
	// store still holds. Staging after the mint also closes the await window in
	// the async twin, where another mint of the same content could otherwise
	// shift the LRU entry between `record` and `recordSeenLines`.
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	if (lines !== undefined) {
		stageOrRecord({
			kind: "text",
			owner: session,
			key: canonicalSnapshotKey(absolutePath),
			text: normalized,
			lines,
		});
	}
	return tag;
}

/**
 * Leading line-number prefix the hashline/summary/grep formatters stamp on
 * every displayed body line: `NN:` or a collapsed summary `NN-MM:` from `read`,
 * optionally preceded by a grep `*` (match) / space (context) marker from
 * `search`/`ast-grep`. Anchored at line start, so source content after the
 * colon never matches.
 */
const HASHLINE_LINE_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;
/**
 * The `…` the column cap stamps where a source line continued. A numbered row
 * ending in it shows a prefix, never the whole line.
 */
const CLIPPED_ROW_SUFFIX = "…";

/** Does this displayed row end where the column cap cut the source line? */
function isClippedDisplayRow(row: string): boolean {
	return row.endsWith(CLIPPED_ROW_SUFFIX);
}

/**
 * The 1-indexed file lines a hashline-formatted body actually displayed.
 * Single `NN:` rows contribute that line; a collapsed summary `NN-MM:` row
 * (a `{ … }` brace pair) contributes only its boundary lines `NN` and `MM` —
 * the elided interior was never shown, so editing inside it must be rejected.
 */
export function parseSeenLinesFromHashlineBody(body: string): number[] {
	const seen: number[] = [];
	for (const row of body.split("\n")) {
		// A clipped row shows a prefix plus `…`: it proves the line number was
		// displayed, never that its content was. Anchoring an edit there would
		// rewrite a line the model never fully saw.
		if (isClippedDisplayRow(row)) continue;
		const match = HASHLINE_LINE_PREFIX.exec(row);
		if (!match) continue;
		seen.push(Number(match[1]));
		if (match[2] !== undefined) seen.push(Number(match[2]));
	}
	return seen;
}

/** Merge explicit 1-indexed displayed lines into a recorded hashline snapshot. */
export function recordSeenLines(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	lines: readonly number[],
): void {
	const key = canonicalSnapshotKey(absolutePath);
	stageOrRecord({ kind: "lines", owner: session, key, tag, lines: Array.from(lines) });
}

/**
 * Attach the lines a read displayed to the snapshot it minted, so the patcher's
 * (opt-in) seen-line guard can reject edits anchored on lines the model never
 * saw. Best-effort: a no-op when the body has no numbered rows or the snapshot
 * already aged out. `tag` must be the tag returned when this exact content was
 * recorded.
 *
 * A numbered row is not enough on its own: `parseSeenLinesFromHashlineBody`
 * drops rows the column cap left unfinished, so a line displayed only as a
 * prefix authorizes nothing.
 */
export function recordSeenLinesFromBody(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	body: string,
): void {
	stageOrRecord({
		kind: "body",
		owner: session,
		key: canonicalSnapshotKey(absolutePath),
		tag,
		body,
	});
}

// =============================================================================
// Staged provenance
// =============================================================================

/**
 * A seen-line claim held until the delivered result is known. Producers format
 * their body before the central artifact spill can shorten it, so recording at
 * format time marks lines the model never receives as seen.
 * - `lines`: explicit 1-indexed lines with no body to check them against.
 * - `body`: the hashline-formatted body as one string. A row the column cap
 *   left unfinished ends in an `…` where the source continued: the display
 *   proves a prefix, never the line, so that row's number authorizes nothing.
 * - `text`: the full source text (and therefore the tag) the lines belong to.
 */
export type StagedProvenance =
	| { kind: "lines"; owner: FileSnapshotStoreOwner; key: string; tag: string; lines: readonly number[] }
	| { kind: "body"; owner: FileSnapshotStoreOwner; key: string; tag: string; body: string }
	| { kind: "text"; owner: FileSnapshotStoreOwner; key: string; text: string; lines: readonly number[] };

const provenanceStaging = new AsyncLocalStorage<{ claims: StagedProvenance[]; nested: boolean }>();

/**
 * A live provenance scope: `result` is `fn`'s return value and `commit` resolves
 * every claim staged while it ran against the text actually delivered.
 *
 * The commit has to be callable *outside* `fn` — the delivered text is only
 * known once the producer's output comes back — so the scope hands its bag back
 * instead of relying on the async context still being active.
 */
export interface StagedProvenanceScope<T> {
	readonly result: T;
	readonly isRoot: boolean;
	commit(delivered: string, deliveredIsProducerOutput: boolean): number;
}

/**
 * Run `fn` with a fresh provenance bag: producers reached inside stage their
 * claims instead of recording them, and the returned {@link StagedProvenanceScope}
 * resolves them once the delivered content is known. Outside any scope — a
 * direct `new ReadTool(...).execute(...)`, an embedder, a search tool — claims
 * record eagerly, exactly as they did before this existed.
 */
export function withStagedProvenance<T>(fn: () => T): StagedProvenanceScope<T> {
	const parent = provenanceStaging.getStore();
	const staged = parent ?? { claims: [], nested: false };
	if (parent) parent.nested = true;
	const result = provenanceStaging.run(staged, fn);
	return {
		result,
		isRoot: parent === undefined,
		commit: (delivered, deliveredIsProducerOutput) =>
			parent ? 0 : commitStagedProvenance(staged.claims, delivered, deliveredIsProducerOutput && !staged.nested),
	};
}

/** Record one claim now, or hand it to the active bag. The bag decides *when*. */
function stageOrRecord(claim: StagedProvenance): void {
	const staged = provenanceStaging.getStore();
	if (staged) {
		staged.claims.push(claim);
		return;
	}
	commitProvenance(claim, "", true);
}

/** The lines a claim can still prove were delivered. `delivered` is the exact
 * text the model receives; `deliveredIsProducerOutput` says whether that text
 * *is* what the producer formatted. */
function verifiableLines(
	claim: StagedProvenance,
	delivered: string,
	deliveredIsProducerOutput: boolean,
): readonly number[] {
	if (claim.kind === "lines") {
		// An explicit line list cannot be matched to a body at all: only an
		// unshortened delivery proves it.
		return deliveredIsProducerOutput ? claim.lines : [];
	}
	if (deliveredIsProducerOutput) {
		return claim.kind === "text" ? claim.lines : parseSeenLinesFromHashlineBody(claim.body);
	}
	if (claim.kind === "text") {
		// An explicit line list cannot be matched to a shortened body.
		return [];
	}
	const deliveredRows = new Set(delivered.split("\n"));
	const survivors = claim.body
		.split("\n")
		.filter(row => deliveredRows.has(row))
		.join("\n");
	return parseSeenLinesFromHashlineBody(survivors);
}

/** Records one resolved claim under its own tag. */
function recordProvenance(claim: StagedProvenance, proven: readonly number[]): void {
	const store = getFileSnapshotStore(claim.owner);
	if (claim.kind === "text") store.record(claim.key, claim.text, proven);
	else store.recordSeenLines(claim.key, claim.tag, proven);
}

/** Returns 1 when a shortened body leaves the claim without proof. */
function commitProvenance(claim: StagedProvenance, delivered: string, deliveredIsProducerOutput: boolean): number {
	const proven = verifiableLines(claim, delivered, deliveredIsProducerOutput);
	recordProvenance(claim, proven);
	if (!deliveredIsProducerOutput && claim.kind === "lines") {
		// The body was shortened and this claim carries no rows to check against
		// it: an explicit line list cannot be matched to a body at all.
		// Record the known-zero observation without discarding prior seen lines.
		return claim.lines.length > 0 ? 1 : 0;
	}
	return 0;
}

/**
 * Resolve staged claims against `delivered`, the exact text the model receives.
 *
 * When `delivered` *is* the producer's own output the claims replay verbatim.
 * When a later stage shortened it, a claim is trusted only line by line: rows
 * present in `delivered` keep their lines, elided rows lose them, a row the
 * column cap clipped keeps nothing, and a claim with no rows to check proves no
 * lines. Zero-survivor observations record an empty set when no prior displayed
 * lines exist; existing coverage is preserved by the store's union.
 *
 * Returns how many explicit-line claims lost their proof, so the caller can report
 * that a shortened result carries no verifiable provenance.
 */
export function commitStagedProvenance(
	staged: readonly StagedProvenance[],
	delivered: string,
	deliveredIsProducerOutput: boolean,
): number {
	let unverified = 0;
	for (const claim of staged) unverified += commitProvenance(claim, delivered, deliveredIsProducerOutput);
	return unverified;
}
