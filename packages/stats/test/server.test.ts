import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_STATS_HOST, formatStatsUrl, normalizeStatsHost, startServer } from "@san/stats";
import type { StatsServerHandle } from "@san/stats/server";
import type { UsageAnalyticsStats } from "@san/stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const handles: StatsServerHandle[] = [];
const foreignServers: ReturnType<typeof Bun.serve>[] = [];

function track(handle: StatsServerHandle): StatsServerHandle {
	handles.push(handle);
	return handle;
}

function trackForeign(server: ReturnType<typeof Bun.serve>): number {
	foreignServers.push(server);
	return server.port;
}

async function fetchHealth(port: number, host = "127.0.0.1"): Promise<Response> {
	return fetch(`${formatStatsUrl(host, port)}/api/health`);
}

afterEach(() => {
	for (const handle of handles.splice(0)) handle.stop();
	for (const server of foreignServers.splice(0)) server.stop();
});

describe("stats server bind host", () => {
	it("defaults to loopback-only 127.0.0.1", async () => {
		const server = track(await startServer(0));

		expect(server.host).toBe(DEFAULT_STATS_HOST);
		expect(server.port).toBeGreaterThan(0);
		expect(server.reused).toBe(false);

		const response = await fetchHealth(server.port);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			name: "san-stats",
			host: "127.0.0.1",
		});
	});

	it("propagates an explicit bind host", async () => {
		const server = track(await startServer(0, "0.0.0.0", { token: "secret-token" }));

		expect(server.host).toBe("0.0.0.0");

		// A wildcard bind still answers on loopback, and identifies its own host.
		const response = await fetchHealth(server.port);
		expect(response.status).toBe(200);
		expect((await response.json()) as { host: string }).toMatchObject({ host: "0.0.0.0" });
	});

	it("rejects invalid bind hosts", async () => {
		expect(() => normalizeStatsHost("")).toThrow(/Invalid stats host/);
		expect(() => normalizeStatsHost("  ")).toThrow(/Invalid stats host/);
		expect(() => normalizeStatsHost("a b")).toThrow(/Invalid stats host/);
		expect(() => normalizeStatsHost("::1/evil")).toThrow(/Invalid stats host/);
	});
});

describe("stats dashboard URL formatting", () => {
	it("formats IPv4 and hostname links without brackets", () => {
		expect(formatStatsUrl("127.0.0.1", 3847)).toBe("http://127.0.0.1:3847");
		expect(formatStatsUrl("localhost", 3847)).toBe("http://localhost:3847");
	});

	it("brackets IPv6 literals in links", () => {
		expect(formatStatsUrl("::1", 3847)).toBe("http://[::1]:3847");
		expect(formatStatsUrl("::", 8080)).toBe("http://[::]:8080");
	});

	it("normalizes pre-bracketed IPv6 input", () => {
		expect(normalizeStatsHost("[::1]")).toBe("::1");
		expect(formatStatsUrl("[::1]", 8383)).toBe("http://[::1]:8383");
	});

	it("drops whitespace around the host", () => {
		expect(normalizeStatsHost(" 127.0.0.1 ")).toBe("127.0.0.1");
	});
});

