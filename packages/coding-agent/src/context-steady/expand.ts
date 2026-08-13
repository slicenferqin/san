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
	/** Rendered plain-text transcript of the expanded span. */
	readonly text: string;
}

/** 默认输出上限(字符)。原文区间可能很大;超限从头部截断并标注。 */
export const DEFAULT_EXPAND_MAX_CHARS = 30_000;

interface SpanMessageShape {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly customType?: unknown;
	readonly entryId?: unknown;
}

function blockToText(block: unknown): string {
	if (!block || typeof block !== "object") return "";
	const record = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown };
	if (record.type === "text" && typeof record.text === "string") return record.text;
	if (record.type === "toolCall") {
		const name = typeof record.name === "string" ? record.name : "tool";
		let args = "";
		try {
			args = JSON.stringify(record.arguments ?? {});
		} catch {
			args = "<unserializable args>";
		}
		if (args.length > 400) args = `${args.slice(0, 400)}…`;
		return `[tool call: ${name} ${args}]`;
	}
	if (record.type === "thinking") return "";
	return "";
}

function messageText(message: SpanMessageShape): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map(blockToText)
			.filter(part => part.length > 0)
			.join("\n");
	}
	return "";
}

function roleLabel(message: SpanMessageShape): string {
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (role === "custom" && typeof message.customType === "string") return `custom:${message.customType}`;
	return role;
}

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
export function expandDigestSpan(
	branch: readonly ExpandableBranchEntry[],
	digestEntryId: string,
	options: { maxChars?: number } = {},
): ContextExpandResult | undefined {
	const digest = findDigestEntry(branch, digestEntryId);
	if (!digest) return undefined;
	const { fromEntryId, toEntryId } = digest.source;
	const messages = extractSpanMessages(branch, fromEntryId, toEntryId) as SpanMessageShape[];
	const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_EXPAND_MAX_CHARS);

	const sections: string[] = [];
	for (const message of messages) {
		const text = messageText(message).trim();
		if (!text) continue;
		sections.push(`── ${roleLabel(message)} ──\n${text}`);
	}
	let text = sections.join("\n\n");
	let truncated = false;
	if (text.length > maxChars) {
		// 截头留尾:区间尾部离当前工作更近,信息价值通常更高。
		text = `[… truncated: span exceeds ${maxChars} chars; oldest content dropped …]\n\n${text.slice(text.length - maxChars)}`;
		truncated = true;
	}
	return {
		digestEntryId,
		fromEntryId,
		toEntryId,
		messageCount: messages.length,
		truncated,
		text,
	};
}
