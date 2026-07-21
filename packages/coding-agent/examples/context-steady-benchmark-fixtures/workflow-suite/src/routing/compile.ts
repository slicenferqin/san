import { normalizeRoute } from "./normalize";
import type { LegacyRouteDefinition, RoutePolicy } from "./types";

export function compileRoutes(routes: readonly LegacyRouteDefinition[]): RoutePolicy[] {
	return routes.map(normalizeRoute);
}
