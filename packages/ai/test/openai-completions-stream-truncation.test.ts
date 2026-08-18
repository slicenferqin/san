// Regression coverage for silent truncation in the OpenAI-compatible
// chat-completions stream parser.
//
// Two failure shapes previously surfaced as a clean "stop" and silently
// delivered partial work:
//   1. The transport closes after non-empty assistant content without any
//      `finish_reason` chunk (premature EOF) — now a retryable
//      incomplete-stream error via the existing `ProviderResponseError` kind.
//   2. `finish_reason: "insufficient_system_resource"` (vLLM/SGLang/gateway
//      OOM or context exhaustion) — now classified as a retryable
//      provider-finish error instead of an unknown non-retryable reason.
//
// Empty streams keep the existing empty-completion retry path, and normal
// text/tool completions are untouched.
import { describe, expect, it } from "bun:test";
import * as AIError from "@san/ai/error";
import { streamOpenAICompletions } from "@san/ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model } from "@san/ai/types";
import { getBundledModel } from "@san/catalog/models";

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
		id: "chatcmpl-truncation",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("openai-completions stream closure", () => {
	it("errors on non-empty premature EOF instead of delivering a clean stop", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: { content: "lo" } }] }),
			// No finish_reason chunk, no [DONE] — the transport just closes.
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream closed before a finish_reason was received");
		// The partial content is preserved on the error result.
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		// Kind "incomplete-stream" attaches the existing Transient flag, so the
		// retry machinery recognizes this as retryable.
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	}, 10_000);

	it("errors on premature EOF mid-tool-call instead of promoting to toolUse", async () => {
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
									function: { name: "read", arguments: '{"pat' },
								},
							],
						},
					},
				],
			}),
			// Truncated mid-arguments; no finish_reason chunk follows.
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream closed before a finish_reason was received");
		expect(AIError.retriable(result.errorId)).toBe(true);
	}, 10_000);

	it("keeps retrying a stream that closes empty before delivering content", async () => {
		let attempts = 0;
		const fetchMock: FetchImpl = async (_input: string | URL | Request, _init?: RequestInit) => {
			attempts++;
			if (attempts === 1) {
				// Degenerate empty stream: a lone [DONE] sentinel and nothing else.
				return createSseFetch(["[DONE]"])(_input, _init);
			}
			return createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "recovered" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
				"[DONE]",
			])(_input, _init);
		};

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	}, 10_000);

	it("keeps normal text completion unchanged", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	}, 10_000);

	it("keeps normal tool-call completion unchanged", async () => {
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
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		const calls = result.content.filter(
			(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				block.type === "toolCall",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
	}, 10_000);
});
