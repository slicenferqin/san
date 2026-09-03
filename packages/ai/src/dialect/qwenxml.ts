/**
 * Qwen XML tool-call tagset (`<tool_call><function=NAME><parameter=KEY>…`).
 *
 * MiMo (xiaomi mimo-v2.x，经 opencode-go 等 OpenAI 兼容网关) has a habit of
 * mirroring its structured tool_calls into the visible text channel using this
 * Qwen2.5-style XML format. The stream-markup healer routes those text deltas
 * through this scanner so the duplicate markup is suppressed (structured calls
 * remain the source of truth) or, on hosts without structured calls, recovered
 * into real tool calls.
 *
 * The scanner is block-oriented: it buffers a whole `<tool_call>…</tool_call>`
 * span (bounded) and parses it in one shot, which tolerates the model's sloppy
 * variants (`<parameter i>` without `=`, newlines inside values).
 */

import type { InbandScanEvent, InbandScanner } from "./types";

const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";
/** Pathological runaway guard: a call span bigger than this is emitted as text. */
const MAX_CALL_BLOCK = 1_000_000;

const FUNCTION_RE = /<function=([^\n>]+)>/;
const PARAM_RE = /<parameter(?:=|\s)([^\s>]+)>([\s\S]*?)<\/parameter>/g;

/** Longest suffix of `text` that is a prefix of `token` (stream hold-back). */
function partialSuffixLength(text: string, token: string): number {
	const max = Math.min(text.length, token.length - 1);
	for (let len = max; len > 0; len--) {
		if (token.startsWith(text.slice(-len))) return len;
	}
	return 0;
}

export class QwenXmlInbandScanner implements InbandScanner {
	#outside = "";
	#inCall = "";

	feed(text: string): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		let rest = text;
		while (rest.length > 0) {
			if (this.#inCall.length > 0) {
				rest = this.#consumeCall(rest, events);
				continue;
			}
			// outside: emit text up to the next call opener (or hold back a partial one)
			this.#outside += rest;
			rest = "";
			const openAt = this.#outside.indexOf(CALL_OPEN);
			if (openAt >= 0) {
				const head = this.#outside.slice(0, openAt);
				if (head) events.push({ type: "text", text: head });
				this.#inCall = CALL_OPEN;
				rest = this.#outside.slice(openAt + CALL_OPEN.length);
				this.#outside = "";
				continue;
			}
			const hold = partialSuffixLength(this.#outside, CALL_OPEN);
			const emit = this.#outside.slice(0, this.#outside.length - hold);
			if (emit) events.push({ type: "text", text: emit });
			this.#outside = this.#outside.slice(this.#outside.length - hold);
		}
		return events;
	}

	#consumeCall(rest: string, events: InbandScanEvent[]): string {
		this.#inCall += rest;
		const closeAt = this.#inCall.indexOf(CALL_CLOSE);
		if (closeAt < 0) {
			if (this.#inCall.length > MAX_CALL_BLOCK) {
				events.push({ type: "text", text: this.#inCall });
				this.#inCall = "";
			}
			return "";
		}
		const block = this.#inCall.slice(0, closeAt + CALL_CLOSE.length);
		const tail = this.#inCall.slice(closeAt + CALL_CLOSE.length);
		this.#inCall = "";
		const parsed = parseCallBlock(block);
		if (parsed) {
			events.push({
				type: "toolEnd",
				id: `qwenxml-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
				name: parsed.name,
				arguments: parsed.arguments,
				rawBlock: block,
			});
		} else {
			// 完整但不符语法的块：按原文显示，不静默吞掉。
			events.push({ type: "text", text: block });
		}
		return tail;
	}

	flush(): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		if (this.#outside) {
			events.push({ type: "text", text: this.#outside });
			this.#outside = "";
		}
		// 未闭合的调用块按惯例丢弃（与 kimi/dsml 扫描器一致）。
		this.#inCall = "";
		return events;
	}
}

/** Parse one complete `<tool_call>…</tool_call>` block; undefined when it has no function tag. */
function parseCallBlock(block: string): { name: string; arguments: Record<string, unknown> } | undefined {
	const fn = FUNCTION_RE.exec(block);
	if (!fn?.[1]) return undefined;
	const name = fn[1].trim();
	if (!name) return undefined;
	const args: Record<string, unknown> = {};
	PARAM_RE.lastIndex = 0;
	for (let m = PARAM_RE.exec(block); m; m = PARAM_RE.exec(block)) {
		const key = m[1];
		if (!key) continue;
		// 值保持原始文本（命令/内容本就不是 JSON）；尾部的排版换行属于语法。
		args[key] = (m[2] ?? "").replace(/\n$/, "");
	}
	return { name, arguments: args };
}
