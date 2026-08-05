import type { Api, Model } from "@san/ai/types";
import { type ModelRouteResolution, type ModelRouteResolutionRequest, resolveModelRoute } from "./model-route-resolver";
import {
	type LogicalModelsConfig,
	type ModelRouteBillingConfig,
	ModelRouteConfigurationError,
	type RouteFailureCategory,
	validateLogicalModelsConfiguration,
} from "./model-routes-schema";

const DEFAULT_ROUTE_FALLBACK_ON: readonly RouteFailureCategory[] = Object.freeze([
	"rate_limit",
	"quota",
	"timeout",
	"network",
	"server_error",
	"model_unavailable",
]);

export interface CompiledModelRoutePolicy {
	readonly strategy: "priority";
	readonly affinity: "session";
	readonly revert: "next-turn-after-cooldown" | "never";
	readonly fallbackOn: readonly RouteFailureCategory[];
}

export interface CompiledModelRoute {
	readonly id: string;
	readonly logicalModelId: string;
	readonly modelSelector: string;
	readonly model: Model<Api>;
	readonly priority: number;
	readonly configOrder: number;
	readonly enabled: boolean;
	readonly equivalence: "exact" | "compatible" | "unknown";
	readonly billing?: Readonly<ModelRouteBillingConfig>;
}

export interface CompiledLogicalModelRouteGroup {
	readonly id: string;
	readonly name: string;
	readonly harnessProfile: string;
	readonly policyVersion: number;
	readonly policy: CompiledModelRoutePolicy;
	readonly routes: readonly CompiledModelRoute[];
}

export interface CompileModelRouteRegistryOptions {
	readonly policyVersion?: number;
}

function exactModelIndex(models: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const index = new Map<string, Model<Api> | null>();
	for (const model of models) {
		const selector = `${model.provider}/${model.id}`;
		index.set(selector, index.has(selector) ? null : model);
	}
	return index;
}

function compileRoutePolicy(policy: LogicalModelsConfig[string]["policy"]): CompiledModelRoutePolicy {
	return Object.freeze({
		strategy: policy?.strategy ?? "priority",
		affinity: policy?.affinity ?? "session",
		revert: policy?.revert ?? "next-turn-after-cooldown",
		fallbackOn: Object.freeze([...(policy?.fallbackOn ?? DEFAULT_ROUTE_FALLBACK_ON)]),
	});
}

/**
 * 显式 Logical Model 配置的不可变编译快照。它只索引用户声明的组，
 * 不扫描或归并同名 concrete model。
 */
export class ModelRouteRegistry {
	readonly policyVersion: number;
	readonly #groups: readonly CompiledLogicalModelRouteGroup[];
	readonly #groupById: ReadonlyMap<string, CompiledLogicalModelRouteGroup>;

	constructor(policyVersion: number, groups: readonly CompiledLogicalModelRouteGroup[]) {
		this.policyVersion = policyVersion;
		this.#groups = Object.freeze([...groups]);
		this.#groupById = new Map(this.#groups.map(group => [group.id, group]));
	}

	static empty(policyVersion = 0): ModelRouteRegistry {
		return new ModelRouteRegistry(policyVersion, []);
	}

	has(logicalModelId: string): boolean {
		return this.#groupById.has(logicalModelId);
	}

	get(logicalModelId: string): CompiledLogicalModelRouteGroup | undefined {
		return this.#groupById.get(logicalModelId);
	}

	getAll(): readonly CompiledLogicalModelRouteGroup[] {
		return this.#groups;
	}

	getRoute(logicalModelId: string, routeId: string): CompiledModelRoute | undefined {
		return this.get(logicalModelId)?.routes.find(route => route.id === routeId);
	}

	findRouteBySelector(logicalModelId: string, modelSelector: string): CompiledModelRoute | undefined {
		return this.get(logicalModelId)?.routes.find(route => route.modelSelector === modelSelector);
	}

	resolve(logicalModelId: string, request: ModelRouteResolutionRequest = {}): ModelRouteResolution | undefined {
		const group = this.get(logicalModelId);
		return group ? resolveModelRoute(group, request) : undefined;
	}
}

export function compileModelRouteRegistry(
	logicalModels: LogicalModelsConfig | undefined,
	models: readonly Model<Api>[],
	options: CompileModelRouteRegistryOptions = {},
): ModelRouteRegistry {
	validateLogicalModelsConfiguration(logicalModels);
	const policyVersion = options.policyVersion ?? 1;
	if (!Number.isSafeInteger(policyVersion) || policyVersion < 0) {
		throw new Error(`Model route policyVersion must be a non-negative safe integer, received ${policyVersion}`);
	}
	if (!logicalModels) return ModelRouteRegistry.empty(policyVersion);

	const modelBySelector = exactModelIndex(models);
	const groups: CompiledLogicalModelRouteGroup[] = [];
	for (const [logicalModelId, logicalModel] of Object.entries(logicalModels)) {
		const routes: CompiledModelRoute[] = logicalModel.routes.map((route, configOrder) => {
			const model = modelBySelector.get(route.model);
			const modelPath = `logicalModels.${logicalModelId}.routes[${configOrder}].model`;
			if (model === undefined) {
				throw new ModelRouteConfigurationError(modelPath, `unknown concrete model "${route.model}"`);
			}
			if (model === null) {
				throw new ModelRouteConfigurationError(modelPath, `ambiguous concrete model "${route.model}"`);
			}
			return Object.freeze({
				id: route.id ?? route.model,
				logicalModelId,
				modelSelector: route.model,
				model,
				priority: route.priority ?? configOrder,
				configOrder,
				enabled: route.enabled ?? true,
				equivalence: route.equivalence,
				...(route.billing !== undefined && { billing: Object.freeze({ ...route.billing }) }),
			});
		});

		groups.push(
			Object.freeze({
				id: logicalModelId,
				name: logicalModel.name ?? logicalModelId,
				harnessProfile: logicalModel.harnessProfile ?? logicalModelId,
				policyVersion,
				policy: compileRoutePolicy(logicalModel.policy),
				routes: Object.freeze(routes),
			}),
		);
	}
	return new ModelRouteRegistry(policyVersion, groups);
}
