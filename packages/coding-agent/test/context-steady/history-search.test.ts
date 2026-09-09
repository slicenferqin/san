import { describe, expect, test } from "bun:test";
import {
	ContextHistoryIndex,
	makeContextSourceRef,
	parseContextSourceRef,
	searchContextHistory,
} from "../../src/context-steady/history-search";
import type { SessionEntry } from "../../src/session/session-entries";

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

function customMessageEntry(id: string, content: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "ordinary-note",
		content,
		display: false,
		attribution: "agent",
	} as unknown as SessionEntry;
}

function digestEntry(id: string, content: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "san.turn_digest",
		data: { summary: content },
	} as unknown as SessionEntry;
}

describe("searchContextHistory", () => {
	test("finds failures present only in a tool result and returns a stable source ref", () => {
		const branch = [
			messageEntry("user-1", { role: "user", content: "Fix the login" }),
			messageEntry("tool-1", {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "token refresh failed with ECONNRESET" }],
			}),
		];
		const result = searchContextHistory(branch, "ECONNRESET");
		expect(result.total).toBe(1);
		expect(result.hits[0]?.entryId).toBe("tool-1");
		expect(result.hits[0]?.ref).toBe(makeContextSourceRef("tool-1"));
		expect(parseContextSourceRef(result.hits[0]!.ref)).toBe("tool-1");
		expect(result.hits[0]?.excerpt).toContain("ECONNRESET");
	});

	test("excludes lossy digest custom entries", () => {
		const result = searchContextHistory([digestEntry("digest-1", "secret unique failure")], "unique failure");
		expect(result).toEqual({ query: "unique failure", hits: [], total: 0 });
	});

	test("excludes generated plan injections and updates incrementally", () => {
		const plan = {
			type: "custom_message",
			id: "plan",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "san.context_plan.injected",
			content: "unique-plan-instruction",
			display: false,
		};
		const first = messageEntry("first", { role: "user", content: "first result" });
		const second = messageEntry("second", { role: "toolResult", content: "second result" });
		const index = new ContextHistoryIndex();
		index.update([first, plan as unknown as SessionEntry]);
		expect(index.search("unique-plan-instruction").total).toBe(0);
		index.update([first, plan as unknown as SessionEntry, second]);
		expect(index.search("second result").hits[0]?.ref).toBe(makeContextSourceRef("second"));
		index.update([second]);
		expect(index.search("first result").total).toBe(0);
	});

	test("supports CJK and identifier substring matching", () => {
		const branch = [
			messageEntry("cjk", { role: "user", content: "上下文稳态恢复失败" }),
			customMessageEntry("identifier", "contextSteadyRecoveryEnabled"),
		];
		expect(searchContextHistory(branch, "上下文稳态").hits[0]?.entryId).toBe("cjk");
		expect(searchContextHistory(branch, "RecoveryEnabled").hits[0]?.entryId).toBe("identifier");
	});

	test("ranks repeated matches and applies a deterministic limit", () => {
		const branch = [
			messageEntry("old", { role: "user", content: "cache issue" }),
			messageEntry("recent", { role: "assistant", content: "cache cache issue" }),
			messageEntry("newest", { role: "assistant", content: "cache issue" }),
		];
		const result = searchContextHistory(branch, "cache issue", { limit: 2 });
		expect(result.total).toBe(3);
		expect(result.hits.map(hit => hit.entryId)).toEqual(["recent", "newest"]);
	});

	test("fails closed for an empty query", () => {
		expect(searchContextHistory([], "   ")).toEqual({ query: "   ", hits: [], total: 0 });
	});
});
