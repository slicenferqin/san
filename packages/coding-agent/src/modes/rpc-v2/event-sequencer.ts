/**
 * San RPC v2 Event Sequencer.
 *
 * Assigns monotonically increasing sequence numbers and unique event IDs
 * to each session event within a single RPC process. Sequence is 1-based
 * and only comparable within the same Session.
 */
import type { EventCausation, SessionEvent, SessionEventType } from "./dto/events";
import type { RunId, SessionId, TurnId } from "./protocol/ids";
import { newEventId, SequenceAllocator } from "./protocol/ids";

/**
 * Per-session event sequencer. Maintains the monotonic sequence watermark
 * and wraps event data into the v2 SessionEvent envelope.
 */
export class EventSequencer {
	readonly #sessionId: SessionId;
	readonly #allocator: SequenceAllocator;

	constructor(sessionId: SessionId, startAt = 0) {
		this.#sessionId = sessionId;
		this.#allocator = new SequenceAllocator(startAt);
	}

	get currentSequence(): number {
		return this.#allocator.current;
	}

	/** Advance the watermark (used during recovery from journal). */
	advanceTo(value: number): void {
		this.#allocator.advanceTo(value);
	}

	/** Wrap event data into a full SessionEvent envelope with sequence and ID. */
	emit<T>(
		type: SessionEventType,
		data: T,
		options?: {
			durability?: "durable" | "transient";
			runId?: RunId;
			turnId?: TurnId;
			causation?: EventCausation;
		},
	): SessionEvent<T> {
		const eventId = newEventId();
		const sequence = this.#allocator.next();
		return {
			schemaVersion: 1,
			eventId,
			sessionId: this.#sessionId,
			sequence,
			timestamp: new Date().toISOString(),
			...(options?.runId && { runId: options.runId }),
			...(options?.turnId && { turnId: options.turnId }),
			type,
			durability: options?.durability ?? "durable",
			...(options?.causation && { causation: options.causation }),
			data,
		};
	}
}
