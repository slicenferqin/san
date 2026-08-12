import { extractHttpStatusFromError } from "@san/utils";
import { isAccountPolicyError, isOAuthExpiry, isUsageLimit } from "./flags";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an OAuth refresh failure is definitive (the credential must be
 * disabled) versus transient. Thin alias over the {@link Flag.OAuthExpiry}
 * text classifier {@link isOAuthExpiry}; retained as the public
 * `@san/ai` entrypoint name used by the coding agent and auth-broker.
 */
export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	return isOAuthExpiry(errorMsg);
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

/** Whether an upstream response explicitly says the supplied OAuth bearer was invalidated. */
export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errorMessage = error.errorMessage;
		if (typeof errorMessage === "string" && INVALIDATED_OAUTH_TOKEN_PATTERN.test(errorMessage)) return true;
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message);
}

/**
 * 判断上游失败是否值得进入兄弟凭证轮换：401/403、账号策略拒绝、账号额度耗尽，
 * 或缺少可判别正文的 429。并发上限与普通分钟限速仍由上游退避层处理。
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	const status = httpStatus ?? embeddedStatus;
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (status === 401 || status === 403) return true;
	return isUsageLimitOutcome(status, message);
}
