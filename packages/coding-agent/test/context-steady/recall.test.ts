import { describe, expect, test } from "bun:test";
import {
	buildContextSteadyRecallQuery,
	normalizeContextSteadyRecallItems,
	recallFromContextBranch,
} from "../../src/context-steady/recall";
import { isTextRelevantToPrompt } from "../../src/context-steady/relevance";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION, type TurnDigest } from "../../src/context-steady/types";
import type { SessionEntry } from "../../src/session/session-entries";

function digest(turnId: string, userIntent: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: "2026-06-30T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId: `${turnId}-from`, toEntryId: `${turnId}-to`, promptGeneration: 1 },
		userIntent,
		actionsTaken: [`acted on ${userIntent}`],
		decisions: [`decided ${turnId}`],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [`continue ${turnId}`],
		memoryCandidates: [],
		fallback: true,
	};
}

function digestEntry(id: string, data: TurnDigest): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-06-30T00:00:00.000Z",
		customType: TURN_DIGEST_CUSTOM_TYPE,
		data,
	};
}

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-30T00:00:00.000Z",
		message,
	} as unknown as SessionEntry;
}

describe("Context steady recall quality helpers", () => {
	test("builds recall query from current prompt plus recent digest context", () => {
		const query = buildContextSteadyRecallQuery(
			[
				digestEntry("d1", digest("t1", "implement M6 debug view")),
				digestEntry("d2", digest("t2", "write M7 dogfood verifier")),
				digestEntry("d3", digest("t3", "settle M8 recommended config")),
			],
			"Continue recall quality",
			{ recentDigests: 2, maxQueryChars: 2000 },
		);

		expect(query).toContain("Recent San turn digests:");
		expect(query).toContain("d2: write M7 dogfood verifier");
		expect(query).toContain("d3: settle M8 recommended config");
		expect(query).not.toContain("d1: implement M6 debug view");
		expect(query).toContain("Current prompt:");
		expect(query).toContain("Continue recall quality");
	});

	test("preserves the current prompt when digest context exceeds the query budget", () => {
		const query = buildContextSteadyRecallQuery(
			[digestEntry("d1", digest("t1", "x".repeat(1000)))],
			"Recall the current task",
			{ recentDigests: 1, maxQueryChars: 24 },
		);

		expect(query).toBe("Recall the current task");
	});

	test("fails closed when query or item budgets are disabled and enforces item token limits", () => {
		expect(
			buildContextSteadyRecallQuery([digestEntry("d1", digest("t1", "retain this context"))], "Current task", {
				recentDigests: 1,
				maxQueryChars: 0,
			}),
		).toBe("");

		expect(
			normalizeContextSteadyRecallItems(
				[
					{ id: "too-large", content: "x".repeat(400) },
					{ id: "small", content: "keep this item" },
				],
				{ maxItems: 2, maxTokens: 20 },
			),
		).toEqual([{ id: "small", content: "keep this item" }]);

		expect(normalizeContextSteadyRecallItems([{ content: "keep" }], { maxItems: 1, maxTokens: 0 })).toEqual([]);
	});

	test("deduplicates and trims recall results before building the volatile layer", () => {
		const items = normalizeContextSteadyRecallItems(
			[
				{ id: "mem-1", content: " Keep San docs in HTML ", source: "mnemopi", score: 0.9 },
				{ id: "mem-1", content: "Keep San docs in HTML", source: "mnemopi", score: 0.8 },
				{ content: "Cache stable content first", source: "mnemopi" },
				{ content: "  Cache stable content first  ", source: "mnemopi" },
				{ content: "   " },
				{ id: "mem-3", content: "Recall is read-only", source: "hindsight" },
			],
			{ maxItems: 3 },
		);

		expect(items).toEqual([
			{ id: "mem-1", content: "Keep San docs in HTML", source: "mnemopi", score: 0.9 },
			{ content: "Cache stable content first", source: "mnemopi" },
			{ id: "mem-3", content: "Recall is read-only", source: "hindsight" },
		]);
	});

	test("fails closed for unscoped and mismatched recall items when scope isolation is active", () => {
		const items = normalizeContextSteadyRecallItems(
			[
				{ id: "repo-risk", content: "Release retry failed", memoryType: "episodic", scope: "repo:/repo" },
				{ id: "user-fact", content: "Prefer HTML", memoryType: "fact", scope: "user:user:local" },
				{ id: "working", content: "Transient note", memoryType: "working", scope: "repo:/repo" },
				{ id: "legacy", content: "Bank-scoped legacy memory" },
			],
			{ maxItems: 5, memoryTypes: ["episodic", "fact"], scopeKeys: ["repo:/repo"] },
		);

		expect(items).toEqual([
			{
				id: "repo-risk",
				content: "Release retry failed",
				memoryType: "episodic",
				scope: "repo:/repo",
			},
		]);
	});

	test("does not treat one-token CJK overlap as topic relevance", () => {
		expect(isTextRelevantToPrompt("模型", "模型价格调研")).toBe(false);
		expect(isTextRelevantToPrompt("上下文稳态", "上下文稳态验收报告")).toBe(true);
	});

	test("recalls matching raw tool results from real branch entries", () => {
		const branch = [
			messageEntry("old-failure", {
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "bash",
				content: [{ type: "text", text: "FAIL E_PARSE_17: stale delimiter state" }],
				isError: true,
				timestamp: 1,
			}),
			messageEntry("current-prompt", {
				role: "user",
				content: [{ type: "text", text: "What caused E_PARSE_17 previously?" }],
				timestamp: 2,
			}),
		];

		expect(
			recallFromContextBranch(branch, "What caused E_PARSE_17 previously?", {
				maxItems: 3,
				maxTokens: 1000,
				currentEntryId: "current-prompt",
			}),
		).toEqual([
			expect.objectContaining({
				id: "old-failure",
				source: "source:old-failure",
				content: expect.stringContaining("stale delimiter state"),
				memoryType: "context-journal",
				scope: "branch-local",
			}),
		]);
	});

	test("uses digest context for thin continuation and ignores unrelated new tasks", () => {
		const branch = [
			messageEntry("old-failure", {
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "bash",
				content: [{ type: "text", text: "E_PARSE_17 failed because delimiter state was stale" }],
				isError: true,
				timestamp: 1,
			}),
		];

		expect(
			recallFromContextBranch(branch, "continue", {
				maxItems: 3,
				maxTokens: 1000,
				fallbackQuery: "Repair parser E_PARSE_17 and preserve delimiter state",
			}),
		).toEqual([expect.objectContaining({ source: "source:old-failure" })]);
		expect(
			recallFromContextBranch(branch, "Implement unrelated authentication middleware", {
				maxItems: 3,
				maxTokens: 1000,
			}),
		).toEqual([]);
	});
});
