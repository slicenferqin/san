import * as fs from "node:fs/promises";
import * as path from "node:path";
import { captureBaseline, type WorktreeBaseline } from "../task/worktree";
import * as git from "../utils/git";
import type { WorkflowWriteArtifact, WorkflowWriteArtifactCandidate, WorkflowWriteArtifactStatus } from "./types";

export const WORKFLOW_MAX_PATCH_BYTES = 4 * 1024 * 1024;

export type WorkflowWriteDeliveryErrorCode =
	| "artifact_tampered"
	| "baseline_changed"
	| "invalid_review"
	| "invalid_state"
	| "nested_changes"
	| "patch_conflict"
	| "scope_violation"
	| "secret_detected"
	| "unknown_side_effect";

export class WorkflowWriteDeliveryError extends Error {
	readonly code: WorkflowWriteDeliveryErrorCode;

	constructor(code: WorkflowWriteDeliveryErrorCode, message: string) {
		super(message);
		this.name = "WorkflowWriteDeliveryError";
		this.code = code;
	}
}

export interface WorkflowWriteArtifactRecord {
	metadata: WorkflowWriteArtifact;
	candidate: WorkflowWriteArtifactCandidate;
	preimages?: Record<string, string | null>;
	reviewToken?: string;
}

export interface WorkflowWriteReview {
	artifactId: string;
	reviewToken: string;
	patchHash: string;
	baselineHash: string;
	byteLength: number;
	patchText: string;
}

export interface WorkflowWriteApplyResult {
	artifact: WorkflowWriteArtifact;
	nextBaseline: WorktreeBaseline;
	hadChanges: boolean;
}

const WORKFLOW_APPLY_LOCKS = new Map<string, Promise<void>>();

async function withWorkflowApplyLock<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
	const previous = WORKFLOW_APPLY_LOCKS.get(repoRoot) ?? Promise.resolve();
	const release = Promise.withResolvers<void>();
	const tail = previous.then(() => release.promise);
	WORKFLOW_APPLY_LOCKS.set(repoRoot, tail);
	await previous;
	try {
		return await action();
	} finally {
		release.resolve();
		if (WORKFLOW_APPLY_LOCKS.get(repoRoot) === tail) WORKFLOW_APPLY_LOCKS.delete(repoRoot);
	}
}

function digestText(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function stableBaselineValue(baseline: WorktreeBaseline): object {
	const repo = (value: WorktreeBaseline["root"]) => ({
		repoRoot: path.resolve(value.repoRoot),
		headCommit: value.headCommit,
		staged: value.staged,
		unstaged: value.unstaged,
		untracked: [...value.untracked].sort(),
		untrackedPatch: value.untrackedPatch,
	});
	return {
		root: repo(baseline.root),
		nested: [...baseline.nested]
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
			.map(item => ({ relativePath: item.relativePath, baseline: repo(item.baseline) })),
	};
}

export function workflowBaselineHash(baseline: WorktreeBaseline): string {
	return digestText(JSON.stringify(stableBaselineValue(baseline)));
}

function safePatchPath(raw: string): string | undefined {
	if (raw === "/dev/null") return undefined;
	if (raw.includes("\t") || raw.includes("\\") || raw.startsWith('"') || raw.endsWith('"')) {
		throw new WorkflowWriteDeliveryError(
			"scope_violation",
			"Workflow patch uses a quoted or escaped path that cannot be reviewed safely.",
		);
	}
	const withoutPrefix = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
	if (!withoutPrefix || path.posix.isAbsolute(withoutPrefix)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow patch contains an absolute or empty path.");
	}
	const normalized = path.posix.normalize(withoutPrefix);
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow patch path escapes the approved repository.");
	}
	return normalized;
}

