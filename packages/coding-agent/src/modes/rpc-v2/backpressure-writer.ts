/**
 * San RPC v2 backpressure-aware output writer.
 *
 * Wraps process.stdout.write with drain waiting so the protocol never
 * accumulates unbounded objects when the consumer is slow. Durable events
 * are never dropped; transient events can be coalesced under pressure.
 */

type Frame = object;

export class BackpressureWriter {
	#draining = false;
	#closed = false;
	#coalescedCount = 0;
	readonly #maxQueueSize: number;

	constructor(options?: { maxQueueSize?: number }) {
		this.#maxQueueSize = options?.maxQueueSize ?? 4096;
	}

	/** Write a frame. Waits for drain if the kernel buffer is full. */
	async write(frame: Frame): Promise<void> {
		if (this.#closed) return;

		const line = `${JSON.stringify(frame)}\n`;
		const ok = process.stdout.write(line);
		if (!ok) {
			await this.#waitForDrain();
		}
	}

	/** Synchronous write for frames that must not be delayed (server.ready, errors). */
	writeSync(frame: Frame): void {
		if (this.#closed) return;
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	}

	/**
	 * Write a transient frame with coalescing under pressure.
	 * If the queue is backed up, transient frames are dropped and counted.
	 */
	writeTransient(frame: Frame): void {
		if (this.#closed) return;
		const ok = process.stdout.write(`${JSON.stringify(frame)}\n`);
		if (!ok) {
			// Under pressure: skip transient frame
			this.#coalescedCount++;
		}
	}

	get coalescedCount(): number {
		return this.#coalescedCount;
	}

	close(): void {
		this.#closed = true;
	}

	#waitForDrain(): Promise<void> {
		if (this.#draining) return Promise.resolve();
		this.#draining = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", () => {
			this.#draining = false;
			resolve();
		});
		return promise;
	}
}
