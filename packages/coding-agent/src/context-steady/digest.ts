/**
 * TurnDigest orchestration: input collection, LLM digest, and fallback digest.
 *
 * Digest generation is a side request — it never touches the main agent loop,
 * never appends messages to the session, and never triggers new agent_end events.
 */

import { ThinkingLevel } from "@san/agent";
import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@san/ai";
import { isDeepseekModelIdOrName } from "@san/catalog/identity";
import { logger, prompt } from "@san/utils";

import type { Settings } from "../config/settings";
import type { ReadonlySessionManager } from "../session/session-manager";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { generateFallbackDigest, generateTurnId } from "./fallback";
import { normalizeDigest } from "./normalize";
import turnDigestPrompt from "./prompts/turn-digest.md" with { type: "text" };
import { appendTurnDigest, findExistingDigest } from "./session";
import { isVolatileContextSteadyMemory, polishContextSteadyText } from "./text";
import type {
	ContextSteadySettings,
	TurnDigest,
	TurnDigestFallbackReason,
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
	/** Optional concrete effort selected in the digest model selector. */
	thinkingLevel?: ThinkingLevel;
	obfuscator?: ContextSteadyDigestObfuscator;
	/**
	 * Optional session-prepared stream options (routing, payload hooks, loop guard).
	 * When set, merged over the default digest request options before completeSimple.
	 */
	prepareStreamOptions?: (options: SimpleStreamOptions, provider: string) => SimpleStreamOptions;
	/** Optional observer used to account for successful side-request usage. */
	onResponse?: (response: AssistantMessage) => void;
}

