import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createSanLoopTaskAgentExecutor } from "../../src/san-loop/task-executor";
import {
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopReviewReport,
	type SanLoopRunSnapshot,
	type SanLoopWorkerAssignment,
	type SanLoopWorkerResult,
} from "../../src/san-loop/types";
import { SessionManager } from "../../src/session/session-manager";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";
import * as executorModule from "../../src/task/executor";
import type { SingleResult } from "../../src/task/types";

function makeResult(id: string, output: unknown): SingleResult {
	return {
		index: 0,
		id,
		agent: id,
		agentSource: "bundled",
		task: "san task",
		exitCode: 0,
		output: JSON.stringify(output),
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		extractedToolData: { yield: [{ data: output }] },
	};
}

function makeFailureResult(id: string, stderr: string): SingleResult {
	return {
		index: 0,
		id,
		agent: id,
		agentSource: "bundled",
		task: "san task",
		exitCode: 1,
		output: "",
		stderr,
		error: stderr,
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		extractedToolData: { yield: [] },
	};
}

function runSnapshot(): SanLoopRunSnapshot {
	const now = "2026-07-02T00:00:00.000Z";
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		runId: "loop_role_models",
		sessionId: "session-role-models",
		objective: "Verify role model routing",
		mode: "deep",
		status: "working",
		createdAt: now,
		updatedAt: now,
		maxRetries: 2,
		retryCount: 0,
		contextPacketRefs: [],
		plan: undefined,
		assignments: [],
		workerResults: [],
		reviewReports: [],
		decisions: [],
		budget: [],
	};
}

function assignment(): SanLoopWorkerAssignment {
	return {
		assignmentId: "assign-role-models",
		runId: "loop_role_models",
		objective: "Implement role routing",
		instructions: "Patch San role model routing.",
		taskNodeIds: ["role-routing"],
		acceptanceCriteria: ["roles route to configured models"],
		checkRefs: ["supervisor-gate"],
		contextRefs: [],
		status: "in_progress",
		createdAt: "2026-07-02T00:00:00.000Z",
	};
}

function workerResult(): SanLoopWorkerResult {
	return {
		resultId: "result-role-models",
		runId: "loop_role_models",
		assignmentId: "assign-role-models",
		createdAt: "2026-07-02T00:00:00.000Z",
		status: "completed",
		summary: "Patched role routing.",
		changedFiles: ["packages/coding-agent/src/san-loop/task-executor.ts"],
		commandsRun: [],
		verification: ["focused test"],
		risks: [],
	};
}

function oracleReview(): SanLoopReviewReport {
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		reportId: "review-oracle",
		runId: "loop_role_models",
		reviewer: "oracle",
		verdict: "pass",
		defects: [],
		testsRun: [],
		evidence: ["oracle reviewed evidence"],
		retryable: false,
		requiredNextActions: [],
		confidence: "high",
		createdAt: "2026-07-02T00:00:00.000Z",
	};
}

