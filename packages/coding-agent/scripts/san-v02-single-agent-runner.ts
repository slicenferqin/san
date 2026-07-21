#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Handlebars from "handlebars";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { disposeAllVmContexts } from "../src/eval/js/context-manager";
import singleAgentBaselinePrompt from "../src/prompts/san-loop/roi-single-agent-baseline.md" with { type: "text" };
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../src/sdk";
import type { SecretEntry } from "../src/secrets";

export interface SingleAgentRunnerArgs {
	agentDir?: string;
	config?: string;
	cwd: string;
	expect: "terminal" | "passed";
	label: string;
	model?: string;
	objective: string;
	followUps?: string[];
	runtimeApiKeys?: ReadonlyMap<string, string>;
	additionalSecretValues?: readonly string[];
	sessionOptions?: Pick<
		CreateAgentSessionOptions,
		| "extensions"
		| "skills"
		| "rules"
		| "contextFiles"
		| "toolNames"
		| "strictToolNames"
		| "toolPathScope"
		| "toolPathScopeExemptToolNames"
	>;
	out?: string;
}

export interface SingleAgentRunOutput {
	ok: boolean;
	expectation: SingleAgentRunnerArgs["expect"];
	label: string;
	objective: string;
	sessionFile?: string;
	status: "passed" | "blocked" | "failed";
	finalVerdict: "pass" | "needs_fix" | "fail" | null;
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
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		cost: number;
		premiumRequests: number;
	};
}

const PASS_PATTERN = /(?:^|\b)(?:PASS|PASSED|通过|无阻塞|可验收)(?:\b|$)/i;
const BLOCKED_PATTERN = /(?:^|\b)(?:BLOCKED|NEEDS_FIX|needs fix|需修复|阻塞|不通过)(?:\b|$)/i;
const FAIL_PATTERN = /(?:^|\b)(?:FAIL|FAILED|失败)(?:\b|$)/i;
const VERDICT_LINE_PATTERN = /^\s*(?:VERDICT|最终结论|结论)\s*[:：]\s*(.+?)\s*$/gim;

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-v02-single-agent-runner.ts [options] --objective <text>",
		"",
		"Options:",
		"  --agent-dir <path>     Agent dir with models.yml (default: SAN_CODING_AGENT_DIR or ~/.san/agent)",
		"  --config <path>        Config overlay for context steady/model catalog",
		"  --cwd <path>           Workspace cwd for the run (default: current cwd)",
		"  --expect <terminal|passed>  Exit success condition (default: terminal)",
		"  --label <name>         Evidence label (default: san-v02-single-agent)",
		"  --model <selector>     Explicit model selector (default: vb/gpt-5.5:xhigh)",
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

function parseExpect(value: string | undefined): SingleAgentRunnerArgs["expect"] {
	return value === "passed" ? "passed" : "terminal";
}

function parseArgs(): SingleAgentRunnerArgs {
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
	const agentDir =
		argValue(args, "--agent-dir") ?? process.env.SAN_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	const config = argValue(args, "--config");
	const out = argValue(args, "--out");

	return {
		agentDir: agentDir ? resolvePath(agentDir) : undefined,
		config: config ? resolvePath(config) : undefined,
		cwd,
		expect: parseExpect(argValue(args, "--expect")),
		label: argValue(args, "--label") ?? "san-v02-single-agent",
		model: argValue(args, "--model") ?? "vb/gpt-5.5:xhigh",
		objective,
		out: out ? resolvePath(out) : undefined,
	};
}

function buildPrompt(objective: string): string {
	return Handlebars.compile<{ objective: string }>(singleAgentBaselinePrompt)({ objective });
}

function mapVerdictText(value: string): Pick<SingleAgentRunOutput, "finalVerdict" | "status"> | null {
	if (FAIL_PATTERN.test(value)) return { finalVerdict: "fail", status: "failed" };
	if (BLOCKED_PATTERN.test(value)) return { finalVerdict: "needs_fix", status: "blocked" };
	if (PASS_PATTERN.test(value)) return { finalVerdict: "pass", status: "passed" };
	return null;
}

function normalizeStatus(text: string | undefined): Pick<SingleAgentRunOutput, "finalVerdict" | "status"> {
	const value = text ?? "";
	for (const match of value.matchAll(VERDICT_LINE_PATTERN)) {
		const mapped = mapVerdictText(match[1] ?? "");
		if (mapped) return mapped;
	}
	const fallback = mapVerdictText(value.slice(-1200));
	if (fallback) return fallback;
	return { finalVerdict: null, status: "blocked" };
}

function collectList(text: string, label: string): string[] {
	const pattern = new RegExp(`${label}:\\s*(.+)`, "i");
	const match = pattern.exec(text);
	if (!match?.[1]) return [];
	const value = match[1].trim();
	if (!value || /^none$/i.test(value)) return [];
	return [value];
}

export async function writeSingleAgentOutput(output: SingleAgentRunOutput, outPath: string | undefined): Promise<void> {
	const text = `${JSON.stringify(output, null, 2)}\n`;
	if (outPath) {
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await Bun.write(outPath, text);
	}
	await Bun.write(Bun.stdout, text);
}

