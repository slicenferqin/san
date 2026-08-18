import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type AssistantMessage, withOneshotRetry } from "@san/ai";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function errorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return message({ stopReason: "error", ...overrides });
}

function okMessage(text = "recovered"): AssistantMessage {
	return message({ content: [{ type: "text", text }] });
}

type WaitCall = { delayMs: number; signal?: AbortSignal };

function mockSchedulerWait(): { waits: WaitCall[] } {
	const waits: WaitCall[] = [];
	vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs: number, options?: { signal?: AbortSignal }) => {
		waits.push({ delayMs, signal: options?.signal });
	});
	return { waits };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("withOneshotRetry", () => {
	it("returns a resolved non-error completion after a single attempt", async () => {
		const ok = okMessage("done");
		const result = await withOneshotRetry(async () => ok);
		expect(result).toBe(ok);
	});

	it("retries a resolved transient error-stop and returns the eventual completion", async () => {
		let calls = 0;
		const transient = errorMessage({
			errorStatus: 503,
			errorMessage: "503 service unavailable: overloaded_error",
		});
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return calls === 1 ? transient : ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
	});

	it("exhausts the bounded attempt count and returns the final error result", async () => {
		let calls = 0;
		const transient = errorMessage({ errorStatus: 429, errorMessage: "429 too many requests" });
		const { waits } = mockSchedulerWait();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return transient;
			},
			{ retryBaseDelayMs: 10 },
		);
		expect(calls).toBe(3);
		expect(result).toBe(transient);
		// Linear backoff: base * (attempt + 1).
		expect(waits.map(w => w.delayMs)).toEqual([10, 20]);
	});

	it("honors attempts: 1 by never retrying", async () => {
		let calls = 0;
		const transient = errorMessage({ errorStatus: 503, errorMessage: "503 overloaded" });
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return transient;
			},
			{ attempts: 1, retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(1);
		expect(result).toBe(transient);
	});

	it("retries a thrown transient error and returns the eventual completion", async () => {
		let calls = 0;
		const err = Object.assign(new Error("503 service unavailable: overloaded_error"), { status: 503 });
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				if (calls === 1) throw err;
				return ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
	});

	it("does not retry non-retryable thrown errors", async () => {
		let calls = 0;
		const err = Object.assign(new Error("400 Bad Request: unsupported max_tokens; param=max_tokens"), {
			status: 400,
		});
		await expect(
			withOneshotRetry(async () => {
				calls += 1;
				throw err;
			}),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("honors retry-after backoff from the error message hint", async () => {
		let calls = 0;
		const err = Object.assign(new Error("429 too many requests retry-after-ms=40"), { status: 429 });
		const { waits } = mockSchedulerWait();
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				if (calls === 1) throw err;
				return ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
		// Server-requested backoff wins over the base linear backoff.
		expect(waits.map(w => w.delayMs)).toEqual([40]);
	});

	it("honors retry-after headers on the thrown error", async () => {
		let calls = 0;
		const err = Object.assign(new Error("429 too many requests"), {
			status: 429,
			headers: new Headers({ "retry-after-ms": "35" }),
		});
		const { waits } = mockSchedulerWait();
		await withOneshotRetry(
			async () => {
				calls += 1;
				if (calls === 1) throw err;
				return okMessage();
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(waits.map(w => w.delayMs)).toEqual([35]);
	});

	it("honors retry-after hints embedded in a resolved error message", async () => {
		let calls = 0;
		const transient = errorMessage({
			errorStatus: 503,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=30",
		});
		const ok = okMessage();
		const { waits } = mockSchedulerWait();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return calls === 1 ? transient : ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
		expect(waits.map(w => w.delayMs)).toEqual([30]);
	});

	it("gives up on resolved errors whose retry-after exceeds the cap", async () => {
		let calls = 0;
		const overloaded = errorMessage({
			errorStatus: 503,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=50000",
		});
		const { waits } = mockSchedulerWait();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return overloaded;
			},
			{ retryBaseDelayMs: 1, retryAfterMaxMs: 1_000 },
		);
		expect(calls).toBe(1);
		expect(result).toBe(overloaded);
		expect(waits).toHaveLength(0);
	});

	it("gives up on thrown errors whose retry-after exceeds the cap", async () => {
		let calls = 0;
		const err = Object.assign(new Error("503 service unavailable retry-after-ms=50000"), { status: 503 });
		const { waits } = mockSchedulerWait();
		await expect(
			withOneshotRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ retryBaseDelayMs: 1, retryAfterMaxMs: 1_000 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
		expect(waits).toHaveLength(0);
	});

	it("does not retry usage-limit error results", async () => {
		let calls = 0;
		const usage = errorMessage({
			errorStatus: 429,
			errorMessage: "You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.",
		});
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return usage;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(1);
		expect(result).toBe(usage);
	});

	it("does not retry auth-failed error results", async () => {
		let calls = 0;
		const auth = errorMessage({
			errorStatus: 401,
			errorMessage:
				'401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
		});
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return auth;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(1);
		expect(result).toBe(auth);
	});

	it("treats a plain 500 status-only message as transient", async () => {
		let calls = 0;
		const serverError = errorMessage({ errorStatus: 500 });
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return calls === 1 ? serverError : ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
	});

	it("retries provider finish_reason errors", async () => {
		let calls = 0;
		const finishError = errorMessage({ errorMessage: "Provider returned error finish_reason: error" });
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return calls === 1 ? finishError : ok;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
	});

	it("passes aborted error results through without retry", async () => {
		let calls = 0;
		const aborted = errorMessage({ stopReason: "aborted", errorMessage: "user cancelled" });
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return aborted;
			},
			{ retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(1);
		expect(result).toBe(aborted);
	});

	it("does not retry after a latched abort and never schedules a wait", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const err = Object.assign(new Error("503 service unavailable: overloaded_error"), { status: 503 });
		const { waits } = mockSchedulerWait();
		await expect(
			withOneshotRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ signal: controller.signal, retryBaseDelayMs: 1 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
		expect(waits).toHaveLength(0);
	});

	it("keeps an abort during the retry wait an abort", async () => {
		const controller = new AbortController();
		let calls = 0;
		const err = Object.assign(new Error("503 service unavailable: overloaded_error"), { status: 503 });
		// The real `scheduler.wait(delay, { signal })` rejects with an
		// AbortError when the signal fires mid-wait; simulate exactly that.
		const waits: WaitCall[] = [];
		vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs: number, options?: { signal?: AbortSignal }) => {
			waits.push({ delayMs, signal: options?.signal });
			throw new DOMException("The operation was aborted", "AbortError");
		});
		const caught = await withOneshotRetry(
			async () => {
				calls += 1;
				throw err;
			},
			{ signal: controller.signal, retryBaseDelayMs: 200 },
		).then(
			() => null,
			error => error,
		);
		expect(caught).toBeTruthy();
		expect(calls).toBe(1);
		expect(String((caught as Error)?.name)).toContain("Abort");
		expect(waits).toHaveLength(1);
		expect(waits[0]?.delayMs).toBe(200);
		expect(waits[0]?.signal).toBe(controller.signal);
	});

	it("returns the eventual completion once a later attempt succeeds", async () => {
		let calls = 0;
		const transient = errorMessage({ errorStatus: 502, errorMessage: "502 Bad Gateway" });
		const ok = okMessage();
		const result = await withOneshotRetry(
			async () => {
				calls += 1;
				return calls === 2 ? ok : transient;
			},
			{ attempts: 3, retryBaseDelayMs: 1 },
		);
		expect(calls).toBe(2);
		expect(result).toBe(ok);
	});
});
