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

	test("rejects execution claims whose identifiable path or command is absent from evidence", () => {
		const state = stateWithNoExecutionEvidence();
		state.executionEvidence.successfulMutations.push({
			tool: "write",
			toolCallId: "write-1",
			resultEntryId: "result-write-1",
			path: "/workspace/src/a.ts",
		});
		state.executionEvidence.successfulVerifications.push({
			tool: "bash",
			toolCallId: "bash-1",
			resultEntryId: "result-bash-1",
			command: "bun test a",
		});

		const mismatch = inspectContextSummary(["- fixed src/b.ts", "- bun test b passed"].join("\n"), state);
		const match = inspectContextSummary(["- fixed src/a.ts", "- bun test a passed"].join("\n"), state);
		const partialPathMatch = inspectContextSummary("- fixed src/a.ts and src/b.ts", state);
		const commandPrefixMismatch = inspectContextSummary("- bun test all passed", state);

		expect(mismatch.executionClaimConflictCount).toBe(2);
		expect(match.executionClaimConflictCount).toBe(0);
		expect(partialPathMatch.executionClaimConflictCount).toBe(1);
		expect(commandPrefixMismatch.executionClaimConflictCount).toBe(1);
	});

	test("accepts a verified path when it is part of the evidenced command", () => {
		const state = stateWithNoExecutionEvidence();
		state.executionEvidence.successfulVerifications.push({
			tool: "bash",
			toolCallId: "bash-1",
			resultEntryId: "result-bash-1",
			command: "bun test test/context-steady/segment.test.ts",
		});

		expect(
			inspectContextSummary("- `bun test test/context-steady/segment.test.ts` passed", state)
				.executionClaimConflictCount,
		).toBe(0);
	});
});
