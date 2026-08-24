/**
 * Stats CLI command handlers.
 *
 * Handles `san stats` subcommand for viewing AI usage statistics.
 */

import { truncateToWidth } from "@san/tui/utils";
import { APP_NAME, formatDuration, formatNumber, formatPercent } from "@san/utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

/** Loopback-only bind host for the stats dashboard server. */
export const DEFAULT_STATS_HOST = "127.0.0.1";

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
	/** Auth token for non-loopback binds; falls back to SAN_STATS_TOKEN. */
	token?: string;
}

// =============================================================================
// Argument Parser
// =============================================================================

/**
 * Parse stats subcommand arguments.
 * Returns undefined if not a stats command.
 */
export function parseStatsArgs(args: string[]): StatsCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "stats") {
		return undefined;
	}

	const result: StatsCommandArgs = {
		port: 3847,
		host: DEFAULT_STATS_HOST,
		json: false,
		summary: false,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			result.json = true;
		} else if (arg === "--summary" || arg === "-s") {
			result.summary = true;
		} else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = parseInt(arg.split("=")[1], 10);
		} else if ((arg === "--host" || arg === "-H") && i + 1 < args.length) {
			result.host = args[++i];
		} else if (arg.startsWith("--host=")) {
			result.host = arg.slice("--host=".length);
		} else if ((arg === "--token" || arg === "-t") && i + 1 < args.length) {
			result.token = args[++i];
		} else if (arg.startsWith("--token=")) {
			result.token = arg.slice("--token=".length);
		}
	}

	return result;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	if (process.env.SAN_BUILD_PROFILE === "core" && !cmd.json && !cmd.summary) {
		process.stderr.write(
			"The stats dashboard is not included in the San core binary; use --summary, --json, or the full binary.\n",
		);
		process.exitCode = 1;
		return;
	}
	// Lazy import to avoid loading stats module when not needed
	const { getDashboardStats, syncAllSessions, getTotalMessageCount, startServer, closeDb, formatStatsUrl } =
		await import("@san/stats");

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server. Non-loopback binds refuse to start without a
	// token (the API exposes session contents); SAN_STATS_TOKEN is the env escape hatch.
	const token = cmd.token ?? Bun.env.SAN_STATS_TOKEN;
	const server = await startServer(cmd.port, cmd.host, token !== undefined ? { token } : undefined);
	const url = formatStatsUrl(server.host, server.port);

	// Open browser. On authenticated binds the token rides in the link once so
	// the dashboard can pick it up and drop it from the address bar.
	const openUrl = token ? `${url}/?token=${encodeURIComponent(token)}` : url;
	console.log(
		server.reused
			? chalk.green(`Reusing existing dashboard at: ${url}`)
			: chalk.green(`Dashboard available at: ${url}`),
	);
	openPath(openUrl);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@san/stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

// =============================================================================
// Help
// =============================================================================

export function printStatsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} stats`)} - AI Usage Statistics Dashboard

${chalk.bold("Usage:")}
  ${APP_NAME} stats [options]

${chalk.bold("Options:")}
  -p, --port <port>  Port for the dashboard server (default: 3847)
  -H, --host <host>  Host to bind the dashboard server (default: 127.0.0.1)
  -t, --token <key>  Auth token required by non-loopback hosts (or SAN_STATS_TOKEN)
  -j, --json         Output stats as JSON and exit
  -s, --summary      Print summary to console and exit
  -h, --help         Show this help message

${chalk.bold("Examples:")}
  ${APP_NAME} stats              # Start dashboard server
  ${APP_NAME} stats --json       # Print stats as JSON
  ${APP_NAME} stats --summary    # Print summary to console and exit
  ${APP_NAME} stats --port 8080  # Start on custom port
  ${APP_NAME} stats --host 0.0.0.0 --port 8080 --token <secret>  # Expose on all interfaces (containers)

${chalk.bold("Metrics:")}
  - Total requests and error rate
  - Token usage (input, output, cache)
  - Cost breakdown
  - Average duration and time to first token (TTFT)
  - Tokens per second throughput
`);
}
