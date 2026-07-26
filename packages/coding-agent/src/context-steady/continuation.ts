import { prompt } from "@san/utils";
import continuationAuthorityTemplate from "../prompts/context-steady/continuation-authority.md" with { type: "text" };
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { isAuthoritativeUserEntry } from "./session";
import {
	type ActiveContinuationState,
	CONTEXT_CONTINUATION_MESSAGE_TYPE,
	CONTEXT_CONTINUATION_SCHEMA_VERSION,
	type ContextContinuationToolEvidence,
	type ContextSummaryAuthorityAudit,
} from "./types";

const KNOWN_MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_edit", "memory_edit", "manage_skill"]);
const UNCLASSIFIED_EXECUTION_TOOLS: ReadonlySet<string> = new Set(["bash", "eval"]);
const KNOWN_VERIFICATION_TOOLS: ReadonlySet<string> = new Set(["lsp", "debug"]);
const VERIFICATION_COMMAND_RE =
	/(?:^|[;&|]\s*|\s)(?:bun\s+(?:run\s+)?(?:test|check)|npm\s+(?:run\s+)?(?:test|check|build|lint)|pnpm\s+(?:run\s+)?(?:test|check|build|lint)|yarn\s+(?:run\s+)?(?:test|check|build|lint)|pytest|vitest|jest|cargo\s+(?:test|check|build)|go\s+test|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build))(?:\s|$)/i;
const MAX_ACTIVE_USER_REQUEST_CHARS = 16_000;
const MAX_EVIDENCE_REFS_PER_KIND = 32;
const TRUNCATED_REQUEST_MARKER =
	"\n[... active user request truncated; recover the full text from activeUserEntryId ...]\n";
const AUTHORITY_SOURCE_MISSING = "authority_source_missing";

interface ToolCallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function userRequestText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") parts.push(`[attached image: ${block.mimeType}]`);
	}
	return parts.join("\n");
}

