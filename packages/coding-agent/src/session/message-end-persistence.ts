/**
 * Serializes persistence for messages emitted at the end of a turn.
 *
 * A message-end event can be observed before the message that precedes it has
 * finished appending to the session journal. This queue keeps those appends in
 * emission order and lets later lifecycle work wait for either one message or
 * the complete pending tail without coupling the coordination state to
 * `AgentSession`.
 */
import type { AgentMessage } from "@san/agent";

import { sessionMessagePersistenceKey } from "./turn-persistence";

export type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};

export class MessageEndPersistenceQueue {
	#tail = Promise.resolve();
	#pending = new Map<string, Promise<void>>();

	create(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#tail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pending.get(key) === promise) {
				this.#pending.delete(key);
			}
		};
		this.#pending.set(key, promise);
		this.#tail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	async waitFor(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pending.get(key);
	}

	async waitForAll(): Promise<void> {
		await this.#tail;
	}
}
