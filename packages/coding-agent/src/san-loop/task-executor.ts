import * as fs from "node:fs/promises";

import { prompt } from "@san/utils";
import { extractMessages } from "../hindsight/transcript";
import commanderTaskTemplate from "../prompts/san-loop/commander-task.md" with { type: "text" };
import oracleTaskTemplate from "../prompts/san-loop/oracle-task.md" with { type: "text" };
import supervisorTaskTemplate from "../prompts/san-loop/supervisor-task.md" with { type: "text" };
import workerTaskTemplate from "../prompts/san-loop/worker-task.md" with { type: "text" };

import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { runSubprocess, type YieldItem } from "../task/executor";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { AgentDefinition, SingleResult } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { renderSanLoopChecks } from "./checks";
import { buildSanLoopRoleContext } from "./context";
import type { SanLoopReviewInput, SanLoopWorkerResultInput } from "./orchestrator";
import type {
	SanLoopAgentExecutor,
	SanLoopCommanderInvocation,
	SanLoopCommanderResult,
	SanLoopExecutorUsage,
	SanLoopRoleBudget,
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
import { normalizeSanLoopMode } from "./types";

interface TaskExecutorSession {
	sessionManager: SessionManager;
	settings: AgentSession["settings"];
	modelRegistry: AgentSession["modelRegistry"];
	sessionFile?: string;
	serviceTierByFamily?: AgentSession["serviceTierByFamily"];
	getEvalSessionId?: AgentSession["getEvalSessionId"];
	getAgentId?: AgentSession["getAgentId"];
	getHindsightSessionState?: AgentSession["getHindsightSessionState"];
	getMnemopiSessionState?: AgentSession["getMnemopiSessionState"];
}

type SanLoopRoleName = "commander" | "worker" | "supervisor" | "oracle";

const SAN_LOOP_ROLE_TOOLS: Record<SanLoopRoleName, readonly string[]> = {
	commander: ["read", "grep", "glob", "yield"],
	worker: ["read", "grep", "glob", "write", "edit", "bash", "yield"],
	supervisor: ["read", "grep", "glob", "yield"],
	oracle: ["read", "grep", "glob", "yield"],
};

// Host-owned bash receipts for San worker evidence. Registered once so
// subprocess tool_execution_end events populate extractedToolData.bash.
subprocessToolRegistry.register<{ command: string; exitCode?: number; summary: string }>("bash", {
	extractData: event => {
		const args = event.args;
		const command =
			args && typeof args === "object" && "command" in args && typeof args.command === "string"
				? args.command.trim()
				: "";
		if (!command) return undefined;
		const details = event.result?.details;
		const exitCode =
			details && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number"
				? details.exitCode
				: event.isError
					? 1
					: 0;
		return {
			command,
			exitCode,
			summary: event.isError ? `host bash error exit ${exitCode}` : `host bash exit ${exitCode}`,
		};
	},
});

export interface SanLoopTaskAgentExecutorOptions {
	session: TaskExecutorSession;
	cwd: string;
	eventBus?: EventBus;
	signal?: AbortSignal;
	parentToolCallId?: string;
	/** Remaining-aware hard budgets enforced on each role subprocess. */
	hardBudget?: {
		maxTokens?: number;
		maxCost?: number;
		maxDurationMs?: number;
		/** Remaining provider-request slots for this role call (hard abort). */
		maxProviderRequests?: number;
	};
}

interface CommanderYieldAssignment {
	agent?: unknown;
	id?: unknown;
	assignmentId?: unknown;
	assignment_id?: unknown;
	title?: unknown;
	description?: unknown;
	objective?: unknown;
	role?: unknown;
	assignment?: unknown;
	instructions?: unknown;
	target?: unknown;
	change?: unknown;
	acceptance?: unknown;
	acceptanceCriteria?: unknown;
	acceptance_criteria?: unknown;
	checkRefs?: unknown;
	check_refs?: unknown;
	taskNodeIds?: unknown;
	task_node_ids?: unknown;
}

interface CommanderYieldData {
	objective?: unknown;
	mode?: unknown;
	acceptanceCriteria?: unknown;
	acceptance_criteria?: unknown;
	assignments?: unknown;
	workers?: unknown;
	workerAssignments?: unknown;
	worker_assignments?: unknown;
	tasks?: unknown;
	stages?: unknown;
	phases?: unknown;
	decision?: unknown;
	rationale?: unknown;
	plan_summary?: unknown;
	riskRegister?: unknown;
	risk_register?: unknown;
}

interface WorkerYieldCommand {
	command?: unknown;
	exitCode?: unknown;
	exit_code?: unknown;
	summary?: unknown;
}

interface WorkerYieldData {
	assignmentId?: unknown;
	assignment_id?: unknown;
	status?: unknown;
	summary?: unknown;
	report?: unknown;
	message?: unknown;
	changedFiles?: unknown;
	changed_files?: unknown;
	commandsRun?: unknown;
	commands_run?: unknown;
	verification?: unknown;
	testsRun?: unknown;
	tests_run?: unknown;
	risks?: unknown;
	directory?: unknown;
	workspace?: unknown;
	scope?: unknown;
	verificationMethod?: unknown;
	verification_method?: unknown;
	mutationsPerformed?: unknown;
	mutations_performed?: unknown;
	noCreationOrModification?: unknown;
	no_creation_or_modification?: unknown;
	notes?: unknown;
	fileCount?: unknown;
	file_count?: unknown;
	method?: unknown;
	modificationsAttempted?: unknown;
	modifications_attempted?: unknown;
	scopeAmbiguity?: unknown;
	scope_ambiguity?: unknown;
}

interface SupervisorYieldDefect {
	severity?: unknown;
	title?: unknown;
	evidence?: unknown;
	retryable?: unknown;
	suggestedFix?: unknown;
	suggested_fix?: unknown;
}

interface SupervisorYieldData {
	verdict?: unknown;
	status?: unknown;
	gate?: unknown;
	outcome?: unknown;
	decision?: unknown;
	error?: unknown;
	retryable?: unknown;
	confidence?: unknown;
	defects?: unknown;
	testsRun?: unknown;
	tests_run?: unknown;
	requiredNextActions?: unknown;
	required_next_actions?: unknown;
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

function recordValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (key in record) return record[key];
	}
	return undefined;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	return stringValue(recordValue(record, keys));
}

