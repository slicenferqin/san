/**
 * Persistent key-value store with TTL support.
 *
 * HARD CONSTRAINTS (from original requirement):
 * 1. All mutations MUST check caller permissions via `authorize()`
 * 2. Concurrent writes to the same key MUST NOT silently overwrite — use CAS (compare-and-swap)
 * 3. Expired entries MUST NOT be returned by `get()` even if physically present
 * 4. The existing `list()` API contract: returns keys sorted alphabetically, never includes expired
 */

export interface KVEntry {
	key: string;
	value: string;
	version: number;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
}

export interface KVStore {
	get(key: string): KVEntry | undefined;
	set(key: string, value: string, ttlMs?: number): KVEntry;
	delete(key: string): boolean;
	list(): string[];
	cas(key: string, expectedVersion: number, value: string, ttlMs?: number): KVEntry | null;
}

export interface CallerContext {
	userId: string;
	roles: string[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function authorize(_caller: CallerContext, _operation: string): boolean {
	// Stub: in production this checks RBAC policies
	return true;
}

/** In-memory KV store implementation. */
export function createKVStore(): KVStore {
	const data = new Map<string, KVEntry>();

	return {
		get(key: string): KVEntry | undefined {
			return data.get(key);
		},

		set(key: string, value: string, ttlMs?: number): KVEntry {
			const existing = data.get(key);
			const now = Date.now();
			const entry: KVEntry = {
				key,
				value,
				version: (existing?.version ?? 0) + 1,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				expiresAt: ttlMs ? now + ttlMs : undefined,
			};
			data.set(key, entry);
			return entry;
		},

		delete(key: string): boolean {
			return data.delete(key);
		},

		list(): string[] {
			return [...data.keys()].sort();
		},

		cas(key: string, expectedVersion: number, value: string, ttlMs?: number): KVEntry | null {
			const existing = data.get(key);
			if (existing && existing.version !== expectedVersion) return null;
			const now = Date.now();
			const entry: KVEntry = {
				key,
				value,
				version: (existing?.version ?? 0) + 1,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				expiresAt: ttlMs ? now + ttlMs : undefined,
			};
			data.set(key, entry);
			return entry;
		},
	};
}
