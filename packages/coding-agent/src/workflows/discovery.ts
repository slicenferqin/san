import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { findRepoRoot } from "../capability/fs";
import { workflowSourceHash } from "./fingerprint";
import { WORKFLOW_MAX_SOURCE_BYTES } from "./source-parser";
import type { DiscoveredWorkflowSource, WorkflowSourceLevel, WorkflowSourceProvider } from "./types";

export interface DiscoverWorkflowSourcesOptions {
	cwd: string;
	repoRoot?: string | null;
	agentDir?: string;
	home?: string;
}

export interface WorkflowDiscoveryResult {
	items: DiscoveredWorkflowSource[];
	all: Array<DiscoveredWorkflowSource & { shadowed: boolean }>;
	warnings: string[];
}

interface WorkflowScanRoot {
	dir: string;
	provider: Exclude<WorkflowSourceProvider, "session">;
	level: Exclude<WorkflowSourceLevel, "session">;
	scopeKey: string;
	directoryDepth: number;
}

const WORKFLOW_FILENAME = /^[a-z0-9][a-z0-9_-]{0,63}\.js$/;

function ancestorDirs(cwd: string, stopAt: string): string[] {
	const resolvedCwd = path.resolve(cwd);
	const resolvedStop = path.resolve(stopAt);
	const relative = path.relative(resolvedStop, resolvedCwd);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return [resolvedCwd];
	const result: string[] = [];
	let current = resolvedCwd;
	while (true) {
		result.push(current);
		if (current === resolvedStop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return result;
}

async function scanRoot(root: WorkflowScanRoot, warnings: string[]): Promise<DiscoveredWorkflowSource[]> {
	try {
		const entries = await fs.readdir(root.dir, { withFileTypes: true });
		const sources: DiscoveredWorkflowSource[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!WORKFLOW_FILENAME.test(entry.name)) continue;
			if (!entry.isFile()) {
				warnings.push(`Ignoring non-regular Workflow entry ${path.join(root.dir, entry.name)}.`);
				continue;
			}
			const filePath = path.join(root.dir, entry.name);
			try {
				const file = Bun.file(filePath);
				if (file.size > WORKFLOW_MAX_SOURCE_BYTES) {
					warnings.push(`Ignoring Workflow file ${filePath}: source exceeds ${WORKFLOW_MAX_SOURCE_BYTES} bytes.`);
					continue;
				}
				const sourceText = await file.text();
				sources.push({
					name: entry.name.slice(0, -3),
					path: filePath,
					sourceText,
					sourceHash: workflowSourceHash(sourceText),
					provider: root.provider,
					level: root.level,
					scopeKey: root.scopeKey,
					directoryDepth: root.directoryDepth,
				});
			} catch (error) {
				warnings.push(`Cannot read Workflow file ${filePath}: ${String(error)}`);
			}
		}
		return sources;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		warnings.push(`Cannot scan Workflow directory ${root.dir}: ${String(error)}`);
		return [];
	}
}

/**
 * Discover Managed scripts in strict first-wins order:
 * closest project directory, San before Claude at the same directory, then
 * San user and Claude user. Every candidate is returned in `all` for UI
 * diagnostics; only the winner per command name appears in `items`.
 */
export async function discoverWorkflowSources(
	options: DiscoverWorkflowSourcesOptions,
): Promise<WorkflowDiscoveryResult> {
	const cwd = path.resolve(options.cwd);
	const repoRoot = options.repoRoot === undefined ? await findRepoRoot(cwd) : options.repoRoot;
	const projectDirs = ancestorDirs(cwd, repoRoot ?? cwd);
	const roots: WorkflowScanRoot[] = [];
	for (let depth = 0; depth < projectDirs.length; depth++) {
		const dir = projectDirs[depth];
		roots.push({
			dir: path.join(dir, ".san", "workflows"),
			provider: "san",
			level: "project",
			scopeKey: dir,
			directoryDepth: depth,
		});
		roots.push({
			dir: path.join(dir, ".claude", "workflows"),
			provider: "claude",
			level: "project",
			scopeKey: dir,
			directoryDepth: depth,
		});
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const home = options.home ?? os.homedir();
	roots.push({
		dir: path.join(agentDir, "workflows"),
		provider: "san",
		level: "user",
		scopeKey: cwd,
		directoryDepth: Number.MAX_SAFE_INTEGER - 1,
	});
	roots.push({
		dir: path.join(home, ".claude", "workflows"),
		provider: "claude",
		level: "user",
		scopeKey: cwd,
		directoryDepth: Number.MAX_SAFE_INTEGER,
	});

	const warnings: string[] = [];
	const batches = await Promise.all(roots.map(root => scanRoot(root, warnings)));
	const candidates = batches.flat();
	const seen = new Set<string>();
	const items: DiscoveredWorkflowSource[] = [];
	const all = candidates.map(source => {
		const shadowed = seen.has(source.name);
		if (!shadowed) {
			seen.add(source.name);
			items.push(source);
		}
		return { ...source, shadowed };
	});
	return { items, all, warnings };
}
