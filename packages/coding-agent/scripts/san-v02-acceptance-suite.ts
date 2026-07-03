#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SanLoopMode } from "../src/san-loop";
import { type AcceptanceRunOutput, type RunnerArgs, runAcceptanceTask } from "./san-v02-acceptance-runner";

interface AcceptanceTaskSpec {
	id: string;
	label: string;
	mode: SanLoopMode;
	expect: RunnerArgs["expect"];
	objective: string;
}

interface AcceptanceSuiteOutput {
	ok: boolean;
	label: string;
	startedAt: string;
	completedAt: string;
	agentDir: string;
	config: string;
	sourceCwd: string;
	outDir: string;
	taskFile: string;
	tasks: AcceptanceRunOutput[];
	summary: {
		total: number;
		ok: number;
		passed: number;
		terminal: number;
		blocked: number;
		failed: number;
		aborted: number;
		retried: number;
		reviewReports: number;
		workerResults: number;
		durationMs: number;
	};
}

function argValue(name: string): string | undefined {
	const prefix = `${name}=`;
	for (let index = 2; index < Bun.argv.length; index++) {
		const value = Bun.argv[index];
		if (value === name) return Bun.argv[index + 1];
		if (value?.startsWith(prefix)) return value.slice(prefix.length);
	}
	return undefined;
}

function hasFlag(name: string): boolean {
	return Bun.argv.includes(name);
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function resolvePath(value: string): string {
	return path.resolve(expandHome(value));
}

function defaultConfigPath(): string {
	return path.resolve(import.meta.dir, "..", "examples", "config", "san-execution-loop-heterogeneous.yml");
}

function defaultTaskFile(): string {
	return path.resolve(import.meta.dir, "..", "examples", "san-v02-acceptance-tasks.json");
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-v02-acceptance-suite.ts [options]",
		"",
		"Options:",
		"  --agent-dir <path>     Agent dir with models.yml",
		"  --config <path>        San config overlay",
		"  --cwd-root <path>      Root for per-task workspaces",
		"  --source-cwd <path>    Source repo copied into each task workspace",
		"  --out-dir <path>       Directory for evidence JSON files",
		"  --task-file <path>     JSON task file",
		"  --label <name>         Suite label",
		"  --stop-on-fail         Stop after the first failed task expectation",
	].join("\n");
}

function assertTaskSpec(value: unknown): AcceptanceTaskSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Acceptance task must be an object");
	}
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	const label = typeof record.label === "string" ? record.label : "";
	const mode = record.mode === "rush" || record.mode === "smart" || record.mode === "deep" ? record.mode : undefined;
	const expect = record.expect === "passed" || record.expect === "terminal" ? record.expect : undefined;
	const objective = typeof record.objective === "string" ? record.objective.trim() : "";
	if (!id || !label || !mode || !expect || !objective) {
		throw new Error(`Invalid acceptance task: ${JSON.stringify(record)}`);
	}
	return { id, label, mode, expect, objective };
}

async function loadTasks(filePath: string): Promise<AcceptanceTaskSpec[]> {
	const data = await Bun.file(filePath).json();
	if (!Array.isArray(data)) throw new Error(`Acceptance task file must contain an array: ${filePath}`);
	return data.map(assertTaskSpec);
}

function terminalCount(tasks: readonly AcceptanceRunOutput[]): number {
	return tasks.filter(task => ["passed", "blocked", "failed", "aborted"].includes(task.status)).length;
}

function summarize(tasks: readonly AcceptanceRunOutput[], startedAt: number): AcceptanceSuiteOutput["summary"] {
	return {
		total: tasks.length,
		ok: tasks.filter(task => task.ok).length,
		passed: tasks.filter(task => task.status === "passed").length,
		terminal: terminalCount(tasks),
		blocked: tasks.filter(task => task.status === "blocked").length,
		failed: tasks.filter(task => task.status === "failed").length,
		aborted: tasks.filter(task => task.status === "aborted").length,
		retried: tasks.filter(task => task.retryCount > 0).length,
		reviewReports: tasks.reduce((total, task) => total + task.reviewReports, 0),
		workerResults: tasks.reduce((total, task) => total + task.workerResults, 0),
		durationMs: Date.now() - startedAt,
	};
}

