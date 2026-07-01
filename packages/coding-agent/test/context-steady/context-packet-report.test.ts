/**
 * Context Steady State M6 — ContextPacket debug report tests.
 */

import { describe, expect, test } from "bun:test";
import {
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	type ContextPacket,
} from "../../src/context-steady/types";
import type { SessionEntry } from "../../src/session/session-entries";
import {
	buildContextPacketReportText,
	parseContextPacketReportCount,
} from "../../src/slash-commands/helpers/context-packet-report";

function entryBase(id: string) {
	return {
		id,
		parentId: null,
		timestamp: "2026-06-30T00:00:00.000Z",
	};
}

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
	return {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: "ctx_test",
		sessionId: "session-1",
		createdAt: "2026-06-30T00:00:00.000Z",
		currentPromptPreview: "Continue San work",
		layers: [
			{
				name: "stable_checkpoint",
				entryRefs: ["ck1"],
				tokenEstimate: 300,
				tokenBudget: 12000,
				trimmed: 0,
				stability: "stable",
				cachePriority: "high",
			},
			{
				name: "turn_digest_ledger",
				entryRefs: ["d1", "d2"],
				tokenEstimate: 420,
				tokenBudget: 2000,
				trimmed: 1,
				stability: "append-only",
				cachePriority: "medium",
			},
			{
				name: "retrieved_context",
				entryRefs: ["mem-1"],
				tokenEstimate: 120,
				tokenBudget: 500,
				trimmed: 0,
				stability: "volatile",
				cachePriority: "low",
			},
		],
		checkpointRef: "ck1",
		digestRefs: ["d1", "d2"],
		recallQuery: "Continue San work",
		recallRefs: ["mem-1"],
		tokenEstimate: 840,
		tokenBudget: 14500,
		budget: {
			qualityWindowTokens: 24000,
			reserveRatio: 0.2,
			reservedTokens: 4800,
			packetTokenBudget: 2000,
			configuredPacketMaxTokens: 2000,
		},
		trimDecisions: [{ layer: "turn_digest_ledger", reason: "recent_limit", omitted: 1 }],
		injectedMessageCustomType: CONTEXT_PACKET_MESSAGE_TYPE,
		...overrides,
	};
}

function packetEntry(id: string, data: ContextPacket): SessionEntry {
	return {
		...entryBase(id),
		type: "custom",
		customType: CONTEXT_PACKET_CUSTOM_TYPE,
		data,
	};
}

function injectedEntry(id: string, packetId: string): SessionEntry {
	return {
		...entryBase(id),
		type: "custom_message",
		customType: CONTEXT_PACKET_MESSAGE_TYPE,
		content: "<san_context_packet>",
		display: false,
		details: { packetId, digestRefs: ["d1", "d2"] },
		attribution: "agent",
	};
}

describe("ContextPacket debug report", () => {
	test("renders latest packet layers, trim decisions, recall refs, and injected message link", () => {
		const entries = [packetEntry("packet-entry", packet()), injectedEntry("injected-entry", "ctx_test")];

		const report = buildContextPacketReportText(entries);

		expect(report).toContain("San ContextPacket debug view (1/1 shown)");
		expect(report).toContain("## ContextPacket ctx_test");
		expect(report).toContain("Debug entry: packet-entry");
		expect(report).toContain("Injected message: injected-entry");
		expect(report).toContain("Packet tokens: 840/14,500");
		expect(report).toContain("Checkpoint ref: ck1");
		expect(report).toContain("Digest refs: d1, d2");
		expect(report).toContain("Budget:");
		expect(report).toContain("- qualityWindowTokens=24,000");
		expect(report).toContain("- reserveRatio=0.2");
		expect(report).toContain("- packetTokenBudget=2,000");
		expect(report).toContain("Recall query: Continue San work");
		expect(report).toContain("Recall refs: mem-1");
		expect(report).toContain(
			"- stable_checkpoint: 300/12,000 tokens; refs=ck1; trimmed=0; stability=stable; cache=high",
		);
		expect(report).toContain(
			"- turn_digest_ledger: 420/2,000 tokens; refs=d1, d2; trimmed=1; stability=append-only; cache=medium",
		);
		expect(report).toContain(
			"- retrieved_context: 120/500 tokens; refs=mem-1; trimmed=0; stability=volatile; cache=low",
		);
		expect(report).toContain("- turn_digest_ledger: recent_limit, omitted=1");
	});

	test("shows recent packets newest first with bounded count", () => {
		const entries = [
			packetEntry("packet-1", packet({ packetId: "ctx_1", currentPromptPreview: "first" })),
			packetEntry("packet-2", packet({ packetId: "ctx_2", currentPromptPreview: "second" })),
			packetEntry("packet-3", packet({ packetId: "ctx_3", currentPromptPreview: "third" })),
		];

		const report = buildContextPacketReportText(entries, { count: 2 });

		expect(report).toContain("San ContextPacket debug view (2/3 shown)");
		expect(report.indexOf("## ContextPacket ctx_3")).toBeLessThan(report.indexOf("## ContextPacket ctx_2"));
		expect(report).not.toContain("## ContextPacket ctx_1");
	});

	test("reports an empty state when no packets exist", () => {
		expect(buildContextPacketReportText([])).toBe("No San ContextPacket debug entries found.");
	});

	test("parses optional packet report counts", () => {
		expect(parseContextPacketReportCount("")).toBe(1);
		expect(parseContextPacketReportCount("3")).toBe(3);
		expect(parseContextPacketReportCount("0")).toEqual({ error: "Usage: /context packet [1-20]" });
		expect(parseContextPacketReportCount("21")).toEqual({ error: "Usage: /context packet [1-20]" });
		expect(parseContextPacketReportCount("abc")).toEqual({ error: "Usage: /context packet [1-20]" });
	});
});
