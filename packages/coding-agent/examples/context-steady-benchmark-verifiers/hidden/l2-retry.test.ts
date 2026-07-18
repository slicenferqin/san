import { describe, expect, test } from "bun:test";

import { retryDelayMs } from "./src/retry/backoff";
import { RequestAbortedError, RetryableRequestError } from "./src/retry/errors";
import { executeWithRetry } from "./src/retry/execute";

describe("L2 hidden retry contract", () => {
	test("caps exponential delay and honors a longer Retry-After", () => {
		expect(retryDelayMs(100, 250, 1)).toBe(100);
		expect(retryDelayMs(100, 250, 3)).toBe(250);
		expect(retryDelayMs(100, 500, 2, 450)).toBe(450);
	});

	test("does not retry non-retryable failures", async () => {
		const failure = new Error("validation failed");
		let calls = 0;
		await expect(
			executeWithRetry(
				async () => {
					calls++;
					throw failure;
				},
				{ method: "GET", maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4, sleep: async () => {} },
			),
		).rejects.toBe(failure);
		expect(calls).toBe(1);
	});

	test("POST retries require an idempotency key", async () => {
		let withoutKey = 0;
		await expect(
			executeWithRetry(
				async () => {
					withoutKey++;
					throw new RetryableRequestError("temporary");
				},
				{ method: "POST", maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4, sleep: async () => {} },
			),
		).rejects.toBeInstanceOf(RetryableRequestError);
		expect(withoutKey).toBe(1);

		let withKey = 0;
		await expect(
			executeWithRetry(
				async () => {
					withKey++;
					throw new RetryableRequestError("temporary");
				},
				{
					method: "POST",
					idempotencyKey: "request-1",
					maxRetries: 2,
					baseDelayMs: 1,
					maxDelayMs: 4,
					sleep: async () => {},
				},
			),
		).rejects.toBeInstanceOf(RetryableRequestError);
		expect(withKey).toBe(3);
	});

	test("aborts before another operation is attempted", async () => {
		const controller = new AbortController();
		let calls = 0;
		await expect(
			executeWithRetry(
				async () => {
					calls++;
					controller.abort();
					throw new RetryableRequestError("temporary", 1);
				},
				{
					method: "GET",
					maxRetries: 2,
					baseDelayMs: 1,
					maxDelayMs: 4,
					signal: controller.signal,
					sleep: async () => {},
				},
			),
		).rejects.toBeInstanceOf(RequestAbortedError);
		expect(calls).toBe(1);
	});
});
