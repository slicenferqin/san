import { createHash, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
import { $ } from "bun";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getToolDashboardStats,
	getTotalMessageCount,
	syncAllSessions,
} from "./aggregator";
import { decodeEmbeddedClientArchive } from "./embedded-client";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import { getGainDashboardStats } from "./gain-aggregator";

const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);

/** Loopback-only bind host for the stats dashboard. */
export const DEFAULT_STATS_HOST = "127.0.0.1";

/** Identity reported (and probed for) by the stats dashboard's health endpoint. */
const STATS_SERVER_NAME = "san-stats";

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
// The prepacked npm bundle (coding-agent dist/cli.js) constant-folds
// process.env.PI_BUNDLED at build time. Like compiled binaries, it ships no
// dashboard sources or prebuilt dist/client next to the bundle, so the
// embedded archive is the only viable asset source.
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;

const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "san-stats-client");
let embeddedClientDirPromise: Promise<string> | null = null;

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STATIC_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;

	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded stats client bundle missing. Rebuild the San binary or npm bundle with embedded stats assets.",
		);
	}

	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();

	return embeddedClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Tolerate missing source trees (e.g. installs without the dashboard
		// sources); the caller falls back to prebuilt assets or a clear build
		// failure instead of crashing on the scan.
		if (isEnoent(err)) return 0;
		throw err;
	}

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (USE_EMBEDDED_CLIENT) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building stats client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}

	const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

	await Bun.write(path.join(STATIC_DIR, "index.html"), indexHtml);
};

/**
 * Handle API requests.
 */
