import { describe, expect, test } from "bun:test";
import { type AgentTool, type AgentToolContext, countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import { stripOutputNotice, wrapToolWithMetaNotice } from "@san/coding-agent/tools/output-meta";

function makeContext(sessionManager: object, settings: Settings, executionScopeId: string): AgentToolContext {
	return {
		sessionManager,
		settings,
		executionScopeId,
		model: { contextWindow: 10_000 },
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
			"tools.logicalTurnOutputTokens": 0,
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

	test("reserves one shared logical-turn budget and resets it for a new scope", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (content: string) => {
				saved.push(content);
				return `artifact-${saved.length}`;
			},
		};
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1000,
			"tools.artifactHeadBytes": 20,
			"tools.artifactTailBytes": 20,
			"tools.artifactTailLines": 50,
			"tools.outputPreviewTokens": 10_000,
			"tools.logicalTurnOutputTokens": 1800,
		});
		const original = "alpha ".repeat(1600);
		const tool = wrapToolWithMetaNotice({
			name: "bash",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const run = (scope: string) =>
			tool.execute("call", {}, undefined, undefined, makeContext(sessionManager, settings, scope));
		const first = await run("scope-1");
		const second = await run("scope-1");
		const reset = await run("scope-2");
		const bodyTokens = (result: typeof first) => {
			const block = result.content.find(item => item.type === "text");
			return countTokens(stripOutputNotice(block?.text ?? "", result.details?.meta));
		};

		expect(bodyTokens(first)).toBeLessThanOrEqual(1800);
		expect(bodyTokens(second)).toBeLessThan(bodyTokens(first));
		expect(bodyTokens(reset)).toBe(bodyTokens(first));
		expect(saved).toHaveLength(3);
	});

	test("caps exhausted previews across one scope and resets artifacts by scope", async () => {
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
			"tools.outputPreviewTokens": 10_000,
			"tools.logicalTurnOutputTokens": 20,
		});
		const original = "useful output ".repeat(1_000);
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const run = (scope: string) =>
			tool.execute("call", {}, undefined, undefined, makeContext(sessionManager, settings, scope));
		const first = await run("scope-1");
		const exhausted = await run("scope-1");
		const repeated = await run("scope-1");
		const reset = await run("scope-2");
		const bodyTokens = (result: typeof first) => {
			const block = result.content.find(item => item.type === "text");
			return countTokens(stripOutputNotice(block?.text ?? "", result.details?.meta));
		};

		expect(bodyTokens(exhausted)).toBeGreaterThan(0);
		expect(bodyTokens(repeated)).toBe(0);
		expect(bodyTokens(first) + bodyTokens(exhausted) + bodyTokens(repeated)).toBeLessThanOrEqual(532);
		expect(exhausted.details?.meta?.truncation?.artifactId).toBe("artifact-2");
		expect(repeated.details?.meta?.truncation?.artifactId).toBe("artifact-3");
		expect(bodyTokens(reset)).toBe(bodyTokens(first));
		expect(saved).toHaveLength(4);
	});

	test("preserves small recovery results with one shared token left", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (text: string) => {
				saved.push(text);
				return String(saved.length);
			},
		};
		const burn = "alpha ".repeat(200);
		const recovery = "Recovery evidence: diagnostic E_RECOVERY_READY is readable. ".repeat(8);
		const settings = Settings.isolated({
			"tools.logicalTurnOutputTokens": countTokens(burn) + 1,
		});
		let text = burn;
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text }] }),
		} as unknown as AgentTool);
		const context = makeContext(sessionManager, settings, "near-zero");
		await tool.execute("burn", {}, undefined, undefined, context);
		text = recovery;
		const result = await tool.execute("recover", {}, undefined, undefined, context);
		expect(result.content).toEqual([{ type: "text", text: recovery }]);
		expect(saved).toEqual([]);
	});

	test("caps emergency previews by the explicit per-result token limit", async () => {
		const original = "diagnostic data ".repeat(1000);
		const sessionManager = { saveArtifact: async () => "bounded" };
		const settings = Settings.isolated({
			"tools.logicalTurnOutputTokens": 1,
			"tools.outputPreviewTokens": 96,
		});
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: original }] }),
		} as unknown as AgentTool);
		const context = makeContext(sessionManager, settings, "bounded");
		await tool.execute("burn", {}, undefined, undefined, context);
		const result = await tool.execute("recover", {}, undefined, undefined, context);
		const body = stripOutputNotice(
			result.content.find(block => block.type === "text")?.text ?? "",
			result.details?.meta,
		);
		expect(body).toContain("diagnostic");
		expect(countTokens(body)).toBeLessThanOrEqual(96);
		expect(result.details?.meta?.truncation?.artifactId).toBe("bounded");
	});
});
