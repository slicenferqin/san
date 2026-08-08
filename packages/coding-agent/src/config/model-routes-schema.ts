import { scope } from "arktype";

const { type } = scope({}, { jitless: true });

export const LOGICAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const RouteFailureCategorySchema = type(
	'"rate_limit" | "quota" | "timeout" | "network" | "server_error" | "model_unavailable" | "auth_failed" | "context_overflow" | "invalid_request" | "refusal" | "user_abort"',
);

export type RouteFailureCategory = typeof RouteFailureCategorySchema.infer;

/**
 * 运行时实际允许 replay 的可配置 fallback 类别（窄集合）。
 *
 * refusal / user_abort / context_overflow 永不会被 runtime 重放，只能用于错误
 * 分类、session entry 与 RPC event（保持完整的 RouteFailureCategory）。配置
 * fallbackOn 时只接受本集合，非法项由 validateLogicalModelsConfiguration 以
 * 精确的 `logicalModels.<id>.policy.fallbackOn[index]` 路径拒绝。
 */
export const RouteFallbackCategorySchema = type(
	'"rate_limit" | "quota" | "timeout" | "network" | "server_error" | "model_unavailable" | "auth_failed" | "invalid_request"',
);

export type RouteFallbackCategory = typeof RouteFallbackCategorySchema.infer;

/** 配置侧允许的 fallback 类别清单，与 RouteFallbackCategorySchema 保持一致。 */
export const RUNTIME_ALLOWED_FALLBACK_CATEGORIES: readonly RouteFallbackCategory[] = Object.freeze([
	"rate_limit",
	"quota",
	"timeout",
	"network",
	"server_error",
	"model_unavailable",
	"auth_failed",
	"invalid_request",
]);

/** 配置侧 fallback 类别运行时可重放性，与 RouteFailureCategory 保持穷尽。 */
const REPLAYABLE_ROUTE_FAILURE_CATEGORY: Readonly<Record<RouteFailureCategory, boolean>> = Object.freeze({
	rate_limit: true,
	quota: true,
	timeout: true,
	network: true,
	server_error: true,
	model_unavailable: true,
	auth_failed: true,
	invalid_request: true,
	context_overflow: false,
	refusal: false,
	user_abort: false,
});

export const ModelRouteBillingSchema = type({
	source: '"override"',
	input: "number >= 0",
	output: "number >= 0",
	cacheRead: "number >= 0",
	cacheWrite: "number >= 0",
});

export const ModelRoutePolicySchema = type({
	"strategy?": '"priority"',
	"affinity?": '"session"',
	"revert?": '"next-turn-after-cooldown" | "never"',
	"fallbackOn?": RouteFailureCategorySchema.array(),
});

export const ModelRouteSchema = type({
	"id?": "string",
	model: "string",
	"priority?": "number",
	"enabled?": "boolean",
	equivalence: '"exact" | "compatible" | "unknown"',
	"billing?": ModelRouteBillingSchema,
});

export const LogicalModelSchema = type({
	"name?": "string",
	"harnessProfile?": "string",
	"policy?": ModelRoutePolicySchema,
	routes: ModelRouteSchema.array(),
});

export const LogicalModelsSchema = type({ "[string]": LogicalModelSchema });

export type ModelRouteBillingConfig = typeof ModelRouteBillingSchema.infer;
export type ModelRoutePolicyConfig = typeof ModelRoutePolicySchema.infer;
export type ModelRouteConfig = typeof ModelRouteSchema.infer;
export type LogicalModelConfig = typeof LogicalModelSchema.infer;
export type LogicalModelsConfig = typeof LogicalModelsSchema.infer;

export class ModelRouteConfigurationError extends Error {
	readonly configPath: string;

	constructor(configPath: string, problem: string) {
		super(`${configPath}: ${problem}`);
		this.name = "ModelRouteConfigurationError";
		this.configPath = configPath;
	}
}

function validateExactConcreteSelector(selector: string, configPath: string): void {
	if (selector !== selector.trim() || selector.length === 0) {
		throw new ModelRouteConfigurationError(configPath, "must be a non-empty exact provider/model selector");
	}
	const slashIndex = selector.indexOf("/");
	if (slashIndex <= 0 || slashIndex === selector.length - 1) {
		throw new ModelRouteConfigurationError(configPath, "must be an exact provider/model selector");
	}
}

