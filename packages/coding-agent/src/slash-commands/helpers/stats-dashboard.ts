import * as stats from "@san/stats";
import * as openUtils from "../../utils/open";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	port: number;
	host: string;
	stop: () => void;
}

export interface StatsDashboardArgs {
	port: number;
	host: string;
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

const STATS_DASHBOARD_USAGE = "Usage: /stats [--port <port>] [--host <host>]";

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

export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let port = DEFAULT_STATS_DASHBOARD_PORT;
	let host = stats.DEFAULT_STATS_HOST;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--port" || token === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token.startsWith("--port=")) {
			const parsed = parsePort(token.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token === "--host" || token === "-H") {
			const parsed = parseHost(tokens[++i]);
			if (typeof parsed !== "string") return parsed;
			host = parsed;
			continue;
		}
		if (token.startsWith("--host=")) {
			const parsed = parseHost(token.slice("--host=".length));
			if (typeof parsed !== "string") return parsed;
			host = parsed;
			continue;
		}
		return { error: `Unknown option: ${token}. ${STATS_DASHBOARD_USAGE}` };
	}

	return { port, host };
}

export async function launchStatsDashboard(args: StatsDashboardArgs): Promise<StatsDashboardLaunchResult> {
	if (process.env.SAN_BUILD_PROFILE === "core") {
		throw new Error("The stats dashboard is not included in the San core binary; use `san stats --summary` instead.");
	}
	const { processed, files } = await stats.syncAllSessions();
	const total = await stats.getTotalMessageCount();
	let requestedHostOrPortIgnored = false;

	if (!activeStatsServer) {
		activeStatsServer = await stats.startServer(args.port, args.host);
	} else if (args.host !== activeStatsServer.host || args.port !== activeStatsServer.port) {
		requestedHostOrPortIgnored = true;
	}

	const url = stats.formatStatsUrl(activeStatsServer.host, activeStatsServer.port);
	openUtils.openPath(url);

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
