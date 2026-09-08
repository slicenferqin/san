import { describe, expect, test } from "bun:test";
import { ContextSearchTool } from "../../src/tools/context-search";
import type { ToolSession } from "../../src/tools/index";

function session(search: NonNullable<ToolSession["searchContextHistory"]>): ToolSession {
	return { searchContextHistory: search } as unknown as ToolSession;
}

describe("ContextSearchTool", () => {
	test("is only created when the root session exposes search", () => {
		expect(ContextSearchTool.createIf({} as unknown as ToolSession)).toBeNull();
		expect(ContextSearchTool.createIf(session(() => ({ query: "x", hits: [], total: 0 })))).toBeInstanceOf(
			ContextSearchTool,
		);
	});

	test("returns readable refs and structured hits", async () => {
		const tool = ContextSearchTool.createIf(
			session(() => ({
				query: "timeout",
				total: 1,
				hits: [
					{
						ref: "source:entry-7",
						entryId: "entry-7",
						role: "toolResult",
						toolName: "bash",
						excerpt: "timeout while refreshing token",
						matchedTerms: ["timeout"],
						score: 2,
					},
				],
			})),
		);
		if (!tool) throw new Error("tool should be created");
		const result = await tool.execute("call-1", { query: "timeout" });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("source:entry-7");
		expect(text).toContain("context_expand");
		expect(result.details?.hits[0]?.entryId).toBe("entry-7");
	});

	test("rejects an empty query", async () => {
		const tool = ContextSearchTool.createIf(session(() => ({ query: "", hits: [], total: 0 })));
		if (!tool) throw new Error("tool should be created");
		expect(tool.execute("call-1", { query: "   " })).rejects.toThrow("non-empty");
	});
});
