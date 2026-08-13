import { describe, expect, test } from "bun:test";
import { expandDigestSpan } from "../../src/context-steady/expand";
import { buildContextPacket } from "../../src/context-steady/packet";
import type { ContextPacketSettings, TurnDigest } from "../../src/context-steady/types";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION } from "../../src/context-steady/types";
import { ContextExpandTool } from "../../src/tools/context-expand";
import type { ToolSession } from "../../src/tools/index";
import { ToolError } from "../../src/tools/tool-errors";

function digest(turnId: string, fromEntryId: string, toEntryId: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: new Date().toISOString(),
		source: { sessionId: "s1", fromEntryId, toEntryId, promptGeneration: 1 },
		userIntent: `intent of ${turnId}`,
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [],
		fallback: true,
	};
}

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function digestEntry(id: string, payload: TurnDigest): Record<string, unknown> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: TURN_DIGEST_CUSTOM_TYPE,
		data: payload,
	};
}

function sampleBranch(): Record<string, unknown>[] {
	return [
		messageEntry("m1", { role: "user", content: "please fix the login timeout", timestamp: 1 }),
		messageEntry("m2", {
			role: "assistant",
			content: [
				{ type: "text", text: "Looking at the session store now." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test login.test.ts" } },
			],
			timestamp: 2,
		}),
		messageEntry("m3", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "1 fail: token refresh expired" }],
			timestamp: 3,
		}),
		digestEntry("d1", digest("turn-1", "m1", "m3")),
	];
}

type Branch = Parameters<typeof expandDigestSpan>[0];

describe("expandDigestSpan", () => {
	test("expands a digest ref back into the raw transcript span it covers", () => {
		const result = expandDigestSpan(sampleBranch() as unknown as Branch, "d1");
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.fromEntryId).toBe("m1");
		expect(result.toEntryId).toBe("m3");
		expect(result.messageCount).toBe(3);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("please fix the login timeout");
		expect(result.text).toContain("Looking at the session store now.");
		expect(result.text).toContain("[tool call: bash");
		expect(result.text).toContain("1 fail: token refresh expired");
	});

	test("truncates oversized spans from the oldest side and keeps the tail", () => {
		const branch = sampleBranch();
		branch.splice(
			3,
			0,
			messageEntry("m4", { role: "assistant", content: `analysis: ${"x".repeat(5_000)} tail-marker`, timestamp: 4 }),
		);
		const withWideDigest = branch.map(entry =>
			entry.id === "d1" ? digestEntry("d1", digest("turn-1", "m1", "m4")) : entry,
		);
		const result = expandDigestSpan(withWideDigest as unknown as Branch, "d1", { maxChars: 1_000 });
		expect(result).toBeDefined();
		if (!result) return;
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("truncated");
		expect(result.text).toContain("tail-marker");
		expect(result.text).not.toContain("please fix the login timeout");
	});

	test("returns undefined for unknown ids and non-digest entries", () => {
		const branch = sampleBranch() as unknown as Branch;
		expect(expandDigestSpan(branch, "missing")).toBeUndefined();
		expect(expandDigestSpan(branch, "m1")).toBeUndefined();
	});
});

describe("context packet digest refs", () => {
	test("renders each digest with its expandable entry ref", () => {
		const settings: ContextPacketSettings = {
			enabled: true,
			recentDigests: 3,
			maxTokens: 2_000,
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
		};
		const branch = sampleBranch();
		const packet = buildContextPacket(
			branch as unknown as Parameters<typeof buildContextPacket>[0],
			"s1",
			"continue the fix",
			settings,
		);
		expect(packet?.content).toContain("[ref: d1]");
		expect(packet?.content).toContain("context_expand");
	});
});

describe("ContextExpandTool", () => {
	function toolSession(expand: ToolSession["expandContextDigest"]): ToolSession {
		return { expandContextDigest: expand } as unknown as ToolSession;
	}

	test("is only created for sessions that expose the expansion capability", () => {
		expect(ContextExpandTool.createIf({} as unknown as ToolSession)).toBeNull();
		expect(ContextExpandTool.createIf(toolSession(() => undefined))).toBeInstanceOf(ContextExpandTool);
	});

	test("returns the expanded transcript for a valid ref", async () => {
		const branch = sampleBranch() as unknown as Branch;
		const tool = ContextExpandTool.createIf(toolSession(ref => expandDigestSpan(branch, ref)));
		if (!tool) throw new Error("tool should be created");
		const result = await tool.execute("call-1", { ref: "d1" });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("Expanded digest d1");
		expect(text).toContain("please fix the login timeout");
		expect(result.details?.messageCount).toBe(3);
	});

	test("rejects refs that do not resolve to an expandable digest", async () => {
		const tool = ContextExpandTool.createIf(toolSession(() => undefined));
		if (!tool) throw new Error("tool should be created");
		expect(tool.execute("call-1", { ref: "nope" })).rejects.toThrow(ToolError);
	});
});
