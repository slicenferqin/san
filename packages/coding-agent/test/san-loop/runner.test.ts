import { describe, expect, test } from "bun:test";
import {
	cancelRunningSanLoop,
	findLatestSanLoopRun,
	rebuildSanLoopLedger,
	requestSanLoopAbort,
	runSanLoop,
	type SanLoopAgentExecutor,
	type SanLoopTaskNode,
	type SanLoopWorkerResultInput,
} from "../../src/san-loop";
import { SessionManager } from "../../src/session/session-manager";

function taskNode(id: string): SanLoopTaskNode {
	return {
		id,
		title: `Implement ${id}`,
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: ["focused checks pass"],
		checkRefs: ["supervisor-gate"],
	};
}

describe("San loop runner", () => {
	test("drives a complete commander-worker-supervisor pass loop into the ledger", async () => {
		const session = SessionManager.inMemory();
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["final verdict is pass"],
						taskGraph: [taskNode("runner")],
						checkPlan: ["supervisor-gate"],
					},
				};
			},
			async worker(invocation) {
				return {
					resultId: "result-pass",
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed the implementation.",
					changedFiles: ["packages/coding-agent/src/san-loop/runner.ts"],
					verification: ["focused checks pass"],
				};
			},
			async supervisor() {
				return {
					reportId: "review-pass",
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test test/san-loop"],
					evidence: ["all focused checks pass"],
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Ship runner loop",
			mode: "team",
			runId: "loop_runner_pass",
			executor,
		});

		expect(result.run.status).toBe("passed");
		expect(result.run.finalVerdict).toBe("pass");
		expect(result.transitions.map(transition => transition.event.type)).toEqual([
			"plan_created",
			"assignment_created",
			"worker_completed",
			"finalized",
		]);
		expect(result.reviewEntryIds).toHaveLength(1);
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data).toMatchObject({
			runId: "loop_runner_pass",
			status: "passed",
			finalVerdict: "pass",
		});
		expect(ledger.events.map(event => event.data.type)).toContain("finalized");
		expect(ledger.reviews[0]?.data.verdict).toBe("pass");
	});

	test("retries when supervisor returns needs_fix and stops after pass", async () => {
		const session = SessionManager.inMemory();
		let commanderCalls = 0;
		let workerCalls = 0;
		let supervisorCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				commanderCalls += 1;
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["retry resolves defect"],
						taskGraph: [taskNode(`retry-${commanderCalls}`)],
						checkPlan: ["supervisor-gate"],
						riskRegister: invocation.latestReview ? ["prior review requested fix"] : [],
					},
				};
			},
			async worker(invocation) {
				workerCalls += 1;
				return {
					resultId: `result-${workerCalls}`,
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: `Worker attempt ${workerCalls} completed.`,
					verification: ["focused checks pass"],
				};
			},
			async supervisor() {
				supervisorCalls += 1;
				if (supervisorCalls === 1) {
					return {
						reportId: "review-fix",
						reviewer: "supervisor",
						verdict: "needs_fix",
						defects: [
							{
								defectId: "defect-1",
								severity: "high",
								title: "Missing follow-up",
								evidence: ["first attempt did not include retry evidence"],
								retryable: true,
							},
						],
						requiredNextActions: ["retry implementation"],
						confidence: "high",
					};
				}
				return {
					reportId: "review-pass",
					reviewer: "supervisor",
					verdict: "pass",
					evidence: ["retry fixed defect"],
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Retry to pass",
			mode: "solo",
			runId: "loop_runner_retry",
			executor,
			maxRetries: 2,
			maxTurns: 6,
		});

		expect(result.run.status).toBe("passed");
		expect(result.run.retryCount).toBe(1);
		expect(commanderCalls).toBe(2);
		expect(workerCalls).toBe(2);
		expect(supervisorCalls).toBe(2);
		expect(result.transitions.map(transition => transition.event.type)).toEqual([
			"plan_created",
			"assignment_created",
			"worker_completed",
			"retry_requested",
			"plan_created",
			"assignment_created",
			"worker_completed",
			"finalized",
		]);
	});

	test("blocks before launching another agent when the turn budget is exhausted", async () => {
		const session = SessionManager.inMemory();
		let supervisorCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["budget exhaustion is auditable"],
						taskGraph: [taskNode("budget")],
						checkPlan: ["supervisor-gate"],
					},
				};
			},
			async worker(invocation) {
				return {
					resultId: "result-budget",
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker consumed the final budgeted turn.",
					verification: ["worker evidence persisted"],
				};
			},
			async supervisor() {
				supervisorCalls += 1;
				return {
					reportId: "review-should-not-run",
					reviewer: "supervisor",
					verdict: "pass",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Exhaust budget",
			mode: "solo",
			runId: "loop_runner_budget",
			executor,
			maxTurns: 2,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(result.run.budget.at(-1)?.remainingTurns).toBe(0);
		expect(supervisorCalls).toBe(0);
		expect(result.transitions.map(transition => transition.event.type)).toEqual([
			"plan_created",
			"assignment_created",
			"worker_completed",
			"blocked",
		]);
		expect(result.transitions.at(-1)?.event.summary).toBe("San execution loop exhausted the configured turn budget.");
	});

	test("runs oracle before supervisor in council mode", async () => {
		const session = SessionManager.inMemory();
		let oracleCalls = 0;
		let supervisorSawOracle = false;
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["oracle second opinion is recorded"],
						taskGraph: [taskNode("oracle")],
						checkPlan: ["supervisor-gate"],
					},
				};
			},
			async worker(invocation) {
				return {
					resultId: "result-oracle",
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed council-mode task.",
					verification: ["worker evidence persisted"],
				};
			},
			async oracle() {
				oracleCalls += 1;
				return {
					reportId: "review-oracle",
					reviewer: "oracle",
					verdict: "pass",
					evidence: ["oracle checked council-mode evidence"],
					requiredNextActions: ["continue supervisor gate"],
					confidence: "high",
				};
			},
			async supervisor(invocation) {
				supervisorSawOracle = invocation.oracleReview?.reviewer === "oracle";
				return {
					reportId: "review-supervisor",
					reviewer: "supervisor",
					verdict: "pass",
					evidence: ["supervisor incorporated oracle opinion"],
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Council oracle gate",
			mode: "council",
			runId: "loop_runner_oracle",
			executor,
		});

		expect(result.run.status).toBe("passed");
		expect(oracleCalls).toBe(1);
		expect(supervisorSawOracle).toBe(true);
		expect(result.reviewEntryIds).toHaveLength(2);
		expect(result.transitions.map(transition => transition.event.actor)).toContain("oracle");
		expect(result.transitions.filter(transition => transition.event.type === "finalized")).toHaveLength(1);
		expect(result.transitions.find(transition => transition.event.actor === "oracle")?.event.type).toBe(
			"review_completed",
		);
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.reviews.map(review => review.data.reviewer)).toEqual(["oracle", "supervisor"]);
	});

	test("blocks dependent assignments and never invokes Supervisor after a Worker failure", async () => {
		const session = SessionManager.inMemory();
		const workerCalls: string[] = [];
		let supervisorCalls = 0;
		const first = taskNode("first");
		const second = { ...taskNode("second"), dependsOn: ["first"] };
		const executor: SanLoopAgentExecutor = {
			async commander() {
				return { plan: { taskGraph: [first, second] } };
			},
			async worker(invocation) {
				workerCalls.push(invocation.assignment.objective);
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "failed",
					summary: "The first dependency failed.",
				};
			},
			async supervisor() {
				supervisorCalls += 1;
				return { reviewer: "supervisor", verdict: "pass" };
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Respect DAG failures",
			runId: "loop_runner_worker_failure",
			executor,
		});

		expect(result.run.status).toBe("failed");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(workerCalls).toEqual(["Implement first"]);
		expect(supervisorCalls).toBe(0);
		expect(result.transitions.map(transition => transition.event.type)).not.toContain("finalized");
	});

	test("does not retry a non-retryable needs_fix verdict when maxRetries is zero", async () => {
		const session = SessionManager.inMemory();
		let commanderCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander() {
				commanderCalls += 1;
				return { plan: { taskGraph: [taskNode("no-retry")] } };
			},
			async worker(invocation) {
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed the attempt.",
				};
			},
			async supervisor() {
				return { reviewer: "supervisor", verdict: "needs_fix", retryable: false };
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Honor retry policy",
			runId: "loop_runner_no_retry",
			maxRetries: 0,
			executor,
		});

		expect(result.run.status).toBe("failed");
		expect(result.run.retryCount).toBe(0);
		expect(commanderCalls).toBe(1);
		expect(result.transitions.map(transition => transition.event.type)).not.toContain("retry_requested");
	});

	test("propagates cancellation to a running Worker and acknowledges aborted as the final state", async () => {
		const session = SessionManager.inMemory();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const executor: SanLoopAgentExecutor = {
			async commander() {
				return { plan: { taskGraph: [taskNode("cancel")] } };
			},
			worker(invocation) {
				started.resolve();
				const signal = invocation.signal;
				if (!signal) throw new Error("Expected active San loop Worker signal.");
				const result = Promise.withResolvers<SanLoopWorkerResultInput>();
				signal.addEventListener(
					"abort",
					() => {
						cancelled.resolve();
						result.reject(signal.reason);
					},
					{ once: true },
				);
				return result.promise;
			},
			async supervisor() {
				return { reviewer: "supervisor", verdict: "pass" };
			},
		};
		const running = runSanLoop({
			sessionManager: session,
			objective: "Cancel live child",
			runId: "loop_runner_cancel",
			executor,
		});
		await started.promise;
		const active = findLatestSanLoopRun(session.getEntries(), "loop_runner_cancel");
		if (!active) throw new Error("Expected active San loop run before cancellation.");
		requestSanLoopAbort(session, active.data);
		const completion = cancelRunningSanLoop(active.data.runId);
		if (!completion) throw new Error("Expected cancellation registry entry for active San loop run.");
		await completion;

		const result = await running;
		await cancelled.promise;
		expect(result.run.status).toBe("aborted");
		expect(result.transitions.map(transition => transition.event.type).slice(-1)).toEqual(["aborted"]);
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.events.map(event => event.data.type).slice(-2)).toEqual(["abort_requested", "aborted"]);
		expect(ledger.latestRun?.data.status).toBe("aborted");
	});
});
