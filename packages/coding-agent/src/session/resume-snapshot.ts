import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEntry, SessionHeader, UsageStatistics } from "./session-entries";
import { parseTitleSlotLine } from "./session-title-slot";

export const RESUME_SNAPSHOT_SCHEMA_VERSION = 2;
export const RESUME_SNAPSHOT_SUFFIX = ".resume.json";
const SESSION_JOURNAL_SUFFIX = ".jsonl";
const CHECKSUM_PREFIX = "sha256:";
export const RESUME_SNAPSHOT_TAIL_HASH_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SIDECAR_MODE = 0o600;
const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;
export interface ResumeSnapshotJournalRef {
	path: string;
	byteOffset: number;
	lastEntryId: string | null;
	revision: number;
	size: number;
	tailHash: string;
	dev?: number;
	ino?: number;
	mtimeMs?: number;
}
export interface ResumeSnapshotBranchIndex {
	leafId: string | null;
	rootId: string | null;
	activeEntryRefs: readonly string[];
	parentIndex: Readonly<Record<string, string | null>>;
}
export interface ResumeSnapshotRuntime {
	header: SessionHeader;
	activeEntries: SessionEntry[];
	usage: UsageStatistics;
}

/** 在深拷贝前检查运行状态大小，避免为无法保存的快照复制整份历史。 */
export function assertResumeSnapshotRuntimeSize(runtime: ResumeSnapshotRuntime): void {
	let bytes = Buffer.byteLength(JSON.stringify({ ...runtime, activeEntries: [] }), "utf8");
	for (const [index, entry] of runtime.activeEntries.entries()) {
		bytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + (index === 0 ? 0 : 1);
		if (bytes > MAX_SNAPSHOT_BYTES) {
			throw new Error(`Resume snapshot runtime exceeds ${MAX_SNAPSHOT_BYTES} bytes (${bytes} bytes observed)`);
		}
	}
	if (bytes > MAX_SNAPSHOT_BYTES) {
		throw new Error(`Resume snapshot runtime exceeds ${MAX_SNAPSHOT_BYTES} bytes (${bytes} bytes observed)`);
	}
}
export interface ResumeSnapshot {
	schemaVersion: typeof RESUME_SNAPSHOT_SCHEMA_VERSION;
	sessionId: string;
	createdAt: string;
	journal: ResumeSnapshotJournalRef;
	branch: ResumeSnapshotBranchIndex;
	runtime: ResumeSnapshotRuntime;
	checksum: string;
}
export interface ResumeSnapshotJournalRefInput {
	path: string;
	byteOffset: number;
	lastEntryId: string | null;
	revision: number;
	size: number;
}

export function resumeSnapshotPath(sessionFile: string): string {
	const base = sessionFile.endsWith(SESSION_JOURNAL_SUFFIX)
		? sessionFile.slice(0, -SESSION_JOURNAL_SUFFIX.length)
		: sessionFile;
	return `${base}${RESUME_SNAPSHOT_SUFFIX}`;
}
export function resumeSnapshotTempPath(snapshotPath: string): string {
	return `${snapshotPath}.${process.pid}.${Date.now().toString(36)}.${crypto.randomUUID()}.tmp`;
}
export function isResumeSnapshotTempPath(snapshotPath: string, filePath: string): boolean {
	const n = path.basename(filePath);
	return n.startsWith(`${path.basename(snapshotPath)}.`) && n.endsWith(".tmp");
}
export function isSettledResumeSnapshotJournalRef(ref: ResumeSnapshotJournalRef): boolean {
	return Number.isSafeInteger(ref.byteOffset) && ref.byteOffset >= 0 && ref.byteOffset <= ref.size;
}
export function hashJournalTailWindow(bytes: Uint8Array, byteOffset: number): string {
	const start = Math.max(0, byteOffset - RESUME_SNAPSHOT_TAIL_HASH_BYTES);
	return new Bun.CryptoHasher("sha256").update(bytes.subarray(start, byteOffset)).digest("hex");
}

