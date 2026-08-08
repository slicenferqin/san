import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { AssistantMessageEventStream } from "@san/ai/utils/event-stream";
import {
	createProviderHealthKey,
	ExecutionLedger,
	normalizeProviderBaseUrl,
	ProviderCircuitOpenError,
	ProviderHealthError,
	type ProviderHealthEvent,
	type ProviderHealthEventType,
	ProviderHealthRegistry,
	providerHealthRefFromSnapshot,
} from "../../src/execution-control";

const key = createProviderHealthKey({
	provider: "OpenAI",
	baseUrl: "https://user:password@example.test/v1/?api_key=secret&route=primary#fragment",
	modelId: "gpt-test",
});

function message(stopReason: "stop" | "length" | "toolUse" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			totalTokens: 0,
		},
		stopReason,
		providerPayload: undefined,
		timestamp: Date.now(),
	};
}

function authReceipt(requestId: string) {
	return {
		kind: "auth_unavailable" as const,
		receiptRef: `auth-${requestId}`,
		requestId,
	};
}

describe("ProviderHealthRegistry", () => {
	test("normalizes endpoint identity without credential material", () => {
		expect(normalizeProviderBaseUrl(key.normalizedUrl)).toBe("https://example.test/v1?route=primary");
		expect(key.provider).toBe("openai");
		expect(key.normalizedUrl).not.toContain("password");
		expect(key.normalizedUrl).not.toContain("secret");
		const nonUrl = normalizeProviderBaseUrl("custom endpoint?access_token=top-secret&route=primary");
		expect(nonUrl).not.toContain("top-secret");
		expect(nonUrl).toContain("route=primary");
	});

	test("opens only after exhausted auth rotation and blocks before dispatch", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, authCooldownMs: 5_000 });
		const unchanged = registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-not-exhausted",
			credentialsExhausted: false,
		});
		expect(unchanged.state).toBe("closed");
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-exhausted",
			credentialsExhausted: true,
			routeSwitched: false,
		});
		let dispatched = false;
		await expect(
			registry.dispatch({ key }, async () => {
				dispatched = true;
				return "unexpected";
			}),
		).rejects.toBeInstanceOf(ProviderCircuitOpenError);
		expect(dispatched).toBe(false);
	});

	test("opens after consecutive auth failures and blocks until cooldown elapses", async () => {
		let now = 1_000;
		const registry = new ProviderHealthRegistry({ now: () => now, authCooldownMs: 5_000, failureThreshold: 2 });
		expect(registry.recordAuthUnavailable(key, authReceipt("request-1")).state).toBe("closed");
		const opened = registry.recordAuthUnavailable(key, authReceipt("request-2"));
		expect(opened.state).toBe("open");
		expect(opened.retryAt).toBe(6_000);
		await expect(registry.dispatch({ key }, async () => "unexpected")).rejects.toBeInstanceOf(
			ProviderCircuitOpenError,
		);
		// After the cooldown, dispatch proceeds as a half-open probe and success closes the circuit.
		now = 6_000;
		await expect(registry.dispatch({ key }, async () => "probe-ok")).resolves.toBe("probe-ok");
		expect(registry.status(key).state).toBe("closed");
	});

	test("resets the auth failure count after a success", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		registry.recordAuthUnavailable(key, authReceipt("request-before"));
		registry.recordSuccess(key);
		// Without the reset this would be the second consecutive failure and open.
		expect(registry.recordAuthUnavailable(key, authReceipt("request-after-1")).state).toBe("closed");
		expect(registry.recordAuthUnavailable(key, authReceipt("request-after-2")).state).toBe("open");
	});

	test("records thrown failures from non-stream dispatches", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		await expect(
			registry.dispatch({ key, requestId: "request-1" }, async () => {
				throw new Error("provider failure one");
			}),
		).rejects.toThrow("provider failure one");
		expect(registry.status(key).state).toBe("closed");

		await expect(
			registry.dispatch({ key, requestId: "request-2" }, async () => {
				throw new Error("provider failure two");
			}),
		).rejects.toThrow("provider failure two");
		expect(registry.status(key).state).toBe("open");
	});

	test("clears thrown failure evidence after a non-stream success", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		await expect(
			registry.dispatch({ key, requestId: "request-before" }, async () => {
				throw new Error("provider failure before success");
			}),
		).rejects.toThrow("provider failure before success");
		expect(await registry.dispatch({ key }, async () => "ok")).toBe("ok");

		await expect(
			registry.dispatch({ key, requestId: "request-after-1" }, async () => {
				throw new Error("provider failure after success one");
			}),
		).rejects.toThrow("provider failure after success one");
		expect(registry.status(key).state).toBe("closed");

		await expect(
			registry.dispatch({ key, requestId: "request-after-2" }, async () => {
				throw new Error("provider failure after success two");
			}),
		).rejects.toThrow("provider failure after success two");
		expect(registry.status(key).state).toBe("open");
	});

	test("requires distinct provider failure identities before opening", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		const receipt = (requestId: string, errorId: string) => ({
			kind: "provider_error" as const,
			receiptRef: `${requestId}-${errorId}`,
			requestId,
			errorId,
		});
		expect(registry.recordTerminalReceipt(key, receipt("request-1", "error-1")).state).toBe("closed");
		expect(registry.recordTerminalReceipt(key, receipt("request-1", "error-1")).state).toBe("closed");
		expect(registry.recordTerminalReceipt(key, receipt("request-2", "error-2")).state).toBe("open");
	});

	test("does not count provider errors after a successful terminal", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		const receipt = (errorId: string) => ({
			kind: "provider_error" as const,
			receiptRef: errorId,
			errorId,
		});
		registry.recordTerminalReceipt(key, receipt("error-before-1"));
		registry.recordSuccess(key);
		expect(registry.recordTerminalReceipt(key, receipt("error-after-1")).state).toBe("closed");
		expect(registry.recordTerminalReceipt(key, receipt("error-after-2")).state).toBe("open");
	});

	test("requires repeated receipt evidence when provider IDs are unavailable", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		expect(
			registry.recordTerminalReceipt(key, { kind: "provider_error", receiptRef: "provider-error-1" }).state,
		).toBe("closed");
		expect(
			registry.recordTerminalReceipt(key, { kind: "provider_error", receiptRef: "provider-error-2" }).state,
		).toBe("open");
	});

	test("clears auth failure evidence when credentials rotate", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-before-rotation",
			requestId: "request-before-rotation",
			credentialsExhausted: true,
		});
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-rotated",
			credentialsExhausted: false,
			routeSwitched: true,
		});
		expect(
			registry.recordAuthUnavailable(key, {
				kind: "auth_unavailable",
				receiptRef: "auth-after-rotation",
				requestId: "request-after-rotation",
				credentialsExhausted: true,
			}).state,
		).toBe("closed");
	});
	test("honors retry-after and allows one half-open probe", async () => {
		let now = 0;
		const registry = new ProviderHealthRegistry({ now: () => now, defaultRetryAfterMs: 100 });
		registry.recordRetryAfter(key, { kind: "retry_after", receiptRef: "429", retryAfterMs: 100 });
		await expect(registry.dispatch({ key }, async () => "blocked")).rejects.toBeInstanceOf(ProviderCircuitOpenError);
		now = 100;
		let calls = 0;
		const first = registry.dispatch({ key }, async () => {
			calls++;
			return "probe";
		});
		const second = registry.dispatch({ key }, async () => {
			calls++;
			return "after-probe";
		});
		expect(await first).toBe("probe");
		expect(await second).toBe("after-probe");
		expect(calls).toBe(2);
		expect(registry.status(key).state).toBe("closed");
	});

	test("reports dispatchability without consuming a half-open probe", async () => {
		let now = 0;
		const registry = new ProviderHealthRegistry({ now: () => now, defaultRetryAfterMs: 100 });
		expect(registry.hasDispatchableRoute()).toBe(false);
		registry.getSnapshot(key);
		expect(registry.hasDispatchableRoute()).toBe(true);

		registry.recordRetryAfter(key, { kind: "retry_after", receiptRef: "dispatchability-429", retryAfterMs: 100 });
		expect(registry.hasDispatchableRoute()).toBe(false);
		now = 100;
		expect(registry.hasDispatchableRoute()).toBe(true);

		const probeGate = Promise.withResolvers<void>();
		const probe = registry.dispatch({ key, requestId: "dispatchability-probe" }, async () => {
			await probeGate.promise;
			return "ok";
		});
		expect(registry.status(key).state).toBe("half_open");
		expect(registry.hasDispatchableRoute()).toBe(false);
		probeGate.resolve();
		await expect(probe).resolves.toBe("ok");
		expect(registry.hasDispatchableRoute()).toBe(true);
	});

	test("closes only after a successful assistant terminal", async () => {
		const now = 0;
		const registry = new ProviderHealthRegistry({ now: () => now });
		registry.recordRetryAfter(key, { kind: "retry_after", receiptRef: "429", retryAt: 0 });
		const source = new AssistantMessageEventStream();
		const observed = await registry.dispatchStream({ key, sessionId: "s1" }, () => source);
		expect(registry.status(key).state).toBe("half_open");
		source.push({ type: "done", reason: "stop", message: message() });
		await observed.result();
		expect(registry.status(key).state).toBe("closed");
	});

	test("requires repeated no-heartbeat stalls, preferably across sessions", () => {
		let now = 10;
		const registry = new ProviderHealthRegistry({ now: () => now, stallWindowMs: 1_000 });
		registry.recordStreamStall(key, {
			kind: "stream_stalled",
			receiptRef: "stall-a",
			sessionId: "session-a",
			noTerminal: true,
			noHeartbeat: true,
		});
		expect(registry.status(key).state).toBe("closed");
		now = 20;
		registry.recordStreamStall(key, {
			kind: "stream_stalled",
			receiptRef: "stall-b",
			sessionId: "session-b",
			noTerminal: true,
			noHeartbeat: true,
		});
		expect(registry.status(key).state).toBe("open");
	});

	test("does not count user aborts or persists bounded health state through the ledger", () => {
		const ledger = new ExecutionLedger({ scopeId: "scope", rootSessionId: "root", logicalTurnId: "turn" });
		const registry = new ProviderHealthRegistry({ ledger, now: () => 5_000 });
		registry.recordTerminalReceipt(key, {
			kind: "abort",
			receiptRef: "user-abort",
			error: new DOMException("cancelled", "AbortError"),
		});
		expect(registry.status(key).state).toBe("closed");
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-final",
			credentialsExhausted: true,
		});
		const replayed = new ProviderHealthRegistry({ ledger });
		expect(replayed.status(key).state).toBe("open");
		expect(ledger.getSnapshot().providerHealth[0]?.terminalReceiptRef).toBe("auth-final");
	});

	test("providerHealthRefFromSnapshot emits a complete credential-free ledger ref", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-final",
			credentialsExhausted: true,
			evidenceRefs: ["evidence-1"],
		});
		const snapshot = registry.status(key);
		expect(snapshot.state).toBe("open");
		const ref = providerHealthRefFromSnapshot(snapshot);
		expect(ref).toMatchObject({
			providerKey: "openai",
			endpoint: snapshot.endpoint,
			normalizedUrl: "https://example.test/v1?route=primary",
			modelKey: "gpt-test",
			state: "open",
			healthRevision: snapshot.healthRevision,
			generation: snapshot.generation,
			terminalReceiptRef: "auth-final",
			retryAt: 31_000,
			evidenceRefs: ["evidence-1"],
		});
		expect(ref).not.toHaveProperty("error");
		const serialized = JSON.stringify(ref);
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("secret");
	});

	test("subscribe returns a working unsubscribe", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		const seen: ProviderHealthEventType[] = [];
		const unsubscribe = registry.subscribe((event: ProviderHealthEvent) => seen.push(event.type));
		registry.recordRetryAfter(key, { kind: "retry_after", receiptRef: "retry-1", retryAfterMs: 10 });
		expect(seen).toContain("opened");
		unsubscribe();
		registry.recordRetryAfter(key, { kind: "retry_after", receiptRef: "retry-2", retryAfterMs: 10 });
		expect(seen.filter(type => type === "opened")).toHaveLength(1);
	});

	test("clear publishes a cleared event and resets health debt", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		const seen: ProviderHealthEventType[] = [];
		registry.subscribe((event: ProviderHealthEvent) => seen.push(event.type));
		registry.recordAuthUnavailable(key, authReceipt("request-1"));
		registry.recordAuthUnavailable(key, authReceipt("request-2"));
		expect(registry.status(key).state).toBe("open");
		registry.clear();
		expect(seen).toContain("cleared");
		expect(registry.status(key).state).toBe("closed");
		await expect(registry.dispatch({ key }, async () => "ok")).resolves.toBe("ok");
	});
});

