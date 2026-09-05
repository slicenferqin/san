import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

export type SessionChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface SessionChange {
	path: string;
	status: SessionChangeStatus;
	baselineHash?: string;
	currentHash?: string;
	additions: number;
	deletions: number;
	baseRef: string;
	snapshotId: string;
	safeToRevert: boolean;
}

export interface SessionChangeList {
	revision: string;
	baseRef: string;
	source: "git" | "filesystem";
	changes: SessionChange[];
	totalAdds: number;
	totalDels: number;
}

export interface SessionDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

export interface SessionDiffFile {
	path: string;
	baseRef: string;
	status: SessionChangeStatus;
	baselineHash?: string;
	currentHash?: string;
	hunks: SessionDiffHunk[];
}

export interface SessionRevertResult {
	reverted: Array<{ path: string; snapshotId: string }>;
	skipped: Array<{
		path: string;
		reason: "invalid_path" | "external_edit" | "revision_changed" | "not_changed" | "not_revertible";
	}>;
	revision: string;
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

function resolveWorkspacePath(cwd: string, file: string): { normalized: string; full: string } {
	if (typeof file !== "string" || file.length === 0 || file.includes("\0"))
		throw new Error("Path must be workspace-relative");
	const root = path.resolve(cwd);
	const normalizedInput = file.replaceAll("\\", "/");
	if (path.posix.isAbsolute(normalizedInput)) throw new Error("Path must be workspace-relative");
	const full = path.resolve(root, normalizedInput);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error("Path must be workspace-relative");
	return { normalized: path.relative(root, full).split(path.sep).join("/"), full };
}

function commandExitCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "number" ? error.code : undefined;
}

function commandOutput(error: unknown, key: "stdout" | "stderr"): string {
	if (!error || typeof error !== "object" || !(key in error)) return "";
	const value = (error as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function isOutsideGitRepository(error: unknown): boolean {
	return commandExitCode(error) === 128 && commandOutput(error, "stderr").includes("not a git repository");
}

async function git(cwd: string, args: string[], allowExitCodes: readonly number[] = []): Promise<string> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			maxBuffer: MAX_BUFFER,
			encoding: "utf8",
			windowsHide: true,
		});
		return result.stdout;
	} catch (error) {
		const code = commandExitCode(error);
		if (code !== undefined && allowExitCodes.includes(code)) return commandOutput(error, "stdout");
		throw error;
	}
}

