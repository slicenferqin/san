/**
 * Contract: `message_update` streams answer text as `message.delta`, and —
 * only when the client opted in via `stream.configure {thinkingDeltas:true}` —
 * streams reasoning as `message.delta {channel:"thinking"}`. Thinking deltas
 * must never enter the visible active-message buffer.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import { AdapterContext, adaptSessionEvent } from "./event-adapter";
import { EventSequencer } from "./event-sequencer";
import type { SessionId } from "./protocol/ids";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-test",
	usage: {} as AssistantMessage["usage"],
	stopReason: "stop",
	timestamp: 1,
} as AssistantMessage;

function makeUpdate(assistantMessageEvent: {
	type: "text_delta" | "thinking_delta";
	delta: string;
}): AgentSessionEvent {
	return {
		type: "message_update",
		message: assistant,
		assistantMessageEvent: { ...assistantMessageEvent, contentIndex: 0, partial: assistant },
	} as AgentSessionEvent;
}

function makeContext(): { ctx: AdapterContext; sequencer: EventSequencer } {
	const ctx = new AdapterContext();
	ctx.allocateMessage("assistant");
	return { ctx, sequencer: new EventSequencer("sess_test" as SessionId) };
}

describe("event-adapter message_update", () => {
	it("emits text deltas and appends them to the visible buffer", () => {
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(makeUpdate({ type: "text_delta", delta: "hello" }), sequencer, ctx);
		expect(emitted?.type).toBe("message.delta");
		const data = (emitted?.data ?? {}) as { delta?: string; channel?: string };
		expect(data.delta).toBe("hello");
		expect(data.channel).toBeUndefined();
		const stream = ctx.activeStreams.find(s => s.kind === "message");
		expect(stream && "content" in stream ? stream.content : "").toBe("hello");
	});

	it("drops thinking deltas by default", () => {
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(makeUpdate({ type: "thinking_delta", delta: "pondering" }), sequencer, ctx);
		expect(emitted).toBeUndefined();
	});

	it("emits thinking deltas on the thinking channel when opted in, without touching the buffer", () => {
		const { ctx, sequencer } = makeContext();
		ctx.emitThinkingDeltas = true;
		const emitted = adaptSessionEvent(makeUpdate({ type: "thinking_delta", delta: "pondering" }), sequencer, ctx);
		expect(emitted?.type).toBe("message.delta");
		expect(emitted?.durability).toBe("transient");
		expect(emitted?.data as { messageId?: unknown; delta?: string; channel?: string }).toEqual({
			messageId: ctx.currentMessageId,
			delta: "pondering",
			channel: "thinking",
		});
		const stream = ctx.activeStreams.find(s => s.kind === "message");
		expect(stream && "content" in stream ? stream.content : "").toBe("");
	});

	it("still emits plain text deltas while thinking is opted in", () => {
		const { ctx, sequencer } = makeContext();
		ctx.emitThinkingDeltas = true;
		const emitted = adaptSessionEvent(makeUpdate({ type: "text_delta", delta: "answer" }), sequencer, ctx);
		const data = (emitted?.data ?? {}) as { delta?: string; channel?: string };
		expect(data.channel).toBeUndefined();
		expect(data.delta).toBe("answer");
	});
});

describe("event-adapter message_end", () => {
	it("projects bounded visible content and clears the active stream", () => {
		const { ctx, sequencer } = makeContext();
		const message = {
			...assistant,
			content: [{ type: "text" as const, text: "final answer" }],
		};
		const emitted = adaptSessionEvent({ type: "message_end", message } as AgentSessionEvent, sequencer, ctx);
		expect(emitted?.type).toBe("message.completed");
		expect(emitted?.data).toEqual({
			messageId: expect.any(String),
			role: "assistant",
			content: "final answer",
			contentLength: 12,
			truncated: false,
		});
		expect(ctx.activeStreams).toEqual([]);
	});
});

describe("event-adapter tool_execution_end", () => {
	function makeToolEnd(result: unknown, isError = false): AgentSessionEvent {
		return { type: "tool_execution_end", toolCallId: "tc_1", toolName: "edit", result, isError } as AgentSessionEvent;
	}

	it("projects edit diff and path into a bounded preview", () => {
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(
			makeToolEnd({ content: [], details: { path: "/tmp/a.ts", diff: "--- a\n+++ b\n-x\n+y\n" } }),
			sequencer,
			ctx,
		);
		const data = (emitted?.data ?? {}) as {
			path?: string;
			preview?: string;
			previewTruncated?: boolean;
			summary?: string;
		};
		expect(emitted?.type).toBe("tool.completed");
		expect(data.path).toBe("/tmp/a.ts");
		expect(data.preview).toBe("--- a\n+++ b\n-x\n+y\n");
		expect(data.previewTruncated).toBeUndefined();
		expect(data.summary).toBe("edit completed");
	});

	it("truncates oversized diffs and flags it", () => {
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(
			makeToolEnd({ details: { resolvedPath: "/tmp/b.ts", diff: "x".repeat(10_000) } }),
			sequencer,
			ctx,
		);
		const data = (emitted?.data ?? {}) as { path?: string; preview?: string; previewTruncated?: boolean };
		expect(data.path).toBe("/tmp/b.ts");
		expect(data.preview?.length).toBe(4096);
		expect(data.previewTruncated).toBe(true);
	});

	it("emits no detail fields for tools without renderer details", () => {
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(makeToolEnd({ content: [{ type: "text", text: "ok" }] }), sequencer, ctx);
		const data = (emitted?.data ?? {}) as { path?: string; preview?: string };
		expect(data.path).toBeUndefined();
		expect(data.preview).toBeUndefined();
	});

	it("redacts credentials and local home paths from tool result projections", () => {
		const { ctx, sequencer } = makeContext();
		const home = process.env.HOME ?? "/Users/tester";
		const secret = "sk-abcdefghijklmnopqrstuvwx";
		const emitted = adaptSessionEvent(
			makeToolEnd({
				details: {
					resolvedPath: `${home}/private/a.ts`,
					diff: `+authorization=${secret}\n+file=${home}/private/a.ts`,
				},
			}),
			sequencer,
			ctx,
		);
		const data = (emitted?.data ?? {}) as { path?: string; preview?: string };
		expect(data.path).toBe("~/private/a.ts");
		expect(data.preview).toBe("+authorization=[REDACTED]\n+file=~/private/a.ts");
		expect(data.preview).not.toContain(secret);
		expect(data.preview).not.toContain(home);
	});
});

describe("event-adapter diagnostic metadata", () => {
	it("projects logical model route lifecycle events", () => {
		const { ctx, sequencer } = makeContext();
		const resolved = adaptSessionEvent(
			{
				type: "model_route_resolved",
				logicalModel: "coding",
				routeId: "primary",
				model: "provider/chat",
				reason: "affinity",
			},
			sequencer,
			ctx,
		);
		const changed = adaptSessionEvent(
			{
				type: "model_route_changed",
				logicalModel: "coding",
				fromRoute: "primary",
				toRoute: "backup",
				trigger: "rate_limit",
				cooldownUntil: 1_785_830_400_000,
			},
			sequencer,
			ctx,
		);

		expect(resolved).toMatchObject({
			type: "model.route.resolved",
			data: {
				logicalModel: "coding",
				routeId: "primary",
				model: "provider/chat",
				reason: "affinity",
			},
		});
		expect(changed).toMatchObject({
			type: "model.route.changed",
			data: {
				logicalModel: "coding",
				fromRoute: "primary",
				toRoute: "backup",
				trigger: "rate_limit",
				cooldownUntil: 1_785_830_400_000,
			},
		});
	});

	it("redacts retry errors, tool intents, and notices before emission", () => {
		const home = process.env.HOME ?? "/Users/tester";
		const secret = "sk-abcdefghijklmnopqrstuvwx";
		const raw = `failed at ${home}/private authorization=${secret}`;
		const cases: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "tc_2",
				toolName: "bash",
				args: {},
				intent: raw,
			},
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: raw },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: raw },
			{ type: "notice", level: "error", message: raw, source: "test" },
		] as AgentSessionEvent[];

		for (const event of cases) {
			const { ctx, sequencer } = makeContext();
			const emitted = adaptSessionEvent(event, sequencer, ctx);
			const serialized = JSON.stringify(emitted?.data);
			expect(serialized).toContain("[REDACTED]");
			expect(serialized).toContain("~/private");
			expect(serialized).not.toContain(secret);
			expect(serialized).not.toContain(home);
		}
	});

	it("exposes and sanitizes context-maintenance failure diagnostics", () => {
		const home = process.env.HOME ?? "/Users/tester";
		const secret = "sk-abcdefghijklmnopqrstuvwx";
		const { ctx, sequencer } = makeContext();
		const emitted = adaptSessionEvent(
			{
				type: "auto_compaction_end",
				maintenanceId: "maintenance_test",
				action: "context-full",
				result: undefined,
				aborted: false,
				willRetry: false,
				skipped: true,
				failureStage: "preparation",
				failureReason: `no settled history at ${home}/private authorization=${secret}`,
			} as AgentSessionEvent,
			sequencer,
			ctx,
		);

		expect(emitted?.type).toBe("context.maintenance.completed");
		expect(emitted?.data).toMatchObject({
			failureStage: "preparation",
			failureReason: "no settled history at ~/private authorization=[REDACTED]",
		});
	});
});
