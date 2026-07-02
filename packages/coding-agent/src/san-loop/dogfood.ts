import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { buildSanLoopReportText } from "../slash-commands/helpers/san-loop-report";
import {
	abortSanLoopRun,
	appendSanLoopRunSnapshot,
	createSanLoopRunSnapshot,
	rebuildSanLoopLedger,
	recoverSanLoopRun,
} from "./ledger";
import { defaultSanLoopModePolicy } from "./orchestrator";
import { runSanLoop, type SanLoopAgentExecutor } from "./runner";
import type { SanLoopMode, SanLoopReviewVerdict, SanLoopStatus, SanLoopTaskNode } from "./types";

export interface SanLoopDogfoodOptions {
	cwd?: string;
}

export interface SanLoopDogfoodAssertion {
	name: string;
	ok: boolean;
	detail: string;
}

export interface SanLoopDogfoodScenario {
	name: string;
	runId: string;
	mode: SanLoopMode;
	status: SanLoopStatus;
	retryCount: number;
	reviews: number;
	events: string[];
}

export interface SanLoopDogfoodSummary {
	ok: boolean;
	sessionId: string;
	scenarios: SanLoopDogfoodScenario[];
	runs: number;
	passedRuns: number;
	blockedRuns: number;
	abortedRuns: number;
	recoveredRuns: number;
	reviewReports: number;
	events: number;
	reportText: string;
	assertions: SanLoopDogfoodAssertion[];
}

const DEFAULT_SESSION_ID = "san-loop-dogfood-session";

function assertResult(name: string, ok: boolean, detail: string): SanLoopDogfoodAssertion {
	return { name, ok, detail };
}

function taskNode(id: string, title: string): SanLoopTaskNode {
	return {
		id,
		title,
		status: "pending",
		description: `Dogfood task ${id}: ${title}`,
		dependsOn: [],
		acceptanceCriteria: ["ledger records plan, worker result, review, and final verdict"],
		checkRefs: ["supervisor-gate", "project-typescript-contracts"],
		assignedRole: "worker",
	};
}

function makeExecutor(options: {
	taskId: string;
	taskTitle: string;
	reviews: readonly SanLoopReviewVerdict[];
	oracle?: boolean;
}): SanLoopAgentExecutor {
	let commanderCalls = 0;
	let workerCalls = 0;
	let supervisorCalls = 0;
	return {
		async commander(invocation) {
			commanderCalls += 1;
			const retrySuffix = invocation.latestReview ? ` retry ${commanderCalls}` : "";
			return {
				plan: {
					objective: invocation.run.objective,
					constraints: ["stay within assignment scope", "persist every state transition"],
					acceptanceCriteria: ["supervisor verdict reaches terminal status"],
					taskGraph: [taskNode(`${options.taskId}-${commanderCalls}`, `${options.taskTitle}${retrySuffix}`)],
					checkPlan: ["supervisor-gate", "project-typescript-contracts"],
					riskRegister: invocation.latestReview ? ["prior review requested a correction"] : [],
				},
			};
		},
		async worker(invocation) {
			workerCalls += 1;
			return {
				resultId: `${options.taskId}-result-${workerCalls}`,
				assignmentId: invocation.assignment.assignmentId,
				status: "completed",
				summary: `Completed ${invocation.assignment.objective} on attempt ${workerCalls}.`,
				changedFiles: [`packages/coding-agent/src/san-loop/${options.taskId}.ts`],
				commandsRun: [{ command: "bun test packages/coding-agent/test/san-loop", exitCode: 0, summary: "passed" }],
				verification: ["focused san-loop tests pass"],
				risks: workerCalls > 1 ? ["retry path exercised"] : [],
			};
		},
		async supervisor() {
			const verdict = options.reviews[Math.min(supervisorCalls, options.reviews.length - 1)] ?? "pass";
			supervisorCalls += 1;
			if (verdict === "needs_fix") {
				return {
					reportId: `${options.taskId}-review-fix-${supervisorCalls}`,
					reviewer: "supervisor",
					verdict,
					defects: [
						{
							defectId: `${options.taskId}-defect-${supervisorCalls}`,
							severity: "high",
							title: "Missing mature-loop evidence",
							evidence: ["first pass did not include retry evidence"],
							retryable: true,
							suggestedFix: "re-run Commander with prior review context and produce a corrected worker pass",
						},
					],
					testsRun: ["bun test packages/coding-agent/test/san-loop"],
					evidence: ["supervisor reviewed deterministic worker result"],
					retryable: true,
					requiredNextActions: ["retry implementation with review context"],
					confidence: "high",
				};
			}
			if (verdict === "blocked") {
				return {
					reportId: `${options.taskId}-review-blocked`,
					reviewer: "supervisor",
					verdict,
					testsRun: ["bun test packages/coding-agent/test/san-loop"],
					evidence: ["external dependency required before completion"],
					retryable: false,
					requiredNextActions: ["request operator input"],
					confidence: "medium",
				};
			}
			return {
				reportId: `${options.taskId}-review-pass-${supervisorCalls}`,
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: ["bun test packages/coding-agent/test/san-loop"],
				evidence: ["all deterministic checks pass"],
				retryable: false,
				requiredNextActions: [],
				confidence: "high",
			};
		},
		async oracle() {
			if (!options.oracle) {
				return {
					reviewer: "oracle",
					verdict: "blocked",
					defects: [
						{
							defectId: `${options.taskId}-oracle-disabled`,
							severity: "medium",
							title: "Oracle disabled for this deterministic scenario",
							evidence: ["scenario did not request oracle"],
							retryable: false,
						},
					],
					evidence: [],
					testsRun: [],
					retryable: false,
					requiredNextActions: ["do not call oracle for this mode"],
					confidence: "low",
				};
			}
			return {
				reviewer: "oracle",
				verdict: "pass",
				testsRun: [],
				evidence: ["oracle second opinion reviewed deterministic deep-mode evidence"],
				retryable: false,
				requiredNextActions: ["continue supervisor gate"],
				confidence: "high",
			};
		},
	};
}

