import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@san/agent";
import { prompt } from "@san/utils";
import { type } from "arktype";
import type { ContextHistorySearchHit } from "../context-steady/history-search";
import contextSearchDescription from "../prompts/tools/context-search.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const contextSearchSchema = type({
	query: type("string").describe("words or an exact phrase to find in earlier session history"),
	"limit?": type("number").describe("maximum number of matching entries"),
	"maxExcerptChars?": type("number").describe("maximum excerpt size per match"),
});

type ContextSearchParams = typeof contextSearchSchema.infer;

export interface ContextSearchToolDetails {
	query: string;
	total: number;
	hits: ContextHistorySearchHit[];
	meta?: OutputMeta;
}

export class ContextSearchTool implements AgentTool<typeof contextSearchSchema, ContextSearchToolDetails> {
	readonly name = "context_search";
	readonly approval = "read" as const;
	readonly label = "Context Search";
	readonly summary = "Find exact text in earlier session history";
	readonly description: string;
	readonly parameters = contextSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<ContextSearchParams>) =>
		args.query ? `searching context ${args.query}` : "searching context";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextSearchDescription);
	}

	static createIf(session: ToolSession): ContextSearchTool | null {
		if (!session.searchContextHistory) return null;
		return new ContextSearchTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ContextSearchParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextSearchToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextSearchToolDetails>> {
		const search = this.session.searchContextHistory;
		if (!search) throw new ToolError("Context history search is not available in this session.");
		const query = params.query.trim();
		if (!query) throw new ToolError("A non-empty history search query is required.");
		const result = search(query, { limit: params.limit, maxExcerptChars: params.maxExcerptChars });
		const lines = [`Found ${result.total} matching history entr${result.total === 1 ? "y" : "ies"}.`];
		for (const [index, hit] of result.hits.entries()) {
			const tool = hit.toolName ? ` tool=${hit.toolName}` : "";
			lines.push(`[${index + 1}] ${hit.ref} role=${hit.role}${tool} score=${hit.score}`);
			lines.push(hit.excerpt);
			lines.push("Use context_expand with this ref for the bounded original entry.");
		}
		if (result.hits.length === 0) lines.push("No matching original message or tool result was found.");
		return toolResult<ContextSearchToolDetails>({ query, total: result.total, hits: result.hits })
			.text(lines.join("\n\n"))
			.done();
	}
}
