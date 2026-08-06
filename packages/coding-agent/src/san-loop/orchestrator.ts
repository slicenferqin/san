import {
	type EvidenceGateVerificationResult,
	isConcreteLegacyCommand,
	legacyCommandCheckId,
	verifyAcceptanceGates,
} from "../execution-control/evidence-gates";
import type { EvidenceReceipt, EvidenceRef } from "../execution-control/types";
import {
	type LegacySanLoopMode,
	normalizeSanLoopMode,
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopBudgetSnapshot,
	type SanLoopDecision,
	type SanLoopDefect,
	type SanLoopEventType,
	type SanLoopMode,
	type SanLoopPlan,
	type SanLoopReviewReport,
	type SanLoopReviewVerdict,
	type SanLoopRole,
	type SanLoopRunSnapshot,
	type SanLoopStatus,
	type SanLoopTaskNode,
	type SanLoopWorkerAssignment,
	type SanLoopWorkerResult,
} from "./types";

export interface SanLoopModePolicy {
	mode: SanLoopMode;
	maxRetries: number;
	maxWorkers: number;
	remainingTurns: number;
	requireOracle: boolean;
	pipeline: readonly SanLoopRole[];
}

export interface SanLoopPlanInput {
	objective?: string;
	constraints?: readonly string[];
	acceptanceCriteria?: readonly string[];
	taskGraph?: readonly SanLoopTaskNode[];
	checkPlan?: readonly string[];
	riskRegister?: readonly string[];
}

export interface SanLoopAssignmentInput {
	assignmentId?: string;
	objective: string;
	taskNodeIds: readonly string[];
	instructions: string;
	acceptanceCriteria?: readonly string[];
	contextRefs?: readonly string[];
	checkRefs?: readonly string[];
	createdAt?: string;
}

export interface SanLoopWorkerResultInput {
	resultId?: string;
	assignmentId: string;
	status: SanLoopWorkerResult["status"];
	summary: string;
	changedFiles?: readonly string[];
	commandsRun?: readonly SanLoopWorkerResult["commandsRun"][number][];
	verification?: readonly string[];
	risks?: readonly string[];
	createdAt?: string;
	evidenceReceipts?: readonly EvidenceReceipt[];
}

export interface SanLoopReviewInput {
	reportId?: string;
	reviewer: SanLoopReviewReport["reviewer"];
	verdict: SanLoopReviewVerdict;
	defects?: readonly SanLoopDefect[];
	testsRun?: readonly string[];
	evidence?: readonly string[];
	retryable?: boolean;
	requiredNextActions?: readonly string[];
	confidence?: SanLoopReviewReport["confidence"];
	assignmentId?: string;
	createdAt?: string;
	evidenceRefs?: readonly string[];
}

