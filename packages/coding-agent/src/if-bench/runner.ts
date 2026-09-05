import type { Api, ApiKeyResolver, AssistantMessage, Context, Message, Model, ProviderSessionState } from "@san/ai";
import { logger } from "@san/utils";
import type { BenchRuntime, BenchTarget, StreamSimpleFn } from "../cli/bench-runtime";
import { formatModelSelectorValue, formatModelString } from "../config/model-resolver";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { Action } from "./actions";
import { applyActions, initialArray, makeActions } from "./actions";
import type { CatPlacement, IfBenchFailure } from "./protocol";
import { assessResponse, buildSystemPrompt, buildTurnPrompt } from "./protocol";

export interface IfBenchTurnRecord {
	turn: number;
	actions: number;
	cumulativeActions: number;
	placement: CatPlacement;
	durationMs: number;
	outputTokens: number;
	cost: number;
	passed: boolean;
	failure?: IfBenchFailure;
	expected: string;
	response: string;
}

export interface IfBenchModelReport {
	selector: string;
	model: string;
	label: string;
	turns: IfBenchTurnRecord[];
	turnsPassed: number;
	actionsPassed: number;
	failure?: { turn: number; kind: IfBenchFailure; detail: string };
	durationMs: number;
	outputTokens: number;
	cost: number;
}

export interface IfBenchSummary {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
	maxTokens: number;
	models: IfBenchModelReport[];
	failures: number;
}

export interface IfBenchObserver {
	modelStarted?(label: string): void;
	turnStarted?(label: string, turn: number, actions: number): void;
	turnFinished?(label: string, record: IfBenchTurnRecord): void;
	modelFinished?(report: IfBenchModelReport): void;
}

export interface IfBenchRunOptions {
	targets: readonly BenchTarget[];
	runtime: BenchRuntime;
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
	maxTokens: number;
	par: number;
	stream: StreamSimpleFn;
	now: () => number;
	randomSessionId: () => string;
	observer?: IfBenchObserver;
	sleep?: (ms: number) => Promise<void>;
}

interface TurnOutcome {
	message?: AssistantMessage;
	text: string;
	error?: string;
	durationMs: number;
}

const REFUSAL_MAX_ATTEMPTS = 8;
const REFUSAL_BACKOFF_MS = [0, 5_000, 15_000, 30_000, 60_000, 90_000, 120_000, 180_000];

function isCyberRefusal(error: string | undefined): boolean {
	return error !== undefined && /^Refusal \(/.test(error);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("");
}

function errorText(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

export async function runIfBench(options: IfBenchRunOptions): Promise<IfBenchSummary> {
	const queue = options.targets.map((target, index) => ({ target, index }));
	const ordered: IfBenchModelReport[] = new Array(options.targets.length);
	const worker = async (): Promise<void> => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			ordered[next.index] = await runTarget(next.target, options);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(options.par, options.targets.length)) }, worker));
	return {
		maxTurns: options.maxTurns,
		arrayLength: options.arrayLength,
		nyaMax: options.nyaMax,
		maxTokens: options.maxTokens,
		models: ordered,
		failures: ordered.filter(report => report.failure !== undefined).length,
	};
}

