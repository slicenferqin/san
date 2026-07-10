import type { TurnDigest } from "../context-steady/types";
import { rebuildSanLoopLedger } from "../san-loop/ledger";
import type { SessionEntry } from "../session/session-entries";
import type { SanBrainEvidenceRef, SanBrainEvidenceSourceMode, SanBrainLoopEvidenceRef } from "./types";

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}

function entriesInSpan(entries: readonly SessionEntry[], fromEntryId: string, toEntryId: string): SessionEntry[] {
	const fromIndex = entries.findIndex(entry => entry.id === fromEntryId);
	const toIndex = entries.findIndex(entry => entry.id === toEntryId);
	if (fromIndex < 0 || toIndex < fromIndex) return [];
	return entries.slice(fromIndex, toIndex + 1);
}

function acceptedLoopEvidence(entries: readonly SessionEntry[]): {
	entryIds: string[];
	loopRefs: SanBrainLoopEvidenceRef[];
} {
	const ledger = rebuildSanLoopLedger(entries);
	const entryIds: string[] = [];
	const loopRefs: SanBrainLoopEvidenceRef[] = [];

	for (const runRef of ledger.runs) {
		const run = runRef.data;
		if (run.status !== "passed" || run.finalVerdict !== "pass") continue;
		const acceptedReview = [...run.reviewReports]
			.reverse()
			.find(report => report.verdict === "pass" && report.assignmentId);
		if (!acceptedReview?.assignmentId) continue;
		const acceptedResult = [...run.workerResults]
			.reverse()
			.find(result => result.assignmentId === acceptedReview.assignmentId && result.status === "completed");
		if (!acceptedResult) continue;

		const reviewEntry = ledger.reviews.find(review => review.data.reportId === acceptedReview.reportId);
		entryIds.push(runRef.entryId);
		if (reviewEntry) entryIds.push(reviewEntry.entryId);
		loopRefs.push({
			runId: run.runId,
			assignmentId: acceptedResult.assignmentId,
			attemptId: acceptedResult.resultId,
			reviewId: acceptedReview.reportId,
			accepted: true,
		});
	}

	return { entryIds: unique(entryIds), loopRefs };
}

export function buildSanBrainEvidenceRef(options: {
	digest: TurnDigest;
	digestEntryId?: string;
	entries: readonly SessionEntry[];
	sourceMode: SanBrainEvidenceSourceMode;
}): SanBrainEvidenceRef {
	const { digest } = options;
	const spanEntries = entriesInSpan(options.entries, digest.source.fromEntryId, digest.source.toEntryId);
	const accepted = acceptedLoopEvidence(spanEntries);
	const toolEntryIds = digest.toolEvidence.flatMap(item => item.entryIds ?? []);
	const sourceEntryIds = [
		digest.source.fromEntryId,
		digest.source.toEntryId,
		...(digest.source.userEntryId ? [digest.source.userEntryId] : []),
		...toolEntryIds,
		...accepted.entryIds,
	];

	return {
		sessionId: digest.sessionId,
		sourceMode: options.sourceMode,
		entryIds: unique(sourceEntryIds),
		digestEntryIds: options.digestEntryId ? [options.digestEntryId] : [],
		loopRefs: accepted.loopRefs,
		fileRefs: digest.filesTouched.map(file => ({ path: file.path })),
		toolCallIds: [],
		summary: `${options.sourceMode}: ${digest.userIntent}`.slice(0, 500),
	};
}
