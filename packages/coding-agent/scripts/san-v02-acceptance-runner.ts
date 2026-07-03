#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { createSanLoopTaskAgentExecutor, isSanLoopTerminalStatus, runSanLoop, type SanLoopMode } from "../src/san-loop";
import { createAgentSession } from "../src/sdk";
import { buildSanLoopReportText } from "../src/slash-commands/helpers/san-loop-report";

export interface RunnerArgs {
	agentDir?: string;
	config?: string;
	cwd: string;
	expect: "terminal" | "passed";
	label: string;
	mode: SanLoopMode;
	objective: string;
	out?: string;
}

export interface AcceptanceRunOutput {
	ok: boolean;
	expectation: RunnerArgs["expect"];
	label: string;
	mode: SanLoopMode;
	objective: string;
	sessionFile?: string;
	status: string;
	finalVerdict: string | null;
	retryCount: number;
	maxRetries: number;
	transitions: number;
	reviewEntries: number;
	assignments: number;
	workerResults: number;
	reviewReports: number;
	decisions: number;
	changedFiles: string[];
	testsRun: string[];
	risks: string[];
	reportText: string;
	durationMs: number;
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-v02-acceptance-runner.ts [options] --objective <text>",
		"",
		"Options:",
		"  --agent-dir <path>     Agent dir with models.yml (default: PI_CODING_AGENT_DIR or ~/.omp/agent)",
		"  --config <path>        San config overlay (default: heterogeneous v0.2 overlay)",
		"  --cwd <path>           Workspace cwd for the run (default: current cwd)",
		"  --expect <terminal|passed>  Exit success condition (default: terminal)",
		"  --label <name>         Evidence label (default: san-v02-acceptance)",
		"  --mode <rush|smart|deep>    San loop mode (default: rush)",
		"  --out <path>           Write JSON evidence to this path",
	].join("\n");
}

function argValue(args: readonly string[], name: string): string | undefined {
	const prefix = `${name}=`;
	for (let index = 0; index < args.length; index++) {
		const value = args[index];
		if (value === name) return args[index + 1];
		if (value?.startsWith(prefix)) return value.slice(prefix.length);
	}
	return undefined;
}

function hasFlag(args: readonly string[], name: string): boolean {
	return args.includes(name);
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function resolvePath(value: string): string {
	return path.resolve(expandHome(value));
}

function parseMode(value: string | undefined): SanLoopMode {
	if (value === "smart" || value === "deep" || value === "rush") return value;
	return "rush";
}

function parseExpect(value: string | undefined): RunnerArgs["expect"] {
	return value === "passed" ? "passed" : "terminal";
}

function defaultConfigPath(): string {
	return path.resolve(import.meta.dir, "..", "examples", "config", "san-execution-loop-heterogeneous.yml");
}

function parseArgs(): RunnerArgs {
	const args = Bun.argv.slice(2);
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${usage()}\n`);
		process.exit(0);
	}

	const objective = argValue(args, "--objective")?.trim();
	if (!objective) {
		process.stderr.write(`${usage()}\n`);
		process.exit(2);
	}

	const cwd = resolvePath(argValue(args, "--cwd") ?? process.cwd());
	const agentDir = argValue(args, "--agent-dir") ?? process.env.PI_CODING_AGENT_DIR;
	const config = resolvePath(argValue(args, "--config") ?? defaultConfigPath());
	const out = argValue(args, "--out");

	return {
		agentDir: agentDir ? resolvePath(agentDir) : undefined,
		config,
		cwd,
		expect: parseExpect(argValue(args, "--expect")),
		label: argValue(args, "--label") ?? "san-v02-acceptance",
		mode: parseMode(argValue(args, "--mode")),
		objective,
		out: out ? resolvePath(out) : undefined,
	};
}

function maxTurnsForMode(settings: Settings, mode: SanLoopMode): number {
	switch (mode) {
		case "rush":
			return settings.get("san.executionLoop.budget.rushMaxTurns");
		case "smart":
			return settings.get("san.executionLoop.budget.smartMaxTurns");
		case "deep":
			return settings.get("san.executionLoop.budget.deepMaxTurns");
	}
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.trim().length > 0))];
}

export async function writeAcceptanceOutput(output: AcceptanceRunOutput, outPath: string | undefined): Promise<void> {
	const text = `${JSON.stringify(output, null, 2)}\n`;
	if (outPath) {
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await Bun.write(outPath, text);
	}
	await Bun.write(Bun.stdout, text);
}

export async function runAcceptanceTask(args: RunnerArgs): Promise<AcceptanceRunOutput> {
	const startedAt = Date.now();
	const settings = await Settings.init({
		cwd: args.cwd,
		agentDir: args.agentDir,
		configFiles: args.config ? [args.config] : undefined,
	});
	const created = await createAgentSession({
		cwd: args.cwd,
		agentDir: args.agentDir,
		settings,
		enableMCP: false,
		disableExtensionDiscovery: true,
		autoApprove: true,
	});
	const session = created.session;

	try {
		const result = await runSanLoop({
			sessionManager: session.sessionManager,
			objective: args.objective,
			mode: args.mode,
			maxRetries: settings.get("san.executionLoop.maxRetries"),
			maxWorkers: settings.get("san.executionLoop.maxWorkers"),
			maxTurns: maxTurnsForMode(settings, args.mode),
			executor: createSanLoopTaskAgentExecutor({
				session,
				cwd: args.cwd,
				eventBus: created.eventBus,
			}),
		});
		const reportText = buildSanLoopReportText(session.sessionManager.getEntries(), { count: 5 });
		const changedFiles = uniqueStrings(result.run.workerResults.flatMap(worker => worker.changedFiles));
		const testsRun = uniqueStrings(result.run.reviewReports.flatMap(review => review.testsRun));
		const risks = uniqueStrings(result.run.workerResults.flatMap(worker => worker.risks));
		const ok = args.expect === "passed" ? result.run.status === "passed" : isSanLoopTerminalStatus(result.run.status);
		return {
			ok,
			expectation: args.expect,
			label: args.label,
			mode: result.run.mode,
			objective: result.run.objective,
			sessionFile: session.sessionFile,
			status: result.run.status,
			finalVerdict: result.run.finalVerdict ?? null,
			retryCount: result.run.retryCount,
			maxRetries: result.run.maxRetries,
			transitions: result.transitions.length,
			reviewEntries: result.reviewEntryIds.length,
			assignments: result.run.assignments.length,
			workerResults: result.run.workerResults.length,
			reviewReports: result.run.reviewReports.length,
			decisions: result.run.decisions.length,
			changedFiles,
			testsRun,
			risks,
			reportText,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		await session.dispose();
	}
}

async function main(): Promise<void> {
	const args = parseArgs();
	const output = await runAcceptanceTask(args);
	await writeAcceptanceOutput(output, args.out);
	process.exitCode = output.ok ? 0 : 1;
}

if (import.meta.main) {
	await main();
}
