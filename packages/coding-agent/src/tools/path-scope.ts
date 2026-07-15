import * as fs from "node:fs";
import * as path from "node:path";
import { parseFindPattern, parseSearchPath, resolveToCwd, splitPathAndSel, toPathList } from "./path-utils";
import { ToolError } from "./tool-errors";

const PATHLESS_SCOPED_TOOLS = new Set(["web_search", "yield"]);
const SEARCH_PATH_TOOLS = new Set(["ast_grep", "glob", "grep"]);
const DIRECT_PATH_TOOLS = new Set(["inspect_image", "read", "write"]);
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const IMAGE_ATTACHMENT_REFERENCE = /^\s*(?:\[?Image #[1-9]\d*(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/[1-9]\d*)\s*$/i;

export interface ToolPathScopeOptions {
	args: Record<string, unknown>;
	toolName: string;
	cwd: string;
	scopeRoot: string;
}

interface ResolvedPathScope {
	logicalRoot: string;
	canonicalRoot: string;
}

function scopeError(toolName: string, reason: string): ToolError {
	return new ToolError(`Workflow path scope blocked ${toolName}: ${reason}`);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve all existing path components, including symlinks, while retaining a
 * missing or glob-shaped suffix. The SDK argument-transform hook is
 * synchronous, so this authorization check deliberately uses the synchronous
 * filesystem API before tool execution.
 */
function canonicalizeExistingPrefix(candidate: string, toolName: string): string {
	let current = path.resolve(candidate);
	const suffix: string[] = [];
	while (true) {
		try {
			const canonical = fs.realpathSync.native(current);
			return path.resolve(canonical, ...suffix);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw scopeError(toolName, "the path could not be verified");
			}
		}
		const parent = path.dirname(current);
		if (parent === current) throw scopeError(toolName, "the path could not be verified");
		suffix.unshift(path.basename(current));
		current = parent;
	}
}

function canonicalLocalPath(rawPath: string, options: ToolPathScopeOptions, scope: ResolvedPathScope): string {
	const candidate = rawPath.trim();
	if (!candidate) throw scopeError(options.toolName, "path must not be empty");
	if (candidate.includes("\0")) throw scopeError(options.toolName, "path contains an invalid character");
	if (IMAGE_ATTACHMENT_REFERENCE.test(candidate)) {
		throw scopeError(options.toolName, "image attachments are outside the approved filesystem scope");
	}
	if (URI_SCHEME.test(candidate) && !WINDOWS_DRIVE_PATH.test(candidate)) {
		throw scopeError(options.toolName, "URLs and internal resources are outside the approved filesystem scope");
	}

	let resolved: string;
	try {
		resolved = resolveToCwd(candidate, options.cwd);
	} catch {
		throw scopeError(options.toolName, "URLs and internal resources are outside the approved filesystem scope");
	}
	if (!isWithin(scope.logicalRoot, resolved)) {
		throw scopeError(options.toolName, "path escapes the approved directory");
	}
	const canonical = canonicalizeExistingPrefix(resolved, options.toolName);
	if (!isWithin(scope.canonicalRoot, canonical)) {
		throw scopeError(options.toolName, "path resolves outside the approved directory");
	}
	return canonical;
}

function splitTopLevelPathCandidates(input: string): string[] {
	const candidates = [input];
	let braceDepth = 0;
	let start = 0;
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (character === "\\" && index + 1 < input.length) {
			index++;
			continue;
		}
		if (character === "{") {
			braceDepth++;
			continue;
		}
		if (character === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (character !== ";" && character !== "," && !/\s/.test(character))) continue;
		const part = input.slice(start, index).trim();
		if (part) candidates.push(part);
		start = index + 1;
	}
	const tail = input.slice(start).trim();
	if (tail && start > 0) candidates.push(tail);
	return [...new Set(candidates)];
}

function searchBasePath(toolName: string, rawPath: string): string {
	const peeled = splitPathAndSel(rawPath).path;
	return toolName === "glob" ? parseFindPattern(peeled).basePath : parseSearchPath(peeled).basePath;
}

function assertSearchPath(rawPath: string, options: ToolPathScopeOptions, scope: ResolvedPathScope): void {
	for (const candidate of splitTopLevelPathCandidates(rawPath)) {
		canonicalLocalPath(candidate, options, scope);
		canonicalLocalPath(searchBasePath(options.toolName, candidate), options, scope);
	}
}

function canonicalSearchPath(rawPath: string, options: ToolPathScopeOptions, scope: ResolvedPathScope): string {
	const parsed = options.toolName === "glob" ? parseFindPattern(rawPath) : parseSearchPath(rawPath);
	const basePath = canonicalLocalPath(parsed.basePath, options, scope);
	if (options.toolName === "glob") {
		const find = parseFindPattern(rawPath);
		return find.hasGlob ? path.join(basePath, find.globPattern) : basePath;
	}
	const search = parseSearchPath(rawPath);
	return search.glob ? path.join(basePath, search.glob) : basePath;
}

function requiredString(args: Record<string, unknown>, key: string, toolName: string): string {
	const value = args[key];
	if (typeof value !== "string") throw scopeError(toolName, `${key} must be a string`);
	return value;
}

function canonicalEditInput(input: string, options: ToolPathScopeOptions, scope: ResolvedPathScope): string {
	const paths: string[] = [];
	for (const line of input.split(/\r?\n/)) {
		const applyPatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line.trim());
		if (applyPatch?.[1]) paths.push(applyPatch[1].trim());
		const move = /^\*\*\* Move to:\s*(.+)$/.exec(line.trim());
		if (move?.[1]) paths.push(move[1].trim());
		const hashline = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/.exec(line.trim());
		if (hashline?.[1]) paths.push(hashline[1]);
	}
	if (paths.length === 0) throw scopeError(options.toolName, "edit input does not expose a verifiable file path");
	for (const filePath of paths) canonicalLocalPath(filePath, options, scope);
	return input
		.split(/(\r?\n)/)
		.map(line => {
			const applyPatch = /^(\s*\*\*\* (?:Add|Update|Delete) File:\s*)(.+?)(\s*)$/.exec(line);
			if (applyPatch?.[2]) {
				return `${applyPatch[1]}${canonicalLocalPath(applyPatch[2].trim(), options, scope)}${applyPatch[3]}`;
			}
			const move = /^(\s*\*\* Move to:\s*)(.+?)(\s*)$/.exec(line);
			if (move?.[2]) return `${move[1]}${canonicalLocalPath(move[2].trim(), options, scope)}${move[3]}`;
			const hashline = /^(\s*\[)([^#\r\n]+)((?:#[0-9a-fA-F]{4})?\].*)$/.exec(line);
			if (hashline?.[2]) {
				return `${hashline[1]}${canonicalLocalPath(hashline[2], options, scope)}${hashline[3]}`;
			}
			return line;
		})
		.join("");
}

function canonicalEditPaths(
	options: ToolPathScopeOptions,
	scope: ResolvedPathScope,
	args: Record<string, unknown>,
): void {
	const pathValue = args.path;
	if (typeof pathValue === "string") args.path = canonicalLocalPath(pathValue, options, scope);
	const edits = args.edits;
	if (Array.isArray(edits)) {
		args.edits = edits.map(edit => {
			if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
			const cloned = { ...(edit as Record<string, unknown>) };
			const rename = cloned.rename;
			if (typeof rename === "string") cloned.rename = canonicalLocalPath(rename, options, scope);
			return cloned;
		});
	}
	const input = args.input;
	if (typeof input === "string") args.input = canonicalEditInput(input, options, scope);
	if (typeof pathValue !== "string" && typeof input !== "string") {
		throw scopeError(options.toolName, "edit call does not expose a verifiable file path");
	}
}

/** 严格工具调用在授权后改用规范绝对路径，避免后续跟随已被替换的符号链接。 */
export function authorizeToolArgumentsWithinPathScope(options: ToolPathScopeOptions): Record<string, unknown> {
	if (!path.isAbsolute(options.scopeRoot)) {
		throw scopeError(options.toolName, "approved scope must be an absolute directory");
	}
	const scope = {
		logicalRoot: path.resolve(options.scopeRoot),
		canonicalRoot: canonicalizeExistingPrefix(options.scopeRoot, options.toolName),
	};
	if (!fs.statSync(scope.canonicalRoot).isDirectory())
		throw scopeError(options.toolName, "approved scope is not a directory");
	const logicalCwd = path.resolve(options.cwd);
	if (!isWithin(scope.logicalRoot, logicalCwd))
		throw scopeError(options.toolName, "working directory is outside the approved scope");
	const canonicalCwd = canonicalizeExistingPrefix(options.cwd, options.toolName);
	if (!isWithin(scope.canonicalRoot, canonicalCwd))
		throw scopeError(options.toolName, "working directory is outside the approved scope");
	const args = structuredClone(options.args);

	if (PATHLESS_SCOPED_TOOLS.has(options.toolName)) return args;
	if (DIRECT_PATH_TOOLS.has(options.toolName)) {
		const rawPath = requiredString(args, "path", options.toolName);
		const split = options.toolName === "read" ? splitPathAndSel(rawPath) : { path: rawPath };
		const canonical = canonicalLocalPath(split.path, options, scope);
		args.path = split.sel ? `${canonical}:${split.sel}` : canonical;
		return args;
	}
	if (SEARCH_PATH_TOOLS.has(options.toolName)) {
		const pathValue = args.path;
		if (
			pathValue !== undefined &&
			typeof pathValue !== "string" &&
			(!Array.isArray(pathValue) || pathValue.some(item => typeof item !== "string"))
		) {
			throw scopeError(options.toolName, "path must be a string or string array");
		}
		const inputs = toPathList(pathValue as string | string[] | undefined);
		const authorized: string[] = [];
		for (const input of inputs.length > 0 ? inputs : ["."]) {
			assertSearchPath(input, options, scope);
			const candidates = splitTopLevelPathCandidates(input);
			const atomic = candidates.length > 1 ? candidates.slice(1) : candidates;
			authorized.push(...atomic.map(candidate => canonicalSearchPath(candidate, options, scope)));
		}
		args.path = authorized.length === 1 && !Array.isArray(pathValue) ? authorized[0] : authorized;
		return args;
	}
	if (options.toolName === "ast_edit") {
		const paths = args.paths;
		if (!Array.isArray(paths) || paths.length === 0 || paths.some(item => typeof item !== "string")) {
			throw scopeError(options.toolName, "paths must be a non-empty string array");
		}
		for (const input of paths as string[]) assertSearchPath(input, options, scope);
		args.paths = (paths as string[]).map(input => canonicalSearchPath(input, options, scope));
		return args;
	}
	if (options.toolName === "edit" || options.toolName === "apply_patch") {
		canonicalEditPaths(options, scope, args);
		return args;
	}
	throw scopeError(options.toolName, "tool has no approved path-scope adapter");
}

/** 仅校验工具参数；生产执行应使用 authorizeToolArgumentsWithinPathScope 返回的参数。 */
export function assertToolArgumentsWithinPathScope(options: ToolPathScopeOptions): void {
	authorizeToolArgumentsWithinPathScope(options);
}
