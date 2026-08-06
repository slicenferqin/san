import { ThinkingLevel } from "@san/agent";
import type { Effort } from "@san/ai";
import { THINKING_EFFORTS } from "@san/catalog/effort";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type { CompiledLogicalModelRouteGroup, CompiledModelRoute } from "./model-route-registry";

export type ModelRouteResolutionReason = "primary" | "affinity" | "failover" | "recovery" | "manual";

export type ModelRouteRejectionCode =
	| "disabled"
	| "unavailable"
	| "unauthenticated"
	| "suppressed"
	| "excluded"
	| "images_unsupported"
	| "tools_unsupported"
	| "context_window_unknown"
	| "context_window_too_small"
	| "output_limit_unknown"
	| "output_limit_too_small"
	| "effort_unsupported"
	| "equivalence_unknown";

export interface ModelRouteRejection {
	readonly code: ModelRouteRejectionCode;
	readonly message: string;
}

export interface ModelRouteResolutionTrace {
	readonly routeId: string;
	readonly modelSelector: string;
	readonly priority: number;
	readonly configOrder: number;
	readonly rank: number;
	readonly eligible: boolean;
	readonly selected: boolean;
	readonly rejections: readonly ModelRouteRejection[];
}

export interface ModelRouteResolutionRequest {
	readonly requiredContextTokens?: number;
	readonly requiredOutputTokens?: number;
	readonly requiresImages?: boolean;
	readonly requiresTools?: boolean;
	readonly thinkingLevel?: ConfiguredThinkingLevel;
	readonly manualRouteId?: string;
	readonly affinityRouteId?: string;
	readonly excludedRouteIds?: ReadonlySet<string>;
	readonly suppressedRouteIds?: ReadonlySet<string>;
	readonly isAvailable?: (route: CompiledModelRoute) => boolean;
	readonly hasAuth?: (route: CompiledModelRoute) => boolean;
	readonly selectionReason?: "primary" | "failover" | "recovery";
}

export interface ModelRouteResolution {
	readonly logicalModelId: string;
	readonly harnessProfile: string;
	readonly policyVersion: number;
	readonly route?: CompiledModelRoute;
	readonly reason?: ModelRouteResolutionReason;
	readonly trace: readonly ModelRouteResolutionTrace[];
}

function validateTokenRequirement(name: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new Error(`${name} must be a non-negative safe integer, received ${value}`);
	}
}

function requestedEffort(level: ConfiguredThinkingLevel | undefined): Effort | undefined {
	if (
		level === undefined ||
		level === AUTO_THINKING ||
		level === ThinkingLevel.Inherit ||
		level === ThinkingLevel.Off
	) {
		return undefined;
	}
	return THINKING_EFFORTS.includes(level as Effort) ? (level as Effort) : undefined;
}

function routePreferenceTier(route: CompiledModelRoute, request: ModelRouteResolutionRequest): number {
	if (route.id === request.manualRouteId) return 0;
	if (route.id === request.affinityRouteId) return 1;
	return 2;
}

function rankRoutes(
	routes: readonly CompiledModelRoute[],
	request: ModelRouteResolutionRequest,
): readonly CompiledModelRoute[] {
	return [...routes].sort((left, right) => {
		const tierDifference = routePreferenceTier(left, request) - routePreferenceTier(right, request);
		if (tierDifference !== 0) return tierDifference;
		if (left.priority !== right.priority) return left.priority - right.priority;
		return left.configOrder - right.configOrder;
	});
}

