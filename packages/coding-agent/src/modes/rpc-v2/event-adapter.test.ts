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
