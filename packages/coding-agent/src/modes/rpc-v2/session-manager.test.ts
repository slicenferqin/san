/**
 * Contract: a successful todo tool run mirrors its committed `details.phases`
 * onto the wire as `todo.changed`. The projection must be lenient — a
 * malformed tool result drops invalid entries rather than throwing inside
 * event handling — and an empty phases array is a valid "cleared" signal.
 */
import { describe, expect, it } from "bun:test";
import type { SessionEvent } from "./dto/events";
import type { EventId, MessageId, SessionId, ToolCallId } from "./protocol/ids";
import { extractTodoPhases, getEventCoalesceKey } from "./session-manager";

describe("extractTodoPhases", () => {
	it("projects well-formed phases with task statuses", () => {
		const result = {
			content: [{ type: "text", text: "ok" }],
			details: {
				phases: [
					{
						name: "构建",
						tasks: [
							{ content: "写代码", status: "completed" },
							{ content: "跑测试", status: "in_progress" },
						],
					},
				],
			},
		};
		expect(extractTodoPhases(result)).toEqual([
			{
				name: "构建",
				tasks: [
					{ content: "写代码", status: "completed" },
					{ content: "跑测试", status: "in_progress" },
				],
			},
		]);
	});

	it("treats an empty phases array as a cleared checklist", () => {
		expect(extractTodoPhases({ details: { phases: [] } })).toEqual([]);
	});

	it("returns undefined when the result carries no phases array", () => {
		expect(extractTodoPhases(undefined)).toBeUndefined();
		expect(extractTodoPhases({ details: {} })).toBeUndefined();
		expect(extractTodoPhases({ details: { phases: "not-an-array" } })).toBeUndefined();
	});

	it("drops malformed entries and defaults missing or invalid statuses instead of throwing", () => {
		const result = {
			details: {
				phases: [
					"garbage",
					{ name: 42, tasks: [] },
					{
						name: "ok",
						tasks: [
							null,
							{ content: "缺省" },
							{ content: "无效", status: "teleported" },
							{ content: 7, status: "completed" },
						],
					},
				],
			},
		};
		expect(extractTodoPhases(result)).toEqual([
			{
				name: "ok",
				tasks: [
					{ content: "缺省", status: "pending" },
					{ content: "无效", status: "pending" },
				],
			},
		]);
	});
});

describe("getEventCoalesceKey", () => {
	const baseEvent = {
		schemaVersion: 1,
		eventId: "evt-1" as EventId,
		sessionId: "session-1" as SessionId,
		sequence: 1,
		timestamp: "2026-07-26T00:00:00.000Z",
		durability: "transient",
	} as const;

	it("keeps visible and thinking message streams independent", () => {
		const visible = {
			...baseEvent,
			type: "message.delta",
			data: { messageId: "message-1" as MessageId, delta: "answer" },
		} satisfies SessionEvent;
		const thinking = {
			...visible,
			data: { ...visible.data, channel: "thinking" },
		} satisfies SessionEvent;

		expect(getEventCoalesceKey(visible)).toBe("message.delta:::");
		expect(getEventCoalesceKey(thinking)).toBe("message.delta:::thinking");
	});

	it("keeps concurrent tool progress streams independent", () => {
		const progress = (toolCallId: string) =>
			({
				...baseEvent,
				type: "tool.progress",
				data: { toolCallId: toolCallId as ToolCallId, toolName: "bash" },
			}) satisfies SessionEvent;

		expect(getEventCoalesceKey(progress("tool-1"))).toBe("tool.progress:::tool-1");
		expect(getEventCoalesceKey(progress("tool-2"))).toBe("tool.progress:::tool-2");
	});
});