export interface SanLoopTransition {
	run: SanLoopRunSnapshot;
	eventType: SanLoopEventType;
	eventSummary: string;
	retryExhausted: boolean;
}
const DEFAULT_POLICIES: Record<SanLoopMode, SanLoopModePolicy> = {
	solo: {
		mode: "solo",
		maxRetries: 1,
		maxWorkers: 1,
		remainingTurns: 3,
		requireOracle: false,
		pipeline: ["worker"],
	},
	team: {
		mode: "team",
		maxRetries: 2,
		maxWorkers: 4,
		remainingTurns: 8,
		requireOracle: false,
		pipeline: ["commander", "worker", "supervisor"],
	},
	council: {
		mode: "council",
		maxRetries: 3,
		maxWorkers: 6,
		remainingTurns: 12,
		requireOracle: true,
		pipeline: ["commander", "worker", "oracle", "supervisor"],
	},
};

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${Bun.randomUUIDv7()}`;
}

function unique(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	return Array.from(new Set(values.map(value => value.trim()).filter(value => value.length > 0)));
}

function cloneTaskNode(task: SanLoopTaskNode): SanLoopTaskNode {
	return {
		...task,
		dependsOn: unique(task.dependsOn),
		acceptanceCriteria: unique(task.acceptanceCriteria),
		checkRefs: unique(task.checkRefs),
	};
}

function appendBudget(run: SanLoopRunSnapshot, status: SanLoopStatus, createdAt: string): SanLoopBudgetSnapshot[] {
	const latestRemaining = run.budget.at(-1)?.remainingTurns;
	const remainingTurns =
		latestRemaining === undefined
			? defaultSanLoopModePolicy(run.mode).remainingTurns
			: Math.max(0, latestRemaining - 1);
	return [...run.budget, { createdAt, state: status, remainingTurns }];
}

function appendDecision(
	run: SanLoopRunSnapshot,
	decision: Omit<SanLoopDecision, "decisionId" | "runId" | "createdAt"> & {
		decisionId?: string;
		createdAt: string;
	},
): SanLoopDecision[] {
	return [
		...run.decisions,
		{
			decisionId: decision.decisionId ?? newId("loop_decision"),
			runId: run.runId,
			createdAt: decision.createdAt,
			actor: decision.actor,
			decision: decision.decision,
			rationale: decision.rationale,
			nextAction: decision.nextAction,
		},
	];
}

function updateAssignmentStatus(
	assignments: readonly SanLoopWorkerAssignment[],
	assignmentId: string,
	status: SanLoopWorkerAssignment["status"],
): SanLoopWorkerAssignment[] {
	return assignments.map(assignment =>
		assignment.assignmentId === assignmentId ? { ...assignment, status } : { ...assignment },
	);
}

function updateTaskStatuses(
	plan: SanLoopPlan | undefined,
	taskNodeIds: readonly string[],
	status: SanLoopTaskNode["status"],
): SanLoopPlan | undefined {
	if (!plan) return undefined;
	const selected = new Set(taskNodeIds);
	return {
		...plan,
		taskGraph: plan.taskGraph.map(task => (selected.has(task.id) ? { ...task, status } : { ...task })),
	};
}

export function defaultSanLoopModePolicy(mode: SanLoopMode | LegacySanLoopMode): SanLoopModePolicy {
	const normalizedMode = normalizeSanLoopMode(mode) ?? "team";
	const policy = DEFAULT_POLICIES[normalizedMode];
	return { ...policy, pipeline: [...policy.pipeline] };
}

export function normalizeSanLoopPlan(run: SanLoopRunSnapshot, input: SanLoopPlanInput): SanLoopPlan {
	return {
		objective: input.objective?.trim() || run.objective,
		constraints: unique(input.constraints),
		acceptanceCriteria: unique(input.acceptanceCriteria),
		taskGraph: input.taskGraph?.map(cloneTaskNode) ?? [],
		checkPlan: unique(input.checkPlan),
		riskRegister: unique(input.riskRegister),
	};
}

export function applySanLoopPlan(
	run: SanLoopRunSnapshot,
	input: SanLoopPlanInput,
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const plan = normalizeSanLoopPlan(run, input);
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: "dispatching",
			plan,
			budget: appendBudget(run, "dispatching", createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: "commander",
				decision: "Accepted execution plan",
				rationale: `${plan.taskGraph.length} task(s), ${plan.checkPlan.length} check(s), ${plan.riskRegister.length} risk(s).`,
				nextAction: "dispatch_workers",
			}),
		},
		eventType: "plan_created",
		eventSummary: `Commander created a plan with ${plan.taskGraph.length} task(s).`,
		retryExhausted: false,
	};
}

export function createSanLoopWorkerAssignments(
	run: SanLoopRunSnapshot,
	inputs: readonly SanLoopAssignmentInput[],
): SanLoopWorkerAssignment[] {
	return inputs.map(input => ({
		assignmentId: input.assignmentId ?? newId("loop_assignment"),
		runId: run.runId,
		createdAt: input.createdAt ?? nowIso(),
		objective: input.objective.trim(),
		taskNodeIds: unique(input.taskNodeIds),
		instructions: input.instructions.trim(),
		acceptanceCriteria: unique(input.acceptanceCriteria),
		contextRefs: unique(input.contextRefs),
		checkRefs: unique(input.checkRefs),
		status: "pending",
	}));
}

export function dispatchSanLoopAssignments(
	run: SanLoopRunSnapshot,
	inputs: readonly SanLoopAssignmentInput[],
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const assignments = createSanLoopWorkerAssignments(run, inputs);
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: assignments.length > 0 ? "working" : "blocked",
			assignments: [...run.assignments, ...assignments],
			budget: appendBudget(run, assignments.length > 0 ? "working" : "blocked", createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: "commander",
				decision: assignments.length > 0 ? "Dispatched worker assignments" : "Blocked before dispatch",
				rationale:
					assignments.length > 0
						? `${assignments.length} worker assignment(s) created.`
						: "No worker assignment inputs were available.",
				nextAction: assignments.length > 0 ? "collect_worker_results" : "request_human_input",
			}),
		},
		eventType: assignments.length > 0 ? "assignment_created" : "blocked",
		eventSummary:
			assignments.length > 0
				? `Commander dispatched ${assignments.length} worker assignment(s).`
				: "Commander could not dispatch any worker assignment.",
		retryExhausted: false,
	};
}

export function createSanLoopWorkerResult(
	run: SanLoopRunSnapshot,
	input: SanLoopWorkerResultInput,
): SanLoopWorkerResult {
	return {
		resultId: input.resultId ?? newId("loop_result"),
		runId: run.runId,
		assignmentId: input.assignmentId,
		createdAt: input.createdAt ?? nowIso(),
		status: input.status,
		summary: input.summary.trim(),
		changedFiles: unique(input.changedFiles),
		commandsRun: input.commandsRun ? input.commandsRun.map(command => ({ ...command })) : [],
		evidenceReceipts: input.evidenceReceipts ? input.evidenceReceipts.map(receipt => ({ ...receipt })) : [],
		verification: unique(input.verification),
		risks: unique(input.risks),
	};
}

export function recordSanLoopWorkerResult(
	run: SanLoopRunSnapshot,
	input: SanLoopWorkerResultInput,
	options: { createdAt?: string } = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const result = createSanLoopWorkerResult(run, { ...input, createdAt: input.createdAt ?? createdAt });
	const assignmentStatus: SanLoopWorkerAssignment["status"] =
		result.status === "completed" ? "completed" : result.status === "blocked" ? "blocked" : "failed";
	const taskStatus: SanLoopTaskNode["status"] =
		result.status === "completed" ? "completed" : result.status === "blocked" ? "blocked" : "failed";
	const nextStatus: SanLoopStatus = result.status === "completed" ? "reviewing" : "working";
	const assignment = run.assignments.find(candidate => candidate.assignmentId === input.assignmentId);
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: nextStatus,
			plan: updateTaskStatuses(run.plan, assignment?.taskNodeIds ?? [], taskStatus),
			assignments: updateAssignmentStatus(run.assignments, result.assignmentId, assignmentStatus),
			evidenceReceipts: [...(run.evidenceReceipts ?? []), ...(result.evidenceReceipts ?? [])],
			workerResults: [...run.workerResults, result],
			budget: appendBudget(run, nextStatus, createdAt),
		},
		eventType: result.status === "completed" ? "worker_completed" : result.status === "failed" ? "failed" : "blocked",
		eventSummary: `Worker ${result.assignmentId} ${result.status}: ${result.summary}`,
		retryExhausted: false,
	};
}

export function createSanLoopReviewReport(run: SanLoopRunSnapshot, input: SanLoopReviewInput): SanLoopReviewReport {
	const retryable = input.retryable ?? input.verdict === "needs_fix";
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		reportId: input.reportId ?? newId("loop_review"),
		runId: run.runId,
		createdAt: input.createdAt ?? nowIso(),
		reviewer: input.reviewer,
		verdict: input.verdict,
		defects: input.defects ? input.defects.map(defect => ({ ...defect, evidence: unique(defect.evidence) })) : [],
		testsRun: unique(input.testsRun),
		evidenceRefs: unique(input.evidenceRefs),
		evidence: unique(input.evidence),
		retryable,
		requiredNextActions: unique(input.requiredNextActions),
		confidence: input.confidence ?? "medium",
		assignmentId: input.assignmentId,
	};
}
export interface SanLoopEvidenceValidationOptions {
	readonly currentBatchAssignmentIds?: readonly string[];
	readonly hostReceipts?: readonly EvidenceReceipt[];
	readonly freshnessRevision?: number;
}

function mergeHostReceipts(run: SanLoopRunSnapshot, options: SanLoopEvidenceValidationOptions): EvidenceReceipt[] {
	const canonical = run.evidenceReceipts?.length
		? run.evidenceReceipts
		: run.workerResults.flatMap(result => result.evidenceReceipts ?? []);
	const receipts: EvidenceReceipt[] = [];
	const byId = new Map<string, EvidenceReceipt>();
	for (const receipt of [...canonical, ...(options.hostReceipts ?? [])]) {
		const existing = byId.get(receipt.receiptId);
		if (!existing) {
			byId.set(receipt.receiptId, receipt);
			receipts.push(receipt);
			continue;
		}
		if (JSON.stringify(existing) !== JSON.stringify(receipt)) receipts.push(receipt);
	}
	return receipts;
}

function passEvidenceResult(evidenceRefs: readonly string[], reason: string): EvidenceGateVerificationResult {
	return {
		passed: true,
		allRequiredGatesPassing: true,
		verdicts: [],
		evidenceRefs: [...evidenceRefs],
		reasons: [reason],
	};
}

function failEvidenceResult(reason: string): EvidenceGateVerificationResult {
	return {
		passed: false,
		allRequiredGatesPassing: false,
		verdicts: [],
		evidenceRefs: [],
		reasons: [reason],
	};
}

function evidenceRefForReceipt(receipt: EvidenceReceipt): EvidenceRef {
	return {
		evidenceId: receipt.receiptId,
		kind: receipt.kind,
		receiptRef: receipt.receiptId,
		receiptId: receipt.receiptId,
		gateId: receipt.gateId,
		contractRevision: receipt.contractRevision,
		assignmentId: receipt.assignmentId,
		freshnessRevision: receipt.freshnessRevision,
	};
}

function legacyBatchIds(run: SanLoopRunSnapshot, requested?: readonly string[]): string[] {
	if (requested && requested.length > 0) return [...requested];
	const assignment = run.assignments.at(-1);
	if (assignment) return [assignment.assignmentId];
	const result = run.workerResults.at(-1);
	return result ? [result.assignmentId] : [];
}

/**
 * Validate a pass using only typed host receipts. Legacy sessions without a
 * typed contract retain readability through a concrete, test-like host command
 * derived from the current assignment; arbitrary successful bash is rejected.
 */
export function validatePassEvidence(
	report: SanLoopReviewReport,
	run: SanLoopRunSnapshot,
	options: SanLoopEvidenceValidationOptions = {},
): EvidenceGateVerificationResult {
	if (report.verdict !== "pass") return passEvidenceResult([], "non-pass review does not finalize");
	const batchIds = legacyBatchIds(run, options.currentBatchAssignmentIds);
	const receipts = mergeHostReceipts(run, options);
	const contractRevision = run.contractRevision ?? run.objectiveContract?.revision;
	const contractHash = run.contractHash ?? run.objectiveContract?.contractHash;
	const gates = run.acceptanceGates ?? [];
	if (gates.length > 0 || contractRevision !== undefined || contractHash !== undefined) {
		if (contractRevision === undefined || !contractHash) {
			return failEvidenceResult("typed acceptance gates require an immutable contract revision and hash");
		}
		const currentReceipts = receipts.filter(receipt => {
			if (!receipt.assignmentId || batchIds.length === 0) return true;
			return batchIds.includes(receipt.assignmentId);
		});
		const freshnessRevision = options.freshnessRevision ?? run.revision;
		const boundGates = gates.map(gate => {
			if (gate.evidenceRefs.length > 0 || !report.evidenceRefs || report.evidenceRefs.length === 0) return gate;
			const reported = currentReceipts.filter(
				receipt => report.evidenceRefs!.includes(receipt.receiptId) && receipt.gateId === gate.gateId,
			);
			return { ...gate, evidenceRefs: reported.map(evidenceRefForReceipt) };
		});
		return verifyAcceptanceGates({
			scopeId: run.runId,
			contractRevision,
			contractHash,
			freshnessRevision,
			gates: boundGates,
			receipts: currentReceipts,
			evidenceRefs: report.evidenceRefs,
			assignmentIds: batchIds,
		});
	}

	if (batchIds.length === 0) return failEvidenceResult("no current assignment batch exists");
	const batchSet = new Set(batchIds);
	const relevantResults = run.workerResults.filter(
		result => batchSet.has(result.assignmentId) && result.status === "completed",
	);
	const matchingCommands = relevantResults.flatMap(result =>
		result.commandsRun.filter(
			command => command.source === "host" && command.exitCode === 0 && isConcreteLegacyCommand(command.command),
		),
	);
	if (matchingCommands.length === 0) {
		return failEvidenceResult("no concrete host command check passed in the current assignment batch");
	}
	return passEvidenceResult(
		matchingCommands.map(command => legacyCommandCheckId(command.command)),
		"legacy host command matched a concrete derived check",
	);
}

export function applySanLoopReview(
	run: SanLoopRunSnapshot,
	input: SanLoopReviewInput,
	options: { createdAt?: string } & SanLoopEvidenceValidationOptions = {},
): SanLoopTransition {
	const createdAt = options.createdAt ?? nowIso();
	const rawReport = createSanLoopReviewReport(run, { ...input, createdAt: input.createdAt ?? createdAt });
	const evidenceVerdict = validatePassEvidence(rawReport, run, options);
	const evidenceValid = rawReport.verdict !== "pass" || evidenceVerdict.passed;
	const report: SanLoopReviewReport = evidenceValid
		? rawReport
		: {
				...rawReport,
				verdict: "blocked",
				retryable: false,
				defects: [
					...rawReport.defects,
					{
						defectId: "host-evidence-gate-blocked",
						severity: "blocker",
						title: "Supervisor pass rejected by host typed evidence gate.",
						evidence: [...evidenceVerdict.reasons],
						retryable: false,
					},
				],
				requiredNextActions: [
					...rawReport.requiredNextActions,
					"Worker must produce matching host-owned typed evidence for every required gate before a pass can finalize.",
				],
			};
	if (report.reviewer === "oracle") {
		return {
			run: {
				...run,
				updatedAt: createdAt,
				status: "reviewing",
				reviewReports: [...run.reviewReports, report],
				budget: appendBudget(run, "reviewing", createdAt),
				decisions: appendDecision(run, {
					createdAt,
					actor: "oracle",
					decision: `Oracle evidence: ${report.verdict}`,
					rationale: "Oracle reports are advisory evidence; only the Supervisor may finalize a run.",
					nextAction: "supervisor_gate",
				}),
			},
			eventType: "review_completed",
			eventSummary: `oracle advisory review ${report.verdict}; awaiting supervisor gate.`,
			retryExhausted: false,
		};
	}
	const retryableNeedsFix = report.verdict === "needs_fix" && report.retryable;
	const retryExhausted = retryableNeedsFix && run.retryCount >= run.maxRetries;
	const nextStatus: SanLoopStatus =
		report.verdict === "pass"
			? "passed"
			: report.verdict === "blocked" || report.verdict === "out_of_scope"
				? "blocked"
				: !retryableNeedsFix || retryExhausted
					? "failed"
					: "retrying";
	const retryCount = nextStatus === "retrying" ? run.retryCount + 1 : run.retryCount;
	return {
		run: {
			...run,
			updatedAt: createdAt,
			status: nextStatus,
			reviewReports: [...run.reviewReports, report],
			finalVerdict:
				nextStatus === "passed" || nextStatus === "failed" || nextStatus === "blocked"
					? report.verdict
					: run.finalVerdict,
			retryCount,
			budget: appendBudget(run, nextStatus, createdAt),
			decisions: appendDecision(run, {
				createdAt,
				actor: report.reviewer,
				decision: `Review verdict: ${report.verdict}`,
				rationale:
					report.defects.length > 0 ? `${report.defects.length} defect(s) reported.` : "No defects reported.",
				nextAction:
					nextStatus === "retrying"
						? "retry_worker"
						: nextStatus === "passed"
							? "finalize"
							: nextStatus === "failed"
								? "stop_failed"
								: "request_human_input",
			}),
		},
		eventType:
			nextStatus === "retrying"
				? "retry_requested"
				: nextStatus === "passed"
					? "finalized"
					: nextStatus === "failed"
						? "failed"
						: "review_completed",
		eventSummary: `${report.reviewer} review ${report.verdict}; next status ${nextStatus}.`,
		retryExhausted,
	};
}
