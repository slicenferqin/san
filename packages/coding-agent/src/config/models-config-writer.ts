/**
 * Safe models.yml writer: comment-preserving path patches under a file lock.
 *
 * Never writes API key material into YAML. Custom providers that need keys use
 * `auth: apiKey` and store secrets in AuthStorage.
 */

import * as path from "node:path";
import type { Api } from "@san/ai/types";
import { getBundledProviders } from "@san/catalog/models";
import { getAgentDir, isEnoent } from "@san/utils";
import { parseDocument } from "yaml";
import { withFileLock } from "./file-lock";
import type { ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";
import { applyYamlPathPatches, patchYamlFile, type YamlPathPatch } from "./yaml-path-patch";

export interface CustomModelWriteInput {
	provider: string;
	id: string;
	name?: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	supportsTools?: boolean;
}

export interface CustomProviderWriteInput {
	/** Provider id (YAML key under providers.). */
	name: string;
	baseUrl: string;
	api?: Api;
	auth?: ProviderAuthMode;
	discovery?: ProviderDiscovery;
	/** Explicit model stubs. Prefer discovery when possible. */
	models?: Array<Omit<CustomModelWriteInput, "provider">>;
}

export interface ModelsConfigWriteResult {
	path: string;
	changed: boolean;
	/** True when the provider block was written without embedding secrets. */
	persisted: boolean;
}

export interface CustomProviderConfigSummary {
	providerId: string;
	baseUrl: string;
	api?: Api;
	auth: ProviderAuthMode;
	discoveryType?: ProviderDiscovery["type"];
	modelCount: number;
}

function modelsConfigPath(explicit?: string): string {
	return explicit ?? path.join(getAgentDir(), "models.yml");
}

const BUNDLED_PROVIDER_IDS = new Set<string>(getBundledProviders());
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateProviderId(providerId: string): void {
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error("Provider id must use 1-64 lowercase letters, numbers, dots, underscores, or dashes");
	}
}

function validateCustomProviderId(providerId: string): void {
	validateProviderId(providerId);
	if (BUNDLED_PROVIDER_IDS.has(providerId)) {
		throw new Error(`Provider id "${providerId}" is reserved by the bundled catalog`);
	}
}

export function validateCustomProviderConfigInput(input: CustomProviderWriteInput): void {
	validateCustomProviderId(input.name);
	let endpoint: URL;
	try {
		endpoint = new URL(input.baseUrl);
	} catch {
		throw new Error("Provider base URL must be a valid URL");
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("Provider base URL must use http or https");
	}
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error("Provider base URL must not contain credentials, query parameters, or fragments");
	}
}

function assertProviderDoesNotExist(source: string, providerId: string): void {
	if (!source) return;
	const doc = parseDocument(source, { prettyErrors: false });
	if (doc.errors.length > 0) {
		throw new Error("Invalid models.yml document");
	}
	if (doc.hasIn(["providers", providerId])) {
		throw new Error(`Provider id "${providerId}" already exists in models.yml`);
	}
}

function assertProviderExists(source: string, providerId: string): void {
	if (!source) throw new Error(`Provider id "${providerId}" does not exist in models.yml`);
	const doc = parseDocument(source, { prettyErrors: false });
	if (doc.errors.length > 0) throw new Error("Invalid models.yml document");
	if (!doc.hasIn(["providers", providerId])) {
		throw new Error(`Provider id "${providerId}" does not exist in models.yml`);
	}
}

export function validateCustomModelConfigInput(input: CustomModelWriteInput): void {
	validateProviderId(input.provider);
	const modelId = input.id.trim();
	if (!modelId || modelId.length > 128 || /[\u0000-\u001f\u007f]/.test(modelId)) {
		throw new Error("Model id must use 1-128 printable characters");
	}
	for (const [field, value] of [
		["contextWindow", input.contextWindow],
		["maxTokens", input.maxTokens],
	] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
			throw new Error(`${field} must be a positive safe integer`);
		}
	}
	if (input.input && (input.input.length === 0 || new Set(input.input).size !== input.input.length)) {
		throw new Error("Model input capabilities must be non-empty and unique");
	}
}

