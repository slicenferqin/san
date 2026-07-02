import { isSanLoopTerminalStatus, rebuildSanLoopLedger } from "../../san-loop/ledger";
import type { SanLoopEntryRef, SanLoopEvent, SanLoopReviewReport, SanLoopRunSnapshot } from "../../san-loop/types";
import type { SessionEntry } from "../../session/session-entries";

const DEFAULT_LOOP_REPORT_COUNT = 1;
const MAX_LOOP_REPORT_COUNT = 20;

export interface SanLoopReportOptions {
	count?: number;
	runId?: string;
}

export type SanLoopParsedArgs =
	| { action: "status"; count: number }
	| { action: "run"; objective: string; mode?: SanLoopRunSnapshot["mode"] }
	| { action: "stop"; runId?: string }
	| { error: string };

export function parseSanLoopReportCount(input: string): number | { error: string } {
	const trimmed = input.trim();
	if (!trimmed) return DEFAULT_LOOP_REPORT_COUNT;
	const count = Number(trimmed);
	if (!Number.isInteger(count) || count < 1 || count > MAX_LOOP_REPORT_COUNT) {
		return { error: sanLoopUsageText() };
	}
	return count;
}

export function sanLoopUsageText(): string {
	return `Usage: /san-loop [status [1-${MAX_LOOP_REPORT_COUNT}]] | run [--mode rush|smart|deep] <objective> | stop [runId]`;
}

export function parseSanLoopArgs(input: string): SanLoopParsedArgs {
	const trimmed = input.trim();
	if (!trimmed) return { action: "status", count: DEFAULT_LOOP_REPORT_COUNT };
	const [first = "", ...restTokens] = trimmed.split(/\s+/);
	if (first === "status") {
		const count = parseSanLoopReportCount(restTokens.join(" "));
		return typeof count === "number" ? { action: "status", count } : count;
	}
	if (first === "stop") {
		if (restTokens.length > 1 || restTokens.some(token => token.startsWith("-")))
			return { error: sanLoopUsageText() };
		return { action: "stop", runId: restTokens[0] };
	}
	if (first !== "run") {
		const count = parseSanLoopReportCount(trimmed);
		return typeof count === "number" ? { action: "status", count } : { error: sanLoopUsageText() };
	}
	let mode: SanLoopRunSnapshot["mode"] | undefined;
	const objectiveTokens: string[] = [];
	for (let index = 0; index < restTokens.length; index++) {
		const token = restTokens[index];
		if (token === "--mode") {
			const value = restTokens[index + 1];
			if (value !== "rush" && value !== "smart" && value !== "deep") return { error: sanLoopUsageText() };
			mode = value;
			index += 1;
			continue;
		}
		if (token?.startsWith("--mode=")) {
			const value = token.slice("--mode=".length);
			if (value !== "rush" && value !== "smart" && value !== "deep") return { error: sanLoopUsageText() };
			mode = value;
			continue;
		}
		if (token?.startsWith("-")) return { error: sanLoopUsageText() };
		if (token) objectiveTokens.push(token);
	}
	const objective = objectiveTokens.join(" ").trim();
	if (!objective) return { error: sanLoopUsageText() };
	return { action: "run", objective, mode };
}

function clampReportCount(count: number | undefined): number {
	if (count === undefined || !Number.isFinite(count)) return DEFAULT_LOOP_REPORT_COUNT;
	return Math.min(MAX_LOOP_REPORT_COUNT, Math.max(1, Math.floor(count)));
}

function formatNumber(value: number): string {
	return value.toLocaleString();
}

function formatList(label: string, values: readonly string[]): string[] {
	if (values.length === 0) return [`${label}: none`];
	return [`${label}:`, ...values.map(value => `- ${value}`)];
}

function latestEventsForRun(events: readonly SanLoopEntryRef<SanLoopEvent>[], runId: string): SanLoopEvent[] {
	return events
		.filter(event => event.data.runId === runId)
		.slice(-5)
		.map(event => event.data);
}

