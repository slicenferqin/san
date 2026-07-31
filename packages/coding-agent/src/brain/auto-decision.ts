import type { ReadonlySessionManager } from "../session/session-manager";
import { applySanBrainMutation, type SanBrainMutationAction } from "./commands";
import {
	isConflictingSanBrainCandidate,
	isEquivalentSanBrainCandidate,
	mergeSanBrainCandidateRecords,
} from "./consolidate";
import { getSanBrainProjectionTarget } from "./projection-plan";
import { isSanBrainRecallTemplateId } from "./recall";
import type { SanBrainCandidateRecord, SanBrainStore } from "./store";
import { isSanBrainExperienceCandidate, isSanBrainProfileCandidate } from "./types";

export const SAN_BRAIN_AUTO_DECISION_POLICY_VERSION = "brain-auto-v1";

export interface SanBrainAutoDecisionOptions {
	store: SanBrainStore;
	sessionManager: ReadonlySessionManager;
	candidateIds?: readonly string[];
	explicitMinConfidence: number;
	inferredMinConfidence: number;
	minIndependentEvidence: number;
	maxPerTurn: number;
	createdAt?: string;
}

export interface SanBrainAutoDecisionEvaluation {
	action: Exclude<SanBrainMutationAction, "undo">;
	reason: string;
	authorization: "explicit_user" | "inferred";
	confidence: number;
	evidenceCount: number;
}

export interface SanBrainAutoDecisionOutcome extends SanBrainAutoDecisionEvaluation {
	candidateId: string;
	decisionIds: string[];
}

export interface SanBrainAutoDecisionFailure {
	candidateId: string;
	error: string;
}

export interface SanBrainAutoDecisionResult {
	evaluated: number;
	automaticallyHandled: number;
	escalated: number;
	outcomes: SanBrainAutoDecisionOutcome[];
	failures: SanBrainAutoDecisionFailure[];
}