function buildModelValue(input: Omit<CustomModelWriteInput, "provider">): Record<string, unknown> {
	const entry: Record<string, unknown> = { id: input.id.trim() };
	if (input.name) entry.name = input.name.trim();
	if (input.api) entry.api = input.api;
	if (input.contextWindow !== undefined) entry.contextWindow = input.contextWindow;
	if (input.maxTokens !== undefined) entry.maxTokens = input.maxTokens;
	if (input.reasoning !== undefined) entry.reasoning = input.reasoning;
	if (input.input) entry.input = input.input;
	if (input.supportsTools !== undefined) entry.supportsTools = input.supportsTools;
	return entry;
}

function buildProviderValue(input: CustomProviderWriteInput): Record<string, unknown> {
	const auth: ProviderAuthMode = input.auth ?? "apiKey";
	const value: Record<string, unknown> = {
		baseUrl: input.baseUrl,
		auth,
	};
	if (input.api) value.api = input.api;
	if (input.discovery) value.discovery = input.discovery;
	if (input.models && input.models.length > 0) {
		for (const model of input.models) validateCustomModelConfigInput({ ...model, provider: input.name });
		value.models = input.models.map(buildModelValue);
	}
	// Never persist apiKey bytes here.
	return value;
}

/**
 * Upsert a custom provider into models.yml without embedding API keys.
 * Uses comment-preserving path patches and atomic replace under a file lock.
 */
export async function writeCustomProviderConfig(
	input: CustomProviderWriteInput,
	options?: { modelsPath?: string },
): Promise<ModelsConfigWriteResult> {
	validateCustomProviderConfigInput(input);
	const configPath = modelsConfigPath(options?.modelsPath);
	const providerValue = buildProviderValue(input);
	const patches: YamlPathPatch[] = [{ op: "set", path: ["providers", input.name], value: providerValue }];

	const result = await withFileLock(configPath, async () => {
		return patchYamlFile(configPath, patches, {
			createIfMissing: true,
			validateSource: source => assertProviderDoesNotExist(source, input.name),
		});
	});

	return {
		path: configPath,
		changed: result.changed,
		persisted: true,
	};
}