export async function handleApi(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	// Stats reads are DB-only; explicit /api/sync does the expensive session scan.
	const range = url.searchParams.get("range");

	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/behavior") {
		const stats = await getBehaviorDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/tools") {
		const stats = await getToolDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byFolder);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/sync") {
		const result = await syncAllSessions();
		const count = await getTotalMessageCount();
		return Response.json({ ...result, totalMessages: count });
	}

	if (path === "/api/stats/gain") {
		const project = url.searchParams.get("project");
		const stats = await getGainDashboardStats(range, project);
		return Response.json(stats);
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(staticDir, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(staticDir, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

// =============================================================================
// Bind host handling
// =============================================================================

/**
 * Normalize a bind-host value: trim whitespace, strip surrounding IPv6
 * brackets, and reject empty, whitespace-bearing, or path-like inputs.
 */
export function normalizeStatsHost(host: string): string {
	const normalized = host.trim().replace(/^\[|\]$/g, "");
	if (!normalized || /[\s/]/.test(normalized)) {
		throw new Error(`Invalid stats host: ${host}`);
	}
	return normalized;
}

/**
 * Format a stats dashboard URL, bracketing IPv6 literals so the link is valid.
 */
export function formatStatsUrl(host: string, port: number): string {
	const normalized = normalizeStatsHost(host);
	const hostPart = normalized.includes(":") ? `[${normalized}]` : normalized;
	return `http://${hostPart}:${port}`;
}

/** Wildcard bind hosts by IP family. */
function wildcardFamily(host: string): "ipv4" | "ipv6" | null {
	if (host === "0.0.0.0") return "ipv4";
	if (host === "::") return "ipv6";
	return null;
}

/**
 * Whether a bind host only listens on the machine's own loopback interfaces.
 * Anything else (wildcards, LAN IPs, hostnames resolving off-box) exposes the
 * dashboard to other clients and requires an auth token.
 */
export function isLoopbackStatsHost(host: string): boolean {
	const normalized = normalizeStatsHost(host);
	if (normalized === "localhost" || normalized === "::1") return true;
	// The whole 127.0.0.0/8 block is loopback.
	return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/** Constant-time token comparison: hashing both sides equalizes lengths. */
function statsTokensMatch(provided: string, expected: string): boolean {
	const providedDigest = createHash("sha256").update(provided).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(providedDigest, expectedDigest);
}

/** Bearer token from the Authorization header or a `?token=` query parameter. */
function requestStatsToken(req: Request, url: URL): string {
	const header = req.headers.get("authorization");
	if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
	const query = url.searchParams.get("token");
	return query !== null ? query.trim() : "";
}

async function resolveHostAddresses(host: string): Promise<string[]> {
	try {
		const entries = await dnsLookup(host, { all: true });
		return entries.map(entry => `${entry.family === 4 ? "ipv4" : "ipv6"}:${entry.address.toLowerCase()}`);
	} catch {
		return [];
	}
}

/**
 * Whether an existing instance bound to `foundHost` serves the requested
 * `host`. A wildcard only matches the same-family wildcard; a wildcard
 * instance serves same-family specific targets; two specific hosts compare
 * resolved address sets so `localhost` matches a `127.0.0.1` instance.
 */
async function statsHostsCompatible(requested: string, foundHost: string): Promise<boolean> {
	const requestedHost = normalizeStatsHost(requested);
	const foundHostNormalized = normalizeStatsHost(foundHost);
	if (requestedHost === foundHostNormalized) return true;

	const requestedWildcard = wildcardFamily(requestedHost);
	if (requestedWildcard) return wildcardFamily(foundHostNormalized) === requestedWildcard;

	const foundWildcard = wildcardFamily(foundHostNormalized);
	if (foundWildcard) return (requestedHost.includes(":") ? "ipv6" : "ipv4") === foundWildcard;

	const requestedAddresses = await resolveHostAddresses(requestedHost);
	const foundAddresses = await resolveHostAddresses(foundHostNormalized);
	return requestedAddresses.length > 0 && requestedAddresses.some(address => foundAddresses.includes(address));
}

/** Address to probe for a requested bind host (wildcards probe loopback). */
function probeHostFor(host: string): string {
	const normalized = normalizeStatsHost(host);
	if (normalized === "0.0.0.0") return "127.0.0.1";
	if (normalized === "::") return "::1";
	return normalized;
}

type ProbeResult =
	| { kind: "available" }
	| { kind: "reusable"; foundHost: string }
	| { kind: "different-host"; foundHost: string }
	| { kind: "unidentified" };

/**
 * Probe a host:port for an existing San stats dashboard. Refused or timed-out
 * connections mean the port is free to bind; a responding service that does
 * not identify as San stats (or is bound to a different host) is left alone.
 */
async function probeStatsServer(host: string, port: number): Promise<ProbeResult> {
	const probeUrl = `${formatStatsUrl(probeHostFor(host), port)}/api/health`;
	let response: Response;
	try {
		response = await fetch(probeUrl, { signal: AbortSignal.timeout(500) });
	} catch {
		return { kind: "available" };
	}
	if (!response.ok) return { kind: "unidentified" };
	let health: { status?: unknown; name?: unknown; host?: unknown } | null = null;
	try {
		health = (await response.json()) as { status?: unknown; name?: unknown; host?: unknown } | null;
	} catch {
		return { kind: "unidentified" };
	}
	if (health?.status !== "ok" || health?.name !== STATS_SERVER_NAME || typeof health?.host !== "string") {
		return { kind: "unidentified" };
	}
	const compatible = await statsHostsCompatible(host, health.host);
	return compatible
		? { kind: "reusable", foundHost: health.host }
		: { kind: "different-host", foundHost: health.host };
}

/**
 * Handle returned by {@link startServer}.
 */
export interface StatsServerHandle {
	port: number;
	host: string;
	/** True when a confirmed dashboard already serving this host:port was reused. */
	reused: boolean;
	stop: () => void;
}

/**
 * Start the HTTP server.
 *
 * Binds loopback-only by default ({@link DEFAULT_STATS_HOST}); an explicit
 * host (e.g. `0.0.0.0` in containers) is honored as-is but requires an auth
 * token — the API serves session contents, cost data, and can trigger syncs,
 * so a remotely reachable bind must never be anonymous.
 *
 * When a confirmed San stats dashboard is already serving the requested
 * host:port it is reused instead of failing or taking the port over. An
 * unidentified process, or an instance bound to a different host, is never
 * reused, stopped, or taken over.
 */
export async function startServer(
	port = 3847,
	host = DEFAULT_STATS_HOST,
	options?: { token?: string },
): Promise<StatsServerHandle> {
	const normalizedHost = normalizeStatsHost(host);
	const loopback = isLoopbackStatsHost(normalizedHost);
	const token = options?.token?.trim() ?? "";
	if (!loopback && token === "") {
		throw new Error(
			`Refusing to expose the stats dashboard on ${formatStatsUrl(normalizedHost, port)} without authentication: ` +
				"the dashboard API exposes session contents and cost data. Start it with --token <secret> " +
				"(or SAN_STATS_TOKEN), or bind a loopback host such as 127.0.0.1.",
		);
	}

	// `port: 0` means "pick a free port" and has nothing to probe.
	if (port > 0) {
		const probe = await probeStatsServer(normalizedHost, port);
		if (probe.kind === "reusable") {
			return { port, host: normalizedHost, reused: true, stop: () => {} };
		}
		if (probe.kind === "different-host") {
			throw new Error(
				`Port ${port} is already in use by a San stats dashboard bound to ${probe.foundHost}; ` +
					`refusing to start another instance on ${formatStatsUrl(normalizedHost, port)}.`,
			);
		}
		if (probe.kind === "unidentified") {
			throw new Error(
				`Port ${port} on ${normalizedHost} is already in use by a process that is not a San stats ` +
					"dashboard; refusing to take it over.",
			);
		}
	}

	await ensureClientBuild();

	try {
		const server = Bun.serve({
			hostname: normalizedHost,
			port,
			async fetch(req) {
				const url = new URL(req.url);
				const path = url.pathname;

				// Identity endpoint used to confirm an already-running San
				// stats dashboard before reusing its host:port. Identity only —
				// no data, so it stays reachable without a token.
				if (path === "/api/health") {
					return Response.json({ status: "ok", name: STATS_SERVER_NAME, host: normalizedHost });
				}

				// Loopback serves local development, so cross-origin tooling may
				// read the API. A remotely exposed bind must not: every response
				// carrying data stays same-origin only.
				const corsHeaders: Record<string, string> = loopback
					? {
							"Access-Control-Allow-Origin": "*",
							"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
							"Access-Control-Allow-Headers": "Content-Type, Authorization",
						}
					: {};

				if (req.method === "OPTIONS") {
					return new Response(null, { headers: corsHeaders });
				}

				// Remote binds authenticate every API route (static assets carry
				// no data; the browser UI picks the token up from ?token=).
				if (!loopback && path.startsWith("/api/")) {
					if (!statsTokensMatch(requestStatsToken(req, url), token)) {
						return new Response("Unauthorized", { status: 401, headers: corsHeaders });
					}
				}

				try {
					let response: Response;

					if (path.startsWith("/api/")) {
						response = await handleApi(req);
					} else {
						response = await handleStatic(path);
					}

					// Add CORS headers to all responses
					const headers = new Headers(response.headers);
					for (const [key, value] of Object.entries(corsHeaders)) {
						headers.set(key, value);
					}

					return new Response(response.body, {
						status: response.status,
						headers,
					});
				} catch (error) {
					console.error("Server error:", error);
					return Response.json(
						{ error: error instanceof Error ? error.message : "Unknown error" },
						{ status: 500, headers: corsHeaders },
					);
				}
			},
		});

		return {
			port: server.port ?? port,
			host: normalizedHost,
			reused: false,
			stop: () => server.stop(),
		};
	} catch (error) {
		throw new Error(
			`Could not bind the stats dashboard to ${formatStatsUrl(normalizedHost, port)}: ` +
				"the address appears to be in use by another process. Stop the conflicting process and retry.",
			{ cause: error },
		);
	}
}
