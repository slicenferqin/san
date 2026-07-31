import type { SanBrainActiveStateRecord, SanBrainCandidateRecord } from "./store";
import {
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	type SanBrainCandidate,
	type SanBrainCandidateKind,
	type SanBrainEvidenceRef,
} from "./types";

export interface SanBrainConsolidationGroup {
	key: string;
	kind: SanBrainCandidateKind;
	candidateIds: string[];
	activeCandidateIds: string[];
	dedupeKeys: string[];
}

export interface SanBrainConsolidationReport {
	duplicateGroups: SanBrainConsolidationGroup[];
	conflictGroups: SanBrainConsolidationGroup[];
}

function scopeKey(record: SanBrainCandidateRecord): string {
	return `${record.candidate.scope.kind}:${record.candidate.scope.key}`;
}

function groupRecords(
	records: readonly SanBrainCandidateRecord[],
	activeIds: ReadonlySet<string>,
	keyFor: (record: SanBrainCandidateRecord) => string | undefined,
): SanBrainConsolidationGroup[] {
	const groups = new Map<string, SanBrainCandidateRecord[]>();
	for (const record of records) {
		if (record.status === "superseded" || record.status === "undone") continue;
		const key = keyFor(record);
		if (!key) continue;
		const group = groups.get(key);
		if (group) group.push(record);
		else groups.set(key, [record]);
	}
	return [...groups.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([key, group]) => ({
			key,
			kind: group[0]!.kind,
			candidateIds: group.map(record => record.candidate.candidateId).sort(),
			activeCandidateIds: group
				.map(record => record.candidate.candidateId)
				.filter(candidateId => activeIds.has(candidateId))
				.sort(),
			dedupeKeys: [...new Set(group.map(record => record.candidate.dedupeKey))].sort(),
		}))
		.sort((left, right) => left.key.localeCompare(right.key));
}

export function buildSanBrainConsolidationReport(
	records: readonly SanBrainCandidateRecord[],
	activeStates: readonly SanBrainActiveStateRecord[],
): SanBrainConsolidationReport {
	const activeIds = new Set(activeStates.map(state => state.candidate.candidateId));
	const duplicateGroups = groupRecords(
		records,
		activeIds,
		record => `${record.kind}:${scopeKey(record)}:${record.candidate.dedupeKey}`,
	);
	const conflictGroups = groupRecords(records, activeIds, record => {
		const candidate = record.candidate;
		const conflictKey =
			record.kind === "profile"
				? candidate.claimKey
				: isSanBrainExperienceCandidate(candidate)
					? candidate.conflictKey
					: undefined;
		return conflictKey ? `${record.kind}:${scopeKey(record)}:${conflictKey}` : undefined;
	}).filter(group => group.dedupeKeys.length > 1);
	return { duplicateGroups, conflictGroups };
}

export function isEquivalentSanBrainCandidate(left: SanBrainCandidateRecord, right: SanBrainCandidateRecord): boolean {
	return (
		left.kind === right.kind &&
		left.candidate.scope.kind === right.candidate.scope.kind &&
		left.candidate.scope.key === right.candidate.scope.key &&
		left.candidate.dedupeKey === right.candidate.dedupeKey
	);
}

export function isConflictingSanBrainCandidate(left: SanBrainCandidateRecord, right: SanBrainCandidateRecord): boolean {
	if (
		left.kind !== right.kind ||
		left.candidate.scope.kind !== right.candidate.scope.kind ||
		left.candidate.scope.key !== right.candidate.scope.key ||
		left.candidate.dedupeKey === right.candidate.dedupeKey
	) {
		return false;
	}
	if (left.kind === "profile") return left.candidate.claimKey === right.candidate.claimKey;
	if (!isSanBrainExperienceCandidate(left.candidate) || !isSanBrainExperienceCandidate(right.candidate)) return false;
	return Boolean(left.candidate.conflictKey && left.candidate.conflictKey === right.candidate.conflictKey);
}

function uniqueEvidence(candidates: readonly SanBrainCandidate[]): SanBrainEvidenceRef[] {
	const evidence = new Map<string, SanBrainEvidenceRef>();
	for (const candidate of candidates) {
		for (const ref of candidate.evidence) evidence.set(JSON.stringify(ref), ref);
	}
	return [...evidence.values()];
}

function impactRank(impact: "low" | "medium" | "high"): number {
	return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}

export function mergeSanBrainCandidateRecords(
	canonical: SanBrainCandidateRecord,
	records: readonly SanBrainCandidateRecord[],
): SanBrainCandidate {
	const equivalent = records.filter(record => isEquivalentSanBrainCandidate(canonical, record));
	if (equivalent.length === 0) return canonical.candidate;
	const candidates = equivalent.map(record => record.candidate);
	const taskTags = [...new Set(candidates.flatMap(candidate => candidate.taskTags))].sort();
	const evidence = uniqueEvidence(candidates);
	const createdAt = candidates.map(candidate => candidate.createdAt).sort()[0] ?? canonical.candidate.createdAt;
	const authorization = candidates.some(candidate => candidate.authorization === "explicit_user")
		? "explicit_user"
		: "inferred";
	if (canonical.kind === "profile" && isSanBrainProfileCandidate(canonical.candidate)) {
		const profiles = candidates.filter(isSanBrainProfileCandidate);
		return {
			...canonical.candidate,
			authorization,
			taskTags,
			evidence,
			confidence: Math.max(...profiles.map(candidate => candidate.confidence)),
			importance: Math.max(...profiles.map(candidate => candidate.importance)),
			independentEvidenceCount: profiles.reduce((total, candidate) => total + candidate.independentEvidenceCount, 0),
			createdAt,
		};
	}
	if (canonical.kind === "experience" && isSanBrainExperienceCandidate(canonical.candidate)) {
		const experiences = candidates.filter(isSanBrainExperienceCandidate);
		return {
			...canonical.candidate,
			authorization,
			taskTags,
			evidence,
			confidence: Math.max(...experiences.map(candidate => candidate.confidence)),
			repeatCount: experiences.reduce((total, candidate) => total + candidate.repeatCount, 0),
			impact: [...experiences].sort((left, right) => impactRank(right.impact) - impactRank(left.impact))[0]!.impact,
			createdAt,
		};
	}
	return canonical.candidate;
}
