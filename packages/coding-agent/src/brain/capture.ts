import type { ReadonlySessionManager } from "../session/session-manager";
import { extractSanBrainCandidates, type SanBrainExtractOptions } from "./extract";
import { appendSanBrainExperienceCandidate, appendSanBrainProfileCandidate, listSanBrainLedgerEntries } from "./ledger";
import { BRAIN_ERROR_CUSTOM_TYPE } from "./types";

export interface SanBrainCaptureResult {
	profileCandidates: number;
	experienceCandidates: number;
	entryIds: string[];
	candidateIds: string[];
}

export function captureSanBrainTurn(
	sessionManager: ReadonlySessionManager,
	options: Omit<SanBrainExtractOptions, "entries">,
): SanBrainCaptureResult {
	const entries = sessionManager.getEntries();
	const extracted = extractSanBrainCandidates({ ...options, entries });
	const existing = listSanBrainLedgerEntries(entries);
	const existingIds = new Set([
		...existing.profileCandidates.map(entry => entry.data.candidateId),
		...existing.experienceCandidates.map(entry => entry.data.candidateId),
	]);
	const entryIds: string[] = [];
	const candidateIds: string[] = [];
	let profileCandidates = 0;
	let experienceCandidates = 0;

	for (const candidate of extracted.profileCandidates) {
		if (existingIds.has(candidate.candidateId)) continue;
		existingIds.add(candidate.candidateId);
		candidateIds.push(candidate.candidateId);
		entryIds.push(appendSanBrainProfileCandidate(sessionManager, candidate));
		profileCandidates++;
	}
	for (const candidate of extracted.experienceCandidates) {
		if (existingIds.has(candidate.candidateId)) continue;
		existingIds.add(candidate.candidateId);
		entryIds.push(appendSanBrainExperienceCandidate(sessionManager, candidate));
		candidateIds.push(candidate.candidateId);
		experienceCandidates++;
	}

	return { profileCandidates, experienceCandidates, entryIds, candidateIds };
}

export function recordSanBrainCaptureError(
	sessionManager: ReadonlySessionManager,
	options: { sessionId: string; turnId?: string; message: string },
): string {
	return sessionManager.appendCustomEntry(BRAIN_ERROR_CUSTOM_TYPE, {
		schemaVersion: 1,
		errorId: `brain_error_${Bun.randomUUIDv7()}`,
		phase: "capture",
		sessionId: options.sessionId,
		...(options.turnId ? { turnId: options.turnId } : {}),
		message: options.message,
		createdAt: new Date().toISOString(),
	});
}
