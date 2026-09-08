import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@san/agent";
import { prompt } from "@san/utils";
import { type } from "arktype";
import contextExpandDescription from "../prompts/tools/context-expand.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const contextExpandSchema = type({
	ref: type("string").describe("digest ref or source ref returned by context_search"),
	"maxChars?": type("number").describe("maximum characters to return in one page"),
	"offset?": type("number").describe("character offset for the next source page"),
});

type ContextExpandParams = typeof contextExpandSchema.infer;

export interface ContextExpandToolDetails {
	ref: string;
	fromEntryId?: string;
	toEntryId?: string;
	messageCount?: number;
	truncated?: boolean;
	offset?: number;
	nextOffset?: number;
	meta?: OutputMeta;
}

/**
 * Agent 自助召回工具(magic-context 对比研究 §4.5 的 San 版):把 context
 * packet 里某条 turn digest 的 source 区间从 append-only journal 解压回原文。
 * 只读、有界;实际提取由会话侧能力(`ToolSession.expandContextDigest`)完成,
 * 该能力仅在 context-steady 开启的根会话上存在。
 */
export class ContextExpandTool implements AgentTool<typeof contextExpandSchema, ContextExpandToolDetails> {
	readonly name = "context_expand";
	readonly approval = "read" as const;
	readonly label = "Context Expand";
	readonly summary = "Re-read the original messages behind a summarized turn digest";
	readonly description: string;
	readonly parameters = contextExpandSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<ContextExpandParams>) =>
		args.ref ? `expanding context ${args.ref}` : "expanding context";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextExpandDescription);
	}

	static createIf(session: ToolSession): ContextExpandTool | null {
		if (!session.expandContextDigest) return null;
		return new ContextExpandTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ContextExpandParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextExpandToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextExpandToolDetails>> {
		const expand = this.session.expandContextDigest;
		if (!expand) throw new ToolError("Context expansion is not available in this session.");
		const ref = params.ref.trim();
		if (!ref) throw new ToolError("A digest ref or source ref is required.");
		const result = expand(ref, { maxChars: params.maxChars, offset: params.offset });
		if (!result) {
			throw new ToolError(
				`No expandable context source found for ref ${ref}. Use a ref listed in the current context packet or context_search results.`,
			);
		}
		const kind = ref.startsWith("source:") ? "source" : "digest";
		const page = result.nextOffset === undefined ? "" : `, next offset ${result.nextOffset}`;
		const header =
			`Expanded ${kind} ${ref} (${result.messageCount} message${result.messageCount === 1 ? "" : "s"}, ` +
			`span ${result.fromEntryId} … ${result.toEntryId}${result.truncated ? ", truncated" : ""}${page}):`;
		return toolResult<ContextExpandToolDetails>({
			ref,
			fromEntryId: result.fromEntryId,
			toEntryId: result.toEntryId,
			messageCount: result.messageCount,
			truncated: result.truncated,
			offset: result.offset,
			nextOffset: result.nextOffset,
		})
			.text(`${header}\n\n${result.text}`)
			.done();
	}
}