export interface ContextSteadyDigestObfuscator {
	hasSecrets(): boolean;
	obfuscate(text: string): string;
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

export interface TurnDigestGenerationResult {
	digest: TurnDigest;
	entryId?: string;
	persisted: boolean;
	reused: boolean;
	upgraded: boolean;
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
): Promise<TurnDigestGenerationResult | undefined> {
	if (!steadySettings.enabled || !steadySettings.digest.enabled) return undefined;

	const entries = sessionManager.getEntries();
	const existing = findExistingDigest(entries, source);
	const existingDigest = existing?.type === "custom" ? (existing.data as TurnDigest) : undefined;
	const canUpgrade =
		existingDigest?.fallback === true && steadySettings.digest.llm?.enabled === true && digestModel !== undefined;
	if (existingDigest && !canUpgrade) {
		return {
			digest: existingDigest,
			entryId: existing?.id,
			persisted: true,
			reused: true,
			upgraded: false,
		};
	}

	const turnId = existingDigest?.turnId ?? generateTurnId();
	const sessionId = source.sessionId;
	const fallbackDigest =
		existingDigest ??
		generateFallbackDigest(messages as Parameters<typeof generateFallbackDigest>[0], source, turnId, sessionId);
	const digest = await buildDigest(messages, fallbackDigest, steadySettings, digestModel);
	if (!digest) return undefined;
	if (existingDigest && digest.fallback) {
		return {
			digest: existingDigest,
			entryId: existing?.id,
			persisted: true,
			reused: true,
			upgraded: false,
		};
	}
	const upgraded = existingDigest?.fallback === true && digest.fallback === false;
	const persistedDigest = upgraded && existing ? { ...digest, supersedesEntryId: existing.id } : digest;

	try {
		const entryId = appendTurnDigest(sessionManager, persistedDigest);
		logger.debug("TurnDigest persisted", {
			turnId: persistedDigest.turnId,
			fallback: persistedDigest.fallback,
			upgraded,
			sessionId: persistedDigest.sessionId,
			fromEntryId: source.fromEntryId,
			toEntryId: source.toEntryId,
		});
		return { digest: persistedDigest, entryId, persisted: true, reused: false, upgraded };
	} catch (err) {
		logger.warn("Failed to persist TurnDigest", { error: String(err), sessionId: persistedDigest.sessionId });
		return { digest: persistedDigest, persisted: false, reused: false, upgraded };
	}
}

function fallbackReasonForError(error: unknown): TurnDigestFallbackReason {
	const message = error instanceof Error ? error.message : String(error);
	if (/auth_unavailable|no auth available|unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) {
		return "auth_unavailable";
	}
	if (/timeout|timed out|aborterror/i.test(message)) return "timeout";
	if (/structured turn digest|structured output|tool arguments|json object/i.test(message)) {
		return "structured_output_invalid";
	}
	return "request_failed";
}

async function buildDigest(
	messages: readonly unknown[],
	fallbackDigest: TurnDigest,
	steadySettings: ContextSteadySettings,
	digestModel?: ContextSteadyDigestModel,
): Promise<TurnDigest | undefined> {
	if (!steadySettings.digest.llm?.enabled) {
		return steadySettings.digest.persistFallback ? { ...fallbackDigest, fallbackReason: "llm_disabled" } : undefined;
	}
	if (!digestModel) {
		logger.warn("TurnDigest model could not be resolved; persisting fallback digest", {
			modelRole: steadySettings.digest.llm.modelRole,
			sessionId: fallbackDigest.sessionId,
			turnId: fallbackDigest.turnId,
		});
		return steadySettings.digest.persistFallback
			? { ...fallbackDigest, fallbackReason: "model_unresolved" }
			: undefined;
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
		return steadySettings.digest.persistFallback
			? { ...fallbackDigest, fallbackReason: fallbackReasonForError(error) }
			: undefined;
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
	return /stream closed|terminal response|fetch failed|network|socket|econnreset|etimedout|timed out|timeout|aborterror|temporar|structured turn digest|structured output|tool arguments|json object/i.test(
		message,
	);
}

async function generateLlmDigest(
	messages: readonly unknown[],
	fallbackDigest: TurnDigest,
	steadySettings: ContextSteadySettings,
	digestModel: ContextSteadyDigestModel,
): Promise<Record<string, unknown>> {
	const userContent = formatDigestUserMessage(messages, fallbackDigest);
	const outboundUserContent = obfuscateDigestText(digestModel.obfuscator, userContent);
	const timeoutSignal = AbortSignal.timeout(Math.max(1, steadySettings.digest.timeoutMs));
	const requestedThinkingLevel = digestModel.thinkingLevel;
	const useConfiguredThinking =
		requestedThinkingLevel !== undefined && requestedThinkingLevel !== ThinkingLevel.Inherit;
	const resolvedThinkingLevel = useConfiguredThinking
		? resolveThinkingLevelForModel(digestModel.model, requestedThinkingLevel)
		: undefined;
	const baseOptions: SimpleStreamOptions = {
		apiKey: digestModel.apiKey,
		maxTokens: digestModel.model.reasoning ? Math.max(DIGEST_MAX_TOKENS, 4096) : DIGEST_MAX_TOKENS,
		reasoning: useConfiguredThinking ? toReasoningEffort(resolvedThinkingLevel) : undefined,
		disableReasoning: useConfiguredThinking ? shouldDisableReasoning(resolvedThinkingLevel) : true,
		// DeepSeek-family reasoning models always think and reject `tool_choice`
		// while thinking is enabled (`Thinking mode does not support this
		// tool_choice`). Only the built-in deepseek provider resolves
		// `supportsToolChoice: false`; custom proxies in front of DeepSeek do
		// not, so the forced named choice would 400 upstream. Keep the tool
		// offered, let the provider default to auto, and recover structured
		// output from the tool call or the text-JSON fallback.
		toolChoice:
			digestModel.model.reasoning && isDeepseekModelIdOrName(digestModel.model.id)
				? undefined
				: { type: "tool", name: RECORD_TURN_DIGEST_TOOL_NAME },
		metadata: {
			...(digestModel.metadata ?? {}),
			sanSideRequest: "context_steady.turn_digest",
			turnId: fallbackDigest.turnId,
			sessionId: fallbackDigest.sessionId,
		},
		signal: timeoutSignal,
		// Isolate from main append-only conversation cache while keeping a stable cache key family.
		sessionId: `${fallbackDigest.sessionId}:digest:${fallbackDigest.turnId}`,
		promptCacheKey: fallbackDigest.sessionId,
		preferWebsockets: false,
	};
	const preparedOptions = digestModel.prepareStreamOptions
		? digestModel.prepareStreamOptions(baseOptions, digestModel.model.provider)
		: baseOptions;
	const response = await completeSimple(
		digestModel.model,
		{
			systemPrompt: [TURN_DIGEST_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: outboundUserContent,
					timestamp: Date.now(),
				},
			],
			tools: [recordTurnDigestTool],
		},
		preparedOptions,
	);
	digestModel.onResponse?.(response);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "provider returned an error");
	}

	const toolArgs = extractDigestToolArguments(response);
	if (toolArgs) return toolArgs;

	const textJson = extractJsonObjectFromText(response);
	if (textJson) return textJson;
	if (timeoutSignal.aborted) {
		throw new Error("TurnDigest request timed out before structured output");
	}

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

	for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
		for (let end = text.indexOf("}", start); end >= 0; end = text.indexOf("}", end + 1)) {
			try {
				const parsed = JSON.parse(text.slice(start, end + 1));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				// Keep scanning candidate braces in case surrounding text contains non-JSON objects.
			}
		}
	}

	return undefined;
}

function obfuscateDigestText(obfuscator: ContextSteadyDigestObfuscator | undefined, text: string): string {
	return obfuscator?.hasSecrets() ? obfuscator.obfuscate(text) : text;
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

function authoritativeMemoryCandidates(digest: TurnDigest, fallbackDigest: TurnDigest): TurnDigestMemoryCandidate[] {
	const inferred: TurnDigestMemoryCandidate[] = digest.memoryCandidates.map(candidate => ({
		...candidate,
		authorization: "inferred",
	}));
	const seen = new Set(inferred.map(candidate => candidate.content.trim().toLowerCase()));
	for (const candidate of fallbackDigest.memoryCandidates) {
		if (candidate.authorization !== "explicit_user") continue;
		const key = candidate.content.trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		inferred.unshift({ ...candidate, authorization: "explicit_user" });
	}
	return inferred;
}

function mergeAuthoritativeDigestFields(digest: TurnDigest, fallbackDigest: TurnDigest): TurnDigest {
	return {
		...digest,
		turnId: fallbackDigest.turnId,
		sessionId: fallbackDigest.sessionId,
		createdAt: fallbackDigest.createdAt,
		source: fallbackDigest.source,
		memoryCandidates: authoritativeMemoryCandidates(digest, fallbackDigest),
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