export async function buildResumeSnapshotJournalRef(
	input: ResumeSnapshotJournalRefInput,
): Promise<ResumeSnapshotJournalRef> {
	const file = Bun.file(input.path);
	const size = file.size;
	const end = Math.min(input.byteOffset, size);
	const start = Math.max(0, end - RESUME_SNAPSHOT_TAIL_HASH_BYTES);
	const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
	let stat: { dev?: number; ino?: number; mtimeMs?: number } | undefined;
	try {
		const s = await fs.stat(input.path);
		stat = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs };
	} catch {}
	return {
		path: input.path,
		byteOffset: input.byteOffset,
		lastEntryId: input.lastEntryId,
		revision: input.revision,
		size: input.size,
		tailHash: hashJournalTailWindow(bytes, bytes.length),
		...stat,
	};
}

/**
 * Canonical JSON for a snapshot payload: object keys sorted, arrays in order, and every
 * leaf or non-plain shape delegated to `JSON.stringify` so its semantics survive verbatim —
 * `Date`/`toJSON` replacement, `undefined`/functions/symbols dropped from objects but
 * emitted as `null` inside arrays, numeric object keys as strings, and unserializable or
 * cyclic input throwing rather than inventing `null`.
 *
 * The reference implementation normalized the payload with `JSON.parse(JSON.stringify())`
 * and then rebuilt the whole text with a recursive map/join, holding two extra full-payload
 * copies. This walks the live graph once and streams the text into the hasher in bounded
 * chunks, so no full-payload copy is ever materialized.
 */
const CANONICAL_CHUNK_CHARS = 128 * 1024;
/**
 * Bounded text buffer in front of the hasher. Fragments are always whole JSON tokens —
 * a structural character or one `JSON.stringify` result — so a chunk boundary never lands
 * inside a surrogate pair, and the hasher sees exactly the bytes of the full canonical text.
 */
