import * as fs from "node:fs/promises";

import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { runSubprocess, type YieldItem } from "../task/executor";
import type { AgentDefinition, SingleResult } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import type { SanLoopReviewInput, SanLoopWorkerResultInput } from "./orchestrator";
import type {
	SanLoopAgentExecutor,
	SanLoopCommanderInvocation,
	SanLoopCommanderResult,
	SanLoopSupervisorInvocation,
	SanLoopWorkerInvocation,
} from "./runner";
import type {
	SanLoopCommandEvidence,
	SanLoopDefect,
	SanLoopMode,
	SanLoopReviewReport,
	SanLoopReviewVerdict,
	SanLoopRunSnapshot,
	SanLoopTaskNode,
	SanLoopWorkerAssignment,
	SanLoopWorkerResult,
} from "./types";

interface TaskExecutorSession {
	sessionManager: SessionManager;
	settings: AgentSession["settings"];
	modelRegistry: AgentSession["modelRegistry"];
	sessionFile?: string;
	serviceTier?: AgentSession["serviceTier"];
	getEvalSessionId?: AgentSession["getEvalSessionId"];
	getAgentId?: AgentSession["getAgentId"];
	getHindsightSessionState?: AgentSession["getHindsightSessionState"];
	getMnemopiSessionState?: AgentSession["getMnemopiSessionState"];
}

export interface SanLoopTaskAgentExecutorOptions {
	session: TaskExecutorSession;
	cwd: string;
	eventBus?: EventBus;
	signal?: AbortSignal;
	parentToolCallId?: string;
}

interface CommanderYieldAssignment {
	objective?: unknown;
	instructions?: unknown;
	acceptanceCriteria?: unknown;
	checkRefs?: unknown;
}

interface CommanderYieldData {
	objective?: unknown;
	mode?: unknown;
	acceptanceCriteria?: unknown;
	assignments?: unknown;
	decision?: unknown;
	rationale?: unknown;
}

interface WorkerYieldCommand {
	command?: unknown;
	exitCode?: unknown;
	summary?: unknown;
}

interface WorkerYieldData {
	assignmentId?: unknown;
	status?: unknown;
	summary?: unknown;
	changedFiles?: unknown;
	commandsRun?: unknown;
	verification?: unknown;
	risks?: unknown;
}

interface SupervisorYieldDefect {
	severity?: unknown;
	title?: unknown;
	evidence?: unknown;
	retryable?: unknown;
	suggestedFix?: unknown;
}

interface SupervisorYieldData {
	verdict?: unknown;
	retryable?: unknown;
	confidence?: unknown;
	defects?: unknown;
	testsRun?: unknown;
	requiredNextActions?: unknown;
	evidence?: unknown;
}

interface OracleYieldData {
	opinion?: unknown;
	confidence?: unknown;
	evidence?: unknown;
	recommendation?: unknown;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(stringValue).filter((item): item is string => item !== undefined))];
}

function records(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
	);
}

function latestYieldData(result: SingleResult): unknown {
	const yieldItems = result.extractedToolData?.yield as YieldItem[] | undefined;
	if (Array.isArray(yieldItems) && yieldItems.length > 0) {
		return yieldItems.at(-1)?.data;
	}
	const trimmed = result.output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function taskNode(
	id: string,
	title: string,
	criteria: readonly string[],
	checkRefs: readonly string[],
): SanLoopTaskNode {
	return {
		id,
		title,
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: [...criteria],
		checkRefs: [...checkRefs],
	};
}

function sanitizeTaskId(value: string, index: number): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || `task-${index + 1}`;
}

function parseMode(value: unknown, fallback: SanLoopMode): SanLoopMode {
	return value === "rush" || value === "smart" || value === "deep" ? value : fallback;
}

function parseWorkerStatus(value: unknown): SanLoopWorkerResult["status"] {
	return value === "blocked" || value === "failed" || value === "completed" ? value : "failed";
}

function parseReviewVerdict(value: unknown): SanLoopReviewVerdict {
	return value === "pass" || value === "needs_fix" || value === "blocked" || value === "out_of_scope"
		? value
		: "blocked";
}

