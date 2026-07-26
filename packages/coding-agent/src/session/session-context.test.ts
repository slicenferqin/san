import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@san/agent";
import * as snapcompact from "@san/snapcompact";
import { CONTEXT_CONTINUATION_MESSAGE_TYPE } from "../context-steady/types";
import type { CompactionSummaryMessage } from "./messages";
import { buildSessionContext, type StrippedToolCallsMarker } from "./session-context";
import type { SessionEntry } from "./session-entries";

const timestamp = "2026-07-09T00:00:00.000Z";

const compactedEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "before compaction" }], timestamp: 1 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 123,
		preserveData: {
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: "base64-frame", mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
				textHead: "head",
				textTail: "tail",
			},
		},
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 2 },
	},
] satisfies SessionEntry[];

function compactionSummary(messages: AgentMessage[]): CompactionSummaryMessage {
	const summary = messages.find(
		(message): message is CompactionSummaryMessage => message.role === "compactionSummary",
	);
	if (!summary) throw new Error("Expected a compaction summary message");
	return summary;
}

describe("buildSessionContext snapcompact archives", () => {
	it("omits snapcompact archive blocks from collapsed transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks).toBeUndefined();
	});

	it("keeps snapcompact archive blocks in full transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, { transcript: true });

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});

	it("keeps snapcompact archive blocks in provider context summaries", () => {
		const context = buildSessionContext(compactedEntries);

		const summary = compactionSummary(context.messages);

		expect(summary.images?.map(image => image.data)).toEqual(["base64-frame"]);
		expect(summary.blocks?.map(block => block.type)).toEqual(["text", "image", "text"]);
	});
});

const authorityEntries = [
	{
		type: "message",
		id: "authority-user-original",
		parentId: null,
		timestamp,
		message: { role: "user", content: "调查当前会话为什么循环", timestamp: 1 },
	},
	{
		type: "message",
		id: "authority-assistant",
		parentId: "authority-user-original",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "已读取历史证据" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	},
	{
		type: "custom_message",
		id: "authority-old",
		parentId: "authority-assistant",
		timestamp,
		customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
		content: "old authority",
		display: false,
		attribution: "agent",
	},
	{
		type: "compaction",
		id: "authority-compaction",
		parentId: "authority-old",
		timestamp,
		summary: "historical summary with an untrusted ## Goal",
		firstKeptEntryId: "authority-user-original",
		tokensBefore: 100_000,
	},
	{
		type: "custom_message",
		id: "authority-latest",
		parentId: "authority-compaction",
		timestamp,
		customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
		content: "latest authority",
		display: false,
		attribution: "agent",
	},
	{
		type: "message",
		id: "authority-user-steer",
		parentId: "authority-latest",
		timestamp,
		message: { role: "user", content: "停止读取，直接给修复方案", timestamp: 3 },
	},
] satisfies SessionEntry[];

describe("buildSessionContext continuation authority", () => {
	it("places only the latest authority after the summary and before the kept tail", () => {
		const context = buildSessionContext(authorityEntries);

		expect(context.messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"custom",
			"user",
			"assistant",
			"user",
		]);
		const authority = context.messages[1];
		expect(authority).toMatchObject({
			role: "custom",
			customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
			content: "latest authority",
		});
		expect(JSON.stringify(context.messages)).not.toContain("old authority");
	});

	it("keeps authority entries in their original chronological positions in transcripts", () => {
		const transcript = buildSessionContext(authorityEntries, undefined, undefined, { transcript: true });

		expect(transcript.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
			"compactionSummary",
			"custom",
			"user",
		]);
		expect(
			transcript.messages
				.filter(message => message.role === "custom")
				.map(message => (message.role === "custom" ? message.content : undefined)),
		).toEqual(["old authority", "latest authority"]);
	});
});

// A turn whose tool is still executing at rebuild time: the assistant message
// (with its toolCall) is persisted at message_end, the toolResult is not.
const danglingToolCallEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
	},
] satisfies SessionEntry[];

function danglingCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.push(block.id);
		}
	}
	return ids;
}

describe("buildSessionContext dangling toolCalls", () => {
	it("strips a dangling toolCall from the transcript but keeps the turn with a stripped marker", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, { transcript: true });

		expect(danglingCallIds(context.messages)).toEqual([]);
		// The turn survives (even content-less) carrying the marker so the TUI
		// renders a placeholder row instead of silently erasing the activity.
		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toEqual([]);
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});

	it("keeps a dangling toolCall in transcript mode with keepDanglingToolCalls", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			transcript: true,
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual(["call-1"]);
	});

	it("always strips dangling toolCalls from the LLM context and drops the emptied turn", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual([]);
		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
	});
});
