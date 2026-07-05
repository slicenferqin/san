#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

interface PreparedProvider {
	name: string;
	selector: string;
	baseUrl: string;
	model: string;
	hasKey: boolean;
}

interface PrepareResult {
	agentDir: string;
	modelsPath: string;
	providers: PreparedProvider[];
	command: string;
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

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		return (await Bun.file(filePath).json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function readTomlFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		return Bun.TOML.parse(await Bun.file(filePath).text()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function stringField(record: Record<string, unknown> | undefined | null, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringFieldFrom(
	record: Record<string, unknown> | undefined | null,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = stringField(record, key);
		if (value) return value;
	}
	return undefined;
}

function numberField(record: Record<string, unknown> | undefined | null, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanFieldFrom(
	record: Record<string, unknown> | undefined | null,
	keys: readonly string[],
): boolean | undefined {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined | null, key: string): Record<string, unknown> | null {
	const value = record?.[key];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function codexApiFromWireApi(value: string | undefined): "openai-completions" | "openai-responses" {
	return value === "chat" || value === "chat_completions" || value === "chat-completions"
		? "openai-completions"
		: "openai-responses";
}

function normalizeClaudeModel(value: string | undefined): string {
	if (!value || value === "fable" || value === "sonnet") return "claude-sonnet-4-5-20250929";
	if (value === "opus") return "claude-opus-4-5-20251101";
	if (value.startsWith("claude-")) return value;
	return value;
}

const agentDir = path.resolve(expandHome(argValue("--agent-dir") ?? "/private/tmp/san-v02-agent"));
const modelsPath = path.join(agentDir, "models.yml");
const claudeSettings = await readJsonFile(path.join(os.homedir(), ".claude", "settings.json"));
const codexConfig = await readTomlFile(path.join(os.homedir(), ".codex", "config.toml"));
const codexAuth = await readJsonFile(path.join(os.homedir(), ".codex", "auth.json"));

const claudeEnv = nestedRecord(claudeSettings, "env");
const codexProviders = nestedRecord(codexConfig, "model_providers");
const codexProviderName = stringField(codexConfig, "model_provider") ?? "custom";
const codexSelectedProvider = nestedRecord(codexProviders, codexProviderName) ?? nestedRecord(codexProviders, "custom");

const workerBaseUrl = "https://model-proxy.yowant.team";
const workerModel = "qwen3.7-max-2026-06-08";
const workerKey =
	process.env.SAN_WORKER_ANTHROPIC_AUTH_TOKEN ??
	process.env.ANTHROPIC_AUTH_TOKEN ??
	process.env.SAN_WORKER_ANTHROPIC_API_KEY ??
	process.env.ANTHROPIC_API_KEY;
const claudeKey = stringField(claudeEnv, "ANTHROPIC_AUTH_TOKEN") ?? stringField(claudeEnv, "ANTHROPIC_API_KEY");
const openaiKey = stringField(codexAuth, "OPENAI_API_KEY");

const claudeModel = normalizeClaudeModel(
	stringField(claudeSettings, "model") ?? stringField(claudeEnv, "ANTHROPIC_MODEL"),
);
const openaiModel = stringField(codexConfig, "model") ?? "gpt-5.5";
const openaiBaseUrl = stringFieldFrom(codexSelectedProvider, ["base_url", "baseUrl"]) ?? "https://api.openai.com/v1";
const openaiApi = codexApiFromWireApi(stringFieldFrom(codexSelectedProvider, ["wire_api", "wireApi"]));
const openaiAuthHeader = booleanFieldFrom(codexSelectedProvider, ["requires_openai_auth", "authHeader"]) ?? true;
const openaiContextWindow = numberField(codexConfig, "model_context_window") ?? 500000;
const openaiMaxTokens = numberField(codexConfig, "model_max_output_tokens") ?? 128000;
const openaiEffort = stringField(codexConfig, "model_reasoning_effort") ?? "xhigh";

const modelsConfig = {
	providers: {
		"model-proxy": {
			baseUrl: workerBaseUrl,
			apiKey: workerKey ?? "SAN_WORKER_ANTHROPIC_AUTH_TOKEN",
			api: "anthropic-messages",
			models: [
				{
					id: workerModel,
					name: `Model Proxy ${workerModel}`,
					contextWindow: 1000000,
					maxTokens: 32768,
					supportsTools: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
		"claude-code": {
			baseUrl: stringField(claudeEnv, "ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
			apiKey: claudeKey ?? "ANTHROPIC_AUTH_TOKEN",
			api: "anthropic-messages",
			models: [
				{
					id: claudeModel,
					name: `Claude Code ${claudeModel}`,
					contextWindow: 200000,
					maxTokens: 8192,
					supportsTools: true,
					reasoning: true,
					thinking: {
						mode: "effort",
						efforts: ["low", "medium", "high"],
						defaultLevel: "medium",
					},
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
		vb: {
			baseUrl: openaiBaseUrl,
			apiKey: openaiKey ?? "OPENAI_API_KEY",
			api: openaiApi,
			authHeader: openaiAuthHeader,
			models: [
				{
					id: openaiModel,
					name: `GPT ${openaiModel}`,
					contextWindow: openaiContextWindow,
					maxTokens: openaiMaxTokens,
					supportsTools: true,
					reasoning: true,
					thinking: {
						mode: "effort",
						efforts: ["low", "medium", "high", "xhigh"],
						defaultLevel: openaiEffort,
					},
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
	},
};

await fs.mkdir(agentDir, { recursive: true });
await Bun.write(modelsPath, YAML.stringify(modelsConfig, null, 2));

const providers: PreparedProvider[] = [
	{
		name: "worker",
		selector: `model-proxy/${workerModel}`,
		baseUrl: workerBaseUrl,
		model: workerModel,
		hasKey: Boolean(workerKey),
	},
	{
		name: "supervisor",
		selector: `claude-code/${claudeModel}`,
		baseUrl: stringField(claudeEnv, "ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
		model: claudeModel,
		hasKey: Boolean(claudeKey),
	},
	{
		name: "commander_oracle",
		selector: `vb/${openaiModel}`,
		baseUrl: openaiBaseUrl,
		model: openaiModel,
		hasKey: Boolean(openaiKey),
	},
];

const result: PrepareResult = {
	agentDir,
	modelsPath,
	providers,
	command:
		`PI_CODING_AGENT_DIR=${agentDir} ` +
		"bun packages/coding-agent/scripts/san-v02-acceptance-runner.ts " +
		"--config packages/coding-agent/examples/config/san-execution-loop-heterogeneous.yml " +
		"--objective '<task objective>'",
};

const safeDebug = {
	...result,
	keys: {
		"model-proxy": Boolean(workerKey),
		"claude-code": Boolean(claudeKey),
		vb: Boolean(openaiKey),
	},
};

await Bun.write(Bun.stdout, `${JSON.stringify(safeDebug, null, 2)}\n`);
