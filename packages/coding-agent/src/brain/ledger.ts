import type { CustomEntry, SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import {
	BRAIN_ACTIVATION_CUSTOM_TYPE,
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	isSanBrainActivation,
	isSanBrainDecision,
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	type SanBrainActivation,
	type SanBrainDecision,
	type SanBrainExperienceCandidate,
	type SanBrainProfileCandidate,
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
			case BRAIN_ACTIVATION_CUSTOM_TYPE:
				if (isSanBrainActivation(entry.data)) {
					snapshot.activations.push(ledgerEntry(entry, entry.data));
				}
				break;
		}
	}

	return snapshot;
}
