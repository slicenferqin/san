import type { CustomEntry, SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import {
	BRAIN_ACTIVATION_CUSTOM_TYPE,
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROJECTION_CUSTOM_TYPE,
	BRAIN_PROJECTION_NOTIFICATION_CUSTOM_TYPE,
	BRAIN_RECALL_CUSTOM_TYPE,
	isSanBrainActivation,
	isSanBrainDecision,
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	isSanBrainProjection,
	isSanBrainProjectionNotification,
	isSanBrainRecallAudit,
	type SanBrainActivation,
	type SanBrainDecision,
	type SanBrainExperienceCandidate,
	type SanBrainProfileCandidate,
	type SanBrainProjection,
	type SanBrainProjectionNotification,
	type SanBrainRecallAudit,
} from "./types";

export interface SanBrainLedgerEntry<T> {
	entryId: string;
	parentId: string | null;
	timestamp: string;
	data: T;
}

export interface SanBrainLedgerSnapshot {
	profileCandidates: Array<SanBrainLedgerEntry<SanBrainProfileCandidate>>;
	experienceCandidates: Array<SanBrainLedgerEntry<SanBrainExperienceCandidate>>;
	decisions: Array<SanBrainLedgerEntry<SanBrainDecision>>;
	projections: Array<SanBrainLedgerEntry<SanBrainProjection>>;
	projectionNotifications: Array<SanBrainLedgerEntry<SanBrainProjectionNotification>>;
	recalls: Array<SanBrainLedgerEntry<SanBrainRecallAudit>>;
	activations: Array<SanBrainLedgerEntry<SanBrainActivation>>;
}

export function appendSanBrainProfileCandidate(
	sessionManager: ReadonlySessionManager,
	candidate: SanBrainProfileCandidate,
): string {
	return sessionManager.appendCustomEntry(BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate);
}

export function appendSanBrainExperienceCandidate(
	sessionManager: ReadonlySessionManager,
	candidate: SanBrainExperienceCandidate,
): string {
	return sessionManager.appendCustomEntry(BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE, candidate);
}

export function appendSanBrainDecision(sessionManager: ReadonlySessionManager, decision: SanBrainDecision): string {
	return sessionManager.appendCustomEntry(BRAIN_DECISION_CUSTOM_TYPE, decision);
}

export function appendSanBrainProjection(
	sessionManager: ReadonlySessionManager,
	projection: SanBrainProjection,
): string {
	return sessionManager.appendCustomEntry(BRAIN_PROJECTION_CUSTOM_TYPE, projection);
}

export function appendSanBrainProjectionNotification(
	sessionManager: ReadonlySessionManager,
	notification: SanBrainProjectionNotification,
): string {
	return sessionManager.appendCustomEntry(BRAIN_PROJECTION_NOTIFICATION_CUSTOM_TYPE, notification);
}

export function appendSanBrainRecallAudit(sessionManager: ReadonlySessionManager, audit: SanBrainRecallAudit): string {
	return sessionManager.appendCustomEntry(BRAIN_RECALL_CUSTOM_TYPE, audit);
}

export function appendSanBrainActivation(
	sessionManager: ReadonlySessionManager,
	activation: SanBrainActivation,
): string {
	return sessionManager.appendCustomEntry(BRAIN_ACTIVATION_CUSTOM_TYPE, activation);
}

function ledgerEntry<T>(entry: CustomEntry, data: T): SanBrainLedgerEntry<T> {
	return {
		entryId: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		data,
	};
}

export function listSanBrainLedgerEntries(entries: readonly SessionEntry[]): SanBrainLedgerSnapshot {
	const snapshot: SanBrainLedgerSnapshot = {
		profileCandidates: [],
		experienceCandidates: [],
		decisions: [],
		projections: [],
		projectionNotifications: [],
		recalls: [],
		activations: [],
	};

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		switch (entry.customType) {
			case BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE:
				if (isSanBrainProfileCandidate(entry.data)) {
					snapshot.profileCandidates.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE:
				if (isSanBrainExperienceCandidate(entry.data)) {
					snapshot.experienceCandidates.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_DECISION_CUSTOM_TYPE:
				if (isSanBrainDecision(entry.data)) {
					snapshot.decisions.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_PROJECTION_CUSTOM_TYPE:
				if (isSanBrainProjection(entry.data)) {
					snapshot.projections.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_PROJECTION_NOTIFICATION_CUSTOM_TYPE:
				if (isSanBrainProjectionNotification(entry.data)) {
					snapshot.projectionNotifications.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_RECALL_CUSTOM_TYPE:
				if (isSanBrainRecallAudit(entry.data)) {
					snapshot.recalls.push(ledgerEntry(entry, entry.data));
				}
				break;
			case BRAIN_ACTIVATION_CUSTOM_TYPE:
				if (isSanBrainActivation(entry.data)) {
					snapshot.activations.push(ledgerEntry(entry, entry.data));
				}
				break;
		}
	}

	return snapshot;
}
