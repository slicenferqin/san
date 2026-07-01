/**
 * Context Steady State M2 — ContextPacket contract tests.
 */

import { describe, expect, test } from "bun:test";
import { buildContextCheckpoint } from "../../src/context-steady/checkpoint";
import { buildContextPacket, collectDigestRefs } from "../../src/context-steady/packet";
import type { ContextPacketSettings, TurnDigest } from "../../src/context-steady/types";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
} from "../../src/context-steady/types";

function digest(turnId: string, userIntent: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: new Date().toISOString(),
		source: { sessionId: "s1", fromEntryId: `${turnId}-from`, toEntryId: `${turnId}-to`, promptGeneration: 1 },
		userIntent,
		actionsTaken: [`acted on ${userIntent}`],
		decisions: [`decided ${turnId}`],
		filesTouched: [{ path: `src/${turnId}.ts`, action: "modified" }],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [`continue ${turnId}`],
		memoryCandidates: [],
		fallback: true,
	};
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextPacket>[0];

function packetSettings(overrides: Partial<ContextPacketSettings> = {}): ContextPacketSettings {
	return {
		enabled: true,
		recentDigests: 3,
		maxTokens: 2000,
		qualityWindowTokens: 0,
		reserveRatio: 0.2,
		...overrides,
	};
}

