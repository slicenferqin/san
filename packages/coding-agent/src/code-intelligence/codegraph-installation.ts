import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent } from "@san/utils";

const CODEGRAPH_CHECK_TIMEOUT_MS = 10_000;
const CODEGRAPH_CHECK_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

export type CodeGraphLocalState = "missing" | "unindexed" | "ready" | "pending" | "stale" | "error";

export interface CodeGraphPendingChanges {
	added: number;
	modified: number;
	removed: number;
}

export interface CodeGraphSetupCheck {
	state: CodeGraphLocalState;
	binaryAvailable: boolean;
	initialized: boolean;
	localBackend: "codegraph" | "lsp-ast-text";
	executable?: string;
	version?: string;
	indexRoot?: string;
	pendingChanges?: CodeGraphPendingChanges;
	worktreeMismatch?: boolean;
	error?: string;
}

interface CodeGraphCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CodeGraphSetupDependencies {
	which?: (binary: string) => string | null;
	run?: (command: string[], cwd: string) => Promise<CodeGraphCommandResult>;
}

interface CodeGraphStatusPayload {
	initialized?: unknown;
	projectPath?: unknown;
	pendingChanges?: unknown;
	worktreeMismatch?: unknown;
}

async function runCodeGraphCommand(command: string[], cwd: string): Promise<CodeGraphCommandResult> {
	const process = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: CODEGRAPH_CHECK_TIMEOUT_MS,
		maxBuffer: CODEGRAPH_CHECK_MAX_BUFFER,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function cleanMessage(value: string): string {
	return Bun.stripANSI(value).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parsePendingChanges(value: unknown): CodeGraphPendingChanges {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		added: nonNegativeInteger(record.added),
		modified: nonNegativeInteger(record.modified),
		removed: nonNegativeInteger(record.removed),
	};
}

function firstLine(value: string): string | undefined {
	const line = value
		.split(/\r?\n/)
		.map(part => part.trim())
		.find(Boolean);
	return line || undefined;
}

function errorCheck(executable: string, version: string | undefined, message: string): CodeGraphSetupCheck {
	return {
		state: "error",
		binaryAvailable: true,
		initialized: false,
		localBackend: "lsp-ast-text",
		executable,
		version,
		error: cleanMessage(message) || "CodeGraph status check failed",
	};
}

export function isCodeGraphLocallyUsable(check: CodeGraphSetupCheck): boolean {
	return check.state === "ready" || check.state === "pending" || check.state === "stale";
}

export async function findCodeGraphRoot(startPath: string): Promise<string | null> {
	let current: string;
	try {
		const stat = await fs.stat(startPath);
		current = stat.isDirectory() ? path.resolve(startPath) : path.dirname(path.resolve(startPath));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	while (true) {
		try {
			const marker = await fs.stat(path.join(current, ".codegraph"));
			if (marker.isDirectory()) return current;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export async function checkCodeGraphSetup(
	cwd: string,
	dependencies: CodeGraphSetupDependencies = {},
): Promise<CodeGraphSetupCheck> {
	const executable = (dependencies.which ?? $which)("codegraph");
	if (!executable) {
		return {
			state: "missing",
			binaryAvailable: false,
			initialized: false,
			localBackend: "lsp-ast-text",
		};
	}

	const run = dependencies.run ?? runCodeGraphCommand;
	let versionResult: CodeGraphCommandResult;
	let statusResult: CodeGraphCommandResult;
	try {
		[versionResult, statusResult] = await Promise.all([
			run([executable, "--version"], cwd),
			run([executable, "status", "--json", cwd], cwd),
		]);
	} catch (error) {
		return errorCheck(executable, undefined, error instanceof Error ? error.message : String(error));
	}

	const version = versionResult.exitCode === 0 ? firstLine(versionResult.stdout) : undefined;
	if (statusResult.exitCode !== 0) {
		return errorCheck(executable, version, statusResult.stderr || statusResult.stdout);
	}

	let parsedStatus: unknown;
	try {
		parsedStatus = JSON.parse(statusResult.stdout);
	} catch (error) {
		return errorCheck(executable, version, error instanceof Error ? error.message : String(error));
	}
	if (!parsedStatus || typeof parsedStatus !== "object" || Array.isArray(parsedStatus)) {
		return errorCheck(executable, version, "CodeGraph status returned an invalid JSON object");
	}
	const status = parsedStatus as CodeGraphStatusPayload;

	const indexRoot = typeof status.projectPath === "string" ? status.projectPath : undefined;
	if (status.initialized !== true) {
		return {
			state: "unindexed",
			binaryAvailable: true,
			initialized: false,
			localBackend: "lsp-ast-text",
			executable,
			version,
			indexRoot,
		};
	}

	const pendingChanges = parsePendingChanges(status.pendingChanges);
	const worktreeMismatch = Boolean(status.worktreeMismatch);
	const pendingCount = pendingChanges.added + pendingChanges.modified + pendingChanges.removed;
	const state: CodeGraphLocalState = worktreeMismatch ? "stale" : pendingCount > 0 ? "pending" : "ready";
	return {
		state,
		binaryAvailable: true,
		initialized: true,
		localBackend: "codegraph",
		executable,
		version,
		indexRoot,
		pendingChanges,
		worktreeMismatch,
	};
}