function latestReviewsForRun(
	reviews: readonly SanLoopEntryRef<SanLoopReviewReport>[],
	runId: string,
): SanLoopReviewReport[] {
	return reviews
		.filter(report => report.data.runId === runId)
		.slice(-3)
		.map(report => report.data);
}

function formatReview(report: SanLoopReviewReport): string[] {
	const lines = [
		`- ${report.verdict} by ${report.reviewer}; confidence=${report.confidence}; retryable=${report.retryable}`,
		`  report=${report.reportId}${report.assignmentId ? ` assignment=${report.assignmentId}` : ""}`,
	];
	if (report.defects.length > 0) {
		lines.push(`  defects=${formatNumber(report.defects.length)}`);
	}
	if (report.requiredNextActions.length > 0) {
		lines.push(`  next=${report.requiredNextActions.join("; ")}`);
	}
	return lines;
}

function formatRun(
	runRef: SanLoopEntryRef<SanLoopRunSnapshot>,
	events: readonly SanLoopEntryRef<SanLoopEvent>[],
	reviews: readonly SanLoopEntryRef<SanLoopReviewReport>[],
): string {
	const run = runRef.data;
	const lines = [
		`## San Loop ${run.runId}`,
		`Debug entry: ${runRef.entryId}`,
		`Status: ${run.status}`,
		`Active: ${isSanLoopTerminalStatus(run.status) ? "no" : "yes"}`,
		`Mode: ${run.mode}`,
		`Objective: ${run.objective}`,
		`Created: ${run.createdAt}`,
		`Updated: ${run.updatedAt}`,
		`Retries: ${run.retryCount}/${run.maxRetries}`,
		`Final verdict: ${run.finalVerdict ?? "none"}`,
		`Context packet refs: ${run.contextPacketRefs.length > 0 ? run.contextPacketRefs.join(", ") : "none"}`,
		`Plan tasks: ${formatNumber(run.plan?.taskGraph.length ?? 0)}`,
		`Assignments: ${formatNumber(run.assignments.length)}`,
		`Worker results: ${formatNumber(run.workerResults.length)}`,
		`Review reports: ${formatNumber(run.reviewReports.length)}`,
		`Decisions: ${formatNumber(run.decisions.length)}`,
		`Budget snapshots: ${formatNumber(run.budget.length)}`,
	];
	if (run.plan) {
		lines.push(...formatList("Acceptance criteria", run.plan.acceptanceCriteria));
		lines.push(...formatList("Risks", run.plan.riskRegister));
	}
	const runReviews = latestReviewsForRun(reviews, run.runId);
	lines.push("Latest reviews:");
	if (runReviews.length === 0) lines.push("- none");
	else {
		for (const report of runReviews) lines.push(...formatReview(report));
	}
	const runEvents = latestEventsForRun(events, run.runId);
	lines.push("Latest events:");
	if (runEvents.length === 0) lines.push("- none");
	else {
		for (const event of runEvents) lines.push(`- ${event.type}: ${event.summary}`);
	}
	return lines.join("\n");
}

export function buildSanLoopReportText(entries: readonly SessionEntry[], options: SanLoopReportOptions = {}): string {
	const ledger = rebuildSanLoopLedger(entries);
	if (ledger.runs.length === 0) {
		return "No San execution loop runs found.";
	}

	const count = clampReportCount(options.count);
	const selected = options.runId
		? ledger.runs.filter(run => run.data.runId === options.runId)
		: ledger.runs.slice(-count).reverse();
	if (selected.length === 0) {
		return `No San execution loop run found for ${options.runId}.`;
	}

	const heading = `San execution loop ledger (${selected.length}/${ledger.runs.length} shown)`;
	return [
		heading,
		...selected.map(run => formatRun(run, ledger.events, ledger.reviews)),
		`Review entries: ${formatNumber(ledger.reviews.length)}`,
		`Role context packets: ${formatNumber(ledger.rolePackets.length)}`,
	].join("\n\n");
}
