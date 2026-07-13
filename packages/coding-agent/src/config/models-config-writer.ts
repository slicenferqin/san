/**
 * Safe models.yml writer: comment-preserving path patches under a file lock.
 *
 * Never writes API key material into YAML. Custom providers that need keys use
 * `auth: apiKey` and store secrets in AuthStorage.
 */

import * as path from "node:path";
import type { Api } from "@oh-my-pi/pi-ai/types";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { parseDocument } from "yaml";
import { withFileLock } from "./file-lock";
import type { ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";
import { applyYamlPathPatches, patchYamlFile, type YamlPathPatch } from "./yaml-path-patch";

export interface CustomProviderWriteInput {
	/** Provider id (YAML key under providers.). */
	name: string;
	baseUrl: string;
	api?: Api;
	auth?: ProviderAuthMode;
	discovery?: ProviderDiscovery;
	/** Explicit model stubs. Prefer discovery when possible. */
	models?: Array<{ id: string; name?: string; api?: Api; contextWindow?: number; maxTokens?: number }>;
}

export interface ModelsConfigWriteResult {
	path: string;
	changed: boolean;
	/** True when the provider block was written without embedding secrets. */
	persisted: boolean;
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

function buildProviderValue(input: CustomProviderWriteInput): Record<string, unknown> {
	const auth: ProviderAuthMode = input.auth ?? "apiKey";
	const value: Record<string, unknown> = {
		baseUrl: input.baseUrl,
		auth,
	};
	if (input.api) value.api = input.api;
	if (input.discovery) value.discovery = input.discovery;
	if (input.models && input.models.length > 0) {
		value.models = input.models.map(model => {
			const entry: Record<string, unknown> = { id: model.id };
			if (model.name) entry.name = model.name;
			if (model.api) entry.api = model.api;
			if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
			if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
			return entry;
		});
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
