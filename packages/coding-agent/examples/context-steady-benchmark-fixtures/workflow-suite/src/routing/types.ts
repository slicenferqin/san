export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface LegacyRouteDefinition {
	id: string;
	method: string;
	path: string;
	timeoutSeconds: number;
	retryLimit: number;
	owner: string;
}

export interface RoutePolicy {
	id: string;
	match: { method: HttpMethod; path: string };
	delivery: { timeoutMs: number; retryLimit: number };
	owner: string;
}
