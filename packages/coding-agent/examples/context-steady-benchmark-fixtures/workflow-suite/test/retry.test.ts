import { describe, expect, test } from "bun:test";

import { RetryableRequestError } from "../src/retry/errors";
import { executeWithRetry } from "../src/retry/execute";

describe("request retry contract", () => {
	test("uses bounded exponential delays for retryable GET requests", async () => {
		const delays: number[] = [];
		let calls = 0;
		const result = await executeWithRetry(
			async () => {
				calls++;
				if (calls < 3) throw new RetryableRequestError("temporary");
				return "ok";
			},
			{
				method: "GET",
				maxRetries: 3,
				baseDelayMs: 100,
				maxDelayMs: 250,
				sleep: async delay => {
					delays.push(delay);
				},
			},
		);

		expect(result).toBe("ok");
		expect(delays).toEqual([100, 200]);
	});
});