function patchPaths(patchText: string): string[] {
	const paths = new Set<string>();
	for (const line of patchText.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const parts = line.split(" ");
			if (parts.length !== 4) {
				throw new WorkflowWriteDeliveryError(
					"scope_violation",
					"Workflow patch contains a path with unsupported quoting or whitespace.",
				);
			}
			for (const raw of parts.slice(2)) {
				const parsed = safePatchPath(raw);
				if (parsed) paths.add(parsed);
			}
			continue;
		}
		if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			const raw = line.slice(4);
			if (raw.includes(" ")) {
				throw new WorkflowWriteDeliveryError(
					"scope_violation",
					"Workflow patch contains a path with unsupported whitespace.",
				);
			}
			const parsed = safePatchPath(raw);
			if (parsed) paths.add(parsed);
		}
	}
	if (patchText.trim() && paths.size === 0) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow patch has no reviewable file paths.");
	}
	return [...paths].sort();
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(?:ghp|github_pat|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/,
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
	/\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?key|secret|token)\b\s*[:=]\s*["']?[^\s"']{12,}/i,
];

function assertPatchSafe(patchText: string, candidate: WorkflowWriteArtifactCandidate): void {
	if (candidate.nestedPatches.length > 0) {
		throw new WorkflowWriteDeliveryError(
			"nested_changes",
			"Nested repository changes require manual handling and cannot pass the v0.4 apply gate.",
		);
	}
	if (/^(?:GIT binary patch|Binary files )/m.test(patchText)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Binary Workflow patches are not supported.");
	}
	if (/^(?:new file mode|old mode|new mode) (?:120000|160000)$/m.test(patchText)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow patches cannot create symlinks or gitlinks.");
	}
	const repoRoot = path.resolve(candidate.repoRoot);
	const scopeKey = path.resolve(candidate.scopeKey);
	if (!path.isAbsolute(candidate.repoRoot) || !path.isAbsolute(candidate.scopeKey) || !isWithin(repoRoot, scopeKey)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow write scope is outside its repository.");
	}
	for (const relativePath of patchPaths(patchText)) {
		const absolute = path.resolve(repoRoot, relativePath);
		if (!isWithin(scopeKey, absolute)) {
			throw new WorkflowWriteDeliveryError(
				"scope_violation",
				`Workflow patch path ${relativePath} is outside the approved directory.`,
			);
		}
		const basename = path.basename(relativePath).toLowerCase();
		if (basename === ".env" || basename.startsWith(".env.") || basename === ".npmrc") {
			throw new WorkflowWriteDeliveryError("secret_detected", "Workflow patch targets a credential-bearing file.");
		}
	}
	for (const line of patchText.split("\n")) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		const added = line.slice(1);
		if (SECRET_PATTERNS.some(pattern => pattern.test(added))) {
			throw new WorkflowWriteDeliveryError(
				"secret_detected",
				"Workflow patch contains a possible credential in an added line.",
			);
		}
	}
}

async function capturePatchPreimages(
	patchText: string,
	candidate: WorkflowWriteArtifactCandidate,
): Promise<Record<string, string | null>> {
	const repoRoot = await fs.realpath(candidate.repoRoot);
	const scopeRoot = await fs.realpath(candidate.scopeKey);
	if (!isWithin(repoRoot, scopeRoot)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow write scope is outside its repository.");
	}
	const preimages: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
	for (const relativePath of patchPaths(patchText)) {
		const target = path.resolve(repoRoot, relativePath);
		if (!isWithin(scopeRoot, target)) {
			throw new WorkflowWriteDeliveryError(
				"scope_violation",
				`Workflow patch path ${relativePath} escaped its scope.`,
			);
		}
		try {
			const stat = await fs.lstat(target);
			if (!stat.isFile() || stat.isSymbolicLink()) {
				throw new WorkflowWriteDeliveryError(
					"scope_violation",
					`Workflow patch target ${relativePath} is not a regular file.`,
				);
			}
			preimages[relativePath] = digestText(await Bun.file(target).text());
		} catch (error) {
			if (error instanceof WorkflowWriteDeliveryError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				preimages[relativePath] = null;
				continue;
			}
			throw new WorkflowWriteDeliveryError(
				"scope_violation",
				`Workflow patch target ${relativePath} cannot be verified.`,
			);
		}
	}
	return preimages;
}

function samePreimages(
	left: Readonly<Record<string, string | null>>,
	right: Readonly<Record<string, string | null>>,
): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
	);
}