describe("ContextPacket builder", () => {
	test("collects only TurnDigest custom entries", () => {
		const refs = collectDigestRefs(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first")),
				customEntry("x1", "other", { schemaVersion: 1, turnId: "not-a-digest", source: {} }),
				{ type: "custom_message", id: "m1", parentId: null, timestamp: new Date().toISOString() },
			]),
		);

		expect(refs.map(ref => ref.entryId)).toEqual(["d1"]);
	});

	test("builds a packet from recent digests with debug metadata", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ recentDigests: 2 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.schemaVersion).toBe(CONTEXT_PACKET_SCHEMA_VERSION);
		expect(built!.packet.injectedMessageCustomType).toBe(CONTEXT_PACKET_MESSAGE_TYPE);
		expect(built!.packet.digestRefs).toEqual(["d2", "d3"]);
		expect(built!.packet.tokenEstimate).toBeGreaterThan(0);
		expect(built!.packet.layers[0]!.tokenBudget).toBe(2000);
		expect(built!.packet.layers[0]!.stability).toBe("append-only");
		expect(built!.packet.layers[0]!.cachePriority).toBe("medium");
		expect(built!.packet.budget).toMatchObject({
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 2000,
			configuredPacketMaxTokens: 2000,
		});
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "recent_limit",
			omitted: 1,
		});
		expect(built!.content).toContain("second task");
		expect(built!.content).toContain("third task");
		expect(built!.content).not.toContain("first task");
	});

	test("places retrieved context after digest ledger as a volatile low-cache layer", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ recentDigests: 1 }),
			{
				query: "current prompt",
				tokenBudget: 500,
				items: [
					{
						id: "mem-1",
						content: "User prefers compact implementation reports",
						source: "mnemopi",
						timestamp: "2026-06-30T00:00:00.000Z",
						score: 0.91,
					},
				],
			},
		);

		expect(built).not.toBeNull();
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger", "retrieved_context"]);
		expect(built!.packet.layers[1]).toMatchObject({
			entryRefs: ["mem-1"],
			stability: "volatile",
			cachePriority: "low",
			tokenBudget: 500,
		});
		expect(built!.packet.recallQuery).toBe("current prompt");
		expect(built!.packet.recallRefs).toEqual(["mem-1"]);
		expect(built!.packet.tokenBudget).toBe(2500);
		expect(built!.content.indexOf("Recent turn digests")).toBeLessThan(built!.content.indexOf("Retrieved context"));
		expect(built!.content).toContain("Treat retrieved context as read-only background memory");
	});

	test("builds a recall-only packet for first-turn retrieved context", () => {
		const built = buildContextPacket(asEntries([]), "s1", "current prompt", packetSettings(), {
			query: "current prompt",
			tokenBudget: 500,
			items: [{ content: "Project decision: keep San docs in HTML", source: "mnemopi" }],
		});

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs).toEqual([]);
		expect(built!.packet.recallRefs).toEqual(["recall:1"]);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger", "retrieved_context"]);
		expect(built!.content).toContain("Recent turn digests: none");
		expect(built!.content).toContain("Project decision: keep San docs in HTML");
	});

	test("trims retrieved context against its own volatile token budget", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"current prompt",
			packetSettings(),
			{
				query: "current prompt",
				tokenBudget: 1,
				items: [
					{
						id: "mem-1",
						content: "A recalled project decision that cannot fit the volatile recall budget",
						source: "mnemopi",
					},
				],
			},
		);

		expect(built).not.toBeNull();
		expect(built!.packet.recallRefs).toEqual([]);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "retrieved_context",
			reason: "token_budget",
			omitted: 1,
		});
		expect(built!.content).not.toContain("Retrieved context");
		expect(built!.content).not.toContain("A recalled project decision");
	});

	test("returns null when disabled or no digests exist", () => {
		expect(
			buildContextPacket(asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first"))]), "s1", "p", {
				...packetSettings(),
				enabled: false,
			}),
		).toBeNull();
		expect(buildContextPacket(asEntries([]), "s1", "p", packetSettings())).toBeNull();
	});

	test("trims old digests when the packet exceeds the token budget", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ maxTokens: 180 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs.length).toBeLessThan(3);
		expect(built!.packet.tokenEstimate).toBeLessThanOrEqual(180);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "token_budget",
			omitted: 1,
		});
	});

	test("derives packet budget from quality window and reserve ratio", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ maxTokens: 2000, qualityWindowTokens: 220, reserveRatio: 0.25 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.tokenBudget).toBe(165);
		expect(built!.packet.budget).toEqual({
			qualityWindowTokens: 220,
			reserveRatio: 0.25,
			reservedTokens: 55,
			packetTokenBudget: 165,
			configuredPacketMaxTokens: 2000,
		});
		expect(built!.packet.layers[0]!.tokenBudget).toBe(165);
		expect(built!.packet.tokenEstimate).toBeLessThanOrEqual(165);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "token_budget",
			omitted: 1,
		});
	});

	test("returns null when the effective packet budget cannot hold any digest", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"current prompt",
			packetSettings({ maxTokens: 2000, qualityWindowTokens: 1, reserveRatio: 0.9 }),
		);

		expect(built).toBeNull();
	});

	test("returns null when the configured packet budget is disabled by zero tokens", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"current prompt",
			packetSettings({ maxTokens: 0, qualityWindowTokens: 0 }),
		);

		expect(built).toBeNull();
	});

	test("keeps maxTokens as a hard packet cap when quality window is configured", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"current prompt",
			packetSettings({ maxTokens: 0, qualityWindowTokens: 220, reserveRatio: 0.25 }),
		);

		expect(built).toBeNull();
	});

	test("builds stable checkpoint entries from uncovered digest ledger prefix", () => {
		const built = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		);

		expect(built).not.toBeNull();
		expect(built!.checkpoint.entryRefs).toEqual(["d1", "d2"]);
		expect(built!.checkpoint.digestCount).toBe(2);
		expect(built!.checkpoint.stability).toBe("stable");
		expect(built!.checkpoint.cachePriority).toBe("high");
		expect(built!.checkpoint.summary.userIntents.map(item => item.text)).toEqual(["first task", "second task"]);
	});

	test("extends stable checkpoint coverage when another digest batch becomes eligible", () => {
		const firstCheckpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const secondCheckpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, firstCheckpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
				customEntry("d4", TURN_DIGEST_CUSTOM_TYPE, digest("t4", "fourth task")),
				customEntry("d5", TURN_DIGEST_CUSTOM_TYPE, digest("t5", "fifth task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, firstCheckpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
				customEntry("d4", TURN_DIGEST_CUSTOM_TYPE, digest("t4", "fourth task")),
				customEntry("ck2", CONTEXT_CHECKPOINT_CUSTOM_TYPE, secondCheckpoint),
				customEntry("d5", TURN_DIGEST_CUSTOM_TYPE, digest("t5", "fifth task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ recentDigests: 5 }),
		);

		expect(secondCheckpoint.entryRefs).toEqual(["d1", "d2", "d3", "d4"]);
		expect(secondCheckpoint.digestCount).toBe(4);
		expect(secondCheckpoint.summary.userIntents.map(item => item.text)).toEqual([
			"first task",
			"second task",
			"third task",
			"fourth task",
		]);
		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck2");
		expect(built!.packet.digestRefs).toEqual(["d5"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: 4,
		});
		expect(built!.content).toContain("first task");
		expect(built!.content).toContain("fourth task");
		expect(built!.content).toContain("fifth task");
	});

	test("places stable checkpoint before append-only digest tail and avoids duplicated covered digests", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"current prompt",
			packetSettings({ recentDigests: 5 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck1");
		expect(built!.packet.tokenBudget).toBe(14000);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["stable_checkpoint", "turn_digest_ledger"]);
		expect(built!.packet.layers[0]).toMatchObject({
			entryRefs: ["ck1"],
			stability: "stable",
			cachePriority: "high",
		});
		expect(built!.packet.layers[1]).toMatchObject({
			entryRefs: ["d3"],
			stability: "append-only",
			cachePriority: "medium",
		});
		expect(built!.packet.digestRefs).toEqual(["d3"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: 2,
		});
		expect(built!.content).toContain("Stable checkpoint");
		expect(built!.content).toContain("first task");
		expect(built!.content).toContain("third task");
	});
});
