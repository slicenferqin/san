import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "./dto/events";
import type { EventId, SessionId } from "./protocol/ids";
import { TransientEventLimiter } from "./transient-event-limiter";

function event(sequence: number, durability: "durable" | "transient" = "transient"): SessionEvent {
	return {
		schemaVersion: 1,
		eventId: `event-${sequence}` as EventId,
		sessionId: "session-1" as SessionId,
		sequence,
		timestamp: "2026-07-26T00:00:00.000Z",
		type: "message.delta",
		durability,
		data: { delta: String(sequence) },
	};
}

describe("TransientEventLimiter", () => {
	test("coalesces over-limit streams by key and releases the latest values next window", () => {
		const limiter = new TransientEventLimiter(2);
		const now = Date.now();
		expect(limiter.select(event(1), "answer", now)).toEqual([event(1)]);
		expect(limiter.select(event(2), "thinking", now)).toEqual([event(2)]);
		expect(limiter.select(event(3), "answer", now)).toEqual([]);
		expect(limiter.select(event(4), "answer", now)).toEqual([]);
		expect(limiter.select(event(5), "thinking", now)).toEqual([]);
		expect(limiter.pendingCount).toBe(2);
		expect(limiter.millisecondsUntilNextWindow).toBeLessThanOrEqual(1_000);
		expect(limiter.millisecondsUntilNextWindow).toBeGreaterThanOrEqual(0);

		expect(limiter.flush(now + 999)).toEqual([]);
		expect(limiter.flush(now + 1_000)).toEqual([event(4), event(5)]);
		expect(limiter.pendingCount).toBe(0);
		expect(limiter.millisecondsUntilNextWindow).toBeUndefined();
	});

	test("never rate limits durable events and drops stale transient predecessors", () => {
		const limiter = new TransientEventLimiter(1);
		expect(limiter.select(event(1), "answer", 0)).toEqual([event(1)]);
		expect(limiter.select(event(2), "answer", 0)).toEqual([]);
		expect(limiter.select(event(3, "durable"), "completion", 0)).toEqual([event(3, "durable")]);
		expect(limiter.flush(1_000)).toEqual([]);
	});

	test("preserves pending events when the limit changes", () => {
		const limiter = new TransientEventLimiter(1);
		limiter.select(event(1), "answer", 0);
		limiter.select(event(2), "answer", 0);
		limiter.configure(2);

		expect(limiter.flush(1)).toEqual([event(2)]);
	});

	test("bounds pending stream keys and retains the most recently active streams", () => {
		const limiter = new TransientEventLimiter(1, 2);
		limiter.select(event(1), "answer", 0);
		limiter.select(event(2), "stream-1", 0);
		limiter.select(event(3), "stream-2", 0);
		limiter.select(event(4), "stream-1", 0);
		limiter.select(event(5), "stream-3", 0);

		expect(limiter.pendingCount).toBe(2);
		expect(limiter.droppedPendingCount).toBe(1);
		expect(limiter.flush(1_000)).toEqual([event(4)]);
		expect(limiter.flush(2_000)).toEqual([event(5)]);
	});
});

describe("TransientEventLimiter.clear", () => {
	test("drops coalesced events when a subscription ends", () => {
		const limiter = new TransientEventLimiter(1);
		limiter.select(event(1), "answer", 0);
		limiter.select(event(2), "answer", 0);

		limiter.clear();

		expect(limiter.pendingCount).toBe(0);
		expect(limiter.flush(1_000)).toEqual([]);
		expect(limiter.millisecondsUntilNextWindow).toBeUndefined();
	});
});