describe("ProviderHealthRegistry half-open probe", () => {
	const unhandled: unknown[] = [];
	const captureUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};

	afterEach(() => {
		process.off("unhandledRejection", captureUnhandled);
		unhandled.length = 0;
	});

	/** Yield one macrotask so the runtime's unhandled-rejection detection runs. */
	function tick(): Promise<void> {
		// unhandledRejection is emitted during processTicksAndRejections (after the
		// microtask queue drains, before the next macrotask phase). A fake clock
		// cannot trigger it — it is runtime tick processing — so the only way to
		// observe the event deterministically is one event-loop turn.
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		return promise;
	}

	test("observes a lone probe failure so a zero-consumer rejection cannot crash the process", async () => {
		let now = 1_000;
		const registry = new ProviderHealthRegistry({
			now: () => now,
			failureThreshold: 1,
			defaultRetryAfterMs: 100,
		});
		const probeKey = createProviderHealthKey({ provider: "test", baseUrl: "https://example.com/v1" });

		// Open the circuit, then let the cooldown elapse so the next admit is a probe.
		registry.recordProviderError(probeKey, { receiptRef: "r1", error: new Error("boom") });
		expect(registry.getSnapshot(probeKey).state).toBe("open");
		now = 5_000;

		process.on("unhandledRejection", captureUnhandled);

		// This request becomes the probe and its operation fails with no other
		// request queued behind it. The probe promise rejection must be observed.
		await expect(
			registry.dispatch({ key: probeKey, requestId: "probe-1" }, async () => {
				// NOT a stall-text message — "upstream"/"timeout" etc. would be
				// classified as a stream stall and need stallThreshold (2) stalls.
				throw new Error("probe boom");
			}),
		).rejects.toThrow("probe boom");

		// Let the runtime detect any unobserved rejection before asserting.
		await tick();
		expect(unhandled).toEqual([]);

		// The probe failure re-opened the circuit with a future retryAt.
		const snapshot = registry.getSnapshot(probeKey);
		expect(snapshot.state).toBe("open");
		expect(snapshot.retryAt).toBeGreaterThan(now);
	});

	test("still propagates a probe rejection to a request queued behind it", async () => {
		let now = 1_000;
		const registry = new ProviderHealthRegistry({
			now: () => now,
			failureThreshold: 1,
			defaultRetryAfterMs: 100,
		});
		const probeKey = createProviderHealthKey({ provider: "test", baseUrl: "https://example.com/v1" });

		registry.recordProviderError(probeKey, { receiptRef: "r1", error: new Error("boom") });
		now = 5_000;

		const { promise: gate, resolve: release } = Promise.withResolvers<void>();

		// The probe is registered synchronously in admit() (no awaits before the
		// probe-creation return), so the queued request below is guaranteed to
		// see it — no timer needed.
		const probe = registry.dispatch({ key: probeKey, requestId: "probe-1" }, async () => {
			await gate;
			throw new Error("probe failed");
		});
		// Second request queues behind the in-flight probe.
		const queued = registry.dispatch({ key: probeKey, requestId: "queued-1" }, async () => "ok");
		// The queued dispatch promise rejects with ProviderCircuitOpenError the
		// moment the probe fails — before the test's await at the bottom attaches
		// a handler. Observe both immediately so bun's unhandled-rejection check
		// (which runs between microtask turns) never sees a handler-less promise.
		void probe.catch(() => undefined);
		void queued.catch(() => undefined);

		release();

		await expect(probe).rejects.toThrow("probe failed");
		// The queued request receives the probe's ProviderCircuitOpenError.
		await expect(queued).rejects.toBeInstanceOf(ProviderCircuitOpenError);
	});
});