function parseConfidence(value: unknown): SanLoopReviewReport["confidence"] {
	return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function parseSeverity(value: unknown): SanLoopDefect["severity"] {
	return value === "low" || value === "medium" || value === "high" || value === "blocker" ? value : "medium";
}

function buildCommanderTask(invocation: SanLoopCommanderInvocation): string {
	const latestReview = invocation.latestReview
		? JSON.stringify(
				{
					verdict: invocation.latestReview.verdict,
					defects: invocation.latestReview.defects,
					requiredNextActions: invocation.latestReview.requiredNextActions,
				},
				null,
				2,
			)
		: "none";
	return [
		"Create the next San v0.2 execution plan for this run.",
		`Run ID: ${invocation.run.runId}`,
		`Mode: ${invocation.mode}`,
		`Objective: ${invocation.run.objective}`,
		`Current status: ${invocation.run.status}`,
		`Retry count: ${invocation.run.retryCount}/${invocation.run.maxRetries}`,
		`Latest review: ${latestReview}`,
		"Return bounded worker assignments. Do not implement directly.",
	].join("\n");
}

function buildWorkerTask(invocation: SanLoopWorkerInvocation): string {
	const assignment = invocation.assignment;
	return [
		"Execute this San v0.2 worker assignment.",
		`Run ID: ${invocation.run.runId}`,
		`Mode: ${invocation.mode}`,
		`Assignment ID: ${assignment.assignmentId}`,
		`Objective: ${assignment.objective}`,
		`Instructions: ${assignment.instructions}`,
		`Acceptance criteria:\n${assignment.acceptanceCriteria.map(item => `- ${item}`).join("\n") || "- none"}`,
		`Checks:\n${assignment.checkRefs.map(item => `- ${item}`).join("\n") || "- none"}`,
		"Make the required code/doc changes, run focused verification, and yield structured evidence.",
	].join("\n");
}

function buildSupervisorTask(invocation: SanLoopSupervisorInvocation): string {
	return [
		"Review this San v0.2 execution-loop batch as a quality gate.",
		`Run ID: ${invocation.run.runId}`,
		`Mode: ${invocation.mode}`,
		`Objective: ${invocation.run.objective}`,
		`Assignments:\n${JSON.stringify(invocation.assignments, null, 2)}`,
		`Worker results:\n${JSON.stringify(invocation.workerResults, null, 2)}`,
		`Oracle review:\n${invocation.oracleReview ? JSON.stringify(invocation.oracleReview, null, 2) : "none"}`,
		"Run relevant read-only validation if useful. Yield pass only when the acceptance criteria and checks are satisfied.",
	].join("\n");
}

function buildOracleTask(invocation: SanLoopSupervisorInvocation): string {
	return [
		"Give a second opinion for this San v0.2 deep execution-loop gate.",
		`Run ID: ${invocation.run.runId}`,
		`Mode: ${invocation.mode}`,
		`Objective: ${invocation.run.objective}`,
		`Assignments:\n${JSON.stringify(invocation.assignments, null, 2)}`,
		`Worker results:\n${JSON.stringify(invocation.workerResults, null, 2)}`,
		"Read the evidence, state uncertainty, and yield opinion/confidence/evidence/recommendation.",
	].join("\n");
}

function parseCommanderResult(run: SanLoopRunSnapshot, mode: SanLoopMode, data: unknown): SanLoopCommanderResult {
	const record = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as CommanderYieldData) : {};
	const criteria = stringArray(record.acceptanceCriteria);
	const rationale = stringValue(record.rationale);
	const rawAssignments = records(record.assignments) as CommanderYieldAssignment[];
	const assignments = rawAssignments.map((assignment, index) => {
		const objective = stringValue(assignment.objective) ?? `Assignment ${index + 1}`;
		const checks = stringArray(assignment.checkRefs);
		return {
			assignmentId: `${run.runId}_${sanitizeTaskId(objective, index)}`,
			objective,
			taskNodeIds: [sanitizeTaskId(objective, index)],
			instructions: stringValue(assignment.instructions) ?? objective,
			acceptanceCriteria: stringArray(assignment.acceptanceCriteria),
			checkRefs: checks,
			contextRefs: run.contextPacketRefs,
		};
	});
	const taskGraph = assignments.map((assignment, _index) =>
		taskNode(assignment.taskNodeIds[0]!, assignment.objective, assignment.acceptanceCriteria, assignment.checkRefs),
	);
	return {
		plan: {
			objective: stringValue(record.objective) ?? run.objective,
			acceptanceCriteria: criteria,
			taskGraph,
			checkPlan: [...new Set(assignments.flatMap(assignment => assignment.checkRefs))],
			riskRegister: rationale ? [rationale] : [],
			constraints: [`mode=${parseMode(record.mode, mode)}`],
		},
		assignments,
	};
}