async function readVerifiedPatch(record: WorkflowWriteArtifactRecord): Promise<string> {
	const { candidate, metadata } = record;
	if (!path.isAbsolute(candidate.artifactRoot) || !path.isAbsolute(candidate.patchPath)) {
		throw new WorkflowWriteDeliveryError("artifact_tampered", "Workflow patch artifact path is not absolute.");
	}
	let root: string;
	let patchPath: string;
	try {
		[root, patchPath] = await Promise.all([fs.realpath(candidate.artifactRoot), fs.realpath(candidate.patchPath)]);
		const stat = await fs.lstat(candidate.patchPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new WorkflowWriteDeliveryError("artifact_tampered", "Workflow patch artifact is not a regular file.");
		}
		if (stat.size > WORKFLOW_MAX_PATCH_BYTES) {
			throw new WorkflowWriteDeliveryError(
				"artifact_tampered",
				`Workflow patch exceeds the ${WORKFLOW_MAX_PATCH_BYTES}-byte review limit.`,
			);
		}
	} catch (error) {
		if (error instanceof WorkflowWriteDeliveryError) throw error;
		throw new WorkflowWriteDeliveryError("artifact_tampered", "Workflow patch artifact cannot be verified.");
	}
	if (!isWithin(root, patchPath)) {
		throw new WorkflowWriteDeliveryError(
			"artifact_tampered",
			"Workflow patch artifact escaped its artifact directory.",
		);
	}
	const patchText = await Bun.file(patchPath).text();
	const byteLength = new TextEncoder().encode(patchText).byteLength;
	const patchHash = digestText(patchText);
	if (byteLength !== metadata.byteLength || patchHash !== metadata.patchHash) {
		throw new WorkflowWriteDeliveryError("artifact_tampered", "Workflow patch artifact changed after capture.");
	}
	assertPatchSafe(patchText, candidate);
	return patchText;
}

export async function captureWorkflowWriteArtifact(options: {
	artifactId: string;
	nodeId: string;
	callId: string;
	agentRef: string;
	candidate: WorkflowWriteArtifactCandidate;
	capturedAt: string;
}): Promise<WorkflowWriteArtifactRecord> {
	const placeholder: WorkflowWriteArtifactRecord = {
		metadata: {
			artifactId: options.artifactId,
			nodeId: options.nodeId,
			callId: options.callId,
			agentRef: options.agentRef,
			status: "pending",
			patchHash: "",
			baselineHash: workflowBaselineHash(options.candidate.baseline),
			byteLength: 0,
			hasNestedChanges: options.candidate.nestedPatches.length > 0,
			capturedAt: options.capturedAt,
		},
		candidate: structuredClone(options.candidate),
	};
	const { candidate } = placeholder;
	if (!path.isAbsolute(candidate.repoRoot) || !path.isAbsolute(candidate.scopeKey)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow write candidate uses a non-absolute scope.");
	}
	if (path.resolve(candidate.baseline.root.repoRoot) !== path.resolve(candidate.repoRoot)) {
		throw new WorkflowWriteDeliveryError(
			"baseline_changed",
			"Workflow write baseline belongs to a different repository.",
		);
	}
	let root: string;
	let patchPath: string;
	try {
		const [canonicalRepo, canonicalScope, artifactRoot, canonicalPatch] = await Promise.all([
			fs.realpath(candidate.repoRoot),
			fs.realpath(candidate.scopeKey),
			fs.realpath(candidate.artifactRoot),
			fs.realpath(candidate.patchPath),
		]);
		if (!isWithin(canonicalRepo, canonicalScope)) throw new Error("scope outside repository");
		root = artifactRoot;
		patchPath = canonicalPatch;
		const stat = await fs.lstat(candidate.patchPath);
		if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(root, patchPath)) {
			throw new Error("invalid artifact");
		}
		if (stat.size > WORKFLOW_MAX_PATCH_BYTES) throw new Error("oversized artifact");
	} catch {
		throw new WorkflowWriteDeliveryError("artifact_tampered", "Workflow patch artifact cannot be captured safely.");
	}
	const patchText = await Bun.file(patchPath).text();
	const byteLength = new TextEncoder().encode(patchText).byteLength;
	if (byteLength > WORKFLOW_MAX_PATCH_BYTES) {
		throw new WorkflowWriteDeliveryError(
			"artifact_tampered",
			`Workflow patch exceeds the ${WORKFLOW_MAX_PATCH_BYTES}-byte review limit.`,
		);
	}
	placeholder.metadata.patchHash = digestText(patchText);
	placeholder.metadata.byteLength = byteLength;
	return placeholder;
}

