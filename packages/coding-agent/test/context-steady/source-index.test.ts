/**
 * ContextPlan source-index contract tests.
 */

import { describe, expect, test } from "bun:test";
import { buildContextSourceIndex, isContextPlanLegacyPacketEntry } from "../../src/context-steady/source-index";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_CHECKPOINT_SCHEMA_VERSION,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	type ContextCheckpoint,
	type ContextPacket,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "../../src/context-steady/types";

function messageEntry(id: string, content: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now(), provider: "x", model: "x" },
	};
}

function assistantToolCallEntry(id: string, toolCallId: string, toolName: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: { filePath: "src/app.ts" } }],
			timestamp: Date.now(),
			provider: "x",
			model: "x",
		},
	};
}

function toolResultEntry(id: string, toolCallId: string, toolName: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: "OK",
			timestamp: Date.now(),
			provider: "x",
			model: "x",
		},
	};
}

function fileMentionEntry(id: string, path: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "fileMention", files: [{ path, content: "file body" }], timestamp: Date.now() },
	};
}

function customMessageEntry(id: string, customType: string): Record<string, unknown> {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		content: "attachment description",
		display: false,
	};
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

function digest(fromEntryId: string, toEntryId: string, toolEntryIds: string[] = [], fallback = false): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: `turn-${fromEntryId}`,
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId, toEntryId, promptGeneration: 1 },
		userIntent: "index source",
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: toolEntryIds.map(entryId => ({ tool: "read", summary: "read evidence", entryIds: [entryId] })),
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [],
		fallback,
	};
}

function checkpoint(entryRefs: string[]): ContextCheckpoint {
	return {
		schemaVersion: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
		checkpointId: "checkpoint-1",
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		entryRefs,
		fromDigestEntryId: entryRefs[0] ?? "d1",
		toDigestEntryId: entryRefs.at(-1) ?? "d1",
		digestCount: entryRefs.length,
		summary: { userIntents: [], decisions: [], filesTouched: [], risks: [], nextSteps: [] },
		tokenEstimate: 10,
		tokenBudget: 100,
		stability: "stable",
		cachePriority: "high",
	};
}

