/**
 * Context Steady State — provider-bound prune contract tests.
 */

import { describe, expect, test } from "bun:test";
import { buildContextSteadyPrunedMessages } from "../../src/context-steady/prune";
import {
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	type ContextPacket,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "../../src/context-steady/types";

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

function customMessageEntry(
	id: string,
	customType: string,
	content: string,
	timestamp: string,
): Record<string, unknown> {
	return { type: "custom_message", id, parentId: null, timestamp, customType, content, display: false };
}

function digest(source: TurnDigest["source"], toolEvidence: TurnDigest["toolEvidence"] = []): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: "turn-1",
		sessionId: "s1",
		createdAt: new Date().toISOString(),
		source,
		userIntent: "Inspect old context",
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence,
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [],
		fallback: true,
	};
}

function packet(digestRefs: string[]): ContextPacket {
	return {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: "ctx-test",
		sessionId: "s1",
		createdAt: new Date().toISOString(),
		currentPromptPreview: "continue",
		layers: [],
		digestRefs,
		recallRefs: [],
		tokenEstimate: 1,
		tokenBudget: 1000,
		budget: {
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 1000,
			configuredPacketMaxTokens: 1000,
		},
		trimDecisions: [],
		injectedMessageCustomType: CONTEXT_PACKET_MESSAGE_TYPE,
	};
}

const asMessages = (messages: Record<string, unknown>[]) =>
	messages as unknown as Parameters<typeof buildContextSteadyPrunedMessages>[0];
const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextSteadyPrunedMessages>[1];

describe("buildContextSteadyPrunedMessages", () => {
	test("preserves non-packet custom messages inside a covered digest span", () => {
		const reminderTimestamp = new Date("2026-07-02T00:00:00.000Z").getTime();
		const reminderEntryTimestamp = new Date(reminderTimestamp).toISOString();
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const reminder = {
			role: "custom",
			customType: "workflow-notice",
			content: "non-digested custom context",
			display: false,
			timestamp: reminderTimestamp,
		};
		const oldAssistant = { role: "assistant", content: "old raw assistant", timestamp: 2, provider: "x", model: "x" };
		const packetMessage = {
			role: "custom",
			customType: CONTEXT_PACKET_MESSAGE_TYPE,
			content: "<san_context_packet>",
			display: false,
			timestamp: 3,
			details: { packetId: "ctx-test" },
		};
		const currentUser = { role: "user", content: "continue", timestamp: 4, provider: "x", model: "x" };

		const pruned = buildContextSteadyPrunedMessages(
			asMessages([oldUser, reminder, oldAssistant, packetMessage, currentUser]),
			asEntries([
				messageEntry("u1", oldUser),
				customMessageEntry("c1", "workflow-notice", "non-digested custom context", reminderEntryTimestamp),
				messageEntry("a1", oldAssistant),
				customEntry(
					"d1",
					TURN_DIGEST_CUSTOM_TYPE,
					digest({ sessionId: "s1", fromEntryId: "u1", toEntryId: "a1", promptGeneration: 1 }),
				),
				customEntry("p1", CONTEXT_PACKET_CUSTOM_TYPE, packet(["d1"])),
				customMessageEntry("pm1", CONTEXT_PACKET_MESSAGE_TYPE, "<san_context_packet>", new Date(3).toISOString()),
				messageEntry("u2", currentUser),
			]),
		);

		expect(JSON.stringify(pruned)).not.toContain("old raw user");
		expect(JSON.stringify(pruned)).not.toContain("old raw assistant");
		expect(JSON.stringify(pruned)).toContain("non-digested custom context");
		expect(JSON.stringify(pruned)).toContain("<san_context_packet>");
		expect(JSON.stringify(pruned)).toContain("continue");
	});

	test("prunes explicit tool evidence messages even when digest source span cannot be resolved", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const toolResult = {
			role: "toolResult",
			toolName: "read",
			content: "large tool evidence",
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const packetMessage = {
			role: "custom",
			customType: CONTEXT_PACKET_MESSAGE_TYPE,
			content: "<san_context_packet>",
			display: false,
			timestamp: 3,
			details: { packetId: "ctx-test" },
		};

		const pruned = buildContextSteadyPrunedMessages(
			asMessages([oldUser, toolResult, packetMessage]),
			asEntries([
				messageEntry("u1", oldUser),
				messageEntry("tool1", toolResult),
				customEntry(
					"d1",
					TURN_DIGEST_CUSTOM_TYPE,
					digest({ sessionId: "s1", fromEntryId: "missing-from", toEntryId: "missing-to", promptGeneration: 1 }, [
						{ tool: "read", summary: "read: completed", entryIds: ["tool1"] },
					]),
				),
				customEntry("p1", CONTEXT_PACKET_CUSTOM_TYPE, packet(["d1"])),
			]),
		);

		expect(JSON.stringify(pruned)).toContain("old raw user");
		expect(JSON.stringify(pruned)).not.toContain("large tool evidence");
		expect(JSON.stringify(pruned)).toContain("<san_context_packet>");
	});

	test("does not prune a reversed digest source span", () => {
		const oldUser = { role: "user", content: "old raw user", timestamp: 1, provider: "x", model: "x" };
		const oldAssistant = { role: "assistant", content: "old raw assistant", timestamp: 2, provider: "x", model: "x" };
		const packetMessage = {
			role: "custom",
			customType: CONTEXT_PACKET_MESSAGE_TYPE,
			content: "<san_context_packet>",
			display: false,
			timestamp: 3,
			details: { packetId: "ctx-test" },
		};

		const pruned = buildContextSteadyPrunedMessages(
			asMessages([oldUser, oldAssistant, packetMessage]),
			asEntries([
				messageEntry("u1", oldUser),
				messageEntry("a1", oldAssistant),
				customEntry(
					"d1",
					TURN_DIGEST_CUSTOM_TYPE,
					digest({ sessionId: "s1", fromEntryId: "a1", toEntryId: "u1", promptGeneration: 1 }),
				),
				customEntry("p1", CONTEXT_PACKET_CUSTOM_TYPE, packet(["d1"])),
			]),
		);

		expect(JSON.stringify(pruned)).toContain("old raw user");
		expect(JSON.stringify(pruned)).toContain("old raw assistant");
		expect(JSON.stringify(pruned)).toContain("<san_context_packet>");
	});
});
