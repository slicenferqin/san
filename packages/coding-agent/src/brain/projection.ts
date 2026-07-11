import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, withTimeout } from "@oh-my-pi/pi-utils";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	restoreManagedSkillContent,
	sanitizeSkillName,
	toSkillFrontmatter,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { resolveMemoryBackend } from "../memory-backend";
import type { MemoryBackend, MemoryBackendOperationContext } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import type { ReadonlySessionManager } from "../session/session-manager";
import { sanitizeSanBrainAuditError } from "./audit";
import { appendSanBrainProjection } from "./ledger";
import type { SanBrainCandidateRecord, SanBrainProjectionRecord, SanBrainStore } from "./store";
import {
	BRAIN_SCHEMA_VERSION,
	type SanBrainDecision,
	type SanBrainExperienceCandidate,
	type SanBrainProjection,
	type SanBrainProjectionErrorCode,
	type SanBrainProjectionState,
} from "./types";

const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

class ProjectionBlockedError extends Error {
	readonly code: SanBrainProjectionErrorCode;

	constructor(message: string, code: SanBrainProjectionErrorCode = "invalid_draft") {
		super(message);
		this.code = code;
	}
}

export interface RunSanBrainProjectionsOptions {
	store: SanBrainStore;
	sessionManager: ReadonlySessionManager;
	session?: AgentSession;
	agentDir: string;
	cwd: string;
	maxAttempts: number;
	attemptTimeoutMs?: number;
	includeFailed?: boolean;
	limit?: number;
	memoryBackend?: MemoryBackend;
}

export interface RunSanBrainProjectionsResult {
	applied: number;
	compensated: number;
	failed: number;
	blocked: number;
	reconciled?: number;
}

interface ProjectionMutationResult {
	beforeHash?: string;
	afterHash?: string;
	receiptId?: string;
}

interface ProjectionAuditUpdates extends ProjectionMutationResult {
	errorCode?: SanBrainProjectionErrorCode;
	error?: string;
	durationMs?: number;
}

function contentHash(content: string): string {
	return Bun.hash(content).toString(36);
}

function nextUpdatedAt(previous: string): string {
	const previousMs = Date.parse(previous);
	const now = Date.now();
	return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString();
}

function projectionAudit(
	record: SanBrainProjectionRecord,
	state: SanBrainProjectionState,
	attemptCount: number,
	updates: ProjectionAuditUpdates = {},
): SanBrainProjection {
	return {
		schemaVersion: BRAIN_SCHEMA_VERSION,
		projectionId: record.projectionId,
		decisionId: record.decisionId,
		target: record.target,
		state,
		attemptCount,
		...(record.revision === undefined ? {} : { revision: record.revision }),
		...(updates.beforeHash ? { beforeHash: updates.beforeHash } : {}),
		...(updates.afterHash ? { afterHash: updates.afterHash } : {}),
		...(updates.errorCode ? { errorCode: updates.errorCode } : {}),
		...(updates.error ? { error: sanitizeSanBrainAuditError(updates.error) } : {}),
		...(updates.durationMs === undefined ? {} : { durationMs: updates.durationMs }),
		...(updates.receiptId ? { receiptId: updates.receiptId } : {}),
		updatedAt: nextUpdatedAt(record.updatedAt),
	};
}

function appendAudit(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	state: SanBrainProjectionState,
	attemptCount: number,
	updates: ProjectionAuditUpdates = {},
): void {
	appendSanBrainProjection(options.sessionManager, projectionAudit(record, state, attemptCount, updates));
	options.store.syncSessionEntries(options.sessionManager.getSessionId(), options.sessionManager.getEntries());
}

function requireExperienceCandidate(candidate: SanBrainCandidateRecord): SanBrainExperienceCandidate {
	if (candidate.kind !== "experience" || !("selector" in candidate.candidate)) {
		throw new ProjectionBlockedError(
			`Projection target requires an experience candidate, found ${candidate.kind}.`,
			"invalid_draft",
		);
	}
	return candidate.candidate;
}

