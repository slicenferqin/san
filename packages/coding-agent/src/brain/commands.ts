import type { ReadonlySessionManager } from "../session/session-manager";
import {
	buildSanBrainConsolidationReport,
	isConflictingSanBrainCandidate,
	isEquivalentSanBrainCandidate,
	type SanBrainConsolidationReport,
} from "./consolidate";
import { appendSanBrainDecision } from "./ledger";
import { buildSanBrainProjectionPlans } from "./projection-plan";
import { isSanBrainRecallTemplateId } from "./recall";
import type { SanBrainCandidateRecord, SanBrainDecisionRecord, SanBrainStore, SanBrainSyncResult } from "./store";
import {
	BRAIN_SCHEMA_VERSION,
	isSanBrainExperienceCandidate,
	type SanBrainDecision,
	type SanBrainDecisionAction,
} from "./types";

const BRAIN_M3_POLICY_VERSION = "brain-m3";

export type SanBrainMutationAction = "approve" | "discard" | "observe" | "escalate" | "undo";

export interface SanBrainMutationRequest {
	action: SanBrainMutationAction;
	id: string;
	reason?: string;
	createdAt?: string;
	requestedBy?: "user" | "policy";
	policyVersion?: string;
}

export interface SanBrainMutationResult {
	action: SanBrainMutationAction;
	targetId: string;
	changed: boolean;
	decisions: SanBrainDecision[];
	sync: SanBrainSyncResult;
}

function decisionId(idempotencyKey: string): string {
	return `brain-decision-${Bun.hash(idempotencyKey).toString(36)}`;
}

function ownerType(candidate: SanBrainCandidateRecord): SanBrainDecision["ownerType"] {
	return candidate.kind === "profile" ? "profile_candidate" : "experience_candidate";
}

interface SanBrainDecisionContext {
	requestedBy: "user" | "policy";
	policyVersion: string;
	createdAt: string;
}

function createDecision(
	candidate: SanBrainCandidateRecord,
	action: SanBrainDecisionAction,
	reason: string,
	idempotencyContext: string,
	context: SanBrainDecisionContext,
): SanBrainDecision {
	const nextRevision = candidate.revision + 1;
	const idempotencyKey = `${context.policyVersion}:${context.requestedBy}:${action}:${candidate.candidate.candidateId}:${nextRevision}:${idempotencyContext}`;
	const nextDecisionId = decisionId(idempotencyKey);
	const projectionIds = buildSanBrainProjectionPlans(candidate.candidate, {
		decisionId: nextDecisionId,
		action,
	}).map(plan => plan.projectionId);
	return {
		schemaVersion: BRAIN_SCHEMA_VERSION,
		decisionId: nextDecisionId,
		ownerType: ownerType(candidate),
		ownerId: candidate.candidate.candidateId,
		action,
		previousRevision: candidate.revision,
		nextRevision,
		requestedBy: context.requestedBy,
		reason,
		policyVersion: context.policyVersion,
		idempotencyKey,
		projectionIds,
		createdAt: context.createdAt,
	};
}

function offsetTimestamp(base: string, offsetMs: number): string {
	const timestamp = Date.parse(base);
	if (!Number.isFinite(timestamp)) throw new Error(`Invalid Brain decision timestamp: ${base}`);
	return new Date(timestamp + offsetMs).toISOString();
}

function requireCandidate(store: SanBrainStore, id: string): SanBrainCandidateRecord {
	const candidate = store.getCandidate(id);
	if (candidate) return candidate;
	const explanation = store.explain(id);
	if (explanation) return explanation.candidate;
	throw new Error(`No San Brain candidate or decision found for ${id}.`);
}

function latestAppliedDecision(candidate: SanBrainCandidateRecord, decisions: readonly SanBrainDecisionRecord[]) {
	return decisions
		.filter(record => record.applicationState === "applied" && record.decision.nextRevision === candidate.revision)
		.at(-1);
}