async function readFileHash(file: string): Promise<{ hash: string; content: Buffer } | undefined> {
	try {
		const content = await fs.readFile(file);
		return { hash: sha256(content), content };
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function readBaseline(
	cwd: string,
	file: string,
	baseRef: string,
): Promise<{ hash: string; content: Buffer } | undefined> {
	try {
		const content = Buffer.from(await git(cwd, ["show", `${baseRef}:${file}`]));
		return { hash: sha256(content), content };
	} catch (error) {
		const code = (error as { code?: number | string }).code;
		if (code === 128 || code === "ENOENT") return undefined;
		throw error;
	}
}

function statusFromCode(code: string): SessionChangeStatus {
	if (code.includes("D")) return "deleted";
	if (code.includes("R") || code.includes("C")) return "renamed";
	if (code.includes("A") || code === "??") return "added";
	return "modified";
}

function countDiff(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

function parseHunks(diff: string): SessionDiffHunk[] {
	const hunks: SessionDiffHunk[] = [];
	for (const line of diff.split("\n")) {
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
		if (!match) continue;
		hunks.push({
			oldStart: Number(match[1]),
			oldLines: Number(match[2] ?? 1),
			newStart: Number(match[3]),
			newLines: Number(match[4] ?? 1),
			lines: [],
		});
	}
	const headers = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)];
	for (let index = 0; index < headers.length; index++) {
		const start = headers[index]?.index ?? 0;
		const end = headers[index + 1]?.index ?? diff.length;
		const body = diff.slice(start, end).split("\n").slice(1);
		const hunk = hunks[index];
		if (hunk) hunk.lines = body.filter(line => line.length > 0);
	}
	return hunks;
}

async function gitChanges(cwd: string): Promise<{ baseRef: string; status: string; changes: SessionChange[] }> {
	const baseRef = (await git(cwd, ["rev-parse", "HEAD"])).trim();
	const status = await git(cwd, ["status", "--porcelain=v1", "-z"]);
	const fields = status.split("\0");
	const changes: SessionChange[] = [];
	for (let index = 0; index < fields.length - 1; index++) {
		const field = fields[index] ?? "";
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		let file = field.slice(3);
		if (code.includes("R") || code.includes("C")) file = fields[++index] ?? file;
		const resolved = resolveWorkspacePath(cwd, file);
		const current = await readFileHash(resolved.full);
		const baseline = await readBaseline(cwd, resolved.normalized, baseRef);
		const diff =
			code === "??"
				? await git(
						cwd,
						["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", resolved.normalized],
						[1],
					)
				: await git(cwd, ["diff", baseRef, "--no-ext-diff", "--no-color", "--", resolved.normalized]);
		const counts = countDiff(diff);
		const snapshotId = sha256(`${baseRef}\0${resolved.normalized}\0${baseline?.hash ?? ""}`);
		changes.push({
			path: resolved.normalized,
			status: statusFromCode(code),
			baselineHash: baseline?.hash,
			currentHash: current?.hash,
			additions: counts.additions,
			deletions: counts.deletions,
			baseRef,
			snapshotId,
			safeToRevert: Boolean(current && (baseline?.hash === undefined || current.hash !== baseline.hash)),
		});
	}
	return { baseRef, status, changes };
}

/** Lists tracked and untracked working-tree changes relative to HEAD. */
export async function listSessionChanges(cwd: string): Promise<SessionChangeList> {
	try {
		const result = await gitChanges(cwd);
		const totalAdds = result.changes.reduce((sum, change) => sum + change.additions, 0);
		const totalDels = result.changes.reduce((sum, change) => sum + change.deletions, 0);
		const revision = sha256(`${result.baseRef}\0${result.status}`);
		return { revision, baseRef: result.baseRef, source: "git", changes: result.changes, totalAdds, totalDels };
	} catch (error) {
		if (!isOutsideGitRepository(error)) throw error;
		return { revision: "filesystem:0", baseRef: "", source: "filesystem", changes: [], totalAdds: 0, totalDels: 0 };
	}
}

export async function readChangeFile(cwd: string, file: string): Promise<SessionDiffFile> {
	const resolved = resolveWorkspacePath(cwd, file);
	const listed = await listSessionChanges(cwd);
	const change = listed.changes.find(item => item.path === resolved.normalized);
	if (!change) throw new Error("File has no session change");
	const diff =
		change.status === "added" && change.baselineHash === undefined
			? await git(
					cwd,
					["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", resolved.normalized],
					[1],
				)
			: await git(cwd, ["diff", listed.baseRef, "--no-ext-diff", "--no-color", "--", resolved.normalized]);
	return {
		path: resolved.normalized,
		baseRef: listed.baseRef,
		status: change.status,
		baselineHash: change.baselineHash,
		currentHash: change.currentHash,
		hunks: parseHunks(diff),
	};
}

export function diffStats(changes: SessionChangeList): {
	revision: string;
	baseRef: string;
	files: Array<{ path: string; adds: number; dels: number }>;
	totalAdds: number;
	totalDels: number;
} {
	return {
		revision: changes.revision,
		baseRef: changes.baseRef,
		files: changes.changes.map(change => ({ path: change.path, adds: change.additions, dels: change.deletions })),
		totalAdds: changes.totalAdds,
		totalDels: changes.totalDels,
	};
}

/** Reverts only unchanged files to the current HEAD baseline. */
export async function revertSessionChanges(
	cwd: string,
	files: readonly string[],
	expected: Record<string, string> = {},
	expectedRevision?: string,
): Promise<SessionRevertResult> {
	const before = await listSessionChanges(cwd);
	const reverted: Array<{ path: string; snapshotId: string }> = [];
	const skipped: SessionRevertResult["skipped"] = [];
	if (expectedRevision !== undefined && expectedRevision !== before.revision) {
		return {
			reverted,
			skipped: files.map(file => ({ path: file, reason: "revision_changed" })),
			revision: before.revision,
		};
	}
	for (const requested of files) {
		let resolved: { normalized: string; full: string };
		try {
			resolved = resolveWorkspacePath(cwd, requested);
		} catch {
			skipped.push({ path: requested, reason: "invalid_path" });
			continue;
		}
		const change = before.changes.find(item => item.path === resolved.normalized);
		if (!change) {
			skipped.push({ path: resolved.normalized, reason: "not_changed" });
			continue;
		}
		const current = await readFileHash(resolved.full);
		if (expected[resolved.normalized] !== undefined && current?.hash !== expected[resolved.normalized]) {
			skipped.push({ path: resolved.normalized, reason: "external_edit" });
			continue;
		}
		if (!current || !change.currentHash || current.hash !== change.currentHash) {
			skipped.push({ path: resolved.normalized, reason: "external_edit" });
			continue;
		}
		const baseline = await readBaseline(cwd, resolved.normalized, before.baseRef);
		try {
			if (baseline) {
				await fs.mkdir(path.dirname(resolved.full), { recursive: true });
				await fs.writeFile(resolved.full, baseline.content);
			} else {
				await fs.rm(resolved.full);
			}
			reverted.push({ path: resolved.normalized, snapshotId: change.snapshotId });
		} catch {
			skipped.push({ path: resolved.normalized, reason: "not_revertible" });
		}
	}
	const after = await listSessionChanges(cwd);
	return { reverted, skipped, revision: after.revision };
}