function toolCallsFromEntry(entry: SessionEntry): ToolCallRecord[] {
	if (entry.type !== "message" || entry.message.role !== "assistant") return [];
	const calls: ToolCallRecord[] = [];
	for (const block of entry.message.content) {
		if (block.type !== "toolCall") continue;
		calls.push({ id: block.id, name: block.name, arguments: block.arguments });
	}
	return calls;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		if (!(key in value)) continue;
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function evidencePath(call: ToolCallRecord | undefined, details: unknown): string | undefined {
	return (
		stringField(details, ["path", "filePath", "file_path"]) ??
		stringField(call?.arguments, ["path", "filePath", "file_path"])
	);
}

function evidenceResource(call: ToolCallRecord | undefined): string | undefined {
	return stringField(call?.arguments, ["path", "filePath", "file_path", "url", "uri", "cwd", "workdir"]);
}

function evidenceCommand(call: ToolCallRecord | undefined): string | undefined {
	return stringField(call?.arguments, ["command"]);
}

function isVerification(call: ToolCallRecord | undefined, tool: string): boolean {
	if (KNOWN_VERIFICATION_TOOLS.has(tool)) return true;
	if (tool !== "bash") return false;
	const command = stringField(call?.arguments, ["command"]);
	return command !== undefined && VERIFICATION_COMMAND_RE.test(command);
}

function boundActiveUserRequest(request: string): {
	text: string;
	truncated: boolean;
	originalChars: number;
} {
	if (request.length <= MAX_ACTIVE_USER_REQUEST_CHARS) {
		return { text: request, truncated: false, originalChars: request.length };
	}
	const edgeChars = Math.floor((MAX_ACTIVE_USER_REQUEST_CHARS - TRUNCATED_REQUEST_MARKER.length) / 2);
	return {
		text: `${request.slice(0, edgeChars)}${TRUNCATED_REQUEST_MARKER}${request.slice(-edgeChars)}`,
		truncated: true,
		originalChars: request.length,
	};
}

function appendBoundedEvidence(
	target: ContextContinuationToolEvidence[],
	evidence: ContextContinuationToolEvidence,
): boolean {
	const omitted = target.length >= MAX_EVIDENCE_REFS_PER_KIND;
	if (omitted) target.shift();
	target.push(evidence);
	return omitted;
}

function normalizePersistedContinuationState(state: ActiveContinuationState): ActiveContinuationState {
	const request = boundActiveUserRequest(state.activeUserRequest);
	const successfulMutations = state.executionEvidence.successfulMutations.slice(-MAX_EVIDENCE_REFS_PER_KIND);
	const successfulVerifications = state.executionEvidence.successfulVerifications.slice(-MAX_EVIDENCE_REFS_PER_KIND);
	const observedResources = state.executionEvidence.observedResources.slice(-MAX_EVIDENCE_REFS_PER_KIND);
	const omittedEvidenceRefs =
		(state.executionEvidence.omittedEvidenceRefs ?? 0) +
		(state.executionEvidence.successfulMutations.length - successfulMutations.length) +
		(state.executionEvidence.successfulVerifications.length - successfulVerifications.length) +
		(state.executionEvidence.observedResources.length - observedResources.length);
	return {
		...state,
		activeUserRequest: request.text,
		...(request.truncated
			? {
					activeUserRequestTruncated: true,
					activeUserRequestOriginalChars: request.originalChars,
				}
			: {
					activeUserRequestTruncated: undefined,
					activeUserRequestOriginalChars: undefined,
				}),
		supersededUserEntryIds: state.supersededUserEntryIds.slice(-MAX_EVIDENCE_REFS_PER_KIND),
		executionEvidence: {
			...state.executionEvidence,
			successfulMutations,
			successfulVerifications,
			observedResources,
			omittedEvidenceRefs,
		},
	};
}

function continuationStateWithoutJournalSource(options: {
	entries: readonly SessionEntry[];
	sessionId: string;
	promptGeneration: number;
	summaryAuthority?: ContextSummaryAuthorityAudit;
	createdAt?: string;
}): ActiveContinuationState {
	const persisted = findLatestActiveContinuationState(options.entries);
	if (persisted && persisted.authoritySource !== AUTHORITY_SOURCE_MISSING) {
		const boundedPersisted = normalizePersistedContinuationState(persisted);
		return {
			...boundedPersisted,
			sessionId: options.sessionId,
			authoritySource: "persisted",
			...(boundedPersisted.sessionId !== options.sessionId
				? { sourceSessionId: boundedPersisted.sourceSessionId ?? boundedPersisted.sessionId }
				: {}),
			promptGeneration: options.promptGeneration,
			createdAt: options.createdAt ?? new Date().toISOString(),
			...(options.summaryAuthority ? { summaryAuthority: options.summaryAuthority } : {}),
		};
	}

	return {
		schemaVersion: CONTEXT_CONTINUATION_SCHEMA_VERSION,
		sessionId: options.sessionId,
		authoritySource: AUTHORITY_SOURCE_MISSING,
		logicalTurnId: AUTHORITY_SOURCE_MISSING,
		activeUserEntryId: AUTHORITY_SOURCE_MISSING,
		activeUserRequest: "",
		supersededUserEntryIds: [],
		promptGeneration: options.promptGeneration,
		createdAt: options.createdAt ?? new Date().toISOString(),
		...(options.summaryAuthority ? { summaryAuthority: options.summaryAuthority } : {}),
		executionEvidence: {
			successfulMutations: [],
			successfulVerifications: [],
			observedResources: [],
			successfulToolResults: 0,
			failedToolResults: 0,
			unclassifiedShellOrEvalResults: 0,
			omittedEvidenceRefs: 0,
		},
	};
}

/** 从真实 journal role/tool-result 配对同步派生当前继续执行权威态。 */
export function buildActiveContinuationState(options: {
	entries: readonly SessionEntry[];
	sessionId: string;
	promptGeneration: number;
	logicalTurnId?: string;
	summaryAuthority?: ContextSummaryAuthorityAudit;
	createdAt?: string;
}): ActiveContinuationState | undefined {
	const logicalTurnIndex = options.logicalTurnId
		? options.entries.findIndex(entry => entry.id === options.logicalTurnId)
		: -1;
	let activeUserIndex = -1;
	for (let index = options.entries.length - 1; index >= Math.max(0, logicalTurnIndex); index--) {
		const entry = options.entries[index];
		if (entry && isAuthoritativeUserEntry(entry)) {
			activeUserIndex = index;
			break;
		}
	}
	if (activeUserIndex < 0) return continuationStateWithoutJournalSource(options);

	const activeUserEntry = options.entries[activeUserIndex];
	if (!activeUserEntry) return continuationStateWithoutJournalSource(options);
	const rawActiveUserRequest = userRequestText(activeUserEntry);
	if (rawActiveUserRequest === undefined) return continuationStateWithoutJournalSource(options);
	const activeUserRequest = boundActiveUserRequest(rawActiveUserRequest);
	const priorAuthority = findLatestActiveContinuationState(options.entries.slice(0, activeUserIndex));
	const continuesPriorLogicalTurn =
		activeUserEntry.type === "message" &&
		activeUserEntry.message.role === "user" &&
		activeUserEntry.message.attribution !== "agent" &&
		activeUserEntry.message.steering === true &&
		priorAuthority !== undefined &&
		priorAuthority.authoritySource !== AUTHORITY_SOURCE_MISSING;
	const resolvedLogicalTurnId =
		logicalTurnIndex >= 0 && logicalTurnIndex <= activeUserIndex
			? options.logicalTurnId!
			: continuesPriorLogicalTurn
				? priorAuthority.logicalTurnId
				: activeUserEntry.id;
	const evidenceStartIndex = Math.max(
		0,
		options.entries.findIndex(entry => entry.id === resolvedLogicalTurnId),
	);
	const supersededUserEntryIds = [
		...(continuesPriorLogicalTurn ? priorAuthority.supersededUserEntryIds : []),
		...(continuesPriorLogicalTurn ? [priorAuthority.activeUserEntryId] : []),
		...options.entries
			.slice(evidenceStartIndex, activeUserIndex)
			.filter(entry => isAuthoritativeUserEntry(entry))
			.map(entry => entry.id),
	]
		.filter((entryId, index, all) => entryId !== activeUserEntry.id && all.indexOf(entryId) === index)
		.slice(-MAX_EVIDENCE_REFS_PER_KIND);
	const calls = new Map<string, ToolCallRecord>();
	for (const entry of options.entries.slice(evidenceStartIndex)) {
		for (const call of toolCallsFromEntry(entry)) calls.set(call.id, call);
	}

	const successfulMutations: ContextContinuationToolEvidence[] = [];
	const successfulVerifications: ContextContinuationToolEvidence[] = [];
	const observedResources: ContextContinuationToolEvidence[] = [];
	let successfulToolResults = 0;
	let failedToolResults = 0;
	let unclassifiedShellOrEvalResults = 0;
	let omittedEvidenceRefs = 0;
	for (const entry of options.entries.slice(evidenceStartIndex)) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.isError) {
			failedToolResults++;
			continue;
		}
		successfulToolResults++;
		const call = calls.get(entry.message.toolCallId);
		const tool = call?.name ?? entry.message.toolName;
		if (UNCLASSIFIED_EXECUTION_TOOLS.has(tool)) unclassifiedShellOrEvalResults++;
		const path = evidencePath(call, entry.message.details);
		const resource = evidenceResource(call);
		const command = evidenceCommand(call);
		const evidence: ContextContinuationToolEvidence = {
			tool,
			toolCallId: entry.message.toolCallId,
			resultEntryId: entry.id,
			...(path ? { path } : {}),
			...(resource && resource !== path ? { resource } : {}),
			...(command ? { command } : {}),
		};
		if (KNOWN_MUTATION_TOOLS.has(tool)) {
			if (appendBoundedEvidence(successfulMutations, evidence)) omittedEvidenceRefs++;
		} else if (isVerification(call, tool)) {
			if (appendBoundedEvidence(successfulVerifications, evidence)) omittedEvidenceRefs++;
		} else if (path || resource) {
			if (appendBoundedEvidence(observedResources, evidence)) omittedEvidenceRefs++;
		}
	}

	return {
		schemaVersion: CONTEXT_CONTINUATION_SCHEMA_VERSION,
		sessionId: options.sessionId,
		authoritySource: "journal",
		logicalTurnId: resolvedLogicalTurnId,
		activeUserEntryId: activeUserEntry.id,
		activeUserRequest: activeUserRequest.text,
		...(activeUserRequest.truncated
			? {
					activeUserRequestTruncated: true,
					activeUserRequestOriginalChars: activeUserRequest.originalChars,
				}
			: {}),
		supersededUserEntryIds,
		promptGeneration: options.promptGeneration,
		createdAt: options.createdAt ?? new Date().toISOString(),
		...(options.summaryAuthority ? { summaryAuthority: options.summaryAuthority } : {}),
		executionEvidence: {
			successfulMutations,
			successfulVerifications,
			observedResources,
			successfulToolResults,
			failedToolResults,
			unclassifiedShellOrEvalResults,
			omittedEvidenceRefs,
		},
	};
}