export async function reviewWorkflowWriteArtifact(
	record: WorkflowWriteArtifactRecord,
	reviewedAt: string,
	tokenFactory: () => string = () => `workflow-write-${crypto.randomUUID()}`,
): Promise<WorkflowWriteReview> {
	if (record.metadata.status !== "pending" && record.metadata.status !== "reviewed") {
		throw new WorkflowWriteDeliveryError(
			"invalid_state",
			`Workflow patch cannot be reviewed from status ${record.metadata.status}.`,
		);
	}
	const patchText = await readVerifiedPatch(record);
	record.preimages = await capturePatchPreimages(patchText, record.candidate);
	const reviewToken = tokenFactory();
	if (!reviewToken.trim()) throw new WorkflowWriteDeliveryError("invalid_review", "Workflow review token is empty.");
	record.reviewToken = reviewToken;
	record.metadata.status = "reviewed";
	record.metadata.reviewedAt = reviewedAt;
	return {
		artifactId: record.metadata.artifactId,
		reviewToken,
		patchHash: record.metadata.patchHash,
		baselineHash: record.metadata.baselineHash,
		byteLength: record.metadata.byteLength,
		patchText,
	};
}

export async function applyWorkflowWriteArtifact(options: {
	record: WorkflowWriteArtifactRecord;
	reviewToken: string;
	expectedBaseline: WorktreeBaseline;
	appliedAt: string;
	onApplyStarted: () => void;
}): Promise<WorkflowWriteApplyResult> {
	let repoRoot: string;
	try {
		repoRoot = await fs.realpath(options.record.candidate.repoRoot);
	} catch {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow repository path cannot be verified.");
	}
	return withWorkflowApplyLock(repoRoot, () => applyWorkflowWriteArtifactLocked(options, repoRoot));
}