function planApprove(
	store: SanBrainStore,
	target: SanBrainCandidateRecord,
	reason: string,
	context: SanBrainDecisionContext,
): SanBrainDecision[] {
	if (target.status === "active") return [];
	if (
		isSanBrainExperienceCandidate(target.candidate) &&
		target.candidate.action.kind === "recall_policy" &&
		!isSanBrainRecallTemplateId(target.candidate.action.queryTemplateId)
	) {
		throw new Error(`Unknown San Brain recall template: ${target.candidate.action.queryTemplateId}.`);
	}
	const candidates = store.listCandidates(5000);
	const activeIds = new Set(store.listActiveStates(5000).map(state => state.candidate.candidateId));
	const equivalents = candidates.filter(
		candidate =>
			candidate.candidate.candidateId !== target.candidate.candidateId &&
			isEquivalentSanBrainCandidate(target, candidate) &&
			(candidate.status === "pending" ||
				candidate.status === "observed" ||
				candidate.status === "review" ||
				candidate.status === "active"),
	);
	const activeEquivalent = equivalents.find(candidate => activeIds.has(candidate.candidate.candidateId));
	if (activeEquivalent) {
		return [
			createDecision(
				target,
				"supersede",
				`Equivalent state is already active as ${activeEquivalent.candidate.candidateId}.`,
				`equivalent:${activeEquivalent.candidate.candidateId}`,
				context,
			),
		];
	}

	const decisions = [createDecision(target, "approve", reason, `approve:${target.candidate.candidateId}`, context)];
	const superseded = new Map<string, SanBrainCandidateRecord>();
	for (const candidate of equivalents) superseded.set(candidate.candidate.candidateId, candidate);
	for (const candidate of candidates) {
		if (
			candidate.status === "active" &&
			candidate.candidate.candidateId !== target.candidate.candidateId &&
			isConflictingSanBrainCandidate(target, candidate)
		) {
			superseded.set(candidate.candidate.candidateId, candidate);
		}
	}
	let offset = 1;
	for (const candidate of superseded.values()) {
		decisions.push(
			createDecision(
				candidate,
				"supersede",
				`Superseded by approved candidate ${target.candidate.candidateId}.`,
				`approved-by:${target.candidate.candidateId}`,
				{ ...context, createdAt: offsetTimestamp(context.createdAt, offset++) },
			),
		);
	}
	return decisions;
}

function planStateChange(
	target: SanBrainCandidateRecord,
	action: "discard" | "observe" | "escalate",
	reason: string,
	context: SanBrainDecisionContext,
): SanBrainDecision[] {
	const settledStatus = action === "discard" ? "discarded" : action === "observe" ? "observed" : "review";
	if (target.status === settledStatus) return [];
	return [createDecision(target, action, reason, `${action}:${target.candidate.candidateId}`, context)];
}

function planUndo(
	store: SanBrainStore,
	id: string,
	reason: string,
	context: SanBrainDecisionContext,
): SanBrainDecision[] {
	const target = requireCandidate(store, id);
	const explanation = store.explain(target.candidate.candidateId);
	if (!explanation) throw new Error(`No San Brain decision history found for ${target.candidate.candidateId}.`);
	const requestedDecision = explanation.decisions.find(record => record.decision.decisionId === id);
	const latest = latestAppliedDecision(target, explanation.decisions);
	const decision = requestedDecision ?? latest;
	if (decision?.applicationState !== "applied") {
		throw new Error(`No applied San Brain decision can be undone for ${id}.`);
	}
	if (decision.decision.nextRevision !== target.revision) {
		throw new Error(
			`Cannot undo ${decision.decision.decisionId}: candidate ${target.candidate.candidateId} has newer revision ${target.revision}.`,
		);
	}
	if (decision.decision.action !== "approve" || target.status !== "active") {
		throw new Error("Only the current applied approve decision can be undone in Brain M3.");
	}
	return [createDecision(target, "undo", reason, `undo:${decision.decision.decisionId}`, context)];
}

export function buildSanBrainConsolidation(store: SanBrainStore): SanBrainConsolidationReport {
	return buildSanBrainConsolidationReport(store.listCandidates(5000), store.listActiveStates(5000));
}

export function applySanBrainMutation(
	store: SanBrainStore,
	sessionManager: ReadonlySessionManager,
	request: SanBrainMutationRequest,
): SanBrainMutationResult {
	const targetId = request.id.trim();
	if (!targetId) throw new Error(`San Brain ${request.action} requires an id.`);
	store.syncSessionEntries(sessionManager.getSessionId(), sessionManager.getEntries());
	const createdAt = request.createdAt ?? new Date().toISOString();
	const requestedBy = request.requestedBy ?? "user";
	const context: SanBrainDecisionContext = {
		requestedBy,
		policyVersion: request.policyVersion?.trim() || BRAIN_M3_POLICY_VERSION,
		createdAt,
	};
	const reason = request.reason?.trim() || `${request.action} requested by ${requestedBy}.`;
	const target = requireCandidate(store, targetId);
	let decisions: SanBrainDecision[];
	switch (request.action) {
		case "approve":
			decisions = planApprove(store, target, reason, context);
			break;
		case "discard":
		case "observe":
		case "escalate":
			decisions = planStateChange(target, request.action, reason, context);
			break;
		case "undo":
			decisions = planUndo(store, targetId, reason, context);
			break;
	}
	if (decisions.length === 0) {
		return {
			action: request.action,
			targetId,
			changed: false,
			decisions: [],
			sync: { candidatesAdded: 0, decisionsAdded: 0, decisionsApplied: 0, decisionsBlocked: 0 },
		};
	}
	for (const decision of decisions) appendSanBrainDecision(sessionManager, decision);
	const sync = store.syncSessionEntries(sessionManager.getSessionId(), sessionManager.getEntries());
	for (const decision of decisions) {
		const record = store.getDecision(decision.decisionId);
		if (!record) throw new Error(`Brain decision ${decision.decisionId} was not persisted to the durable store.`);
		if (record.applicationState === "blocked") {
			throw new Error(record.applicationError ?? `Brain decision ${decision.decisionId} was blocked.`);
		}
	}
	return { action: request.action, targetId, changed: true, decisions, sync };
}