async function runTarget(target: BenchTarget, options: IfBenchRunOptions): Promise<IfBenchModelReport> {
	const { model, selector, thinking } = target;
	const label = formatModelSelectorValue(formatModelString(model), thinking);
	const report: IfBenchModelReport = {
		selector,
		model: formatModelString(model),
		label,
		turns: [],
		turnsPassed: 0,
		actionsPassed: 0,
		durationMs: 0,
		outputTokens: 0,
		cost: 0,
	};
	options.observer?.modelStarted?.(label);

	const preflight = await options.runtime.modelRegistry.getApiKey(model, options.randomSessionId());
	if (!preflight) {
		report.failure = {
			turn: 0,
			kind: "provider",
			detail: `No credentials for provider "${model.provider}". Configure credentials before running if-bench.`,
		};
		options.observer?.modelFinished?.(report);
		return report;
	}

	const messages: Message[] = [];
	const context: Context = { systemPrompt: [buildSystemPrompt(options.nyaMax)], messages };
	const providerSessionState = new Map<string, ProviderSessionState>();
	let state = initialArray(options.arrayLength);
	let cumulativeActions = 0;

	try {
		for (let turn = 1; turn <= options.maxTurns; turn += 1) {
			const actions: Action[] = makeActions(options.arrayLength, cumulativeActions, turn);
			const turnPrompt = buildTurnPrompt({
				turn,
				start: turn === 1 ? state : undefined,
				actions,
				nyaMax: options.nyaMax,
			});
			messages.push({ role: "user", content: turnPrompt.content, timestamp: Date.now(), attribution: "user" });
			options.observer?.turnStarted?.(label, turn, actions.length);

			const expected = applyActions(state, actions);
			const outcome = await requestTurnWithRefusalRetry(model, context, providerSessionState, target, options);
			cumulativeActions += actions.length;
			const assessment = outcome.error
				? { passed: false, failure: "provider" as IfBenchFailure }
				: assessResponse(outcome.text, expected, options.nyaMax);
			const record: IfBenchTurnRecord = {
				turn,
				actions: actions.length,
				cumulativeActions,
				placement: turnPrompt.placement,
				durationMs: outcome.durationMs,
				outputTokens: outcome.message?.usage.output ?? 0,
				cost: outcome.message?.usage.cost?.total ?? 0,
				passed: assessment.passed,
				failure: assessment.failure,
				expected,
				response: outcome.error ?? outcome.text,
			};
			report.turns.push(record);
			report.durationMs += record.durationMs;
			report.outputTokens += record.outputTokens;
			report.cost += record.cost;
			options.observer?.turnFinished?.(label, record);

			if (!record.passed) {
				report.failure = {
					turn,
					kind: record.failure ?? "format",
					detail: record.response,
				};
				break;
			}
			report.turnsPassed = turn;
			report.actionsPassed = cumulativeActions;
			state = expected;
			if (outcome.message) messages.push(outcome.message);
		}
	} finally {
		for (const sessionState of providerSessionState.values()) sessionState.close();
		providerSessionState.clear();
	}

	options.observer?.modelFinished?.(report);
	return report;
}

async function requestTurnWithRefusalRetry(
	model: Model<Api>,
	context: Context,
	providerSessionState: Map<string, ProviderSessionState>,
	target: BenchTarget,
	options: IfBenchRunOptions,
): Promise<TurnOutcome> {
	let outcome: TurnOutcome = { text: "", error: "request failed", durationMs: 0 };
	for (let attempt = 1; attempt <= REFUSAL_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 1) await (options.sleep ?? Bun.sleep)(REFUSAL_BACKOFF_MS[attempt - 1] ?? 180_000);
		const sessionId = options.randomSessionId();
		const apiKey = options.runtime.modelRegistry.resolver(model, sessionId);
		outcome = await requestTurn(model, context, sessionId, apiKey, providerSessionState, target, options);
		if (!isCyberRefusal(outcome.error) || attempt === REFUSAL_MAX_ATTEMPTS) return outcome;
		logger.debug("if-bench refusal retry", { attempt, error: outcome.error });
	}
	return outcome;
}

async function requestTurn(
	model: Model<Api>,
	context: Context,
	sessionId: string,
	apiKey: ApiKeyResolver,
	providerSessionState: Map<string, ProviderSessionState>,
	target: BenchTarget,
	options: IfBenchRunOptions,
): Promise<TurnOutcome> {
	const startedAt = options.now();
	const elapsed = (message?: AssistantMessage): number => {
		const duration = message?.duration ?? options.now() - startedAt;
		return Number.isFinite(duration) && duration > 0 ? duration : 0;
	};
	try {
		const stream = options.stream(model, context, {
			apiKey,
			sessionId,
			promptCacheKey: sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			temperature: 0,
			reasoning: toReasoningEffort(target.thinking),
			disableReasoning: shouldDisableReasoning(target.thinking) ? true : undefined,
			providerSessionState,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "error") {
				return { text: "", error: event.error.errorMessage ?? "request failed", durationMs: elapsed() };
			}
			if (event.type === "done") message = event.message;
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { message, text: "", error: message.errorMessage ?? "request failed", durationMs: elapsed(message) };
		}
		const text = assistantText(message).trim();
		if (text.length === 0) {
			return {
				message,
				text,
				error: `provider returned no text (stop reason: ${message.stopReason ?? "unknown"})`,
				durationMs: elapsed(message),
			};
		}
		return { message, text, durationMs: elapsed(message) };
	} catch (error) {
		return { text: "", error: errorText(error), durationMs: elapsed() };
	}
}
