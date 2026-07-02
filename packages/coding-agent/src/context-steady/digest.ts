/**
 * TurnDigest orchestration: input collection, LLM digest, and fallback digest.
 *
 * Digest generation is a side request — it never touches the main agent loop,
 * never appends messages to the session, and never triggers new agent_end events.
 */

import { type Api, type ApiKey, type AssistantMessage, completeSimple, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";

import type { Settings } from "../config/settings";
import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { generateFallbackDigest, generateTurnId } from "./fallback";
import { normalizeDigest } from "./normalize";
import turnDigestPrompt from "./prompts/turn-digest.md" with { type: "text" };
import { appendTurnDigest, hasExistingDigest } from "./session";
import { isVolatileContextSteadyMemory, polishContextSteadyText } from "./text";
import type {
	ContextSteadySettings,
	TurnDigest,
	TurnDigestFile,
	TurnDigestMemoryCandidate,
	TurnDigestSource,
	TurnDigestToolEvidence,
} from "./types";

const TURN_DIGEST_SYSTEM_PROMPT = prompt.render(turnDigestPrompt);
const RECORD_TURN_DIGEST_TOOL_NAME = "record_turn_digest";
const DIGEST_MAX_TOKENS = 2048;
const MAX_TRANSCRIPT_CHARS = 18000;
const MAX_LLM_DIGEST_ATTEMPTS = 2;
const MAX_LLM_ACTIONS = 5;
const MAX_LLM_DECISIONS = 6;
const MAX_LLM_FACTS = 6;
const MAX_LLM_RISKS = 4;
const MAX_LLM_NEXT_STEPS = 4;
const MAX_LLM_MEMORY_CANDIDATES = 2;

const recordTurnDigestTool: Tool = {
	name: RECORD_TURN_DIGEST_TOOL_NAME,
	description: "Record the structured digest for the settled turn span.",
	parameters: {
		type: "object",
		properties: {
			userIntent: { type: "string", description: "One-sentence summary of what the user asked for." },
			actionsTaken: { type: "array", maxItems: MAX_LLM_ACTIONS, items: { type: "string" } },
			decisions: { type: "array", maxItems: MAX_LLM_DECISIONS, items: { type: "string" } },
			filesTouched: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						action: { type: "string", enum: ["read", "modified", "created", "deleted", "unknown"] },
						reason: { type: "string" },
					},
					required: ["path", "action"],
					additionalProperties: false,
				},
			},
			factsLearned: { type: "array", maxItems: MAX_LLM_FACTS, items: { type: "string" } },
			openQuestions: { type: "array", items: { type: "string" } },
			risks: { type: "array", maxItems: MAX_LLM_RISKS, items: { type: "string" } },
			nextSteps: { type: "array", maxItems: MAX_LLM_NEXT_STEPS, items: { type: "string" } },
			memoryCandidates: {
				type: "array",
				maxItems: MAX_LLM_MEMORY_CANDIDATES,
				items: {
					type: "object",
					properties: {
						content: { type: "string" },
						type: {
							type: "string",
							description:
								"One of preference, project_fact, decision, workflow, or other. Invalid values are normalized.",
						},
						importance: { type: "number" },
					},
					required: ["content", "type", "importance"],
					additionalProperties: false,
				},
			},
		},
		required: [
			"userIntent",
			"actionsTaken",
			"decisions",
			"filesTouched",
			"factsLearned",
			"openQuestions",
			"risks",
			"nextSteps",
			"memoryCandidates",
		],
		additionalProperties: false,
	},
};

export interface ContextSteadyDigestModel {
	model: Model<Api>;
	apiKey: ApiKey;
	metadata?: Record<string, unknown>;
}

interface DigestTextPart {
	type: "text";
	text: string;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	status?: unknown;
	isError?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	customType?: unknown;
	entryId?: unknown;
	details?: unknown;
}

/**
 * Generate and persist a TurnDigest for a settled turn.
 *
 * Never throws — errors are logged to the session manager's logger but
 * never propagate to the caller.
 */
export async function generateDigest(
	messages: readonly unknown[],
	source: TurnDigestSource,
	sessionManager: ReadonlySessionManager,
	_settings: Settings,
	steadySettings: ContextSteadySettings,
	digestModel?: ContextSteadyDigestModel,
): Promise<void> {
	if (!steadySettings.enabled || !steadySettings.digest.enabled) return;

	// Dedupe: skip if this source range already has a digest
	const entries = (
		sessionManager as unknown as { getEntries(): Array<Record<string, unknown>> }
	).getEntries() as unknown as readonly SessionEntry[];
	if (hasExistingDigest(entries, source)) return;

	const turnId = generateTurnId();
	const sessionId = source.sessionId;

	const fallbackDigest = generateFallbackDigest(
		messages as Parameters<typeof generateFallbackDigest>[0],
		source,
		turnId,
		sessionId,
	);
	const digest = await buildDigest(messages, fallbackDigest, steadySettings, digestModel);

	if (!digest) return;

	try {
		appendTurnDigest(sessionManager, digest);
		logger.debug("TurnDigest persisted", {
			turnId: digest.turnId,
			fallback: digest.fallback,
			sessionId: digest.sessionId,
			fromEntryId: source.fromEntryId,
			toEntryId: source.toEntryId,
		});
	} catch (err) {
		logger.warn("Failed to persist TurnDigest", { error: String(err), sessionId: digest.sessionId });
	}
}