function collectRejections(
	route: CompiledModelRoute,
	request: ModelRouteResolutionRequest,
): readonly ModelRouteRejection[] {
	const rejections: ModelRouteRejection[] = [];
	if (!route.enabled) {
		rejections.push({ code: "disabled", message: `route ${route.id} is disabled by configuration` });
	}
	if (request.excludedRouteIds?.has(route.id)) {
		rejections.push({ code: "excluded", message: `route ${route.id} is excluded for this resolution` });
	}
	if (request.suppressedRouteIds?.has(route.id)) {
		rejections.push({ code: "suppressed", message: `route ${route.id} is temporarily suppressed` });
	}
	if (request.isAvailable && !request.isAvailable(route)) {
		rejections.push({ code: "unavailable", message: `concrete model ${route.modelSelector} is unavailable` });
	}
	if (request.hasAuth && !request.hasAuth(route)) {
		rejections.push({
			code: "unauthenticated",
			message: `provider ${route.model.provider} has no configured authentication`,
		});
	}
	if (request.requiresImages && !route.model.input.includes("image")) {
		rejections.push({ code: "images_unsupported", message: `model ${route.modelSelector} does not accept images` });
	}
	if (request.requiresTools && route.model.supportsTools === false) {
		rejections.push({ code: "tools_unsupported", message: `model ${route.modelSelector} does not support tools` });
	}
	if (request.requiredContextTokens !== undefined && request.requiredContextTokens > 0) {
		if (route.model.contextWindow === null) {
			rejections.push({
				code: "context_window_unknown",
				message: `model ${route.modelSelector} has an unknown context window`,
			});
		} else if (route.model.contextWindow < request.requiredContextTokens) {
			rejections.push({
				code: "context_window_too_small",
				message: `model ${route.modelSelector} context window ${route.model.contextWindow} is below required ${request.requiredContextTokens}`,
			});
		}
	}
	if (request.requiredOutputTokens !== undefined && request.requiredOutputTokens > 0) {
		if (route.model.maxTokens === null) {
			rejections.push({
				code: "output_limit_unknown",
				message: `model ${route.modelSelector} has an unknown output limit`,
			});
		} else if (route.model.maxTokens < request.requiredOutputTokens) {
			rejections.push({
				code: "output_limit_too_small",
				message: `model ${route.modelSelector} output limit ${route.model.maxTokens} is below required ${request.requiredOutputTokens}`,
			});
		}
	}

	const effort = requestedEffort(request.thinkingLevel);
	if (effort !== undefined && (!route.model.reasoning || !route.model.thinking?.efforts.includes(effort))) {
		rejections.push({
			code: "effort_unsupported",
			message: `model ${route.modelSelector} does not support requested effort ${effort}`,
		});
	} else if (request.thinkingLevel === ThinkingLevel.Off && route.model.thinking?.requiresEffort) {
		rejections.push({
			code: "effort_unsupported",
			message: `model ${route.modelSelector} requires reasoning effort and cannot disable thinking`,
		});
	}
	if (route.equivalence === "unknown" && route.id !== request.manualRouteId) {
		rejections.push({
			code: "equivalence_unknown",
			message: `route ${route.id} has unknown equivalence and requires an explicit manual route`,
		});
	}
	return Object.freeze(rejections);
}

/**
 * 在不可变 group 与调用方提供的状态快照上执行确定性路由，不读取时间、
 * 环境变量、鉴权存储或全局 registry 状态。
 */
export function resolveModelRoute(
	group: CompiledLogicalModelRouteGroup,
	request: ModelRouteResolutionRequest = {},
): ModelRouteResolution {
	validateTokenRequirement("requiredContextTokens", request.requiredContextTokens);
	validateTokenRequirement("requiredOutputTokens", request.requiredOutputTokens);
	if (request.manualRouteId !== undefined && !group.routes.some(route => route.id === request.manualRouteId)) {
		throw new Error(`Unknown manual route "${request.manualRouteId}" for logical model "${group.id}"`);
	}

	const rankedRoutes = rankRoutes(group.routes, request);
	let selectedRoute: CompiledModelRoute | undefined;
	let selectedReason: ModelRouteResolutionReason | undefined;
	const trace: ModelRouteResolutionTrace[] = [];
	for (const [rank, route] of rankedRoutes.entries()) {
		const rejections = collectRejections(route, request);
		const eligible = rejections.length === 0;
		const selected = eligible && selectedRoute === undefined;
		if (selected) {
			selectedRoute = route;
			selectedReason =
				route.id === request.manualRouteId
					? "manual"
					: route.id === request.affinityRouteId
						? "affinity"
						: (request.selectionReason ?? "primary");
		}
		trace.push(
			Object.freeze({
				routeId: route.id,
				modelSelector: route.modelSelector,
				priority: route.priority,
				configOrder: route.configOrder,
				rank,
				eligible,
				selected,
				rejections,
			}),
		);
	}

	return Object.freeze({
		logicalModelId: group.id,
		harnessProfile: group.harnessProfile,
		policyVersion: group.policyVersion,
		...(selectedRoute !== undefined && { route: selectedRoute, reason: selectedReason }),
		trace: Object.freeze(trace),
	});
}
