import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { buildUsageAnalytics } from "@san/coding-agent/modes/rpc-v2/usage-analytics";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RPC v2 usage analytics", () => {
	test("aggregates active-session provider, model, cache, timing, and tool-call usage", async () => {
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		const now = new Date("2026-07-24T12:00:00.000Z");
		const message: AssistantMessage = {
			...createAssistantMessage("done"),
			content: [
				{ type: "text", text: "done" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "state.txt" } },
			],
			provider: "anthropic",
			model: "claude-sonnet",
			timestamp: now.getTime(),
			duration: 2_000,
			ttft: 100,
			usage: {
				input: 100,
				output: 50,
				reasoningTokens: 10,
				cacheRead: 25,
				cacheWrite: 5,
				totalTokens: 180,
				premiumRequests: 1,
				cost: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.05, total: 0.5 },
			},
		};

		const analytics = await buildUsageAnalytics({
			activeSession: {
				sessionId: "session-active",
				title: "Active session",
				cwd: "/workspace",
				messages: [message],
			},
			days: 2,
			sessionLimit: 5,
			now,
		});

		expect(analytics).toMatchObject({
			generatedAt: now.toISOString(),
			days: 2,
			sessionCount: 1,
			persistedSessionCount: 0,
			activeSessionIncluded: true,
			sessionsTruncated: false,
			totals: {
				requests: 1,
				inputTokens: 100,
				outputTokens: 50,
				reasoningTokens: 10,
				cacheReadTokens: 25,
				cacheWriteTokens: 5,
				totalTokens: 180,
				costUsd: 0.5,
				premiumRequests: 1,
				toolCalls: 1,
				failures: 0,
				aborted: 0,
				durationMs: 2_000,
				averageTtftMs: 100,
				tokensPerSecond: 25,
				cacheHitRate: 25 / 130,
				successRate: 1,
			},
			currentSession: {
				sessionId: "session-active",
				title: "Active session",
				provider: "anthropic",
				model: "claude-sonnet",
				requests: 1,
			},
		});
		expect(analytics.byProvider).toEqual([
			expect.objectContaining({ key: "anthropic", requests: 1, totalTokens: 180 }),
		]);
		expect(analytics.byModel).toEqual([
			expect.objectContaining({ key: "anthropic/claude-sonnet", requests: 1, totalTokens: 180 }),
		]);
		expect(analytics.daily).toHaveLength(2);
		expect(analytics.daily.at(-1)).toMatchObject({ date: "2026-07-24", requests: 1, totalTokens: 180 });
		expect(analytics.sessions).toEqual([
			expect.objectContaining({ sessionId: "session-active", requests: 1, totalTokens: 180 }),
		]);
	});
	test("excludes out-of-window usage from totals and breakdowns but keeps it in the session summary", async () => {
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		const now = new Date("2026-07-24T12:00:00.000Z");
		const base = createAssistantMessage("done");
		const recent: AssistantMessage = {
			...base,
			provider: "anthropic",
			model: "claude-sonnet",
			timestamp: now.getTime(),
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stale: AssistantMessage = {
			...base,
			provider: "openai",
			model: "gpt-x",
			timestamp: now.getTime() - 30 * 86_400_000,
			usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};

		const analytics = await buildUsageAnalytics({
			activeSession: {
				sessionId: "session-active",
				cwd: "/workspace",
				messages: [stale, recent],
			},
			days: 7,
			now,
		});

		// 窗口外（30 天前）的 1500 token 不得计入任何全局聚合。
		expect(analytics.totals.totalTokens).toBe(15);
		expect(analytics.totals.requests).toBe(1);
		expect(analytics.byProvider).toEqual([expect.objectContaining({ key: "anthropic", totalTokens: 15 })]);
		expect(analytics.byModel).toEqual([expect.objectContaining({ key: "anthropic/claude-sonnet", totalTokens: 15 })]);
		expect(analytics.daily.reduce((sum, d) => sum + d.totalTokens, 0)).toBe(15);
		// 会话级 summary 仍是全时段口径。
		expect(analytics.sessions[0]).toMatchObject({ requests: 2, totalTokens: 1515 });
	});

});