async function applyMemoryProjection(
	options: RunSanBrainProjectionsOptions,
	candidate: SanBrainCandidateRecord,
	projection: SanBrainProjectionRecord,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	if (candidate.kind !== "profile" || !("subject" in candidate.candidate)) {
		throw new ProjectionBlockedError("Memory projection requires a profile candidate.", "invalid_draft");
	}
	const value = candidate.candidate;
	const content = `${value.subject}: ${value.predicate} = ${value.value}`;
	const backend = await projectionMemoryBackend(options);
	if (!backend.project) {
		throw new ProjectionBlockedError(
			`Memory backend ${backend.id} does not expose durable projection receipts.`,
			backend.id === "off" ? "backend_unavailable" : "receipt_missing",
		);
	}
	const saved = await backend.project(memoryOperationContext(options), {
		content,
		context: `${value.scope.kind}:${value.scope.key}`,
		source: `san.brain.projection:${projection.projectionId}`,
		importance: value.importance,
		operationId: projection.projectionId,
		signal,
	});
	if (saved.stored < 1 && saved.queued !== true) {
		const message = saved.message ?? `Memory backend ${saved.backend} did not store the approved Brain state.`;
		if (saved.backend === "off") throw new ProjectionBlockedError(message, "backend_unavailable");
		throw new Error(message);
	}
	const afterHash = saved.ids?.join(",") || contentHash(content);
	return { afterHash, ...(saved.ids?.length ? { receiptId: saved.ids.join(",") } : {}) };
}

function memoryOperationContext(options: RunSanBrainProjectionsOptions): MemoryBackendOperationContext {
	return { agentDir: options.agentDir, cwd: options.cwd, session: options.session };
}

async function projectionMemoryBackend(options: RunSanBrainProjectionsOptions): Promise<MemoryBackend> {
	if (options.memoryBackend) return options.memoryBackend;
	if (!options.session) {
		throw new ProjectionBlockedError(
			"Memory projection backend requires an active agent session.",
			"owner_unavailable",
		);
	}
	return resolveMemoryBackend(options.session.settings);
}

async function compensateMemoryProjection(
	options: RunSanBrainProjectionsOptions,
	decision: SanBrainDecision,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	const previous = options.store.findPreviousAppliedProjection(decision.ownerId, "memory", decision.decisionId);
	if (!previous) {
		throw new ProjectionBlockedError("No applied memory projection is available to compensate.", "unsafe_undo");
	}
	const backend = await projectionMemoryBackend(options);
	if (!backend.compensateProjection) {
		throw new ProjectionBlockedError(
			`Memory backend ${backend.id} does not support projection compensation.`,
			"unsafe_undo",
		);
	}
	const compensated = await backend.compensateProjection(
		memoryOperationContext(options),
		previous.projectionId,
		signal,
	);
	if (compensated.state !== "compensated" && compensated.state !== "missing") {
		throw new ProjectionBlockedError(
			compensated.message ?? "Memory projection compensation is unsafe.",
			"unsafe_undo",
		);
	}
	return {
		...(previous.afterHash ? { beforeHash: previous.afterHash } : {}),
		...(compensated.receiptId ? { receiptId: compensated.receiptId } : {}),
	};
}

function skillBackupPath(agentDir: string, projectionId: string): string {
	return path.join(agentDir, "brain", "projection-backups", `${projectionId}.json`);
}

async function writeSkillBackup(agentDir: string, projectionId: string, name: string, content: string): Promise<void> {
	const file = skillBackupPath(agentDir, projectionId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, JSON.stringify({ name, content }));
}

