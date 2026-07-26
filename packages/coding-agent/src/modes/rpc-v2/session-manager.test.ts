/**
 * Contract: a successful todo tool run mirrors its committed `details.phases`
 * onto the wire as `todo.changed`. The projection must be lenient — a
 * malformed tool result drops invalid entries rather than throwing inside
 * event handling — and an empty phases array is a valid "cleared" signal.
 */
import { describe, expect, it } from "bun:test";
import { extractTodoPhases } from "./session-manager";

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
