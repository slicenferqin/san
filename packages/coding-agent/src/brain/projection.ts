import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	restoreManagedSkillContent,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { createSessionMemoryRuntimeContext } from "../memory-backend/runtime";
import type { AgentSession } from "../session/agent-session";
import type { ReadonlySessionManager } from "../session/session-manager";
import { appendSanBrainProjection } from "./ledger";
import type { SanBrainCandidateRecord, SanBrainProjectionRecord, SanBrainStore } from "./store";
import {
	BRAIN_SCHEMA_VERSION,
	type SanBrainDecision,
	type SanBrainExperienceCandidate,
	type SanBrainProjection,
	type SanBrainProjectionState,
} from "./types";

const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

class ProjectionBlockedError extends Error {}

export interface RunSanBrainProjectionsOptions {
	store: SanBrainStore;
	sessionManager: ReadonlySessionManager;
	session?: AgentSession;
	agentDir: string;
	cwd: string;
	maxAttempts: number;
	limit?: number;
}

export interface RunSanBrainProjectionsResult {
	applied: number;
	compensated: number;
	failed: number;
	blocked: number;
}

interface ProjectionMutationResult {
	beforeHash?: string;
	afterHash?: string;
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
	updates: ProjectionMutationResult & { error?: string } = {},
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
		...(updates.error ? { error: updates.error } : {}),
		updatedAt: nextUpdatedAt(record.updatedAt),
	};
}

function appendAudit(
	options: RunSanBrainProjectionsOptions,
	record: SanBrainProjectionRecord,
	state: SanBrainProjectionState,
	attemptCount: number,
	updates: ProjectionMutationResult & { error?: string } = {},
): void {
	appendSanBrainProjection(options.sessionManager, projectionAudit(record, state, attemptCount, updates));
	options.store.syncSessionEntries(options.sessionManager.getSessionId(), options.sessionManager.getEntries());
}

function requireExperienceCandidate(candidate: SanBrainCandidateRecord): SanBrainExperienceCandidate {
	if (candidate.kind !== "experience" || !("selector" in candidate.candidate)) {
		throw new ProjectionBlockedError(`Projection target requires an experience candidate, found ${candidate.kind}.`);
	}
	return candidate.candidate;
}

async function applyMemoryProjection(
	options: RunSanBrainProjectionsOptions,
	candidate: SanBrainCandidateRecord,
	projection: SanBrainProjectionRecord,
): Promise<ProjectionMutationResult> {
	if (!options.session) throw new ProjectionBlockedError("Memory projection requires an active agent session.");
	if (candidate.kind !== "profile" || !("subject" in candidate.candidate)) {
		throw new ProjectionBlockedError("Memory projection requires a profile candidate.");
	}
	const value = candidate.candidate;
	const content = `${value.subject}: ${value.predicate} = ${value.value}`;
	const runtime = createSessionMemoryRuntimeContext(options.session, options.agentDir, options.cwd);
	const saved = await runtime.save({
		content,
		context: `${value.scope.kind}:${value.scope.key}`,
		source: `san.brain.projection:${projection.projectionId}`,
		importance: value.importance,
	});
	if (saved.stored < 1 && saved.queued !== true) {
		throw new Error(saved.message ?? `Memory backend ${saved.backend} did not store the approved Brain state.`);
	}
	return { afterHash: saved.ids?.join(",") || contentHash(content) };
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
		throw new ProjectionBlockedError("Managed-skill projection requires a skill_reference action.");
	}
	const description = candidate.action.description?.trim();
	const body = candidate.action.body?.trim();
	if (!description || !body) throw new ProjectionBlockedError("Managed-skill draft is missing description or body.");
	const action = candidate.action.action ?? "create";
	if (action === "update" && !candidate.action.expectedHash) {
		throw new ProjectionBlockedError("Managed-skill update requires expectedHash from the approved draft.");
	}
	if (action === "update") {
		const safe = sanitizeSkillName(candidate.action.skillName);
		const file = path.join(getManagedSkillsDir(options.agentDir), safe, "SKILL.md");
		const current = await Bun.file(file).text();
		const currentHash = contentHash(current);
		if (currentHash !== candidate.action.expectedHash) {
			throw new ProjectionBlockedError(
				`Managed skill ${safe} changed since draft: expected ${candidate.action.expectedHash}, found ${currentHash}.`,
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
			throw new ProjectionBlockedError(message);
		}
		throw error;
	}
}

function checkSuggestionPath(agentDir: string, checkId: string): string {
	const safe = checkId.trim().toLowerCase();
	if (!CHECK_ID_PATTERN.test(safe)) throw new ProjectionBlockedError(`Invalid Brain check suggestion id: ${checkId}`);
	return path.join(agentDir, "brain", "check-suggestions", `${safe}.md`);
}