describe("stats server port conflict gating", () => {
	it("reuses a confirmed San stats instance on the same host and port", async () => {
		const first = track(await startServer(0, "127.0.0.1"));
		const second = track(await startServer(first.port, "127.0.0.1"));

		expect(second.reused).toBe(true);
		expect(second.port).toBe(first.port);
		expect(second.host).toBe(first.host);

		// The reuse handle must not stop the live dashboard it points at.
		second.stop();
		const response = await fetchHealth(first.port);
		expect(response.status).toBe(200);
	});

	it("reuses a confirmed instance whose wildcard bind serves the requested host", async () => {
		const first = track(await startServer(0, "0.0.0.0", { token: "secret-token" }));
		const second = track(await startServer(first.port, "127.0.0.1", { token: "secret-token" }));

		expect(second.reused).toBe(true);
		expect(second.port).toBe(first.port);
	});

	it("reuses a confirmed instance when the requested hostname resolves to its bind", async () => {
		const first = track(await startServer(0, "127.0.0.1"));
		const second = track(await startServer(first.port, "localhost"));

		expect(second.reused).toBe(true);
		expect(second.port).toBe(first.port);
	});

	it("refuses to reuse an instance bound to a different host and does not stop it", async () => {
		const first = track(await startServer(0, "127.0.0.1"));

		await expect(startServer(first.port, "0.0.0.0", { token: "secret-token" })).rejects.toThrow(
			/already in use by a San stats dashboard bound to 127\.0\.0\.1/,
		);

		// The conflicting instance is untouched and keeps serving.
		const response = await fetchHealth(first.port);
		expect(response.status).toBe(200);
	});

	it("refuses to take over an unidentified process and does not stop it", async () => {
		const foreignPort = trackForeign(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => Response.json({ status: "ok", name: "some-other-app" }),
			}),
		);

		await expect(startServer(foreignPort, "127.0.0.1")).rejects.toThrow(/not a San stats dashboard/);

		// The unidentified process keeps serving untouched.
		const response = await fetch(`http://127.0.0.1:${foreignPort}/api/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", name: "some-other-app" });
	});

	it("treats a non-JSON responder on the port as an unidentified process", async () => {
		const foreignPort = trackForeign(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response("plain text body"),
			}),
		);

		await expect(startServer(foreignPort, "127.0.0.1")).rejects.toThrow(/not a San stats dashboard/);
	});
});

describe("stats server remote-bind authentication", () => {
	// API routes touch the stats DB; keep them on a throwaway database.
	installStatsTestIsolation("stats-server-auth");

	it("refuses to start on a non-loopback host without a token", async () => {
		await expect(startServer(0, "0.0.0.0")).rejects.toThrow(/without authentication/);
		await expect(startServer(0, "::")).rejects.toThrow(/without authentication/);
	});

	it("authenticates every API route on a remote bind and keeps the health probe open", async () => {
		const server = track(await startServer(0, "0.0.0.0", { token: "sekrit" }));

		// Identity probe stays anonymous: port-reuse detection depends on it.
		expect((await fetchHealth(server.port)).status).toBe(200);

		const anon = await fetch(`http://127.0.0.1:${server.port}/api/stats`);
		expect(anon.status).toBe(401);
		const wrongToken = await fetch(`http://127.0.0.1:${server.port}/api/stats`, {
			headers: { Authorization: "Bearer not-the-token" },
		});
		expect(wrongToken.status).toBe(401);

		// Correct token reaches the API both as a header and as ?token= —
		// the browser dashboard opens via a tokenized link.
		const viaHeader = await fetch(`http://127.0.0.1:${server.port}/api/stats`, {
			headers: { Authorization: "Bearer sekrit" },
		});
		expect(viaHeader.status).toBe(200);
		const viaQuery = await fetch(`http://127.0.0.1:${server.port}/api/stats?token=sekrit`);
		expect(viaQuery.status).toBe(200);

		// Remote binds serve same-origin only: no cross-origin reads for
		// other websites even when the token is known.
		expect(viaHeader.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("reuses a remote dashboard only when its token is accepted", async () => {
		const first = track(await startServer(0, "0.0.0.0", { token: "sekrit" }));

		await expect(startServer(first.port, "0.0.0.0", { token: "wrong" })).rejects.toThrow(
			/supplied authentication token does not match/,
		);
		await expect(startServer(first.port, "127.0.0.1")).rejects.toThrow(
			/already in use by an authenticated San stats dashboard/,
		);

		const second = track(await startServer(first.port, "0.0.0.0", { token: "sekrit" }));
		expect(second.reused).toBe(true);
	});

	it("loopback binds stay anonymous and cross-origin-friendly", async () => {
		const server = track(await startServer(0, "127.0.0.1"));

		const response = await fetch(`http://127.0.0.1:${server.port}/api/stats`);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});
	it("serves the unified usage analytics payload", async () => {
		const server = track(await startServer(0, "0.0.0.0", { token: "sekrit" }));
		const response = await fetch(`http://127.0.0.1:${server.port}/api/stats/usage?range=24h`, {
			headers: { Authorization: "Bearer sekrit" },
		});

		expect(response.status).toBe(200);
		const payload = (await response.json()) as UsageAnalyticsStats;
		expect(payload.range).toBe("24h");
		expect(payload.summary).toMatchObject({ totalRequests: 0, totalTokens: 0, successRate: 0 });
		expect(payload.byProvider).toEqual([]);
		expect(payload.byModel).toEqual([]);
		expect(payload.byProject).toEqual([]);
		expect(payload.trend).toEqual([]);
	});
});