describe("ProviderHealthRegistry request lifecycle", () => {
	test("aborts publish request_interrupted exactly once and never open the circuit", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		const seen: Array<{ type: ProviderHealthEventType; requestId?: string }> = [];
		registry.subscribe(event => seen.push({ type: event.type, requestId: event.requestId }));
		await expect(
			registry.dispatch({ key, requestId: "req-abort" }, async () => {
				throw new DOMException("user aborted", "AbortError");
			}),
		).rejects.toThrow("user aborted");
		expect(seen.filter(event => event.type.startsWith("request_"))).toEqual([
			{ type: "request_interrupted", requestId: "req-abort" },
		]);
		expect(registry.status(key).state).toBe("closed");
		// Abort 不累计 failure debt：随后一个普通失败仍按 threshold 从头计。
		expect(registry.recordProviderError(key, { receiptRef: "after-abort-1" }).state).toBe("closed");
		expect(registry.recordProviderError(key, { receiptRef: "after-abort-2" }).state).toBe("open");
	});

	test("duplicate requestId terminals are strict no-ops on health state", async () => {
		let now = 1_000;
		const registry = new ProviderHealthRegistry({ now: () => now, failureThreshold: 1, defaultRetryAfterMs: 500 });
		const seen: ProviderHealthEventType[] = [];
		registry.subscribe(event => seen.push(event.type));
		const firstGate = Promise.withResolvers<void>();
		const duplicateGate = Promise.withResolvers<void>();
		const first = registry.dispatch({ key, requestId: "req-dup", errorId: "error-1" }, async () => {
			await firstGate.promise;
			throw new Error("boom first");
		});
		const duplicate = registry.dispatch({ key, requestId: "req-dup", errorId: "error-2" }, async () => {
			await duplicateGate.promise;
			throw new Error("boom second");
		});
		void first.catch(() => undefined);
		void duplicate.catch(() => undefined);
		firstGate.resolve();
		await expect(first).rejects.toThrow("boom first");
		const afterFirst = registry.status(key);
		expect(afterFirst.state).toBe("open");
		// 同一 admission 窗口内的重复 terminal：claim 先于 mutation，snapshot/debt 严格不变。
		duplicateGate.resolve();
		await expect(duplicate).rejects.toThrow("boom second");
		expect(registry.status(key)).toEqual(afterFirst);
		expect(seen.filter(type => type.startsWith("request_"))).toEqual(["request_failed"]);
		// 新 requestId 在冷却期后仍正常累计失败 revision。
		now = 1_500;
		await expect(
			registry.dispatch({ key, requestId: "req-new", errorId: "error-3" }, async () => {
				throw new Error("boom third");
			}),
		).rejects.toThrow("boom third");
		expect(registry.status(key).healthRevision).toBeGreaterThan(afterFirst.healthRevision);
	});

	test("stream success publishes request_completed exactly once", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		const seen: Array<{ type: ProviderHealthEventType; requestId?: string }> = [];
		registry.subscribe(event => seen.push({ type: event.type, requestId: event.requestId }));
		const source = new AssistantMessageEventStream();
		const observed = await registry.dispatchStream({ key, requestId: "req-stream" }, () => source);
		source.push({ type: "done", reason: "stop", message: message() });
		await observed.result();
		expect(seen.filter(event => event.type.startsWith("request_"))).toEqual([
			{ type: "request_completed", requestId: "req-stream" },
		]);
	});

	test("a second stream terminal for the same requestId does not accumulate debt", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 3, defaultRetryAfterMs: 500 });
		const failing = new AssistantMessageEventStream();
		const observed = await registry.dispatchStream({ key, requestId: "req-stream-dup" }, () => failing);
		failing.fail(new Error("stream error"));
		await expect(observed.result()).rejects.toThrow("stream error");
		expect(registry.status(key).state).toBe("closed");
		// 同 requestId 的第二个 stream 失败被 claim 拦截：不累计 debt，仍 closed。
		const failing2 = new AssistantMessageEventStream();
		const observed2 = await registry.dispatchStream({ key, requestId: "req-stream-dup" }, () => failing2);
		failing2.fail(new Error("stream error again"));
		await expect(observed2.result()).rejects.toThrow("stream error again");
		expect(registry.status(key).state).toBe("closed");
		// 新 requestId 的失败正常计 debt：第二个新身份失败即 open。
		await expect(
			registry.dispatch({ key, requestId: "req-fresh-1" }, async () => {
				throw new Error("fresh one");
			}),
		).rejects.toThrow("fresh one");
		expect(registry.status(key).state).toBe("closed");
		await expect(
			registry.dispatch({ key, requestId: "req-fresh-2" }, async () => {
				throw new Error("fresh two");
			}),
		).rejects.toThrow("fresh two");
		expect(registry.status(key).state).toBe("open");
	});

	test("opens the circuit for repeated terminal 503 failures even outside the stall window", async () => {
		let now = 0;
		const registry = new ProviderHealthRegistry({ now: () => now, failureThreshold: 2, stallWindowMs: 60_000 });
		const failRequest = async (requestId: string): Promise<void> => {
			const source = new AssistantMessageEventStream();
			const observed = await registry.dispatchStream({ key, requestId }, () => source);
			source.fail(Object.assign(new Error("503 model_not_found: no distributor route"), { errorStatus: 503 }));
			await expect(observed.result()).rejects.toThrow("model_not_found");
		};

		await failRequest("req-model-unavailable-1");
		expect(registry.status(key).state).toBe("closed");
		now = 120_000;
		await failRequest("req-model-unavailable-2");
		expect(registry.status(key).state).toBe("open");
	});
});

