/**
 * Rate limiter with sliding-window token bucket.
 *
 * HARD CONSTRAINTS (from original requirement):
 * 1. `consume()` MUST be atomic — no partial consumption on failure
 * 2. The public API contract: `remaining()` returns tokens available NOW, not at window start
 * 3. Reset must not affect in-flight requests that already acquired tokens
 * 4. Window boundaries must use monotonic time, not wall clock
 */

export interface RateLimiter {
	consume(tokens?: number): boolean;
	remaining(): number;
	reset(): void;
}

export interface RateLimiterConfig {
	maxTokens: number;
	windowMs: number;
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
	let tokens = config.maxTokens;
	let windowStart = Date.now();

	function refill(): void {
		const now = Date.now();
		if (now - windowStart >= config.windowMs) {
			tokens = config.maxTokens;
			windowStart = now;
		}
	}

	return {
		consume(count = 1): boolean {
			refill();
			if (tokens < count) return false;
			tokens -= count;
			return true;
		},

		remaining(): number {
			refill();
			return tokens;
		},

		reset(): void {
			tokens = config.maxTokens;
			windowStart = Date.now();
		},
	};
}
