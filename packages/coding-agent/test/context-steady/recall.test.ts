import { describe, expect, test } from "bun:test";
import { buildContextSteadyRecallQuery, normalizeContextSteadyRecallItems } from "../../src/context-steady/recall";
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

describe("Context steady recall quality helpers", () => {
	test("builds recall query from current prompt plus recent digest context", () => {
		const query = buildContextSteadyRecallQuery(
			[
				digestEntry("d1", digest("t1", "implement M6 debug view")),
				digestEntry("d2", digest("t2", "write M7 dogfood verifier")),
				digestEntry("d3", digest("t3", "settle M8 recommended config")),
			],
			"Improve recall quality",
			{ recentDigests: 2, maxQueryChars: 2000 },
		);

		expect(query).toContain("Recent San turn digests:");
		expect(query).toContain("d2: write M7 dogfood verifier");
		expect(query).toContain("d3: settle M8 recommended config");
		expect(query).not.toContain("d1: implement M6 debug view");
		expect(query).toContain("Current prompt:");
		expect(query).toContain("Improve recall quality");
	});

	test("preserves the current prompt when digest context exceeds the query budget", () => {
		const query = buildContextSteadyRecallQuery(
			[digestEntry("d1", digest("t1", "x".repeat(1000)))],
			"Recall the current task",
			{ recentDigests: 1, maxQueryChars: 24 },
		);

		expect(query).toBe("Recall the current task");
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
});
