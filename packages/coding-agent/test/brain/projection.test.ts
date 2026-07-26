import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { deleteManagedSkill, getManagedSkillsDir, writeManagedSkill } from "@san/coding-agent/autolearn/managed-skills";
import { applySanBrainMutation } from "@san/coding-agent/brain/commands";
import {
	appendSanBrainExperienceCandidate,
	appendSanBrainProfileCandidate,
	appendSanBrainProjection,
} from "@san/coding-agent/brain/ledger";
import { runSanBrainProjections } from "@san/coding-agent/brain/projection";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import type {
	SanBrainAction,
	SanBrainExperienceCandidate,
	SanBrainExperienceCandidateType,
	SanBrainProfileCandidate,
} from "@san/coding-agent/brain/types";
import { Settings } from "@san/coding-agent/config/settings";
import * as memoryBackend from "@san/coding-agent/memory-backend";
import type { MemoryBackend } from "@san/coding-agent/memory-backend/types";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

function experienceCandidate(
	candidateId: string,
	type: SanBrainExperienceCandidateType,
	action: SanBrainAction,
): SanBrainExperienceCandidate {
	return {
		schemaVersion: 1,
		candidateId,
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type,
		selector: {},
		action,
		taskTags: [],
		claimKey: `${type}:${candidateId}`,
		dedupeKey: `${type}:${candidateId}`,
		conflictKey: `${type}:${candidateId}`,
		repeatCount: 1,
		confidence: 0.95,
		impact: "medium",
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-10T10:00:00.000Z",
	};
}