function stringArrayField(record: Record<string, unknown>, keys: readonly string[]): string[] {
	return stringArray(recordValue(record, keys));
}

function booleanField(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
	const value = recordValue(record, keys);
	return typeof value === "boolean" ? value : undefined;
}

function scalarString(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return undefined;
}

function scalarStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	return scalarString(recordValue(record, keys));
}

function recordsField(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown>[] {
	return records(recordValue(record, keys));
}

function isCommanderWorkerAssignment(record: Record<string, unknown>): boolean {
	const agent = stringField(record, ["agent"])?.toLowerCase();
	if (agent) return agent === "san-worker" || agent === "worker";
	const role = stringField(record, ["role"])?.toLowerCase();
	if (!role) return true;
	return !/\b(supervisor|oracle|commander)\b/.test(role);
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

function hasYieldData(result: SingleResult): boolean {
	const yieldItems = result.extractedToolData?.yield as YieldItem[] | undefined;
	return Array.isArray(yieldItems) && yieldItems.length > 0;
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
	return normalizeSanLoopMode(value) ?? fallback;
}

function structuredAssignmentText(value: unknown): string | undefined {
	if (typeof value === "string") return stringValue(value);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const sections: [string, string | undefined][] = [
		["Target", stringValue(record.target)],
		["Change", stringArray(record.change).join("\n")],
		["Acceptance", stringArray(record.acceptance).join("\n")],
	];
	const text = sections
		.filter((section): section is [string, string] => section[1] !== undefined && section[1].length > 0)
		.map(([label, content]) => `${label}:\n${content}`)
		.join("\n\n");
	return text || compactEvidenceValue(value);
}

function commanderAssignmentInstructions(record: Record<string, unknown>, fallback: string): string {
	return (
		stringField(record, ["instructions"]) ??
		structuredAssignmentText(record.assignment) ??
		structuredAssignmentText({
			target: record.target,
			change: record.change,
			acceptance: record.acceptance,
		}) ??
		fallback
	);
}

function parseWorkerStatusWithFallback(
	value: unknown,
	fallback: SanLoopWorkerResult["status"],
): SanLoopWorkerResult["status"] {
	const normalized =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[\s-]+/g, "_")
			: "";
	return normalized === "blocked" || normalized === "failed" || normalized === "completed" ? normalized : fallback;
}

function parseReviewVerdict(value: unknown): SanLoopReviewVerdict {
	const normalized =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[\s-]+/g, "_")
			: "";
	if (normalized === "pass" || normalized === "passed" || normalized === "pass_with_warnings") return "pass";
	if (normalized === "needs_fix" || normalized === "fail" || normalized === "failed") return "needs_fix";
	if (normalized === "blocked" || normalized === "block") return "blocked";
	if (normalized === "out_of_scope" || normalized === "out_of_scope_error") return "out_of_scope";
	return "blocked";
}

function parseSupervisorErrorVerdict(value: unknown): SanLoopReviewVerdict | undefined {
	const text = stringValue(value);
	if (!text) return undefined;
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (/^needs_fix\b/.test(normalized)) return "needs_fix";
	if (/^pass(ed)?\b/.test(normalized)) return "pass";
	if (/^block(ed)?\b/.test(normalized)) return "blocked";
	if (/^out_of_scope\b/.test(normalized)) return "out_of_scope";
	return undefined;
}

function parseSupervisorVerdict(
	record: Record<string, unknown>,
	typedRecord: SupervisorYieldData,
): SanLoopReviewVerdict {
	const explicit = recordValue(record, ["verdict", "status", "gate", "outcome", "decision"]);
	if (explicit !== undefined) return parseReviewVerdict(explicit);
	return parseSupervisorErrorVerdict(typedRecord.error) ?? "blocked";
}

