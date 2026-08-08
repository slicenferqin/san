import { describe, expect, test } from "bun:test";
import type { ImmutableObjectiveContract } from "../../src/execution-control";
import { createExecutionRuntime, ProviderHealthRegistry, TaskContractRegistry } from "../../src/execution-control";
import { createExternalEvidenceReceipt } from "../../src/execution-control/evidence-gates";
import type { ExecutionRuntime } from "../../src/execution-control/execution-runtime";
import type { AcceptanceGate } from "../../src/execution-control/types";
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

function passingCommands(): NonNullable<SanLoopWorkerResultInput["commandsRun"]> {
	return [{ command: "bun test packages/coding-agent/test/san-loop", exitCode: 0, summary: "passed", source: "host" }];
}
const NOW = "2026-08-07T00:00:00.000Z";

function objectiveContract(revision = 1, turnId = "turn-1"): ImmutableObjectiveContract {
	return {
		ref: {
			contractId: "contract-root",
			revision,
			contractHash: `sha256-contract-${revision}`,
			clauseRefs: ["clause:deliver"],
		},
		authoritativeUserTurnId: turnId,
		source: "authoritative_user",
	};
}

function runtimeFor(session: SessionManager, providerRegistry = new ProviderHealthRegistry({ now: () => 0 })) {
	return createExecutionRuntime({
		rootSessionId: session.getSessionId(),
		branchEntries: session.getEntries(),
		sessionManager: session,
		taskRegistry: new TaskContractRegistry({ rootSessionId: session.getSessionId() }),
		providerRegistry,
		now: () => NOW,
	});
}

function scopeFor(runtime: ExecutionRuntime, session: SessionManager, turnId = "turn-1"): string {
	return runtime.startScope({
		rootSessionId: session.getSessionId(),
		logicalTurnId: turnId,
		objectiveContract: objectiveContract(1, turnId),
	}).scopeId;
}

// runner 在 assignment 产生后按 assignment materialize host gate（gateId 带
// assignmentId 后缀，freshnessRevision 来自该时刻 scope snapshot）；测试按
// assignmentId 动态读取该 gate 构造 receipt，不硬编码 gateId/freshness。
function materializedGateForAssignment(
	runtime: ExecutionRuntime,
	executionScopeId: string,
	assignmentId: string,
): AcceptanceGate {
	const gate = runtime
		.getScope(executionScopeId)
		?.snapshot()
		.gates.find(candidate => candidate.assignmentId === assignmentId);
	if (!gate)
		throw new Error(`materialized gate for assignment ${assignmentId} not found in scope ${executionScopeId}`);
	return gate;
}