async function applyWorkflowWriteArtifactLocked(
	options: {
		record: WorkflowWriteArtifactRecord;
		reviewToken: string;
		expectedBaseline: WorktreeBaseline;
		appliedAt: string;
		onApplyStarted: () => void;
	},
	lockedRepoRoot: string,
): Promise<WorkflowWriteApplyResult> {
	const { record } = options;
	if (record.metadata.status !== "reviewed") {
		throw new WorkflowWriteDeliveryError(
			"invalid_state",
			`Workflow patch cannot be applied from status ${record.metadata.status}.`,
		);
	}
	if (!record.reviewToken || record.reviewToken !== options.reviewToken) {
		throw new WorkflowWriteDeliveryError("invalid_review", "Workflow patch review token is invalid or stale.");
	}
	let currentRepoRoot: string;
	let currentScope: string;
	try {
		[currentRepoRoot, currentScope] = await Promise.all([
			fs.realpath(record.candidate.repoRoot),
			fs.realpath(record.candidate.scopeKey),
		]);
	} catch {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow write scope cannot be verified.");
	}
	if (currentRepoRoot !== lockedRepoRoot || !isWithin(currentRepoRoot, currentScope)) {
		throw new WorkflowWriteDeliveryError("scope_violation", "Workflow write scope changed after approval.");
	}
	const patchText = await readVerifiedPatch(record);
	if (!record.preimages) {
		throw new WorkflowWriteDeliveryError("invalid_review", "Workflow patch review has no file preimage receipt.");
	}
	const currentBaseline = await captureBaseline(record.candidate.repoRoot);
	if (workflowBaselineHash(currentBaseline) !== workflowBaselineHash(options.expectedBaseline)) {
		throw new WorkflowWriteDeliveryError(
			"baseline_changed",
			"The working tree changed after Workflow patch review; the patch was not applied.",
		);
	}
	const currentPreimages = await capturePatchPreimages(patchText, record.candidate);
	if (!samePreimages(record.preimages, currentPreimages)) {
		throw new WorkflowWriteDeliveryError(
			"baseline_changed",
			"A Workflow patch target changed after review; the patch was not applied.",
		);
	}
	if (!(await git.patch.canApplyText(record.candidate.repoRoot, patchText))) {
		throw new WorkflowWriteDeliveryError(
			"patch_conflict",
			"Workflow patch no longer applies cleanly to the reviewed baseline.",
		);
	}
	const preApplyImages = await capturePatchPreimages(patchText, record.candidate);
	if (!samePreimages(currentPreimages, preApplyImages)) {
		throw new WorkflowWriteDeliveryError(
			"baseline_changed",
			"A Workflow patch target changed during apply validation; the patch was not applied.",
		);
	}
	options.onApplyStarted();
	record.metadata.status = "applying";
	try {
		await git.patch.applyText(record.candidate.repoRoot, patchText);
		const nextBaseline = await captureBaseline(record.candidate.repoRoot);
		if (
			patchText.trim() &&
			!(await git.patch.canApplyText(record.candidate.repoRoot, patchText, { reverse: true }))
		) {
			record.metadata.status = "unknown";
			throw new WorkflowWriteDeliveryError(
				"unknown_side_effect",
				"Workflow patch application returned without a verifiable post-image.",
			);
		}
		record.metadata.status = "applied";
		record.metadata.appliedAt = options.appliedAt;
		record.reviewToken = undefined;
		return {
			artifact: structuredClone(record.metadata),
			nextBaseline,
			hadChanges: patchText.trim().length > 0,
		};
	} catch (error) {
		if (error instanceof WorkflowWriteDeliveryError && error.code === "unknown_side_effect") throw error;
		const afterFailure = await captureBaseline(record.candidate.repoRoot);
		if (workflowBaselineHash(afterFailure) === workflowBaselineHash(options.expectedBaseline)) {
			record.metadata.status = "blocked";
			throw new WorkflowWriteDeliveryError("patch_conflict", "Workflow patch failed without changing the baseline.");
		}
		const [reverseApplies, forwardApplies] = await Promise.all([
			git.patch.canApplyText(record.candidate.repoRoot, patchText, { reverse: true }),
			git.patch.canApplyText(record.candidate.repoRoot, patchText),
		]);
		if (reverseApplies && !forwardApplies) {
			record.metadata.status = "applied";
			record.metadata.appliedAt = options.appliedAt;
			record.reviewToken = undefined;
			return {
				artifact: structuredClone(record.metadata),
				nextBaseline: afterFailure,
				hadChanges: patchText.trim().length > 0,
			};
		}
		record.metadata.status = "unknown";
		throw new WorkflowWriteDeliveryError(
			"unknown_side_effect",
			"Workflow patch application failed after the working tree changed; side effects are unknown.",
		);
	}
}

export function rejectWorkflowWriteArtifact(
	record: WorkflowWriteArtifactRecord,
	rejectedAt: string,
): WorkflowWriteArtifact {
	if (record.metadata.status !== "pending" && record.metadata.status !== "reviewed") {
		throw new WorkflowWriteDeliveryError(
			"invalid_state",
			`Workflow patch cannot be rejected from status ${record.metadata.status}.`,
		);
	}
	record.metadata.status = "rejected";
	record.metadata.rejectedAt = rejectedAt;
	record.reviewToken = undefined;
	return structuredClone(record.metadata);
}

export function blockWorkflowWriteArtifact(
	record: WorkflowWriteArtifactRecord,
	status: Extract<WorkflowWriteArtifactStatus, "blocked" | "unknown">,
	reason: string,
): WorkflowWriteArtifact {
	record.metadata.status = status;
	record.metadata.blockedReason = reason;
	record.reviewToken = undefined;
	return structuredClone(record.metadata);
}
