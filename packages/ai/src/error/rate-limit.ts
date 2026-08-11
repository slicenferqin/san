/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000; // 5s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
	return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;
// gRPC/Connect 尾帧会携带 resource_exhausted 状态名；先剥离状态词，
// 让正文中的额度、限速和服务端信号继续按其真实语义分类。
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
	// 必须在 concurrent 附近出现明确的上限信号；“不支持并发调用”不是临时并发上限。
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
	// “Rate limit will reset” 也可能是无状态码的分钟限速，因此 reset 分支必须带账号指向词。
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
// 简中持久额度耗尽：使用上限、额度/配额耗尽、限额重置、余额不足。
const CN_QUOTA_EXHAUSTED_PATTERN = /使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
// 同时含“使用/上限”的分钟、速率、频率、并发限制仍是瞬时限流。
const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;

/**
 * 将限流错误归类为账号额度、分钟限速、并发上限、模型容量或服务端错误。
 * 裸 `resource_exhausted` 属于瞬时模型容量；若正文另含额度或限速细节，则以正文为准。
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lowerWithStatus = errorMessage.toLowerCase();
	const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) {
		return "CONCURRENT_LIMIT";
	}

	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (matchesSubscriptionCapText(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		// xAI SuperGrok: HTTP 403 "run out of credits" / spending-limit is an
		// account-local cap — rotate, don't treat as auth failure.
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	if (hasResourceExhaustedStatus) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "CONCURRENT_LIMIT":
			return CONCURRENT_LIMIT_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * HTTP 402 Payment Required is categorically an account-billing cap (xAI
 * Grok Build "usage balance exhausted", DeepSeek "Insufficient Balance",
 * OpenRouter credit exhaustion) — never a transient blip or bad credential.
 * Always combine with {@link isUsageLimitOutcome} when a message is available
 * — a 429 carrying transient rate-limit wording is NOT a usage cap.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

/**
 * 判断是否应暂停当前凭证并轮换兄弟账号。
 * 明确的账号额度、账号级 403/无状态码尾帧以及不透明的 429/402 会轮换；
 * 非 402 的并发上限、分钟限速和服务容量问题留给调用方退避。
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	const isBillingCapStatus = status === 402;
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && matchesUsageLimitText(message)) return true;
	if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	const reason = parseRateLimitReason(message);
	return reason === "QUOTA_EXHAUSTED" || (isBillingCapStatus && reason === "CONCURRENT_LIMIT");
}

/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, the status digits with HTTP/JSON
 * framing, or generic punctuation. Anything else (retry hints, capacity
 * wording, error descriptions) is informative enough to defer to the
 * classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
		!CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
		!CN_THROTTLE_PATTERN.test(cleaned)
	);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		(CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		matchesSubscriptionCapText(errorMessage) ||
		OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
	);
}

/** 403 或无状态码尾帧中的账号级额度上限描述。 */
export function isAccountScopedCapText(message: string): boolean {
	return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

/** 非计费状态下的并发上限应退避，不应轮换凭证。 */
export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