const COMMANDER_ASSIGNMENT_COLLECTION_KEYS = [
	"assignments",
	"workers",
	"workerAssignments",
	"worker_assignments",
	"tasks",
	"stages",
	"waves",
	"dispatch_sequence",
	"dispatchSequence",
	"worker_batch",
	"workerBatch",
	"worker_batches",
	"workerBatches",
	"sequence",
	"steps",
] as const;

const COMMANDER_ASSIGNMENT_CONTAINER_KEYS = [
	"dispatch",
	"plan",
	"commander_plan",
	"commanderPlan",
	"worker_batch",
	"workerBatch",
	"worker_batches",
	"workerBatches",
	"dispatch_rounds",
	"dispatchRounds",
	"phases",
	"supervisor_after_worker",
	"supervisorAfterWorker",
	"next_after_workers",
	"nextAfterWorkers",
] as const;

function nestedRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function commanderAssignmentRecordsFromContainer(
	record: Record<string, unknown>,
	inheritedAgent: string | undefined,
): CommanderYieldAssignment[] {
	const ownAgent = stringField(record, ["agent"]) ?? inheritedAgent;
	const directAssignments = COMMANDER_ASSIGNMENT_COLLECTION_KEYS.flatMap(key =>
		recordsField(record, [key]).map(task => ({
			...task,
			agent: stringField(task, ["agent"]) ?? ownAgent,
		})),
	);
	const nestedAssignments = COMMANDER_ASSIGNMENT_CONTAINER_KEYS.flatMap(key => {
		const recordValue = nestedRecordField(record, key);
		if (recordValue) return commanderAssignmentRecordsFromContainer(recordValue, ownAgent);
		return recordsField(record, [key]).flatMap(item => {
			const itemAgent = stringField(item, ["agent"]) ?? ownAgent;
			const nested = commanderAssignmentRecordsFromContainer(item, itemAgent);
			return nested.length > 0 ? nested : [{ ...item, agent: itemAgent }];
		});
	});
	return [...directAssignments, ...nestedAssignments] as CommanderYieldAssignment[];
}

function commanderAssignmentRecords(record: Record<string, unknown>): CommanderYieldAssignment[] {
	return commanderAssignmentRecordsFromContainer(record, undefined);
}

function parseConfidence(value: unknown): SanLoopReviewReport["confidence"] {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : "medium";
}

function parseSeverity(value: unknown): SanLoopDefect["severity"] {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "blocker"
		? normalized
		: "medium";
}

const DEFAULT_COMMANDER_CONTEXT_TOKEN_BUDGET = 2000;
const COMMANDER_CONTEXT_CHARS_PER_TOKEN = 4;
const MIN_COMMANDER_CONTEXT_CHARS = 512;

function renderCommanderConversationContext(sessionManager: SessionManager, tokenBudget: number): string {
	const messages = extractMessages({ getEntries: () => sessionManager.getBranch() });
	if (messages.length === 0) return "none";

	const normalizedTokenBudget = Number.isFinite(tokenBudget)
		? Math.max(1, Math.floor(tokenBudget))
		: DEFAULT_COMMANDER_CONTEXT_TOKEN_BUDGET;
	let remainingChars = Math.max(
		MIN_COMMANDER_CONTEXT_CHARS,
		normalizedTokenBudget * COMMANDER_CONTEXT_CHARS_PER_TOKEN,
	);
	const selected: string[] = [];
	for (let index = messages.length - 1; index >= 0 && remainingChars > 0; index -= 1) {
		const message = messages[index]!;
		const prefix = `${message.role === "user" ? "User" : "Assistant"}:\n`;
		const content = message.content.trim();
		const separatorLength = selected.length > 0 ? 2 : 0;
		const full = `${prefix}${content}`;
		if (full.length + separatorLength <= remainingChars) {
			selected.unshift(full);
			remainingChars -= full.length + separatorLength;
			continue;
		}

		const availableContentChars = remainingChars - prefix.length - separatorLength - 1;
		if (availableContentChars > 0) {
			selected.unshift(`${prefix}…${content.slice(-availableContentChars)}`);
		}
		break;
	}
	return selected.join("\n\n") || "none";
}

function buildCommanderTask(
	invocation: SanLoopCommanderInvocation,
	conversationContext: string,
	roleContext: string,
): string {
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
	return prompt.render(commanderTaskTemplate, {
		run_id: invocation.run.runId,
		mode: invocation.mode,
		current_status: invocation.run.status,
		retry_count: `${invocation.run.retryCount}/${invocation.run.maxRetries}`,
		latest_review: latestReview,
		conversation_context: conversationContext,
		objective: invocation.run.objective,
		role_context: roleContext,
		checks: renderSanLoopChecks(invocation.checks ?? []),
	});
}

