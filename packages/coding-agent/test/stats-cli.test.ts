import { describe, expect, it, vi } from "bun:test";
import { DEFAULT_STATS_HOST, parseStatsArgs } from "@san/coding-agent/cli/stats-cli";
import {
	launchStatsDashboard,
	parseStatsDashboardArgs,
	stopStatsDashboard,
} from "@san/coding-agent/slash-commands/helpers/stats-dashboard";
import * as openUtils from "@san/coding-agent/utils/open";
import * as stats from "@san/stats";

describe("parseStatsArgs host plumbing", () => {
	it("defaults to the loopback host", () => {
		expect(parseStatsArgs(["stats"])).toEqual({
			port: 3847,
			host: DEFAULT_STATS_HOST,
			json: false,
			summary: false,
		});
	});

	it("parses --host with a value", () => {
		expect(parseStatsArgs(["stats", "--host", "0.0.0.0", "--port", "8080", "--json"])).toMatchObject({
			host: "0.0.0.0",
			port: 8080,
			json: true,
		});
	});

	it("parses token values in long and short forms", () => {
		expect(parseStatsArgs(["stats", "--host", "0.0.0.0", "--token", "secret"])).toMatchObject({
			host: "0.0.0.0",
			token: "secret",
		});
		expect(parseStatsArgs(["stats", "-t", "short-secret"])).toMatchObject({ token: "short-secret" });
	});
	it("parses --host=value and the -H short form", () => {
		expect(parseStatsArgs(["stats", "--host=::1"])).toMatchObject({ host: "::1" });
		expect(parseStatsArgs(["stats", "-H", "0.0.0.0"])).toMatchObject({ host: "0.0.0.0" });
	});

	it("returns undefined for non-stats commands", () => {
		expect(parseStatsArgs(["status"])).toBeUndefined();
	});
});

describe("parseStatsDashboardArgs host plumbing", () => {
	it("defaults to the loopback host and default port", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: 3847, host: "127.0.0.1" });
	});

	it("parses --host with a value next to --port", () => {
		expect(parseStatsDashboardArgs("--port 9000 --host 0.0.0.0")).toEqual({
			port: 9000,
			host: "0.0.0.0",
		});
	});

	it("parses --host=value and the -H short form", () => {
		expect(parseStatsDashboardArgs("--host=::1")).toEqual({ port: 3847, host: "::1" });
		expect(parseStatsDashboardArgs("-H [::1]")).toEqual({ port: 3847, host: "::1" });
	});

	it("rejects a missing host value", () => {
		const result = parseStatsDashboardArgs("--port 9000 --host");
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toMatch(/Missing host/);
	});

	it("rejects an invalid host value", () => {
		const result = parseStatsDashboardArgs("--host bad/host");
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toMatch(/Invalid host: bad\/host/);
	});
	it("rejects unknown options with usage", () => {
		const result = parseStatsDashboardArgs("--bogus");
		expect((result as { error: string }).error).toMatch(/Unknown option: --bogus/);
		expect((result as { error: string }).error).toContain("/stats [--port <port>] [--host <host>]");
	});
});

describe("launchStatsDashboard authentication", () => {
	it("opens an authenticated URL when the remote-bind token comes from SAN_STATS_TOKEN", async () => {
		const previousToken = Bun.env.SAN_STATS_TOKEN;
		Bun.env.SAN_STATS_TOKEN = "env-secret";
		const stop = vi.fn();
		vi.spyOn(stats, "syncAllSessions").mockResolvedValue({ processed: 2, files: 1 });
		vi.spyOn(stats, "getTotalMessageCount").mockResolvedValue(3);
		vi.spyOn(stats, "startServer").mockResolvedValue({
			port: 3847,
			host: "0.0.0.0",
			reused: false,
			stop,
		});
		vi.spyOn(stats, "closeDb").mockImplementation(() => {});
		const openPath = vi.spyOn(openUtils, "openPath").mockImplementation(() => {});

		try {
			await launchStatsDashboard({ port: 3847, host: "0.0.0.0" });
			delete Bun.env.SAN_STATS_TOKEN;
			await launchStatsDashboard({ port: 3847, host: "0.0.0.0" });

			expect(stats.startServer).toHaveBeenCalledTimes(1);
			expect(stats.startServer).toHaveBeenCalledWith(3847, "0.0.0.0", { token: "env-secret" });
			expect(openPath).toHaveBeenNthCalledWith(1, "http://0.0.0.0:3847/?token=env-secret");
			expect(openPath).toHaveBeenNthCalledWith(2, "http://0.0.0.0:3847/?token=env-secret");
		} finally {
			stopStatsDashboard();
			vi.restoreAllMocks();
			if (previousToken === undefined) delete Bun.env.SAN_STATS_TOKEN;
			else Bun.env.SAN_STATS_TOKEN = previousToken;
		}
	});
});
