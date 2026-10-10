/**
 * Contract: the seen-line guard authorizes exactly the source lines the model
 * actually received — after the central artifact spill has shortened the
 * producer's formatted result.
 *
 * A producer formats its body (read → hashline text) *before*
 * `spillLargeResultToArtifact` may truncate it, so provenance must be resolved
 * against the delivered text, not the formatted intermediate. These tests drive
 * the real ReadTool through the wrapped path, shorten the result with real
 * per-result preview settings, and then drive real hashline validation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@san/coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@san/coding-agent/edit";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@san/coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@san/coding-agent/tools";
import { wrapToolWithMetaNotice } from "@san/coding-agent/tools/output-meta";
import { ReadTool } from "@san/coding-agent/tools/read";
import { removeWithRetries } from "@san/utils";

function executeOptions(session: ToolSession): Omit<ExecuteHashlineSingleOptions, "input"> {
	return {
		session,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HEADER = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;

function tagFromOutput(text: string): string {
	const match = HEADER.exec(text);
	if (!match) throw new Error(`no hashline header in read output:\n${text}`);
	return match[2];
}

function createSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated({ "edit.enforceSeenLines": true, ...overrides }),
		enableLsp: false,
	} as unknown as ToolSession;
}

describe("final-output snapshot provenance", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "final-output-provenance-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("rejects a hunk on a line the column cap delivered only as a prefix", async () => {
		// The target line dwarfs the per-line column cap, so its numbered row
		// arrives as a prefix plus `…` while every neighbor that fits the cap is
		// delivered in full. A prefix is not the line: the row proves the source
		// line exists, never what it says, so no hunk may anchor on it.
		const huge = "y".repeat(800);
		const content = Array.from({ length: 40 }, (_, i) => (i === 39 ? huge : `line ${i + 1}`)).join("\n");
		const file = path.join(tmpDir, "wide.txt");
		await Bun.write(file, content);

		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const key = canonicalSnapshotKey(file);
		const tag = store.record(key, content);

		const read = await wrapToolWithMetaNotice(new ReadTool(session)).execute("r1", { path: `${file}:40-40` });
		const delivered = resultText(read);
		expect(delivered).not.toContain(huge);
		expect(tagFromOutput(delivered)).toBe(tag);
		expect(delivered).toContain(`39:line 39`);
		expect(delivered.split("\n").find(row => row.startsWith("40:"))).toEndWith("…");
		expect(store.byHash(key, tag)?.seenLines?.has(40) ?? false).toBe(false);

		await expect(
			executeHashlineSingle({ ...executeOptions(session), input: `[wide.txt#${tag}]\nSWAP 40.=40:\n+EDITED` }),
		).rejects.toThrow(/never displayed/);
		expect(await Bun.file(file).text()).toBe(content);
	});

	it("keeps a hunk on a fully delivered line authorized after a same-content re-record", async () => {
		const content = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const file = path.join(tmpDir, "small.txt");
		await Bun.write(file, content);

		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const key = canonicalSnapshotKey(file);
		const tag = store.record(key, content, [4]);

		const read = await wrapToolWithMetaNotice(new ReadTool(session)).execute("r1", { path: `${file}:4-4` });
		expect(tagFromOutput(resultText(read))).toBe(tag);

		const seen = store.byHash(key, tag)?.seenLines;
		expect(seen?.has(4)).toBe(true);
		// Only the delivered rows are seen: the bounded context `:4-4` shows is
		// authorized too, but line 8 — past the delivered window — is not.
		expect(seen?.has(8) ?? false).toBe(false);

		await executeHashlineSingle({ ...executeOptions(session), input: `[small.txt#${tag}]\nSWAP 4.=4:\n+EDITED` });
		expect(await Bun.file(file).text()).toContain("line 3\nEDITED\n");
	});

	it("drops lines from an earlier read when a later read of the same file is shortened", async () => {
		const huge = "z".repeat(3000);
		const lines = Array.from({ length: 30 }, (_, i) => (i === 2 ? "SHORT LINE" : `${huge} ${i + 1}`));
		const content = lines.join("\n");
		const file = path.join(tmpDir, "mixed.txt");
		await Bun.write(file, content);

		const session = createSession(tmpDir, {
			"tools.artifactSpillThreshold": 1,
			"tools.outputPreviewTokens": 800,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 2,
		});
		const store = getFileSnapshotStore(session);
		const key = canonicalSnapshotKey(file);
		const tag = store.record(key, content, [3]);

		// First read fully delivers the short line 3.
		const first = await wrapToolWithMetaNotice(new ReadTool(session)).execute("r1", { path: `${file}:3-3` });
		expect(resultText(first)).toContain("SHORT LINE");
		expect(store.byHash(key, tag)?.seenLines?.has(3)).toBe(true);

		// Second read's truncated result must not silently keep line 3 seen,
		// but it also must not erase the line the first read really delivered.
		const second = await wrapToolWithMetaNotice(new ReadTool(session)).execute("r2", { path: `${file}:20-20` });
		expect(resultText(second)).not.toContain(lines[19]);
		expect(store.byHash(key, tag)?.seenLines?.has(3)).toBe(true);
		expect(store.byHash(key, tag)?.seenLines?.has(20)).toBe(false);

		await executeHashlineSingle({
			...executeOptions(session),
			input: `[mixed.txt#${tag}]\nSWAP 3.=3:\n+EDITED SHORT`,
		});
		expect(await Bun.file(file).text()).toContain("EDITED SHORT");
	});

	it("does not authorize a source line merely because a tool printed a tag-like string", async () => {
		const content = `${Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const file = path.join(tmpDir, "spoof.txt");
		await Bun.write(file, content);

		const session = createSession(tmpDir);
		const store = getFileSnapshotStore(session);
		const key = canonicalSnapshotKey(file);
		const tag = store.record(key, content);

		// A read of an unrelated file whose *content* embeds this file's tag and
		// a numbered row: the printed text names this file, but the read never
		// touched it, so line 2 must stay unauthorized. The genuine read of this
		// file (line 6) must equally stay the only thing that authorized line 6.
		const other = path.join(tmpDir, "other.txt");
		await Bun.write(other, `[spoof.txt#${tag}]\n2:line 2\n`);
		await wrapToolWithMetaNotice(new ReadTool(session)).execute("r1", { path: `${file}:6-6` });
		await wrapToolWithMetaNotice(new ReadTool(session)).execute("r2", { path: other });
		expect(store.byHash(key, tag)?.seenLines?.has(2) ?? false).toBe(false);

		await expect(
			executeHashlineSingle({ ...executeOptions(session), input: `[spoof.txt#${tag}]\nSWAP 2.=2:\n+EDITED` }),
		).rejects.toThrow(/never displayed/);
		expect(await Bun.file(file).text()).toBe(content);
	});
});
