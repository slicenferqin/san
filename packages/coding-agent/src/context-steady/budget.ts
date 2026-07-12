import type { ContextPlanBudgetAudit } from "./plan-types";

export interface ContextPlanBudgetSettings {
	qualityWindowTokens: number;
	reserveRatio: number;
	planMaxTokens: number;
	burstWindowTokens?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const integer = Math.floor(value);
	return integer > 0 ? integer : undefined;
}

function clampReserveRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function resolveContextPlanBudget(options: {
	settings: ContextPlanBudgetSettings;
	contextWindow: number;
	nonMessageTokens: number;
	qualityBurstRequired?: boolean;
}): ContextPlanBudgetAudit {
	const contextWindow = positiveInteger(options.contextWindow) ?? 0;
	const nonMessageTokens = Math.max(0, Math.floor(options.nonMessageTokens));
	const reserveRatio = clampReserveRatio(options.settings.reserveRatio);
	const configuredSteady = positiveInteger(options.settings.qualityWindowTokens) ?? 240_000;
	const reserveTokens = contextWindow > 0 ? Math.max(32_000, Math.floor(contextWindow * reserveRatio)) : 32_000;
	const hardInputCeiling = contextWindow > 0 ? Math.max(0, contextWindow - reserveTokens) : configuredSteady;
	const steadyTarget = Math.min(configuredSteady, hardInputCeiling);
	const configuredBurst = positiveInteger(options.settings.burstWindowTokens) ?? 320_000;
	const burstCeiling = Math.min(Math.max(configuredBurst, steadyTarget), hardInputCeiling);
	const controlMax = Math.min(burstCeiling, Math.floor((steadyTarget * 13) / 12));
	const selectedInputLimit = options.qualityBurstRequired === true ? burstCeiling : controlMax;
	const selectedInputMode = options.qualityBurstRequired === true ? "burst" : "steady";
	const messageBudget = Math.max(0, selectedInputLimit - nonMessageTokens);
	const planMaxTokens = positiveInteger(options.settings.planMaxTokens) ?? 0;
	const planTokenBudget = Math.max(0, Math.min(planMaxTokens, messageBudget));

	return {
		contextWindow,
		nonMessageTokens,
		steadyTarget,
		controlMax,
		burstCeiling,
		selectedInputLimit,
		selectedInputMode,
		messageBudget,
		planTokenBudget,
		reserveTokens,
		reserveRatio,
	};
}
