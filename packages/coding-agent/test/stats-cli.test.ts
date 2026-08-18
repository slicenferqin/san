import { describe, expect, it } from "bun:test";
import { DEFAULT_STATS_HOST, parseStatsArgs } from "@san/coding-agent/cli/stats-cli";
import { parseStatsDashboardArgs } from "@san/coding-agent/slash-commands/helpers/stats-dashboard";

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
