import type { SanBrainStore } from "./store";
import { summarizeSanBrainCandidate } from "./types";

function formatScope(scope: { kind: string; key: string }): string {
	return `${scope.kind}:${scope.key}`;
}

export function buildSanBrainInboxReportText(store: SanBrainStore, limit = 20): string {
	const candidates = store.listPendingCandidates(limit);
	if (candidates.length === 0) return "San Brain inbox is empty.";
	const lines = [`San Brain inbox (${candidates.length})`];
	for (const record of candidates) {
		lines.push(
			`- ${record.candidate.candidateId} [${record.kind}] scope=${formatScope(record.candidate.scope)} confidence=${record.candidate.confidence.toFixed(2)}`,
			`  ${summarizeSanBrainCandidate(record.kind, record.candidate)}`,
		);
	}
	return lines.join("\n");
}

export function buildSanBrainProfileReportText(store: SanBrainStore, limit = 20): string {
	const states = store.listActiveStates(limit).filter(state => state.kind === "profile");
	if (states.length === 0) return "San Brain profile has no active state.";
	const lines = [`San Brain active profile (${states.length})`];
	for (const state of states) {
		lines.push(
			`- ${state.candidate.candidateId} revision=${state.revision} scope=${formatScope(state.candidate.scope)}`,
			`  ${summarizeSanBrainCandidate(state.kind, state.candidate)}`,
			`  decision=${state.decisionId}`,
		);
	}
	return lines.join("\n");
}

export function buildSanBrainExplanationText(store: SanBrainStore, id: string): string {
	const explanation = store.explain(id);
	if (!explanation) return `No San Brain candidate or decision found for ${id}.`;
	const { candidate } = explanation;
	const lines = [
		`San Brain explanation: ${candidate.candidate.candidateId}`,
		`Kind: ${candidate.kind}`,
		`Status: ${candidate.status}`,
		`Revision: ${candidate.revision}`,
		`Scope: ${formatScope(candidate.candidate.scope)}`,
		`Summary: ${summarizeSanBrainCandidate(candidate.kind, candidate.candidate)}`,
		`Source: session=${candidate.sourceSessionId} entry=${candidate.sourceEntryId}`,
		`Decisions: ${explanation.decisions.length}`,
	];
	for (const decision of explanation.decisions) {
		lines.push(
			`- ${decision.decision.decisionId}: ${decision.decision.action}; state=${decision.applicationState}; revision=${decision.decision.nextRevision}`,
		);
		if (decision.applicationError) lines.push(`  error=${decision.applicationError}`);
	}
	lines.push(`Active: ${explanation.activeState ? `yes, decision=${explanation.activeState.decisionId}` : "no"}`);
	lines.push(`Projections: ${explanation.projections.length}`);
	return lines.join("\n");
}