async function buildDigest(
	messages: readonly unknown[],
	fallbackDigest: TurnDigest,
	steadySettings: ContextSteadySettings,
	digestModel?: ContextSteadyDigestModel,
): Promise<TurnDigest | undefined> {
	if (!steadySettings.digest.llm?.enabled || !digestModel) {
		return steadySettings.digest.persistFallback ? fallbackDigest : undefined;
	}

	try {
		const rawDigest = await generateLlmDigestWithRetry(messages, fallbackDigest, steadySettings, digestModel);
		const normalized = normalizeDigest(rawDigest, {
			...fallbackDigest,
			model: `${digestModel.model.provider}/${digestModel.model.id}`,
			fallback: false,
		});
		return polishLlmDigest(mergeAuthoritativeDigestFields(normalized, fallbackDigest));
	} catch (error) {
		logger.warn("TurnDigest LLM generation failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionId: fallbackDigest.sessionId,
			turnId: fallbackDigest.turnId,
			model: `${digestModel.model.provider}/${digestModel.model.id}`,
		});
		return steadySettings.digest.persistFallback ? fallbackDigest : undefined;
	}
}

async function generateLlmDigestWithRetry(
	messages: readonly unknown[],
	fallbackDigest: TurnDigest,
	steadySettings: ContextSteadySettings,
	digestModel: ContextSteadyDigestModel,
): Promise<Record<string, unknown>> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_LLM_DIGEST_ATTEMPTS; attempt++) {
		try {
			return await generateLlmDigest(messages, fallbackDigest, steadySettings, digestModel);
		} catch (error) {
			lastError = error;
			if (attempt >= MAX_LLM_DIGEST_ATTEMPTS || !isRetryableDigestError(error)) break;
			logger.debug("Retrying TurnDigest LLM generation after transient failure", {
				error: error instanceof Error ? error.message : String(error),
				sessionId: fallbackDigest.sessionId,
				turnId: fallbackDigest.turnId,
				attempt,
			});
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableDigestError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /stream closed|terminal response|fetch failed|network|socket|econnreset|etimedout|temporar/i.test(message);
}

async function generateLlmDigest(
	messages: readonly unknown[],
	fallbackDigest: TurnDigest,
	steadySettings: ContextSteadySettings,
	digestModel: ContextSteadyDigestModel,
): Promise<Record<string, unknown>> {
	const response = await completeSimple(
		digestModel.model,
		{
			systemPrompt: [TURN_DIGEST_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: formatDigestUserMessage(messages, fallbackDigest),
					timestamp: Date.now(),
				},
			],
			tools: [recordTurnDigestTool],
		},
		{
			apiKey: digestModel.apiKey,
			maxTokens: digestModel.model.reasoning ? Math.max(DIGEST_MAX_TOKENS, 4096) : DIGEST_MAX_TOKENS,
			disableReasoning: true,
			toolChoice: { type: "tool", name: RECORD_TURN_DIGEST_TOOL_NAME },
			metadata: digestModel.metadata,
			signal: AbortSignal.timeout(Math.max(1, steadySettings.digest.timeoutMs)),
		},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "provider returned an error");
	}

	const toolArgs = extractDigestToolArguments(response);
	if (toolArgs) return toolArgs;

	const textJson = extractJsonObjectFromText(response);
	if (textJson) return textJson;

	throw new Error("provider did not return a structured turn digest");
}

function extractDigestToolArguments(response: AssistantMessage): Record<string, unknown> | undefined {
	for (const content of response.content) {
		if (content.type !== "toolCall" || content.name !== RECORD_TURN_DIGEST_TOOL_NAME) continue;
		return typeof content.arguments === "object" && content.arguments !== null ? content.arguments : undefined;
	}
	return undefined;
}

