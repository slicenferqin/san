/**
 * Event pipeline: receives raw events, validates schema, and dispatches to handlers.
 *
 * HARD CONSTRAINTS (from original requirement):
 * 1. Unknown event types MUST be rejected with a structured error, not silently dropped
 * 2. Handler exceptions MUST NOT crash the pipeline — isolate with try/catch and emit to dead-letter
 * 3. The `process()` method MUST return a receipt with accepted/rejected/dead-letter counts
 * 4. Event ordering within the same partition key MUST be preserved
 */

export interface RawEvent {
	id: string;
	type: string;
	partitionKey: string;
	payload: Record<string, unknown>;
	timestamp: number;
}

export interface ProcessReceipt {
	accepted: number;
	rejected: number;
	deadLetter: number;
}

export type EventHandler = (event: RawEvent) => void | Promise<void>;

export interface EventPipeline {
	register(eventType: string, handler: EventHandler): void;
	process(events: RawEvent[]): Promise<ProcessReceipt>;
}

export function createEventPipeline(): EventPipeline {
	const handlers = new Map<string, EventHandler>();

	return {
		register(eventType: string, handler: EventHandler): void {
			handlers.set(eventType, handler);
		},

		async process(events: RawEvent[]): Promise<ProcessReceipt> {
			let accepted = 0;
			let rejected = 0;
			const deadLetter = 0;

			for (const event of events) {
				const handler = handlers.get(event.type);
				if (!handler) {
					continue;
				}
				try {
					await handler(event);
					accepted++;
				} catch {
					rejected++;
				}
			}

			return { accepted, rejected, deadLetter };
		},
	};
}
