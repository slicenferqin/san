import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@san/ai";
import { ToolProgressGuard } from "../../src/context-steady/tool-progress-guard";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function turn(index: number, path: string, text: string) {
	const toolCallId = `call-${index}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index,
	};
	return { message, toolResults: [result] };
}

function mutationTurn(index: number) {
	const toolCallId = `call-${index}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "edit",
				arguments: { path: "src/fix.ts", oldText: "before", newText: "after" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "edit",
		content: [{ type: "text", text: "Updated src/fix.ts" }],
		isError: false,
		timestamp: index,
	};
	return { message, toolResults: [result] };
}

function searchTurn(index: number, query: string) {
	const toolCallId = `search-${index}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "grep", arguments: { query, path: "src" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "grep",
		content: [{ type: "text", text: "No matches found" }],
		isError: false,
		timestamp: index,
	};
	return { message, toolResults: [result] };
}

function bashTurn(index: number, wallTimeMs: number, exitCode = 0) {
	const toolCallId = `bash-${index}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "git status --short" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "M src/fix.ts" }],
		details: { exitCode, wallTimeMs, terminalId: `terminal-${index}` },
		isError: false,
		timestamp: index,
	};
	return { message, toolResults: [result] };
}

function guard() {
	return new ToolProgressGuard({
		mode: "hard",
		repeatThreshold: 3,
		saturationWindow: 8,
		saturationMaxResources: 2,
		finalizeAfterNoProgress: 3,
		historyLimit: 12,
		exemptTools: ["job", "irc"],
	});
}

describe("ToolProgressGuard", () => {
	test("redirects an A/B evidence cycle and then requires a no-tool final answer", () => {
		const progress = guard();
		const sequence = [
			turn(1, "a.log", "same A"),
			turn(2, "b.log", "same B"),
			turn(3, "a.log", "same A"),
			turn(4, "b.log", "same B"),
			turn(5, "a.log", "same A"),
		];
		for (const item of sequence.slice(0, -1)) expect(progress.recordTurn(item)).toBeNull();
		expect(progress.recordTurn(sequence.at(-1)!)).toMatchObject({
			kind: "soft_redirect",
			reason: "repeated_result",
		});
		expect(progress.recordTurn(turn(6, "b.log", "same B"))).toBeNull();
		expect(progress.recordTurn(turn(7, "a.log", "same A"))).toBeNull();
		expect(progress.recordTurn(turn(8, "b.log", "same B"))).toMatchObject({ kind: "finalize_required" });
		expect(progress.consumeForcedFinalization()).toBe(true);
		expect(progress.consumeForcedFinalization()).toBe(false);
	});

	test("new resources and changed results keep a long investigation running", () => {
		const progress = guard();
		for (let index = 1; index <= 60; index++) {
			expect(progress.recordTurn(turn(index, `evidence-${index}.log`, `result-${index}`))).toBeNull();
		}
		expect(progress.snapshot()).toMatchObject({
			state: "tracking",
			softRedirects: 0,
			forcedFinalizations: 0,
			observationCount: 60,
		});
	});

	test("different search queries remain distinct resources even when every result is empty", () => {
		const progress = guard();
		for (let index = 1; index <= 60; index++) {
			expect(progress.recordTurn(searchTurn(index, `symbol-${index}`))).toBeNull();
		}
		expect(progress.snapshot()).toMatchObject({
			state: "tracking",
			uniqueResourceCount: 60,
			softRedirects: 0,
			forcedFinalizations: 0,
		});
	});

	test("ignores volatile bash timing and terminal metadata when detecting repeated evidence", () => {
		const progress = guard();
		expect(progress.recordTurn(bashTurn(1, 10))).toBeNull();
		expect(progress.recordTurn(bashTurn(2, 500))).toBeNull();
		expect(progress.recordTurn(bashTurn(3, 2_000))).toMatchObject({
			kind: "soft_redirect",
			reason: "repeated_result",
		});

		const changedExit = guard();
		expect(changedExit.recordTurn(bashTurn(1, 10, 0))).toBeNull();
		expect(changedExit.recordTurn(bashTurn(2, 20, 1))).toBeNull();
		expect(changedExit.snapshot().actionRepeatCount).toBe(1);
	});

	test("successful mutation clears redirect evidence before tracking later observations", () => {
		const progress = guard();
		for (let index = 1; index <= 5; index++) {
			progress.recordTurn(turn(index, index % 2 === 0 ? "b.log" : "a.log", index % 2 === 0 ? "B" : "A"));
		}
		expect(progress.snapshot().state).toBe("soft_redirect");

		expect(progress.recordTurn(mutationTurn(6))).toBeNull();
		expect(progress.snapshot()).toMatchObject({
			state: "tracking",
			noEvidenceCount: 0,
			mutationCount: 1,
		});
		expect(progress.recordTurn(turn(7, "a.log", "A"))).toBeNull();
		expect(progress.recordTurn(turn(8, "b.log", "B"))).toBeNull();
		expect(progress.consumeForcedFinalization()).toBe(false);
	});

	test("reset cancels a pending finalization when a real user steer arrives", () => {
		const progress = guard();
		for (let index = 1; index <= 5; index++) {
			progress.recordTurn(turn(index, index % 2 === 0 ? "b.log" : "a.log", index % 2 === 0 ? "B" : "A"));
		}
		for (let index = 6; index <= 8; index++) {
			progress.recordTurn(turn(index, index % 2 === 0 ? "b.log" : "a.log", index % 2 === 0 ? "B" : "A"));
		}
		expect(progress.snapshot().state).toBe("finalize_required");
		progress.reset();
		expect(progress.consumeForcedFinalization()).toBe(false);
		expect(progress.snapshot()).toMatchObject({ state: "tracking", noEvidenceCount: 0 });
	});
});
