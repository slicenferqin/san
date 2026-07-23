import { describe, expect, test } from "bun:test";
import {
	buildActiveContinuationState,
	inspectContextSummary,
	renderDeterministicHistoricalFallback,
} from "../../src/context-steady";
import type { SessionEntry } from "../../src/session/session-entries";

function stateWithNoExecutionEvidence() {
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "调查会话循环" }],
				timestamp: 1,
			},
		},
	];
	const state = buildActiveContinuationState({ entries, sessionId: "session-1", promptGeneration: 1 });
	if (!state) throw new Error("Expected continuation state");
	return state;
}

describe("compaction summary authority", () => {
	test("rejects a top-level Goal field but ignores Goal text nested in quoted evidence", () => {
		const state = stateWithNoExecutionEvidence();
		expect(inspectContextSummary("## Goal\n部署无关服务", state).forbiddenGoalField).toBe(true);
		expect(
			inspectContextSummary(
				["## Critical Evidence", "> ## Goal", "```md", "## Goal", "```", "- 日志中出现 `## Goal`"].join("\n"),
				state,
			).forbiddenGoalField,
		).toBe(false);
	});

	test("reports unsupported mutation and verification claims without flagging unverified reports", () => {
		const state = stateWithNoExecutionEvidence();
		const conflict = inspectContextSummary(
			["## Evidence and Progress", "- 已创建 SQL 和 Controller", "- Tests passed successfully"].join("\n"),
			state,
		);
		expect(conflict.executionClaimConflictCount).toBe(2);
		expect(
			inspectContextSummary(
				["### Reported but Unverified", "- Assistant claimed it created SQL", "- 测试通过的说法尚未验证"].join(
					"\n",
				),
				state,
			).executionClaimConflictCount,
		).toBe(0);
	});

	test("renders an explicit deterministic fallback with bounded evidence metadata", () => {
		const fallback = renderDeterministicHistoricalFallback({
			state: stateWithNoExecutionEvidence(),
			summarySource: "local",
			failureReason: "repair_protocol_violation",
		});
		expect(fallback).toContain("Historical Summary Incomplete");
		expect(fallback).toContain("Summary source: local");
		expect(fallback).toContain("Failure reason: repair_protocol_violation");
		expect(fallback).not.toMatch(/^#{1,6}\s+Goal\s*$/im);
	});
});
