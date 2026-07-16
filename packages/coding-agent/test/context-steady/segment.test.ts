import { describe, expect, test } from "bun:test";
import { buildContextSegment, buildContextSegmentDigestInput } from "../../src/context-steady/segment";
import { CONTEXT_SEGMENT_CUSTOM_TYPE, type ContextSegment } from "../../src/context-steady/types";
import type { SessionEntry } from "../../src/session/session-entries";

function base(id: string, parentId: string | null) {
	return { id, parentId, timestamp: "2026-07-16T00:00:00.000Z" };
}

function userEntry(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		...base(id, parentId),
		type: "message",
		message: { role: "user", content, timestamp: 1 },
	};
}

function assistantEntry(id: string, parentId: string, content: string): SessionEntry {
	return {
		...base(id, parentId),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function segmentEntry(id: string, parentId: string, segment: ContextSegment): SessionEntry {
	return {
		...base(id, parentId),
		type: "custom",
		customType: CONTEXT_SEGMENT_CUSTOM_TYPE,
		data: segment,
	};
}

function buildSegment(entries: readonly SessionEntry[], firstKeptEntryId: string, maintenanceId: string) {
	return buildContextSegment({
		entries,
		sessionId: "session-segment",
		firstKeptEntryId,
		promptGeneration: 1,
		maintenanceId,
		reason: "threshold",
		phase: "mid_turn",
		authority: "context-full",
		summary: `recursive summary ${maintenanceId}`,
		tokensBefore: 280_000,
	});
}

describe("ContextSegment", () => {
	test("records a maintenance boundary without introducing an execution budget", () => {
		const entries = [
			userEntry("user-1", null, "完成一项持续数小时的任务"),
			assistantEntry("assistant-1", "user-1", "完成第一批操作"),
			assistantEntry("assistant-kept", "assistant-1", "继续执行后续操作"),
		];
		const segment = buildSegment(entries, "assistant-kept", "maintenance-1");

		expect(segment).toBeDefined();
		expect(segment?.logicalTurnId).toBe("user-1");
		expect(segment?.source).toMatchObject({
			fromEntryId: "user-1",
			toEntryId: "assistant-1",
			firstKeptEntryId: "assistant-kept",
		});
		expect(segment?.checkpoint.userIntent).toContain("持续数小时");
		expect("budget" in (segment as unknown as Record<string, unknown>)).toBe(false);
		expect("maxSteps" in (segment as unknown as Record<string, unknown>)).toBe(false);
	});

	test("starts the next segment after the previous covered range", () => {
		const initial = [
			userEntry("user-1", null, "继续同一个长任务"),
			assistantEntry("assistant-1", "user-1", "第一段"),
			assistantEntry("assistant-2", "assistant-1", "第二段"),
			assistantEntry("assistant-3", "assistant-2", "第三段"),
		];
		const first = buildSegment(initial, "assistant-2", "maintenance-1");
		if (!first) throw new Error("Expected first segment");
		const entries = [...initial.slice(0, 3), segmentEntry("segment-entry-1", "assistant-2", first), initial[3]!];
		const second = buildSegment(entries, "assistant-3", "maintenance-2");

		expect(second?.logicalTurnId).toBe("user-1");
		expect(second?.source.fromEntryId).toBe("assistant-2");
		expect(second?.source.toEntryId).toBe("segment-entry-1");
		expect(second?.source.fromEntryId).not.toBe(first.source.fromEntryId);
	});

	test("bounds a 500-call logical turn by the latest recursive segment frontier", () => {
		const entries: SessionEntry[] = [userEntry("user-1", null, "执行长时间工具任务")];
		let parentId = "user-1";
		for (let index = 1; index <= 500; index++) {
			const id = `assistant-${index}`;
			entries.push(assistantEntry(id, parentId, `${"tool evidence ".repeat(80)}CALL_${index}`));
			parentId = id;
		}
		const segment = buildSegment(entries, "assistant-451", "maintenance-stress");
		if (!segment) throw new Error("Expected stress segment");
		entries.splice(451, 0, segmentEntry("segment-entry", "assistant-450", segment));

		const input = buildContextSegmentDigestInput(entries, "user-1", "assistant-500", 6_000);
		const serialized = JSON.stringify(input.messages);

		expect(input.segmentEntryId).toBe("segment-entry");
		expect(input.estimatedTokens).toBeLessThanOrEqual(6_000);
		expect(input.trimmedMessages).toBeGreaterThan(400);
		expect(serialized).toContain("recursive summary maintenance-stress");
		expect(serialized).toContain("CALL_500");
		expect(serialized).not.toContain('CALL_1"');
	});
});
