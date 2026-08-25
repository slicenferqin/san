import * as stats from "@san/stats";
import * as openUtils from "../../utils/open";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	port: number;
	host: string;
	stop: () => void;
	token?: string;
}

export interface StatsDashboardArgs {
	port: number;
	host: string;
	/** Auth token for non-loopback binds; falls back to SAN_STATS_TOKEN. */
	token?: string;
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

const STATS_DASHBOARD_USAGE = "Usage: /stats [--port <port>] [--host <host>] [--token <secret>]";

function parsePort(value: string | undefined): number | string {
	if (!value) return `Missing port. ${STATS_DASHBOARD_USAGE}`;
	if (!/^\d+$/.test(value)) return `Invalid port: ${value}`;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return `Invalid port: ${value}`;
	return port;
}
function parseHost(value: string | undefined): string | { error: string } {
	if (!value) return { error: `Missing host. ${STATS_DASHBOARD_USAGE}` };
	const normalized = value.trim().replace(/^\[|\]$/g, "");
	if (!normalized || /[\s/]/.test(normalized)) return { error: `Invalid host: ${value}` };
	return normalized;
}

function parseToken(value: string | undefined): string | { error: string } {
	if (!value) return { error: `Missing token. ${STATS_DASHBOARD_USAGE}` };
	if (!/[\s/]/.test(value)) return value;
	return { error: `Invalid token: ${value}` };
}

export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let port = DEFAULT_STATS_DASHBOARD_PORT;
	let host = stats.DEFAULT_STATS_HOST;
	let token: string | undefined;

	for (let i = 0; i < tokens.length; i++) {
		const tokenArg = tokens[i];
		if (tokenArg === "--port" || tokenArg === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (tokenArg.startsWith("--port=")) {
			const parsed = parsePort(tokenArg.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (tokenArg === "--host" || tokenArg === "-H") {
			const parsed = parseHost(tokens[++i]);
			if (typeof parsed !== "string") return parsed;
			host = parsed;
			continue;
		}
		if (tokenArg.startsWith("--host=")) {
			const parsed = parseHost(tokenArg.slice("--host=".length));
			if (typeof parsed !== "string") return parsed;
			host = parsed;
			continue;
		}
		if (tokenArg === "--token" || tokenArg === "-t") {
			const parsed = parseToken(tokens[++i]);
			if (typeof parsed !== "string") return parsed;
			token = parsed;
			continue;
		}
		if (tokenArg.startsWith("--token=")) {
			const parsed = parseToken(tokenArg.slice("--token=".length));
			if (typeof parsed !== "string") return parsed;
			token = parsed;
			continue;
		}
		return { error: `Unknown option: ${tokenArg}. ${STATS_DASHBOARD_USAGE}` };
	}

	return token === undefined ? { port, host } : { port, host, token };
}

export async function launchStatsDashboard(args: StatsDashboardArgs): Promise<StatsDashboardLaunchResult> {
	if (process.env.SAN_BUILD_PROFILE === "core") {
		throw new Error("The stats dashboard is not included in the San core binary; use `san stats --summary` instead.");
	}
	const { processed, files } = await stats.syncAllSessions();
	const total = await stats.getTotalMessageCount();
	let requestedHostOrPortIgnored = false;

	const requestedToken = args.token ?? Bun.env.SAN_STATS_TOKEN;
	if (!activeStatsServer) {
		// Non-loopback binds refuse to start without a token (the API exposes
		// session contents); SAN_STATS_TOKEN is the env escape hatch.
		const server = await stats.startServer(
			args.port,
			args.host,
			requestedToken !== undefined ? { token: requestedToken } : undefined,
		);
		activeStatsServer = requestedToken === undefined ? server : { ...server, token: requestedToken };
	} else if (args.host !== activeStatsServer.host || args.port !== activeStatsServer.port) {
		requestedHostOrPortIgnored = true;
	}

	const url = stats.formatStatsUrl(activeStatsServer.host, activeStatsServer.port);
	// On authenticated binds the token rides in the link once so the dashboard
	// can pick it up and drop it from the address bar. Keep the credential that
	// belongs to the active server when subsequent /stats calls reuse it.
	const token = activeStatsServer.token;
	openUtils.openPath(token ? `${url}/?token=${encodeURIComponent(token)}` : url);

	const serverLine = requestedHostOrPortIgnored
		? `Dashboard already running at: ${url} (requested ${args.host}:${args.port} ignored)`
		: `Dashboard available at: ${url}`;

	return {
		url,
		message: `Synced ${processed} new entries from ${files} files (${total} total)\n${serverLine}`,
	};
}

export function stopStatsDashboard(): void {
	if (!activeStatsServer) return;
	activeStatsServer.stop();
	activeStatsServer = undefined;
	stats.closeDb();
}