describe("ProviderHealthRegistry branch reset", () => {
	test("equal-snapshot non-force reset is a strict no-op preserving waiters and in-flight requests", async () => {
		let now = 1_000;
		const registry = new ProviderHealthRegistry({ now: () => now, failureThreshold: 2 });
		registry.recordAuthUnavailable(key, authReceipt("request-1"));
		registry.recordAuthUnavailable(key, authReceipt("request-2"));
		expect(registry.status(key).state).toBe("open");
		const seen: ProviderHealthEventType[] = [];
		registry.subscribe(event => seen.push(event.type));
		let waiterSettled = false;
		void registry.waitForHealthy(key).then(() => {
			waiterSettled = true;
		});
		const gate = Promise.withResolvers<void>();
		// 冷却到期后同一路由进入 half-open，保留一个真实在途 probe。
		now = 31_000;
		const pending = registry.dispatch({ key, requestId: "req-inflight" }, async () => {
			await gate.promise;
			return "ok";
		});
		await Promise.resolve();
		expect(registry.status(key).state).toBe("half_open");
		registry.reset(registry.all());
		expect(seen).not.toContain("reset");
		expect(waiterSettled).toBe(false);
		expect(registry.status(key).state).toBe("half_open");
		gate.resolve();
		await expect(pending).resolves.toBe("ok");
		// 在途请求未被失效：success 发布 terminal、关闭同一路由并唤醒 waiter。
		expect(seen.filter(type => type.startsWith("request_"))).toEqual(["request_completed"]);
		await Promise.resolve();
		expect(waiterSettled).toBe(true);
	});

	test("equal-snapshot non-force reset preserves failure debt", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		registry.recordAuthUnavailable(key, authReceipt("request-debt-1"));
		expect(registry.status(key).state).toBe("closed");
		registry.reset(registry.all());
		// debt 保留：第二个失败身份即可 open；若 reset 清了 debt 则仍 closed。
		expect(registry.recordAuthUnavailable(key, authReceipt("request-debt-2")).state).toBe("open");
	});

	test("force reset rejects waiters, clears parked debt, and invalidates in-flight terminals", async () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000, failureThreshold: 2 });
		registry.recordAuthUnavailable(key, authReceipt("request-1"));
		registry.recordAuthUnavailable(key, authReceipt("request-2"));
		const parked = registry.park({ assignmentId: "assignment-cut", replaySafety: "safe" }, key, {
			retryAt: 9_999,
		});
		expect(parked.status).toBe("parked");
		const cutKey = createProviderHealthKey({ provider: "cut", baseUrl: "https://cut.test/v1" });
		const seen: Array<{ type: ProviderHealthEventType; requestId?: string }> = [];
		registry.subscribe(event => seen.push({ type: event.type, requestId: event.requestId }));
		const healthy = registry.waitForHealthy(key);
		let waiterRejected: unknown;
		void healthy.then(
			() => undefined,
			error => {
				waiterRejected = error;
			},
		);
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const pending = registry.dispatch({ key: cutKey, requestId: "req-cut" }, async () => {
			await gate;
			return "ok";
		});
		registry.reset(registry.all(), { force: true });
		expect(seen.map(event => event.type)).toContain("reset");
		await expect(healthy).rejects.toBeInstanceOf(ProviderHealthError);
		expect(waiterRejected).toBeInstanceOf(ProviderHealthError);
		expect(registry.parkedAssignments(key)).toEqual([]);
		release();
		await expect(pending).resolves.toBe("ok");
		// 旧分支晚到 success：无 request terminal、健康状态保持 reset 后的 open。
		expect(seen.filter(event => event.type.startsWith("request_"))).toEqual([]);
		expect(registry.status(key).state).toBe("open");
		// 同一 requestId 可在新分支重新 dispatch 并正常终结。
		await expect(registry.dispatch({ key: cutKey, requestId: "req-cut" }, async () => "ok")).resolves.toBe("ok");
		expect(seen.filter(event => event.type.startsWith("request_")).map(event => event.type)).toEqual([
			"request_completed",
		]);
	});

	test("reset with different snapshots atomically replaces branch state once", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		registry.recordAuthUnavailable(key, {
			kind: "auth_unavailable",
			receiptRef: "auth-old",
			credentialsExhausted: true,
		});
		expect(registry.status(key).state).toBe("open");
		const otherKey = createProviderHealthKey({ provider: "other", baseUrl: "https://other.test/v1" });
		const seen: ProviderHealthEventType[] = [];
		registry.subscribe(event => seen.push(event.type));
		registry.reset([registry.status(otherKey)]);
		expect(seen.filter(type => type === "reset")).toHaveLength(1);
		expect(registry.all().map(snapshot => snapshot.providerKey)).toEqual(["other"]);
		expect(registry.status(key).state).toBe("closed");
	});
});

