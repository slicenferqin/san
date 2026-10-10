import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentToolContext, countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@san/coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@san/coding-agent/tools";
import { stripOutputNotice, wrapToolWithMetaNotice } from "@san/coding-agent/tools/output-meta";
import { ReadTool } from "@san/coding-agent/tools/read";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: "a1",
			path: path.join(cwd, "session", `a1.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

function largeArtifactText(): string {
	return Array.from(
		{ length: 400 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(256)}`,
	).join("\n");
}

describe("read tool large artifact handling", () => {
	let testDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-large-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(path.join(artifactDir, "0.mcp.log"), largeArtifactText());
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("blocks unbounded raw reads and points to bounded artifact workflows", async () => {
		const result = await tool.execute("call-raw", { path: "artifact://0:raw" });
		const output = getTextOutput(result);

		expect(output).toContain("Unbounded raw read blocked for artifact://0");
		expect(output).toContain("artifact://0:raw:1-3000");
		expect(output).toContain(artifactDir);
		expect(output).not.toContain("line-001");
	});

	it("streams bounded artifact reads without materializing the whole artifact", async () => {
		const result = await tool.execute("call-range", { path: "artifact://0:1-3" });
		const output = getTextOutput(result);

		expect(output).toContain("line-001");
		expect(output).toContain("line-003");
		expect(output).toContain("Artifact storage:");
		expect(output).toContain("artifact://0:raw:N-M");
		expect(output).not.toContain("line-400");
	});

	it("keeps bounded raw artifact chunks verbatim (no workflow notice appended)", async () => {
		const result = await tool.execute("call-raw-range", { path: "artifact://0:raw:1-2" });
		const output = getTextOutput(result);

		expect(output).toStartWith("line-001");
		expect(output).toContain("line-002");
		expect(output).not.toContain("line-400");
		// Raw chunks must stay verbatim so copy/paste workflows do not eat the
		// workflow notice into the artifact bytes.
		expect(output).not.toContain("Artifact storage:");
		expect(output).not.toContain("artifact://0:raw:N-M");
	});

	it("returns exactly the requested raw artifact range without context padding", async () => {
		const result = await tool.execute("call-raw-exact", { path: "artifact://0:raw:31-31" });
		const output = getTextOutput(result);

		expect(output).toContain("line-031");
		expect(output).not.toContain("line-030");
		expect(output).not.toContain("line-032");
	});

	it("shortens artifact paths under the user's home dir instead of leaking the absolute path", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue(testDir);
		try {
			const result = await tool.execute("call-raw-home", { path: "artifact://0:raw" });
			const output = getTextOutput(result);
			// artifactDir sits under the (mocked) home, so shortenPath rewrites the
			// prefix to `~` — the notice must NOT leak the absolute artifact path.
			expect(output).toContain(`~${path.sep}session`);
			expect(output).not.toContain(artifactDir);
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("recovers the saved bytes exactly across 240 bounded continuation pages", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (text: string) => {
				saved.push(text);
				const id = String(saved.length + 99);
				await Bun.write(path.join(artifactDir, `${id}.read.log`), text);
				return id;
			},
		};
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.outputPreviewTokens": 12_000,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 50,
		});
		const context = {
			settings,
			sessionManager,
			executionScopeId: "artifact-recovery",
			model: { contextWindow: 100_000 },
		} as unknown as AgentToolContext;
		const wrapped = wrapToolWithMetaNotice(new ReadTool({ ...makeSession(testDir), settings }));
		// 2,400 sources of original text. The unwrapped read cannot return them in
		// one result (700 lines per call, 50 KB raw ceiling), so recovery has to go
		// through bounded pages of the stored artifact.
		const original = Array.from(
			{ length: 2_400 },
			(_, index) => `diagnostic-${index + 1}: original failure reason for step ${index + 1}`,
		).join("\n");
		await Bun.write(path.join(artifactDir, "97.mcp.log"), original);
		const full = await wrapped.execute("full", { path: "artifact://97:raw:1-2400" }, undefined, undefined, context);

		// The spill wrapper bounds the result and reuses the stored artifact it
		// came from instead of writing a second copy of the same bytes.
		expect(full.details?.meta?.truncation?.artifactId).toBe("97");
		expect(saved).toEqual([]);
		expect(getTextOutput(full)).toContain("artifact://97");
		expect(countTokens(stripOutputNotice(getTextOutput(full), full.details?.meta))).toBeLessThanOrEqual(12_000);

		const recovered: string[] = [];
		for (let page = 0; page < 240; page++) {
			const start = page * 10 + 1;
			const result = await wrapped.execute(
				`page-${page}`,
				{ path: `artifact://97:raw:${start}-${start + 9}` },
				undefined,
				undefined,
				context,
			);
			// A bounded page never claims an artifact of its own: recovery stays
			// anchored to the one stable reference, so no chain forms.
			expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
			const chunk = stripOutputNotice(getTextOutput(result), result.details?.meta);
			expect(chunk.length).toBeGreaterThan(0);
			recovered.push(chunk);
		}
		expect(recovered).toHaveLength(240);
		// Byte-exact recovery: the concatenated pages reconstruct the original.
		expect(recovered.join("\n")).toBe(original);
		// Paging an artifact back never writes another artifact.
		expect(saved).toEqual([]);
	});

	it("never resolves a pinned session's numeric artifact id against another session", async () => {
		const otherDir = path.join(testDir, "other-session");
		await fs.mkdir(otherDir, { recursive: true });
		// Same numeric id in both sessions: 0 is the pre-seeded mcp.log.
		const otherText = "other-session original: 天地玄黄";
		await Bun.write(path.join(otherDir, "0.mcp.log"), `${otherText}\n`);
		const otherUnregister = registerArtifactsDir(otherDir);
		const pinnedContext = {
			localProtocolOptions: { getArtifactsDir: () => artifactDir },
		} as unknown as AgentToolContext;

		try {
			// `artifact://0` is ambiguous across registered dirs; a session-pinned
			// lookup must stay inside its own artifacts directory.
			const pinned = await tool.execute(
				"pinned",
				{ path: "artifact://0:raw:1-1" },
				undefined,
				undefined,
				pinnedContext,
			);
			expect(getTextOutput(pinned)).toContain("line-001");
			expect(getTextOutput(pinned)).not.toContain(otherText);

			// An id absent from the pinned session must NOT fall through to the
			// other registered session that happens to hold it.
			const missing = await tool
				.execute("missing", { path: "artifact://99:raw:1-1" }, undefined, undefined, pinnedContext)
				.then(
					result => ({ ok: true as const, text: getTextOutput(result) }),
					error => ({ ok: false as const, text: error instanceof Error ? error.message : String(error) }),
				);
			expect(missing.text).not.toContain(otherText);

			// Repeated reads keep hitting the pinned session rather than whichever
			// directory the registry resolves for the bare id.
			for (let attempt = 0; attempt < 3; attempt++) {
				const repeat = await tool.execute(
					`repeat-${attempt}`,
					{ path: "artifact://0:raw:1-1" },
					undefined,
					undefined,
					pinnedContext,
				);
				expect(getTextOutput(repeat)).toContain("line-001");
				expect(getTextOutput(repeat)).not.toContain(otherText);
			}
		} finally {
			otherUnregister();
		}
	});
});
