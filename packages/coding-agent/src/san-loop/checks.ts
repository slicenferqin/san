import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import builtinProjectTypescriptContracts from "../prompts/san-loop/checks/project-typescript-contracts.md" with {
	type: "text",
};
import builtinSupervisorGate from "../prompts/san-loop/checks/supervisor-gate.md" with { type: "text" };
import type { SanLoopRole } from "./types";

export type SanLoopCheckSeverity = "info" | "warning" | "error" | "blocker";

export type SanLoopCheckSource = "project" | "user" | "bundled";

export interface SanLoopCheckScope {
	paths: string[];
}

export interface SanLoopCheck {
	name: string;
	description?: string;
	path: string;
	content: string;
	scope?: SanLoopCheckScope;
	severity: SanLoopCheckSeverity;
	appliesTo: SanLoopRole[];
	source: SanLoopCheckSource;
}

export interface DiscoverSanLoopChecksOptions {
	cwd: string;
	includeBuiltins?: boolean;
	projectDir?: string;
}

export interface SanLoopCheckPlanOptions {
	role?: SanLoopRole;
	paths?: readonly string[];
}

interface CheckFrontmatter {
	name?: unknown;
	description?: unknown;
	scope?: unknown;
	severity?: unknown;
	appliesTo?: unknown;
}

const CHECK_EXTENSIONS = new Set([".md", ".markdown"]);
const ALL_ROLES: SanLoopRole[] = ["commander", "worker", "supervisor", "oracle"];
const BUILTIN_CHECKS: Array<{ path: string; content: string }> = [
	{ path: "embedded:san-loop/checks/project-typescript-contracts.md", content: builtinProjectTypescriptContracts },
	{ path: "embedded:san-loop/checks/supervisor-gate.md", content: builtinSupervisorGate },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function stringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const values = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function parseSeverity(value: unknown): SanLoopCheckSeverity {
	if (value === "info" || value === "warning" || value === "error" || value === "blocker") return value;
	return "warning";
}

function parseAppliesTo(value: unknown): SanLoopRole[] {
	const values = stringArray(value);
	if (!values) return [...ALL_ROLES];
	const roles = values.filter(
		(item): item is SanLoopRole =>
			item === "commander" || item === "worker" || item === "supervisor" || item === "oracle",
	);
	return roles.length > 0 ? roles : [...ALL_ROLES];
}

function parseScope(value: unknown): SanLoopCheckScope | undefined {
	if (!isRecord(value)) return undefined;
	const paths = stringArray(value.paths);
	return paths ? { paths } : undefined;
}

function parseCheck(content: string, filePath: string, source: SanLoopCheckSource): SanLoopCheck | null {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath, level: "warn" });
	const fm = frontmatter as CheckFrontmatter;
	const explicitName = typeof fm.name === "string" ? fm.name.trim() : "";
	const fallbackName = path.basename(filePath).replace(/\.(md|markdown)$/i, "");
	const name = explicitName || fallbackName;
	if (!name) return null;
	const bodyText = body.trim();
	if (!bodyText) return null;
	return {
		name,
		description: typeof fm.description === "string" ? fm.description.trim() : undefined,
		path: filePath,
		content: bodyText,
		scope: parseScope(fm.scope),
		severity: parseSeverity(fm.severity),
		appliesTo: parseAppliesTo(fm.appliesTo),
		source,
	};
}

async function readCheckDir(dir: string, source: SanLoopCheckSource): Promise<SanLoopCheck[]> {
	let files: string[];
	try {
		files = await fs.readdir(dir);
	} catch {
		return [];
	}
	const checks: SanLoopCheck[] = [];
	for (const file of files.toSorted()) {
		if (!CHECK_EXTENSIONS.has(path.extname(file))) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) continue;
			const parsed = parseCheck(await Bun.file(filePath).text(), filePath, source);
			if (parsed) checks.push(parsed);
		} catch {}
	}
	return checks;
}

function dedupeFirstWins(checks: SanLoopCheck[]): SanLoopCheck[] {
	const seen = new Set<string>();
	const result: SanLoopCheck[] = [];
	for (const check of checks) {
		if (seen.has(check.name)) continue;
		seen.add(check.name);
		result.push(check);
	}
	return result;
}

function builtinChecks(): SanLoopCheck[] {
	return BUILTIN_CHECKS.flatMap(check => {
		const parsed = parseCheck(check.content, check.path, "bundled");
		return parsed ? [parsed] : [];
	});
}

export async function discoverSanLoopChecks(options: DiscoverSanLoopChecksOptions): Promise<SanLoopCheck[]> {
	const projectSubdir = options.projectDir ?? ".omp/checks";
	const projectDirs =
		projectSubdir === ".omp/checks"
			? findAllNearestProjectConfigDirs("checks", options.cwd)
					.filter(entry => entry.source === ".omp")
					.map(entry => entry.path)
			: [path.resolve(options.cwd, projectSubdir)];
	const userDirs = getConfigDirs("checks", { user: true, project: false, existingOnly: true })
		.filter(entry => entry.source === ".omp")
		.map(entry => entry.path);

	const projectChecks = (await Promise.all(projectDirs.map(dir => readCheckDir(dir, "project")))).flat();
	const userChecks = (await Promise.all(userDirs.map(dir => readCheckDir(dir, "user")))).flat();
	const bundled = options.includeBuiltins === false ? [] : builtinChecks();
	return dedupeFirstWins([...projectChecks, ...userChecks, ...bundled]);
}

function pathMatches(pattern: string, target: string): boolean {
	const normalizedPattern = pattern.replaceAll("\\", "/");
	const normalizedTarget = target.replaceAll("\\", "/");
	if (normalizedPattern === normalizedTarget) return true;
	if (normalizedPattern.endsWith("/**")) {
		return normalizedTarget.startsWith(normalizedPattern.slice(0, -3));
	}
	if (normalizedPattern.startsWith("**/")) {
		return normalizedTarget.endsWith(normalizedPattern.slice(3));
	}
	if (normalizedPattern.includes("*")) {
		const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
		return new RegExp(`^${escaped}$`).test(normalizedTarget);
	}
	return normalizedTarget.startsWith(normalizedPattern);
}

export function selectSanLoopChecks(
	checks: readonly SanLoopCheck[],
	options: SanLoopCheckPlanOptions = {},
): SanLoopCheck[] {
	return checks.filter(check => {
		if (options.role && !check.appliesTo.includes(options.role)) return false;
		if (!options.paths || options.paths.length === 0 || !check.scope?.paths || check.scope.paths.length === 0) {
			return true;
		}
		return options.paths.some(target => check.scope?.paths.some(pattern => pathMatches(pattern, target)));
	});
}

export function renderSanLoopChecks(checks: readonly SanLoopCheck[]): string {
	if (checks.length === 0) return "San checks: none";
	const lines = ["San checks:"];
	for (const check of checks) {
		lines.push(`## ${check.name}`);
		lines.push(`Severity: ${check.severity}`);
		lines.push(`Applies to: ${check.appliesTo.join(", ")}`);
		if (check.description) lines.push(`Description: ${check.description}`);
		if (check.scope?.paths.length) lines.push(`Paths: ${check.scope.paths.join(", ")}`);
		lines.push(check.content);
	}
	return lines.join("\n");
}
