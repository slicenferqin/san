import type { Model } from "@san/ai";
import type { CompiledModelRoute, ModelRouteRegistry } from "../config/model-route-registry";
import type {
	ModelRouteResolution,
	ModelRouteResolutionReason,
	ModelRouteResolutionRequest,
} from "../config/model-route-resolver";
import type { RouteFailureCategory } from "../config/model-routes-schema";

export interface ActiveModelRoute {
	logicalModelId: string;
	harnessProfile: string;
	routeId: string;
	modelSelector: string;
	policyVersion: number;
	role: string;
}

export type ModelRouteFallbackDecision = "not_allowed" | "retry_same_route" | "fallback";

export interface ModelRouteSelection {
	route: ActiveModelRoute;
	model: Model;
	reason: ModelRouteResolutionReason;
	trace: ModelRouteResolution["trace"];
}

export interface ModelRouteLeaseState {
	active?: ActiveModelRoute;
	failedRouteIds: readonly string[];
	consecutiveRouteFailures: number;
}

function mergedRouteIds(
	left: ReadonlySet<string> | undefined,
	right: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
	if (right.size === 0) return left;
	return new Set([...(left ?? []), ...right]);
}

function activeRoute(
	resolution: ModelRouteResolution,
	role: string,
	harnessProfile = resolution.harnessProfile,
): ActiveModelRoute | undefined {
	const route = resolution.route;
	if (!route) return undefined;
	return Object.freeze({
		logicalModelId: route.logicalModelId,
		harnessProfile,
		routeId: route.id,
		modelSelector: route.modelSelector,
		policyVersion: resolution.policyVersion,
		role,
	});
}

export function activeModelRouteFromResolution(
	resolution: ModelRouteResolution | undefined,
	role: string,
): ActiveModelRoute | undefined {
	return resolution ? activeRoute(resolution, role) : undefined;
}

/**
 * 保存用户的 Logical Model 意图和当前 concrete route lease。
 *
 * Controller 不读取鉴权、时间或全局健康状态；调用方把同一份请求快照传给
 * 纯 resolver，从而让启动、恢复和运行时 fallback 使用相同的 eligibility 规则。
 */
export class ModelRouteLeaseController {
	readonly #getRegistry: () => ModelRouteRegistry;
	#active: ActiveModelRoute | undefined;
	#failedRouteIds = new Set<string>();
	#consecutiveRouteFailures = 0;

	constructor(getRegistry: () => ModelRouteRegistry, initial?: ActiveModelRoute) {
		this.#getRegistry = getRegistry;
		this.#active = initial ? Object.freeze({ ...initial }) : undefined;
	}

	get active(): ActiveModelRoute | undefined {
		return this.#active;
	}

	snapshot(): ActiveModelRoute | undefined {
		return this.#active ? { ...this.#active } : undefined;
	}

	captureState(): ModelRouteLeaseState {
		return {
			...(this.#active && { active: { ...this.#active } }),
			failedRouteIds: [...this.#failedRouteIds],
			consecutiveRouteFailures: this.#consecutiveRouteFailures,
		};
	}

	restoreState(state: ModelRouteLeaseState): void {
		this.#active = state.active ? Object.freeze({ ...state.active }) : undefined;
		this.#failedRouteIds = new Set(state.failedRouteIds);
		this.#consecutiveRouteFailures = state.consecutiveRouteFailures;
	}

	restore(snapshot: ActiveModelRoute | undefined): void {
		this.#active = snapshot ? Object.freeze({ ...snapshot }) : undefined;
		this.#failedRouteIds.clear();
		this.#consecutiveRouteFailures = 0;
	}

	clear(): void {
		this.restore(undefined);
	}

	currentRoute(): CompiledModelRoute | undefined {
		const active = this.#active;
		return active ? this.#getRegistry().getRoute(active.logicalModelId, active.routeId) : undefined;
	}

	matchesModel(model: Model | null | undefined): boolean {
		return model !== null && model !== undefined && this.#active?.modelSelector === `${model.provider}/${model.id}`;
	}

	select(logicalModelId: string, role: string, request: ModelRouteResolutionRequest): ModelRouteSelection | undefined {
		const resolution = this.#getRegistry().resolve(logicalModelId, request);
		if (!resolution?.route || !resolution.reason) return undefined;
		this.#active = activeModelRouteFromResolution(resolution, role);
		if (!this.#active) return undefined;
		this.#failedRouteIds.clear();
		this.#consecutiveRouteFailures = 0;
		return {
			route: this.#active,
			model: resolution.route.model,
			reason: resolution.reason,
			trace: resolution.trace,
		};
	}

	resolveFallbackDecision(
		category: RouteFailureCategory,
		options?: { skipSameRouteRetry?: boolean },
	): ModelRouteFallbackDecision {
		const active = this.#active;
		if (!active) return "not_allowed";
		const group = this.#getRegistry().get(active.logicalModelId);
		if (!group?.policy.fallbackOn.includes(category)) return "not_allowed";
		if (category === "refusal" || category === "user_abort" || category === "context_overflow") {
			return "not_allowed";
		}

		this.#consecutiveRouteFailures++;
		if (
			options?.skipSameRouteRetry !== true &&
			this.#consecutiveRouteFailures === 1 &&
			(category === "network" || category === "timeout" || category === "server_error")
		) {
			return "retry_same_route";
		}
		return "fallback";
	}

	failover(request: ModelRouteResolutionRequest): ModelRouteSelection | undefined {
		const active = this.#active;
		if (!active) return undefined;
		this.#failedRouteIds.add(active.routeId);
		const resolution = this.#getRegistry().resolve(active.logicalModelId, {
			...request,
			affinityRouteId: undefined,
			manualRouteId: undefined,
			selectionReason: "failover",
			excludedRouteIds: mergedRouteIds(request.excludedRouteIds, this.#failedRouteIds),
		});
		if (!resolution?.route || !resolution.reason) return undefined;
		this.#active = activeRoute(resolution, active.role, active.harnessProfile);
		if (!this.#active) return undefined;
		this.#consecutiveRouteFailures = 0;
		return {
			route: this.#active,
			model: resolution.route.model,
			reason: resolution.reason,
			trace: resolution.trace,
		};
	}

	recover(request: ModelRouteResolutionRequest): ModelRouteSelection | undefined {
		const active = this.#active;
		if (!active) return undefined;
		const group = this.#getRegistry().get(active.logicalModelId);
		if (group?.policy.revert !== "next-turn-after-cooldown") return undefined;
		const resolution = this.#getRegistry().resolve(active.logicalModelId, {
			...request,
			affinityRouteId: undefined,
			manualRouteId: undefined,
			selectionReason: "recovery",
			excludedRouteIds: undefined,
		});
		if (!resolution?.route || !resolution.reason || resolution.route.id === active.routeId) return undefined;

		const currentRoute = group.routes.find(route => route.id === active.routeId);
		if (
			currentRoute &&
			(resolution.route.priority > currentRoute.priority ||
				(resolution.route.priority === currentRoute.priority &&
					resolution.route.configOrder >= currentRoute.configOrder))
		) {
			return undefined;
		}

		this.#active = activeRoute(resolution, active.role, active.harnessProfile);
		if (!this.#active) return undefined;
		this.#failedRouteIds.clear();
		this.#consecutiveRouteFailures = 0;
		return {
			route: this.#active,
			model: resolution.route.model,
			reason: resolution.reason,
			trace: resolution.trace,
		};
	}

	markSuccess(): void {
		this.#failedRouteIds.clear();
		this.#consecutiveRouteFailures = 0;
	}
}
