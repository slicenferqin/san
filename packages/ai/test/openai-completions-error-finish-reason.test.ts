// Regression coverage for gateways (OpenRouter, Vercel AI Gateway, …) that
// report upstream model failures as a bare `finish_reason: "error"` — e.g.
// Gemini MALFORMED_FUNCTION_CALL behind an OpenAI-compat endpoint. The mapped
// error message must match the session retry classifier's transient-transport
// pattern (`provider.?returned.?error` in agent-session's
// #isTransientTransportErrorMessage) so the turn is auto-retried instead of
// stopping with a pinned error banner.
import { describe, expect, it } from "bun:test";
import * as AIError from "@san/ai/error";
import { streamOpenAICompletions } from "@san/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@san/ai/types";
import { getBundledModel } from "@san/catalog/models";

// Mirrors the transient-transport alternative the session retry gate matches on.
const RETRYABLE_PATTERN = /provider.?returned.?error/i;

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-error-finish",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("finish_reason: error", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);

	it("stays an error even when the stream carried tool calls", async () => {
		// The user-visible failure mode: the model garbles a tool call, the
		// gateway ends the stream with `finish_reason: "error"`. Tool-call
		// promotion (stop → toolUse) must not paper over the error finish.
		const fetchMock = createSseFetch([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"pattern":"x"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);

	it("classifies finish_reason insufficient_system_resource as retryable", async () => {
		// vLLM/SGLang and gateway proxies report the system failing to complete
		// generation (worker OOM / context exhaustion) as this non-standard
		// finish reason. It must surface as an error and classify through the
		// existing provider-finish-error / transient flags so the turn is
		// auto-retried instead of surfacing OK with a truncated answer.
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
		expect(AIError.is(result.errorId, AIError.Flag.ProviderFinishError)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	}, 10_000);
});