function packet(): ContextPacket {
	return {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: "packet-1",
		sessionId: "s1",
		createdAt: "2026-07-12T00:00:00.000Z",
		currentPromptPreview: "continue",
		layers: [],
		digestRefs: [],
		recallRefs: [],
		tokenEstimate: 1,
		tokenBudget: 10,
		budget: {
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 10,
			configuredPacketMaxTokens: 10,
		},
		trimDecisions: [],
		injectedMessageCustomType: "san.context_packet.injected",
	};
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextSourceIndex>[0];

describe("buildContextSourceIndex", () => {
	test("indexes exact entries, turn bundles, tool pairs, file evidence, and attachments", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "inspect src/app.ts"),
				assistantToolCallEntry("a1", "tc-read", "read"),
				toolResultEntry("tr1", "tc-read", "read"),
				fileMentionEntry("fm1", "src/app.ts"),
				customMessageEntry("img1", "image-attachment-description"),
				messageEntry("u2", "continue"),
			]),
		);

		expect(index.exactEntries.map(entry => entry.entryId)).toEqual(["u1", "a1", "tr1", "fm1", "u2"]);
		expect(index.turnBundles.map(bundle => bundle.entryIds)).toEqual([["u1", "a1", "tr1", "fm1", "img1"], ["u2"]]);
		expect(index.toolPairs).toContainEqual({
			kind: "tool_pair",
			entryIds: ["a1", "tr1"],
			toolCallId: "tc-read",
			toolName: "read",
			assistantEntryId: "a1",
			resultEntryId: "tr1",
			complete: true,
		});
		expect(index.fileEvidence).toEqual([{ kind: "file_evidence", entryId: "fm1", paths: ["src/app.ts"] }]);
		expect(index.attachments).toEqual([
			{ kind: "attachment", entryId: "img1", customType: "image-attachment-description" },
		]);
	});

	test("indexes digest source entry refs from journal span", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "first"),
				messageEntry("a1", "answer"),
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("u1", "a1")),
			]),
		);

		expect(index.digests).toHaveLength(1);
		expect(index.digests[0]?.sourceEntryRefs).toEqual(["u1", "a1"]);
		expect(index.entryIds).toEqual(["u1", "a1", "d1"]);
	});

	test("falls back to explicit tool evidence refs when digest source span is missing", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("tool1", "tool evidence"),
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("missing-from", "missing-to", ["tool1", "missing-tool"])),
			]),
		);

		expect(index.digests[0]?.sourceEntryRefs).toEqual(["tool1"]);
	});

	test("expands checkpoint digest refs to covered source entry refs", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "first"),
				messageEntry("a1", "answer"),
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("u1", "a1")),
				customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint(["d1"])),
			]),
		);

		expect(index.checkpoints).toHaveLength(1);
		expect(index.checkpoints[0]?.coveredDigestEntryRefs).toEqual(["d1"]);
		expect(index.checkpoints[0]?.coveredSourceEntryRefs).toEqual(["u1", "a1"]);
	});

	test("never expands fallback digests into checkpoint coverage authority", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "first"),
				messageEntry("a1", "answer"),
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("u1", "a1", [], true)),
				customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, {
					...checkpoint(["d1"]),
					// Even if a buggy writer listed raw refs, source-index must strip them
					// when the only contributing digest is fallback.
					coveredSourceEntryRefs: ["u1", "a1"],
				}),
			]),
		);

		expect(index.checkpoints[0]?.coveredDigestEntryRefs).toEqual(["d1"]);
		expect(index.checkpoints[0]?.coveredSourceEntryRefs).toEqual([]);
	});

	test("uses the authoritative append-only upgrade for digest and checkpoint coverage", () => {
		const fallback = {
			...digest("u1", "a1", [], true),
			fallbackReason: "model_unresolved" as const,
		};
		const authoritative = {
			...digest("u1", "a1"),
			model: "self/gpt-5.4-mini",
			supersedesEntryId: "d-fallback",
		};
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "first"),
				messageEntry("a1", "answer"),
				customEntry("d-fallback", TURN_DIGEST_CUSTOM_TYPE, fallback),
				customEntry("d-authoritative", TURN_DIGEST_CUSTOM_TYPE, authoritative),
				customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint(["d-authoritative"])),
			]),
		);

		expect(index.digests).toHaveLength(1);
		expect(index.digests[0]).toMatchObject({
			entryId: "d-authoritative",
			digest: { fallback: false, supersedesEntryId: "d-fallback" },
			sourceEntryRefs: ["u1", "a1"],
		});
		expect(index.checkpoints[0]?.coveredDigestEntryRefs).toEqual(["d-authoritative"]);
		expect(index.checkpoints[0]?.coveredSourceEntryRefs).toEqual(["u1", "a1"]);
	});

	test("prefers v2 checkpoint covered source refs over digest span reconstruction", () => {
		const index = buildContextSourceIndex(
			asEntries([
				messageEntry("u1", "first"),
				messageEntry("a1", "answer"),
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("missing-from", "missing-to")),
				customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, {
					...checkpoint(["d1"]),
					coveredSourceEntryRefs: ["u1", "a1"],
					epochId: "epoch_s1",
					rebaseReason: "checkpoint",
				}),
			]),
		);

		expect(index.checkpoints[0]?.coveredDigestEntryRefs).toEqual(["d1"]);
		expect(index.checkpoints[0]?.coveredSourceEntryRefs).toEqual(["u1", "a1"]);
	});
});

describe("isContextPlanLegacyPacketEntry", () => {
	test("classifies legacy packets separately from checkpoints", () => {
		expect(isContextPlanLegacyPacketEntry(customEntry("p1", CONTEXT_PACKET_CUSTOM_TYPE, packet()) as never)).toBe(
			true,
		);
		expect(
			isContextPlanLegacyPacketEntry(customEntry("cp1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint([])) as never),
		).toBe(false);
	});
});
