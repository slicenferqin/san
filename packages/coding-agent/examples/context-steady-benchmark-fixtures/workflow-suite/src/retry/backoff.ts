export function retryDelayMs(baseDelayMs: number, _maxDelayMs: number, retry: number, retryAfterMs?: number): number {
	return retryAfterMs ?? baseDelayMs * retry;
}