/** Validate the destination document and provider-id collision before network or secret mutation. */
export async function validateCustomProviderConfigDestination(
	input: CustomProviderWriteInput,
	options?: { modelsPath?: string },
): Promise<void> {
	validateCustomProviderConfigInput(input);
	const configPath = modelsConfigPath(options?.modelsPath);
	await withFileLock(configPath, async () => {
		let source: string;
		try {
			source = await Bun.file(configPath).text();
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		assertProviderDoesNotExist(source, input.name);
	});
}

/** 更新已有自定义服务商的基础字段（baseUrl/api/auth/discovery），保留 models 与密钥。 */
export async function updateCustomProviderConfig(
	providerId: string,
	patch: { baseUrl?: string; api?: Api; auth?: ProviderAuthMode; discovery?: ProviderDiscovery },
	options?: { modelsPath?: string },
): Promise<ModelsConfigWriteResult> {
	validateProviderId(providerId);
	const patches: YamlPathPatch[] = [];
	if (patch.baseUrl !== undefined) {
		if (!patch.baseUrl.trim()) throw new Error("baseUrl must be a non-empty string");
		patches.push({ op: "set", path: ["providers", providerId, "baseUrl"], value: patch.baseUrl.trim() });
	}
	if (patch.api !== undefined) patches.push({ op: "set", path: ["providers", providerId, "api"], value: patch.api });
	if (patch.auth !== undefined) patches.push({ op: "set", path: ["providers", providerId, "auth"], value: patch.auth });
	if (patch.discovery !== undefined)
		patches.push({ op: "set", path: ["providers", providerId, "discovery"], value: patch.discovery });
	const configPath = modelsConfigPath(options?.modelsPath);
	if (patches.length === 0) return { path: configPath, changed: false, persisted: true };
	const result = await withFileLock(configPath, () =>
		patchYamlFile(configPath, patches, {
			validateSource: source => assertProviderExists(source, providerId),
		}),
	);
	return { path: configPath, changed: result.changed, persisted: true };
}


export async function removeCustomProviderConfig(
	providerId: string,
	options?: { modelsPath?: string },
): Promise<{ path: string; changed: boolean; removed: boolean }> {
	validateProviderId(providerId);
	const configPath = modelsConfigPath(options?.modelsPath);
	const result = await withFileLock(configPath, () =>
		patchYamlFile(configPath, [{ op: "delete", path: ["providers", providerId] }], {
			validateSource: source => assertProviderExists(source, providerId),
		}),
	);
	return { path: configPath, changed: result.changed, removed: result.changed };
}

/** 读取可安全展示的自定义服务商配置；API Key 永不进入返回值。 */
export async function listCustomProviderConfigSummaries(options?: {
	modelsPath?: string;
}): Promise<CustomProviderConfigSummary[]> {
	const configPath = modelsConfigPath(options?.modelsPath);
	let source: string;
	try {
		source = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const doc = parseDocument(source, { prettyErrors: false });
	if (doc.errors.length > 0) throw new Error("Invalid models.yml document");
	const root = doc.toJS();
	if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Invalid models.yml root");
	const providers = (root as Record<string, unknown>).providers;
	if (providers === undefined) return [];
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error("models.yml providers must be an object");
	}
	const summaries: CustomProviderConfigSummary[] = [];
	for (const [providerId, raw] of Object.entries(providers as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const provider = raw as Record<string, unknown>;
		if (typeof provider.baseUrl !== "string" || !provider.baseUrl) continue;
		const discovery =
			provider.discovery && typeof provider.discovery === "object" && !Array.isArray(provider.discovery)
				? (provider.discovery as Record<string, unknown>).type
				: undefined;
		const models = provider.models;
		summaries.push({
			providerId,
			baseUrl: provider.baseUrl,
			...(typeof provider.api === "string" ? { api: provider.api as Api } : {}),
			auth: provider.auth === "none" || provider.auth === "oauth" ? provider.auth : "apiKey",
			...(typeof discovery === "string" ? { discoveryType: discovery as ProviderDiscovery["type"] } : {}),
			modelCount: Array.isArray(models) ? models.length : 0,
		});
	}
	return summaries.sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function readProviderModels(source: string, providerId: string): unknown[] {
	assertProviderExists(source, providerId);
	const doc = parseDocument(source, { prettyErrors: false });
	if (doc.errors.length > 0) throw new Error("Invalid models.yml document");
	const root = doc.toJS();
	if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Invalid models.yml root");
	const providers = (root as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error("models.yml providers must be an object");
	}
	const provider = (providers as Record<string, unknown>)[providerId];
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
		throw new Error(`Provider id "${providerId}" is not a configurable provider`);
	}
	const models = (provider as Record<string, unknown>).models;
	if (models === undefined) return [];
	if (!Array.isArray(models)) throw new Error(`Provider "${providerId}" models must be an array`);
	return models;
}

/** 向已有自定义服务商追加显式模型，不重写同级配置。 */
export async function addCustomModelConfig(
	input: CustomModelWriteInput,
	options?: { modelsPath?: string },
): Promise<ModelsConfigWriteResult> {
	validateCustomModelConfigInput(input);
	const configPath = modelsConfigPath(options?.modelsPath);
	const modelValue = buildModelValue(input);
	const result = await withFileLock(configPath, async () => {
		let source: string;
		try {
			source = await Bun.file(configPath).text();
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Provider id "${input.provider}" does not exist in models.yml`);
			throw error;
		}
		const models = readProviderModels(source, input.provider);
		const duplicate = models.some(candidate => {
			return Boolean(
				candidate &&
					typeof candidate === "object" &&
					!Array.isArray(candidate) &&
					(candidate as Record<string, unknown>).id === input.id.trim(),
			);
		});
		if (duplicate) throw new Error(`Model id "${input.id.trim()}" already exists for provider "${input.provider}"`);
		const patch: YamlPathPatch =
			models.length === 0
				? { op: "set", path: ["providers", input.provider, "models"], value: [modelValue] }
				: { op: "set", path: ["providers", input.provider, "models", models.length], value: modelValue };
		return patchYamlFile(configPath, [patch], {
			validateSource: current => {
				const currentModels = readProviderModels(current, input.provider);
				if (currentModels.length !== models.length) throw new Error("models.yml changed while adding the model");
			},
		});
	});
	return { path: configPath, changed: result.changed, persisted: true };
}

/** 从已有自定义服务商删除单个显式模型。 */
export async function removeCustomModelConfig(
	providerId: string,
	modelId: string,
	options?: { modelsPath?: string },
): Promise<{ path: string; changed: boolean; removed: boolean }> {
	validateProviderId(providerId);
	const id = modelId.trim();
	if (!id) throw new Error("Model id must be a non-empty string");
	const configPath = modelsConfigPath(options?.modelsPath);
	const result = await withFileLock(configPath, async () => {
		let source: string;
		try {
			source = await Bun.file(configPath).text();
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Provider id "${providerId}" does not exist in models.yml`);
			throw error;
		}
		const models = readProviderModels(source, providerId);
		const index = models.findIndex(candidate => {
			return Boolean(
				candidate &&
					typeof candidate === "object" &&
					!Array.isArray(candidate) &&
					(candidate as Record<string, unknown>).id === id,
			);
		});
		if (index < 0) throw new Error(`Model id "${id}" does not exist for provider "${providerId}"`);
		return patchYamlFile(configPath, [{ op: "delete", path: ["providers", providerId, "models", index] }], {
			validateSource: current => {
				const currentModels = readProviderModels(current, providerId);
				if (currentModels.length !== models.length) throw new Error("models.yml changed while removing the model");
			},
		});
	});
	return { path: configPath, changed: result.changed, removed: result.changed };
}

/** 更新自定义服务商下的显式模型：按 id 定位并整体替换该条目（id 不可改）。 */
export async function updateCustomModelConfig(
	providerId: string,
	modelId: string,
	input: Omit<CustomModelWriteInput, "provider" | "id">,
	options?: { modelsPath?: string },
): Promise<ModelsConfigWriteResult> {
	validateProviderId(providerId);
	const id = modelId.trim();
	if (!id) throw new Error("Model id must be a non-empty string");
	validateCustomModelConfigInput({ ...input, provider: providerId, id });
	const configPath = modelsConfigPath(options?.modelsPath);
	const modelValue = buildModelValue({ ...input, id });
	const result = await withFileLock(configPath, async () => {
		let source: string;
		try {
			source = await Bun.file(configPath).text();
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Provider id "${providerId}" does not exist in models.yml`);
			throw error;
		}
		const models = readProviderModels(source, providerId);
		const index = models.findIndex(candidate => {
			return Boolean(
				candidate &&
					typeof candidate === "object" &&
					!Array.isArray(candidate) &&
					(candidate as Record<string, unknown>).id === id,
			);
		});
		if (index < 0) throw new Error(`Model id "${id}" does not exist for provider "${providerId}"`);
		return patchYamlFile(configPath, [{ op: "set", path: ["providers", providerId, "models", index], value: modelValue }], {
			validateSource: current => {
				const currentModels = readProviderModels(current, providerId);
				if (currentModels.length !== models.length) throw new Error("models.yml changed while updating the model");
			},
		});
	});
	return { path: configPath, changed: result.changed, persisted: true };
}

/**
 * Preview patches without writing (tests / dry-run).
 */
export function previewCustomProviderConfig(
	source: string,
	input: CustomProviderWriteInput,
): { text: string; changed: boolean } {
	validateCustomProviderConfigInput(input);
	assertProviderDoesNotExist(source, input.name);
	const patches: YamlPathPatch[] = [{ op: "set", path: ["providers", input.name], value: buildProviderValue(input) }];
	const result = applyYamlPathPatches(source, patches);
	return { text: result.text, changed: result.changed };
}
