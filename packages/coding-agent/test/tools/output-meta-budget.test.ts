import { describe, expect, test } from "bun:test";
import { type AgentTool, type AgentToolContext, countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import { type OutputMeta, stripOutputNotice, wrapToolWithMetaNotice } from "@san/coding-agent/tools/output-meta";

function makeContext(sessionManager: object, settings: Settings, executionScopeId: string): AgentToolContext {
	return {
		sessionManager,
		settings,
		executionScopeId,
		// Large window on purpose: the retired cumulative cap was also clamped to
		// 20% of the model window, so a small window would mask the regression.
		model: { contextWindow: 1_000_000 },
	} as unknown as AgentToolContext;
}

describe("centralized tool output budgets", () => {
	test("spills dense read output by bytes and preserves the full artifact", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (content: string) => {
				saved.push(content);
				return "artifact-dense";
			},
		};
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 50,
			"tools.outputPreviewTokens": 10_000,
		});
		const original = "天地玄黄宇宙洪荒".repeat(100);
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);

		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			makeContext(sessionManager, settings, "scope-1"),
		);
		const body = stripOutputNotice(
			result.content.find(block => block.type === "text")?.text ?? "",
			result.details?.meta,
		);

		expect(saved).toEqual([original]);
		expect(result.details?.meta?.truncation?.artifactId).toBe("artifact-dense");
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(2 * 1024);
	});

	test("keeps 14 dense outputs readable in one scope past the retired cumulative cap", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (content: string) => {
				saved.push(content);
				return `artifact-${saved.length}`;
			},
		};
		// Approved deterministic input: 14 successive 3,500-token results
		// (49,000 tokens) in one shared scope. The retired default cap was 32,000
		// tokens (also clamped to 20% of the window), so the older contract would
		// have starved results 10-14 into an empty body here.
		const original = "useful output ".repeat(1_000);
		const tokens = countTokens(original);
		expect(tokens).toBe(3_500);
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1000,
			"tools.outputPreviewTokens": 10_000,
		});
		const tool = wrapToolWithMetaNotice({
			name: "bash",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const context = makeContext(sessionManager, settings, "long-turn");
		let total = 0;
		for (let index = 0; index < 14; index++) {
			const result = await tool.execute(`call-${index}`, {}, undefined, undefined, context);
			const block = result.content.find(item => item.type === "text");
			const bodyTokens = countTokens(stripOutputNotice(block?.text ?? "", result.details?.meta));
			expect(bodyTokens).toBe(tokens);
			total += bodyTokens;
		}
		// Every result stays readable: nothing spilled, so no artifact was
		// fabricated just because the turn had already emitted a lot of output.
		expect(total).toBeGreaterThan(32_000);
		expect(saved).toEqual([]);
	});

	test("still spills and preserves the original when one result exceeds the per-result preview", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (content: string) => {
				saved.push(content);
				return `artifact-${saved.length}`;
			},
		};
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1000,
			"tools.artifactHeadBytes": 1024,
			"tools.artifactTailBytes": 1024,
			"tools.artifactTailLines": 50,
			"tools.outputPreviewTokens": 200,
		});
		const original = "useful output ".repeat(1_000);
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const body = (result: { content: Array<{ type: string; text?: string }>; details?: unknown }) => {
			const block = result.content.find(item => item.type === "text");
			return stripOutputNotice(block?.text ?? "", (result.details as { meta?: OutputMeta } | undefined)?.meta);
		};
		const context = makeContext(sessionManager, settings, "per-result");

		const first = await tool.execute("call-1", {}, undefined, undefined, context);
		const second = await tool.execute("call-2", {}, undefined, undefined, context);

		// The per-result preview limit still bites, and each result keeps its own
		// artifact instead of inheriting the scope's previous one.
		expect(countTokens(body(first))).toBeLessThanOrEqual(200);
		expect(countTokens(body(second))).toBeLessThanOrEqual(200);
		expect(first.details?.meta?.truncation?.artifactId).toBe("artifact-1");
		expect(second.details?.meta?.truncation?.artifactId).toBe("artifact-2");
		expect(saved).toEqual([original, original]);
	});

	test("preserves unique original text when artifact capture fails", async () => {
		const sessionManager = {
			saveArtifact: async () => {
				throw new Error("disk full");
			},
		};
		const recovery = "Recovery evidence: diagnostic E_RECOVERY_READY is readable. ".repeat(8);
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.outputPreviewTokens": 10_000,
		});
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: recovery }] }),
		} as unknown as AgentTool);
		const result = await tool.execute(
			"recover",
			{},
			undefined,
			undefined,
			makeContext(sessionManager, settings, "save-failure"),
		);

		// A failed capture must not claim a saved artifact nor drop the only copy.
		expect(result.details?.meta?.truncation).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: recovery }]);
	});

	test("bounds a dense result by the explicit per-result token limit", async () => {
		const original = "diagnostic data ".repeat(1000);
		const sessionManager = { saveArtifact: async () => "bounded" };
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1000,
			"tools.outputPreviewTokens": 96,
		});
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const result = await tool.execute(
			"recover",
			{},
			undefined,
			undefined,
			makeContext(sessionManager, settings, "bounded"),
		);
		const body = stripOutputNotice(
			result.content.find(block => block.type === "text")?.text ?? "",
			result.details?.meta,
		);
		expect(body).toContain("diagnostic");
		expect(countTokens(body)).toBeLessThanOrEqual(96);
		expect(result.details?.meta?.truncation?.artifactId).toBe("bounded");
	});
});
