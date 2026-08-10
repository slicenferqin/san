import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@san/agent";
import type { Component } from "@san/tui";
import { Text } from "@san/tui";
import { prompt, untilAborted } from "@san/utils";
import { type } from "arktype";
import {
	CodeIntelligenceRuntime,
	type CodeIntelligenceRuntimeOptions,
	type ExploreResultDetails,
} from "../code-intelligence";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import exploreDescription from "../prompts/tools/explore.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import {
	formatErrorMessage,
	PREVIEW_LIMITS,
	previewLine,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const DEFAULT_MAX_FILES = 8;
const MAX_FILES_LIMIT = 20;
const MAX_QUERY_CHARS = 4_000;

const exploreSchema = type({
	query: type("string").describe("question, symbol, file name, endpoint, or code flow to explore"),
	"path?": type("string").describe("project directory or file; omitted -> current workspace"),
	"maxFiles?": type("number").describe("maximum source files to return (1-20); omitted -> 8"),
});

export type ExploreToolInput = typeof exploreSchema.infer;

function sanitizeDisplayText(text: string): string {
	const home = os.homedir();
	return text
		.split("\n")
		.map(line => truncateToWidth(replaceTabs(line).replaceAll(home, "~"), TRUNCATE_LENGTHS.LINE))
		.join("\n");
}

export class ExploreTool implements AgentTool<typeof exploreSchema, ExploreResultDetails> {
	readonly name = "explore";
	readonly approval = "read" as const;
	readonly label = "Explore";
	readonly summary = "Explore code relationships and current source through CodeGraph or local fallback";
	readonly description = prompt.render(exploreDescription);
	readonly parameters = exploreSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly #runtime: CodeIntelligenceRuntime;

	constructor(
		private readonly session: ToolSession,
		options?: CodeIntelligenceRuntimeOptions,
	) {
		this.#runtime = new CodeIntelligenceRuntime(session, options);
	}

	async execute(
		_toolCallId: string,
		params: ExploreToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ExploreResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ExploreResultDetails>> {
		return untilAborted(signal, async () => {
			const query = params.query.trim();
			if (!query) throw new ToolError("`query` must be non-empty");
			if (query.length > MAX_QUERY_CHARS) {
				throw new ToolError(`query exceeds the ${MAX_QUERY_CHARS}-character limit`);
			}
			const rawMaxFiles = params.maxFiles ?? DEFAULT_MAX_FILES;
			if (!Number.isFinite(rawMaxFiles) || rawMaxFiles < 1) {
				throw new ToolError("maxFiles must be a positive number");
			}
			const maxFiles = Math.min(MAX_FILES_LIMIT, Math.floor(rawMaxFiles));
			const projectPath = resolveToCwd(params.path?.trim() || ".", this.session.cwd);
			try {
				await fs.stat(projectPath);
			} catch (error) {
				throw new ToolError(`Cannot explore path: ${error instanceof Error ? error.message : String(error)}`);
			}

			const result = await this.#runtime.explore(
				{ query, path: projectPath, maxFiles },
				this.session.settings.get("san.codeIntelligence.maxOutputChars"),
				signal,
			);
			result.details.displayContent = sanitizeDisplayText(result.text);
			return toolResult(result.details).text(result.text).done();
		});
	}
}

interface ExploreRenderArgs {
	query?: string;
	path?: string;
	maxFiles?: number;
}

export const exploreToolRenderer = {
	inline: true,
	renderCall(args: ExploreRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta = args.path ? [`in ${previewLine(args.path, TRUNCATE_LENGTHS.CONTENT)}`] : [];
		return new Text(
			renderStatusLine(
				{
					icon: "pending",
					title: "Explore",
					description: previewLine(args.query ?? "?", TRUNCATE_LENGTHS.TITLE),
					meta,
				},
				uiTheme,
			),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ExploreResultDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ExploreRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content.find(item => item.type === "text")?.text ?? "Unknown explore error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}
		const details = result.details;
		const sourceCount = details?.sourceWindows.length ?? 0;
		const freshness = details?.freshness ?? "unavailable";
		const icon = freshness === "fresh" ? "success" : freshness === "unavailable" ? "warning" : "info";
		const header = renderStatusLine(
			{
				icon,
				title: "Explore",
				description: previewLine(args?.query ?? "", TRUNCATE_LENGTHS.TITLE),
				meta: [details?.provider ?? "unknown", freshness, `${sourceCount} window(s)`],
			},
			uiTheme,
		);
		const display = details?.displayContent ?? "";
		const lines = display.split("\n").filter(Boolean);
		const limit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
		const visible = lines.slice(0, limit);
		if (lines.length > visible.length) visible.push(`… ${lines.length - visible.length} more line(s)`);
		return new Text([header, ...visible.map(line => uiTheme.fg("dim", line))].join("\n"), 0, 0);
	},
};