describe("San loop bundled agents", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("registers role agents with expected tool and spawn boundaries", () => {
		clearBundledAgentsCache();
		const agents = loadBundledAgents();
		const byName = new Map(agents.map(agent => [agent.name, agent]));

		expect(byName.get("san-commander")?.spawns).toEqual(["san-worker", "san-supervisor", "san-oracle"]);
		expect(byName.get("san-commander")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-commander")?.tools).toEqual(expect.arrayContaining(["task", "todo", "yield"]));
		expect(byName.get("san-worker")?.spawns).toBeUndefined();
		expect(byName.get("san-worker")?.model).toEqual(["pi/task"]);
		expect(byName.get("san-worker")?.tools).toEqual(expect.arrayContaining(["write", "edit", "bash", "yield"]));
		expect(byName.get("san-supervisor")?.spawns).toEqual(["san-oracle"]);
		expect(byName.get("san-supervisor")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-supervisor")?.tools).toEqual(expect.arrayContaining(["bash", "yield"]));
		expect(byName.get("san-supervisor")?.tools ?? []).not.toContain("write");
		expect(byName.get("san-oracle")?.spawns).toBeUndefined();
		expect(byName.get("san-oracle")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-oracle")?.tools ?? []).not.toContain("bash");
	});

	test("routes configured execution-loop model roles into each San subagent", async () => {
		const settings = Settings.isolated({
			"san.executionLoop.roles.commander.modelRole": "plan",
			"san.executionLoop.roles.worker.modelRole": "deepseek/deepseek-v4-pro",
			"san.executionLoop.roles.supervisor.modelRole": "anthropic/claude-sonnet-4-5:max",
			"san.executionLoop.roles.oracle.modelRole": "openai/gpt-5.5:xhigh",
		});
		const calls: Array<{ agent: string; modelOverride: string | string[] | undefined }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			calls.push({ agent: options.agent.name, modelOverride: options.modelOverride });
			if (options.agent.name === "san-commander") {
				return makeResult(options.id, {
					objective: "Verify role model routing",
					mode: "deep",
					acceptanceCriteria: ["roles route to configured models"],
					assignments: [
						{
							objective: "Implement role routing",
							instructions: "Patch San role model routing.",
							acceptanceCriteria: ["roles route to configured models"],
							checkRefs: ["supervisor-gate"],
						},
					],
					decision: "dispatch",
					rationale: "route by role",
				});
			}
			if (options.agent.name === "san-worker") {
				return makeResult(options.id, {
					assignmentId: "assign-role-models",
					status: "completed",
					summary: "Patched role routing.",
					changedFiles: ["packages/coding-agent/src/san-loop/task-executor.ts"],
					commandsRun: [],
					verification: ["focused test"],
					risks: [],
				});
			}
			if (options.agent.name === "san-supervisor") {
				return makeResult(options.id, {
					verdict: "pass",
					retryable: false,
					confidence: "high",
					defects: [],
					testsRun: ["bun test packages/coding-agent/test/san-loop/agents.test.ts"],
					requiredNextActions: [],
					evidence: ["model override reached supervisor"],
				});
			}
			return makeResult(options.id, {
				opinion: "role routing is sound",
				confidence: "high",
				evidence: ["model override reached oracle"],
				recommendation: "continue",
			});
		});

		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});
		const run = runSnapshot();
		const workerAssignment = assignment();
		const worker = workerResult();

		await executor.commander({ run, mode: "deep" });
		await executor.worker({ run, mode: "deep", assignment: workerAssignment });
		await executor.supervisor({
			run,
			mode: "deep",
			assignments: [workerAssignment],
			workerResults: [worker],
			oracleReview: oracleReview(),
		});
		await executor.oracle?.({
			run,
			mode: "deep",
			assignments: [workerAssignment],
			workerResults: [worker],
		});

		expect(calls).toEqual([
			{ agent: "san-commander", modelOverride: "pi/plan" },
			{ agent: "san-worker", modelOverride: "deepseek/deepseek-v4-pro" },
			{ agent: "san-supervisor", modelOverride: "anthropic/claude-sonnet-4-5:max" },
			{ agent: "san-oracle", modelOverride: "openai/gpt-5.5:xhigh" },
		]);
	});

	test("retries transient commander failures before parsing yielded plans", async () => {
		const settings = Settings.isolated({});
		let calls = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			calls += 1;
			if (calls === 1) {
				return makeFailureResult(
					options.id,
					"OpenAI responses stream closed before a terminal response event was received",
				);
			}
			return makeResult(options.id, {
				objective: "Recover from transient provider stream failure",
				mode: "deep",
				acceptanceCriteria: ["commander dispatches after retry"],
				assignments: [
					{
						agent: "san-worker",
						objective: "Verify retry recovery",
						instructions: "Produce structured worker evidence after the commander retry succeeds.",
						acceptanceCriteria: ["commander dispatches after retry"],
					},
				],
				decision: "dispatch",
				rationale: "retry recovered",
			});
		});
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "deep" });

		expect(calls).toBe(2);
		expect(result.assignments).toEqual([
			expect.objectContaining({
				objective: "Verify retry recovery",
				instructions: "Produce structured worker evidence after the commander retry succeeds.",
				acceptanceCriteria: ["commander dispatches after retry"],
			}),
		]);
	});

	test("normalizes snake_case commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				objective: "Verify real commander output",
				mode: "deep",
				acceptance_criteria: ["terminal verdict includes validation evidence"],
				worker_assignments: [
					{
						agent: "san-worker",
						id: "ReadOnlyFileCountSmoke",
						role: "Read-only filesystem smoke checker",
						assignment: "Inspect the current working directory, count visible files, and do not modify anything.",
						check_refs: ["supervisor-gate"],
					},
					{
						agent: "san-supervisor",
						id: "SmokeReview",
						role: "Read-only smoke evidence reviewer",
						assignment: "Review the worker evidence and produce the terminal verdict.",
					},
				],
				review_assignments: [
					{
						agent: "san-supervisor",
						assignment: "Confirm the worker stayed read-only and supplied evidence.",
					},
				],
				decision: "dispatch",
				plan_summary: "Dispatch one read-only smoke worker and review its evidence.",
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "deep" });

		expect(result.plan.acceptanceCriteria).toEqual(["terminal verdict includes validation evidence"]);
		expect(result.plan.riskRegister).toEqual(["Dispatch one read-only smoke worker and review its evidence."]);
		expect(result.plan.taskGraph).toEqual([
			expect.objectContaining({
				id: "read-only-filesystem-smoke-checker",
				title: "Read-only filesystem smoke checker",
				acceptanceCriteria: ["terminal verdict includes validation evidence"],
				checkRefs: ["supervisor-gate"],
			}),
		]);
		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "ReadOnlyFileCountSmoke",
				objective: "Read-only filesystem smoke checker",
				taskNodeIds: ["read-only-filesystem-smoke-checker"],
				instructions: "Inspect the current working directory, count visible files, and do not modify anything.",
				acceptanceCriteria: ["terminal verdict includes validation evidence"],
				checkRefs: ["supervisor-gate"],
			}),
		]);
	});

	test("normalizes staged commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				objective: "Verify staged commander output",
				mode: "rush",
				workerAssignments: [
					{
						agent: "san-worker",
						id: "ReadOnlySmokeInspector",
						role: "Read-only workspace smoke inspector",
						description: "Inspect without writes and report one factual observation.",
						assignment: "Inspect the current working directory without creating or modifying files.",
					},
				],
				stages: [
					{
						stage: 2,
						agent: "san-supervisor",
						id: "TerminalVerdictSupervisor",
						role: "San terminal verdict reviewer",
						assignment: "Review the worker evidence and issue the terminal verdict.",
					},
				],
				decision: "dispatch",
				plan_summary: "Run one bounded worker before supervisor review.",
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "rush" });

		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "ReadOnlySmokeInspector",
				objective: "Inspect without writes and report one factual observation.",
				taskNodeIds: [expect.stringContaining("inspect-without-writes")],
				instructions: "Inspect the current working directory without creating or modifying files.",
			}),
		]);
		expect(result.plan.taskGraph).toEqual([
			expect.objectContaining({
				id: expect.stringContaining("inspect-without-writes"),
				title: "Inspect without writes and report one factual observation.",
			}),
		]);
	});

	test("normalizes workers-field commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				decision: "dispatch_workers",
				mode: "rush",
				rationale: "Dispatch one bounded worker before a supervisor gate.",
				workers: [
					{
						agent: "san-worker",
						id: "SmokeInspector",
						role: "San loop smoke inspector",
						description:
							"Inspect package metadata and San loop source; minimally fix only a proven concrete bug.",
						assignment:
							"Inspect package metadata and San loop source. Make no changes unless a concrete bug is found.",
					},
				],
				supervisorAfterWorkers: {
					agent: "san-supervisor",
					id: "SmokeSupervisor",
					role: "San loop smoke gate supervisor",
					assignment: "Review the worker report and gate pass/fail/block decision.",
				},
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "rush" });

		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "SmokeInspector",
				objective: "Inspect package metadata and San loop source; minimally fix only a proven concrete bug.",
				taskNodeIds: [expect.stringContaining("inspect-package-metadata-and-san-loop-source")],
				instructions:
					"Inspect package metadata and San loop source. Make no changes unless a concrete bug is found.",
			}),
		]);
		expect(result.plan.taskGraph).toEqual([
			expect.objectContaining({
				id: expect.stringContaining("inspect-package-metadata-and-san-loop-source"),
				title: "Inspect package metadata and San loop source; minimally fix only a proven concrete bug.",
			}),
		]);
	});

	test("normalizes phase task commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				current_status: "planning",
				decision: "dispatch",
				mode: "rush",
				phases: [
					{
						agent: "san-worker",
						phase: "worker_smoke",
						tasks: [
							{
								id: "SmokeInspector",
								role: "San loop smoke implementer",
								description:
									"Inspect package metadata and San loop source; patch only if a concrete bug is found.",
								assignment:
									"Inspect metadata and San loop source. Return files_inspected and no-change evidence.",
								context: "Keep scope narrow and do not run broad gates.",
							},
						],
					},
					{
						agent: "san-supervisor",
						phase: "supervisor_gate_after_worker",
						tasks: [
							{
								id: "SmokeGate",
								role: "San loop smoke gate reviewer",
								assignment: "Gate the worker report.",
							},
						],
					},
				],
				rationale: "One worker then a supervisor gate.",
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "rush" });

		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "SmokeInspector",
				objective: "Inspect package metadata and San loop source; patch only if a concrete bug is found.",
				taskNodeIds: [expect.stringContaining("inspect-package-metadata-and-san-loop-source")],
				instructions: "Inspect metadata and San loop source. Return files_inspected and no-change evidence.",
			}),
		]);
		expect(result.plan.taskGraph).toEqual([
			expect.objectContaining({
				id: expect.stringContaining("inspect-package-metadata-and-san-loop-source"),
				title: "Inspect package metadata and San loop source; patch only if a concrete bug is found.",
			}),
		]);
	});

	test("normalizes nested dispatch commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				decision: "dispatch",
				mode: "rush",
				dispatch: {
					agent: "san-worker",
					tasks: [
						{
							id: "T02CrossFileScopeAudit",
							role: "Read-only cross-file feature-scope assessor",
							description: "Audit src/test/docs and recommend minimal feature slice",
							assignment: "Inspect src, tests, and docs without writing files.",
						},
					],
				},
				supervisor_gate: {
					agent: "san-supervisor",
					id: "T02TerminalVerdict",
					role: "San v0.2 T02 acceptance supervisor",
					assignment: "Review scope, evidence, and terminal verdict readiness.",
				},
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "rush" });

		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "T02CrossFileScopeAudit",
				objective: "Audit src/test/docs and recommend minimal feature slice",
				instructions: "Inspect src, tests, and docs without writing files.",
			}),
		]);
	});

	test("normalizes worker batch and waves commander yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				decision: "dispatch",
				mode: "rush",
				worker_batch: {
					agent: "san-worker",
					tasks: [
						{
							id: "BudgetBoundarySpec",
							role: "Budget-boundary acceptance spec reader",
							assignment: "Read budget-boundary acceptance materials only.",
						},
					],
				},
				waves: [
					{
						agent: "san-worker",
						id: "RulesEvidenceAudit",
						role: "项目规则约束证据审查员",
						assignment: "只读审查项目规则是否进入验收 evidence。",
					},
					{
						agent: "san-supervisor",
						id: "RulesEvidenceGate",
						role: "项目规则约束监督员",
						assignment: "监督 worker 报告。",
					},
				],
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.commander({ run: runSnapshot(), mode: "rush" });

		expect(result.assignments).toEqual([
			expect.objectContaining({
				assignmentId: "RulesEvidenceAudit",
				objective: "项目规则约束证据审查员",
				instructions: "只读审查项目规则是否进入验收 evidence。",
			}),
			expect.objectContaining({
				assignmentId: "BudgetBoundarySpec",
				objective: "Budget-boundary acceptance spec reader",
				instructions: "Read budget-boundary acceptance materials only.",
			}),
		]);
	});

	test("normalizes report-style worker yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				directory: "/private/tmp/san-v02-workspace-smoke3",
				file_count: 0,
				scope: "direct children only",
				verification_method: "read (directory listing) + glob (with hidden=true, gitignore=false)",
				mutations_performed: false,
				notes: "The current working directory is empty. All operations were strictly read-only.",
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.worker({ run: runSnapshot(), mode: "rush", assignment: assignment() });

		expect(result).toEqual(
			expect.objectContaining({
				assignmentId: "assign-role-models",
				status: "completed",
				summary:
					"directory=/private/tmp/san-v02-workspace-smoke3; file_count=0; scope=direct children only; read (directory listing) + glob (with hidden=true, gitignore=false); mutations_performed=false; The current working directory is empty. All operations were strictly read-only.",
				changedFiles: [],
				commandsRun: [],
				risks: [],
			}),
		);
		expect(result.verification).toEqual([
			"directory=/private/tmp/san-v02-workspace-smoke3",
			"file_count=0",
			"scope=direct children only",
			"method=read (directory listing) + glob (with hidden=true, gitignore=false)",
			"mutations_performed=false",
			"notes=The current working directory is empty. All operations were strictly read-only.",
		]);
	});

	test("normalizes snake_case supervisor yields from real providers", async () => {
		const settings = Settings.isolated({});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, {
				verdict: "pass",
				retryable: false,
				confidence: "high",
				defects: [
					{
						severity: "low",
						title: "No defect",
						evidence: ["reviewed worker evidence"],
						retryable: false,
						suggested_fix: "none",
					},
				],
				tests_run: ["read-only validation"],
				required_next_actions: ["terminal verdict PASS"],
				evidence: ["San loop terminal verdict: PASS"],
			}),
		);
		const executor = createSanLoopTaskAgentExecutor({
			cwd: "/tmp",
			session: {
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: { authStorage: {} } as never,
			},
		});

		const result = await executor.supervisor({
			run: runSnapshot(),
			mode: "rush",
			assignments: [assignment()],
			workerResults: [workerResult()],
		});

		expect(result).toEqual(
			expect.objectContaining({
				reviewer: "supervisor",
				verdict: "pass",
				testsRun: ["read-only validation"],
				requiredNextActions: ["terminal verdict PASS"],
				evidence: ["San loop terminal verdict: PASS"],
				retryable: false,
				confidence: "high",
			}),
		);
		expect(result.defects).toEqual([
			expect.objectContaining({
				severity: "low",
				title: "No defect",
				evidence: ["reviewed worker evidence"],
				retryable: false,
				suggestedFix: "none",
			}),
		]);
	});
});
