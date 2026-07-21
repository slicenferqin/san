/**
 * San RPC v2 idempotency receipt store.
 *
 * Tracks mutation idempotency keys to ensure at-most-once execution.
 * Same key + same params → returns cached result.
 * Same key + different params → IDEMPOTENCY_CONFLICT error.
 */

interface Receipt {
	key: string;
	paramsHash: string;
	result: unknown;
	createdAt: number;
}

export class IdempotencyStore {
	#receipts = new Map<string, Receipt>();
	#maxSize: number;

	constructor(options?: { maxSize?: number }) {
		this.#maxSize = options?.maxSize ?? 10_000;
	}

	/**
	 * Check if a mutation with this key was already executed.
	 * Returns the cached result if same params, throws conflict if different params.
	 * Returns undefined if this is a new key.
	 */
	check(key: string, params: unknown): { cached: true; result: unknown } | { cached: false } {
		const existing = this.#receipts.get(key);
		if (!existing) return { cached: false };

		const incomingHash = hashParams(params);
		if (existing.paramsHash === incomingHash) {
			return { cached: true, result: existing.result };
		}

		// Same key, different params — conflict
		throw new IdempotencyConflictError(key);
	}

	/** Record a completed mutation. */
	record(key: string, params: unknown, result: unknown): void {
		if (this.#receipts.size >= this.#maxSize) {
			// Evict oldest entries
			const entries = Array.from(this.#receipts.entries());
			const toRemove = entries.slice(0, Math.floor(this.#maxSize * 0.1));
			for (const [k] of toRemove) this.#receipts.delete(k);
		}

		this.#receipts.set(key, {
			key,
			paramsHash: hashParams(params),
			result,
			createdAt: Date.now(),
		});
	}

	get size(): number {
		return this.#receipts.size;
	}

	clear(): void {
		this.#receipts.clear();
	}
}

export class IdempotencyConflictError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`Idempotency conflict: key "${key}" was already used with different parameters`);
		this.name = "IdempotencyConflictError";
		this.key = key;
	}
}

function hashParams(params: unknown): string {
	try {
		return JSON.stringify(params, Object.keys((params as object) ?? {}).sort());
	} catch {
		return String(params);
	}
}
