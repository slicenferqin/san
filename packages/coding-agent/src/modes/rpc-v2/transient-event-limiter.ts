import type { SessionEvent } from "./dto/events";

const DEFAULT_MAX_TRANSIENT_EVENTS_PER_SECOND = 200;
const DEFAULT_MAX_PENDING_STREAMS = 4_096;

export class TransientEventLimiter {
	#limit: number;
	readonly #maxPendingStreams: number;
	#windowStartedAt: number | undefined;
	#emittedInWindow = 0;
	readonly #pending = new Map<string, SessionEvent>();
	#droppedPendingCount = 0;

	constructor(limit = DEFAULT_MAX_TRANSIENT_EVENTS_PER_SECOND, maxPendingStreams = DEFAULT_MAX_PENDING_STREAMS) {
		this.#limit = assertPositiveInteger(limit, "Transient event limit");
		this.#maxPendingStreams = assertPositiveInteger(maxPendingStreams, "Transient pending stream limit");
	}

	configure(limit: number): void {
		this.#limit = assertPositiveInteger(limit, "Transient event limit");
		this.#windowStartedAt = undefined;
		this.#emittedInWindow = 0;
	}

	clear(): void {
		this.#pending.clear();
		this.#windowStartedAt = undefined;
		this.#emittedInWindow = 0;
		this.#droppedPendingCount = 0;
	}

	select(event: SessionEvent, key: string, now = Date.now()): SessionEvent[] {
		if (event.durability === "durable") {
			this.#pending.clear();
			return [event];
		}
		this.#advanceWindow(now);
		if (this.#emittedInWindow < this.#limit) {
			this.#emittedInWindow++;
			return [event];
		}
		const existing = this.#pending.delete(key);
		if (!existing && this.#pending.size >= this.#maxPendingStreams) {
			const oldestKey = this.#pending.keys().next().value;
			if (oldestKey !== undefined) {
				this.#pending.delete(oldestKey);
				this.#droppedPendingCount++;
			}
		}
		this.#pending.set(key, event);
		return [];
	}

	flush(now = Date.now()): SessionEvent[] {
		this.#advanceWindow(now);
		const available = this.#limit - this.#emittedInWindow;
		if (available <= 0 || this.#pending.size === 0) return [];
		const events: SessionEvent[] = [];
		for (const [key, event] of this.#pending) {
			if (events.length >= available) break;
			events.push(event);
			this.#pending.delete(key);
		}
		this.#emittedInWindow += events.length;
		return events;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	get droppedPendingCount(): number {
		return this.#droppedPendingCount;
	}

	get millisecondsUntilNextWindow(): number | undefined {
		if (this.#pending.size === 0 || this.#windowStartedAt === undefined) return undefined;
		return Math.max(0, this.#windowStartedAt + 1_000 - Date.now());
	}
	#advanceWindow(now: number): void {
		if (this.#windowStartedAt === undefined || now < this.#windowStartedAt || now - this.#windowStartedAt >= 1_000) {
			this.#windowStartedAt = now;
			this.#emittedInWindow = 0;
		}
	}
}

function assertPositiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}
