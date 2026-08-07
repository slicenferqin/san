import type { Model } from "@san/ai";
import type { CompiledModelRoute, ModelRouteRegistry } from "../config/model-route-registry";
import { type ModelCostSnapshot, modelCostsEqual } from "../config/model-route-registry";
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
	/**
	 * LMR-02：route-local effective cost 四字段快照（选路时冻结）。用于同 selector
	 * 的 billing refresh 检测；仅内存态，不写入 session JSONL/RPC。
	 */
	modelCost?: ModelCostSnapshot;
}

export type ModelRouteFallbackDecision = "not_allowed" | "retry_same_route" | "fallback";

export interface ModelRouteSelection {
	route: ActiveModelRoute;
	model: Model;
	reason: ModelRouteResolutionReason;
	trace: ModelRouteResolution["trace"];
	/**
	 * LMR-02：同 route ID/同 selector 的 billing override 变化产生的 cost-only
	 * selection。调用方只切换 effective cost（`agent.state.model`），不得关闭
	 * provider session 或重建 transport 状态。
	 */
	costRefresh?: boolean;
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
		modelCost: Object.freeze({ ...route.model.cost }),
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
		// defense-in-depth：即使配置校验被绕过，这三类也永不触发 replay。
		if (category === "refusal" || category === "user_abort" || category === "context_overflow") {
			return "not_allowed";
		}
		const group = this.#getRegistry().get(active.logicalModelId);
		if (!group?.policy.fallbackOn.includes(category)) return "not_allowed";

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

	/**
	 * 配置刷新后重绑 stale active lease（LMR-01 / LMR-02）。
	 *
	 * 当前 registry 中同 route ID 的 modelSelector 已变化时，用调用方提供的
	 * 当前 constraints 重新解析：保留 role 与已选 harnessProfile，更新 active
	 * selector/version 并返回新 selection。同 ID/同 selector、仅 policyVersion
	 * 变化时只刷新 lease version：若 route-local billing override 的 cost 四字段
	 * 已变化，返回带 `costRefresh` 标记的 selection（调用方只切换 effective cost，
	 * 不做 provider reset）；cost 未变的无关 refresh 返回 undefined。无任何变化或
	 * 当前 group 已不含该 route ID 时返回 undefined。
	 */
	reconcile(request: ModelRouteResolutionRequest): ModelRouteSelection | undefined {
		const active = this.#active;
		if (!active) return undefined;
		const group = this.#getRegistry().get(active.logicalModelId);
		if (!group) return undefined;
		const route = group.routes.find(candidate => candidate.id === active.routeId);
		if (!route) return undefined;
		if (route.modelSelector === active.modelSelector && group.policyVersion === active.policyVersion) {
			return undefined;
		}
		if (route.modelSelector === active.modelSelector) {
			this.#active = Object.freeze({
				...active,
				policyVersion: group.policyVersion,
				modelCost: Object.freeze({ ...route.model.cost }),
			});
			// 手建 lease（无 cost 快照）无法判断变化：保持既有行为，不返回 selection。
			if (active.modelCost !== undefined && modelCostsEqual(active.modelCost, route.model.cost)) {
				return undefined;
			}
			// 同 selector billing 变化：确认 route 仍 eligible（affinity 解析）后返回
			// cost-only selection；route 已 suppressed/disabled 时交给下游 failover。
			const resolution = this.#getRegistry().resolve(active.logicalModelId, {
				...request,
				affinityRouteId: active.routeId,
			});
			if (resolution?.route?.id !== active.routeId || !resolution.reason) return undefined;
			return {
				route: this.#active,
				model: route.model,
				reason: resolution.reason,
				trace: resolution.trace,
				costRefresh: true,
			};
		}
		const resolution = this.#getRegistry().resolve(active.logicalModelId, {
			...request,
			affinityRouteId: active.routeId,
		});
		if (!resolution?.route || !resolution.reason) return undefined;
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
