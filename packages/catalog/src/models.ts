import { buildModel } from "./build";
import MODELS_EMBED from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, ModelSpec, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
type BundledModels = Record<string, Record<string, ModelSpec<Api>>>;

let bundledModels: BundledModels | undefined;
let modelRegistry: Map<string, Map<string, Model<Api>>> | undefined;

function getBundledModelSpecs(): BundledModels {
	if (bundledModels === undefined) {
		bundledModels =
			typeof MODELS_EMBED === "string"
				? (JSON.parse(
						new TextDecoder().decode(Bun.gunzipSync(Buffer.from(MODELS_EMBED, "base64"))),
					) as BundledModels)
				: (MODELS_EMBED as BundledModels);
	}
	return bundledModels;
}

/** Build (once) and return the enriched bundled-model registry. Lazy: enrichment of ~12K models is deferred off module load. */
function getModelRegistry(): Map<string, Map<string, Model<Api>>> {
	if (modelRegistry === undefined) {
		modelRegistry = new Map();
		for (const [provider, models] of Object.entries(getBundledModelSpecs())) {
			const providerModels = new Map<string, Model<Api>>();
			for (const [id, model] of Object.entries(models)) {
				providerModels.set(id, buildModel(model as ModelSpec<Api>));
			}
			modelRegistry.set(provider, providerModels);
		}
	}
	return modelRegistry;
}

export type GeneratedProvider = keyof typeof MODELS_EMBED;

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getModelRegistry().get(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return Object.keys(getBundledModelSpecs()) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getModelRegistry().get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const orchestration = usage.orchestration;
	usage.cost.input = (model.cost.input / 1000000) * (usage.input + (orchestration?.input ?? 0));
	usage.cost.output = (model.cost.output / 1000000) * (usage.output + (orchestration?.output ?? 0));
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0));
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