const RUNTIME_SECRET_REPLACEMENT = "[REDACTED_RUNTIME_API_KEY]";

function runtimeSecretValues(runtimeApiKeys: ReadonlyMap<string, string> | undefined): string[] {
	return [...new Set(runtimeApiKeys?.values() ?? [])]
		.filter(value => value.length > 0)
		.sort((a, b) => b.length - a.length);
}

export function redactRuntimeSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of [...new Set(secrets)].filter(value => value.length > 0).sort((a, b) => b.length - a.length)) {
		redacted = redacted.replaceAll(secret, RUNTIME_SECRET_REPLACEMENT);
	}
	return redacted;
}

async function redactRuntimeSecretsFromFile(filePath: string | undefined, secrets: readonly string[]): Promise<void> {
	if (!filePath || secrets.length === 0) return;
	try {
		const text = await Bun.file(filePath).text();
		const redacted = redactRuntimeSecrets(text, secrets);
		if (redacted !== text) await Bun.write(filePath, redacted);
	} catch (error) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw new Error(`Failed to redact runtime secrets from session artifact ${filePath}: ${String(error)}`);
	}
}

export async function runSingleAgentTask(args: SingleAgentRunnerArgs): Promise<SingleAgentRunOutput> {
	const startedAt = Date.now();
	const protectedSecrets = [
		...new Set([...runtimeSecretValues(args.runtimeApiKeys), ...(args.additionalSecretValues ?? [])]),
	]
		.filter(value => value.length > 0)
		.sort((a, b) => b.length - a.length);
	const additionalSecretEntries: SecretEntry[] = protectedSecrets.map(content => ({
		type: "plain",
		content,
		mode: "replace",
		replacement: RUNTIME_SECRET_REPLACEMENT,
	}));
	const settings = await Settings.loadReadOnly({
		cwd: args.cwd,
		agentDir: args.agentDir,
		configFiles: args.config ? [args.config] : undefined,
	});
	return Settings.runWithActiveInstance(settings, async () => {
		const authStorage =
			args.agentDir || args.runtimeApiKeys?.size ? await discoverAuthStorage(args.agentDir) : undefined;
		const modelRegistry =
			authStorage && args.agentDir
				? new ModelRegistry(authStorage, path.join(args.agentDir, "models.yml"))
				: undefined;
		try {
			for (const [provider, apiKey] of args.runtimeApiKeys ?? []) {
				authStorage?.setRuntimeApiKey(provider, apiKey);
			}
			const created = await createAgentSession({
				cwd: args.cwd,
				agentDir: args.agentDir,
				settings,
				...(authStorage ? { authStorage } : {}),
				...(modelRegistry ? { modelRegistry } : {}),
				enableMCP: false,
				disableExtensionDiscovery: true,
				autoApprove: true,
				modelPattern: args.model,
				additionalSecretEntries,
				...args.sessionOptions,
			});
			const session = created.session;
			const sessionFile = session.sessionFile;

			try {
				await session.prompt(buildPrompt(args.objective), { expandPromptTemplates: false });
				for (const followUp of args.followUps ?? []) {
					await session.prompt(followUp, { expandPromptTemplates: false });
				}
				const reportText = redactRuntimeSecrets(session.getLastAssistantText() ?? "", protectedSecrets);
				const status = normalizeStatus(reportText);
				const stats = session.getSessionStats();
				const ok =
					args.expect === "passed"
						? status.status === "passed"
						: ["passed", "blocked", "failed"].includes(status.status);
				return {
					ok,
					expectation: args.expect,
					label: args.label,
					objective: args.objective,
					sessionFile: session.sessionFile,
					status: status.status,
					finalVerdict: status.finalVerdict,
					retryCount: 0,
					maxRetries: 0,
					transitions: 1 + (args.followUps?.length ?? 0),
					reviewEntries: 0,
					assignments: 0,
					workerResults: 0,
					reviewReports: 0,
					decisions: 0,
					changedFiles: [],
					testsRun: [],
					risks: collectList(reportText, "RISKS"),
					reportText,
					durationMs: Date.now() - startedAt,
					usage: {
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						cacheReadTokens: stats.tokens.cacheRead,
						cacheWriteTokens: stats.tokens.cacheWrite,
						totalTokens: stats.tokens.total,
						cost: stats.cost,
						premiumRequests: stats.premiumRequests,
					},
				};
			} finally {
				try {
					await session.dispose();
				} finally {
					try {
						await disposeAllVmContexts();
					} finally {
						await redactRuntimeSecretsFromFile(sessionFile, protectedSecrets);
						await redactRuntimeSecretsFromFile(
							sessionFile?.replace(/\.jsonl$/, ".context-probe.jsonl"),
							protectedSecrets,
						);
					}
				}
			}
		} finally {
			authStorage?.close();
		}
	});
}

async function main(): Promise<void> {
	const args = parseArgs();
	const output = await runSingleAgentTask(args);
	await writeSingleAgentOutput(output, args.out);
	process.exitCode = output.ok ? 0 : 1;
}

if (import.meta.main) {
	await main();
}
