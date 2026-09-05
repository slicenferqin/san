import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@san/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ToolCall } from "@san/ai/types";
import {
	getStreamMarkupHealingPattern,
	modelMayLeakQwenXmlToolCalls,
	StreamMarkupHealing,
} from "@san/ai/utils/stream-markup-healing";
import { buildModel } from "@san/catalog/build";
import { getBundledModel } from "@san/catalog/models";

/**
 * MiMo (mimo-v2.x, opencode-go 等 OpenAI 兼容网关) mirrors its structured
 * tool_calls into `delta.content` as Qwen-style XML:
 *
 *   <tool_call>
 *   <function=bash>
 *   <parameter=command>git status</parameter>
 *   <parameter i>Check repo state</parameter>
 *   </function>
 *   </tool_call>
 *
 * Without a dedicated healing grammar the mirror renders as raw command prose
 * in the transcript (reported from san-desktop on opencode-go/mimo-v2.5).
 */

const MIMO_MIRROR =
	'<tool_call>\n<function=bash>\n<parameter=command>git log --oneline -5 2>/dev/null || echo "tag not reachable"</parameter>\n<parameter i>Check latest tag content</parameter>\n</function>\n</tool_call>';

function mimoModel(): Model<"openai-completions"> {
	return buildModel({
		id: "mimo-v2.5",
		name: "MiMo V2.5",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8_192,
	});
}

interface SseChoiceDelta {
	content?: string;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: "function";
		function?: { name?: string; arguments?: string };
	}>;
}

function chunk(model: string, delta: SseChoiceDelta, finish: "stop" | "tool_calls" | null = null) {
	return {
		id: "chatcmpl-mimo-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function mockFetch(events: ReadonlyArray<unknown | "[DONE]">): FetchImpl {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	const fn = async (): Promise<Response> =>
		new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return { messages: [{ role: "user", content: "check the tag", timestamp: Date.now() }] };
}

describe("MiMo Qwen-XML leak pattern selection", () => {
	it("routes mimo models to qwenxml healing", () => {
		expect(getStreamMarkupHealingPattern("opencode-go", "mimo-v2.5")).toBe("qwenxml");
		expect(getStreamMarkupHealingPattern("opencode-go", "mimo-v2.5-pro")).toBe("qwenxml");
		expect(modelMayLeakQwenXmlToolCalls("opencode-go", "mimo-v2.5")).toBe(true);
		// 非 mimo 模型不受影响。
		expect(getStreamMarkupHealingPattern("opencode-go", "kimi-k2.6")).toBe("kimi");
		expect(getStreamMarkupHealingPattern("openrouter", "google/gemini-3.5-flash")).toBe("thinking");
	});

	it("bundled opencode-go mimo compat resolves the qwenxml pattern", () => {
		const model = getBundledModel("opencode-go", "mimo-v2.5");
		const compat = model.compat as Record<string, unknown> | undefined;
		expect(compat?.streamMarkupHealingPattern).toBe("qwenxml");
	});
});

describe("StreamMarkupHealing qwenxml grammar", () => {
	it("recovers the mirrored call and strips its markup from visible text", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwenxml" });
		const events = healing.feedEvents(`查一下标签。\n${MIMO_MIRROR}\n`);
		const text = events
			.filter(e => e.type === "text")
			.map(e => e.text)
			.join("");
		const calls = events.filter(e => e.type === "toolCall").map(e => e.call);
		expect(text).toBe("查一下标签。\n\n");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("bash");
		const args = JSON.parse(calls[0]!.arguments);
		expect(args.command).toBe('git log --oneline -5 2>/dev/null || echo "tag not reachable"');
		// `<parameter i>`（缺 `=` 的变体）也要容忍。
		expect(args.i).toBe("Check latest tag content");
	});

	it("parses identically when streamed character by character", () => {
		const whole = new StreamMarkupHealing({ pattern: "qwenxml" });
		const wholeText = whole.feed(`前缀。\n${MIMO_MIRROR}`);
		const wholeCalls = whole.drainCompleted();

		const dribble = new StreamMarkupHealing({ pattern: "qwenxml" });
		let dribbleText = "";
		for (const ch of `前缀。\n${MIMO_MIRROR}`) {
			dribbleText += dribble.feed(ch);
		}
		dribbleText += dribble.flushPending();
		const dribbleCalls = dribble.drainCompleted();

		expect(dribbleText).toBe(wholeText);
		expect(dribbleCalls.map(c => c.name)).toEqual(wholeCalls.map(c => c.name));
		expect(dribbleCalls.map(c => c.arguments)).toEqual(wholeCalls.map(c => c.arguments));
	});

	it("suppresses the mirrored call when structured tool_calls are authoritative", () => {
		const healing = new StreamMarkupHealing({ pattern: "qwenxml" });
		const events = healing.feedEventsWithoutCalls(`前缀。\n${MIMO_MIRROR}`);
		const text = events
			.filter(e => e.type === "text")
			.map(e => e.text)
			.join("");
		expect(text).toBe("前缀。\n");
		expect(events.some(e => e.type === "toolCall")).toBe(false);
	});

	it("drops an unterminated call block at flush and passes through malformed blocks", () => {
		const truncated = new StreamMarkupHealing({ pattern: "qwenxml" });
		truncated.feed("前文。\n<tool_call>\n<function=bash>\n<parameter=command>ls");
		expect(truncated.flushPending()).toBe("");
		expect(truncated.drainCompleted()).toHaveLength(0);

		const malformed = new StreamMarkupHealing({ pattern: "qwenxml" });
		const events = malformed.feedEvents("<tool_call>\nnot a function block\n</tool_call>");
		const text = events
			.filter(e => e.type === "text")
			.map(e => e.text)
			.join("");
		expect(text).toContain("not a function block");
	});
});

describe("openai-completions mimo mirror end-to-end", () => {
	it("keeps structured tool_calls authoritative and strips the XML mirror", async () => {
		const model = mimoModel();
		const fetchMock = mockFetch([
			chunk(model.id, { content: "开始同步。\n" }),
			chunk(model.id, {
				content: MIMO_MIRROR,
				tool_calls: [
					{
						index: 0,
						id: "call_abc123",
						type: "function",
						function: { name: "bash", arguments: '{"command": "git log --oneline -5"}' },
					},
				],
			}),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test",
			fetch: fetchMock,
		}).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		// 正文只剩散文，XML 镜像被剥离；结构化调用是唯一事实来源。
		expect(text).toBe("开始同步。\n");
		expect(text).not.toContain("<tool_call>");
		expect(text).not.toContain("git log");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]!.name).toBe("bash");
	});
});
