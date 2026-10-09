import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildResumeSnapshotJournalRef,
	loadResumeSnapshot,
	parseResumeSnapshotBytes,
	persistResumeSnapshot,
	type ResumeSnapshot,
	type ResumeSnapshotBranchIndex,
	resumeSnapshotChecksum,
	resumeSnapshotPath,
	sealResumeSnapshot,
	validateResumeSnapshot,
	validateResumeSnapshotBranch,
} from "./resume-snapshot";
import type { SessionEntry } from "./session-entries";

const header = {
	type: "session" as const,
	version: 3,
	id: "sess-1",
	timestamp: "2026-09-14T00:00:00.000Z",
	cwd: "/tmp",
};
const entries = [
	{
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-09-14T00:00:01.000Z",
		message: { role: "user", content: "hello", timestamp: 1 },
	},
	{
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "2026-09-14T00:00:02.000Z",
		message: { role: "assistant", content: "world", timestamp: 2 },
	},
] as unknown as SessionEntry[];
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

async function writeJournal(
	dir: string,
	sessionHeader: object,
	body: readonly object[],
): Promise<{ journalPath: string; byteLength: number }> {
	const journalPath = path.join(dir, "session.jsonl");
	const lines = `${[sessionHeader, ...body].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await fs.writeFile(journalPath, lines);
	return { journalPath, byteLength: Buffer.byteLength(lines) };
}

async function fixture(options?: {
	branch?: ResumeSnapshotBranchIndex;
}): Promise<{ dir: string; journalPath: string; snapshot: ResumeSnapshot }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-v2-"));
	const { journalPath, byteLength } = await writeJournal(dir, header, entries);
	const journal = await buildResumeSnapshotJournalRef({
		path: journalPath,
		byteOffset: byteLength,
		lastEntryId: "e2",
		revision: 1,
		size: byteLength,
	});
	const snapshot = sealResumeSnapshot({
		schemaVersion: 2,
		sessionId: "sess-1",
		createdAt: new Date().toISOString(),
		journal,
		branch: options?.branch ?? {
			leafId: "e2",
			rootId: "e1",
			activeEntryRefs: ["e1", "e2"],
			parentIndex: { e1: null, e2: "e1" },
		},
		runtime: { header, activeEntries: entries, usage },
	});
	return { dir, journalPath, snapshot };
}

/**
 * The projection the session manager really publishes: `activeEntryRefs` is the full
 * root→leaf chain, `parentIndex` covers every journal entry, and `activeEntries` is an
 * ordered payload subset that drops compacted history while keeping original parentIds.
 * Compaction archives the chain root's first message, so the subset need not open at
 * `refs[0]` — the root survives only as branch metadata.
 */
const compactChain = [
	{
		type: "custom",
		id: "root",
		parentId: null,
		customType: "san.context_checkpoint",
		data: { note: "root" },
		timestamp: "2026-09-14T00:00:01.000Z",
	},
	{
		type: "message",
		id: "oldHuge",
		parentId: "root",
		timestamp: "2026-09-14T00:00:02.000Z",
		message: { role: "user", content: "huge", timestamp: 2 },
	},
	{
		type: "model_change",
		id: "model",
		parentId: "oldHuge",
		model: "anthropic/claude-sonnet-4-5",
		timestamp: "2026-09-14T00:00:03.000Z",
	},
	{
		type: "message",
		id: "kept",
		parentId: "model",
		timestamp: "2026-09-14T00:00:04.000Z",
		message: { role: "user", content: "kept", timestamp: 4 },
	},
	{
		type: "compaction",
		id: "compaction",
		parentId: "kept",
		summary: "summary",
		firstKeptEntryId: "kept",
		tokensBefore: 10,
		timestamp: "2026-09-14T00:00:05.000Z",
	},
	{
		type: "message",
		id: "tail",
		parentId: "compaction",
		timestamp: "2026-09-14T00:00:06.000Z",
		message: { role: "assistant", content: "tail", timestamp: 6 },
	},
] as unknown as SessionEntry[];
/** Off-chain side branch: it lives in the journal (so `parentIndex` carries it) but never on the chain. */
const sibling = {
	type: "message",
	id: "sibling",
	parentId: "kept",
	timestamp: "2026-09-14T00:00:07.000Z",
	message: { role: "user", content: "side", timestamp: 7 },
} as unknown as SessionEntry;
const compactRefs = compactChain.map(entry => entry.id);
const compactPayloadIds = ["root", "model", "kept", "compaction", "tail"];
const compactParentIndex: Record<string, string | null> = {
	root: null,
	oldHuge: "root",
	model: "oldHuge",
	kept: "model",
	compaction: "kept",
	tail: "compaction",
	sibling: "kept",
};
const compactBranch = (refs: readonly string[]): ResumeSnapshotBranchIndex => ({
	leafId: refs[refs.length - 1] ?? null,
	rootId: refs[0] ?? null,
	activeEntryRefs: refs,
	parentIndex: compactParentIndex,
});

async function compactFixture(options?: {
	refs?: readonly string[];
	payloadIds?: readonly string[];
	reparent?: Record<string, string | null>;
}): Promise<{
	dir: string;
	journalPath: string;
	snapshot: ResumeSnapshot;
	detached: ResumeSnapshot;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-compact-"));
	const { journalPath, byteLength } = await writeJournal(dir, header, [...compactChain, sibling]);
	const journal = await buildResumeSnapshotJournalRef({
		path: journalPath,
		byteOffset: byteLength,
		lastEntryId: "tail",
		revision: 1,
		size: byteLength,
	});
	const byId = new Map(compactChain.map(entry => [entry.id, entry]));
	const payloadIds = options?.payloadIds ?? compactPayloadIds;
	const activeEntries = payloadIds.map(id => ({
		...byId.get(id)!,
		...(options?.reparent?.[id] !== undefined ? { parentId: options?.reparent?.[id] } : {}),
	})) as SessionEntry[];
	const snapshot = sealResumeSnapshot({
		schemaVersion: 2,
		sessionId: "sess-1",
		createdAt: new Date().toISOString(),
		journal,
		branch: compactBranch(options?.refs ?? compactRefs),
		runtime: { header, activeEntries, usage },
	});
	const detached = sealResumeSnapshot({
		...snapshot,
		sessionId: "sess-detached",
		runtime: { header: { ...header, id: "sess-detached" }, activeEntries, usage },
	});
	return { dir, journalPath, snapshot, detached };
}

/**
 * Independent oracle for the canonical text: the documented `JSON.parse(JSON.stringify())`
 * normalization (applied last so primitive and array-value semantics match `JSON.stringify`)
 * followed by an explicit recursive key sort. It never touches the implementation, so it
 * pins the digest to real JSON semantics rather than to whatever ordering the walk emits.
 */
function canonicalChecksum(snapshot: unknown): string {
	const { checksum: _checksum, ...content } = snapshot as Record<string, unknown>;
	const canonical = JSON.stringify(sortKeys(JSON.parse(JSON.stringify(content)) as unknown));
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
}
function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
	return sorted;
}

describe("resume snapshot v2", () => {
	it("round trips concrete runtime", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const loaded = await loadResumeSnapshot(f.journalPath, "sess-1");
		expect(loaded?.runtime.activeEntries).toHaveLength(2);
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("accepts a compact projection that omits a compacted chain entry but keeps true parentIds", async () => {
		const f = await compactFixture();
		expect(validateResumeSnapshot(f.snapshot)).not.toBeNull();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const loaded = await loadResumeSnapshot(f.journalPath, "sess-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.branch.activeEntryRefs).toEqual(compactRefs);
		expect(loaded?.runtime.activeEntries.map(entry => entry.id)).toEqual(compactPayloadIds);
		// The payload keeps the journal parent, not a reparented neighbour.
		expect(loaded?.runtime.activeEntries.find(entry => entry.id === "model")?.parentId).toBe("oldHuge");
		expect(loaded?.runtime.activeEntries.find(entry => entry.id === "kept")?.parentId).toBe("model");
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects refs shrunk to the payload array", async () => {
		const f = await compactFixture({ refs: compactPayloadIds });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await expect(persistResumeSnapshot(f.journalPath, f.snapshot)).rejects.toThrow();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a payload that drops the retained leaf", async () => {
		const f = await compactFixture({ payloadIds: ["root", "model", "kept", "compaction"] });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("accepts omitting the archived chain root from the payload while keeping its metadata", async () => {
		const f = await compactFixture({ payloadIds: ["model", "kept", "compaction", "tail"] });
		expect(validateResumeSnapshot(f.snapshot)).not.toBeNull();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const loaded = await loadResumeSnapshot(f.journalPath, "sess-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.branch.rootId).toBe("root");
		expect(loaded?.branch.activeEntryRefs).toEqual(compactRefs);
		expect(loaded?.branch.parentIndex).toEqual(compactParentIndex);
		expect(loaded?.runtime.activeEntries.map(entry => entry.id)).toEqual(["model", "kept", "compaction", "tail"]);
		// The first surviving entry keeps its real journal parent, which is the omitted root's child.
		expect(loaded?.runtime.activeEntries[0]?.parentId).toBe("oldHuge");
		expect(loaded?.runtime.header.id).toBe("sess-1");
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a payload for a non-empty chain that retains no entries at all", async () => {
		const f = await compactFixture({ refs: ["root"], payloadIds: [] });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a chain whose root metadata is missing", async () => {
		const f = await compactFixture();
		const refs = compactRefs.slice(1);
		const missingRoot = sealResumeSnapshot({
			...f.snapshot,
			branch: {
				leafId: refs[refs.length - 1] ?? null,
				rootId: null,
				activeEntryRefs: refs,
				parentIndex: compactParentIndex,
			},
		});
		expect(validateResumeSnapshotBranch(missingRoot.branch)).toBeNull();
		expect(validateResumeSnapshot(missingRoot)).toBeNull();
		await expect(persistResumeSnapshot(f.journalPath, missingRoot)).rejects.toThrow();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a root-less chain that also reparents the surviving head", async () => {
		const f = await compactFixture();
		const refs = compactRefs.slice(1);
		const detachedRoot = sealResumeSnapshot({
			...f.snapshot,
			branch: {
				leafId: refs[refs.length - 1] ?? null,
				rootId: refs[0] ?? null,
				activeEntryRefs: refs,
				parentIndex: { ...compactParentIndex, oldHuge: null },
			},
		});
		expect(validateResumeSnapshot(detachedRoot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a reparented payload entry", async () => {
		const f = await compactFixture({ reparent: { model: "root" } });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("accepts a payload that skips several chain entries in ascending order", async () => {
		const f = await compactFixture({ payloadIds: ["root", "kept", "tail"] });
		expect(validateResumeSnapshot(f.snapshot)).not.toBeNull();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const loaded = await loadResumeSnapshot(f.journalPath, "sess-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.branch.activeEntryRefs).toEqual(compactRefs);
		expect(loaded?.runtime.activeEntries.map(entry => entry.id)).toEqual(["root", "kept", "tail"]);
		expect(loaded?.runtime.header.id).toBe("sess-1");
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a payload that reverses the chain order", async () => {
		const f = await compactFixture({ payloadIds: ["tail", "kept", "root"] });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a payload entry whose parent is outside the journal", async () => {
		const f = await compactFixture({ reparent: { kept: "ghost" } });
		expect(validateResumeSnapshot(f.snapshot)).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});
	it("rejects a journal whose header belongs to another session", async () => {
		const f = await compactFixture();
		const body = new TextEncoder().encode(JSON.stringify(f.detached));
		expect(validateResumeSnapshot(f.detached)).not.toBeNull();
		expect(await parseResumeSnapshotBytes(body, f.journalPath)).toBeNull();
		expect(
			await parseResumeSnapshotBytes(new TextEncoder().encode(JSON.stringify(f.snapshot)), f.journalPath),
		).not.toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a malformed branch index", async () => {
		const f = await compactFixture();
		const cyclic = sealResumeSnapshot({
			...f.snapshot,
			branch: { ...f.snapshot.branch, parentIndex: { ...compactParentIndex, oldHuge: "tail" } },
		});
		expect(validateResumeSnapshot(cyclic)).toBeNull();
		expect(
			validateResumeSnapshotBranch({ ...f.snapshot.branch, parentIndex: { ...compactParentIndex, sibling: 7 } }),
		).toBeNull();
		expect(validateResumeSnapshotBranch(f.snapshot.branch)).not.toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("canonicalizes undefined with the native JSON semantics the published sidecar uses", async () => {
		const f = await fixture();
		const a = {
			...f.snapshot,
			runtime: { ...f.snapshot.runtime, activeEntries: [...entries, undefined as unknown as SessionEntry] },
		};
		const b = {
			...f.snapshot,
			runtime: { ...f.snapshot.runtime, activeEntries: [...entries, null as unknown as SessionEntry] },
		};
		expect(resumeSnapshotChecksum(a as ResumeSnapshot)).toBe(resumeSnapshotChecksum(b as ResumeSnapshot));
		const zeroed = {
			...f.snapshot,
			runtime: { ...f.snapshot.runtime, activeEntries: [undefined as unknown as SessionEntry] },
		};
		const nullHead = {
			...f.snapshot,
			runtime: { ...f.snapshot.runtime, activeEntries: [null as unknown as SessionEntry] },
		};
		expect(resumeSnapshotChecksum(zeroed as ResumeSnapshot)).toBe(resumeSnapshotChecksum(nullHead as ResumeSnapshot));
		const droppedKey = {
			...f.snapshot,
			runtime: { ...f.snapshot.runtime, activeEntries: entries, ghost: undefined },
		};
		const ghostless = { ...f.snapshot, runtime: { ...f.snapshot.runtime, activeEntries: entries } };
		expect(resumeSnapshotChecksum(droppedKey as ResumeSnapshot)).toBe(
			resumeSnapshotChecksum(ghostless as ResumeSnapshot),
		);
		// The digest is the hash of the sorted-key canonical text, so it stays tied to real
		// JSON semantics rather than to this walk's key construction order.
		expect(resumeSnapshotChecksum(a as ResumeSnapshot)).toBe(canonicalChecksum(a));
		expect(resumeSnapshotChecksum(zeroed as ResumeSnapshot)).toBe(canonicalChecksum(zeroed));
		expect(
			resumeSnapshotChecksum({
				journal: f.snapshot.journal,
				branch: f.snapshot.branch,
				runtime: f.snapshot.runtime,
				createdAt: f.snapshot.createdAt,
				sessionId: f.snapshot.sessionId,
				schemaVersion: 2,
			}),
		).toBe(resumeSnapshotChecksum({ ...f.snapshot }));
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("hashes a sorted-key canonical text for a nested payload", () => {
		const payload = {
			checksum: "ignored",
			schemaVersion: 2,
			sessionId: "sess-1",
			branch: { parentIndex: { e2: "e1", e1: null }, activeEntryRefs: ["e1", "e2"] },
			runtime: {
				usage: { totalTokens: 3, input: 1, output: 2 },
				activeEntries: [
					{ id: "e1", text: "héllo — 世界 🎉", dropped: undefined },
					{ id: "e2", n: [1, 2, 3] },
				],
			},
		};
		// Frozen digest: a deliberate change to the canonical form fails here with a diff.
		expect(resumeSnapshotChecksum(payload as unknown as ResumeSnapshot)).toBe(
			"sha256:d5f3c9b5356fb25faaed7cf9b9f634a9281526e52f132230ff93cdabe11020cc",
		);
		expect(resumeSnapshotChecksum(payload as unknown as ResumeSnapshot)).toBe(canonicalChecksum(payload));
	});

	it("is stable across payloads larger than one canonical chunk", () => {
		// The bounded chunk buffer must not change the digest: it exists only to bound peak
		// memory, so the pending tail between two drains still has to reach the hasher.
		const rows = Array.from({ length: 60_000 }, (_, i) => `row-${i}-😀`);
		const payload = { checksum: "ignored", schemaVersion: 2, entries: rows, filler: "x".repeat(400_000) };
		expect(resumeSnapshotChecksum(payload as unknown as ResumeSnapshot)).toBe(
			"sha256:187936e94a1b5db7e846c2df5ab9273a97a98ba61cdbefb4cf3e07f7735b7ab4",
		);
		expect(resumeSnapshotChecksum(payload as unknown as ResumeSnapshot)).toBe(canonicalChecksum(payload));
	});

	it("does not confuse a plain object with a toJSON shape", () => {
		const base = {
			checksum: "ignored",
			schemaVersion: 2,
			entries: [{ id: "e1", nested: { deep: { value: 1, other: 2 } } }],
		};
		const disguised = {
			...base,
			entries: [{ id: "e1", nested: { deep: { value: 1, other: 2, toJSON: () => ({ replaced: true }) } } }],
		};
		expect(resumeSnapshotChecksum(base as unknown as ResumeSnapshot)).not.toBe(
			resumeSnapshotChecksum(disguised as unknown as ResumeSnapshot),
		);
	});

	it("sorts the keys a JSON replacement produces, not just the producer's order", () => {
		// `toJSON`, `Date`, and class instances are stringified *before* the reference key sort,
		// so the text a replacement yields is itself normalized. A walk that only re-sorts plain
		// own-key records would hash whatever order the replacement happened to build.
		const shape = (replacement: object) =>
			({
				checksum: "ignored",
				schemaVersion: 2,
				runtime: { activeEntries: [{ id: "e1", stamped: { toJSON: () => replacement } }] },
			}) as unknown as ResumeSnapshot;
		const payload = shape({ z: 1, a: 2, nested: { q: 3, b: 4 } });
		expect(resumeSnapshotChecksum(payload)).toBe(canonicalChecksum(payload));
		expect(resumeSnapshotChecksum(shape({ nested: { b: 4, q: 3 }, a: 2, z: 1 }))).toBe(
			resumeSnapshotChecksum(payload),
		);
	});

	it("fails loudly on a payload that cannot be serialized", async () => {
		const f = await fixture();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const poisoned = {
			...f.snapshot,
			branch: { ...f.snapshot.branch, parentIndex: cyclic },
		} as unknown as ResumeSnapshot;
		expect(() => resumeSnapshotChecksum(poisoned)).toThrow(/serializable/);
		await expect(persistResumeSnapshot(f.journalPath, poisoned)).rejects.toThrow(/serializable/);
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects stale commit preserving cache", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const before = await fs.readFile(resumeSnapshotPath(f.journalPath), "utf8");
		await expect(persistResumeSnapshot(f.journalPath, f.snapshot, { commitGuard: () => false })).rejects.toThrow();
		expect(await fs.readFile(resumeSnapshotPath(f.journalPath), "utf8")).toBe(before);
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("publishes the sidecar owner-only and leaves no temp file", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const sidecar = resumeSnapshotPath(f.journalPath);
		expect((await fs.stat(sidecar)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(f.dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects an oversized sidecar before reading it", async () => {
		const f = await fixture();
		const sidecar = resumeSnapshotPath(f.journalPath);
		await fs.writeFile(sidecar, "");
		await fs.truncate(sidecar, 16 * 1024 * 1024 + 1);
		expect(await loadResumeSnapshot(f.journalPath, "sess-1")).toBeNull();
		await fs.writeFile(sidecar, `${JSON.stringify(f.snapshot)}\n`);
		expect(await loadResumeSnapshot(f.journalPath, "sess-1")).not.toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("loads a sidecar that grew past the bound instead of parsing past it", async () => {
		const f = await fixture();
		const sidecar = resumeSnapshotPath(f.journalPath);
		const body = Buffer.from(`${JSON.stringify(f.snapshot)}\n`, "utf8");
		await fs.writeFile(sidecar, Buffer.concat([body, Buffer.alloc(16 * 1024 * 1024 - body.length, 0x20)]));
		expect(await loadResumeSnapshot(f.journalPath, "sess-1")).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("publishes a compact sidecar instead of an indented one", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const published = await fs.readFile(resumeSnapshotPath(f.journalPath), "utf8");
		expect(published).toBe(`${JSON.stringify({ ...f.snapshot, checksum: resumeSnapshotChecksum(f.snapshot) })}\n`);
		expect(published.endsWith("\n")).toBe(true);
		expect(published.includes("\n\t")).toBe(false);
		const padding = "x".repeat(4096);
		const artifacts = { one: padding, two: padding, three: padding };
		expect(Buffer.byteLength(JSON.stringify(artifacts))).toBeLessThan(
			Buffer.byteLength(JSON.stringify(artifacts, null, "\t")),
		);
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("accepts appended journal", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		await fs.appendFile(f.journalPath, "{}\n");
		expect(await loadResumeSnapshot(f.journalPath, "sess-1")).not.toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects a rewritten journal header of the same size", async () => {
		const f = await fixture();
		await persistResumeSnapshot(f.journalPath, f.snapshot);
		const rewritten = `${JSON.stringify({ ...header, id: "sess-2" })}\n${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await fs.writeFile(f.journalPath, rewritten);
		expect(await loadResumeSnapshot(f.journalPath, "sess-1")).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});

	it("rejects malformed branch", () => {
		expect(
			validateResumeSnapshotBranch({
				leafId: "e9",
				rootId: "e1",
				activeEntryRefs: ["e1", "e2"],
				parentIndex: { e1: null, e2: "e1" },
			}),
		).toBeNull();
	});

	it("rejects prior schema", async () => {
		const f = await fixture();
		const old = { ...f.snapshot, schemaVersion: 1 };
		expect(
			await parseResumeSnapshotBytes(new TextEncoder().encode(JSON.stringify(old)), f.journalPath, "sess-1"),
		).toBeNull();
		await fs.rm(f.dir, { recursive: true, force: true });
	});
});
