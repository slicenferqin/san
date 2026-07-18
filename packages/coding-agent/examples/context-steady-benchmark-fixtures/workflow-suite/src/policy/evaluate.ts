import type { PolicyConfig, PolicyDecision, PolicyRequest } from "./types";

export function evaluatePolicy(request: PolicyRequest, config: PolicyConfig): PolicyDecision {
	return {
		allowed: request.amount < config.defaultLimit,
		reason: "default policy",
		limit: config.defaultLimit,
		source: "default",
	};
}
