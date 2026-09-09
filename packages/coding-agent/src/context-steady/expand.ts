/**
 * 历史自助解压(agent 工具面的召回通道)。
 *
 * Coverage 体系保证「被 digest/checkpoint 替代的原始 journal 区间可重读」,
 * 此前重读通道只存在于系统侧(plan 组装期)。本模块把它开放给模型:按
 * digest 的 entry id 定位其 source 区间,从 append-only journal 原文提取
 * 消息并渲染为有界文本。与「digest 不能替代证据」原则同向 — 摘要不够用时,
 * 模型自己拉原文,而不是让宿主猜。
 *
 * 纯函数、无 IO:branch 由调用方(AgentSession)提供。
 */
import { parseContextSourceRef } from "./history-search";
import { type ContextMessageShape, contextMessageRoleLabel, contextMessageText } from "./message-text";
import { extractSpanMessages } from "./session";
import { TURN_DIGEST_CUSTOM_TYPE, type TurnDigest } from "./types";

export interface ExpandableBranchEntry {
	readonly id: string;
	readonly type: string;
	readonly message?: unknown;
	readonly customType?: string;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly display?: boolean;
	readonly attribution?: string;
	readonly data?: unknown;
}

export interface ContextExpandResult {
	readonly digestEntryId: string;
	readonly fromEntryId: string;
	readonly toEntryId: string;
	readonly messageCount: number;
	readonly truncated: boolean;
	/** Character offset used for a bounded page. */
	readonly offset?: number;
	/** Character offset for the next bounded page, when more source remains. */
	readonly nextOffset?: number;
	/** Rendered plain-text transcript of the expanded span. */
	readonly text: string;
}

/** 默认输出上限(字符)。原文区间可能很大;超限从头部截断并标注。 */
export const DEFAULT_EXPAND_MAX_CHARS = 30_000;

type SpanMessageShape = ContextMessageShape;

/**
 * 在 branch 中定位一条 turn digest entry 并返回其 TurnDigest 负载。
 * digest 以 custom entry 持久化,负载在 entry.data(appendCustomEntry 的存储形态)。
 */
export function findDigestEntry(
	branch: readonly ExpandableBranchEntry[],
	digestEntryId: string,
): TurnDigest | undefined {
	for (const entry of branch) {
		if (entry.id !== digestEntryId) continue;
		if (entry.type !== "custom" || entry.customType !== TURN_DIGEST_CUSTOM_TYPE) return undefined;
		const payload = entry.data;
		if (!payload || typeof payload !== "object") return undefined;
		// 与 collectDigestRefs 相同的形状验证:缺 schema/turnId/source 的负载不算 digest。
		if (!("schemaVersion" in payload) || !("turnId" in payload) || !("source" in payload)) return undefined;
		const digest = payload as TurnDigest;
		if (!digest.source?.fromEntryId || !digest.source?.toEntryId) return undefined;
		return digest;
	}
	return undefined;
}

/**
 * 把 digest 的 source 区间解压为有界文本转录。digest 不存在、类型不符或
 * source 区间不完整时返回 undefined(调用方给用户可解释的错误)。
 */
function boundedOffset(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function renderMessages(
	messages: SpanMessageShape[],
	maxChars: number,
	options: { paged: boolean; offset: number },
): {
	text: string;
	truncated: boolean;
	nextOffset?: number;
} {
	const sections: string[] = [];
	for (const message of messages) {
		const text = contextMessageText(message, { includeAttachments: true, includeError: true }).trim();
		if (!text) continue;
		sections.push(`── ${contextMessageRoleLabel(message)} ──\n${text}`);
	}
	const fullText = sections.join("\n\n");
	if (options.paged) {
		const start = Math.min(options.offset, fullText.length);
		const end = Math.min(fullText.length, start + maxChars);
		const page = fullText.slice(start, end);
		return {
			text: `${start > 0 ? "[… previous content omitted …]\n\n" : ""}${page}${end < fullText.length ? "\n\n[… more content available …]" : ""}`,
			truncated: start > 0 || end < fullText.length,
			nextOffset: end < fullText.length ? end : undefined,
		};
	}
	if (fullText.length <= maxChars) return { text: fullText, truncated: false };
	return {
		text: `[… truncated: span exceeds ${maxChars} chars; oldest content dropped …]\n\n${fullText.slice(fullText.length - maxChars)}`,
		truncated: true,
	};
}

/** Expand either a persisted digest source span or a direct journal source ref. */
export function expandDigestSpan(
	branch: readonly ExpandableBranchEntry[],
	digestEntryId: string,
	options: { maxChars?: number; offset?: number } = {},
): ContextExpandResult | undefined {
	const sourceEntryId = parseContextSourceRef(digestEntryId);
	let fromEntryId: string;
	let toEntryId: string;
	let messages: SpanMessageShape[];
	if (sourceEntryId) {
		const sourceEntry = branch.find(entry => entry.id === sourceEntryId);
		if (!sourceEntry || (sourceEntry.type !== "message" && sourceEntry.type !== "custom_message")) return undefined;
		fromEntryId = sourceEntryId;
		toEntryId = sourceEntryId;
		messages = extractSpanMessages(branch, sourceEntryId, sourceEntryId) as SpanMessageShape[];
	} else {
		const digest = findDigestEntry(branch, digestEntryId);
		if (!digest) return undefined;
		({ fromEntryId, toEntryId } = digest.source);
		messages = extractSpanMessages(branch, fromEntryId, toEntryId) as SpanMessageShape[];
	}
	const requestedMaxChars = options.maxChars ?? DEFAULT_EXPAND_MAX_CHARS;
	const maxChars = Number.isFinite(requestedMaxChars)
		? Math.min(DEFAULT_EXPAND_MAX_CHARS, Math.max(1_000, Math.floor(requestedMaxChars)))
		: DEFAULT_EXPAND_MAX_CHARS;
	const offset = boundedOffset(options.offset);
	const rendered = renderMessages(messages, maxChars, {
		paged: sourceEntryId !== undefined || options.offset !== undefined,
		offset,
	});
	return {
		digestEntryId,
		fromEntryId,
		toEntryId,
		messageCount: messages.length,
		truncated: rendered.truncated,
		offset: sourceEntryId !== undefined || options.offset !== undefined ? offset : undefined,
		nextOffset: rendered.nextOffset,
		text: rendered.text,
	};
}