function buildWorkerTask(invocation: SanLoopWorkerInvocation, roleContext: string): string {
	const assignment = invocation.assignment;
	return prompt.render(workerTaskTemplate, {
		run_id: invocation.run.runId,
		mode: invocation.mode,
		assignment_id: assignment.assignmentId,
		objective: assignment.objective,
		instructions: assignment.instructions,
		acceptance_criteria: assignment.acceptanceCriteria.map(item => `- ${item}`).join("\n") || "- none",
		check_refs: assignment.checkRefs.map(item => `- ${item}`).join("\n") || "- none",
		checks: renderSanLoopChecks(invocation.checks ?? []),
		role_context: roleContext,
	});
}

function buildSupervisorTask(invocation: SanLoopSupervisorInvocation, roleContext: string): string {
	return prompt.render(supervisorTaskTemplate, {
		run_id: invocation.run.runId,
		mode: invocation.mode,
		objective: invocation.run.objective,
		assignments: JSON.stringify(invocation.assignments, null, 2),
		worker_results: JSON.stringify(invocation.workerResults, null, 2),
		oracle_review: invocation.oracleReview ? JSON.stringify(invocation.oracleReview, null, 2) : "none",
		checks: renderSanLoopChecks(invocation.checks ?? []),
		role_context: roleContext,
	});
}

function buildOracleTask(invocation: SanLoopSupervisorInvocation, roleContext: string): string {
	return prompt.render(oracleTaskTemplate, {
		run_id: invocation.run.runId,
		mode: invocation.mode,
		objective: invocation.run.objective,
		assignments: JSON.stringify(invocation.assignments, null, 2),
		worker_results: JSON.stringify(invocation.workerResults, null, 2),
		checks: renderSanLoopChecks(invocation.checks ?? []),
		role_context: roleContext,
	});
}

function parseCommanderResult(run: SanLoopRunSnapshot, mode: SanLoopMode, data: unknown): SanLoopCommanderResult {
	const record =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const typedRecord = record as CommanderYieldData;
	const criteria = stringArrayField(record, ["acceptanceCriteria", "acceptance_criteria"]);
	const rationale =
		stringField(record, ["rationale", "plan_summary"]) ??
		stringArrayField(record, ["riskRegister", "risk_register"]).join("; ");
	const rawAssignments = commanderAssignmentRecords(record);
	const workerAssignments = rawAssignments.filter(assignment =>
		isCommanderWorkerAssignment(assignment as Record<string, unknown>),
	);
	const assignments = workerAssignments.map((assignment, index) => {
		const assignmentRecord = assignment as Record<string, unknown>;
		const objective =
			stringField(assignmentRecord, [
				"objective",
				"title",
				"description",
				"role",
				"id",
				"assignmentId",
				"assignment_id",
			]) ?? `Assignment ${index + 1}`;
		const checks = stringArrayField(assignmentRecord, ["checkRefs", "check_refs"]);
		const assignmentId =
			stringField(assignmentRecord, ["assignmentId", "assignment_id", "id"]) ??
			`${run.runId}_${sanitizeTaskId(objective, index)}`;
		const taskNodeIds = stringArrayField(assignmentRecord, ["taskNodeIds", "task_node_ids"]);
		const taskId = taskNodeIds[0] ?? sanitizeTaskId(objective, index);
		const assignmentCriteria = [
			...stringArrayField(assignmentRecord, ["acceptanceCriteria", "acceptance_criteria"]),
			...stringArrayField(assignmentRecord, ["acceptance"]),
		];
		return {
			assignmentId,
			objective,
			taskNodeIds: taskNodeIds.length > 0 ? taskNodeIds : [taskId],
			instructions: commanderAssignmentInstructions(assignmentRecord, objective),
			acceptanceCriteria: assignmentCriteria.length > 0 ? assignmentCriteria : criteria,
			checkRefs: checks,
			contextRefs:
				run.contextPlanRefs && run.contextPlanRefs.length > 0 ? run.contextPlanRefs : run.contextPacketRefs,
		};
	});
	const taskGraph = assignments.map((assignment, _index) =>
		taskNode(assignment.taskNodeIds[0]!, assignment.objective, assignment.acceptanceCriteria, assignment.checkRefs),
	);
	return {
		plan: {
			objective: stringValue(typedRecord.objective) ?? run.objective,
			acceptanceCriteria: criteria,
			taskGraph,
			checkPlan: [...new Set(assignments.flatMap(assignment => assignment.checkRefs))],
			riskRegister: rationale ? [rationale] : [],
			constraints: [`mode=${parseMode(typedRecord.mode, mode)}`],
		},
		assignments,
	};
}

function parseCommandEvidence(value: unknown, source: "host" | "model" = "model"): SanLoopCommandEvidence[] {
	return records(value).map((item): SanLoopCommandEvidence => {
		const commandRecord = item as WorkerYieldCommand;
		const command = stringValue(commandRecord.command) ?? "unknown";
		const exitCode =
			typeof commandRecord.exitCode === "number"
				? commandRecord.exitCode
				: typeof commandRecord.exit_code === "number"
					? commandRecord.exit_code
					: undefined;
		return {
			command,
			exitCode,
			summary: stringValue(commandRecord.summary) ?? command,
			source,
		};
	});
}