function clampProbability(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function resolvedAuthorization(record: SanBrainCandidateRecord): "explicit_user" | "inferred" {
	return record.candidate.authorization === "explicit_user" ? "explicit_user" : "inferred";
}

export function evaluateSanBrainAutoDecision(
	record: SanBrainCandidateRecord,
	candidates: readonly SanBrainCandidateRecord[],
	activeRecords: readonly SanBrainCandidateRecord[],
	options: Pick<
		SanBrainAutoDecisionOptions,
		"explicitMinConfidence" | "inferredMinConfidence" | "minIndependentEvidence"
	>,
	now = Date.now(),
): SanBrainAutoDecisionEvaluation {
	const evidenceRecords = candidates.filter(
		candidate =>
			(candidate.status === "pending" ||
				candidate.status === "observed" ||
				candidate.status === "review" ||
				candidate.status === "active") &&
			isEquivalentSanBrainCandidate(record, candidate),
	);
	const candidate = mergeSanBrainCandidateRecords(record, evidenceRecords);
	const authorization = resolvedAuthorization({ ...record, candidate });
	const confidence = clampProbability(candidate.confidence);
	const evidenceCount = isSanBrainProfileCandidate(candidate)
		? candidate.independentEvidenceCount
		: isSanBrainExperienceCandidate(candidate)
			? candidate.repeatCount
			: 0;
	const result = (action: SanBrainAutoDecisionEvaluation["action"], reason: string) => ({
		action,
		reason,
		authorization,
		confidence,
		evidenceCount,
	});

	if (candidate.sensitivity !== "normal") {
		return result("discard", "Sensitive candidates are not retained automatically.");
	}
	if (candidate.expiresAt) {
		const expiresAt = Date.parse(candidate.expiresAt);
		if (Number.isFinite(expiresAt) && expiresAt <= now) {
			return result("discard", "Candidate expired before automatic evaluation.");
		}
	}

	const activeEquivalent = activeRecords.some(active => isEquivalentSanBrainCandidate(record, active));
	if (activeEquivalent) {
		return result("approve", "Equivalent state is already active; consolidate without user review.");
	}
	const activeConflict = activeRecords.some(active => isConflictingSanBrainCandidate(record, active));
	const projectionTarget = getSanBrainProjectionTarget(candidate);
	const externalDraft = projectionTarget === "managed_skill" || projectionTarget === "check_suggestion";
	if (externalDraft) {
		return result("observe", `${projectionTarget} draft retained without interrupting the user.`);
	}
	if (
		isSanBrainExperienceCandidate(candidate) &&
		candidate.action.kind === "recall_policy" &&
		!isSanBrainRecallTemplateId(candidate.action.queryTemplateId)
	) {
		return result("discard", "Unknown recall policy template cannot be activated safely.");
	}

	if (authorization === "explicit_user") {
		if (confidence < clampProbability(options.explicitMinConfidence)) {
			return result("observe", "Explicit user direction is below the automatic confidence threshold.");
		}
		return result(
			"approve",
			activeConflict
				? "Explicit current user direction supersedes conflicting active state."
				: "Explicit durable user direction is safe to activate automatically.",
		);
	}
	if (isSanBrainExperienceCandidate(candidate) && candidate.impact === "high") {
		return result("escalate", "High-impact inferred behavior requires review.");
	}
	if (activeConflict) {
		return result("escalate", "Inferred candidate conflicts with active state.");
	}
	if (
		(isSanBrainProfileCandidate(candidate) && candidate.type === "other") ||
		(isSanBrainExperienceCandidate(candidate) && (candidate.type === "other" || candidate.type === "do_not_retain"))
	) {
		return result("discard", "Candidate has no durable executable Brain contract.");
	}
	if (confidence < clampProbability(options.inferredMinConfidence)) {
		return result("observe", "Inferred candidate needs stronger confidence before activation.");
	}
	if (evidenceCount < Math.max(1, Math.trunc(options.minIndependentEvidence))) {
		return result("observe", "Inferred candidate needs independent repeated evidence before activation.");
	}
	return result("approve", "Repeated high-confidence candidate is safe to activate automatically.");
}

export function runSanBrainAutoDecisions(options: SanBrainAutoDecisionOptions): SanBrainAutoDecisionResult {
	options.store.syncSessionEntries(options.sessionManager.getSessionId(), options.sessionManager.getEntries());
	const candidates = options.store.listCandidates(5000);
	const pendingIds = candidates
		.filter(candidate => candidate.status === "pending")
		.map(candidate => candidate.candidate.candidateId);
	const prioritizedIds = options.candidateIds ? [...options.candidateIds, ...pendingIds] : pendingIds;
	const requestedIds = [...new Set(prioritizedIds)];
	const limit = Math.max(0, Math.trunc(options.maxPerTurn));
	const selectedIds = requestedIds.slice(0, limit);
	const outcomes: SanBrainAutoDecisionOutcome[] = [];
	const failures: SanBrainAutoDecisionFailure[] = [];
	const baseTimestamp = options.createdAt ? Date.parse(options.createdAt) : Date.now();
	const createdAtMs = Number.isFinite(baseTimestamp) ? baseTimestamp : Date.now();

	for (let index = 0; index < selectedIds.length; index++) {
		const candidateId = selectedIds[index]!;
		const record = options.store.getCandidate(candidateId);
		if (record?.status !== "pending") continue;
		const currentCandidates = options.store.listCandidates(5000);
		const activeRecords = options.store
			.listActiveStates(5000)
			.map(state => options.store.getCandidate(state.candidate.candidateId))
			.filter((active): active is SanBrainCandidateRecord => active !== undefined);
		const evaluation = evaluateSanBrainAutoDecision(record, currentCandidates, activeRecords, options);
		try {
			const mutation = applySanBrainMutation(options.store, options.sessionManager, {
				action: evaluation.action,
				id: candidateId,
				reason: evaluation.reason,
				createdAt: new Date(createdAtMs + index).toISOString(),
				requestedBy: "policy",
				policyVersion: SAN_BRAIN_AUTO_DECISION_POLICY_VERSION,
			});
			outcomes.push({
				...evaluation,
				candidateId,
				decisionIds: mutation.decisions.map(decision => decision.decisionId),
			});
		} catch (error) {
			failures.push({ candidateId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const escalated = outcomes.filter(outcome => outcome.action === "escalate").length;
	return {
		evaluated: outcomes.length + failures.length,
		automaticallyHandled: outcomes.length - escalated,
		escalated,
		outcomes,
		failures,
	};
}