describe("ProviderHealthRegistry home-path redaction", () => {
	test("normalizes home-directory paths without leaking usernames", () => {
		const macHome = normalizeProviderBaseUrl("file:///Users/alice/.san/providers/gateway");
		expect(macHome).not.toContain("alice");
		expect(macHome).not.toContain("/Users/");
		expect(macHome).toContain("gateway");
		const linuxHome = normalizeProviderBaseUrl("file:///home/bob/.san/providers/gateway");
		expect(linuxHome).not.toContain("bob");
		expect(linuxHome).not.toContain("/home/");
		expect(linuxHome).toContain("gateway");
		// 普通 HTTP API pathname 路由身份完整保留。
		expect(normalizeProviderBaseUrl("https://api.example.test/v1/chat/completions")).toBe(
			"https://api.example.test/v1/chat/completions",
		);
	});

	test("provider refs never leak home paths while preserving API routes", () => {
		const registry = new ProviderHealthRegistry({ now: () => 1_000 });
		const homeKey = createProviderHealthKey({
			provider: "local",
			baseUrl: "file:///Users/alice/.san/providers/gateway",
		});
		registry.recordAuthUnavailable(homeKey, {
			kind: "auth_unavailable",
			receiptRef: "auth-home",
			credentialsExhausted: true,
		});
		const serialized = JSON.stringify(providerHealthRefFromSnapshot(registry.status(homeKey)));
		expect(serialized).not.toContain("alice");
		expect(serialized).not.toContain("/Users/");
		const apiKey = createProviderHealthKey({
			provider: "openai",
			baseUrl: "https://api.example.test/v1/chat/completions",
		});
		expect(providerHealthRefFromSnapshot(registry.status(apiKey)).normalizedUrl).toBe(
			"https://api.example.test/v1/chat/completions",
		);
	});
});