function extractJsonObjectFromText(response: AssistantMessage): Record<string, unknown> | undefined {
	const text = response.content
		.filter((content): content is DigestTextPart => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
	if (!text) return undefined;
	const match = /\{[\s\S]*\}/.exec(text);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function formatDigestUserMessage(messages: readonly unknown[], fallbackDigest: TurnDigest): string {
	const body = JSON.stringify(
		{
			source: fallbackDigest.source,
			fallbackEvidence: {
				userIntent: fallbackDigest.userIntent,
				filesTouched: fallbackDigest.filesTouched,
				toolEvidence: fallbackDigest.toolEvidence,
				tokenStats: fallbackDigest.tokenStats,
			},
			turnSpan: messages.map(formatMessageForDigest),
		},
		null,
		2,
	);
	return body.length <= MAX_TRANSCRIPT_CHARS
		? body
		: `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n...[truncated for digest generation]`;
}

function formatMessageForDigest(message: unknown): Record<string, unknown> {
	if (!message || typeof message !== "object") return { value: String(message) };
	const obj = message as MessageLike;
	return stripUndefined({
		entryId: stringValue(obj.entryId),
		role: stringValue(obj.role),
		customType: stringValue(obj.customType),
		provider: stringValue(obj.provider),
		model: stringValue(obj.model),
		status: stringValue(obj.status),
		isError: typeof obj.isError === "boolean" ? obj.isError : undefined,
		toolName: stringValue(obj.toolName),
		toolCallId: stringValue(obj.toolCallId),
		content: simplifyContent(obj.content),
		details: simplifyDetails(obj.details),
	});
}

function simplifyContent(content: unknown): unknown {
	if (typeof content === "string") return limitText(content, 2000);
	if (!Array.isArray(content)) return content === undefined ? undefined : String(content);
	return content.map(part => {
		if (!part || typeof part !== "object") return String(part);
		const obj = part as Record<string, unknown>;
		return stripUndefined({
			type: stringValue(obj.type),
			text: typeof obj.text === "string" ? limitText(obj.text, 1200) : undefined,
			name: stringValue(obj.name),
			id: stringValue(obj.id),
			arguments: simplifyDetails(obj.arguments ?? obj.args),
		});
	});
}

function simplifyDetails(details: unknown): unknown {
	if (!details || typeof details !== "object") return details;
	if (Array.isArray(details)) return details.slice(0, 20).map(simplifyDetails);
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (typeof value === "string") {
			result[key] = limitText(value, 500);
		} else if (typeof value === "number" || typeof value === "boolean" || value === null) {
			result[key] = value;
		} else if (Array.isArray(value)) {
			result[key] = value.slice(0, 10).map(simplifyDetails);
		} else if (value && typeof value === "object") {
			result[key] = simplifyDetails(value);
		}
	}
	return result;
}

function mergeAuthoritativeDigestFields(digest: TurnDigest, fallbackDigest: TurnDigest): TurnDigest {
	return {
		...digest,
		turnId: fallbackDigest.turnId,
		sessionId: fallbackDigest.sessionId,
		createdAt: fallbackDigest.createdAt,
		source: fallbackDigest.source,
		filesTouched: mergeFiles(digest.filesTouched, fallbackDigest.filesTouched),
		toolEvidence: mergeToolEvidence(digest.toolEvidence, fallbackDigest.toolEvidence),
		tokenStats: fallbackDigest.tokenStats,
		fallback: false,
	};
}

function mergeFiles(primary: readonly TurnDigestFile[], fallback: readonly TurnDigestFile[]): TurnDigestFile[] {
	const byPath = new Map<string, TurnDigestFile>();
	for (const file of fallback) byPath.set(file.path, file);
	for (const file of primary) byPath.set(file.path, { ...byPath.get(file.path), ...file });
	return [...byPath.values()];
}

function mergeToolEvidence(
	primary: readonly TurnDigestToolEvidence[],
	fallback: readonly TurnDigestToolEvidence[],
): TurnDigestToolEvidence[] {
	const merged: TurnDigestToolEvidence[] = [...fallback];
	for (const item of primary) {
		const existing = merged.find(entry => entry.tool === item.tool);
		if (!existing) {
			merged.push(item);
			continue;
		}
		existing.summary = item.summary || existing.summary;
		if (item.entryIds && item.entryIds.length > 0) {
			const ids = new Set([...(existing.entryIds ?? []), ...item.entryIds]);
			existing.entryIds = [...ids];
		}
	}
	return merged;
}

function polishLlmDigest(digest: TurnDigest): TurnDigest {
	return {
		...digest,
		userIntent: polishContextSteadyText(digest.userIntent) || digest.userIntent,
		actionsTaken: polishStringList(digest.actionsTaken, MAX_LLM_ACTIONS),
		decisions: polishStringList(digest.decisions, MAX_LLM_DECISIONS),
		factsLearned: polishStringList(digest.factsLearned, MAX_LLM_FACTS),
		risks: polishStringList(digest.risks, MAX_LLM_RISKS),
		nextSteps: polishStringList(digest.nextSteps, MAX_LLM_NEXT_STEPS),
		memoryCandidates: polishMemoryCandidates(digest.memoryCandidates),
	};
}

function polishStringList(items: readonly string[], maxItems: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of items) {
		if (result.length >= maxItems) break;
		const polished = polishContextSteadyText(item);
		if (!polished) continue;
		const key = polished.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(polished);
	}
	return result;
}

function polishMemoryCandidates(candidates: readonly TurnDigestMemoryCandidate[]): TurnDigestMemoryCandidate[] {
	const result: TurnDigestMemoryCandidate[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (result.length >= MAX_LLM_MEMORY_CANDIDATES) break;
		const content = polishContextSteadyText(candidate.content);
		if (!content || isVolatileContextSteadyMemory(content)) continue;
		const key = content.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ ...candidate, content });
	}
	return result;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) result[key] = entry;
	}
	return result;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function limitText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