function renderCheckSuggestion(candidate: SanBrainExperienceCandidate, projectionId: string): string {
	if (candidate.action.kind !== "check_suggestion" || !candidate.action.body?.trim()) {
		throw new ProjectionBlockedError("Check suggestion is missing its typed body.");
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
		throw new ProjectionBlockedError("Check-suggestion projection requires a check_suggestion action.");
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
		throw new ProjectionBlockedError("Managed-skill compensation requires a skill_reference action.");
	}
	const previous = options.store.findPreviousAppliedProjection(decision.ownerId, "managed_skill", decision.decisionId);
	if (!previous?.afterHash)
		throw new ProjectionBlockedError("No applied managed-skill projection is available to compensate.");
	if ((candidate.action.action ?? "create") === "create") {
		const deleted = await deleteManagedSkill(candidate.action.skillName, {
			agentDir: options.agentDir,
			expectedHash: previous.afterHash,
		});
		return { beforeHash: deleted.beforeHash };
	}
	const backup = await readSkillBackup(options.agentDir, previous.projectionId);
	if (!backup)
		throw new ProjectionBlockedError("Managed-skill update backup is missing; refusing destructive compensation.");
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
		throw new ProjectionBlockedError("Check-suggestion compensation requires a check_suggestion action.");
	}
	const previous = options.store.findPreviousAppliedProjection(
		decision.ownerId,
		"check_suggestion",
		decision.decisionId,
	);
	if (!previous?.afterHash)
		throw new ProjectionBlockedError("No applied check suggestion is available to compensate.");
	const file = checkSuggestionPath(options.agentDir, candidate.action.checkId);
	const content = await Bun.file(file).text();
	const beforeHash = contentHash(content);
	if (beforeHash !== previous.afterHash) {
		throw new ProjectionBlockedError(
			`Check suggestion ${candidate.action.checkId} changed after projection; refusing to delete it.`,
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
): Promise<ProjectionMutationResult> {
	if (decision.action === "undo") {
		switch (record.target) {
			case "memory":
				throw new ProjectionBlockedError(
					"The active memory backend does not expose safe compensation by projection id.",
				);
			case "managed_skill":
				return compensateManagedSkillProjection(options, candidate, decision);
			case "check_suggestion":
				return compensateCheckSuggestionProjection(options, candidate, decision);
		}
	}
	switch (record.target) {
		case "memory":
			return applyMemoryProjection(options, candidate, record);
		case "managed_skill":
			return applyManagedSkillProjection(options, candidate, record);
		case "check_suggestion":
			return applyCheckSuggestionProjection(options, candidate, record);
	}
}

export async function runSanBrainProjections(
	options: RunSanBrainProjectionsOptions,
): Promise<RunSanBrainProjectionsResult> {
	options.store.syncSessionEntries(options.sessionManager.getSessionId(), options.sessionManager.getEntries());
	const result: RunSanBrainProjectionsResult = { applied: 0, compensated: 0, failed: 0, blocked: 0 };
	const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
	const projections = options.store.listProjections(undefined, options.limit ?? 100);
	for (const record of projections) {
		if (record.state === "applied" || record.state === "compensated" || record.state === "blocked") continue;
		if (record.state === "applying" || record.state === "compensating") {
			appendAudit(options, record, "blocked", record.attemptCount, {
				error: "Previous projection attempt ended without a durable receipt; refusing a blind retry.",
			});
			result.blocked++;
			continue;
		}
		if (record.attemptCount >= maxAttempts) {
			appendAudit(options, record, "blocked", record.attemptCount, {
				error: `Projection exhausted ${maxAttempts} attempts.`,
			});
			result.blocked++;
			continue;
		}
		const decisionRecord = options.store.getDecision(record.decisionId);
		const decision = decisionRecord?.decision;
		const candidate = decision ? options.store.getCandidate(decision.ownerId) : undefined;
		if (!decision || decisionRecord.applicationState !== "applied" || !candidate) {
			appendAudit(options, record, "blocked", record.attemptCount, {
				error: "Projection owner decision or candidate is unavailable.",
			});
			result.blocked++;
			continue;
		}
		const attemptCount = record.attemptCount + 1;
		const inProgressState = decision.action === "undo" ? "compensating" : "applying";
		appendAudit(options, record, inProgressState, attemptCount);
		const activeRecord = options.store.getProjection(record.projectionId) ?? record;
		try {
			const mutation = await executeProjection(options, activeRecord, decision, candidate);
			const completedState = decision.action === "undo" ? "compensated" : "applied";
			appendAudit(options, activeRecord, completedState, attemptCount, mutation);
			if (completedState === "applied") result.applied++;
			else result.compensated++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const state = error instanceof ProjectionBlockedError || record.target === "memory" ? "blocked" : "failed";
			appendAudit(options, activeRecord, state, attemptCount, { error: message });
			if (state === "blocked") result.blocked++;
			else result.failed++;
		}
	}
	return result;
}

export function buildSanBrainProjectionReportText(result: RunSanBrainProjectionsResult): string {
	return `San Brain projections: applied=${result.applied}, compensated=${result.compensated}, failed=${result.failed}, blocked=${result.blocked}`;
}