function extractHostBashReceipts(result: SingleResult): SanLoopCommandEvidence[] {
	const bashData = result.extractedToolData?.bash;
	if (!Array.isArray(bashData) || bashData.length === 0) return [];
	const receipts: SanLoopCommandEvidence[] = [];
	for (const item of bashData) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const command = "command" in item && typeof item.command === "string" ? item.command.trim() : "";
		if (!command) continue;
		const exitCode = "exitCode" in item && typeof item.exitCode === "number" ? item.exitCode : undefined;
		const summaryText =
			"summary" in item && typeof item.summary === "string" && item.summary.trim().length > 0
				? item.summary.trim()
				: undefined;
		const summary = summaryText ?? (exitCode === undefined ? "host bash receipt" : `host bash exit ${exitCode}`);
		receipts.push({ command, exitCode, summary, source: "host" });
	}
	return receipts;
}

function compactEvidenceValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
	if (!text) return undefined;
	return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

function workerEvidenceSummary(record: Record<string, unknown>): string | undefined {
	const explicit = stringField(record, ["summary", "report", "message"]);
	if (explicit) return explicit;
	const evidenceKeys = [
		"checked_path",
		"checkedPath",
		"finding",
		"issue",
		"bug_found",
		"bugFound",
		"bug_summary",
		"bugSummary",
		"candidate_boundary",
		"candidateBoundary",
		"observable_contract",
		"observableContract",
		"failure_scenario",
		"failureScenario",
		"expected_failure_reason",
		"expectedFailureReason",
		"recommended_status",
		"recommendedStatus",
		"scope_inspected",
		"scopeInspected",
		"writes_made",
		"writesMade",
		"sections",
		"evidence_table",
		"evidenceTable",
		"files_inspected",
		"filesInspected",
		"san_loop_locations",
		"sanLoopLocations",
		"package_metadata_evidence",
		"packageMetadataEvidence",
	] as const;
	const facts = [
		...evidenceKeys
			.map(key => {
				const value = compactEvidenceValue(record[key]);
				return value ? `${key}=${value}` : undefined;
			})
			.filter((item): item is string => item !== undefined),
		stringField(record, ["directory", "workspace", "inspectedDirectory", "inspected_directory"])
			? `directory=${stringField(record, ["directory", "workspace", "inspectedDirectory", "inspected_directory"])}`
			: undefined,
		scalarStringField(record, ["fileCount", "file_count"])
			? `file_count=${scalarStringField(record, ["fileCount", "file_count"])}`
			: undefined,
		stringField(record, ["scope"]) ? `scope=${stringField(record, ["scope"])}` : undefined,
		stringField(record, ["method", "countingMethod", "counting_method", "verificationMethod", "verification_method"]),
		scalarStringField(record, ["modificationsAttempted", "modifications_attempted"])
			? `modifications_attempted=${scalarStringField(record, ["modificationsAttempted", "modifications_attempted"])}`
			: undefined,
		scalarStringField(record, ["mutationsPerformed", "mutations_performed"])
			? `mutations_performed=${scalarStringField(record, ["mutationsPerformed", "mutations_performed"])}`
			: undefined,
		scalarStringField(record, ["noCreationOrModification", "no_creation_or_modification"])
			? `no_creation_or_modification=${scalarStringField(record, [
					"noCreationOrModification",
					"no_creation_or_modification",
				])}`
			: undefined,
		stringField(record, ["scopeAmbiguity", "scope_ambiguity"]),
		stringField(record, ["notes"]),
	].filter((item): item is string => item !== undefined);
	if (facts.length > 0) return facts.join("; ");
	return compactEvidenceValue(record);
}

