import type { Api, Model } from "@san/ai/types";
import { type ModelRouteResolution, type ModelRouteResolutionRequest, resolveModelRoute } from "./model-route-resolver";
import {
	type LogicalModelsConfig,
	type ModelRouteBillingConfig,
	ModelRouteConfigurationError,
	type RouteFallbackCategory,
	validateLogicalModelsConfiguration,
} from "./model-routes-schema";

const DEFAULT_ROUTE_FALLBACK_ON: readonly RouteFallbackCategory[] = Object.freeze([
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
	readonly fallbackOn: readonly RouteFallbackCategory[];
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

/** Route-local effective cost snapshot (per-million-token, four fields). */
export type ModelCostSnapshot = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}>;

/**
 * LMR-02：显式四字段 cost 相等比较。registry recompilation 会为同 selector 创建
 * 新的 route-local model clone，因此禁止用对象身份比较判断 cost 是否变化。
 */
export function modelCostsEqual(a: ModelCostSnapshot | undefined, b: ModelCostSnapshot | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
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
		// validateLogicalModelsConfiguration 已拒绝 unsafe 类别，这里收窄为
		// 编译后保证的 RouteFallbackCategory 集合。
		fallbackOn: Object.freeze([...(policy?.fallbackOn ?? DEFAULT_ROUTE_FALLBACK_ON)] as RouteFallbackCategory[]),
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
			// LMR-02：billing override 构造 route-local effective model，只替换
			// cost 四字段，复制其余 transport/capability/thinking 等字段；绝不
			// 突变 catalog model 或共享 cost 对象。
			const effectiveModel = route.billing
				? Object.freeze({
						...model,
						cost: Object.freeze({
							input: route.billing.input,
							output: route.billing.output,
							cacheRead: route.billing.cacheRead,
							cacheWrite: route.billing.cacheWrite,
						}),
					})
				: model;
			return Object.freeze({
				id: route.id ?? route.model,
				logicalModelId,
				modelSelector: route.model,
				model: effectiveModel,
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
