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

import { describe, expect, test } from "bun:test";
import { generateFallbackDigest, generateTurnId } from "../../src/context-steady/fallback";
import { normalizeDigest } from "../../src/context-steady/normalize";
import {
	computeTurnSourceSpan,
	extractSpanMessages,
	findExistingDigest,
	hasExistingDigest,
	listTurnDigests,
} from "../../src/context-steady/session";
import type { TurnDigest } from "../../src/context-steady/types";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION } from "../../src/context-steady/types";

// Minimal message shapes to avoid pulling in @oh-my-pi/pi-agent-core
// (which transitively loads @oh-my-pi/pi-natives native modules).
interface Msg {
	role: string;
	content: string | Array<{ type: string; text?: string; id?: string; name?: string; args?: Record<string, unknown> }>;
	timestamp: number;
	provider: string;
	model: string;
	status?: string;
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
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

const asM = (m: Msg[]) => m as unknown as Parameters<typeof generateFallbackDigest>[0];
const asE = (e: Record<string, unknown>[]) => e as unknown as Parameters<typeof listTurnDigests>[0];

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
		expect(msgs[0]).toEqual({ role: "assistant", content: "hello", timestamp: 2, provider: "x", model: "x" });
		expect(msgs[1]).toMatchObject({
			role: "custom",
			content: "continue please",
			customType: "session-stop-continuation",
		});
		expect(msgs[2]).toMatchObject({ role: "user", content: "hi2" });
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
			{ role: "user", content: "hi", timestamp: 1, provider: "x", model: "x" },
			{ role: "assistant", content: "hello", timestamp: 2, provider: "x", model: "x" },
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
