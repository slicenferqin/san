import * as path from "node:path";
import { $which, logger } from "@san/utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { callTool, connectToServer, disconnectServer, listTools } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import type { MCPServerConnection, MCPToolCallResult } from "../mcp/types";
import type { ToolSession } from "../tools";
import { findCodeGraphRoot } from "./codegraph-installation";
import type {
	CodeIntelligenceFreshness,
	CodeIntelligenceProvider,
	CodeIntelligenceResult,
	ExploreRequest,
	SourceLineRange,
	SourceWindowHint,
} from "./types";

const CODEGRAPH_EXPLORE_TOOL = "codegraph_explore";
const CODEGRAPH_STATUS_TOOL = "codegraph_status";
const CODEGRAPH_INTERNAL_SERVER = "san-codegraph";
const CODEGRAPH_MCP_TIMEOUT_MS = 60_000;

interface CodeGraphToolLocation {
	serverName: string;
	exploreToolName: string;
	statusToolName?: string;
}

function textFromMCPResult(result: MCPToolCallResult): string {
	return result.content
		.filter(item => item.type === "text")
		.map(item => item.text)
		.join("\n\n");
}

function cleanMarkdownValue(value: string): string {
	return Bun.stripANSI(value)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.trim();
}

function markdownSection(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const normalizedHeading = heading.toLowerCase();
	const start = lines.findIndex(line => {
		const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
		return match?.[2]?.toLowerCase().startsWith(normalizedHeading) === true;
	});
	if (start < 0) return [];
	const headingDepth = /^(#+)/.exec(lines[start] ?? "")?.[1]?.length ?? 3;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		const depth = /^(#+)\s+/.exec(lines[index] ?? "")?.[1]?.length;
		if (depth !== undefined && depth <= headingDepth) {
			end = index;
			break;
		}
	}
	return lines.slice(start + 1, end);
}

