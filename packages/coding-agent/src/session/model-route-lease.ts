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

function mergedRouteIds(
	left: ReadonlySet<string> | undefined,
	right: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
	if (right.size === 0) return left;
	return new Set([...(left ?? []), ...right]);
}

function activeRoute(route: CompiledModelRoute, policyVersion: number, role: string): ActiveModelRoute {
	return Object.freeze({
		logicalModelId: route.logicalModelId,
		routeId: route.id,
		modelSelector: route.modelSelector,
		policyVersion,
		role,
	});
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
		this.#active = activeRoute(resolution.route, resolution.policyVersion, role);
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
		this.#active = activeRoute(resolution.route, resolution.policyVersion, active.role);
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

		this.#active = activeRoute(resolution.route, resolution.policyVersion, active.role);
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

export function formatModelRouteResolutionFailure(
	logicalModelId: string,
	trace: ModelRouteResolution["trace"],
): string {
	if (trace.length === 0) return `Logical model "${logicalModelId}" has no configured routes`;
	const reasons = trace.map(route => {
		const details = route.rejections.map(rejection => `${rejection.code}: ${rejection.message}`).join("; ");
		return `${route.routeId} (${route.modelSelector}): ${details || "not selected"}`;
	});
	return `No eligible route for logical model "${logicalModelId}": ${reasons.join(" | ")}`;
}
