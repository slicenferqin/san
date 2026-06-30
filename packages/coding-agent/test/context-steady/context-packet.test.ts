/**
 * Context Steady State M2 — ContextPacket contract tests.
 */

import { describe, expect, test } from "bun:test";
import { buildContextPacket, collectDigestRefs } from "../../src/context-steady/packet";
import type { TurnDigest } from "../../src/context-steady/types";
import {
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
			{ enabled: true, recentDigests: 2, maxTokens: 2000 },
		);

		expect(built).not.toBeNull();
		expect(built!.packet.schemaVersion).toBe(CONTEXT_PACKET_SCHEMA_VERSION);
		expect(built!.packet.injectedMessageCustomType).toBe(CONTEXT_PACKET_MESSAGE_TYPE);
		expect(built!.packet.digestRefs).toEqual(["d2", "d3"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "recent_limit",
			omitted: 1,
		});
		expect(built!.content).toContain("second task");
		expect(built!.content).toContain("third task");
		expect(built!.content).not.toContain("first task");
	});

	test("returns null when disabled or no digests exist", () => {
		expect(
			buildContextPacket(asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first"))]), "s1", "p", {
				enabled: false,
				recentDigests: 3,
				maxTokens: 2000,
			}),
		).toBeNull();
		expect(
			buildContextPacket(asEntries([]), "s1", "p", { enabled: true, recentDigests: 3, maxTokens: 2000 }),
		).toBeNull();
	});
});