function workerVerification(record: Record<string, unknown>): string[] {
	const explicit = [
		...stringArrayField(record, ["verification"]),
		...stringArrayField(record, ["testsRun", "tests_run"]),
		...stringArrayField(record, ["methods_used", "methodsUsed"]),
		...stringArrayField(record, ["read_only_evidence", "readOnlyEvidence"]),
		...stringArrayField(record, ["evidence"]),
		...stringArrayField(record, ["files_inspected", "filesInspected"]),
		...stringArrayField(record, ["san_loop_locations", "sanLoopLocations"]),
	];
	const facts = [
		stringField(record, ["checked_path", "checkedPath"])
			? `checked_path=${stringField(record, ["checked_path", "checkedPath"])}`
			: undefined,
		stringField(record, ["scope_inspected", "scopeInspected"])
			? `scope_inspected=${stringField(record, ["scope_inspected", "scopeInspected"])}`
			: undefined,
		scalarStringField(record, ["writes_made", "writesMade"])
			? `writes_made=${scalarStringField(record, ["writes_made", "writesMade"])}`
			: undefined,
		stringField(record, ["directory", "workspace", "inspectedDirectory", "inspected_directory"])
			? `directory=${stringField(record, ["directory", "workspace", "inspectedDirectory", "inspected_directory"])}`
			: undefined,
		scalarStringField(record, ["fileCount", "file_count"])
			? `file_count=${scalarStringField(record, ["fileCount", "file_count"])}`
			: undefined,
		stringField(record, ["scope"]) ? `scope=${stringField(record, ["scope"])}` : undefined,
		stringField(record, ["method", "countingMethod", "counting_method", "verificationMethod", "verification_method"])
			? `method=${stringField(record, [
					"method",
					"countingMethod",
					"counting_method",
					"verificationMethod",
					"verification_method",
				])}`
			: undefined,
		scalarStringField(record, ["modificationsAttempted", "modifications_attempted"])
			? `modifications_attempted=${scalarStringField(record, ["modificationsAttempted", "modifications_attempted"])}`
			: undefined,
		scalarStringField(record, ["mutationsPerformed", "mutations_performed"])
			? `mutations_performed=${scalarStringField(record, ["mutationsPerformed", "mutations_performed"])}`
			: undefined,
		scalarStringField(record, ["noCreationOrModification", "no_creation_or_modification"])
			? `no_creation_or_modification=${scalarStringField(record, [
					"noCreationOrModification",
					"no_creation_or_modification",
				])}`
			: undefined,
		stringField(record, ["scopeAmbiguity", "scope_ambiguity"])
			? `scope_ambiguity=${stringField(record, ["scopeAmbiguity", "scope_ambiguity"])}`
			: undefined,
		stringField(record, ["notes"]) ? `notes=${stringField(record, ["notes"])}` : undefined,
	].filter((item): item is string => item !== undefined);
	return [...new Set([...explicit, ...facts])];
}

function parseWorkerResult(
	assignment: SanLoopWorkerAssignment,
	data: unknown,
	hostReceipts: readonly SanLoopCommandEvidence[] = [],
): SanLoopWorkerResultInput {
	const record =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const typedRecord = record as WorkerYieldData;
	const summary = workerEvidenceSummary(record);
	const verification = workerVerification(record);
	const risks = stringArrayField(record, ["risks"]);
	if (
		booleanField(record, ["modificationsAttempted", "modifications_attempted"]) === true ||
		booleanField(record, ["mutationsPerformed", "mutations_performed"]) === true ||
		booleanField(record, ["noCreationOrModification", "no_creation_or_modification"]) === false
	) {
		risks.push("Worker reported that modifications were attempted.");
	}
	// Model-claimed commands are retained only as untrusted audit noise. The
	// pass gate exclusively trusts host receipts extracted from bash tool ends.
	const modelClaims = parseCommandEvidence(recordValue(record, ["commandsRun", "commands_run"]), "model");
	if (modelClaims.length > 0 && hostReceipts.length === 0) {
		risks.push("Worker claimed commandsRun without host bash receipts; claims ignored by pass gate.");
	}
	return {
		assignmentId: stringField(record, ["assignmentId", "assignment_id"]) ?? assignment.assignmentId,
		status: parseWorkerStatusWithFallback(
			typedRecord.status,
			summary || verification.length > 0 || hostReceipts.length > 0 ? "completed" : "failed",
		),
		summary: summary ?? "Worker did not provide a summary.",
		changedFiles: stringArrayField(record, ["changedFiles", "changed_files"]),
		commandsRun: hostReceipts.length > 0 ? [...hostReceipts] : modelClaims,
		verification,
		risks,
	};
}

function parseDefects(value: unknown): SanLoopDefect[] {
	return records(value).map((item, index): SanLoopDefect => {
		const defect = item as SupervisorYieldDefect;
		const defectRecord = item as Record<string, unknown>;
		return {
			defectId: `defect-${index + 1}`,
			severity: parseSeverity(defect.severity),
			title: stringValue(defect.title) ?? `Defect ${index + 1}`,
			evidence: stringArray(defect.evidence),
			retryable: typeof defect.retryable === "boolean" ? defect.retryable : true,
			suggestedFix: stringField(defectRecord, ["suggestedFix", "suggested_fix"]),
		};
	});
}

