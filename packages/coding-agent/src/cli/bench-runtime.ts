import type { ResolvedThinkingLevel } from "@san/agent";
import type { Api, ApiKeyResolver, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@san/ai";
import { buildModelProviderPriorityRank } from "@san/catalog/identity";
import { getProjectDir, logger } from "@san/utils";
import chalk from "chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { concreteThinkingLevel, resolveThinkingLevelForModel } from "../thinking";

/** Injection point for the provider call; tests can substitute a synthetic stream. */
export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Model catalog and credential surface a benchmark command depends on. */
export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

/** Live registry plus settings and teardown hook backing it. */
export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

/** One resolved benchmark subject. */
export interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Open auth storage, settings, and the model registry for a benchmark run. */
export async function createDefaultBenchRuntime(): Promise<BenchRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((left, right) => {
		const leftRank = priority.get(left.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const rightRank = priority.get(right.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return leftRank - rightRank;
	})[0];
}

/**
 * Redirect an unpinned selector to an equivalent model with configured auth.
 * Explicit provider/model selectors remain authoritative.
 */
function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;
	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};
	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

/** Resolve selectors and warn when an equivalent authenticated provider wins. */
export function resolveBenchTargets(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): BenchTarget[] {
	const preferences = getModelMatchPreferences(settings);
	const resolved: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			settings,
			preferences,
		});
		if (result.error) {
			errors.push(`${selector}: ${result.error}`);
			continue;
		}
		if (!result.model) {
			errors.push(`${selector}: model not found`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`Warning: ${result.warning}`)}\n`);
		let model = result.model;
		const authenticated = resolveAuthenticatedAlternative(selector, model, modelRegistry, preferences.providerOrder);
		if (authenticated) {
			writeStderr(
				`${chalk.yellow(
					`Warning: no credentials for "${model.provider}"; benchmarking ${formatModelString(authenticated)} instead. Pin "${formatModelString(model)}" to force it.`,
				)}\n`,
			);
			model = authenticated;
		}
		resolved.push({
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, concreteThinkingLevel(result.thinkingLevel)),
		});
	}
	if (errors.length > 0) {
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	}
	logger.debug("if-bench targets resolved", { count: resolved.length });
	return resolved;
}
