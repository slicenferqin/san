import type { LegacyRouteDefinition, RoutePolicy } from "./types";

export function normalizeRoute(route: LegacyRouteDefinition): RoutePolicy {
	return {
		id: route.id,
		match: { method: route.method as RoutePolicy["match"]["method"], path: route.path },
		delivery: { timeoutMs: route.timeoutSeconds, retryLimit: route.retryLimit },
		owner: route.owner,
	};
}