function parseCommandEvidence(value: unknown): SanLoopCommandEvidence[] {
	return records(value).map((item): SanLoopCommandEvidence => {
		const commandRecord = item as WorkerYieldCommand;
		const command = stringValue(commandRecord.command) ?? "unknown";
		const exitCode = typeof commandRecord.exitCode === "number" ? commandRecord.exitCode : undefined;
		return {
			command,
			exitCode,
			summary: stringValue(commandRecord.summary) ?? command,
		};
	});
}

function parseWorkerResult(assignment: SanLoopWorkerAssignment, data: unknown): SanLoopWorkerResultInput {
	const record = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as WorkerYieldData) : {};
	return {
		assignmentId: stringValue(record.assignmentId) ?? assignment.assignmentId,
		status: parseWorkerStatus(record.status),
		summary: stringValue(record.summary) ?? "Worker did not provide a summary.",
		changedFiles: stringArray(record.changedFiles),
		commandsRun: parseCommandEvidence(record.commandsRun),
		verification: stringArray(record.verification),
		risks: stringArray(record.risks),
	};
}

function parseDefects(value: unknown): SanLoopDefect[] {
	return records(value).map((item, index): SanLoopDefect => {
		const defect = item as SupervisorYieldDefect;
		return {
			defectId: `defect-${index + 1}`,
			severity: parseSeverity(defect.severity),
			title: stringValue(defect.title) ?? `Defect ${index + 1}`,
			evidence: stringArray(defect.evidence),
			retryable: typeof defect.retryable === "boolean" ? defect.retryable : true,
			suggestedFix: stringValue(defect.suggestedFix),
		};
	});
}

function parseSupervisorResult(data: unknown): SanLoopReviewInput {
	const record =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as SupervisorYieldData) : {};
	const verdict = parseReviewVerdict(record.verdict);
	return {
		reviewer: "supervisor" as const,
		verdict,
		defects: parseDefects(record.defects),
		testsRun: stringArray(record.testsRun),
		evidence: stringArray(record.evidence),
		retryable: typeof record.retryable === "boolean" ? record.retryable : verdict === "needs_fix",
		requiredNextActions: stringArray(record.requiredNextActions),
		confidence: parseConfidence(record.confidence),
	};
}

function parseOracleResult(data: unknown): SanLoopReviewInput {
	const record = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as OracleYieldData) : {};
	const recommendation =
		stringValue(record.recommendation) ?? stringValue(record.opinion) ?? "Oracle did not recommend a path.";
	return {
		reviewer: "oracle",
		verdict: "pass",
		defects: [],
		testsRun: [],
		evidence: stringArray(record.evidence),
		retryable: false,
		requiredNextActions: [recommendation],
		confidence: parseConfidence(record.confidence),
	};
}

function resultFailureSummary(result: SingleResult): string {
	return result.stderr.trim() || result.error || result.output.trim() || "Subagent did not yield a usable result.";
}

function safeArtifactId(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "san-loop-agent"
	);
}

