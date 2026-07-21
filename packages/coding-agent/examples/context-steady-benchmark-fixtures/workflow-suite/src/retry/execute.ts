import { retryDelayMs } from "./backoff";

export interface RetryOptions {
	method: string;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	idempotencyKey?: string;
	signal?: AbortSignal;
	sleep?: (milliseconds: number) => Promise<void>;
}

export async function executeWithRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
	let attempt = 0;
	while (true) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= options.maxRetries) throw error;
			attempt++;
			await (options.sleep ?? Bun.sleep)(retryDelayMs(options.baseDelayMs, options.maxDelayMs, attempt));
		}
	}
}