describe("San loop runner", () => {
	test("blocks an otherwise passing commander-worker-supervisor loop without host evidence", async () => {
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
					commandsRun: passingCommands(),
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Ship runner loop",
			mode: "team",
			runId: "loop_runner_pass",
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(result.transitions.map(transition => transition.event.type)).toEqual([
			"plan_created",
			"assignment_created",
			"worker_completed",
			"blocked",
		]);
		expect(result.reviewEntryIds).toHaveLength(1);
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data).toMatchObject({
			runId: "loop_runner_pass",
			status: "blocked",
			finalVerdict: "blocked",
		});
		expect(ledger.events.map(event => event.data.type)).not.toContain("finalized");
		expect(ledger.reviews[0]?.data.verdict).toBe("pass");
		// 无 acceptance gates 的模型 pass 不得推进 runtime scope 或 San run。
		expect(runtime.getScope(executionScopeId)?.snapshot().state).not.toBe("completed");
	});

	test("host scheduler grace gate blocks dispatch and records deterministic blocked", async () => {
		const session = SessionManager.inMemory();
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const scheduler = runtime.schedulerFor(executionScopeId);
		scheduler.openGraceWindow();
		let workerCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander() {
				throw new Error("commander must not run inside the grace window");
			},
			async worker() {
				workerCalls += 1;
				return { assignmentId: "loop_runner_gate_gated", status: "completed", summary: "unexpected dispatch" };
			},
			async supervisor() {
				throw new Error("supervisor must not run inside the grace window");
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Wait for the diagnostic grace window",
			mode: "solo",
			runId: "loop_runner_gate",
			executor,
			executionRuntime: runtime,
			executionScopeId,
			maxTurns: 4,
		});

		expect(workerCalls).toBe(0);
		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		const blocked = result.transitions.find(transition => transition.event.type === "blocked");
		expect(blocked?.event.data).toMatchObject({ blockedBy: "dispatch_gate", role: "worker" });
	});

	test("retries after needs_fix then blocks a model-only pass", async () => {
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
					commandsRun: passingCommands(),
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Retry to pass",
			mode: "team",
			runId: "loop_runner_retry",
			executor,
			maxRetries: 2,
			maxTurns: 6,
		});

		expect(result.run.status).toBe("blocked");
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
			"blocked",
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Exhaust budget",
			mode: "team",
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
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("budget_exhausted");
		expect(
			runtime.taskRegistry.list(executionScopeId).map(contract => [contract.strategyKey, contract.status]),
		).toEqual([["san-loop:team:worker", "completed"]]);
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
					commandsRun: passingCommands(),
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Council oracle gate",
			mode: "council",
			runId: "loop_runner_oracle",
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(oracleCalls).toBe(1);
		expect(supervisorSawOracle).toBe(true);
		expect(result.reviewEntryIds).toHaveLength(2);
		expect(result.transitions.map(transition => transition.event.actor)).toContain("oracle");
		expect(result.transitions.filter(transition => transition.event.type === "finalized")).toHaveLength(0);
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const workerStatuses = new Map<string, string[]>();
		runtime.taskRegistry.subscribe(change => {
			if (change.type === "reset" || change.snapshot.strategyKey !== "san-loop:team:worker") return;
			const taskId = change.snapshot.taskId ?? "unknown";
			const statuses = workerStatuses.get(taskId) ?? [];
			statuses.push(change.snapshot.status);
			workerStatuses.set(taskId, statuses);
		});
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Respect DAG failures",
			runId: "loop_runner_worker_failure",
			executor,
		});

		expect(result.run.status).toBe("failed");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(workerCalls).toEqual(["Implement first"]);
		expect(supervisorCalls).toBe(0);
		expect(result.transitions.map(transition => transition.event.type)).not.toContain("finalized");
		expect(workerStatuses).toEqual(
			new Map([
				["first", ["queued", "running", "failed"]],
				["second", ["queued", "cancelled"]],
			]),
		);
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

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
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
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const workerStatuses: string[] = [];
		runtime.taskRegistry.subscribe(change => {
			if (change.type !== "reset" && change.snapshot.strategyKey === "san-loop:team:worker") {
				workerStatuses.push(change.snapshot.status);
			}
		});
		const running = runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
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
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("aborted_by_user");
		expect(workerStatuses).toEqual(["queued", "running", "cancelled"]);
	});

	test("aborts and drains sibling Workers before recording an executor failure", async () => {
		const session = SessionManager.inMemory();
		const bothStarted = Promise.withResolvers<void>();
		let started = 0;
		let siblingAborted = false;
		let lateSideEffect = false;
		const executor: SanLoopAgentExecutor = {
			async commander() {
				return { plan: { taskGraph: [taskNode("fails"), taskNode("sibling")] } };
			},
			async worker(invocation) {
				started++;
				if (started === 2) bothStarted.resolve();
				await bothStarted.promise;
				if (invocation.assignment.objective === "Implement fails") throw new Error("first Worker failed");
				const signal = invocation.signal;
				if (!signal) throw new Error("Expected a Worker cancellation signal.");
				const pending = Promise.withResolvers<SanLoopWorkerResultInput>();
				let settled = false;
				signal.addEventListener(
					"abort",
					() => {
						settled = true;
						siblingAborted = true;
						pending.reject(signal.reason);
					},
					{ once: true },
				);
				void Bun.sleep(40).then(() => {
					if (settled) return;
					settled = true;
					lateSideEffect = true;
					pending.resolve({
						assignmentId: invocation.assignment.assignmentId,
						status: "completed",
						summary: "Sibling completed after the run failed.",
					});
				});
				return pending.promise;
			},
			async supervisor() {
				return { reviewer: "supervisor", verdict: "pass" };
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const workerStatuses = new Map<string, string[]>();
		runtime.taskRegistry.subscribe(change => {
			if (change.type === "reset" || change.snapshot.strategyKey !== "san-loop:team:worker") return;
			const statuses = workerStatuses.get(change.snapshot.workKey) ?? [];
			statuses.push(change.snapshot.status);
			workerStatuses.set(change.snapshot.workKey, statuses);
		});
		await expect(
			runSanLoop({
				sessionManager: session,
				executionRuntime: runtime,
				executionScopeId,
				objective: "Converge concurrent failures",
				runId: "loop_runner_sibling_abort",
				maxWorkers: 2,
				executor,
			}),
		).rejects.toThrow("first Worker failed");
		await Bun.sleep(60);

		expect(siblingAborted).toBe(true);
		expect(lateSideEffect).toBe(false);
		expect(findLatestSanLoopRun(session.getEntries(), "loop_runner_sibling_abort")?.data.status).toBe("failed");
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("runtime_fault");
		expect(
			[...workerStatuses.values()].every(statuses => statuses[0] === "queued" && statuses[1] === "running"),
		).toBe(true);
		expect([...workerStatuses.values()].map(statuses => statuses.at(-1)).sort()).toEqual(["cancelled", "failed"]);
	});

	test("normalizes invalid SDK worker and retry limits to mode defaults", async () => {
		const session = SessionManager.inMemory();
		let workerCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander() {
				return { plan: { taskGraph: [taskNode("normalize")] } };
			},
			async worker(invocation) {
				workerCalls++;
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Normalized limits still execute the assignment.",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				return {
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test"],
					evidence: ["normalized limits verified"],
				};
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Normalize SDK limits",
			runId: "loop_runner_normalized_limits",
			maxWorkers: Number.NaN,
			maxRetries: Number.NaN,
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.maxRetries).toBe(2);
		expect(workerCalls).toBe(1);
	});

	test("blocks after worker overspend even when maxTokens is tiny", async () => {
		const session = SessionManager.inMemory();
		let totalTokens = 0;
		const executor: SanLoopAgentExecutor = {
			usage: () => ({
				inputTokens: totalTokens,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens,
				cost: 0,
				durationMs: 0,
				providerRequests: 1,
			}),
			async commander() {
				return { plan: { taskGraph: [taskNode("token-budget")] } };
			},
			async worker(invocation) {
				totalTokens = 100;
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker spent 100 tokens.",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				return {
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test"],
					evidence: ["should not finalize"],
				};
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Hard token budget must block overspend",
			mode: "team",
			runId: "loop_runner_token_budget",
			maxTokens: 1,
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(result.transitions.map(t => t.event.type)).toContain("blocked");
		expect(result.transitions.at(-1)?.event.summary).toContain("tokens 100 >= 1");
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("budget_exhausted");
	});

	for (const dimension of ["cost", "providerRequests"] as const) {
		test(`maps an independent ${dimension} overspend to budget_exhausted before review`, async () => {
			const session = SessionManager.inMemory();
			const usage = {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				cost: 0,
				durationMs: 0,
				providerRequests: 0,
			};
			let supervisorCalls = 0;
			const executor: SanLoopAgentExecutor = {
				usage: () => ({ ...usage }),
				async commander() {
					return { plan: { taskGraph: [taskNode(`${dimension}-budget`)] } };
				},
				async worker(invocation) {
					if (dimension === "cost") usage.cost = 2;
					else usage.providerRequests = 2;
					return {
						assignmentId: invocation.assignment.assignmentId,
						status: "completed",
						summary: `Worker exceeded the ${dimension} budget.`,
					};
				},
				async supervisor() {
					supervisorCalls += 1;
					return { reviewer: "supervisor", verdict: "pass" };
				},
			};
			const runtime = runtimeFor(session);
			const executionScopeId = scopeFor(runtime, session);
			const result = await runSanLoop({
				sessionManager: session,
				executionRuntime: runtime,
				executionScopeId,
				objective: `Enforce ${dimension} budget`,
				runId: `loop_runner_${dimension}_budget`,
				...(dimension === "cost" ? { maxCost: 1 } : { maxProviderRequests: 1 }),
				executor,
			});

			expect(result.run.status).toBe("blocked");
			expect(result.transitions.at(-1)?.event.summary).toContain(dimension === "cost" ? "cost" : "requests");
			expect(supervisorCalls).toBe(0);
			expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("budget_exhausted");
		});
	}

	test("solo mode only invokes the worker role", async () => {
		const session = SessionManager.inMemory();
		const calls: string[] = [];
		const executor: SanLoopAgentExecutor = {
			async commander() {
				calls.push("commander");
				throw new Error("commander must not run in solo");
			},
			async worker(invocation) {
				calls.push("worker");
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Solo worker finished.",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				calls.push("supervisor");
				throw new Error("supervisor must not run in solo");
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Solo single-agent path",
			mode: "solo",
			runId: "loop_runner_solo_only_worker",
			executor,
		});

		expect(calls).toEqual(["worker"]);
		expect(result.run.status).toBe("blocked");
	});

	test("does not persist passed when post-review usage exceeds maxTokens", async () => {
		const session = SessionManager.inMemory();
		let totalTokens = 0;
		const executor: SanLoopAgentExecutor = {
			usage: () => ({
				inputTokens: totalTokens,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens,
				cost: 0,
				durationMs: 0,
				providerRequests: 1,
			}),
			async commander() {
				return { plan: { taskGraph: [taskNode("terminal-budget")] } };
			},
			async worker(invocation) {
				// Stay under budget until the supervisor call.
				totalTokens = 0;
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker stayed under budget.",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				// Spend during review so the gate only fires after the review is known.
				totalTokens = 100;
				return {
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test"],
					evidence: ["must not finalize when over budget"],
					confidence: "high",
				};
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Terminal budget must not write passed then fail",
			mode: "team",
			runId: "round2_terminal_budget",
			maxTokens: 1,
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data.status).toBe("blocked");
		expect(ledger.latestRun?.data.finalVerdict).toBe("blocked");
		expect(result.transitions.at(-1)?.event.type).toBe("blocked");
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("budget_exhausted");
	});

	test("partitions hard budgets across concurrent workers without launching an unfunded assignment", async () => {
		const session = SessionManager.inMemory();
		const usage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: 0,
			durationMs: 0,
			providerRequests: 0,
		};
		const bothStarted = Promise.withResolvers<void>();
		const budgets: Array<{ maxTokens?: number; maxCost?: number; maxProviderRequests?: number }> = [];
		let activeWorkers = 0;
		let maxActiveWorkers = 0;
		let supervisorCalls = 0;
		const executor: SanLoopAgentExecutor = {
			usage: () => ({ ...usage }),
			async commander() {
				return {
					plan: { taskGraph: [taskNode("lease-a"), taskNode("lease-b"), taskNode("lease-c")] },
				};
			},
			async worker(invocation) {
				budgets.push({ ...invocation.budget });
				activeWorkers += 1;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				if (budgets.length === 2) bothStarted.resolve();
				await bothStarted.promise;
				usage.totalTokens += invocation.budget?.maxTokens ?? 0;
				usage.inputTokens = usage.totalTokens;
				usage.cost += invocation.budget?.maxCost ?? 0;
				usage.providerRequests += invocation.budget?.maxProviderRequests ?? 0;
				activeWorkers -= 1;
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker stayed within its exclusive lease.",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				supervisorCalls += 1;
				return { reviewer: "supervisor", verdict: "pass" };
			},
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Partition concurrent hard budgets",
			mode: "team",
			runId: "loop_runner_exclusive_usage_budget",
			maxWorkers: 3,
			maxTokens: 100,
			maxCost: 1,
			maxProviderRequests: 2,
			executor,
		});

		expect(maxActiveWorkers).toBe(2);
		expect(budgets).toEqual([
			{ maxTokens: 50, maxCost: 0.5, maxProviderRequests: 1 },
			{ maxTokens: 50, maxCost: 0.5, maxProviderRequests: 1 },
		]);
		expect(usage.totalTokens).toBeLessThanOrEqual(100);
		expect(usage.cost).toBeLessThanOrEqual(1);
		expect(usage.providerRequests).toBeLessThanOrEqual(2);
		expect(supervisorCalls).toBe(0);
		expect(result.run.status).toBe("blocked");
		expect(result.run.workerResults).toHaveLength(2);
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("budget_exhausted");
	});

	test("blocks council runs when Oracle is required but unavailable", async () => {
		const session = SessionManager.inMemory();
		const calls: string[] = [];
		const executor: SanLoopAgentExecutor = {
			async commander() {
				calls.push("commander");
				return { plan: { taskGraph: [taskNode("needs-oracle")] } };
			},
			async worker(invocation) {
				calls.push("worker");
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "must not run without oracle",
					commandsRun: passingCommands(),
				};
			},
			async supervisor() {
				calls.push("supervisor");
				return {
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: [],
					evidence: [],
					confidence: "high",
				};
			},
			// oracle intentionally omitted
		};

		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const result = await runSanLoop({
			sessionManager: session,
			executionRuntime: runtime,
			executionScopeId,
			objective: "Council without oracle must block",
			mode: "council",
			runId: "loop_council_no_oracle",
			executor,
		});

		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(calls).toEqual([]);
		expect(result.transitions.at(-1)?.event.summary).toContain("requires Oracle");
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data.status).toBe("blocked");
	});
	test("materializes gates idempotently and finalizes only after host evidence passes", async () => {
		const session = SessionManager.inMemory();
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const workerStatuses: string[] = [];
		runtime.taskRegistry.subscribe(change => {
			if (change.type !== "reset" && change.snapshot.strategyKey === "san-loop:team:worker") {
				workerStatuses.push(change.snapshot.status);
			}
		});
		const gate: AcceptanceGate = {
			gateId: "gate:external",
			contractRef: {
				contractId: "contract-root",
				revision: 1,
				contractHash: "sha256-contract-1",
				clauseRefs: ["clause:deliver"],
			},
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			objectiveClauseRefs: ["clause:deliver"],
			verifier: { kind: "external", dependencyId: "dep:ci" },
			status: "unknown",
			evidenceRefs: [],
			required: true,
		};
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["final verdict is pass"],
						taskGraph: [taskNode("gated")],
					},
				};
			},
			async worker(invocation) {
				// receipt 直接读刚 materialize 的 gate（gateId/freshness/assignment 不硬编码）。
				const gate = materializedGateForAssignment(runtime, executionScopeId, invocation.assignment.assignmentId);
				return {
					resultId: "result-gated",
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed the gated task.",
					commandsRun: passingCommands(),
					verification: ["focused checks pass"],
					evidenceReceipts: [
						createExternalEvidenceReceipt({
							receiptId: "receipt:ci",
							scopeId: executionScopeId,
							gateId: gate.gateId,
							contractRevision: gate.contractRevision,
							contractHash: gate.contractHash ?? gate.contractRef.contractHash,
							freshnessRevision: gate.freshnessRevision!,
							assignmentId: invocation.assignment.assignmentId,
							outcome: "pass",
							timestamp: NOW,
							dependencyId: "dep:ci",
						}),
					],
				};
			},
			async supervisor() {
				return {
					reportId: "review-gated",
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test test/san-loop"],
					evidence: ["all focused checks pass"],
					evidenceRefs: ["receipt:ci"],
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Complete with host evidence",
			mode: "team",
			runId: "loop_runner_completed",
			executor,
			executionRuntime: runtime,
			executionScopeId,
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			acceptanceGates: [gate, gate],
		});

		expect(result.run.status).toBe("passed");
		const snapshot = runtime.getScope(executionScopeId)?.snapshot();
		expect(snapshot?.gates[0]?.status).toBe("pass");
		// materialize 绑定到当前 batch 的 assignment，且携带 freshnessRevision。
		expect(snapshot?.gates[0]?.assignmentId).toBe(result.run.assignments[0]?.assignmentId);
		expect(snapshot?.gates[0]?.freshnessRevision).toBeGreaterThan(0);
		expect(snapshot?.state).toBe("completed");
		expect(result.run.acceptanceGates).toHaveLength(1);
		expect(snapshot?.gates).toHaveLength(1);
		expect(workerStatuses).toEqual(["queued", "running", "completed"]);
		expect(
			runtime.taskRegistry.list(executionScopeId).map(contract => [contract.strategyKey, contract.status]),
		).toEqual([["san-loop:team:worker", "completed"]]);
	});

	test("needs_user enters only through a typed external blocker with host evidence", async () => {
		const session = SessionManager.inMemory();
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const gate: AcceptanceGate = {
			gateId: "gate:auth",
			contractRef: {
				contractId: "contract-root",
				revision: 1,
				contractHash: "sha256-contract-1",
				clauseRefs: ["clause:deliver"],
			},
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			objectiveClauseRefs: ["clause:deliver"],
			verifier: { kind: "external", dependencyId: "dep:auth" },
			status: "unknown",
			evidenceRefs: [],
			required: true,
		};
		const executor: SanLoopAgentExecutor = {
			async commander() {
				return { plan: { taskGraph: [taskNode("needs-user")], checkPlan: ["gate:auth"] } };
			},
			async worker(invocation) {
				const gate = materializedGateForAssignment(runtime, executionScopeId, invocation.assignment.assignmentId);
				return {
					resultId: "result-auth",
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed; auth dependency still missing.",
					commandsRun: passingCommands(),
					verification: ["worker evidence persisted"],
					evidenceReceipts: [
						createExternalEvidenceReceipt({
							receiptId: "receipt:auth",
							scopeId: executionScopeId,
							gateId: gate.gateId,
							contractRevision: gate.contractRevision,
							contractHash: gate.contractHash ?? gate.contractRef.contractHash,
							freshnessRevision: gate.freshnessRevision!,
							assignmentId: invocation.assignment.assignmentId,
							outcome: "failed",
							timestamp: NOW,
							dependencyId: "dep:auth",
						}),
					],
				};
			},
			async supervisor() {
				return {
					reportId: "review-blocked-external",
					reviewer: "supervisor",
					verdict: "blocked",
					defects: [
						{
							defectId: "external-auth",
							severity: "blocker",
							title: "Missing external auth dependency",
							evidence: ["typed blocker"],
							retryable: false,
						},
					],
					evidence: ["blocked by external dependency"],
					confidence: "high",
					externalBlocker: { kind: "external", dependencyId: "dep:auth", evidenceRef: "receipt:auth" },
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Wait on external auth",
			mode: "team",
			runId: "loop_runner_needs_user",
			executor,
			executionRuntime: runtime,
			executionScopeId,
			acceptanceGates: [gate],
		});

		expect(result.run.status).toBe("blocked");
		const snapshot = runtime.getScope(executionScopeId)?.snapshot();
		expect(snapshot?.state).toBe("needs_user");
		expect(snapshot?.gates[0]?.status).toBe("blocked");
	});

	test("maps all-unavailable provider routes to no_provider_available before any role call", async () => {
		const session = SessionManager.inMemory();
		const providerRegistry = new ProviderHealthRegistry({ now: () => 0, failureThreshold: 1 });
		const runtime = runtimeFor(session, providerRegistry);
		const executionScopeId = scopeFor(runtime, session);
		providerRegistry.recordAuthUnavailable(
			{ provider: "test-provider", normalizedUrl: "https://example.test/v1" },
			{ kind: "auth_unavailable", receiptRef: "auth-1" },
		);
		expect(runtime.providerRegistry.all()[0]?.state).toBe("open");
		let commanderCalls = 0;
		const executor: SanLoopAgentExecutor = {
			async commander() {
				commanderCalls += 1;
				return { plan: { taskGraph: [taskNode("no-route")] } };
			},
			async worker() {
				throw new Error("worker must not run without provider routes");
			},
			async supervisor() {
				throw new Error("supervisor must not run without provider routes");
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Block without provider routes",
			mode: "team",
			runId: "loop_runner_no_provider",
			executor,
			executionRuntime: runtime,
			executionScopeId,
		});

		expect(commanderCalls).toBe(0);
		expect(result.run.status).toBe("blocked");
		expect(result.run.finalVerdict).toBe("blocked");
		expect(runtime.getScope(executionScopeId)?.snapshot().state).toBe("no_provider_available");
	});

	test("provider cooldown blocks dispatch before expiry and allows role dispatch after", async () => {
		const session = SessionManager.inMemory();
		let now = 0;
		const providerRegistry = new ProviderHealthRegistry({ now: () => now, failureThreshold: 1 });
		const runtime = runtimeFor(session, providerRegistry);
		// runtime 构造会用分支 journal 重建注册表（空 journal 清空预置 entries），
		// 观测必须在 runtime 创建之后记录。
		providerRegistry.recordProviderError(
			{ provider: "test-provider", normalizedUrl: "https://example.test/v1" },
			{ receiptRef: "error-1" },
		);
		expect(providerRegistry.all()[0]?.state).toBe("open");

		// 到期前：任何 role 都不得被调用，scope 终态 no_provider_available。
		const scopeBefore = scopeFor(runtime, session);
		let commanderCallsBefore = 0;
		const blocked = await runSanLoop({
			sessionManager: session,
			objective: "Block before cooldown expiry",
			mode: "team",
			runId: "loop_runner_cooldown_before",
			executor: {
				async commander() {
					commanderCallsBefore += 1;
					return { plan: { taskGraph: [taskNode("cooldown")] } };
				},
				async worker() {
					throw new Error("worker must not run before cooldown expiry");
				},
				async supervisor() {
					throw new Error("supervisor must not run before cooldown expiry");
				},
			},
			executionRuntime: runtime,
			executionScopeId: scopeBefore,
		});
		expect(commanderCallsBefore).toBe(0);
		expect(blocked.run.status).toBe("blocked");
		expect(runtime.getScope(scopeBefore)?.snapshot().state).toBe("no_provider_available");

		// 到期后（注入 clock 推进）：gate 放行 dispatch，commander/worker 正常执行；
		// fake 无 typed host receipt，最终状态 blocked，不得伪造 pass。
		now = 1001;
		const scopeAfter = scopeFor(runtime, session, "turn-2");
		let commanderCallsAfter = 0;
		let workerCallsAfter = 0;
		const proceeded = await runSanLoop({
			sessionManager: session,
			objective: "Proceed after cooldown expiry",
			mode: "team",
			runId: "loop_runner_cooldown_after",
			executor: {
				async commander() {
					commanderCallsAfter += 1;
					return { plan: { taskGraph: [taskNode("probe")] } };
				},
				async worker(invocation) {
					workerCallsAfter += 1;
					return {
						resultId: "result-probe",
						assignmentId: invocation.assignment.assignmentId,
						status: "completed",
						summary: "Worker completed after cooldown expiry.",
						verification: [],
					};
				},
				async supervisor() {
					return {
						reportId: "review-probe",
						reviewer: "supervisor",
						verdict: "pass",
						testsRun: [],
						evidence: ["model claims"],
						confidence: "high",
					};
				},
			},
			executionRuntime: runtime,
			executionScopeId: scopeAfter,
		});
		expect(commanderCallsAfter).toBe(1);
		expect(workerCallsAfter).toBe(1);
		expect(proceeded.run.status).toBe("blocked");
		expect(runtime.getScope(scopeAfter)?.snapshot().state).not.toBe("no_provider_available");
	});

	test("materializes one gate per assignment with stable suffixed gate ids", async () => {
		const session = SessionManager.inMemory();
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const gate: AcceptanceGate = {
			gateId: "gate:per-assignment",
			contractRef: {
				contractId: "contract-root",
				revision: 1,
				contractHash: "sha256-contract-1",
				clauseRefs: ["clause:deliver"],
			},
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			objectiveClauseRefs: ["clause:deliver"],
			verifier: { kind: "external", dependencyId: "dep:ci" },
			status: "unknown",
			evidenceRefs: [],
			required: true,
		};
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["final verdict is pass"],
						taskGraph: [taskNode("gated-a"), taskNode("gated-b")],
						checkPlan: ["gate:per-assignment"],
					},
				};
			},
			async worker(invocation) {
				// 每个 worker 只认自己 assignment 绑定的 gate（gateId 带 assignmentId 后缀）。
				const gate = runtime
					.getScope(executionScopeId)
					?.snapshot()
					.gates.find(candidate => candidate.assignmentId === invocation.assignment.assignmentId);
				if (!gate) throw new Error("worker assignment gate not materialized");
				return {
					resultId: `result-${invocation.assignment.assignmentId}`,
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker completed the gated task.",
					commandsRun: passingCommands(),
					verification: ["focused checks pass"],
					evidenceReceipts: [
						createExternalEvidenceReceipt({
							receiptId: `receipt:${invocation.assignment.assignmentId}`,
							scopeId: executionScopeId,
							gateId: gate.gateId,
							contractRevision: gate.contractRevision,
							contractHash: gate.contractHash ?? gate.contractRef.contractHash,
							freshnessRevision: gate.freshnessRevision!,
							assignmentId: invocation.assignment.assignmentId,
							outcome: "pass",
							timestamp: NOW,
							dependencyId: "dep:ci",
						}),
					],
				};
			},
			async supervisor(invocation) {
				const receipts = invocation.workerResults.flatMap(
					result => result.evidenceReceipts?.map(receipt => receipt.receiptId) ?? [],
				);
				return {
					reportId: "review-multi",
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: ["bun test test/san-loop"],
					evidence: ["all focused checks pass"],
					evidenceRefs: receipts,
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Complete with per-assignment gates",
			mode: "team",
			runId: "loop_runner_multi_gate",
			executor,
			executionRuntime: runtime,
			executionScopeId,
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			acceptanceGates: [gate],
		});

		const snapshot = runtime.getScope(executionScopeId)?.snapshot();
		expect(snapshot?.gates).toHaveLength(2);
		const assignmentIds = result.run.assignments.map(assignment => assignment.assignmentId).sort();
		expect(snapshot?.gates.map(candidate => candidate.gateId).sort()).toEqual(
			assignmentIds.map(assignmentId => `gate:per-assignment:${assignmentId}`),
		);
		expect(snapshot?.gates.every(candidate => candidate.status === "pass")).toBe(true);
		expect(snapshot?.state).toBe("completed");
	});

	test("model-only completed workers record no evidence progress and cannot complete a gated scope", async () => {
		const session = SessionManager.inMemory();
		const runtime = runtimeFor(session);
		const executionScopeId = scopeFor(runtime, session);
		const gate: AcceptanceGate = {
			gateId: "gate:model-only",
			contractRef: {
				contractId: "contract-root",
				revision: 1,
				contractHash: "sha256-contract-1",
				clauseRefs: ["clause:deliver"],
			},
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			objectiveClauseRefs: ["clause:deliver"],
			verifier: { kind: "external", dependencyId: "dep:ci" },
			status: "unknown",
			evidenceRefs: [],
			required: true,
		};
		const executor: SanLoopAgentExecutor = {
			async commander(invocation) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["final verdict is pass"],
						taskGraph: [taskNode("model-only-a"), taskNode("model-only-b")],
						checkPlan: ["gate:model-only"],
					},
				};
			},
			async worker(invocation) {
				// 重复的模型声明 completed：无 host receipts，绝不产生 typed evidence。
				return {
					resultId: `result-model-only-${invocation.assignment.assignmentId}`,
					assignmentId: invocation.assignment.assignmentId,
					status: "completed",
					summary: "Worker claims completion without host evidence.",
					commandsRun: [{ command: "bun check", exitCode: 0, summary: "claimed", source: "model" }],
					verification: ["worker claims pass"],
				};
			},
			async supervisor() {
				return {
					reportId: "review-model-only",
					reviewer: "supervisor",
					verdict: "pass",
					testsRun: [],
					evidence: ["model claims"],
					confidence: "high",
				};
			},
		};

		const result = await runSanLoop({
			sessionManager: session,
			objective: "Model-only completion must not finalize",
			mode: "team",
			runId: "loop_runner_model_only",
			executor,
			executionRuntime: runtime,
			executionScopeId,
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			acceptanceGates: [gate],
		});

		expect(result.run.status).toBe("blocked");
		const snapshot = runtime.getScope(executionScopeId)?.snapshot();
		expect(snapshot?.state).not.toBe("completed");
		// 无 host receipts：scope ledger 不得出现 evidence/progress 类观察。
		expect(snapshot?.progress.filter(observation => observation.progressClass === "progress")).toHaveLength(0);
		expect(snapshot?.gates.every(candidate => candidate.status === "unknown")).toBe(true);
	});
});