class CanonicalSink {
	readonly #hasher: Bun.CryptoHasher;
	#pending = "";
	constructor(hasher: Bun.CryptoHasher) {
		this.#hasher = hasher;
	}
	push(text: string): void {
		this.#pending += text;
		if (this.#pending.length >= CANONICAL_CHUNK_CHARS) this.drain();
	}
	drain(): void {
		if (this.#pending.length === 0) return;
		this.#hasher.update(this.#pending);
		this.#pending = "";
	}
}
/** True when `JSON.stringify` emits exactly this object's own enumerable keys and nothing else. */
function isPlainRecord(value: object): boolean {
	const proto: unknown = Object.getPrototypeOf(value);
	// `JSON.stringify` resolves `toJSON` through the prototype chain, so `in` matches it exactly.
	return (proto === Object.prototype || proto === null) && !("toJSON" in value);
}
/**
 * Stream `value` as canonical JSON. `prefix` is written only when the value has a JSON form,
 * mirroring `JSON.stringify` dropping the object keys whose value serializes to nothing.
 * Returns whether anything was written.
 */
function pushCanonical(value: unknown, sink: CanonicalSink, prefix: string, ancestors: Set<object>): boolean {
	if (value === null) {
		sink.push(prefix);
		sink.push("null");
		return true;
	}
	if (typeof value !== "object") {
		const text = JSON.stringify(value) as string | undefined;
		if (text === undefined) return false;
		sink.push(prefix);
		sink.push(text);
		return true;
	}
	if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
	if (Array.isArray(value)) {
		ancestors.add(value);
		sink.push(prefix);
		sink.push("[");
		for (let i = 0; i < value.length; i++) {
			if (i > 0) sink.push(",");
			if (!pushCanonical(value[i], sink, "", ancestors)) sink.push("null");
		}
		sink.push("]");
		ancestors.delete(value);
		return true;
	}
	if (isPlainRecord(value)) {
		ancestors.add(value);
		// `isPlainRecord` established this is an own-key record, so the index read is exact.
		const record = value as Record<string, unknown>;
		const keys: string[] = Object.keys(value);
		keys.sort();
		sink.push(prefix);
		sink.push("{");
		let first = true;
		for (const key of keys) {
			const child = record[key];
			if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
			if (pushCanonical(child, sink, `${first ? "" : ","}${JSON.stringify(key)}:`, ancestors)) first = false;
		}
		sink.push("}");
		ancestors.delete(value);
		return true;
	}
	// `Date`, `Map`/`Set`, boxed primitives, class instances, and custom `toJSON` shapes: let
	// `JSON.stringify` own the node, then re-walk its *result* so nested plain records inside a
	// replaced subtree still come out sorted. Only this node's own JSON text is materialized —
	// never the payload — so the walk stays bounded while the digest stays canonical.
	const replaced = JSON.stringify(value) as string | undefined;
	// A `toJSON` that yields nothing makes `JSON.stringify` drop the key (or emit `null` in an array).
	if (replaced === undefined) return false;
	return pushCanonical(JSON.parse(replaced) as unknown, sink, prefix, ancestors);
}
function hashCanonicalJson(value: unknown, hasher: Bun.CryptoHasher): void {
	const sink = new CanonicalSink(hasher);
	try {
		pushCanonical(value, sink, "", new Set<object>());
		sink.drain();
	} catch (error) {
		throw new Error(`Resume snapshot content is not JSON serializable: ${String(error)}`);
	}
}
export function resumeSnapshotChecksum(snapshot: Omit<ResumeSnapshot, "checksum"> & { checksum?: string }): string {
	const { checksum: _checksum, ...content } = snapshot;
	const hasher = new Bun.CryptoHasher("sha256");
	hashCanonicalJson(content, hasher);
	return `${CHECKSUM_PREFIX}${hasher.digest("hex")}`;
}
export function sealResumeSnapshot(snapshot: Omit<ResumeSnapshot, "checksum"> & { checksum?: string }): ResumeSnapshot {
	const sealed = { ...snapshot, schemaVersion: 2 as const, checksum: "" } as ResumeSnapshot;
	sealed.checksum = resumeSnapshotChecksum(sealed);
	return sealed;
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function isResumeSnapshotJournalRef(v: unknown): v is ResumeSnapshotJournalRef {
	return (
		obj(v) &&
		typeof v.path === "string" &&
		safeInt(v.byteOffset) &&
		(v.lastEntryId === null || typeof v.lastEntryId === "string") &&
		safeInt(v.revision) &&
		safeInt(v.size) &&
		typeof v.tailHash === "string" &&
		(v.dev === undefined || safeInt(v.dev)) &&
		(v.ino === undefined || safeInt(v.ino)) &&
		(v.mtimeMs === undefined || typeof v.mtimeMs === "number")
	);
}
export function validateResumeSnapshotBranch(v: unknown): ResumeSnapshotBranchIndex | null {
	if (
		!obj(v) ||
		!(v.leafId === null || typeof v.leafId === "string") ||
		!(v.rootId === null || typeof v.rootId === "string") ||
		!Array.isArray(v.activeEntryRefs) ||
		!v.activeEntryRefs.every(x => typeof x === "string") ||
		!obj(v.parentIndex)
	)
		return null;
	const refs = [...v.activeEntryRefs] as string[];
	const pi: Record<string, string | null> = {};
	for (const [k, p] of Object.entries(v.parentIndex)) {
		if (!(p === null || typeof p === "string")) return null;
		pi[k] = p;
	}
	if (refs.length === 0)
		return v.leafId === null && v.rootId === null
			? { leafId: null, rootId: null, activeEntryRefs: refs, parentIndex: pi }
			: null;
	if (v.leafId !== refs.at(-1) || v.rootId !== refs[0] || pi[refs[0]] !== null) return null;
	for (let i = 1; i < refs.length; i++) if (pi[refs[i]] !== refs[i - 1]) return null;
	if (new Set(refs).size !== refs.length) return null;
	return { leafId: v.leafId as string, rootId: v.rootId as string, activeEntryRefs: refs, parentIndex: pi };
}
export function validateResumeSnapshotRuntime(v: unknown): ResumeSnapshotRuntime | null {
	if (
		!obj(v) ||
		!obj(v.header) ||
		v.header.type !== "session" ||
		typeof v.header.id !== "string" ||
		typeof v.header.timestamp !== "string" ||
		typeof v.header.cwd !== "string" ||
		!Array.isArray(v.activeEntries) ||
		!obj(v.usage)
	)
		return null;
	const entries = v.activeEntries;
	const ids = new Set<string>();
	for (const e of entries) {
		if (
			!obj(e) ||
			typeof e.id !== "string" ||
			ids.has(e.id) ||
			!(e.parentId === null || typeof e.parentId === "string") ||
			typeof e.timestamp !== "string" ||
			typeof e.type !== "string"
		)
			return null;
		ids.add(e.id);
	}
	const usage = v.usage as Record<string, unknown>;
	const keys = [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"orchestrationInput",
		"orchestrationOutput",
		"orchestrationCacheRead",
		"premiumRequests",
		"cost",
	];
	if (keys.some(k => typeof usage[k] !== "number" || !Number.isFinite(usage[k]) || usage[k] < 0)) return null;
	return {
		header: { ...v.header, type: "session", id: v.header.id, timestamp: v.header.timestamp, cwd: v.header.cwd },
		activeEntries: entries.map(e => ({ ...e })) as SessionEntry[],
		usage: { ...usage } as unknown as UsageStatistics,
	};
}
/**
 * Bind a runtime payload to the branch index: the payload must be a non-empty ordered
 * subset of the full root→leaf chain and every entry must keep its original journal
 * parent. The chain root is metadata — `rootId`/`activeEntryRefs`/`parentIndex` stay
 * mandatory — but its payload entry need not survive, because compaction archives the
 * root's message. Only the retained leaf must still be present. Compacted gaps are
 * expected; reparented or reordered entries are not.
 */
function validateResumeSnapshotProjection(branch: ResumeSnapshotBranchIndex, runtime: ResumeSnapshotRuntime): boolean {
	const refs = branch.activeEntryRefs,
		entries = runtime.activeEntries,
		parentIndex = branch.parentIndex;
	const positions = new Map<string, number>();
	for (let i = 0; i < refs.length; i++) positions.set(refs[i]!, i);
	if (refs.length > 0 && entries.length === 0) return false;
	let previous = -1;
	for (const entry of entries) {
		const position = positions.get(entry.id);
		if (position === undefined || position <= previous) return false;
		const parent = entry.parentId;
		if (parent !== null && !Object.hasOwn(parentIndex, parent)) return false;
		if (parentIndex[entry.id] !== parent) return false;
		previous = position;
	}
	if (refs.length > 0 && entries[entries.length - 1]!.id !== refs[refs.length - 1]!) return false;
	return true;
}
export function validateResumeSnapshot(v: unknown): ResumeSnapshot | null {
	if (
		!obj(v) ||
		v.schemaVersion !== 2 ||
		typeof v.sessionId !== "string" ||
		!v.sessionId ||
		typeof v.createdAt !== "string" ||
		!isResumeSnapshotJournalRef(v.journal)
	)
		return null;
	const branch = validateResumeSnapshotBranch(v.branch),
		runtime = validateResumeSnapshotRuntime(v.runtime);
	if (!branch || !runtime || typeof v.checksum !== "string" || !v.checksum.startsWith(CHECKSUM_PREFIX)) return null;
	const snapshot: ResumeSnapshot = {
		...v,
		schemaVersion: 2,
		sessionId: v.sessionId,
		createdAt: v.createdAt,
		journal: { ...v.journal },
		branch,
		runtime,
		checksum: v.checksum,
	};
	if (
		v.checksum !== resumeSnapshotChecksum(snapshot) ||
		runtime.header.id !== v.sessionId ||
		!validateResumeSnapshotProjection(branch, runtime)
	)
		return null;
	return snapshot;
}

export async function parseResumeSnapshotBytes(
	bytes: Uint8Array,
	sessionFile: string,
	expectSessionId?: string,
): Promise<ResumeSnapshot | null> {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) return null;
	const text = new TextDecoder().decode(bytes);
	if (!isCompleteResumeSnapshotBody(text)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const s = validateResumeSnapshot(parsed);
	if (
		!s ||
		(expectSessionId !== undefined && s.sessionId !== expectSessionId) ||
		s.journal.path !== path.resolve(sessionFile) ||
		!isSettledResumeSnapshotJournalRef(s.journal)
	)
		return null;
	return (await validateResumeSnapshotJournal(s, sessionFile)) ? s : null;
}

/**
 * The sidecar is exactly one compact JSON document plus a trailing newline (see
 * persistResumeSnapshot). Anything after the closing brace — padding, a second document,
 * a file that grew past the bound — means the bytes are not the cache we wrote.
 */
function isCompleteResumeSnapshotBody(text: string): boolean {
	let depth = 0,
		inString = false,
		escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			depth++;
			continue;
		}
		if (ch === "}" || ch === "]") {
			if (depth === 0) return false;
			depth--;
			if (depth === 0) {
				const rest = text.slice(i + 1);
				return rest === "" || rest === "\n";
			}
		}
	}
	return false;
}
/**
 * Confirm the sidecar still describes this journal. Only a bounded header window, the
 * tail hash window, and one sentinel byte are read; the journal body is never scanned.
 */
async function validateResumeSnapshotJournal(s: ResumeSnapshot, file: string): Promise<boolean> {
	try {
		const st = await fs.stat(file);
		const j = s.journal;
		if (st.size < j.byteOffset) return false;
		if (j.dev !== undefined && st.dev !== j.dev) return false;
		if (j.ino !== undefined && st.ino !== j.ino) return false;
		if (j.mtimeMs !== undefined && st.mtimeMs !== j.mtimeMs && st.size === j.size) return false;
		const headBytes = Math.min(st.size, SESSION_HEADER_PREFIX_BYTES);
		const head = new Uint8Array(await Bun.file(file).slice(0, headBytes).arrayBuffer());
		if (!journalHeaderMatchesSession(new TextDecoder().decode(head), s.sessionId)) return false;
		const start = Math.max(0, j.byteOffset - RESUME_SNAPSHOT_TAIL_HASH_BYTES);
		const w = new Uint8Array(await Bun.file(file).slice(start, j.byteOffset).arrayBuffer());
		if (hashJournalTailWindow(w, w.length) !== j.tailHash) return false;
		if (j.byteOffset < st.size) {
			const b = new Uint8Array(
				await Bun.file(file)
					.slice(j.byteOffset, j.byteOffset + 1)
					.arrayBuffer(),
			);
			if (b[0] !== 0x7b) return false;
		}
		return true;
	} catch {
		return false;
	}
}
/** Find the session header inside a bounded prefix, skipping the fixed-width title slot via the real parser. */
function journalHeaderMatchesSession(prefix: string, sessionId: string): boolean {
	for (const line of prefix.split("\n")) {
		const candidate = line.trim();
		if (!candidate) continue;
		let value: unknown;
		try {
			value = JSON.parse(candidate);
		} catch {
			return false;
		}
		if (parseTitleSlotLine(candidate)) continue;
		if (obj(value) && value.type === "session") return value.id === sessionId;
	}
	return false;
}
export async function loadResumeSnapshot(
	sessionFile: string,
	expectSessionId?: string,
): Promise<ResumeSnapshot | null> {
	try {
		const file = Bun.file(resumeSnapshotPath(sessionFile));
		// Never allocate for an oversized cache, and cap the slice so a file growing between
		// the stat and the read cannot stream more than the bound into memory.
		if (file.size === 0 || file.size > MAX_SNAPSHOT_BYTES) return null;
		const bytes = new Uint8Array(await file.slice(0, MAX_SNAPSHOT_BYTES + 1).arrayBuffer());
		if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return null;
		return parseResumeSnapshotBytes(bytes, sessionFile, expectSessionId);
	} catch {
		return null;
	}
}
export async function persistResumeSnapshot(
	sessionFile: string,
	snapshot: ResumeSnapshot,
	options?: { commitGuard?: () => boolean },
): Promise<void> {
	const target = resumeSnapshotPath(sessionFile),
		temp = resumeSnapshotTempPath(target),
		sealed = { ...snapshot, checksum: resumeSnapshotChecksum(snapshot) };
	let committed = false;
	try {
		// Bun.write ignores `mode`, so create the temp with an explicit owner-only write.
		await fs.writeFile(temp, `${JSON.stringify(sealed)}\n`, { encoding: "utf8", mode: SIDECAR_MODE });
		if ((await fs.stat(temp)).size > MAX_SNAPSHOT_BYTES) throw new Error("resume snapshot exceeds the size cap");
		const p = validateResumeSnapshot(JSON.parse(await fs.readFile(temp, "utf8")));
		if (!p) throw new Error("invalid resume snapshot");
		if (options?.commitGuard && !options.commitGuard()) throw new Error("stale resume snapshot");
		await fs.rename(temp, target);
		committed = true;
	} finally {
		// A guard failure must leave the previously published cache untouched, so only our
		// own temp file is ever removed here.
		if (!committed) await fs.rm(temp, { force: true }).catch(() => undefined);
	}
}