export function renderActiveContinuationState(state: ActiveContinuationState): string {
	return prompt.render(continuationAuthorityTemplate, {
		stateJson: JSON.stringify(state, null, 2),
		authoritySourceMissing: state.authoritySource === AUTHORITY_SOURCE_MISSING,
	});
}

/** 将旧会话派生的权威态迁移到 handoff 新会话，保留真实 journal 来源引用。 */
export function rebaseActiveContinuationState(
	state: ActiveContinuationState,
	options: { sessionId: string; promptGeneration: number; createdAt?: string },
): ActiveContinuationState {
	return {
		...state,
		sessionId: options.sessionId,
		authoritySource: state.authoritySource === AUTHORITY_SOURCE_MISSING ? AUTHORITY_SOURCE_MISSING : "handoff",
		sourceSessionId: state.sourceSessionId ?? state.sessionId,
		promptGeneration: options.promptGeneration,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
}

export function appendActiveContinuationState(
	sessionManager: Pick<SessionManager, "appendCustomMessageEntry">,
	state: ActiveContinuationState,
): string {
	return sessionManager.appendCustomMessageEntry(
		CONTEXT_CONTINUATION_MESSAGE_TYPE,
		renderActiveContinuationState(state),
		false,
		state,
		"agent",
	);
}

function activeContinuationStateFromEntry(entry: SessionEntry | undefined): ActiveContinuationState | undefined {
	if (
		entry?.type !== "custom_message" ||
		entry.customType !== CONTEXT_CONTINUATION_MESSAGE_TYPE ||
		!entry.details ||
		typeof entry.details !== "object"
	) {
		return undefined;
	}
	const state = entry.details as Partial<ActiveContinuationState>;
	if (
		state.schemaVersion !== CONTEXT_CONTINUATION_SCHEMA_VERSION ||
		typeof state.sessionId !== "string" ||
		typeof state.logicalTurnId !== "string" ||
		typeof state.activeUserEntryId !== "string" ||
		typeof state.activeUserRequest !== "string" ||
		!state.executionEvidence ||
		typeof state.executionEvidence !== "object" ||
		!Array.isArray((state.executionEvidence as Record<string, unknown>).successfulMutations) ||
		!Array.isArray((state.executionEvidence as Record<string, unknown>).successfulVerifications) ||
		!Array.isArray((state.executionEvidence as Record<string, unknown>).observedResources)
	) {
		return undefined;
	}
	return state as ActiveContinuationState;
}

/** 最新真实 user entry 会解除此前的 authority_source_missing 阻断。 */
export function isContinuationAuthoritySourceMissing(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry && isAuthoritativeUserEntry(entry)) return false;
		const state = activeContinuationStateFromEntry(entry);
		if (state) return state.authoritySource === AUTHORITY_SOURCE_MISSING;
	}
	return false;
}

export function findLatestActiveContinuationState(
	entries: readonly SessionEntry[],
): ActiveContinuationState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const state = activeContinuationStateFromEntry(entries[index]);
		if (state) return state;
	}
	return undefined;
}