function suitePasses(summary: AcceptanceSuiteOutput["summary"]): boolean {
	return summary.total === 10 && summary.terminal >= 8 && summary.passed >= 6 && summary.ok >= 8;
}

async function copyWorkspace(sourceCwd: string, destination: string): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.cp(sourceCwd, destination, {
		recursive: true,
		dereference: false,
		errorOnExist: false,
		filter: source => {
			const relative = path.relative(sourceCwd, source);
			if (!relative) return true;
			const segments = relative.split(path.sep);
			if (segments.includes(".git")) return false;
			if (segments.includes(".omp")) return false;
			if (segments.includes(".codegraph")) return false;
			if (segments.includes("node_modules")) return false;
			if (segments.includes(".turbo")) return false;
			if (segments.includes(".next")) return false;
			if (segments.includes("dist")) return false;
			if (segments.includes("coverage")) return false;
			return true;
		},
	});
}

async function main(): Promise<void> {
	if (hasFlag("--help") || hasFlag("-h")) {
		await Bun.write(Bun.stdout, `${usage()}\n`);
		return;
	}

	const startedAt = Date.now();
	const startedIso = new Date(startedAt).toISOString();
	const label = argValue("--label") ?? "san-v02-heterogeneous-suite";
	const agentDir = resolvePath(
		argValue("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? "/private/tmp/san-v02-agent",
	);
	const config = resolvePath(argValue("--config") ?? defaultConfigPath());
	const sourceCwd = resolvePath(argValue("--source-cwd") ?? process.cwd());
	const cwdRoot = resolvePath(argValue("--cwd-root") ?? `/private/tmp/${label}-workspaces`);
	const outDir = resolvePath(argValue("--out-dir") ?? `/private/tmp/${label}-evidence`);
	const taskFile = resolvePath(argValue("--task-file") ?? defaultTaskFile());
	const stopOnFail = hasFlag("--stop-on-fail");
	const tasks = await loadTasks(taskFile);
	const outputs: AcceptanceRunOutput[] = [];

	await fs.mkdir(cwdRoot, { recursive: true });
	await fs.mkdir(outDir, { recursive: true });

	for (const task of tasks) {
		const taskLabel = `${task.id.toLowerCase()}-${task.label}`;
		const cwd = path.join(cwdRoot, taskLabel);
		await copyWorkspace(sourceCwd, cwd);
		const output = await runAcceptanceTask({
			agentDir,
			config,
			cwd,
			expect: task.expect,
			label: taskLabel,
			mode: task.mode,
			objective: task.objective,
			out: path.join(outDir, `${taskLabel}.json`),
		});
		outputs.push(output);
		await Bun.write(path.join(outDir, `${taskLabel}.json`), `${JSON.stringify(output, null, 2)}\n`);
		await Bun.write(
			Bun.stdout,
			`${task.id} ${task.label}: ${output.status}; verdict=${output.finalVerdict ?? "none"}; ok=${output.ok}\n`,
		);
		if (!output.ok && stopOnFail) break;
	}

	const summary = summarize(outputs, startedAt);
	const result: AcceptanceSuiteOutput = {
		ok: suitePasses(summary),
		label,
		startedAt: startedIso,
		completedAt: new Date().toISOString(),
		agentDir,
		config,
		sourceCwd,
		outDir,
		taskFile,
		tasks: outputs,
		summary,
	};

	await Bun.write(path.join(outDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
	await Bun.write(Bun.stdout, `${JSON.stringify(result.summary, null, 2)}\n`);
	process.exitCode = result.ok ? 0 : 1;
}

await main();
