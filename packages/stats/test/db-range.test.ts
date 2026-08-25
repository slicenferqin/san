import { describe, expect, it } from "bun:test";
import { getDashboardStats, getUsageAnalyticsStats } from "@san/stats/aggregator";
import { initDb, insertMessageStats } from "@san/stats/db";
import type { MessageStats } from "@san/stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-range-");

function makeMessage(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

function makeAnalyticsMessage(
	timestamp: number,
	entryId: string,
	options: {
		folder: string;
		model: string;
		provider: string;
		stopReason: "stop" | "error";
		duration: number;
		ttft: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		costInput: number;
		costOutput: number;
		costCacheRead: number;
		costCacheWrite: number;
	},
): MessageStats {
	const totalTokens = options.input + options.output + options.cacheRead + options.cacheWrite;
	const totalCost = options.costInput + options.costOutput + options.costCacheRead + options.costCacheWrite;
	return {
		...makeMessage(timestamp, entryId),
		folder: options.folder,
		model: options.model,
		provider: options.provider,
		duration: options.duration,
		ttft: options.ttft,
		stopReason: options.stopReason,
		errorMessage: options.stopReason === "error" ? "request failed" : null,
		usage: {
			input: options.input,
			output: options.output,
			cacheRead: options.cacheRead,
			cacheWrite: options.cacheWrite,
			totalTokens,
			cost: {
				input: options.costInput,
				output: options.costOutput,
				cacheRead: options.costCacheRead,
				cacheWrite: options.costCacheWrite,
				total: totalCost,
			},
		},
	};
}
describe("getDashboardStats time range", () => {
	it("filters dashboard stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const dayStats = await getDashboardStats("24h");
		expect(dayStats.overall.totalRequests).toBe(1);
		expect(dayStats.byModel[0]).toMatchObject({
			totalRequests: 1,
			model: "gpt-5.4",
			provider: "openai-codex",
		});

		const weekStats = await getDashboardStats("7d");
		expect(weekStats.overall.totalRequests).toBe(2);
		expect(weekStats.byModel[0]).toMatchObject({ totalRequests: 2, model: "gpt-5.4", provider: "openai-codex" });

		const allStats = await getDashboardStats("all");
		expect(allStats.overall.totalRequests).toBe(2);
	});

	it("falls back to 24h for unknown range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const stats = await getDashboardStats("last century");
		expect(stats.overall.totalRequests).toBe(1);
	});
	it("returns one consistent usage payload across summary and dimensions", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([
			makeAnalyticsMessage(now - 1_000, "usage-success", {
				folder: "/tmp/alpha",
				model: "model-a",
				provider: "provider-a",
				stopReason: "stop",
				duration: 1_000,
				ttft: 100,
				input: 100,
				output: 40,
				cacheRead: 60,
				cacheWrite: 10,
				costInput: 0.1,
				costOutput: 0.2,
				costCacheRead: 0.03,
				costCacheWrite: 0.01,
			}),
			makeAnalyticsMessage(now - 2_000, "usage-error", {
				folder: "/tmp/beta",
				model: "model-b",
				provider: "provider-b",
				stopReason: "error",
				duration: 2_000,
				ttft: 200,
				input: 200,
				output: 80,
				cacheRead: 0,
				cacheWrite: 20,
				costInput: 0.2,
				costOutput: 0.4,
				costCacheRead: 0,
				costCacheWrite: 0.02,
			}),
			makeMessage(now - 48 * 60 * 60 * 1000, "usage-outside"),
		]);

		const stats = await getUsageAnalyticsStats("24h");

		expect(stats.range).toBe("24h");
		expect(stats.summary).toMatchObject({
			totalRequests: 2,
			successfulRequests: 1,
			failedRequests: 1,
			successRate: 0.5,
			totalInputTokens: 300,
			totalOutputTokens: 120,
			totalCacheReadTokens: 60,
			totalCacheWriteTokens: 30,
			totalTokens: 510,
			cacheRate: 1 / 6,
			avgTtft: 150,
			weightedTokensPerSecond: 40,
		});
		expect(stats.summary.totalCost).toBeCloseTo(0.96, 10);
		expect(stats.summary.costInput).toBeCloseTo(0.3, 10);
		expect(stats.summary.costOutput).toBeCloseTo(0.6, 10);
		expect(stats.trend[0]).toMatchObject({ requests: 2, totalTokens: 510, successRate: 0.5 });
		expect(stats.trend[0]?.cost).toBeCloseTo(0.96, 10);
		expect(stats.byProvider.map(item => item.provider).sort()).toEqual(["provider-a", "provider-b"]);
		expect(stats.byModel.map(item => item.model).sort()).toEqual(["model-a", "model-b"]);
		expect(stats.byProject.map(item => item.project).sort()).toEqual(["/tmp/alpha", "/tmp/beta"]);
		expect(stats.trend).toHaveLength(1);
	});
});

it("applies provider and model filters to every usage view", async () => {
	await initDb();
	const now = Date.now();
	insertMessageStats([
		makeAnalyticsMessage(now - 1_000, "filter-a", {
			folder: "/tmp/alpha",
			model: "model-a",
			provider: "provider-a",
			stopReason: "stop",
			duration: 1_000,
			ttft: 100,
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 10,
			costInput: 0.1,
			costOutput: 0.2,
			costCacheRead: 0.03,
			costCacheWrite: 0.01,
		}),
		makeAnalyticsMessage(now - 2_000, "filter-b", {
			folder: "/tmp/beta",
			model: "model-b",
			provider: "provider-b",
			stopReason: "error",
			duration: 2_000,
			ttft: 200,
			input: 200,
			output: 80,
			cacheRead: 0,
			cacheWrite: 20,
			costInput: 0.2,
			costOutput: 0.4,
			costCacheRead: 0,
			costCacheWrite: 0.02,
		}),
	]);

	const filtered = await getUsageAnalyticsStats("24h", { provider: "provider-a", model: null });
	expect(filtered.filters).toEqual({ provider: "provider-a", model: null });
	expect(filtered.summary).toMatchObject({ totalRequests: 1, totalCacheReadTokens: 60, cacheRate: 0.375 });
	expect(filtered.byProvider.map(item => item.provider)).toEqual(["provider-a"]);
	expect(filtered.byModel.map(item => item.model)).toEqual(["model-a"]);
	expect(filtered.byProject.map(item => item.project)).toEqual(["/tmp/alpha"]);
	expect(filtered.trend).toHaveLength(1);
	expect(filtered.trend[0]).toMatchObject({ requests: 1, totalTokens: 210 });
	expect(filtered.options.providers).toEqual(["provider-a", "provider-b"]);
	expect(filtered.options.models).toEqual([
		{ model: "model-a", provider: "provider-a" },
		{ model: "model-b", provider: "provider-b" },
	]);

	const modelFiltered = await getUsageAnalyticsStats("24h", { provider: "provider-b", model: "model-b" });
	expect(modelFiltered.summary).toMatchObject({ totalRequests: 1, failedRequests: 1, totalOutputTokens: 80 });
	expect(modelFiltered.byProject.map(item => item.project)).toEqual(["/tmp/beta"]);
});
