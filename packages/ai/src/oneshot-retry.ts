import { scheduler } from "node:timers/promises";
import { classifyMessage, Flag, is } from "./error/flags";
import { isProviderRetryableError, isTransientStatus } from "./error/retryable";
import type { AssistantMessage } from "./types";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./utils/retry-after";

/**
 * Bounded retry contract for side-effect-free one-shot LLM completions
 * (title generation, compaction/branch summaries, handoff documents, image
 * descriptions, eval completions).
 *
 * `completeSimple` surfaces most provider failures as a *resolved*
 * `AssistantMessage` with `stopReason === "error"` (providers populate
 * `errorStatus`/`errorId`/`errorMessage`) rather than a thrown exception.
 * This helper covers BOTH shapes:
 *
 * - resolved error-stops classified as transient are re-attempted, and
 * - thrown errors classified by {@link isProviderRetryableError} are
 *   re-attempted.
 *
 * Non-retryable outcomes (auth, usage/quota, content policy, grammar,
 * aborts, …) pass through untouched after a single attempt, and a latched or
 * mid-wait {@link AbortSignal} stays an abort. Server-requested backoff
 * (`retry-after-*` headers on thrown errors, or the `retry-after-ms=…` hint
 * providers append to error text) is honored up to {@link OneshotRetryOptions.retryAfterMaxMs}.
 *
 * The callback MUST create a fresh request each invocation — a once-consumed
 * response cannot be re-iterated.
 */
export interface OneshotRetryOptions {
	/** Maximum total attempts including the first. Defaults to 3. */
	readonly attempts?: number;
	/** Caller cancellation. A latched abort short-circuits retry immediately. */
	readonly signal?: AbortSignal;
	/** Base delay for the linear backoff between attempts. Defaults to 400ms. */
	readonly retryBaseDelayMs?: number;
	/** Longest server-requested backoff we are willing to sit out before giving up. Defaults to 30s. */
	readonly retryAfterMaxMs?: number;
}

const DEFAULT_ONESHOT_RETRY_ATTEMPTS = 3;
const DEFAULT_ONESHOT_RETRY_BASE_DELAY_MS = 400;
const DEFAULT_ONESHOT_RETRY_AFTER_MAX_MS = 30_000;

/** `retry-after-ms=<ms>` hint providers append to error text (see `utils/retry-after.ts`). */
const RETRY_AFTER_MS_HINT_RE = /retry-after-ms=(\d+)/i;

/**
 * Resolved-error kinds that must NEVER trigger a oneshot retry, even when the
 * message text also matches transient wording. Account/usage caps are owned
 * by the credential-rotation layer, auth failures won't heal in seconds,
 * and content/grammar rejections are deterministic for the same input.
 */
const NON_RETRYABLE_MESSAGE_KINDS = (Flag.ThinkingLoop |
	Flag.UsageLimit |
	Flag.MalformedFunctionCall |
	Flag.ContentBlocked |
	Flag.AccountPolicy |
	Flag.ContextOverflow |
	Flag.AuthFailed |
	Flag.SilentAbort |
	Flag.UserInterrupt |
	Flag.Abort |
	Flag.Grammar |
	Flag.FastModeUnsupported |
	Flag.OAuthExpiry) as Flag;

function isOneshotRetryableMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const kinds = classifyMessage({
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorStatus: message.errorStatus,
	});
	if (is(kinds, NON_RETRYABLE_MESSAGE_KINDS)) return false;
	if (is(kinds, Flag.Transient) || is(kinds, Flag.StaleResponsesItem) || is(kinds, Flag.ProviderFinishError)) {
		return true;
	}
	// Status-only error results (no text classification) are transient when
	// the status itself is throttling/server-side (408/429/5xx).
	return isTransientStatus(message.errorStatus);
}

/** Server-requested backoff carried by a thrown error or a resolved error message. */
function getRetryAfterMs(errorOrMessage: unknown): number | undefined {
	const fromHeaders = getRetryAfterMsFromHeaders(getHeadersFromError(errorOrMessage));
	if (fromHeaders !== undefined) return fromHeaders;

	let text: string | undefined;
	if (errorOrMessage instanceof Error) {
		text = errorOrMessage.message;
	} else if (typeof errorOrMessage === "object" && errorOrMessage !== null && "errorMessage" in errorOrMessage) {
		const candidate = errorOrMessage.errorMessage;
		if (typeof candidate === "string") text = candidate;
	}
	if (text === undefined) return undefined;
	const match = RETRY_AFTER_MS_HINT_RE.exec(text);
	return match ? Number(match[1]) : undefined;
}

/**
 * Resolve the delay before the next attempt. Returns `undefined` when the
 * server asked for a backoff longer than {@link OneshotRetryOptions.retryAfterMaxMs} —
 * sitting out a multi-minute wait for a seconds-scale oneshot retry would pin
 * the caller (spinner, title path) with no upside.
 */
function resolveRetryDelayMs(
	errorOrMessage: unknown,
	attempt: number,
	options: { retryBaseDelayMs: number; retryAfterMaxMs: number },
): number | undefined {
	const backoffMs = options.retryBaseDelayMs * (attempt + 1);
	const retryAfterMs = getRetryAfterMs(errorOrMessage);
	if (retryAfterMs === undefined) return backoffMs;
	if (retryAfterMs > options.retryAfterMaxMs) return undefined;
	return Math.max(backoffMs, retryAfterMs);
}

/**
 * Wrap a side-effect-free one-shot completion so bounded transient failures
 * are retried and the eventual completion is returned. See
 * {@link OneshotRetryOptions} for tuning and {@link OneshotRetryOptions.signal}
 * for cancellation semantics.
 */
export async function withOneshotRetry<T extends AssistantMessage>(
	fn: () => Promise<T>,
	options: OneshotRetryOptions = {},
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? DEFAULT_ONESHOT_RETRY_ATTEMPTS);
	const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_ONESHOT_RETRY_BASE_DELAY_MS;
	const retryAfterMaxMs = options.retryAfterMaxMs ?? DEFAULT_ONESHOT_RETRY_AFTER_MAX_MS;
	const signal = options.signal;

	let lastResult: T | undefined;
	for (let attempt = 0; attempt < attempts; attempt++) {
		let message: T;
		try {
			message = await fn();
		} catch (error) {
			// A latched abort makes any retry a guaranteed-dead attempt —
			// surface the original error, not the scheduler's AbortError.
			if (signal?.aborted || !isProviderRetryableError(error)) throw error;
			if (attempt === attempts - 1) throw error;
			const delayMs = resolveRetryDelayMs(error, attempt, { retryBaseDelayMs, retryAfterMaxMs });
			if (delayMs === undefined) throw error;
			await scheduler.wait(delayMs, { signal });
			continue;
		}

		if (!isOneshotRetryableMessage(message)) return message;
		lastResult = message;
		if (attempt === attempts - 1 || signal?.aborted) return message;
		const delayMs = resolveRetryDelayMs(message, attempt, { retryBaseDelayMs, retryAfterMaxMs });
		if (delayMs === undefined) return message;
		await scheduler.wait(delayMs, { signal });
	}
	// Unreachable for attempts >= 1 — every iteration returns or throws.
	return lastResult as T;
}
