#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { $ } from "bun";
import {
	BENCHMARK_PATH_SCOPE_EXEMPT_TOOL_NAMES,
	type BenchmarkEvidenceChainSpec,
	createBenchmarkEvidenceChainController,
	createBenchmarkEvidenceExtension,
	createBenchmarkWorkspaceExtension,
} from "./san-context-steady-benchmark-evidence";
import type { SingleAgentRunOutput } from "./san-v02-single-agent-runner";
import { runSingleAgentTask } from "./san-v02-single-agent-runner";

export type ContextSteadyBenchmarkProfile = "smoke" | "standard" | "confidence" | "release" | "extended";
export type ContextSteadyBenchmarkMode = "native" | "steady";

interface BenchmarkProfileSpec {
	taskCount: number;
	runsPerTask: number;
}

export interface BenchmarkVerifierSpec {
	argv: string[];
	timeoutMs?: number;
}

export interface BenchmarkTaskSpec {
	id: string;
	label: string;
	objective: string;
	calibration?: boolean;
	followUps?: string[];
	fixture?: string;
	evidenceChain?: BenchmarkEvidenceChainSpec;
	verifier: BenchmarkVerifierSpec;
}

export interface PriceTable {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	currency: "USD";
	unitTokens: 1_000_000;
}

export interface ProbeSummary {
	records: number;
	billedRequests: number;
	agentRequests: number;
	digestRequests: number;
	compactionRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	promptTokens: number;
	agentPromptTokens: number;
	maintenancePromptTokens: number;
	cacheReadRate: number;
	maxPromptTokens: number;
	maxAgentPromptTokens: number;
	maxActiveTokens: number;
	maxRawTokens: number;
	compactionCount: number;
	segmentCount: number;
	firstNativeThresholdCrossing?: string;
	estimatedCost: number;
	agentEstimatedCost: number;
	maintenanceEstimatedCost: number;
}

interface VerifierResult {
	ok: boolean;
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
}

export interface BenchmarkPlanItem {
	sequence: number;
	pair: number;
	run: number;
	task: BenchmarkTaskSpec;
	mode: ContextSteadyBenchmarkMode;
}

interface BenchmarkRunResult {
	sequence: number;
	pair: number;
	run: number;
	attempt: number;
	taskId: string;
	taskLabel: string;
	mode: ContextSteadyBenchmarkMode;
	workspace: string;
	baselineCommit: string;
	fixtureHash: string;
	taskHash: string;
	config: string;
	sessionFile?: string;
	probeFile?: string;
	evidenceFile?: string;
	diffFile?: string;
	agent: SingleAgentRunOutput;
	probe: ProbeSummary | null;
	evidenceProtocol: BenchmarkEvidenceProtocolSummary | null;
	verifier: VerifierResult;
	infrastructure: InfrastructureFailureSummary;
	qualityPassed: boolean;
}

export interface InfrastructureFailureEvent {
	timestamp?: number;
	requestKind?: "agent" | "turn_digest" | "compaction";
	provider?: string;
	model?: string;
	status?: number;
	message: string;
}

export interface InfrastructureFailureSummary {
	failed: boolean;
	events: InfrastructureFailureEvent[];
}

export interface BenchmarkEvidenceProtocolSummary {
	expectedDirectCalls: number;
	directCalls: number;
	assistantMessagesWithCalls: number;
	maxCallsPerAssistantMessage: number;
	valid: boolean;
}

interface BenchmarkModeSummary {
	mode: ContextSteadyBenchmarkMode;
	runs: number;
	qualityPassed: number;
	passRate: number;
	promptTokens: number;
	maintenancePromptTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	estimatedCost: number;
	maintenanceEstimatedCost: number;
	costPerPass: number | null;
	maxActiveTokens: number;
	maxRawTokens: number;
}

export interface ComparablePairInput {
	pair: number;
	mode: ContextSteadyBenchmarkMode;
	qualityPassed: boolean;
	probe: ProbeSummary | null;
}

export interface ComparablePairSummary {
	totalPairs: number;
	comparablePairs: number;
	nativePromptTokens: number;
	steadyPromptTokens: number;
	promptTokenDelta: number;
	promptTokenSavingsRate: number | null;
	nativeCost: number;
	steadyCost: number;
	costDelta: number;
	costSavingsRate: number | null;
	promptSavingsDistribution: PairedDistributionSummary | null;
	costSavingsDistribution: PairedDistributionSummary | null;
}

export interface PairedDistributionSummary {
	count: number;
	median: number;
	q1: number;
	q3: number;
	bootstrap95Low: number;
	bootstrap95High: number;
}

interface BenchmarkOutput {
	schemaVersion: 1;
	label: string;
	profile: ContextSteadyBenchmarkProfile;
	seed: string;
	startedAt: string;
	completedAt: string;
	model: string;
	taskFile: string;
	sourceCwd: string;
	provenance: {
		sourceRoot: string;
		sourceCommit: string;
		sourceDirty: boolean;
		sourceDiffHash?: string;
		agentModelConfigHash?: string;
		taskFileHash: string;
		nativeConfigHash: string;
		steadyConfigHash: string;
	};
	priceTable: PriceTable;
	attemptedRuns: number;
	finalRuns: number;
	validFinalRuns: number;
	invalidInfrastructurePairs: number[];
	plan: Array<Pick<BenchmarkPlanItem, "sequence" | "pair" | "run" | "mode"> & { taskId: string }>;
	runs: BenchmarkRunResult[];
	summaries: BenchmarkModeSummary[];
	paired: ComparablePairSummary;
}

interface CliOptions {
	profile: ContextSteadyBenchmarkProfile;
	seed: string;
	label: string;
	agentDir?: string;
	model: string;
	taskFile: string;
	sourceCwd: string;
	workspaceRoot: string;
	outDir: string;
	nativeConfig: string;
	steadyConfig: string;
	priceTable: PriceTable;
	estimateOnly: boolean;
	estimatedCostPerRun?: number;
	maxEstimatedCost: number;
	allowExpensive: boolean;
	resume: boolean;
	infrastructureRetries: 0 | 1;
	allowDirtySource: boolean;
	runtimeKeysStdin: boolean;
	nativeKeyEnv: ReadonlyMap<string, string>;
	steadyKeyEnv: ReadonlyMap<string, string>;
}

export interface BenchmarkRuntimeApiKeys {
	native: ReadonlyMap<string, string>;
	steady: ReadonlyMap<string, string>;
}

const PROFILE_SPECS: Record<ContextSteadyBenchmarkProfile, BenchmarkProfileSpec> = {
	smoke: { taskCount: 1, runsPerTask: 1 },
	standard: { taskCount: 3, runsPerTask: 1 },
	confidence: { taskCount: 3, runsPerTask: 3 },
	release: { taskCount: 5, runsPerTask: 3 },
	extended: { taskCount: 5, runsPerTask: 5 },
};

const DEFAULT_PRICES: PriceTable = {
	input: 5,
	output: 30,
	cacheRead: 0.5,
	cacheWrite: 6.25,
	currency: "USD",
	unitTokens: 1_000_000,
};

const SECRET_ENV_NAME_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

export const BENCHMARK_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"benchmark_step",
	"benchmark_test",
	"benchmark_incident_report",
] as const;

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

function parsePositiveNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Expected a non-negative number, received: ${value}`);
	return parsed;
}

function parseInfrastructureRetries(value: string | undefined): 0 | 1 {
	if (value === undefined || value === "1") return 1;
	if (value === "0") return 0;
	throw new Error(`--infrastructure-retries must be 0 or 1, received: ${value}`);
}

function parseProfile(value: string | undefined): ContextSteadyBenchmarkProfile {
	if (value === undefined) return "smoke";
	if (
		value === "smoke" ||
		value === "standard" ||
		value === "confidence" ||
		value === "release" ||
		value === "extended"
	)
		return value;
	throw new Error(`Unknown benchmark profile: ${value}`);
}

export function parseRuntimeKeyEnvAssignments(
	value: string | undefined,
	optionName: string,
): ReadonlyMap<string, string> {
	const assignments = new Map<string, string>();
	if (value === undefined) return assignments;
	if (value.trim().length === 0) throw new Error(`${optionName} must contain provider=ENV assignments`);
	for (const rawAssignment of value.split(",")) {
		const assignment = rawAssignment.trim();
		const separator = assignment.indexOf("=");
		if (separator <= 0 || separator !== assignment.lastIndexOf("=")) {
			throw new Error(`${optionName} must use comma-separated provider=ENV assignments: ${assignment}`);
		}
		const provider = assignment.slice(0, separator).trim();
		const environmentVariable = assignment.slice(separator + 1).trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
			throw new Error(`${optionName} contains an invalid provider id: ${provider}`);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentVariable)) {
			throw new Error(`${optionName} contains an invalid environment variable for provider ${provider}`);
		}
		if (assignments.has(provider)) throw new Error(`${optionName} repeats provider ${provider}`);
		assignments.set(provider, environmentVariable);
	}
	return assignments;
}

export function resolveRuntimeApiKeys(
	assignments: ReadonlyMap<string, string>,
	environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
	const resolved = new Map<string, string>();
	for (const [provider, environmentVariable] of assignments) {
		const apiKey = environment[environmentVariable]?.trim();
		if (!apiKey) {
			throw new Error(
				`Environment variable ${environmentVariable} required by provider ${provider} is missing or empty`,
			);
		}
		resolved.set(provider, apiKey);
	}
	return resolved;
}

function modelProvider(model: string): string {
	const separator = model.indexOf("/");
	if (separator <= 0) throw new Error(`--model must include an explicit provider: ${model}`);
	return model.slice(0, separator);
}

function validateRuntimeKeyProviders(
	model: string,
	native: ReadonlyMap<string, string>,
	steady: ReadonlyMap<string, string>,
): void {
	if ((native.size === 0) !== (steady.size === 0)) {
		throw new Error("--native-key-env and --steady-key-env must be provided together");
	}
	if (native.size === 0) return;
	const provider = modelProvider(model);
	if (!native.has(provider)) throw new Error(`Native runtime keys must provide the main model provider ${provider}`);
	if (!steady.has(provider)) throw new Error(`Steady runtime keys must provide the main model provider ${provider}`);
}

export function assertSecureRuntimeKeyTransport(estimateOnly: boolean, environmentKeyCount: number): void {
	if (!estimateOnly && environmentKeyCount > 0) {
		throw new Error(
			"Paid benchmark runs reject process-environment key transport; use --runtime-keys-stdin so credentials are not visible through process inspection",
		);
	}
}

export function consumeInheritedSecretEnvironment(environment: Record<string, string | undefined>): string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(environment)) {
		if (!value || value.length < 8 || !SECRET_ENV_NAME_PATTERN.test(name)) continue;
		values.add(value);
		delete environment[name];
	}
	return [...values].sort((a, b) => b.length - a.length);
}

function parseRuntimeKeyObject(value: unknown, field: "native" | "steady"): ReadonlyMap<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runtime key stdin field ${field} must be an object of provider keys`);
	}
	const keys = new Map<string, string>();
	for (const [provider, rawKey] of Object.entries(value)) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
			throw new Error(`Runtime key stdin field ${field} contains an invalid provider id`);
		}
		if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
			throw new Error(`Runtime key stdin field ${field} contains an empty provider key`);
		}
		keys.set(provider, rawKey.trim());
	}
	if (keys.size === 0) throw new Error(`Runtime key stdin field ${field} must provide at least one provider`);
	return keys;
}

export function parseRuntimeApiKeysStdin(text: string, model: string): BenchmarkRuntimeApiKeys {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Runtime key stdin must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Runtime key stdin must be an object with native and steady fields");
	}
	const record = parsed as Record<string, unknown>;
	const unknownFields = Object.keys(record).filter(field => field !== "native" && field !== "steady");
	if (unknownFields.length > 0) {
		throw new Error("Runtime key stdin contains unsupported fields");
	}
	const native = parseRuntimeKeyObject(record.native, "native");
	const steady = parseRuntimeKeyObject(record.steady, "steady");
	validateRuntimeKeyProviders(model, native, steady);
	return { native, steady };
}

function consumeRuntimeApiKeys(options: CliOptions): BenchmarkRuntimeApiKeys {
	const environmentVariables = new Set([...options.nativeKeyEnv.values(), ...options.steadyKeyEnv.values()]);
	try {
		return {
			native: resolveRuntimeApiKeys(options.nativeKeyEnv, process.env),
			steady: resolveRuntimeApiKeys(options.steadyKeyEnv, process.env),
		};
	} finally {
		for (const environmentVariable of environmentVariables) delete process.env[environmentVariable];
	}
}

function defaultPath(relativePath: string): string {
	return path.resolve(import.meta.dir, "..", relativePath);
}

function sha256Text(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
	return hasher.digest("hex");
}

async function hashAgentModelConfig(agentDir: string | undefined): Promise<string | undefined> {
	if (!agentDir) return undefined;
	for (const filename of ["models.yml", "models.yaml"]) {
		const configPath = path.join(agentDir, filename);
		if (await Bun.file(configPath).exists()) return hashFile(configPath);
	}
	return undefined;
}

async function hashDirectory(directory: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const visit = async (current: string): Promise<void> => {
		const entries = await fs.readdir(current, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if ([".git", ".san", ".omp", "node_modules", "dist", "coverage", ".turbo"].includes(entry.name)) {
				continue;
			}
			const absolute = path.join(current, entry.name);
			const relative = path.relative(directory, absolute);
			hasher.update(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}\0`);
			if (entry.isDirectory()) {
				await visit(absolute);
			} else if (entry.isSymbolicLink()) {
				hasher.update(`${await fs.readlink(absolute)}\0`);
			} else {
				hasher.update(new Uint8Array(await Bun.file(absolute).arrayBuffer()));
			}
		}
	};
	await visit(directory);
	return hasher.digest("hex");
}

async function gitRevision(directory: string): Promise<string> {
	const result = await $`git rev-parse HEAD`.cwd(directory).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Failed to resolve source commit from ${directory}: ${result.stderr.toString()}`);
	}
	return result.text().trim();
}

