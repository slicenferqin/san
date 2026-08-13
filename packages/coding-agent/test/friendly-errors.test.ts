/**
 * Friendly error headlines (move-in-ready principle: errors tell the user
 * where it's stuck and what to do next, in plain language, with the raw
 * diagnostic preserved below).
 *
 * Contract: known failure families map to a headline + actionable next step;
 * unknown errors pass through untouched (never mislabel); the raw message is
 * always preserved verbatim in the combined rendering.
 */

import { describe, expect, test } from "bun:test";
import { friendlyErrorSummary, withFriendlyHeadline } from "../src/modes/utils/friendly-errors";

describe("friendlyErrorSummary", () => {
	test("classifies credential rejections to an /auth next step", () => {
		for (const sample of [
			"HTTP 401 Unauthorized",
			"invalid api key provided",
			"OAuth token expired, please re-authenticate",
			"invalidated oauth token",
		]) {
			const summary = friendlyErrorSummary(sample);
			expect(summary?.nextStep).toContain("/auth");
		}
	});

	test("classifies quota exhaustion separately from rate limiting", () => {
		expect(friendlyErrorSummary("usage limit reached for this billing cycle")?.headline).toContain("额度");
		expect(friendlyErrorSummary("HTTP 429 Too Many Requests, retry-after: 30")?.headline).toContain("限流");
	});

	test("classifies context-window overflow to a /compact next step", () => {
		expect(friendlyErrorSummary("prompt is too long: maximum context length exceeded")?.nextStep).toContain(
			"/compact",
		);
	});

	test("classifies network failures and provider outages", () => {
		expect(friendlyErrorSummary("fetch failed: ECONNREFUSED 127.0.0.1:443")?.headline).toContain("网络");
		expect(friendlyErrorSummary("HTTP 503 error: service unavailable / overloaded")?.headline).toContain("服务商");
	});

	test("returns undefined for unknown errors — never mislabels", () => {
		expect(friendlyErrorSummary("Something inexplicably odd happened")).toBeUndefined();
		expect(friendlyErrorSummary("")).toBeUndefined();
	});
});

describe("withFriendlyHeadline", () => {
	test("prepends the headline and next step while preserving the raw diagnostic verbatim", () => {
		const raw = "HTTP 401 Unauthorized: invalid api key";
		const combined = withFriendlyHeadline(raw);
		expect(combined).toContain("→");
		expect(combined.endsWith(raw)).toBe(true);
		expect(combined.indexOf("→")).toBeLessThan(combined.indexOf(raw));
	});

	test("passes unknown errors through byte-identical", () => {
		const raw = "totally novel failure mode";
		expect(withFriendlyHeadline(raw)).toBe(raw);
	});
});
