import type { AcceptanceGate, ImmutableObjectiveContract } from "../execution-control";
import { createExecutionRuntime, ProviderHealthRegistry, TaskContractRegistry } from "../execution-control";
import { createCommandEvidenceReceipt } from "../execution-control/evidence-gates";
import type { ExecutionRuntime } from "../execution-control/execution-runtime";
import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { buildSanLoopReportText } from "../slash-commands/helpers/san-loop-report";
import { appendSanLoopRunSnapshot, createSanLoopRunSnapshot, rebuildSanLoopLedger, recoverSanLoopRun } from "./ledger";
import { defaultSanLoopModePolicy } from "./orchestrator";
import { cancelRunningSanLoop, runSanLoop, type SanLoopAgentExecutor } from "./runner";
import type { SanLoopMode, SanLoopReviewVerdict, SanLoopStatus, SanLoopTaskNode } from "./types";

const DOGFOOD_CONTRACT: ImmutableObjectiveContract = {
	ref: {
		contractId: "contract-dogfood",
		revision: 1,
		contractHash: "sha256-contract-dogfood",
		clauseRefs: ["clause:dogfood"],
	},
	authoritativeUserTurnId: "turn-1",
	source: "authoritative_user",
};
const DOGFOOD_COMMAND = "bun test packages/coding-agent/test/san-loop";
const DOGFOOD_CHECK_ID = `command:${DOGFOOD_COMMAND}`;

function dogfoodAcceptanceGate(): AcceptanceGate {
	return {
		gateId: "gate:dogfood-command",
		contractRef: DOGFOOD_CONTRACT.ref,
		contractRevision: DOGFOOD_CONTRACT.ref.revision,
		contractHash: DOGFOOD_CONTRACT.ref.contractHash,
		objectiveClauseRefs: [...DOGFOOD_CONTRACT.ref.clauseRefs],
		verifier: { kind: "command", checkId: DOGFOOD_CHECK_ID, expectedExitCode: 0 },
		status: "unknown",
		evidenceRefs: [],
		required: true,
	};
}

function dogfoodRunContract() {
	return {
		contractRevision: DOGFOOD_CONTRACT.ref.revision,
		contractHash: DOGFOOD_CONTRACT.ref.contractHash,
		objectiveClauseRefs: [...DOGFOOD_CONTRACT.ref.clauseRefs],
		acceptanceGates: [dogfoodAcceptanceGate()],
	};
}

