import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { AssistantMessageEventStream } from "@san/ai/utils/event-stream";
import {
	createProviderHealthKey,
	ExecutionLedger,
	normalizeProviderBaseUrl,
	ProviderCircuitOpenError,
	ProviderHealthRegistry,
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
});