function parseMarkdownListSection(text: string, heading: string): string[] {
	const section = markdownSection(text, heading);
	const output: string[] = [];
	let relationshipKind = "";
	for (const rawLine of section) {
		const line = cleanMarkdownValue(rawLine);
		if (!line) continue;
		const kindMatch = /^\*\*([^*]+):\**$/.exec(line);
		if (kindMatch) {
			relationshipKind = kindMatch[1]?.trim() ?? "";
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(line)?.[1];
		if (!bullet) continue;
		output.push(relationshipKind ? `${relationshipKind}: ${bullet}` : bullet);
	}
	return output;
}

function mergeLineRanges(ranges: SourceLineRange[]): SourceLineRange[] {
	const sorted = ranges
		.filter(range => Number.isFinite(range.startLine) && Number.isFinite(range.endLine))
		.map(range => ({
			startLine: Math.max(1, Math.floor(Math.min(range.startLine, range.endLine))),
			endLine: Math.max(1, Math.floor(Math.max(range.startLine, range.endLine))),
		}))
		.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: SourceLineRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

/** Parse provider-specific Markdown into San's provider-neutral source pointers. */
export function parseCodeGraphSourceWindows(text: string): SourceWindowHint[] {
	const lines = text.split("\n");
	const sourceStart = lines.findIndex(line => /^###\s+Source Code\s*$/i.test(line.trim()));
	if (sourceStart < 0) return [];

	const byPath = new Map<string, SourceLineRange[]>();
	let currentPath: string | undefined;
	let currentRange: SourceLineRange | undefined;
	let inFence = false;

	const closeRange = () => {
		if (!currentPath || !currentRange) return;
		const ranges = byPath.get(currentPath) ?? [];
		ranges.push(currentRange);
		byPath.set(currentPath, ranges);
		currentRange = undefined;
	};

	for (let index = sourceStart + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (/^###\s+/.test(line)) break;
		const header = /^####\s+(.+?)(?:\s+—\s+.*)?$/.exec(line.trim());
		if (header) {
			closeRange();
			currentPath = header[1]?.replace(/^`|`$/g, "").trim();
			continue;
		}
		if (/^```/.test(line.trim())) {
			if (inFence) closeRange();
			inFence = !inFence;
			continue;
		}
		if (!inFence || !currentPath) continue;
		const numbered = /^(\d+)(?:\t|:|\|)/.exec(line);
		if (!numbered) continue;
		const lineNumber = Number(numbered[1]);
		if (!Number.isFinite(lineNumber) || lineNumber < 1) continue;
		if (currentRange && lineNumber === currentRange.endLine + 1) {
			currentRange.endLine = lineNumber;
		} else {
			closeRange();
			currentRange = { startLine: lineNumber, endLine: lineNumber };
		}
	}
	closeRange();

	return Array.from(byPath, ([windowPath, ranges]) => ({
		path: windowPath,
		ranges: mergeLineRanges(ranges),
	}));
}

function pathLikeValues(lines: string[]): string[] {
	const values: string[] = [];
	const seen = new Set<string>();
	for (const rawLine of lines) {
		for (const match of rawLine.matchAll(/`([^`]+)`/g)) {
			const value = match[1]?.trim();
			if (!value || seen.has(value) || !/[./\\]/.test(value)) continue;
			seen.add(value);
			values.push(value);
		}
		const bullet = /^\s*[-*]\s+([^\s(]+)(?:\s|$)/.exec(rawLine)?.[1]?.replace(/^`|`$/g, "");
		if (bullet && /[./\\]/.test(bullet) && !seen.has(bullet)) {
			seen.add(bullet);
			values.push(bullet);
		}
	}
	return values;
}

function parsePendingFiles(exploreText: string, statusText: string): string[] {
	const statusPending = markdownSection(statusText, "Pending sync");
	const prefix = exploreText.split(/^##\s+Exploration:/m, 1)[0] ?? "";
	const explorePending = /edited since|pending re-index|pending sync/i.test(prefix) ? prefix.split("\n") : [];
	return pathLikeValues([...statusPending, ...explorePending]);
}

function parseFreshness(exploreText: string, statusText: string, pendingFiles: string[]): CodeIntelligenceFreshness {
	const combined = `${statusText}\n${exploreText}`;
	if (/different git (?:working tree|worktree)|worktree mismatch|stale index/i.test(combined)) return "stale-index";
	if (pendingFiles.length > 0 || /edited since the last index sync|pending re-index/i.test(combined)) {
		return "pending-files";
	}
	return "fresh";
}

function parseRepositoryFileCount(statusText: string): number | undefined {
	const match = /\*\*Files indexed:\*\*\s*([\d,]+)/i.exec(statusText);
	if (!match) return undefined;
	const value = Number(match[1]?.replaceAll(",", ""));
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseCodeGraphExploreResult(
	exploreText: string,
	statusText = "",
	sourceRoot?: string,
): CodeIntelligenceResult {
	const pendingFiles = parsePendingFiles(exploreText, statusText);
	const sourceWindows = parseCodeGraphSourceWindows(exploreText).map(window => ({
		...window,
		path: sourceRoot && !path.isAbsolute(window.path) ? path.resolve(sourceRoot, window.path) : window.path,
	}));
	return {
		provider: "codegraph",
		freshness: parseFreshness(exploreText, statusText, pendingFiles),
		sourceWindows,
		relationships: parseMarkdownListSection(exploreText, "Relationships"),
		blastRadius: parseMarkdownListSection(exploreText, "Blast radius"),
		pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
		repositoryFileCount: parseRepositoryFileCount(statusText),
	};
}

export function isCodeGraphMCPTool(tool: Pick<CustomTool, "mcpToolName">): boolean {
	return tool.mcpToolName?.startsWith("codegraph_") === true;
}

export function filterPresentedCodeGraphTools<T extends Pick<CustomTool, "mcpToolName">>(
	tools: readonly T[],
	codeIntelligenceEnabled: boolean,
): T[] {
	return codeIntelligenceEnabled ? tools.filter(tool => !isCodeGraphMCPTool(tool)) : [...tools];
}

export function codeGraphMCPServerNames(
	tools: readonly Pick<CustomTool, "mcpServerName" | "mcpToolName">[],
): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isCodeGraphMCPTool(tool) && tool.mcpServerName) names.add(tool.mcpServerName);
	}
	return names;
}

export function filterCodeGraphServerInstructions(
	instructions: Map<string, string> | undefined,
	tools: readonly Pick<CustomTool, "mcpServerName" | "mcpToolName">[],
	codeIntelligenceEnabled: boolean,
): Map<string, string> | undefined {
	if (!instructions || !codeIntelligenceEnabled) return instructions;
	const hiddenServers = codeGraphMCPServerNames(tools);
	if (hiddenServers.size === 0) return instructions;
	return new Map(Array.from(instructions).filter(([name]) => !hiddenServers.has(name)));
}

function findManagerTool(manager: MCPManager): CodeGraphToolLocation | undefined {
	const explore = manager.getTools().find(tool => tool.mcpToolName === CODEGRAPH_EXPLORE_TOOL);
	if (!explore?.mcpServerName) return undefined;
	const status = manager
		.getTools()
		.find(tool => tool.mcpServerName === explore.mcpServerName && tool.mcpToolName === CODEGRAPH_STATUS_TOOL);
	return {
		serverName: explore.mcpServerName,
		exploreToolName: explore.mcpToolName ?? CODEGRAPH_EXPLORE_TOOL,
		statusToolName: status?.mcpToolName,
	};
}

async function invokeCodeGraph(
	connection: MCPServerConnection,
	location: Omit<CodeGraphToolLocation, "serverName">,
	request: ExploreRequest,
	projectPath: string | undefined,
	signal?: AbortSignal,
): Promise<CodeIntelligenceResult | null> {
	const projectArgs = projectPath ? { projectPath } : {};
	const statusResult = location.statusToolName
		? await callTool(connection, location.statusToolName, projectArgs, { signal }).catch(() => null)
		: null;
	const result = await callTool(
		connection,
		location.exploreToolName,
		{ query: request.query, ...projectArgs, maxFiles: request.maxFiles },
		{ signal },
	);
	if (result.isError) return null;
	const text = textFromMCPResult(result);
	if (!text || /project (?:isn't|is not) initialized|\.codegraph\/.*does not exist/i.test(text)) return null;
	return parseCodeGraphExploreResult(
		text,
		statusResult && !statusResult.isError ? textFromMCPResult(statusResult) : "",
		projectPath,
	);
}
function rethrowAbort(error: unknown, signal?: AbortSignal): void {
	if (signal?.aborted) throw error;
	if (error instanceof Error && error.name === "AbortError") throw error;
}

export class CodeGraphProvider implements CodeIntelligenceProvider {
	constructor(private readonly session: ToolSession) {}

	async explore(request: ExploreRequest, signal?: AbortSignal): Promise<CodeIntelligenceResult | null> {
		const projectRoot = await findCodeGraphRoot(request.path);
		const manager = this.session.mcpManager;
		const managerTool = manager ? findManagerTool(manager) : undefined;
		if (manager && managerTool) {
			try {
				const connection = await manager.waitForConnection(managerTool.serverName);
				const result = await invokeCodeGraph(connection, managerTool, request, projectRoot ?? undefined, signal);
				if (result) return result;
			} catch (error) {
				rethrowAbort(error, signal);
				logger.debug("Configured CodeGraph MCP provider failed; trying installed provider", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const executable = projectRoot ? $which("codegraph") : null;
		if (!projectRoot || !executable) return null;

		let connection: MCPServerConnection | undefined;
		try {
			connection = await connectToServer(
				CODEGRAPH_INTERNAL_SERVER,
				{
					type: "stdio",
					command: executable,
					args: ["serve", "--mcp"],
					cwd: projectRoot,
					timeout: CODEGRAPH_MCP_TIMEOUT_MS,
				},
				{ signal },
			);
			const definitions = await listTools(connection);
			const hasExplore = definitions.some(tool => tool.name === CODEGRAPH_EXPLORE_TOOL);
			if (!hasExplore) return null;
			const hasStatus = definitions.some(tool => tool.name === CODEGRAPH_STATUS_TOOL);
			return await invokeCodeGraph(
				connection,
				{
					exploreToolName: CODEGRAPH_EXPLORE_TOOL,
					statusToolName: hasStatus ? CODEGRAPH_STATUS_TOOL : undefined,
				},
				request,
				projectRoot,
				signal,
			);
		} catch (error) {
			rethrowAbort(error, signal);
			logger.debug("Installed CodeGraph MCP provider unavailable; using local fallback", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		} finally {
			if (connection) {
				await disconnectServer(connection).catch(() => {});
			}
		}
	}
}