async function readSkillBackup(
	agentDir: string,
	projectionId: string,
): Promise<{ name: string; content: string } | undefined> {
	let value: unknown;
	try {
		value = await Bun.file(skillBackupPath(agentDir, projectionId)).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (!value || typeof value !== "object" || !("name" in value) || !("content" in value)) return undefined;
	if (typeof value.name !== "string" || typeof value.content !== "string") return undefined;
	return { name: value.name, content: value.content };
}

async function applyManagedSkillProjection(
	options: RunSanBrainProjectionsOptions,
	candidateRecord: SanBrainCandidateRecord,
	projection: SanBrainProjectionRecord,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	if (candidate.action.kind !== "skill_reference") {
		throw new ProjectionBlockedError("Managed-skill projection requires a skill_reference action.", "invalid_draft");
	}
	const description = candidate.action.description?.trim();
	const body = candidate.action.body?.trim();
	if (!description || !body) {
		throw new ProjectionBlockedError("Managed-skill draft is missing description or body.", "invalid_draft");
	}
	const action = candidate.action.action ?? "create";
	if (action === "update" && !candidate.action.expectedHash) {
		throw new ProjectionBlockedError(
			"Managed-skill update requires expectedHash from the approved draft.",
			"invalid_draft",
		);
	}
	if (action === "update") {
		const safe = sanitizeSkillName(candidate.action.skillName);
		const file = path.join(getManagedSkillsDir(options.agentDir), safe, "SKILL.md");
		const current = await Bun.file(file).text();
		const currentHash = contentHash(current);
		if (currentHash !== candidate.action.expectedHash) {
			throw new ProjectionBlockedError(
				`Managed skill ${safe} changed since draft: expected ${candidate.action.expectedHash}, found ${currentHash}.`,
				"cas_mismatch",
			);
		}
		await writeSkillBackup(options.agentDir, projection.projectionId, safe, current);
	}
	try {
		return await writeManagedSkill({
			action,
			name: candidate.action.skillName,
			description,
			body,
			agentDir: options.agentDir,
			...(candidate.action.expectedHash ? { expectedHash: candidate.action.expectedHash } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already exists|changed since approval|symlink|hard links|not a regular file/iu.test(message)) {
			throw new ProjectionBlockedError(message, "cas_mismatch");
		}
		throw error;
	}
}

function checkSuggestionPath(agentDir: string, checkId: string): string {
	const safe = checkId.trim().toLowerCase();
	if (!CHECK_ID_PATTERN.test(safe)) {
		throw new ProjectionBlockedError(`Invalid Brain check suggestion id: ${checkId}`, "invalid_draft");
	}
	return path.join(agentDir, "brain", "check-suggestions", `${safe}.md`);
}

function renderCheckSuggestion(candidate: SanBrainExperienceCandidate, projectionId: string): string {
	if (candidate.action.kind !== "check_suggestion" || !candidate.action.body?.trim()) {
		throw new ProjectionBlockedError("Check suggestion is missing its typed body.", "invalid_draft");
	}
	const title = (candidate.action.title?.trim() || candidate.action.checkId).replace(/[\p{Cc}\p{Cf}<>`]/gu, " ");
	const severity = candidate.action.severity ?? "warning";
	return `---\nname: ${candidate.action.checkId}\nseverity: ${severity}\nsource: ${projectionId}\n---\n\n# ${title}\n\n${candidate.action.body.trim()}\n`;
}

async function applyCheckSuggestionProjection(
	options: RunSanBrainProjectionsOptions,
	candidateRecord: SanBrainCandidateRecord,
	projection: SanBrainProjectionRecord,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	if (candidate.action.kind !== "check_suggestion") {
		throw new ProjectionBlockedError(
			"Check-suggestion projection requires a check_suggestion action.",
			"invalid_draft",
		);
	}
	const file = checkSuggestionPath(options.agentDir, candidate.action.checkId);
	const content = renderCheckSuggestion(candidate, projection.projectionId);
	const afterHash = contentHash(content);
	await fs.mkdir(path.dirname(file), { recursive: true });
	if (await Bun.file(file).exists()) {
		const before = await Bun.file(file).text();
		const beforeHash = contentHash(before);
		if (beforeHash === afterHash) return { beforeHash, afterHash };
		throw new ProjectionBlockedError(
			`Check suggestion ${candidate.action.checkId} already exists with different content.`,
			"cas_mismatch",
		);
	}
	await fs.writeFile(file, content, { flag: "wx" });
	return { afterHash };
}

async function compensateManagedSkillProjection(
	options: RunSanBrainProjectionsOptions,
	candidateRecord: SanBrainCandidateRecord,
	decision: SanBrainDecision,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	if (candidate.action.kind !== "skill_reference") {
		throw new ProjectionBlockedError(
			"Managed-skill compensation requires a skill_reference action.",
			"invalid_draft",
		);
	}
	const previous = options.store.findPreviousAppliedProjection(decision.ownerId, "managed_skill", decision.decisionId);
	if (!previous?.afterHash) {
		throw new ProjectionBlockedError(
			"No applied managed-skill projection is available to compensate.",
			"unsafe_undo",
		);
	}
	if ((candidate.action.action ?? "create") === "create") {
		const deleted = await deleteManagedSkill(candidate.action.skillName, {
			agentDir: options.agentDir,
			expectedHash: previous.afterHash,
		});
		return { beforeHash: deleted.beforeHash };
	}
	const backup = await readSkillBackup(options.agentDir, previous.projectionId);
	if (!backup) {
		throw new ProjectionBlockedError(
			"Managed-skill update backup is missing; refusing destructive compensation.",
			"unsafe_undo",
		);
	}
	return restoreManagedSkillContent(backup.name, backup.content, {
		agentDir: options.agentDir,
		expectedHash: previous.afterHash,
	});
}

async function compensateCheckSuggestionProjection(
	options: RunSanBrainProjectionsOptions,
	candidateRecord: SanBrainCandidateRecord,
	decision: SanBrainDecision,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	if (candidate.action.kind !== "check_suggestion") {
		throw new ProjectionBlockedError(
			"Check-suggestion compensation requires a check_suggestion action.",
			"invalid_draft",
		);
	}
	const previous = options.store.findPreviousAppliedProjection(
		decision.ownerId,
		"check_suggestion",
		decision.decisionId,
	);
	if (!previous?.afterHash) {
		throw new ProjectionBlockedError("No applied check suggestion is available to compensate.", "unsafe_undo");
	}
	const file = checkSuggestionPath(options.agentDir, candidate.action.checkId);
	const content = await Bun.file(file).text();
	const beforeHash = contentHash(content);
	if (beforeHash !== previous.afterHash) {
		throw new ProjectionBlockedError(
			`Check suggestion ${candidate.action.checkId} changed after projection; refusing to delete it.`,
			"cas_mismatch",
		);
	}
	await fs.rm(file);
	return { beforeHash };
}

async function executeProjection(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	decision: SanBrainDecision,
	candidate: SanBrainCandidateRecord,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	if (decision.action === "undo") {
		switch (record.target) {
			case "memory":
				return compensateMemoryProjection(options, decision, signal);
			case "managed_skill":
				return compensateManagedSkillProjection(options, candidate, decision);
			case "check_suggestion":
				return compensateCheckSuggestionProjection(options, candidate, decision);
		}
	}
	switch (record.target) {
		case "memory":
			return applyMemoryProjection(options, candidate, record, signal);
		case "managed_skill":
			return applyManagedSkillProjection(options, candidate, record);
		case "check_suggestion":
			return applyCheckSuggestionProjection(options, candidate, record);
	}
}

async function reconcileFileProjection(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	candidateRecord: SanBrainCandidateRecord,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	let file: string;
	let expectedContent: string;
	if (record.target === "managed_skill") {
		if (candidate.action.kind !== "skill_reference") {
			throw new ProjectionBlockedError(
				"Managed-skill reconcile requires a skill_reference action.",
				"invalid_draft",
			);
		}
		const description = candidate.action.description?.trim();
		const body = candidate.action.body?.trim();
		if (!description || !body) {
			throw new ProjectionBlockedError("Managed-skill reconcile draft is incomplete.", "invalid_draft");
		}
		const safe = sanitizeSkillName(candidate.action.skillName);
		file = path.join(getManagedSkillsDir(options.agentDir), safe, "SKILL.md");
		expectedContent = `${toSkillFrontmatter(safe, description)}\n${body}\n`;
	} else if (record.target === "check_suggestion") {
		if (candidate.action.kind !== "check_suggestion") {
			throw new ProjectionBlockedError("Check reconcile requires a check_suggestion action.", "invalid_draft");
		}
		file = checkSuggestionPath(options.agentDir, candidate.action.checkId);
		expectedContent = renderCheckSuggestion(candidate, record.projectionId);
	} else {
		throw new ProjectionBlockedError("File reconcile received a non-file target.", "invalid_draft");
	}
	let current: string;
	try {
		current = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new ProjectionBlockedError("Projection receipt is missing after interrupted apply.", "receipt_missing");
		}
		throw error;
	}
	const expectedHash = contentHash(expectedContent);
	const currentHash = contentHash(current);
	if (currentHash !== expectedHash) {
		throw new ProjectionBlockedError("Projected file changed during interrupted apply.", "cas_mismatch");
	}
	return { beforeHash: record.beforeHash, afterHash: currentHash, receiptId: currentHash };
}

async function reconcileMemoryProjection(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	const backend = await projectionMemoryBackend(options);
	if (!backend.reconcileProjection) {
		throw new ProjectionBlockedError(
			`Memory backend ${backend.id} cannot reconcile interrupted projections.`,
			"receipt_missing",
		);
	}
	const receipt = await backend.reconcileProjection(memoryOperationContext(options), record.projectionId, signal);
	if (receipt.state !== "applied") {
		throw new ProjectionBlockedError(receipt.message ?? "Memory projection receipt is missing.", "receipt_missing");
	}
	return {
		...(record.afterHash ? { afterHash: record.afterHash } : {}),
		...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
	};
}

async function readProjectedFile(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function reconcileFileCompensation(
	options: RunSanBrainProjectionsOptions,
	decision: SanBrainDecision,
	candidateRecord: SanBrainCandidateRecord,
): Promise<ProjectionMutationResult> {
	const candidate = requireExperienceCandidate(candidateRecord);
	const target =
		candidate.action.kind === "skill_reference"
			? "managed_skill"
			: candidate.action.kind === "check_suggestion"
				? "check_suggestion"
				: undefined;
	if (!target) {
		throw new ProjectionBlockedError("File compensation reconcile received a non-file action.", "invalid_draft");
	}
	const previous = options.store.findPreviousAppliedProjection(decision.ownerId, target, decision.decisionId);
	if (!previous?.afterHash) {
		throw new ProjectionBlockedError(
			"No applied file projection is available to reconcile compensation.",
			"unsafe_undo",
		);
	}

	if (candidate.action.kind === "skill_reference") {
		const safe = sanitizeSkillName(candidate.action.skillName);
		const file = path.join(getManagedSkillsDir(options.agentDir), safe, "SKILL.md");
		const current = await readProjectedFile(file);
		if ((candidate.action.action ?? "create") === "create") {
			if (current === undefined) return { beforeHash: previous.afterHash, receiptId: previous.afterHash };
			if (contentHash(current) === previous.afterHash) {
				throw new ProjectionBlockedError(
					"Interrupted managed-skill delete has no completion receipt.",
					"receipt_missing",
				);
			}
			throw new ProjectionBlockedError("Managed skill changed during interrupted compensation.", "cas_mismatch");
		}
		if (current === undefined) {
			throw new ProjectionBlockedError("Managed skill disappeared during interrupted compensation.", "cas_mismatch");
		}
		const backup = await readSkillBackup(options.agentDir, previous.projectionId);
		if (!backup) {
			throw new ProjectionBlockedError("Managed-skill compensation backup is missing.", "unsafe_undo");
		}
		const currentHash = contentHash(current);
		const restoredHash = contentHash(backup.content);
		if (currentHash === restoredHash) {
			return { beforeHash: previous.afterHash, afterHash: restoredHash, receiptId: restoredHash };
		}
		if (currentHash === previous.afterHash) {
			throw new ProjectionBlockedError(
				"Interrupted managed-skill restore has no completion receipt.",
				"receipt_missing",
			);
		}
		throw new ProjectionBlockedError("Managed skill changed during interrupted compensation.", "cas_mismatch");
	}

	if (candidate.action.kind !== "check_suggestion") {
		throw new ProjectionBlockedError("Check compensation reconcile requires a check suggestion.", "invalid_draft");
	}
	const file = checkSuggestionPath(options.agentDir, candidate.action.checkId);
	const current = await readProjectedFile(file);
	if (current === undefined) return { beforeHash: previous.afterHash, receiptId: previous.afterHash };
	if (contentHash(current) === previous.afterHash) {
		throw new ProjectionBlockedError(
			"Interrupted check-suggestion delete has no completion receipt.",
			"receipt_missing",
		);
	}
	throw new ProjectionBlockedError("Check suggestion changed during interrupted compensation.", "cas_mismatch");
}

async function reconcileMemoryCompensation(
	options: RunSanBrainProjectionsOptions,
	decision: SanBrainDecision,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	const previous = options.store.findPreviousAppliedProjection(decision.ownerId, "memory", decision.decisionId);
	if (!previous) {
		throw new ProjectionBlockedError(
			"No applied memory projection is available to reconcile compensation.",
			"unsafe_undo",
		);
	}
	const backend = await projectionMemoryBackend(options);
	if (!backend.reconcileProjection) {
		throw new ProjectionBlockedError(`Memory backend ${backend.id} cannot reconcile compensation.`, "unsafe_undo");
	}
	const receipt = await backend.reconcileProjection(memoryOperationContext(options), previous.projectionId, signal);
	if (receipt.state === "missing") {
		return {
			...(previous.afterHash ? { beforeHash: previous.afterHash } : {}),
			...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
		};
	}
	if (receipt.state === "applied") {
		throw new ProjectionBlockedError("Interrupted memory compensation has no completion receipt.", "receipt_missing");
	}
	throw new ProjectionBlockedError(receipt.message ?? "Memory compensation cannot be reconciled.", "unsafe_undo");
}

async function reconcileProjection(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	decision: SanBrainDecision,
	candidate: SanBrainCandidateRecord,
	signal?: AbortSignal,
): Promise<ProjectionMutationResult> {
	if (record.state === "compensating" || decision.action === "undo") {
		return record.target === "memory"
			? reconcileMemoryCompensation(options, decision, signal)
			: reconcileFileCompensation(options, decision, candidate);
	}
	return record.target === "memory"
		? reconcileMemoryProjection(options, record, signal)
		: reconcileFileProjection(options, record, candidate);
}

function projectionTimeoutMs(options: RunSanBrainProjectionsOptions): number {
	if (!Number.isFinite(options.attemptTimeoutMs)) return 10_000;
	return Math.max(1, Math.trunc(options.attemptTimeoutMs ?? 10_000));
}

function executeWithProjectionTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	options: RunSanBrainProjectionsOptions,
): Promise<T> {
	const controller = new AbortController();
	const timeoutMs = projectionTimeoutMs(options);
	const operationPromise = operation(controller.signal);
	return withTimeout(operationPromise, timeoutMs, "San Brain projection attempt timed out.").catch(error => {
		if (isProjectionTimeout(error)) {
			controller.abort(new DOMException("San Brain projection attempt timed out.", "TimeoutError"));
		}
		throw error;
	});
}

function isProjectionTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === "San Brain projection attempt timed out.";
}

export async function runSanBrainProjections(
	options: RunSanBrainProjectionsOptions,
): Promise<RunSanBrainProjectionsResult> {
	options.store.syncSessionEntries(options.sessionManager.getSessionId(), options.sessionManager.getEntries());
	const result: RunSanBrainProjectionsResult = {
		applied: 0,
		compensated: 0,
		failed: 0,
		blocked: 0,
	};
	const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
	const states: SanBrainProjectionState[] = options.includeFailed
		? ["pending", "failed", "applying", "compensating"]
		: ["pending", "applying", "compensating"];
	const projections = options.store.listProjections(states, options.limit ?? 100);
	for (const record of projections) {
		if (record.state === "applied" || record.state === "compensated" || record.state === "blocked") continue;
		const decisionRecord = options.store.getDecision(record.decisionId);
		const decision = decisionRecord?.decision;
		const candidate = decision ? options.store.getCandidate(decision.ownerId) : undefined;
		if (!decision || decisionRecord.applicationState !== "applied" || !candidate) {
			appendAudit(options, record, "blocked", record.attemptCount, {
				errorCode: "owner_unavailable",
				error: "Projection owner decision or candidate is unavailable.",
			});
			result.blocked++;
			continue;
		}
		if (record.state === "applying" || record.state === "compensating") {
			const startedAt = performance.now();
			try {
				const reconciled = await executeWithProjectionTimeout(
					signal => reconcileProjection(options, record, decision, candidate, signal),
					options,
				);
				const completedState = record.state === "compensating" ? "compensated" : "applied";
				appendAudit(options, record, completedState, record.attemptCount, {
					...reconciled,
					durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				});
				if (completedState === "applied") result.applied++;
				else result.compensated++;
				result.reconciled = (result.reconciled ?? 0) + 1;
			} catch (error) {
				appendAudit(options, record, "blocked", record.attemptCount, {
					errorCode: isProjectionTimeout(error)
						? "external_timeout"
						: error instanceof ProjectionBlockedError
							? error.code
							: "stale_in_progress",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				});
				result.blocked++;
			}
			continue;
		}
		if (record.attemptCount >= maxAttempts) {
			appendAudit(options, record, "blocked", record.attemptCount, {
				errorCode: "attempts_exhausted",
				error: `Projection exhausted ${maxAttempts} attempts.`,
			});
			result.blocked++;
			continue;
		}
		const attemptCount = record.attemptCount + 1;
		const inProgressState = decision.action === "undo" ? "compensating" : "applying";
		appendAudit(options, record, inProgressState, attemptCount);
		const activeRecord = options.store.getProjection(record.projectionId) ?? record;
		const startedAt = performance.now();
		try {
			const mutation = await executeWithProjectionTimeout(
				signal => executeProjection(options, activeRecord, decision, candidate, signal),
				options,
			);
			const completedState = decision.action === "undo" ? "compensated" : "applied";
			appendAudit(options, activeRecord, completedState, attemptCount, {
				...mutation,
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
			});
			if (completedState === "applied") result.applied++;
			else result.compensated++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const timedOut = isProjectionTimeout(error);
			const state = timedOut ? inProgressState : error instanceof ProjectionBlockedError ? "blocked" : "failed";
			appendAudit(options, activeRecord, state, attemptCount, {
				errorCode: timedOut
					? "external_timeout"
					: error instanceof ProjectionBlockedError
						? error.code
						: "external_failure",
				error: message,
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
			});
			if (timedOut) {
				result.failed++;
			} else if (state === "blocked") {
				result.blocked++;
			} else result.failed++;
		}
	}
	return result;
}

export function buildSanBrainProjectionReportText(result: RunSanBrainProjectionsResult): string {
	return `San Brain projections: applied=${result.applied}, compensated=${result.compensated}, reconciled=${result.reconciled ?? 0}, failed=${result.failed}, blocked=${result.blocked}`;
}