function parseSupervisorResult(data: unknown): SanLoopReviewInput {
	const record =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const typedRecord = record as SupervisorYieldData;
	const verdict = parseSupervisorVerdict(record, typedRecord);
	const error = stringValue(typedRecord.error);
	return {
		reviewer: "supervisor" as const,
		verdict,
		defects: parseDefects(typedRecord.defects),
		testsRun: stringArrayField(record, ["testsRun", "tests_run"]),
		evidence: stringArray(typedRecord.evidence),
		retryable: typeof typedRecord.retryable === "boolean" ? typedRecord.retryable : verdict === "needs_fix",
		requiredNextActions: [
			...stringArrayField(record, ["requiredNextActions", "required_next_actions"]),
			...(error ? [error] : []),
		],
		confidence: parseConfidence(typedRecord.confidence),
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

const TRANSIENT_SUBAGENT_FAILURE_PATTERNS = [
	/stream closed before a terminal response/i,
	/unable to connect/i,
	/service[_ -]?unavailable/i,
	/\b503\b/i,
	/全部渠道不可提供当前模型/,
];

function shouldRetryTransientSubagentFailure(role: SanLoopRoleName, result: SingleResult): boolean {
	if (role === "worker" || result.exitCode === 0 || hasYieldData(result)) return false;
	const summary = resultFailureSummary(result);
	return TRANSIENT_SUBAGENT_FAILURE_PATTERNS.some(pattern => pattern.test(summary));
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

function normalizeRoleModelOverride(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("@") || trimmed.includes("/") || trimmed.includes(",")) return trimmed;
	return `@${trimmed}`;
}

export function createSanLoopTaskAgentExecutor(options: SanLoopTaskAgentExecutorOptions): SanLoopAgentExecutor {
	const accumulatedUsage: SanLoopExecutorUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: 0,
		durationMs: 0,
		providerRequests: 0,
	};
	const startedAtMs = Date.now();
	const recordUsage = (result: SingleResult): SingleResult => {
		accumulatedUsage.inputTokens += result.usage?.input ?? 0;
		accumulatedUsage.outputTokens += result.usage?.output ?? 0;
		accumulatedUsage.cacheReadTokens += result.usage?.cacheRead ?? 0;
		accumulatedUsage.cacheWriteTokens += result.usage?.cacheWrite ?? 0;
		accumulatedUsage.totalTokens += result.usage?.totalTokens ?? result.tokens;
		accumulatedUsage.cost += result.usage?.cost.total ?? 0;
		accumulatedUsage.durationMs += result.durationMs;
		accumulatedUsage.providerRequests += result.requests;
		return result;
	};
	const getAgent = (name: string): AgentDefinition => {
		const agent = getBundledAgent(name);
		if (!agent) throw new Error(`Bundled San agent not found: ${name}`);
		return agent;
	};
	const modelOverrideForRole = (role: SanLoopRoleName): string | undefined =>
		normalizeRoleModelOverride(options.session.settings.get(`san.executionLoop.roles.${role}.modelRole`));
	const commanderContextTokenBudget = options.session.settings.get("san.executionLoop.roleContext.tokenBudget");
	const roleContextSettings = {
		tokenBudget: commanderContextTokenBudget,
		maxEvents: options.session.settings.get("san.executionLoop.roleContext.maxEvents"),
		maxDecisions: options.session.settings.get("san.executionLoop.roleContext.maxDecisions"),
	};
	const commanderConversationContext = (): string =>
		renderCommanderConversationContext(options.session.sessionManager, commanderContextTokenBudget);
	const roleContext = (role: SanLoopRoleName, runId: string, assignmentId?: string): string =>
		buildSanLoopRoleContext(options.session.sessionManager.getBranch(), {
			role,
			runId,
			assignmentId,
			settings: roleContextSettings,
		})?.content ?? "none";
	const remainingHardTokenLimit = (): number | undefined => {
		const maxTokens = options.hardBudget?.maxTokens;
		if (typeof maxTokens !== "number" || maxTokens <= 0) return undefined;
		return Math.max(0, Math.trunc(maxTokens - accumulatedUsage.totalTokens));
	};
	const remainingHardCostLimit = (): number | undefined => {
		const maxCost = options.hardBudget?.maxCost;
		if (typeof maxCost !== "number" || maxCost <= 0) return undefined;
		return Math.max(0, maxCost - accumulatedUsage.cost);
	};
	const remainingMaxRuntimeMs = (): number | undefined => {
		const maxDurationMs = options.hardBudget?.maxDurationMs;
		if (typeof maxDurationMs !== "number" || maxDurationMs <= 0) return undefined;
		return Math.max(0, Math.trunc(maxDurationMs - (Date.now() - startedAtMs)));
	};
	const remainingHardRequestLimit = (): number | undefined => {
		const maxProviderRequests = options.hardBudget?.maxProviderRequests;
		if (typeof maxProviderRequests !== "number" || maxProviderRequests <= 0) return undefined;
		return Math.max(0, Math.trunc(maxProviderRequests - accumulatedUsage.providerRequests));
	};
	const minimumDefined = (...values: Array<number | undefined>): number | undefined => {
		const defined = values.filter((value): value is number => value !== undefined);
		return defined.length > 0 ? Math.min(...defined) : undefined;
	};
	const runAgent = async (
		agentName: string,
		role: SanLoopRoleName,
		task: string,
		index: number,
		id: string,
		signal?: AbortSignal,
		budget?: SanLoopRoleBudget,
	): Promise<SingleResult> => {
		const artifactsDir = options.session.sessionManager.getArtifactsDir() ?? undefined;
		if (artifactsDir) await fs.mkdir(artifactsDir, { recursive: true });
		const combinedSignal =
			options.signal && signal ? AbortSignal.any([options.signal, signal]) : (options.signal ?? signal);
		const usageAtStart = { ...accumulatedUsage };
		const roleTokenUsage = () => accumulatedUsage.totalTokens - usageAtStart.totalTokens;
		const roleCostUsage = () => accumulatedUsage.cost - usageAtStart.cost;
		const roleRequestUsage = () => accumulatedUsage.providerRequests - usageAtStart.providerRequests;
		const runOnce = async (): Promise<SingleResult> => {
			const hardTokenLimit = minimumDefined(
				remainingHardTokenLimit(),
				budget?.maxTokens === undefined ? undefined : Math.max(0, Math.trunc(budget.maxTokens - roleTokenUsage())),
			);
			const hardCostLimit = minimumDefined(
				remainingHardCostLimit(),
				budget?.maxCost === undefined ? undefined : Math.max(0, budget.maxCost - roleCostUsage()),
			);
			const maxRuntimeMs = remainingMaxRuntimeMs();
			const hardRequestLimit = minimumDefined(
				remainingHardRequestLimit(),
				budget?.maxProviderRequests === undefined
					? undefined
					: Math.max(0, Math.trunc(budget.maxProviderRequests - roleRequestUsage())),
			);
			if (hardTokenLimit === 0 || hardCostLimit === 0 || maxRuntimeMs === 0 || hardRequestLimit === 0) {
				const reasons: string[] = [];
				if (hardTokenLimit === 0) reasons.push("token budget exhausted");
				if (hardCostLimit === 0) reasons.push("cost budget exhausted");
				if (maxRuntimeMs === 0) reasons.push("duration budget exhausted");
				if (hardRequestLimit === 0) reasons.push("provider-request budget exhausted");
				const message = `San role aborted before start: ${reasons.join("; ")}`;
				return {
					index,
					id: safeArtifactId(id),
					agent: agentName,
					agentSource: "bundled",
					task,
					exitCode: 1,
					output: message,
					stderr: message,
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 0,
					error: message,
					aborted: true,
					abortReason: "budget",
					extractedToolData: {},
				};
			}
			return runSubprocess({
				cwd: options.cwd,
				agent: { ...getAgent(agentName), tools: [...SAN_LOOP_ROLE_TOOLS[role]] },
				task,
				index,
				id: safeArtifactId(id),
				settings: options.session.settings,
				modelRegistry: options.session.modelRegistry,
				authStorage: options.session.modelRegistry.authStorage,
				sessionFile: options.session.sessionFile,
				artifactsDir,
				eventBus: options.eventBus,
				signal: combinedSignal,
				parentToolCallId: options.parentToolCallId,
				modelOverride: modelOverrideForRole(role),
				parentActiveModelPattern: undefined,
				parentServiceTier: options.session.serviceTierByFamily ?? null,
				parentHindsightSessionState: options.session.getHindsightSessionState?.(),
				parentMnemopiSessionState: options.session.getMnemopiSessionState?.(),
				parentEvalSessionId: options.session.getEvalSessionId?.() ?? undefined,
				parentAgentId: options.session.getAgentId?.() ?? "Main",
				keepAlive: false,
				enableLsp: true,
				strictToolNames: true,
				...(hardTokenLimit !== undefined ? { hardTokenLimit } : {}),
				...(hardCostLimit !== undefined ? { hardCostLimit } : {}),
				...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
				...(hardRequestLimit !== undefined ? { hardRequestLimit } : {}),
			});
		};
		const result = recordUsage(await runOnce());
		if (!shouldRetryTransientSubagentFailure(role, result)) return result;
		return recordUsage(await runOnce());
	};

	return {
		usage: () => ({ ...accumulatedUsage }),
		async commander(invocation) {
			const result = await runAgent(
				"san-commander",
				"commander",
				buildCommanderTask(
					invocation,
					commanderConversationContext(),
					roleContext("commander", invocation.run.runId),
				),
				0,
				`${invocation.run.runId}_commander`,
				invocation.signal,
				invocation.budget,
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
				"worker",
				buildWorkerTask(
					invocation,
					roleContext("worker", invocation.run.runId, invocation.assignment.assignmentId),
				),
				1,
				invocation.assignment.assignmentId,
				invocation.signal,
				invocation.budget,
			);
			const hostReceipts = extractHostBashReceipts(result);
			const data = latestYieldData(result);
			if (result.exitCode !== 0 || data === undefined) {
				return {
					assignmentId: invocation.assignment.assignmentId,
					status: "failed",
					summary: resultFailureSummary(result),
					changedFiles: [],
					commandsRun: hostReceipts,
					verification: [],
					risks: ["Worker failed before yielding structured evidence."],
				};
			}
			return parseWorkerResult(invocation.assignment, data, hostReceipts);
		},
		async supervisor(invocation) {
			const result = await runAgent(
				"san-supervisor",
				"supervisor",
				buildSupervisorTask(invocation, roleContext("supervisor", invocation.run.runId)),
				2,
				`${invocation.run.runId}_supervisor`,
				invocation.signal,
				invocation.budget,
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
			const result = await runAgent(
				"san-oracle",
				"oracle",
				buildOracleTask(invocation, roleContext("oracle", invocation.run.runId)),
				3,
				`${invocation.run.runId}_oracle`,
				invocation.signal,
				invocation.budget,
			);
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