export function createSanLoopTaskAgentExecutor(options: SanLoopTaskAgentExecutorOptions): SanLoopAgentExecutor {
	const getAgent = (name: string): AgentDefinition => {
		const agent = getBundledAgent(name);
		if (!agent) throw new Error(`Bundled San agent not found: ${name}`);
		return agent;
	};
	const runAgent = async (agentName: string, task: string, index: number, id: string): Promise<SingleResult> => {
		const artifactsDir = options.session.sessionManager.getArtifactsDir() ?? undefined;
		if (artifactsDir) await fs.mkdir(artifactsDir, { recursive: true });
		return runSubprocess({
			cwd: options.cwd,
			agent: getAgent(agentName),
			task,
			index,
			id: safeArtifactId(id),
			settings: options.session.settings,
			modelRegistry: options.session.modelRegistry,
			authStorage: options.session.modelRegistry.authStorage,
			sessionFile: options.session.sessionFile,
			artifactsDir,
			eventBus: options.eventBus,
			signal: options.signal,
			parentToolCallId: options.parentToolCallId,
			parentActiveModelPattern: undefined,
			parentServiceTier: options.session.serviceTier ?? null,
			parentHindsightSessionState: options.session.getHindsightSessionState?.(),
			parentMnemopiSessionState: options.session.getMnemopiSessionState?.(),
			parentEvalSessionId: options.session.getEvalSessionId?.() ?? undefined,
			parentAgentId: options.session.getAgentId?.() ?? "Main",
			keepAlive: false,
			enableLsp: true,
		});
	};

	return {
		async commander(invocation) {
			const result = await runAgent(
				"san-commander",
				buildCommanderTask(invocation),
				0,
				`${invocation.run.runId}_commander`,
			);
			const data = latestYieldData(result);
			if (result.exitCode !== 0 || data === undefined) {
				return {
					plan: {
						objective: invocation.run.objective,
						acceptanceCriteria: ["Commander must produce a structured plan"],
						taskGraph: [],
						riskRegister: [resultFailureSummary(result)],
					},
					assignments: [],
				};
			}
			return parseCommanderResult(invocation.run, invocation.mode, data);
		},
		async worker(invocation) {
			const result = await runAgent(
				"san-worker",
				buildWorkerTask(invocation),
				1,
				invocation.assignment.assignmentId,
			);
			const data = latestYieldData(result);
			if (result.exitCode !== 0 || data === undefined) {
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "failed",
					summary: resultFailureSummary(result),
					changedFiles: [],
					commandsRun: [],
					verification: [],
					risks: ["Worker failed before yielding structured evidence."],
				};
			}
			return parseWorkerResult(invocation.assignment, data);
		},
		async supervisor(invocation) {
			const result = await runAgent(
				"san-supervisor",
				buildSupervisorTask(invocation),
				2,
				`${invocation.run.runId}_supervisor`,
			);
			const data = latestYieldData(result);
			if (result.exitCode !== 0 || data === undefined) {
				return {
					reviewer: "supervisor",
					verdict: "blocked",
					defects: [
						{
							defectId: "supervisor-failed",
							severity: "blocker",
							title: "Supervisor failed to produce a structured gate report",
							evidence: [resultFailureSummary(result)],
							retryable: false,
						},
					],
					evidence: [],
					testsRun: [],
					retryable: false,
					requiredNextActions: ["Inspect supervisor subagent output."],
					confidence: "low",
				};
			}
			return parseSupervisorResult(data);
		},
		async oracle(invocation) {
			const result = await runAgent("san-oracle", buildOracleTask(invocation), 3, `${invocation.run.runId}_oracle`);
			const data = latestYieldData(result);
			if (result.exitCode !== 0 || data === undefined) {
				return {
					reviewer: "oracle",
					verdict: "blocked",
					defects: [
						{
							defectId: "oracle-failed",
							severity: "medium",
							title: "Oracle failed to produce a structured second opinion",
							evidence: [resultFailureSummary(result)],
							retryable: false,
						},
					],
					evidence: [],
					testsRun: [],
					retryable: false,
					requiredNextActions: ["Inspect oracle subagent output."],
					confidence: "low",
				};
			}
			return parseOracleResult(data);
		},
	};
}