function scenarioEvents(entries: readonly SessionEntry[], runId: string): string[] {
	return rebuildSanLoopLedger(entries)
		.events.filter(event => event.data.runId === runId)
		.map(event => event.data.type);
}

function reportScenario(
	entries: readonly SessionEntry[],
	name: string,
	runId: string,
	mode: SanLoopMode,
): SanLoopDogfoodScenario {
	const ledger = rebuildSanLoopLedger(entries);
	const run = ledger.runs.find(item => item.data.runId === runId)?.data;
	if (!run) throw new Error(`San loop dogfood missing run ${runId}`);
	return {
		name,
		runId,
		mode,
		status: run.status,
		retryCount: run.retryCount,
		reviews: run.reviewReports.length,
		events: scenarioEvents(entries, runId),
	};
}

export async function runSanLoopDogfood(options: SanLoopDogfoodOptions = {}): Promise<SanLoopDogfoodSummary> {
	const session = SessionManager.inMemory(options.cwd);
	const sessionId = session.getSessionId() || DEFAULT_SESSION_ID;

	await runSanLoop({
		sessionManager: session,
		objective: "Dogfood rush mode pass loop",
		mode: "rush",
		runId: "loop_dogfood_rush_pass",
		executor: makeExecutor({ taskId: "rush-pass", taskTitle: "rush pass implementation", reviews: ["pass"] }),
	});

	await runSanLoop({
		sessionManager: session,
		objective: "Dogfood smart mode retry loop",
		mode: "smart",
		runId: "loop_dogfood_smart_retry",
		executor: makeExecutor({
			taskId: "smart-retry",
			taskTitle: "smart retry implementation",
			reviews: ["needs_fix", "pass"],
		}),
	});

	await runSanLoop({
		sessionManager: session,
		objective: "Dogfood deep mode blocked loop",
		mode: "deep",
		runId: "loop_dogfood_deep_blocked",
		executor: makeExecutor({
			taskId: "deep-blocked",
			taskTitle: "deep blocked implementation",
			reviews: ["blocked"],
			oracle: true,
		}),
	});

	await runSanLoop({
		sessionManager: session,
		objective: "Dogfood hard turn budget",
		mode: "rush",
		runId: "loop_dogfood_budget_exhausted",
		executor: makeExecutor({
			taskId: "budget-exhausted",
			taskTitle: "budget exhausted implementation",
			reviews: ["pass"],
		}),
		maxTurns: 2,
	});

	const activeRun = createSanLoopRunSnapshot({
		sessionId,
		objective: "Dogfood active run recovery",
		mode: "smart",
		runId: "loop_dogfood_recovered",
	});
	appendSanLoopRunSnapshot(session, activeRun);
	recoverSanLoopRun(session, activeRun, { reason: "Dogfood recovered active run without a child process." });

	const abortRun = createSanLoopRunSnapshot({
		sessionId,
		objective: "Dogfood operator abort",
		mode: "rush",
		runId: "loop_dogfood_aborted",
	});
	appendSanLoopRunSnapshot(session, abortRun);
	abortSanLoopRun(session, abortRun, { reason: "Dogfood operator stopped the loop." });

	const entries = session.getEntries();
	const scenarios = [
		reportScenario(entries, "rush pass", "loop_dogfood_rush_pass", "rush"),
		reportScenario(entries, "smart retry", "loop_dogfood_smart_retry", "smart"),
		reportScenario(entries, "deep blocked", "loop_dogfood_deep_blocked", "deep"),
		reportScenario(entries, "budget exhausted", "loop_dogfood_budget_exhausted", "rush"),
		reportScenario(entries, "recovery", "loop_dogfood_recovered", "smart"),
		reportScenario(entries, "abort", "loop_dogfood_aborted", "rush"),
	];
	const ledger = rebuildSanLoopLedger(entries);
	const recoveredRuns = ledger.events.filter(event => event.data.type === "recovered").length;
	const assertions = [
		assertResult(
			"rush pass reaches final verdict",
			scenarios[0]?.status === "passed" && scenarios[0].events.includes("finalized"),
			`${scenarios[0]?.status ?? "missing"} with events=${scenarios[0]?.events.join(",") ?? "none"}`,
		),
		assertResult(
			"smart retry repairs needs_fix",
			scenarios[1]?.status === "passed" &&
				scenarios[1].retryCount === 1 &&
				scenarios[1].events.includes("retry_requested"),
			`${scenarios[1]?.status ?? "missing"} retry=${scenarios[1]?.retryCount ?? -1}`,
		),
		assertResult(
			"deep mode runs oracle before supervisor",
			defaultSanLoopModePolicy("deep").requireOracle &&
				scenarios[2]?.events.includes("finalized") &&
				scenarios[2]?.reviews === 2,
			`requireOracle=${defaultSanLoopModePolicy("deep").requireOracle}, reviews=${scenarios[2]?.reviews ?? -1}`,
		),
		assertResult(
			"deep blocked is terminal",
			scenarios[2]?.status === "blocked" && scenarios[2].events.includes("review_completed"),
			`${scenarios[2]?.status ?? "missing"} with events=${scenarios[2]?.events.join(",") ?? "none"}`,
		),
		assertResult(
			"hard turn budget blocks before supervisor",
			scenarios[3]?.status === "blocked" && scenarios[3].events.includes("blocked") && scenarios[3].reviews === 0,
			`${scenarios[3]?.status ?? "missing"} reviews=${scenarios[3]?.reviews ?? -1}`,
		),
		assertResult(
			"active run recovery records event",
			scenarios[4]?.status === "blocked" && scenarios[4].events.includes("recovered"),
			`${scenarios[4]?.status ?? "missing"} recoveredEvents=${recoveredRuns}`,
		),
		assertResult(
			"operator abort records event",
			scenarios[5]?.status === "aborted" && scenarios[5].events.includes("aborted"),
			`${scenarios[5]?.status ?? "missing"} with events=${scenarios[5]?.events.join(",") ?? "none"}`,
		),
		assertResult(
			"review reports persisted",
			ledger.reviews.length === 5,
			`${ledger.reviews.length} persisted review reports`,
		),
		assertResult(
			"report renders active state",
			buildSanLoopReportText(entries, { count: 5 }).includes("Active: no"),
			"latest five runs render as inactive terminal states",
		),
	];
	const passedRuns = ledger.runs.filter(run => run.data.status === "passed").length;
	const blockedRuns = ledger.runs.filter(run => run.data.status === "blocked").length;
	const abortedRuns = ledger.runs.filter(run => run.data.status === "aborted").length;
	return {
		ok: assertions.every(assertion => assertion.ok),
		sessionId,
		scenarios,
		runs: ledger.runs.length,
		passedRuns,
		blockedRuns,
		abortedRuns,
		recoveredRuns,
		reviewReports: ledger.reviews.length,
		events: ledger.events.length,
		reportText: buildSanLoopReportText(entries, { count: 5 }),
		assertions,
	};
}