async function fileText(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch {
		return undefined;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("San Brain M5 projections", () => {
	it("materializes an approved managed skill exactly once", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-create-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("skill-create", "skill_candidate", {
					kind: "skill_reference",
					skillName: "brain-created",
					description: "Created from an approved Brain draft.",
					body: "# Brain Created\n\nFollow the approved workflow.",
				}),
			);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: "skill-create" });
			expect(mutation.decisions[0]?.projectionIds).toHaveLength(1);
			expect(store.listProjections(["pending"])).toHaveLength(1);

			const first = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				includeFailed: true,
			});
			expect(first).toEqual({ applied: 1, compensated: 0, failed: 0, blocked: 0 });
			const skillFile = path.join(getManagedSkillsDir(agentDir), "brain-created", "SKILL.md");
			const projected = await Bun.file(skillFile).text();
			expect(projected).toContain("Created from an approved Brain draft.");
			expect(store.listProjections(["applied"])).toHaveLength(1);

			const second = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
			});
			expect(second).toEqual({ applied: 0, compensated: 0, failed: 0, blocked: 0 });
			expect(await Bun.file(skillFile).text()).toBe(projected);
		} finally {
			store.close();
		}
	});

	it("restores the prior managed skill through an undo projection", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-undo-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const original = await writeManagedSkill({
				action: "create",
				name: "brain-updated",
				description: "Original description.",
				body: "# Original\n\nKeep this content.",
				agentDir,
			});
			const skillFile = path.join(getManagedSkillsDir(agentDir), "brain-updated", "SKILL.md");
			const originalContent = await Bun.file(skillFile).text();
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("skill-update", "skill_candidate", {
					kind: "skill_reference",
					skillName: "brain-updated",
					description: "Approved updated description.",
					body: "# Updated\n\nUse the new workflow.",
					action: "update",
					expectedHash: original.afterHash,
				}),
			);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			applySanBrainMutation(store, manager, { action: "approve", id: "skill-update" });
			expect(
				await runSanBrainProjections({ store, sessionManager: manager, agentDir, cwd: agentDir, maxAttempts: 3 }),
			).toMatchObject({ applied: 1 });
			expect(await Bun.file(skillFile).text()).toContain("Approved updated description.");

			applySanBrainMutation(store, manager, { action: "undo", id: "skill-update" });
			const undoResult = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
			});
			expect(store.listProjections(["failed"])).toEqual([]);
			expect(undoResult).toMatchObject({ compensated: 1 });
			expect(await Bun.file(skillFile).text()).toBe(originalContent);
			expect(store.listProjections(["compensated"])).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("reconciles a completed managed-skill compensation after an interrupted audit", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-undo-reconcile-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const candidate = experienceCandidate("skill-undo-reconcile", "skill_candidate", {
				kind: "skill_reference",
				skillName: "undo-reconcile",
				description: "Reconcile a completed delete after restart.",
				body: "# Undo Reconcile\n\nDelete exactly once.",
			});
			appendSanBrainExperienceCandidate(manager, candidate);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			applySanBrainMutation(store, manager, { action: "approve", id: candidate.candidateId });
			expect(
				await runSanBrainProjections({ store, sessionManager: manager, agentDir, cwd: agentDir, maxAttempts: 3 }),
			).toMatchObject({ applied: 1 });
			const applied = store.explain(candidate.candidateId)?.projections.find(record => record.state === "applied");
			if (!applied?.afterHash) throw new Error("Expected applied managed-skill projection.");

			const undo = applySanBrainMutation(store, manager, { action: "undo", id: candidate.candidateId });
			const undoProjectionId = undo.decisions[0]?.projectionIds[0];
			if (!undoProjectionId) throw new Error("Expected undo projection.");
			await deleteManagedSkill("undo-reconcile", { agentDir, expectedHash: applied.afterHash });
			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId: undoProjectionId,
				decisionId: undo.decisions[0]!.decisionId,
				target: "managed_skill",
				state: "compensating",
				attemptCount: 1,
				revision: 2,
				updatedAt: new Date(Date.now() + 1).toISOString(),
			});

			const result = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
			});
			expect(result).toMatchObject({ compensated: 1, reconciled: 1, blocked: 0 });
			expect(store.getProjection(undoProjectionId)).toMatchObject({ state: "compensated", attemptCount: 1 });
			expect(await fileText(path.join(getManagedSkillsDir(agentDir), "undo-reconcile", "SKILL.md"))).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("blocks one unsafe check suggestion without suppressing another projection", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-isolation-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("skill-safe", "skill_candidate", {
					kind: "skill_reference",
					skillName: "safe-sibling",
					description: "Safe sibling projection.",
					body: "# Safe\n\nThis projection should still apply.",
				}),
			);
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("check-unsafe", "check_candidate", {
					kind: "check_suggestion",
					checkId: "../unsafe",
					body: "Reject unsafe projection paths.",
				}),
			);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			applySanBrainMutation(store, manager, { action: "approve", id: "skill-safe" });
			applySanBrainMutation(store, manager, { action: "approve", id: "check-unsafe" });

			const result = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				includeFailed: true,
			});
			expect(result).toEqual({ applied: 1, compensated: 0, failed: 0, blocked: 1 });
			expect(await fileText(path.join(getManagedSkillsDir(agentDir), "safe-sibling", "SKILL.md"))).toContain(
				"Safe sibling projection.",
			);
			expect(store.listProjections(["blocked"])).toMatchObject([
				{ target: "check_suggestion", error: "Invalid Brain check suggestion id: ../unsafe" },
			]);
		} finally {
			store.close();
		}
	});

	it("blocks stale in-progress projections before retrying side effects", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-stale-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("skill-stale", "skill_candidate", {
					kind: "skill_reference",
					skillName: "stale-projection",
					description: "This projection must not be retried blindly.",
					body: "# Stale\n\nDo not write this after an interrupted attempt.",
				}),
			);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: "skill-stale" });
			const decision = mutation.decisions[0];
			if (!decision) throw new Error("Expected approval decision.");
			const projectionId = decision.projectionIds[0];
			if (!projectionId) throw new Error("Expected managed skill projection.");
			const pendingProjection = store.getProjection(projectionId);
			if (!pendingProjection) throw new Error("Expected pending projection.");
			const staleAuditUpdatedAt = new Date(Date.parse(pendingProjection.updatedAt) + 1).toISOString();

			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId,
				decisionId: decision.decisionId,
				target: "managed_skill",
				state: "applying",
				attemptCount: 1,
				revision: 1,
				updatedAt: staleAuditUpdatedAt,
			});

			const result = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				includeFailed: true,
			});
			expect(result).toEqual({ applied: 0, compensated: 0, failed: 0, blocked: 1 });
			expect(
				await fileText(path.join(getManagedSkillsDir(agentDir), "stale-projection", "SKILL.md")),
			).toBeUndefined();
			expect(store.listProjections(["blocked"])).toMatchObject([
				{
					projectionId,
					errorCode: "receipt_missing",
					error: "Projection receipt is missing after interrupted apply.",
				},
			]);
		} finally {
			store.close();
		}
	});

	it("blocks exhausted failed projections without applying side effects", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-exhausted-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			appendSanBrainExperienceCandidate(
				manager,
				experienceCandidate("skill-exhausted", "skill_candidate", {
					kind: "skill_reference",
					skillName: "exhausted-projection",
					description: "This projection already exhausted retries.",
					body: "# Exhausted\n\nDo not write after retry exhaustion.",
				}),
			);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: "skill-exhausted" });
			const decision = mutation.decisions[0];
			if (!decision) throw new Error("Expected approval decision.");
			const projectionId = decision.projectionIds[0];
			if (!projectionId) throw new Error("Expected managed skill projection.");
			const pendingProjection = store.getProjection(projectionId);
			if (!pendingProjection) throw new Error("Expected pending projection.");
			const failedAuditUpdatedAt = new Date(Date.parse(pendingProjection.updatedAt) + 1).toISOString();

			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId,
				decisionId: decision.decisionId,
				target: "managed_skill",
				state: "failed",
				attemptCount: 3,
				revision: 1,
				error: "transient write failure",
				updatedAt: failedAuditUpdatedAt,
			});

			const result = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				includeFailed: true,
			});
			expect(result).toEqual({ applied: 0, compensated: 0, failed: 0, blocked: 1 });
			expect(
				await fileText(path.join(getManagedSkillsDir(agentDir), "exhausted-projection", "SKILL.md")),
			).toBeUndefined();
			expect(store.getProjection(projectionId)).toMatchObject({
				state: "blocked",
				attemptCount: 3,
				error: "Projection exhausted 3 attempts.",
			});
		} finally {
			store.close();
		}
	});

	it("reconciles an interrupted managed-skill apply without replaying the write", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-reconcile-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const candidate = experienceCandidate("skill-reconcile", "skill_candidate", {
				kind: "skill_reference",
				skillName: "reconciled-skill",
				description: "Recovered from an interrupted apply.",
				body: "# Reconciled\n\nUse the durable receipt.",
			});
			appendSanBrainExperienceCandidate(manager, candidate);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: candidate.candidateId });
			const decision = mutation.decisions[0];
			const projectionId = decision?.projectionIds[0];
			if (!decision || !projectionId) throw new Error("Expected managed-skill projection.");
			const write = await writeManagedSkill({
				action: "create",
				name: "reconciled-skill",
				description: "Recovered from an interrupted apply.",
				body: "# Reconciled\n\nUse the durable receipt.",
				agentDir,
			});
			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId,
				decisionId: decision.decisionId,
				target: "managed_skill",
				state: "applying",
				attemptCount: 1,
				revision: 1,
				updatedAt: new Date(Date.now() + 1).toISOString(),
			});

			const result = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
			});

			expect(result).toMatchObject({ applied: 1, reconciled: 1, failed: 0, blocked: 0 });
			expect(store.getProjection(projectionId)).toMatchObject({
				state: "applied",
				attemptCount: 1,
				afterHash: write.afterHash,
				receiptId: write.afterHash,
			});
		} finally {
			store.close();
		}
	});

	it("keeps failed projections silent until an explicit retry includes them", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-explicit-retry-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const candidate = experienceCandidate("skill-retry", "skill_candidate", {
				kind: "skill_reference",
				skillName: "explicit-retry",
				description: "Retried only on explicit command.",
				body: "# Explicit Retry\n\nDo not retry automatically.",
			});
			appendSanBrainExperienceCandidate(manager, candidate);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: candidate.candidateId });
			const decision = mutation.decisions[0];
			const projectionId = decision?.projectionIds[0];
			if (!decision || !projectionId) throw new Error("Expected managed-skill projection.");
			appendSanBrainProjection(manager, {
				schemaVersion: 1,
				projectionId,
				decisionId: decision.decisionId,
				target: "managed_skill",
				state: "failed",
				attemptCount: 1,
				revision: 1,
				errorCode: "external_failure",
				error: "temporary failure",
				updatedAt: new Date(Date.now() + 1).toISOString(),
			});

			expect(
				await runSanBrainProjections({ store, sessionManager: manager, agentDir, cwd: agentDir, maxAttempts: 3 }),
			).toEqual({
				applied: 0,
				compensated: 0,
				failed: 0,
				blocked: 0,
			});
			expect(await fileText(path.join(getManagedSkillsDir(agentDir), "explicit-retry", "SKILL.md"))).toBeUndefined();

			const retried = await runSanBrainProjections({
				store,
				sessionManager: manager,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				includeFailed: true,
			});
			expect(retried).toMatchObject({ applied: 1, failed: 0, blocked: 0 });
			expect(store.getProjection(projectionId)).toMatchObject({ state: "applied", attemptCount: 2 });
		} finally {
			store.close();
		}
	});

	it("records an external timeout and reconciles without replaying the memory write", async () => {
		using tempDir = TempDir.createSync("@san-brain-projection-timeout-");
		const agentDir = tempDir.path();
		const manager = SessionManager.inMemory(agentDir);
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const candidate: SanBrainProfileCandidate = {
				schemaVersion: 1,
				candidateId: "memory-timeout",
				scope: { kind: "user", key: "user:local", resolverVersion: 1 },
				type: "user_preference",
				subject: "delivery",
				predicate: "format",
				value: "HTML",
				claimKey: "delivery:format",
				dedupeKey: "delivery:format:html",
				taskTags: [],
				confidence: 0.95,
				importance: 0.8,
				independentEvidenceCount: 2,
				sensitivity: "normal",
				evidence: [],
				createdAt: "2026-07-11T08:00:00.000Z",
			};
			appendSanBrainProfileCandidate(manager, candidate);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			const mutation = applySanBrainMutation(store, manager, { action: "approve", id: candidate.candidateId });
			const projectionId = mutation.decisions[0]?.projectionIds[0];
			if (!projectionId) throw new Error("Expected memory projection.");
			const project = vi.fn(async (_context, input) => {
				await Bun.sleep(25);
				input.signal?.throwIfAborted();
				return { backend: "mnemopi" as const, stored: 1, ids: ["late-receipt"] };
			});
			const reconcileProjection = vi.fn(async () => ({ state: "missing" as const }));
			const backend: MemoryBackend = {
				id: "mnemopi",
				async start() {},
				async buildDeveloperInstructions() {
					return undefined;
				},
				async clear() {},
				async enqueue() {},
				project,
				reconcileProjection,
			};
			vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
			const settings = Settings.isolated({ "memory.backend": "mnemopi" });
			const session = { settings } as AgentSession;

			const timedOut = await runSanBrainProjections({
				store,
				sessionManager: manager,
				session,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				attemptTimeoutMs: 1,
			});
			expect(timedOut).toMatchObject({ applied: 0, failed: 1, blocked: 0 });
			expect(store.getProjection(projectionId)).toMatchObject({
				state: "applying",
				attemptCount: 1,
				errorCode: "external_timeout",
			});

			const reconciled = await runSanBrainProjections({
				store,
				sessionManager: manager,
				session,
				agentDir,
				cwd: agentDir,
				maxAttempts: 3,
				attemptTimeoutMs: 100,
			});
			expect(reconciled).toMatchObject({ applied: 0, failed: 0, blocked: 1 });
			expect(project).toHaveBeenCalledTimes(1);
			expect(reconcileProjection).toHaveBeenCalledTimes(1);
			expect(store.getProjection(projectionId)).toMatchObject({ state: "blocked", errorCode: "receipt_missing" });
		} finally {
			store.close();
		}
	});
});