async function gitRoot(directory: string): Promise<string> {
	const result = await $`git rev-parse --show-toplevel`.cwd(directory).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Failed to resolve source repository from ${directory}: ${result.stderr.toString()}`);
	}
	return result.text().trim();
}

async function gitWorktreeState(directory: string): Promise<{ dirty: boolean; diffHash?: string }> {
	const status = await $`git status --porcelain -z`.cwd(directory).quiet().nothrow();
	if (status.exitCode !== 0) {
		throw new Error(`Failed to inspect source worktree at ${directory}: ${status.stderr.toString()}`);
	}
	if (status.stdout.length === 0) return { dirty: false };

	const diff = await $`git diff --binary --no-ext-diff HEAD`.cwd(directory).quiet().nothrow();
	if (diff.exitCode !== 0) {
		throw new Error(`Failed to capture source diff at ${directory}: ${diff.stderr.toString()}`);
	}
	const untracked = await $`git ls-files --others --exclude-standard -z`.cwd(directory).quiet().nothrow();
	if (untracked.exitCode !== 0) {
		throw new Error(`Failed to inspect untracked source files at ${directory}: ${untracked.stderr.toString()}`);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(status.stdout);
	hasher.update(diff.stdout);
	const untrackedFiles = new TextDecoder().decode(untracked.stdout).split("\0").filter(Boolean).sort();
	for (const relative of untrackedFiles) {
		hasher.update(`${relative}\0`);
		hasher.update(new Uint8Array(await Bun.file(path.join(directory, relative)).arrayBuffer()));
	}
	return { dirty: true, diffHash: hasher.digest("hex") };
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-context-steady-benchmark.ts --task-file <path> [options]",
		"",
		"Profiles:",
		"  smoke       1 task x 2 modes x 1 run = 2 runs (default)",
		"  standard    3 tasks x 2 modes x 1 run = 6 runs",
		"  confidence  3 tasks x 2 modes x 3 runs = 18 runs",
		"  release     5 tasks x 2 modes x 3 runs = 30 runs; requires --allow-expensive",
		"  extended    5 tasks x 2 modes x 5 runs = 50 runs; requires --allow-expensive",
		"",
		"Options:",
		"  --profile <name>               Benchmark profile",
		"  --task-file <path>              Task manifest with hidden verifier commands",
		"  --source-cwd <path>             Default fixture source",
		"  --agent-dir <path>              Agent configuration directory",
		"  --model <selector>              Same model for both modes",
		"  --runtime-keys-stdin            Read {native,steady} provider-key maps as JSON from stdin",
		"  --native-key-env <p=ENV,...>    Native provider keys read from environment",
		"  --steady-key-env <p=ENV,...>    Steady provider keys read from environment",
		"  --native-config <path>          Explicit Context Steady disabled overlay",
		"  --steady-config <path>          Context Steady enabled overlay",
		"  --workspace-root <path>         Isolated run workspaces",
		"  --out-dir <path>                Evidence output directory",
		"  --seed <text>                   Deterministic paired order seed",
		"  --estimate-only                 Print plan and estimated cost without model calls",
		"  --estimated-cost-per-run <usd>  Cost guard estimate",
		"  --max-estimated-cost <usd>      Refuse runs above this estimate (default: 200)",
		"  --allow-expensive               Required for Release/Extended and over-limit estimates",
		"  --resume                        Reuse completed result.json artifacts",
		"  --infrastructure-retries <0|1>  Rerun an invalid Native/Steady pair once (default: 1)",
		"  --allow-dirty-source            Permit release evidence from an uncommitted source tree",
	].join("\n");
}

function parseOptions(): CliOptions {
	if (hasFlag("--help") || hasFlag("-h")) {
		process.stdout.write(`${usage()}\n`);
		process.exit(0);
	}
	const taskFile = argValue("--task-file");
	if (!taskFile) throw new Error("--task-file is required");
	const profile = parseProfile(argValue("--profile"));
	const label = argValue("--label") ?? `san-context-steady-${profile}`;
	const agentDir = argValue("--agent-dir") ?? process.env.SAN_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	const estimatedCost = argValue("--estimated-cost-per-run");
	const model = argValue("--model") ?? "asxs/gpt-5.6-sol:xhigh";
	const runtimeKeysStdin = hasFlag("--runtime-keys-stdin");
	const nativeKeyEnv = parseRuntimeKeyEnvAssignments(argValue("--native-key-env"), "--native-key-env");
	const steadyKeyEnv = parseRuntimeKeyEnvAssignments(argValue("--steady-key-env"), "--steady-key-env");
	if (runtimeKeysStdin && (nativeKeyEnv.size > 0 || steadyKeyEnv.size > 0)) {
		throw new Error("--runtime-keys-stdin cannot be combined with --native-key-env or --steady-key-env");
	}
	validateRuntimeKeyProviders(model, nativeKeyEnv, steadyKeyEnv);
	return {
		profile,
		seed: argValue("--seed") ?? "san-context-steady-v1",
		label,
		agentDir: agentDir ? resolvePath(agentDir) : undefined,
		model,
		taskFile: resolvePath(taskFile),
		sourceCwd: resolvePath(argValue("--source-cwd") ?? process.cwd()),
		workspaceRoot: resolvePath(argValue("--workspace-root") ?? `/private/tmp/${label}-workspaces`),
		outDir: resolvePath(argValue("--out-dir") ?? `/private/tmp/${label}-evidence`),
		nativeConfig: resolvePath(
			argValue("--native-config") ?? defaultPath("examples/config/san-context-steady-native.yml"),
		),
		steadyConfig: resolvePath(
			argValue("--steady-config") ?? defaultPath("examples/config/san-context-steady-benchmark.yml"),
		),
		priceTable: {
			input: parsePositiveNumber(argValue("--input-price"), DEFAULT_PRICES.input),
			output: parsePositiveNumber(argValue("--output-price"), DEFAULT_PRICES.output),
			cacheRead: parsePositiveNumber(argValue("--cache-read-price"), DEFAULT_PRICES.cacheRead),
			cacheWrite: parsePositiveNumber(argValue("--cache-write-price"), DEFAULT_PRICES.cacheWrite),
			currency: "USD",
			unitTokens: 1_000_000,
		},
		estimateOnly: hasFlag("--estimate-only"),
		estimatedCostPerRun:
			estimatedCost === undefined ? undefined : parsePositiveNumber(estimatedCost, DEFAULT_PRICES.input),
		maxEstimatedCost: parsePositiveNumber(argValue("--max-estimated-cost"), 200),
		allowExpensive: hasFlag("--allow-expensive"),
		resume: hasFlag("--resume"),
		infrastructureRetries: parseInfrastructureRetries(argValue("--infrastructure-retries")),
		allowDirtySource: hasFlag("--allow-dirty-source"),
		runtimeKeysStdin,
		nativeKeyEnv,
		steadyKeyEnv,
	};
}

function assertString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function parseVerifier(value: unknown, taskId: string): BenchmarkVerifierSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Task ${taskId} verifier must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.argv) || !record.argv.every(item => typeof item === "string" && item.length > 0)) {
		throw new Error(`Task ${taskId} verifier.argv must be a non-empty string array`);
	}
	const timeoutMs = record.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		throw new Error(`Task ${taskId} verifier.timeoutMs must be a positive number`);
	}
	return { argv: record.argv, ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) };
}

function parseFollowUps(value: unknown, taskId: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`Task ${taskId} followUps must be an array of non-empty strings`);
	}
	return value.map(item => item.trim());
}

function parseEvidenceChain(value: unknown, taskId: string): BenchmarkEvidenceChainSpec | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Task ${taskId} evidenceChain must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.steps !== "number" || !Number.isSafeInteger(record.steps)) {
		throw new Error(`Task ${taskId} evidenceChain.steps must be an integer`);
	}
	if (typeof record.seed !== "string" || record.seed.trim().length === 0) {
		throw new Error(`Task ${taskId} evidenceChain.seed must be a non-empty string`);
	}
	if (typeof record.payloadChars !== "number" || !Number.isSafeInteger(record.payloadChars)) {
		throw new Error(`Task ${taskId} evidenceChain.payloadChars must be an integer`);
	}
	return { steps: record.steps, seed: record.seed.trim(), payloadChars: record.payloadChars };
}

function parseTask(value: unknown): BenchmarkTaskSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Benchmark task must be an object");
	const record = value as Record<string, unknown>;
	const id = assertString(record.id, "task.id");
	const followUps = parseFollowUps(record.followUps, id);
	const evidenceChain = parseEvidenceChain(record.evidenceChain, id);
	return {
		id,
		label: assertString(record.label, `task ${id}.label`),
		objective: assertString(record.objective, `task ${id}.objective`),
		...(record.calibration === true ? { calibration: true } : {}),
		...(followUps ? { followUps } : {}),
		...(typeof record.fixture === "string" && record.fixture.trim().length > 0
			? { fixture: record.fixture.trim() }
			: {}),
		...(evidenceChain ? { evidenceChain } : {}),
		verifier: parseVerifier(record.verifier, id),
	};
}

async function loadTasks(taskFile: string): Promise<BenchmarkTaskSpec[]> {
	const value: unknown = await Bun.file(taskFile).json();
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`Task manifest must be a non-empty array: ${taskFile}`);
	return value.map(parseTask);
}

function pairOrder(seed: string, taskId: string, run: number): readonly ContextSteadyBenchmarkMode[] {
	const hash = Bun.hash(`${seed}:${taskId}:${run}`);
	return BigInt(hash) % 2n === 0n ? ["native", "steady"] : ["steady", "native"];
}

export function buildBenchmarkPlan(
	tasks: readonly BenchmarkTaskSpec[],
	profile: ContextSteadyBenchmarkProfile,
	seed: string,
): BenchmarkPlanItem[] {
	const spec = PROFILE_SPECS[profile];
	if (tasks.length < spec.taskCount) {
		throw new Error(`Profile ${profile} requires at least ${spec.taskCount} tasks, received ${tasks.length}`);
	}
	const selectedTasks =
		profile === "standard" || profile === "confidence"
			? [...tasks.filter(task => task.calibration), ...tasks.filter(task => !task.calibration)].slice(
					0,
					spec.taskCount,
				)
			: tasks.slice(0, spec.taskCount);
	const plan: BenchmarkPlanItem[] = [];
	let sequence = 1;
	let pair = 1;
	for (const task of selectedTasks) {
		for (let run = 1; run <= spec.runsPerTask; run++) {
			for (const mode of pairOrder(seed, task.id, run)) {
				plan.push({ sequence, pair, run, task, mode });
				sequence++;
			}
			pair++;
		}
	}
	return plan;
}

export function assertBenchmarkCostGuard(options: {
	profile: ContextSteadyBenchmarkProfile;
	plannedRuns: number;
	maximumRuns?: number;
	estimatedCostPerRun?: number;
	maxEstimatedCost: number;
	allowExpensive: boolean;
}): void {
	const costedRuns = options.maximumRuns ?? options.plannedRuns;
	const estimatedTotal =
		options.estimatedCostPerRun === undefined ? undefined : options.estimatedCostPerRun * costedRuns;
	if (options.plannedRuns > PROFILE_SPECS.standard.taskCount * 2 && estimatedTotal === undefined) {
		throw new Error("Confidence and release profiles require --estimated-cost-per-run before model calls");
	}
	if (estimatedTotal !== undefined && estimatedTotal > options.maxEstimatedCost && !options.allowExpensive) {
		throw new Error(
			`Estimated benchmark cost $${estimatedTotal.toFixed(2)} exceeds the $${options.maxEstimatedCost.toFixed(2)} guard; pass --allow-expensive after review`,
		);
	}
	if ((options.profile === "release" || options.profile === "extended") && !options.allowExpensive) {
		throw new Error(
			`${options.profile} profile schedules ${options.plannedRuns} base model runs and up to ${costedRuns} with infrastructure retries; review --estimate-only output and pass --allow-expensive`,
		);
	}
}

function toFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const nested = (value as Record<string, unknown>)[key];
	return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

export function summarizeInfrastructureFailures(text: string, probeText?: string): InfrastructureFailureSummary {
	const parsed: unknown = Bun.JSONL.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Session journal must contain JSONL records");
	const events: InfrastructureFailureEvent[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = nestedRecord(entry, "message");
		if (message.role !== "assistant" || message.stopReason !== "error") continue;
		const status = toFiniteNumber(message.errorStatus);
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "provider request failed";
		if (!isInfrastructureFailure(status, errorMessage)) continue;
		events.push({
			requestKind: "agent",
			...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
			...(typeof message.provider === "string" ? { provider: message.provider } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			...(status > 0 ? { status } : {}),
			message: errorMessage,
		});
	}
	if (probeText !== undefined) {
		const probeRecords: unknown = Bun.JSONL.parse(probeText);
		if (!Array.isArray(probeRecords)) throw new Error("Context probe must contain JSONL records");
		for (const entry of probeRecords) {
			const request = nestedRecord(entry, "request");
			const kind = request.kind;
			if ((kind !== "agent" && kind !== "turn_digest" && kind !== "compaction") || request.stopReason !== "error") {
				continue;
			}
			const status = toFiniteNumber(request.errorStatus);
			const errorMessage =
				typeof request.errorMessage === "string" ? request.errorMessage : "provider request failed";
			if (!isInfrastructureFailure(status, errorMessage)) continue;
			const model = nestedRecord(entry, "model");
			const event: InfrastructureFailureEvent = {
				requestKind: kind,
				...(typeof model.provider === "string" ? { provider: model.provider } : {}),
				...(typeof model.id === "string" ? { model: model.id } : {}),
				...(status > 0 ? { status } : {}),
				message: errorMessage,
			};
			const duplicate = events.some(
				candidate =>
					candidate.requestKind === event.requestKind &&
					candidate.provider === event.provider &&
					candidate.model === event.model &&
					candidate.status === event.status &&
					candidate.message === event.message,
			);
			if (!duplicate) events.push(event);
		}
	}
	return { failed: events.length > 0, events };
}

export function summarizeBenchmarkEvidenceProtocol(
	text: string,
	expectedDirectCalls: number,
): BenchmarkEvidenceProtocolSummary {
	const parsed: unknown = Bun.JSONL.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Session journal must contain JSONL records");
	let directCalls = 0;
	let assistantMessagesWithCalls = 0;
	let maxCallsPerAssistantMessage = 0;
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = nestedRecord(entry, "message");
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const calls = message.content.filter(content => {
			if (!content || typeof content !== "object" || Array.isArray(content)) return false;
			const block = content as Record<string, unknown>;
			return block.type === "toolCall" && block.name === "benchmark_step";
		}).length;
		if (calls === 0) continue;
		directCalls += calls;
		assistantMessagesWithCalls++;
		maxCallsPerAssistantMessage = Math.max(maxCallsPerAssistantMessage, calls);
	}
	return {
		expectedDirectCalls,
		directCalls,
		assistantMessagesWithCalls,
		maxCallsPerAssistantMessage,
		valid:
			directCalls === expectedDirectCalls &&
			assistantMessagesWithCalls === expectedDirectCalls &&
			maxCallsPerAssistantMessage <= 1,
	};
}

function isInfrastructureFailure(status: number, message: string): boolean {
	return (
		status === 429 ||
		status >= 500 ||
		/rate.?limit|too many requests|service unavailable|server.?is.?overloaded|servers?.*overloaded|stream.?read.?error|insufficient.?quota|quota.*(?:insufficient|exceeded)|gateway timeout|bad gateway|fetch failed|network|socket|econnreset|econnrefused|enotfound|eai_again|etimedout|timed out|timeout|tls|concurrency limit/i.test(
			message,
		)
	);
}

function requestKind(record: unknown): "agent" | "turn_digest" | "compaction" {
	const kind = nestedRecord(record, "request").kind;
	return kind === "turn_digest" || kind === "compaction" ? kind : "agent";
}

function estimateUsageCost(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
	priceTable: PriceTable,
): number {
	return (
		(usage.input * priceTable.input +
			usage.output * priceTable.output +
			usage.cacheRead * priceTable.cacheRead +
			usage.cacheWrite * priceTable.cacheWrite) /
		priceTable.unitTokens
	);
}

export function summarizeContextProbe(text: string, priceTable: PriceTable = DEFAULT_PRICES): ProbeSummary {
	const parsed: unknown = Bun.JSONL.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Context probe must contain JSONL records");
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let billedRequests = 0;
	let agentRequests = 0;
	let digestRequests = 0;
	let compactionRequests = 0;
	let agentPromptTokens = 0;
	let maintenancePromptTokens = 0;
	let agentEstimatedCost = 0;
	let maintenanceEstimatedCost = 0;
	let maxPromptTokens = 0;
	let maxAgentPromptTokens = 0;
	let maxActiveTokens = 0;
	let maxRawTokens = 0;
	let compactionCount = 0;
	let segmentCount = 0;
	let firstNativeThresholdCrossing: string | undefined;
	for (const record of parsed) {
		const usage = nestedRecord(record, "usage");
		const context = nestedRecord(record, "context");
		const maintenance = nestedRecord(record, "maintenance");
		const input = toFiniteNumber(usage.input);
		const output = toFiniteNumber(usage.output);
		const cacheRead = toFiniteNumber(usage.cacheRead);
		const cacheWrite = toFiniteNumber(usage.cacheWrite);
		const prompt = toFiniteNumber(usage.promptTokens);
		const kind = requestKind(record);
		const cost = estimateUsageCost({ input, output, cacheRead, cacheWrite }, priceTable);
		inputTokens += input;
		outputTokens += output;
		cacheReadTokens += cacheRead;
		cacheWriteTokens += cacheWrite;
		if (prompt > 0) billedRequests++;
		if (kind === "agent") {
			agentPromptTokens += prompt;
			agentEstimatedCost += cost;
			if (prompt > 0) agentRequests++;
		} else {
			maintenancePromptTokens += prompt;
			maintenanceEstimatedCost += cost;
			if (prompt > 0) {
				if (kind === "turn_digest") digestRequests++;
				else compactionRequests++;
			}
		}
		maxPromptTokens = Math.max(maxPromptTokens, prompt);
		if (kind === "agent") maxAgentPromptTokens = Math.max(maxAgentPromptTokens, prompt);
		maxActiveTokens = Math.max(maxActiveTokens, toFiniteNumber(context.activeEstimatedTokens));
		maxRawTokens = Math.max(maxRawTokens, toFiniteNumber(context.rawJournalEstimatedTokens));
		compactionCount = Math.max(compactionCount, toFiniteNumber(maintenance.compactionCount));
		segmentCount = Math.max(segmentCount, toFiniteNumber(maintenance.segmentCount));
		if (!firstNativeThresholdCrossing && context.rawJournalWouldTriggerNativeCompaction === true) {
			const timestamp = (record as Record<string, unknown>).timestamp;
			if (typeof timestamp === "string") firstNativeThresholdCrossing = timestamp;
		}
	}
	const promptTokens = agentPromptTokens + maintenancePromptTokens;
	const estimatedCost = estimateUsageCost(
		{ input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
		priceTable,
	);
	return {
		records: parsed.length,
		billedRequests,
		agentRequests,
		digestRequests,
		compactionRequests,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		promptTokens,
		agentPromptTokens,
		maintenancePromptTokens,
		cacheReadRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
		maxPromptTokens,
		maxAgentPromptTokens,
		maxActiveTokens,
		maxRawTokens,
		compactionCount,
		segmentCount,
		...(firstNativeThresholdCrossing ? { firstNativeThresholdCrossing } : {}),
		estimatedCost,
		agentEstimatedCost,
		maintenanceEstimatedCost,
	};
}

async function copyWorkspace(source: string, destination: string): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.cp(source, destination, {
		recursive: true,
		dereference: false,
		filter: item => {
			const relative = path.relative(source, item);
			if (!relative) return true;
			const segments = relative.split(path.sep);
			return !segments.some(segment =>
				[".git", ".san", ".omp", "node_modules", "dist", "coverage", ".turbo"].includes(segment),
			);
		},
	});
}

function resolveFixture(task: BenchmarkTaskSpec, taskFile: string, sourceCwd: string): string {
	if (!task.fixture) return sourceCwd;
	return path.resolve(path.dirname(taskFile), task.fixture);
}

function expandVerifierArg(
	value: string,
	workspace: string,
	taskFile: string,
	evidenceFile: string | undefined,
): string {
	return value
		.replaceAll("{{workspace}}", workspace)
		.replaceAll("{{taskDir}}", path.dirname(taskFile))
		.replaceAll("{{evidence}}", evidenceFile ?? "");
}

async function runVerifier(
	spec: BenchmarkVerifierSpec,
	workspace: string,
	taskFile: string,
	evidenceFile?: string,
): Promise<VerifierResult> {
	const argv = spec.argv.map(value => expandVerifierArg(value, workspace, taskFile, evidenceFile));
	const startedAt = Date.now();
	const child = Bun.spawn(argv, { cwd: workspace, stdout: "pipe", stderr: "pipe", env: process.env });
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, spec.timeoutMs ?? 300_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timeout);
	return {
		ok: !timedOut && exitCode === 0,
		exitCode,
		timedOut,
		durationMs: Date.now() - startedAt,
		stdout,
		stderr,
	};
}

async function initializeWorkspaceRepository(workspace: string): Promise<string> {
	const init = await $`git init --quiet`.cwd(workspace).quiet().nothrow();
	if (init.exitCode !== 0) {
		throw new Error(`Failed to initialize benchmark workspace repository at ${workspace}: ${init.stderr.toString()}`);
	}
	const add = await $`git add --all`.cwd(workspace).quiet().nothrow();
	if (add.exitCode !== 0) {
		throw new Error(`Failed to stage benchmark fixture at ${workspace}: ${add.stderr.toString()}`);
	}
	const commit = await $`git -c user.name=San-Benchmark -c user.email=benchmark@san.local commit --quiet -m baseline`
		.cwd(workspace)
		.quiet()
		.nothrow();
	if (commit.exitCode !== 0) {
		throw new Error(`Failed to commit benchmark fixture baseline at ${workspace}: ${commit.stderr.toString()}`);
	}
	const revision = await $`git rev-parse HEAD`.cwd(workspace).quiet().nothrow();
	if (revision.exitCode !== 0) {
		throw new Error(`Failed to resolve benchmark baseline commit at ${workspace}: ${revision.stderr.toString()}`);
	}
	return revision.text().trim();
}

async function writeWorkspaceDiff(workspace: string, baselineCommit: string, destination: string): Promise<void> {
	const intentToAdd = await $`git add --intent-to-add --all`.cwd(workspace).quiet().nothrow();
	if (intentToAdd.exitCode !== 0) {
		throw new Error(
			`Failed to include new benchmark files in diff at ${workspace}: ${intentToAdd.stderr.toString()}`,
		);
	}
	const diff = await $`git diff --binary --no-ext-diff ${baselineCommit}`.cwd(workspace).quiet().nothrow();
	if (diff.exitCode !== 0) {
		throw new Error(`Failed to capture benchmark diff at ${workspace}: ${diff.stderr.toString()}`);
	}
	await Bun.write(destination, diff.stdout);
}

async function copyEvidenceFile(source: string | undefined, destination: string): Promise<string | undefined> {
	if (!source) return undefined;
	try {
		await fs.copyFile(source, destination);
		return destination;
	} catch (error) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readExistingResult(filePath: string): Promise<BenchmarkRunResult | null> {
	try {
		return (await Bun.file(filePath).json()) as BenchmarkRunResult;
	} catch (error) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return null;
		throw new Error(`Failed to read existing benchmark result ${filePath}: ${String(error)}`);
	}
}

function selectFinalPairAttempts(runs: readonly BenchmarkRunResult[]): BenchmarkRunResult[] {
	const final: BenchmarkRunResult[] = [];
	for (const pair of new Set(runs.map(run => run.pair))) {
		const pairRuns = runs.filter(run => run.pair === pair);
		const attempt = pairRuns.reduce((max, run) => Math.max(max, run.attempt), 0);
		final.push(...pairRuns.filter(run => run.attempt === attempt));
	}
	return final;
}

export function collectInvalidInfrastructurePairs(
	runs: readonly { pair: number; infrastructure: InfrastructureFailureSummary }[],
): number[] {
	return [...new Set(runs.filter(run => run.infrastructure.failed).map(run => run.pair))].sort((a, b) => a - b);
}

function summarizeMode(mode: ContextSteadyBenchmarkMode, runs: readonly BenchmarkRunResult[]): BenchmarkModeSummary {
	const selected = runs.filter(run => run.mode === mode);
	const qualityPassed = selected.filter(run => run.qualityPassed).length;
	const probe = selected.flatMap(run => (run.probe ? [run.probe] : []));
	const estimatedCost = probe.reduce((sum, item) => sum + item.estimatedCost, 0);
	return {
		mode,
		runs: selected.length,
		qualityPassed,
		passRate: selected.length > 0 ? qualityPassed / selected.length : 0,
		promptTokens: probe.reduce((sum, item) => sum + item.promptTokens, 0),
		maintenancePromptTokens: probe.reduce((sum, item) => sum + item.maintenancePromptTokens, 0),
		outputTokens: probe.reduce((sum, item) => sum + item.outputTokens, 0),
		cacheReadTokens: probe.reduce((sum, item) => sum + item.cacheReadTokens, 0),
		estimatedCost,
		maintenanceEstimatedCost: probe.reduce((sum, item) => sum + item.maintenanceEstimatedCost, 0),
		costPerPass: qualityPassed > 0 ? estimatedCost / qualityPassed : null,
		maxActiveTokens: probe.reduce((max, item) => Math.max(max, item.maxActiveTokens), 0),
		maxRawTokens: probe.reduce((max, item) => Math.max(max, item.maxRawTokens), 0),
	};
}

export function summarizeComparablePairs(runs: readonly ComparablePairInput[]): ComparablePairSummary {
	const pairIds = [...new Set(runs.map(run => run.pair))];
	let comparablePairs = 0;
	let nativePromptTokens = 0;
	let steadyPromptTokens = 0;
	let nativeCost = 0;
	let steadyCost = 0;
	const promptSavingsRates: number[] = [];
	const costSavingsRates: number[] = [];
	for (const pairId of pairIds) {
		const pair = runs.filter(run => run.pair === pairId);
		const native = pair.find(run => run.mode === "native");
		const steady = pair.find(run => run.mode === "steady");
		if (!native?.qualityPassed || !steady?.qualityPassed || !native.probe || !steady.probe) continue;
		comparablePairs++;
		nativePromptTokens += native.probe.promptTokens;
		steadyPromptTokens += steady.probe.promptTokens;
		nativeCost += native.probe.estimatedCost;
		steadyCost += steady.probe.estimatedCost;
		if (native.probe.promptTokens > 0) {
			promptSavingsRates.push((native.probe.promptTokens - steady.probe.promptTokens) / native.probe.promptTokens);
		}
		if (native.probe.estimatedCost > 0) {
			costSavingsRates.push((native.probe.estimatedCost - steady.probe.estimatedCost) / native.probe.estimatedCost);
		}
	}
	return {
		totalPairs: pairIds.length,
		comparablePairs,
		nativePromptTokens,
		steadyPromptTokens,
		promptTokenDelta: steadyPromptTokens - nativePromptTokens,
		promptTokenSavingsRate:
			nativePromptTokens > 0 ? (nativePromptTokens - steadyPromptTokens) / nativePromptTokens : null,
		nativeCost,
		steadyCost,
		costDelta: steadyCost - nativeCost,
		costSavingsRate: nativeCost > 0 ? (nativeCost - steadyCost) / nativeCost : null,
		promptSavingsDistribution: summarizePairedDistribution(promptSavingsRates),
		costSavingsDistribution: summarizePairedDistribution(costSavingsRates),
	};
}

function quantile(sorted: readonly number[], probability: number): number {
	if (sorted.length === 0) throw new Error("Cannot calculate a quantile from an empty sample");
	if (sorted.length === 1) return sorted[0]!;
	const position = (sorted.length - 1) * probability;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const weight = position - lower;
	return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function bootstrapMedianInterval(values: readonly number[]): { low: number; high: number } {
	const medians: number[] = [];
	let state = 0x5a17c9e3;
	const nextIndex = (): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % values.length;
	};
	for (let sample = 0; sample < 2000; sample++) {
		const resampled = Array.from({ length: values.length }, () => values[nextIndex()]!).sort((a, b) => a - b);
		medians.push(quantile(resampled, 0.5));
	}
	medians.sort((a, b) => a - b);
	return { low: quantile(medians, 0.025), high: quantile(medians, 0.975) };
}

function summarizePairedDistribution(values: readonly number[]): PairedDistributionSummary | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const interval = bootstrapMedianInterval(sorted);
	return {
		count: sorted.length,
		median: quantile(sorted, 0.5),
		q1: quantile(sorted, 0.25),
		q3: quantile(sorted, 0.75),
		bootstrap95Low: interval.low,
		bootstrap95High: interval.high,
	};
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatPairedDistribution(summary: PairedDistributionSummary | null): string {
	if (!summary) return "n/a";
	return `中位数 ${formatPercent(summary.median)}，IQR ${formatPercent(summary.q1)}–${formatPercent(summary.q3)}，bootstrap 95% CI ${formatPercent(summary.bootstrap95Low)}–${formatPercent(summary.bootstrap95High)}`;
}

function renderReport(output: BenchmarkOutput): string {
	const rows = output.summaries
		.map(
			summary =>
				`<tr><td>${summary.mode}</td><td>${summary.qualityPassed}/${summary.runs}</td><td>${formatNumber(summary.promptTokens)}</td><td>${formatNumber(summary.maintenancePromptTokens)}</td><td>${formatNumber(summary.cacheReadTokens)}</td><td>$${formatNumber(summary.estimatedCost)}</td><td>$${formatNumber(summary.maintenanceEstimatedCost)}</td><td>${summary.costPerPass === null ? "n/a" : `$${formatNumber(summary.costPerPass)}`}</td><td>${formatNumber(summary.maxActiveTokens)}</td><td>${formatNumber(summary.maxRawTokens)}</td></tr>`,
		)
		.join("\n");
	const paired = output.paired;
	const invalidPairs = output.invalidInfrastructurePairs;
	const pairedConclusion =
		paired.comparablePairs > 0
			? `质量双通过配对 ${paired.comparablePairs}/${paired.totalPairs}；Prompt 差值 ${formatNumber(paired.promptTokenDelta)}，配对节省 ${formatPairedDistribution(paired.promptSavingsDistribution)}；成本差值 $${formatNumber(paired.costDelta)}，配对节省 ${formatPairedDistribution(paired.costSavingsDistribution)}。`
			: `质量双通过配对 0/${paired.totalPairs}，不输出效率结论。`;
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>San Context Steady Benchmark</title><style>body{margin:40px auto;max-width:1180px;padding:0 20px;font:15px/1.6 system-ui;color:#182221}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d8e1df;padding:9px;text-align:left}th{background:#edf3f1}code{background:#edf3f1;padding:2px 5px}.note{border-left:4px solid #176b52;background:#e7f4ee;padding:12px}</style></head><body><h1>San Context Steady Benchmark</h1><p>Profile: <code>${output.profile}</code> · Model: <code>${output.model}</code> · Seed: <code>${output.seed}</code></p><p class="note">${pairedConclusion} 基础设施无效配对 ${invalidPairs.length}${invalidPairs.length > 0 ? `（${invalidPairs.join(", ")}）` : ""}，已从最终质量与效率汇总中排除。效率结论只在质量通过的配对运行之间成立；总成本包含 Agent、TurnDigest 与 LLM Compaction 请求，Snapcompact 本地维护不产生模型 usage。原始数据见同目录 summary.json 和每次运行 artifact。</p><table><thead><tr><th>模式</th><th>质量通过</th><th>Prompt tokens</th><th>维护 Prompt</th><th>Cache read</th><th>总成本</th><th>维护成本</th><th>Cost/pass</th><th>Max active</th><th>Max raw</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

async function runPlanItem(
	item: BenchmarkPlanItem,
	options: CliOptions,
	attempt: number,
	runtimeApiKeys: ReadonlyMap<string, string>,
	additionalSecretValues: readonly string[],
): Promise<BenchmarkRunResult> {
	const runDir = path.join(options.outDir, item.task.id, `pair-${item.pair}`, `attempt-${attempt}`, item.mode);
	const resultPath = path.join(runDir, "result.json");
	if (options.resume) {
		const existing = await readExistingResult(resultPath);
		if (existing) return existing;
	}
	await fs.mkdir(runDir, { recursive: true });
	const workspace = path.join(
		options.workspaceRoot,
		`${String(item.sequence).padStart(3, "0")}-${item.task.id}-${item.mode}-a${attempt}`,
	);
	const fixture = resolveFixture(item.task, options.taskFile, options.sourceCwd);
	const fixtureHash = await hashDirectory(fixture);
	const taskHash = sha256Text(JSON.stringify(item.task));
	await copyWorkspace(fixture, workspace);
	const baselineCommit = await initializeWorkspaceRepository(workspace);
	const config = item.mode === "native" ? options.nativeConfig : options.steadyConfig;
	const evidenceController = item.task.evidenceChain
		? createBenchmarkEvidenceChainController(item.task.evidenceChain)
		: undefined;
	const extensions = [
		createBenchmarkWorkspaceExtension(workspace),
		...(evidenceController ? [createBenchmarkEvidenceExtension(evidenceController)] : []),
	];
	const agent = await runSingleAgentTask({
		agentDir: options.agentDir,
		config,
		cwd: workspace,
		expect: "passed",
		label: `${options.label}-${item.task.id}-r${item.run}-${item.mode}-a${attempt}`,
		model: options.model,
		objective: item.task.objective,
		runtimeApiKeys,
		additionalSecretValues,
		...(item.task.followUps ? { followUps: item.task.followUps } : {}),
		sessionOptions: {
			toolNames: [...BENCHMARK_TOOL_NAMES],
			strictToolNames: true,
			toolPathScope: workspace,
			toolPathScopeExemptToolNames: [...BENCHMARK_PATH_SCOPE_EXEMPT_TOOL_NAMES],
			extensions,
			skills: [],
			rules: [],
			contextFiles: [],
		},
	});
	const evidenceArtifact = evidenceController ? path.join(runDir, "evidence-state.json") : undefined;
	if (evidenceArtifact && item.task.evidenceChain && evidenceController) {
		await writeJson(evidenceArtifact, {
			schemaVersion: 1,
			spec: item.task.evidenceChain,
			state: evidenceController.state,
		});
	}
	const diffArtifact = path.join(runDir, "diff.patch");
	await writeWorkspaceDiff(workspace, baselineCommit, diffArtifact);
	const verifier = await runVerifier(item.task.verifier, workspace, options.taskFile, evidenceArtifact);
	const sessionArtifact = await copyEvidenceFile(agent.sessionFile, path.join(runDir, "session.jsonl"));
	const sourceProbe = agent.sessionFile ? agent.sessionFile.replace(/\.jsonl$/, ".context-probe.jsonl") : undefined;
	const probeArtifact = await copyEvidenceFile(sourceProbe, path.join(runDir, "context-probe.jsonl"));
	const sessionText = sessionArtifact ? await Bun.file(sessionArtifact).text() : undefined;
	const probeText = probeArtifact ? await Bun.file(probeArtifact).text() : undefined;
	const probe = probeText === undefined ? null : summarizeContextProbe(probeText, options.priceTable);
	const infrastructure = sessionText
		? summarizeInfrastructureFailures(sessionText, probeText)
		: { failed: false, events: [] };
	const evidenceProtocol = item.task.evidenceChain
		? sessionText
			? summarizeBenchmarkEvidenceProtocol(sessionText, item.task.evidenceChain.steps)
			: {
					expectedDirectCalls: item.task.evidenceChain.steps,
					directCalls: 0,
					assistantMessagesWithCalls: 0,
					maxCallsPerAssistantMessage: 0,
					valid: false,
				}
		: null;
	await Bun.write(path.join(runDir, "verify.stdout.log"), verifier.stdout);
	await Bun.write(path.join(runDir, "verify.stderr.log"), verifier.stderr);
	const result: BenchmarkRunResult = {
		sequence: item.sequence,
		pair: item.pair,
		run: item.run,
		attempt,
		taskId: item.task.id,
		taskLabel: item.task.label,
		mode: item.mode,
		workspace,
		baselineCommit,
		fixtureHash,
		taskHash,
		config,
		...(sessionArtifact ? { sessionFile: sessionArtifact } : {}),
		...(probeArtifact ? { probeFile: probeArtifact } : {}),
		...(evidenceArtifact ? { evidenceFile: evidenceArtifact } : {}),
		diffFile: diffArtifact,
		agent,
		probe,
		evidenceProtocol,
		verifier,
		infrastructure,
		qualityPassed:
			!infrastructure.failed && agent.status === "passed" && verifier.ok && (evidenceProtocol?.valid ?? true),
	};
	await writeJson(resultPath, result);
	return result;
}

async function main(): Promise<void> {
	const options = parseOptions();
	const tasks = await loadTasks(options.taskFile);
	const plan = buildBenchmarkPlan(tasks, options.profile, options.seed);
	const sourceRoot = await gitRoot(options.sourceCwd);
	const worktree = await gitWorktreeState(sourceRoot);
	const agentModelConfigHash = await hashAgentModelConfig(options.agentDir);
	const provenance = {
		sourceRoot,
		sourceCommit: await gitRevision(sourceRoot),
		sourceDirty: worktree.dirty,
		...(worktree.diffHash ? { sourceDiffHash: worktree.diffHash } : {}),
		...(agentModelConfigHash ? { agentModelConfigHash } : {}),
		taskFileHash: await hashFile(options.taskFile),
		nativeConfigHash: await hashFile(options.nativeConfig),
		steadyConfigHash: await hashFile(options.steadyConfig),
	};
	const maxRunsWithInfrastructureRetries = plan.length * (1 + options.infrastructureRetries);
	const estimatedTotal =
		options.estimatedCostPerRun === undefined
			? undefined
			: options.estimatedCostPerRun * maxRunsWithInfrastructureRetries;
	const keyEnvironment = options.runtimeKeysStdin
		? { source: "stdin" }
		: options.nativeKeyEnv.size > 0
			? {
					source: "environment",
					native: Object.fromEntries(options.nativeKeyEnv),
					steady: Object.fromEntries(options.steadyKeyEnv),
				}
			: undefined;
	const planOutput = {
		profile: options.profile,
		runs: plan.length,
		maxRunsWithInfrastructureRetries,
		pairs: plan.length / 2,
		tasks: [...new Set(plan.map(item => item.task.id))],
		seed: options.seed,
		model: options.model,
		provenance,
		maxEstimatedCost: options.maxEstimatedCost,
		...(keyEnvironment ? { keyEnvironment } : {}),
		...(options.estimatedCostPerRun === undefined
			? {}
			: { estimatedCostPerRun: options.estimatedCostPerRun, maxEstimatedTotal: estimatedTotal }),
	};
	await Bun.write(Bun.stdout, `${JSON.stringify(planOutput, null, 2)}\n`);
	if (options.estimateOnly) return;
	assertSecureRuntimeKeyTransport(options.estimateOnly, options.nativeKeyEnv.size + options.steadyKeyEnv.size);
	if (
		(options.profile === "release" || options.profile === "extended") &&
		provenance.sourceDirty &&
		!options.allowDirtySource
	) {
		throw new Error(
			`${options.profile} evidence requires a clean source commit; commit/stash the worktree or pass --allow-dirty-source and publish sourceDiffHash`,
		);
	}
	assertBenchmarkCostGuard({
		profile: options.profile,
		plannedRuns: plan.length,
		maximumRuns: maxRunsWithInfrastructureRetries,
		...(options.estimatedCostPerRun === undefined ? {} : { estimatedCostPerRun: options.estimatedCostPerRun }),
		maxEstimatedCost: options.maxEstimatedCost,
		allowExpensive: options.allowExpensive,
	});
	const runtimeApiKeys = options.runtimeKeysStdin
		? parseRuntimeApiKeysStdin(await Bun.stdin.text(), options.model)
		: consumeRuntimeApiKeys(options);
	const inheritedSecretValues = runtimeApiKeys.native.size > 0 ? consumeInheritedSecretEnvironment(process.env) : [];
	await fs.mkdir(options.outDir, { recursive: true });
	await fs.mkdir(options.workspaceRoot, { recursive: true });
	await writeJson(path.join(options.outDir, "manifest.json"), {
		schemaVersion: 1,
		label: options.label,
		profile: options.profile,
		seed: options.seed,
		model: options.model,
		priceTable: options.priceTable,
		provenance,
		...(keyEnvironment ? { keyEnvironment } : {}),
		infrastructureRetries: options.infrastructureRetries,
		plan: plan.map(item => ({
			sequence: item.sequence,
			pair: item.pair,
			run: item.run,
			mode: item.mode,
			taskId: item.task.id,
		})),
	});
	const startedAt = new Date().toISOString();
	const runs: BenchmarkRunResult[] = [];
	let executedRuns = 0;
	for (const pair of new Set(plan.map(item => item.pair))) {
		const pairItems = plan.filter(item => item.pair === pair);
		let attempt = 1;
		while (true) {
			const attemptResults: BenchmarkRunResult[] = [];
			for (const item of pairItems) {
				const result = await runPlanItem(item, options, attempt, runtimeApiKeys[item.mode], inheritedSecretValues);
				runs.push(result);
				attemptResults.push(result);
				executedRuns++;
				await Bun.write(
					Bun.stdout,
					`${executedRuns}/${maxRunsWithInfrastructureRetries} ${item.task.id} ${item.mode} attempt=${attempt}: infrastructure=${result.infrastructure.failed ? "fail" : "ok"}; quality=${result.qualityPassed ? "pass" : "fail"}; prompt=${result.probe?.promptTokens ?? 0}; cost=${result.probe?.estimatedCost.toFixed(4) ?? "n/a"}\n`,
				);
			}
			const infrastructureFailed = attemptResults.some(result => result.infrastructure.failed);
			if (!infrastructureFailed || attempt > options.infrastructureRetries) break;
			await Bun.write(
				Bun.stdout,
				`Pair ${pair} is invalid because of provider infrastructure failure; rerunning both modes once.\n`,
			);
			attempt++;
		}
	}
	const finalPairRuns = selectFinalPairAttempts(runs);
	const invalidInfrastructurePairs = collectInvalidInfrastructurePairs(finalPairRuns);
	const validPairRuns = finalPairRuns.filter(run => !invalidInfrastructurePairs.includes(run.pair));
	const output: BenchmarkOutput = {
		schemaVersion: 1,
		label: options.label,
		profile: options.profile,
		seed: options.seed,
		startedAt,
		completedAt: new Date().toISOString(),
		model: options.model,
		taskFile: options.taskFile,
		sourceCwd: options.sourceCwd,
		provenance,
		priceTable: options.priceTable,
		attemptedRuns: runs.length,
		finalRuns: finalPairRuns.length,
		validFinalRuns: validPairRuns.length,
		invalidInfrastructurePairs,
		plan: plan.map(item => ({
			sequence: item.sequence,
			pair: item.pair,
			run: item.run,
			mode: item.mode,
			taskId: item.task.id,
		})),
		runs,
		summaries: [summarizeMode("native", validPairRuns), summarizeMode("steady", validPairRuns)],
		paired: summarizeComparablePairs(validPairRuns),
	};
	await writeJson(path.join(options.outDir, "summary.json"), output);
	await Bun.write(path.join(options.outDir, "report.html"), renderReport(output));
}

if (import.meta.main) {
	await main();
}