/**
 * 校验 ArkType 无法表达的跨字段不变量，并保留精确的 models.yml 配置路径。
 */
export function validateLogicalModelsConfiguration(logicalModels: LogicalModelsConfig | undefined): void {
	if (!logicalModels) return;

	const ownerByConcreteSelector = new Map<string, string>();
	for (const [logicalModelId, logicalModel] of Object.entries(logicalModels)) {
		const logicalPath = `logicalModels.${logicalModelId}`;
		if (!LOGICAL_MODEL_ID_PATTERN.test(logicalModelId)) {
			throw new ModelRouteConfigurationError(
				logicalPath,
				"id must match [a-z0-9][a-z0-9._-]* and must not contain '/' or a thinking suffix",
			);
		}
		if (logicalModel.name !== undefined && logicalModel.name.trim().length === 0) {
			throw new ModelRouteConfigurationError(`${logicalPath}.name`, "must be a non-empty string");
		}
		if (logicalModel.harnessProfile !== undefined && logicalModel.harnessProfile.trim().length === 0) {
			throw new ModelRouteConfigurationError(`${logicalPath}.harnessProfile`, "must be a non-empty string");
		}
		if (logicalModel.routes.length === 0) {
			throw new ModelRouteConfigurationError(`${logicalPath}.routes`, "must contain at least one route");
		}

		const routeIndexById = new Map<string, number>();
		const fallbackIndexByCategory = new Map<RouteFailureCategory, number>();
		for (const [fallbackIndex, category] of (logicalModel.policy?.fallbackOn ?? []).entries()) {
			// LMR-05：拒绝运行时永不执行 replay 的类别（refusal / user_abort /
			// context_overflow），路径精确到 policy.fallbackOn[index]。
			if (!REPLAYABLE_ROUTE_FAILURE_CATEGORY[category]) {
				throw new ModelRouteConfigurationError(
					`${logicalPath}.policy.fallbackOn[${fallbackIndex}]`,
					`fallbackOn category "${category}" is not replayable by runtime routing (never replay: refusal, user_abort, context_overflow)`,
				);
			}
			const previousIndex = fallbackIndexByCategory.get(category);
			if (previousIndex !== undefined) {
				throw new ModelRouteConfigurationError(
					`${logicalPath}.policy.fallbackOn[${fallbackIndex}]`,
					`duplicates fallbackOn category "${category}" from index ${previousIndex}`,
				);
			}
			fallbackIndexByCategory.set(category, fallbackIndex);
		}

		for (const [routeIndex, route] of logicalModel.routes.entries()) {
			const routePath = `${logicalPath}.routes[${routeIndex}]`;
			validateExactConcreteSelector(route.model, `${routePath}.model`);
			if (route.priority !== undefined && !Number.isFinite(route.priority)) {
				throw new ModelRouteConfigurationError(`${routePath}.priority`, "must be a finite number");
			}
			if (route.billing) {
				for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
					if (!Number.isFinite(route.billing[field])) {
						throw new ModelRouteConfigurationError(`${routePath}.billing.${field}`, "must be a finite number");
					}
				}
			}
			const routeId = route.id ?? route.model;
			if (routeId !== routeId.trim() || routeId.length === 0) {
				throw new ModelRouteConfigurationError(`${routePath}.id`, "must be a non-empty stable string");
			}
			const previousRouteIndex = routeIndexById.get(routeId);
			if (previousRouteIndex !== undefined) {
				throw new ModelRouteConfigurationError(
					`${routePath}.id`,
					`duplicates route id "${routeId}" from ${logicalPath}.routes[${previousRouteIndex}]`,
				);
			}
			routeIndexById.set(routeId, routeIndex);

			const previousOwner = ownerByConcreteSelector.get(route.model);
			if (previousOwner !== undefined) {
				throw new ModelRouteConfigurationError(
					`${routePath}.model`,
					`concrete model "${route.model}" is already assigned at ${previousOwner}`,
				);
			}
			ownerByConcreteSelector.set(route.model, `${routePath}.model`);
		}
	}
}