function dogfoodScope(runtime: ExecutionRuntime, session: SessionManager, logicalTurnId: string): string {
	return runtime.startScope({
		rootSessionId: session.getSessionId() || DEFAULT_SESSION_ID,
		logicalTurnId,
		objectiveContract: DOGFOOD_CONTRACT,
	}).scopeId;
}

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
	runtime: ExecutionRuntime;
	scopeId: string;
	oracle?: boolean;
}): SanLoopAgentExecutor {
	let commanderCalls = 0;
	let workerCalls = 0;
	let supervisorCalls = 0;
	const evidenceRefsByAssignment = new Map<string, string>();
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
			const gate = options.runtime
				.getScope(options.scopeId)
				?.snapshot()
				.gates.find(candidate => candidate.assignmentId === invocation.assignment.assignmentId);
			if (!gate || gate.freshnessRevision === undefined || gate.verifier.kind !== "command") {
				throw new Error(`Dogfood command gate is missing for assignment ${invocation.assignment.assignmentId}.`);
			}
			const receiptId = `receipt:${invocation.assignment.assignmentId}:${gate.gateId}`;
			evidenceRefsByAssignment.set(invocation.assignment.assignmentId, receiptId);
			return {
				resultId: `${options.taskId}-result-${workerCalls}`,
				assignmentId: invocation.assignment.assignmentId,
				status: "completed",
				summary: `Completed ${invocation.assignment.objective} on attempt ${workerCalls}.`,
				changedFiles: [`packages/coding-agent/src/san-loop/${options.taskId}.ts`],
				commandsRun: [{ command: DOGFOOD_COMMAND, exitCode: 0, summary: "passed", source: "host" }],
				verification: ["focused san-loop tests pass"],
				evidenceReceipts: [
					createCommandEvidenceReceipt({
						receiptId,
						scopeId: options.scopeId,
						gateId: gate.gateId,
						contractRevision: gate.contractRevision,
						contractHash: gate.contractHash ?? gate.contractRef.contractHash,
						freshnessRevision: gate.freshnessRevision,
						assignmentId: invocation.assignment.assignmentId,
						outcome: "pass",
						timestamp: new Date().toISOString(),
						checkId: gate.verifier.checkId,
						exitCode: 0,
					}),
				],
				risks: workerCalls > 1 ? ["retry path exercised"] : [],
			};
		},
		async supervisor(invocation) {
			const verdict = options.reviews[Math.min(supervisorCalls, options.reviews.length - 1)] ?? "pass";
			supervisorCalls += 1;
			const evidenceRefs = invocation.assignments.flatMap(assignment => {
				const receiptId = evidenceRefsByAssignment.get(assignment.assignmentId);
				return receiptId ? [receiptId] : [];
			});
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
				evidenceRefs,
				retryable: false,
				requiredNextActions: [],
				confidence: "high",
			};
		},
		async oracle(invocation) {
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
			const evidenceRefs = invocation.assignments.flatMap(assignment => {
				const receiptId = evidenceRefsByAssignment.get(assignment.assignmentId);
				return receiptId ? [receiptId] : [];
			});
			return {
				reviewer: "oracle",
				verdict: "pass",
				testsRun: [],
				evidence: ["oracle second opinion reviewed deterministic council-mode evidence"],
				evidenceRefs,
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

	const runtime = createExecutionRuntime({
		rootSessionId: session.getSessionId() || DEFAULT_SESSION_ID,
		branchEntries: session.getEntries(),
		sessionManager: session,
		taskRegistry: new TaskContractRegistry({
			rootSessionId: session.getSessionId() || DEFAULT_SESSION_ID,
		}),
		providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
		now: () => new Date().toISOString(),
	});

	const soloScopeId = dogfoodScope(runtime, session, "turn-solo-pass");
	await runSanLoop({
		sessionManager: session,
		executionRuntime: runtime,
		executionScopeId: soloScopeId,
		objective: "Dogfood solo mode pass loop",
		mode: "solo",
		runId: "loop_dogfood_solo_pass",
		...dogfoodRunContract(),
		executor: makeExecutor({
			taskId: "solo-pass",
			taskTitle: "solo pass implementation",
			reviews: ["pass"],
			runtime,
			scopeId: soloScopeId,
		}),
	});

	const teamScopeId = dogfoodScope(runtime, session, "turn-team-retry");
	await runSanLoop({
		sessionManager: session,
		executionRuntime: runtime,
		executionScopeId: teamScopeId,
		objective: "Dogfood team mode retry loop",
		mode: "team",
		runId: "loop_dogfood_team_retry",
		...dogfoodRunContract(),
		executor: makeExecutor({
			taskId: "team-retry",
			taskTitle: "team retry implementation",
			reviews: ["needs_fix", "pass"],
			runtime,
			scopeId: teamScopeId,
		}),
	});

	const councilScopeId = dogfoodScope(runtime, session, "turn-council-blocked");
	await runSanLoop({
		sessionManager: session,
		executionRuntime: runtime,
		executionScopeId: councilScopeId,
		objective: "Dogfood council mode blocked loop",
		mode: "council",
		runId: "loop_dogfood_council_blocked",
		...dogfoodRunContract(),
		executor: makeExecutor({
			taskId: "council-blocked",
			taskTitle: "council blocked implementation",
			reviews: ["blocked"],
			oracle: true,
			runtime,
			scopeId: councilScopeId,
		}),
	});

	const budgetScopeId = dogfoodScope(runtime, session, "turn-budget-exhausted");
	await runSanLoop({
		sessionManager: session,
		objective: "Dogfood hard turn budget",
		executionRuntime: runtime,
		executionScopeId: budgetScopeId,
		mode: "team",
		runId: "loop_dogfood_budget_exhausted",
		...dogfoodRunContract(),
		executor: makeExecutor({
			taskId: "budget-exhausted",
			taskTitle: "budget exhausted implementation",
			reviews: ["pass"],
			runtime,
			scopeId: budgetScopeId,
		}),
		maxTurns: 2,
	});

	const activeRun = createSanLoopRunSnapshot({
		sessionId,
		objective: "Dogfood active run recovery",
		mode: "team",
		runId: "loop_dogfood_recovered",
	});
	appendSanLoopRunSnapshot(session, activeRun);
	recoverSanLoopRun(session, activeRun, { reason: "Dogfood recovered active run without a child process." });

	const abortScopeId = dogfoodScope(runtime, session, "turn-operator-abort");
	const workerStarted = Promise.withResolvers<void>();
	const workerAbortObserved = Promise.withResolvers<void>();
	const abortExecutor = makeExecutor({
		taskId: "operator-abort",
		taskTitle: "operator abort implementation",
		reviews: ["pass"],
		runtime,
		scopeId: abortScopeId,
	});
	abortExecutor.worker = async invocation => {
		workerStarted.resolve();
		if (!invocation.signal) throw new Error("San dogfood cancellation worker did not receive an AbortSignal.");
		const interrupted = Promise.withResolvers<never>();
		invocation.signal.addEventListener(
			"abort",
			() => {
				workerAbortObserved.resolve();
				interrupted.reject(invocation.signal?.reason ?? new Error("San dogfood worker aborted."));
			},
			{ once: true },
		);
		return await interrupted.promise;
	};
	const abortRun = runSanLoop({
		sessionManager: session,
		objective: "Dogfood operator abort",
		executionRuntime: runtime,
		executionScopeId: abortScopeId,
		mode: "solo",
		runId: "loop_dogfood_aborted",
		...dogfoodRunContract(),
		executor: abortExecutor,
	});
	await workerStarted.promise;
	const abortCompletion = cancelRunningSanLoop("loop_dogfood_aborted");
	if (!abortCompletion) throw new Error("San dogfood could not find its active cancellation run.");
	await abortRun;
	await abortCompletion;
	await workerAbortObserved.promise;

	const entries = session.getEntries();
	const scenarios = [
		reportScenario(entries, "solo pass", "loop_dogfood_solo_pass", "solo"),
		reportScenario(entries, "team retry", "loop_dogfood_team_retry", "team"),
		reportScenario(entries, "council blocked", "loop_dogfood_council_blocked", "council"),
		reportScenario(entries, "budget exhausted", "loop_dogfood_budget_exhausted", "team"),
		reportScenario(entries, "recovery", "loop_dogfood_recovered", "team"),
		reportScenario(entries, "abort", "loop_dogfood_aborted", "solo"),
	];
	const ledger = rebuildSanLoopLedger(entries);
	const recoveredRuns = ledger.events.filter(event => event.data.type === "recovered").length;
	const assertions = [
		assertResult(
			"solo pass reaches final verdict",
			scenarios[0]?.status === "passed" && scenarios[0].events.includes("finalized"),
			`${scenarios[0]?.status ?? "missing"} with events=${scenarios[0]?.events.join(",") ?? "none"}`,
		),
		assertResult(
			"team retry repairs needs_fix",
			scenarios[1]?.status === "passed" &&
				scenarios[1].retryCount === 1 &&
				scenarios[1].events.includes("retry_requested"),
			`${scenarios[1]?.status ?? "missing"} retry=${scenarios[1]?.retryCount ?? -1}`,
		),
		assertResult(
			"council mode keeps Oracle advisory and lets Supervisor own terminal authority",
			defaultSanLoopModePolicy("council").requireOracle &&
				!scenarios[2]?.events.includes("finalized") &&
				scenarios[2]?.events.filter(event => event === "review_completed").length === 2 &&
				scenarios[2]?.reviews === 2,
			`requireOracle=${defaultSanLoopModePolicy("council").requireOracle}, reviews=${scenarios[2]?.reviews ?? -1}`,
		),
		assertResult(
			"council blocked is terminal",
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
