/**
 * Context Steady State M1 — TurnDigest contract tests.
 *
 * Tests verify the externally observable contracts without depending on
 * the full session pipeline or native modules.
 *
 * Contracts tested:
 * 1. Fallback digest produces schema-complete TurnDigest from messages
 * 2. Normalize clamps and fills missing fields
 * 3. Session helpers properly detect/skip via CustomEntry contract
 * 4. Dedupe prevents duplicate writes for same source range
 * 5. Source span computation isolates the current turn from history
 * 6. Span extraction includes both message and custom_message entries
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateDigest } from "../../src/context-steady/digest";
import { generateFallbackDigest, generateTurnId } from "../../src/context-steady/fallback";
import { normalizeDigest } from "../../src/context-steady/normalize";
import {
	computeTurnSourceSpan,
	extractSpanMessages,
	findExistingDigest,
	hasExistingDigest,
	listTurnDigests,
	skipContextPacketPreludeInDigestSource,
} from "../../src/context-steady/session";
import type { TurnDigest } from "../../src/context-steady/types";
import {
	CONTEXT_PACKET_MESSAGE_TYPE,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
} from "../../src/context-steady/types";

// Minimal message shapes to avoid pulling in @oh-my-pi/pi-agent-core
// (which transitively loads @oh-my-pi/pi-natives native modules).
interface Msg {
	role: string;
	content:
		| string
		| Array<{
				type: string;
				text?: string;
				id?: string;
				name?: string;
				args?: Record<string, unknown>;
				arguments?: Record<string, unknown>;
		  }>;
	timestamp: number;
	provider: string;
	model: string;
	status?: string;
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
	entryId?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: Record<string, number>;
	};
}

function umsg(text: string): Msg {
	return { role: "user", content: text, timestamp: Date.now(), provider: "x", model: "x" };
}

function amsg(text: string, tcs?: Array<{ name: string; args?: Record<string, unknown> }>): Msg {
	const c: Msg["content"] = [];
	if (text) c.push({ type: "text", text });
	if (tcs) for (const tc of tcs) c.push({ type: "toolCall", id: `tc_${tc.name}`, name: tc.name, args: tc.args ?? {} });
	return { role: "assistant", content: c, timestamp: Date.now(), provider: "x", model: "x" };
}

function tmsg(tool: string, status: "completed" | "error", path?: string): Msg {
	return {
		role: "toolResult",
		toolCallId: `tc_${tool}`,
		toolName: tool,
		content: status === "completed" ? "OK" : "Err",
		status,
		details: path ? { path } : undefined,
		timestamp: Date.now(),
		provider: "x",
		model: "x",
	};
}

function centry(id: string, ct: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType: ct, data };
}

function msgEntry(id: string, role: string, content = ""): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role, content, timestamp: Date.now(), provider: "x", model: "x" },
	};
}

function customMsgEntry(id: string, customType: string, content = ""): Record<string, unknown> {
	return { type: "custom_message", id, parentId: null, timestamp: new Date().toISOString(), customType, content };
}

const asM = (m: Msg[]) => m as unknown as Parameters<typeof generateFallbackDigest>[0];
const asE = (e: Record<string, unknown>[]) => e as unknown as Parameters<typeof listTurnDigests>[0];

function getDigestModel(): Model<Api> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled digest test model");
	return model;
}

function assistantWithDigest(args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-digest", name: "record_turn_digest", arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createSessionManager(entries: Record<string, unknown>[] = []) {
	const stored = [...entries];
	return {
		getEntries: () => stored,
		appendCustomEntry(customType: string, data: unknown) {
			const entry = centry(`custom-${stored.length + 1}`, customType, data);
			stored.push(entry);
			return entry.id;
		},
	};
}

function steadySettings(llmEnabled: boolean, persistFallback = true) {
	return {
		enabled: true,
		digest: {
			enabled: true,
			persistFallback,
			timeoutMs: 5000,
			llm: { enabled: llmEnabled, modelRole: "pi/smol" },
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("fallback digest", () => {
	test("schema-complete TurnDigest from messages", () => {
		const msgs = asM([
			umsg("Please fix the bug in src/app.ts"),
			amsg("Looking...", [{ name: "read", args: { filePath: "src/app.ts" } }]),
			tmsg("read", "completed", "src/app.ts"),
			amsg("Fixed.", [{ name: "edit", args: { filePath: "src/app.ts" } }]),
			tmsg("edit", "completed", "src/app.ts"),
		]);

		const src = { sessionId: "s1", fromEntryId: "e1", toEntryId: "e5", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-1", "s1", "x/x");

		expect(d.schemaVersion).toBe(TURN_DIGEST_SCHEMA_VERSION);
		expect(d.turnId).toBe("turn-1");
		expect(d.sessionId).toBe("s1");
		expect(d.source).toEqual(src);
		expect(d.fallback).toBe(true);
		expect(typeof d.userIntent).toBe("string");
		expect(d.userIntent.length).toBeGreaterThan(0);
		expect(Array.isArray(d.actionsTaken)).toBe(true);
		expect(Array.isArray(d.filesTouched)).toBe(true);
		expect(Array.isArray(d.toolEvidence)).toBe(true);
		expect(d.userIntent).toContain("fix the bug");
		expect(d.filesTouched.map(f => f.path)).toContain("src/app.ts");
		expect(d.toolEvidence.map(t => t.tool)).toEqual(expect.arrayContaining(["read", "edit"]));
	});

	test("empty messages produce empty arrays", () => {
		const src = { sessionId: "s1", fromEntryId: "e1", toEntryId: "e1", promptGeneration: 0 };
		const d = generateFallbackDigest(asM([]), src, "t1", "s1");
		expect(d.actionsTaken).toEqual([]);
		expect(d.filesTouched).toEqual([]);
		expect(d.toolEvidence).toEqual([]);
		expect(d.fallback).toBe(true);
	});

	test("generates unique turn IDs", () => {
		expect(generateTurnId()).not.toBe(generateTurnId());
	});

	test("fallback flag is always true", () => {
		const d = generateFallbackDigest(
			asM([umsg("hi")]),
			{ sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 },
			"t",
			"s",
		);
		expect(d.fallback).toBe(true);
	});

	test("collects file paths from real AgentMessage toolCall arguments", () => {
		const msgs = asM([
			umsg("Patch src/app.ts"),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc_edit", name: "edit", arguments: { filePath: "src/app.ts" } }],
				timestamp: Date.now(),
				provider: "x",
				model: "x",
			},
			tmsg("edit", "completed", "src/app.ts"),
			amsg("Patched."),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e4", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-real-toolcall", "s");

		expect(d.filesTouched).toContainEqual({ path: "src/app.ts", action: "modified" });
		expect(d.toolEvidence.map(t => t.tool)).toContain("edit");
	});

	test("summarizes real toolResult entries that only expose isError", () => {
		const msgs = asM([
			umsg("Read and edit config"),
			{
				role: "toolResult",
				toolCallId: "tc_read",
				toolName: "read",
				content: "OK",
				isError: false,
				timestamp: Date.now(),
				provider: "x",
				model: "x",
			},
			{
				role: "toolResult",
				toolCallId: "tc_edit",
				toolName: "edit",
				content: "File not found",
				isError: true,
				timestamp: Date.now(),
				provider: "x",
				model: "x",
			},
			amsg("Done."),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e4", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-tool-status", "s");

		expect(d.toolEvidence.map(t => t.summary)).toEqual(["read: completed", "edit: error"]);
	});

	test("collects decisions from every assistant message in the source span", () => {
		const msgs = asM([
			umsg("Fix the parser"),
			amsg("I will inspect the parser first."),
			amsg("We should keep the fix scoped to parse errors."),
			tmsg("read", "completed", "src/parser.ts"),
			amsg("Done."),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e5", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-decisions", "s");

		expect(d.decisions).toEqual([
			"I will inspect the parser first.",
			"We should keep the fix scoped to parse errors.",
		]);
	});

	test("fallback digest extracts facts, risks, open questions, and next steps from assistant text", () => {
		const msgs = asM([
			umsg("Assess context steady"),
			amsg(
				[
					"Evidence: provider-bound pruning removed raw transcript markers.",
					"Risk: source span could over-prune custom context.",
					"Open question: LLM digest quality is not covered yet.",
					"Next step: rerun the real dogfood benchmark.",
				].join("\n"),
			),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-quality", "s");

		expect(d.factsLearned).toEqual(["Evidence: provider-bound pruning removed raw transcript markers."]);
		expect(d.risks).toEqual(["Risk: source span could over-prune custom context."]);
		expect(d.openQuestions).toEqual(["Open question: LLM digest quality is not covered yet."]);
		expect(d.nextSteps).toEqual(["Next step: rerun the real dogfood benchmark."]);
	});

	test("tool evidence keeps source entry ids when span extraction provides them", () => {
		const msgs = asM([
			umsg("Read a file"),
			{
				...tmsg("read", "completed", "src/app.ts"),
				entryId: "tool-result-entry",
			},
			amsg("Done."),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e3", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-entry-ids", "s");

		expect(d.toolEvidence[0]).toMatchObject({
			tool: "read",
			entryIds: ["tool-result-entry"],
		});
	});

	test("classifies write-like tools as modified file touches", () => {
		const msgs = asM([
			umsg("Update generated files"),
			amsg("Writing.", [
				{ name: "write", args: { filePath: "src/generated.ts" } },
				{ name: "ast_edit", args: { path: "src/refactor.ts" } },
				{ name: "notebook", args: { path: "notes.ipynb" } },
			]),
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-write-actions", "s");

		expect(d.filesTouched).toEqual([
			{ path: "src/generated.ts", action: "modified" },
			{ path: "src/refactor.ts", action: "modified" },
			{ path: "notes.ipynb", action: "modified" },
		]);
	});

	test("token stats total counts input and output without double-counting cache splits", () => {
		const msgs = asM([
			umsg("Summarize context usage"),
			{
				...amsg("Done."),
				usage: {
					input: 100,
					output: 20,
					cacheRead: 60,
					cacheWrite: 10,
					totalTokens: 120,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const d = generateFallbackDigest(msgs, src, "turn-token-stats", "s");

		expect(d.tokenStats).toEqual({
			input: 100,
			output: 20,
			cacheRead: 60,
			cacheWrite: 10,
			total: 120,
		});
	});
});

describe("normalize", () => {
	const fb = {
		turnId: "t",
		sessionId: "s",
		source: { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 },
	};

	test("fills missing fields with empty defaults", () => {
		const d = normalizeDigest({ userIntent: "test" }, fb);
		expect(d.userIntent).toBe("test");
		expect(d.actionsTaken).toEqual([]);
		expect(d.decisions).toEqual([]);
		expect(d.fallback).toBe(false);
	});

	test("clamps long strings", () => {
		const d = normalizeDigest({ userIntent: "x".repeat(1000) }, fb);
		expect(d.userIntent.length).toBeLessThanOrEqual(500);
		expect(d.userIntent.endsWith("...")).toBe(true);
	});

	test("handles null input gracefully", () => {
		const d = normalizeDigest(null, fb);
		expect(d.schemaVersion).toBe(TURN_DIGEST_SCHEMA_VERSION);
		expect(d.userIntent).toBe("Unknown");
		expect(d.actionsTaken).toEqual([]);
	});

	test("invalid file action becomes unknown", () => {
		const d = normalizeDigest({ filesTouched: [{ path: "a.ts", action: "nonexistent" }] }, fb);
		expect(d.filesTouched[0].action).toBe("unknown");
	});

	test("clamps array lengths", () => {
		const d = normalizeDigest({ actionsTaken: Array.from({ length: 100 }, (_, i) => `item-${i}`) }, fb);
		expect(d.actionsTaken.length).toBeLessThanOrEqual(20);
	});

	test("normalizes memory candidate importance as a zero-to-one score", () => {
		const d = normalizeDigest(
			{
				userIntent: "remember preferences",
				memoryCandidates: [
					{ content: "high", type: "preference", importance: 0.9 },
					{ content: "too high", type: "decision", importance: 2 },
					{ content: "too low", type: "workflow", importance: -1 },
					{ content: "missing", type: "other" },
					{ content: "invalid", type: "other", importance: Number.NaN },
				],
			},
			fb,
		);

		expect(d.memoryCandidates.map(candidate => candidate.importance)).toEqual([0.9, 1, 0, 0.5, 0.5]);
	});

	test("preserves tool evidence entry ids", () => {
		const d = normalizeDigest(
			{
				userIntent: "inspect files",
				toolEvidence: [{ tool: "read", summary: "read: completed", entryIds: ["entry-a", 7, "entry-b"] }],
			},
			fb,
		);

		expect(d.toolEvidence[0]).toEqual({
			tool: "read",
			summary: "read: completed",
			entryIds: ["entry-a", "entry-b"],
		});
	});
});

describe("LLM digest orchestration", () => {
	test("persists normalized LLM digest while keeping local source and evidence fields authoritative", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistantWithDigest({
				userIntent: "Validate whether context steady stays stable over a 10-turn benchmark.",
				actionsTaken: ["Inspected the prior dogfood run and identified digest quality as the next bottleneck."],
				decisions: ["Keep packet and checkpoint boundaries unchanged while replacing digest generation."],
				filesTouched: [{ path: "packages/coding-agent/src/context-steady/digest.ts", action: "modified" }],
				factsLearned: ["The current fallback digest misses implicit acceptance constraints."],
				openQuestions: [],
				risks: ["LLM digest failures must not block the main agent turn."],
				nextSteps: ["Run the context-steady test suite and bun check."],
				memoryCandidates: [
					{
						content: "San context steady should solve continuity generically, not with benchmark-specific rules.",
						type: "decision",
						importance: 0.9,
					},
				],
			}),
		);
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e3", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([
				umsg("上下文窗口现在稳住了吗，质量怎么样"),
				{
					...tmsg("read", "completed", "packages/coding-agent/src/context-steady/digest.ts"),
					entryId: "tool-entry",
				},
				amsg("Conclusion: stable, but digest quality needs LLM structure."),
			]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		const entries = sessionManager.getEntries();
		const stored = entries[0]?.data as TurnDigest;
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(stored.fallback).toBe(false);
		expect(stored.source).toEqual(source);
		expect(stored.userIntent).toContain("context steady");
		expect(stored.decisions).toContain(
			"Keep packet and checkpoint boundaries unchanged while replacing digest generation.",
		);
		expect(stored.toolEvidence[0]).toMatchObject({
			tool: "read",
			entryIds: ["tool-entry"],
		});
	});

	test("normalizes minor LLM schema drift instead of falling back", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistantWithDigest({
				userIntent: "第十轮：最终验收 San context steady 是否稳住。",
				actionsTaken: ["第十轮给出最终验收结论。"],
				decisions: ["上下文已基本稳住。"],
				filesTouched: [],
				factsLearned: [],
				openQuestions: [],
				risks: ["Digest 可能继续历史化。"],
				nextSteps: ["继续控制 digest 膨胀。"],
				memoryCandidates: [
					{
						content: "Digest 可能继续历史化，这是本轮风险。",
						type: "risk",
						importance: 0.7,
					},
					{
						content: "Digest 应压缩为通用状态摘要，而不是逐轮聊天复刻。",
						type: "workflow",
						importance: 0.9,
					},
				],
			}),
		);
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([umsg("第十轮：最终验收 San context steady 是否稳住。"), amsg("上下文已基本稳住。")]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		const stored = sessionManager.getEntries()[0]?.data as TurnDigest;
		expect(stored.fallback).toBe(false);
		expect(stored.userIntent).toBe("最终验收 San context steady 是否稳住。");
		expect(stored.actionsTaken).toEqual(["给出最终验收结论。"]);
		expect(stored.memoryCandidates).toEqual([
			{
				content: "Digest 应压缩为通用状态摘要，而不是逐轮聊天复刻。",
				type: "workflow",
				importance: 0.9,
			},
		]);
	});

	test("extracts the final valid JSON object from text fallback without greedy brace capture", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [
				{
					type: "text",
					text: [
						'ignore this diagnostic object: {"note":"not the digest"}',
						JSON.stringify({
							userIntent: "Recover digest JSON from text fallback.",
							actionsTaken: ["Parsed the final structured digest object."],
							decisions: ["Avoid greedy brace matching across multiple JSON objects."],
							filesTouched: [],
							factsLearned: [],
							openQuestions: [],
							risks: [],
							nextSteps: [],
							memoryCandidates: [],
						}),
					].join("\n"),
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([umsg("Need digest JSON fallback"), amsg("Done.")]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		const stored = sessionManager.getEntries()[0]?.data as TurnDigest;
		expect(stored.fallback).toBe(false);
		expect(stored.userIntent).toBe("Recover digest JSON from text fallback.");
		expect(stored.decisions).toEqual(["Avoid greedy brace matching across multiple JSON objects."]);
	});

	test("retries transient LLM digest failures before falling back", async () => {
		const completeSimpleMock = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValueOnce(
				new Error("OpenAI responses stream closed before a terminal response event was received"),
			)
			.mockResolvedValue(
				assistantWithDigest({
					userIntent: "Finalize context steady acceptance.",
					actionsTaken: ["Recorded a stable acceptance conclusion."],
					decisions: ["Treat a transient digest stream close as retryable."],
					filesTouched: [],
					factsLearned: ["The final response completed successfully before digest generation."],
					openQuestions: [],
					risks: [],
					nextSteps: [],
					memoryCandidates: [],
				}),
			);
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([umsg("最终验收"), amsg("通过。")]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		const stored = sessionManager.getEntries()[0]?.data as TurnDigest;
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(stored.fallback).toBe(false);
		expect(stored.userIntent).toBe("Finalize context steady acceptance.");
		expect(stored.decisions).toEqual(["Treat a transient digest stream close as retryable."]);
	});

	test("falls back to deterministic digest when LLM generation fails and fallback persistence is enabled", async () => {
		vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("provider unavailable"));
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([umsg("Fix src/app.ts"), { ...tmsg("read", "completed", "src/app.ts"), entryId: "tool-entry" }]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true, true),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		const stored = sessionManager.getEntries()[0]?.data as TurnDigest;
		expect(stored.fallback).toBe(true);
		expect(stored.userIntent).toContain("Fix src/app.ts");
		expect(stored.toolEvidence[0]).toMatchObject({ entryIds: ["tool-entry"] });
	});

	test("skips persistence when LLM generation fails and fallback persistence is disabled", async () => {
		vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("provider unavailable"));
		const source = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 1 };
		const sessionManager = createSessionManager();

		await generateDigest(
			asM([umsg("Fix src/app.ts")]),
			source,
			sessionManager as never,
			{} as never,
			steadySettings(true, false),
			{ model: getDigestModel(), apiKey: async () => "test-key" },
		);

		expect(sessionManager.getEntries()).toEqual([]);
	});
});

describe("session helpers", () => {
	test("listTurnDigests empty when no entries", () => {
		expect(listTurnDigests(asE([]))).toEqual([]);
	});

	test("listTurnDigests filters by customType", () => {
		const d: TurnDigest = {
			schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
			turnId: "t1",
			sessionId: "s",
			createdAt: new Date().toISOString(),
			source: { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 },
			userIntent: "test",
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
		const entries = asE([
			centry("c1", "other.type", {}),
			centry("c2", TURN_DIGEST_CUSTOM_TYPE, d),
			centry("c3", TURN_DIGEST_CUSTOM_TYPE, { ...d, turnId: "t2" }),
		]);
		const digests = listTurnDigests(entries);
		expect(digests).toHaveLength(2);
		expect(digests[0].turnId).toBe("t1");
		expect(digests[1].turnId).toBe("t2");
	});

	test("listTurnDigests skips entries without schemaVersion", () => {
		const entries = asE([centry("c1", TURN_DIGEST_CUSTOM_TYPE, { notDigest: true })]);
		expect(listTurnDigests(entries)).toEqual([]);
	});

	test("hasExistingDigest detects source range match", () => {
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 };
		const d: TurnDigest = {
			schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
			turnId: "t",
			sessionId: "s",
			createdAt: new Date().toISOString(),
			source: src,
			userIntent: "x",
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
		const entries = asE([centry("c1", TURN_DIGEST_CUSTOM_TYPE, d)]);
		expect(hasExistingDigest(entries, src)).toBe(true);
		expect(hasExistingDigest(entries, { ...src, fromEntryId: "different" })).toBe(false);
	});

	test("findExistingDigest returns matching entry", () => {
		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 };
		const d: TurnDigest = {
			schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
			turnId: "t",
			sessionId: "s",
			createdAt: new Date().toISOString(),
			source: src,
			userIntent: "x",
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
		const entries = asE([centry("c1", TURN_DIGEST_CUSTOM_TYPE, d)]);
		expect(findExistingDigest(entries, src)?.id).toBe("c1");
		expect(findExistingDigest(entries, { ...src, toEntryId: "diff" })).toBeUndefined();
	});

	test("TurnDigest stored as type custom (not custom_message)", () => {
		const d: TurnDigest = {
			schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
			turnId: "t",
			sessionId: "s",
			createdAt: new Date().toISOString(),
			source: { sessionId: "s", fromEntryId: "e1", toEntryId: "e2", promptGeneration: 0 },
			userIntent: "x",
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
		const entry = centry("c1", TURN_DIGEST_CUSTOM_TYPE, d);
		expect(entry.type).toBe("custom");
		expect(entry.customType).toBe(TURN_DIGEST_CUSTOM_TYPE);
	});

	test("dedupe by source range composition", () => {
		const src1 = { sessionId: "A", fromEntryId: "1", toEntryId: "5", promptGeneration: 1 };
		const src2 = { sessionId: "A", fromEntryId: "1", toEntryId: "5", promptGeneration: 2 };
		const src3 = { sessionId: "A", fromEntryId: "1", toEntryId: "6", promptGeneration: 1 };
		const d: TurnDigest = {
			schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
			turnId: "t",
			sessionId: "A",
			createdAt: new Date().toISOString(),
			source: src1,
			userIntent: "x",
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
		const entries = asE([centry("c1", TURN_DIGEST_CUSTOM_TYPE, d)]);
		expect(hasExistingDigest(entries, src1)).toBe(true);
		expect(hasExistingDigest(entries, src2)).toBe(true); // same range
		expect(hasExistingDigest(entries, src3)).toBe(false); // different range
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: multi-subturn turn boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("multi-subturn turn boundary", () => {
	// A real user turn often contains multiple provider sub-turns:
	//   user → assistant(toolCall) → toolResult → assistant(toolCall) → toolResult → assistant(final)
	// The digest must cover the FULL span, and userIntent must come from
	// the CURRENT user request, not from a historical message.

	test("userIntent comes from current user message, not history", () => {
		// Simulate a turn with user message + multiple provider sub-turns
		const msgs = asM([
			umsg("Please fix the type error in src/utils.ts"),
			amsg("Let me read the file first.", [{ name: "read", args: { filePath: "src/utils.ts" } }]),
			tmsg("read", "completed", "src/utils.ts"),
			amsg("Found the issue. The return type is wrong. Let me fix it.", [
				{ name: "edit", args: { filePath: "src/utils.ts" } },
			]),
			tmsg("edit", "completed", "src/utils.ts"),
			amsg("Done. The type error should be fixed now."),
		]);

		const src = { sessionId: "s", fromEntryId: "e1", toEntryId: "e6", promptGeneration: 1 };
		const digest = generateFallbackDigest(msgs, src, "turn-1", "s");

		// userIntent must come from the CURRENT user message
		expect(digest.userIntent).toContain("fix the type error");
		expect(digest.userIntent).toContain("src/utils.ts");

		// Must capture both tool calls
		const toolNames = digest.toolEvidence.map(t => t.tool);
		expect(toolNames).toEqual(expect.arrayContaining(["read", "edit"]));

		// Files touched should include the file from both sub-turns
		expect(digest.filesTouched.map(f => f.path)).toContain("src/utils.ts");
	});

	test("fallback digest handles multi-subturn without history contamination", () => {
		// Simulate a case where the source span messages are a subset
		// (only the last provider sub-turn) — in real use the span computation
		// in agent-session.ts filters entries, but here we test that the
		// fallback correctly identifies intent from whatever it's given.
		const msgs = asM([
			amsg("Let me re-examine the error log.", [{ name: "grep", args: { pattern: "TypeError" } }]),
			tmsg("grep", "completed"),
			amsg("The grep found 3 occurrences. All in src/utils.ts around line 42."),
		]);

		const src = { sessionId: "s", fromEntryId: "e10", toEntryId: "e12", promptGeneration: 2 };
		const digest = generateFallbackDigest(msgs, src, "turn-2", "s");

		// No user message in this span → fallback says system-driven
		expect(digest.userIntent).toBe("System-driven continuation");

		// Only the grep tool should be captured
		expect(digest.toolEvidence.length).toBeGreaterThanOrEqual(1);
		expect(digest.toolEvidence[0].tool).toBe("grep");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Source span computation (extracted pure helper from agent-session.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("computeTurnSourceSpan", () => {
	const branch = [
		{ id: "e0", type: "message" },
		{ id: "e1", type: "message" },
		{ id: "e2", type: "toolResult" },
		{ id: "e3", type: "message" },
		{ id: "e4", type: "custom_message" },
		{ id: "e5", type: "message" },
	];

	test("returns correct range from preTurnLeafId to current leaf", () => {
		const span = computeTurnSourceSpan(branch, "e1", "e5");
		expect(span).toEqual({ fromEntryId: "e2", toEntryId: "e5" });
	});

	test("returns null when currentLeafId is null", () => {
		expect(computeTurnSourceSpan(branch, "e0", null)).toBeNull();
	});

	test("falls back to branch start when preTurnLeafId is null", () => {
		const span = computeTurnSourceSpan(branch, null, "e3");
		expect(span).toEqual({ fromEntryId: "e0", toEntryId: "e3" });
	});

	test("returns null on empty branch", () => {
		expect(computeTurnSourceSpan([], null, "e1")).toBeNull();
	});

	test("preTurnLeafId at end of branch uses its id as fromEntryId", () => {
		const span = computeTurnSourceSpan(branch, "e5", "e5");
		expect(span).toEqual({ fromEntryId: "e5", toEntryId: "e5" });
	});
});

describe("skipContextPacketPreludeInDigestSource", () => {
	test("starts digest at user after ContextPacket prelude even when other prelude messages come first", () => {
		const branch = asE([
			customMsgEntry("eager", "eager-task-prelude", "delegate reminder"),
			customMsgEntry("packet", CONTEXT_PACKET_MESSAGE_TYPE, "<san_context_packet>"),
			msgEntry("user", "user", "Continue with tests"),
			msgEntry("assistant", "assistant", "Done"),
		]);

		expect(skipContextPacketPreludeInDigestSource(branch, "eager", "assistant")).toBe("user");
	});

	test("leaves agent-only continuations digestible when no ContextPacket was injected", () => {
		const branch = asE([
			customMsgEntry("continuation", "session-stop-continuation", "keep working"),
			msgEntry("assistant", "assistant", "Done"),
		]);

		expect(skipContextPacketPreludeInDigestSource(branch, "continuation", "assistant")).toBe("continuation");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Message extraction from branch (source span — both message and custom_message)
// ═══════════════════════════════════════════════════════════════════════════

describe("extractSpanMessages", () => {
	test("extracts message and custom_message entries within range", () => {
		const branch = [
			{
				id: "e0",
				type: "message",
				message: { role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			},
			{
				id: "e1",
				type: "message",
				message: { role: "assistant", content: "hello", timestamp: 2, provider: "x", model: "x" },
			},
			{ id: "e2", type: "toolResult" },
			// CustomMessageEntry: NO .message field, uses top-level content/customType
			{
				id: "e3",
				type: "custom_message",
				customType: "session-stop-continuation",
				content: "continue please",
				display: false,
				attribution: "agent",
			},
			{
				id: "e4",
				type: "message",
				message: { role: "user", content: "hi2", timestamp: 3, provider: "x", model: "x" },
			},
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e1", "e4");
		// e1 (message/assistant), e3 (custom_message → shim), e4 (message/user)
		expect(msgs).toHaveLength(3);
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: "hello",
			timestamp: 2,
			provider: "x",
			model: "x",
			entryId: "e1",
		});
		expect(msgs[1]).toMatchObject({
			role: "custom",
			content: "continue please",
			customType: "session-stop-continuation",
			entryId: "e3",
		});
		expect(msgs[2]).toMatchObject({ role: "user", content: "hi2", entryId: "e4" });
	});

	test("custom_message without .message uses top-level content", () => {
		const branch = [
			{
				id: "e0",
				type: "message",
				message: { role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			},
			// CustomMessageEntry with NO .message field — uses entry.content instead
			{
				id: "e1",
				type: "custom_message",
				customType: "my-prompt",
				content: "agent do this",
				display: true,
				attribution: "user",
			},
			{
				id: "e2",
				type: "message",
				message: { role: "assistant", content: "ok", timestamp: 3, provider: "x", model: "x" },
			},
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e0", "e2");
		expect(msgs).toHaveLength(3);
		expect(msgs[1]).toMatchObject({ role: "custom", content: "agent do this", customType: "my-prompt" });
	});

	test("custom_message with array content is joined", () => {
		const branch = [
			{
				id: "e0",
				type: "custom_message",
				customType: "test",
				content: [
					{ type: "text", text: "multi" },
					{ type: "text", text: "part" },
				],
				display: false,
			},
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e0", "e0");
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ role: "custom", content: "multi part" });
	});

	test("only message and custom_message types are included", () => {
		const branch = [
			{
				id: "e0",
				type: "message",
				message: { role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			},
			{ id: "e1", type: "custom", data: "some-data" },
			{ id: "e2", type: "custom_message", customType: "test", content: "hello", display: false },
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e0", "e2");
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toMatchObject({ role: "user" });
		expect(msgs[1]).toMatchObject({ role: "custom", content: "hello" });
	});

	test("stops at toEntryId", () => {
		const branch = [
			{
				id: "e0",
				type: "message",
				message: { role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			},
			{
				id: "e1",
				type: "message",
				message: { role: "assistant", content: "hello", timestamp: 2, provider: "x", model: "x" },
			},
			{
				id: "e2",
				type: "message",
				message: { role: "user", content: "beyond", timestamp: 3, provider: "x", model: "x" },
			},
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e0", "e1");
		expect(msgs).toHaveLength(2);
		expect(msgs).toEqual([
			{ role: "user", content: "hi", timestamp: 1, provider: "x", model: "x", entryId: "e0" },
			{ role: "assistant", content: "hello", timestamp: 2, provider: "x", model: "x", entryId: "e1" },
		]);
	});

	test("returns empty when fromEntryId is not found", () => {
		const branch = [
			{
				id: "e0",
				type: "message",
				message: { role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			},
		];
		const msgs = extractSpanMessages(branch as Parameters<typeof extractSpanMessages>[0], "e99", "e0");
		expect(msgs).toEqual([]);
	});
});
