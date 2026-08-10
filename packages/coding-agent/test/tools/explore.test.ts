import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@san/coding-agent/config/settings";
import { computeHashlineDiff } from "@san/coding-agent/edit";
import {
	type CodeIntelligenceProvider,
	type CodeIntelligenceResult,
	createTools,
	ExploreTool,
	filterCodeGraphServerInstructions,
	filterPresentedCodeGraphTools,
	parseCodeGraphExploreResult,
	type ToolSession,
} from "@san/coding-agent/tools";
import { removeWithRetries } from "@san/utils";

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: true,
		enableLsp: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"san.codeIntelligence.enabled": true,
			"tools.xdev": false,
			"edit.mode": "hashline",
		}),
		...overrides,
	};
}

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-explore-"));
	try {
		await run(tempDir);
	} finally {
		await removeWithRetries(tempDir);
	}
}

function staticProvider(result: CodeIntelligenceResult): CodeIntelligenceProvider {
	return {
		async explore() {
			return result;
		},
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(item => item.type === "text")
		.map(item => item.text ?? "")
		.join("\n");
}

describe("explore provider facade", () => {
	it("normalizes CodeGraph Markdown, including source ranges and pending freshness", () => {
		const parsed = parseCodeGraphExploreResult(
			[
				"⚠️ Some files referenced below were edited since the last index sync:",
				"- `src/runtime.ts`",
				"",
				"## Exploration: Runtime",
				"",
				"### Blast radius — what depends on these",
				"- `Runtime` — 2 callers",
				"",
				"### Relationships",
				"**calls:**",
				"- start → run",
				"",
				"### Source Code",
				"#### src/runtime.ts — Runtime(class)",
				"```typescript",
				"10\texport class Runtime {",
				"11\t\trun() {}",
				"15\t\tstop() {}",
				"```",
			].join("\n"),
			"**Files indexed:** 1,234\n\n### Pending sync\n- `src/runtime.ts` (modified)",
		);

		expect(parsed.provider).toBe("codegraph");
		expect(parsed.freshness).toBe("pending-files");
		expect(parsed.repositoryFileCount).toBe(1234);
		expect(parsed.pendingFiles).toEqual(["src/runtime.ts"]);
		expect(parsed.relationships).toEqual(["calls: start → run"]);
		expect(parsed.blastRadius).toEqual(["`Runtime` — 2 callers"]);
		expect(parsed.sourceWindows).toEqual([
			{
				path: "src/runtime.ts",
				ranges: [
					{ startLine: 10, endLine: 11 },
					{ startLine: 15, endLine: 15 },
				],
			},
		]);
	});

	it("roots CodeGraph paths at the index while enforcing a nested requested scope", async () => {
		await withTempDir(async tempDir => {
			const scopedDir = path.join(tempDir, "src", "scope");
			await fs.mkdir(scopedDir, { recursive: true });
			await Bun.write(path.join(scopedDir, "runtime.ts"), "export const scopedNeedle = 1;\n");
			await Bun.write(path.join(tempDir, "src", "outside.ts"), "export const outsideNeedle = 2;\n");
			const parsed = parseCodeGraphExploreResult(
				[
					"## Exploration: scopedNeedle",
					"",
					"### Source Code",
					"#### src/scope/runtime.ts — scopedNeedle(variable)",
					"```typescript",
					"1\texport const scopedNeedle = 1;",
					"```",
					"#### src/outside.ts — outsideNeedle(variable)",
					"```typescript",
					"1\texport const outsideNeedle = 2;",
					"```",
				].join("\n"),
				"",
				tempDir,
			);
			const tool = new ExploreTool(createSession(tempDir), { codeGraphProvider: staticProvider(parsed) });

			const result = await tool.execute("nested-scope", { query: "scopedNeedle", path: "src/scope" });
			const text = resultText(result);

			expect(result.details?.sourceWindows.map(window => window.path)).toEqual(["src/scope/runtime.ts"]);
			expect(text).toContain("1:export const scopedNeedle = 1;");
			expect(text).not.toContain("outsideNeedle");
		});
	});

	it("re-reads pending source into FileSnapshotStore so the returned hashline can edit without another read", async () => {
		await withTempDir(async tempDir => {
			const sourceDir = path.join(tempDir, "src");
			await fs.mkdir(sourceDir, { recursive: true });
			const sourcePath = path.join(sourceDir, "runtime.ts");
			await Bun.write(sourcePath, "first\ncurrent value\nthird\n");
			const session = createSession(tempDir);
			const tool = new ExploreTool(session, {
				codeGraphProvider: staticProvider({
					provider: "codegraph",
					freshness: "pending-files",
					sourceWindows: [{ path: "src/runtime.ts", ranges: [{ startLine: 1, endLine: 3 }] }],
					relationships: ["Runtime → dependency"],
					blastRadius: ["Runtime — 1 caller"],
					pendingFiles: ["src/runtime.ts"],
				}),
			});

			const explored = await tool.execute("explore-1", { query: "Runtime" });
			const text = resultText(explored);
			const header = text.match(/^\[src\/runtime\.ts#[0-9A-F]{4}\]$/m)?.[0];

			expect(header).toBeDefined();
			expect(text).toContain("2:current value");
			expect(text).toContain("Source windows below were re-read from the current disk");
			expect(explored.details?.freshness).toBe("pending-files");

			if (!session.fileSnapshotStore) throw new Error("Explore did not record a file snapshot");
			const editable = await computeHashlineDiff(
				{ input: `${header}\nSWAP 2.=2:\n+updated without reread` },
				tempDir,
				session.fileSnapshotStore,
			);
			expect("diff" in editable).toBe(true);
			if ("diff" in editable) expect(editable.diff).toContain("updated without reread");
			expect(await Bun.file(sourcePath).text()).toBe("first\ncurrent value\nthird\n");
		});
	});

	it("falls back to current-disk AST and grep when no CodeGraph provider is available", async () => {
		await withTempDir(async tempDir => {
			await Bun.write(path.join(tempDir, "fallback.ts"), "export function fallbackNeedle() {\n\treturn 42;\n}\n");
			const tool = new ExploreTool(createSession(tempDir), { codeGraphProvider: null });

			const result = await tool.execute("fallback", { query: "Where is fallbackNeedle?", maxFiles: 3 });
			const text = resultText(result);

			expect(result.details?.provider).toBe("lsp-ast");
			expect(result.details?.freshness).toBe("fresh");
			expect(result.details?.sourceWindows).toHaveLength(1);
			expect(text).toMatch(/^\[fallback\.ts#[0-9A-F]{4}\]$/m);
			expect(text).toContain("1:export function fallbackNeedle()");
		});
	});

	it("deduplicates unchanged ranges across calls and invalidates them when the file fingerprint changes", async () => {
		await withTempDir(async tempDir => {
			const sourcePath = path.join(tempDir, "state.ts");
			await Bun.write(sourcePath, "const state = 1;\nexport { state };\n");
			const provider = staticProvider({
				provider: "codegraph",
				freshness: "fresh",
				sourceWindows: [{ path: "state.ts", ranges: [{ startLine: 1, endLine: 2 }] }],
				relationships: [],
				blastRadius: [],
			});
			const tool = new ExploreTool(createSession(tempDir), { codeGraphProvider: provider });

			const first = await tool.execute("first", { query: "state" });
			const second = await tool.execute("second", { query: "state" });
			expect(first.details?.sourceWindows).toHaveLength(1);
			expect(second.details?.sourceWindows).toHaveLength(0);
			expect(second.details?.backReferences).toEqual([
				{ path: "state.ts", startLine: 1, endLine: 2, evidenceRef: "explore-ref:1.1" },
			]);
			expect(resultText(second)).toContain("state.ts:1-2 -> explore-ref:1.1");

			await Bun.write(sourcePath, "const state = 2;\nexport { state };\n");
			const third = await tool.execute("third", { query: "state" });
			expect(third.details?.sourceWindows).toHaveLength(1);
			expect(resultText(third)).toContain("1:const state = 2;");
		});
	});

	it("enforces the hard output budget without recording source lines it did not emit", async () => {
		await withTempDir(async tempDir => {
			const content = Array.from(
				{ length: 500 },
				(_, index) => `export const value${index} = "${"x".repeat(80)}";`,
			).join("\n");
			await Bun.write(path.join(tempDir, "large.ts"), `${content}\n`);
			const tool = new ExploreTool(createSession(tempDir), {
				maxOutputChars: 12_000,
				codeGraphProvider: staticProvider({
					provider: "codegraph",
					freshness: "fresh",
					sourceWindows: [{ path: "large.ts", ranges: [{ startLine: 1, endLine: 500 }] }],
					relationships: [],
					blastRadius: [],
				}),
			});

			const result = await tool.execute("budget", { query: "value" });
			const text = resultText(result);
			expect(text.length).toBeLessThanOrEqual(12_000);
			expect(result.details?.truncated).toBe(true);
			expect(result.details?.sourceWindows[0]?.endLine).toBeLessThan(500);
			expect(text).toContain("Explore output truncated at its hard character budget");
		});
	});

	it("is explicit-off and replaces raw CodeGraph MCP presentation when enabled", async () => {
		const disabledSession = createSession("/tmp", {
			settings: Settings.isolated({ "san.codeIntelligence.enabled": false, "tools.xdev": false }),
		});
		const enabledSession = createSession("/tmp");
		const disabledTools = await createTools(disabledSession);
		const enabledTools = await createTools(enabledSession);

		expect(Settings.isolated().get("san.codeIntelligence.enabled")).toBe(false);
		expect(disabledTools.map(tool => tool.name)).not.toContain("explore");
		expect(enabledTools.find(tool => tool.name === "explore")?.loadMode).toBe("essential");

		const mcpTools = [
			{ mcpToolName: "codegraph_explore", mcpServerName: "graph" },
			{ mcpToolName: "codegraph_status", mcpServerName: "graph" },
			{ mcpToolName: "other_search", mcpServerName: "other" },
		];
		expect(filterPresentedCodeGraphTools(mcpTools, true)).toEqual([mcpTools[2]]);
		expect(filterPresentedCodeGraphTools(mcpTools, false)).toEqual(mcpTools);
		expect(
			filterCodeGraphServerInstructions(
				new Map([
					["graph", "Call codegraph_explore"],
					["other", "Other instructions"],
				]),
				mcpTools,
				true,
			),
		).toEqual(new Map([["other", "Other instructions"]]));
	});
});
