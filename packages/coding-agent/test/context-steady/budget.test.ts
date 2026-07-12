/**
 * ContextPlan budget contract tests.
 */

import { describe, expect, test } from "bun:test";
import { resolveContextPlanBudget } from "../../src/context-steady/budget";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

describe("resolveContextPlanBudget", () => {
	test("uses steady control band by default", () => {
		const budget = resolveContextPlanBudget({
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
		});

		expect(budget.steadyTarget).toBe(240_000);
		expect(budget.controlMax).toBe(260_000);
		expect(budget.burstCeiling).toBe(320_000);
		expect(budget.selectedInputMode).toBe("steady");
		expect(budget.selectedInputLimit).toBe(260_000);
		expect(budget.messageBudget).toBe(240_000);
		expect(budget.planTokenBudget).toBe(240_000);
	});

	test("selects burst ceiling only when quality requires it", () => {
		const budget = resolveContextPlanBudget({
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			qualityBurstRequired: true,
		});

		expect(budget.selectedInputMode).toBe("burst");
		expect(budget.selectedInputLimit).toBe(320_000);
		expect(budget.messageBudget).toBe(300_000);
		expect(budget.planTokenBudget).toBe(240_000);
	});

	test("reserves at least 32K output tokens on small models", () => {
		const budget = resolveContextPlanBudget({
			settings: SETTINGS,
			contextWindow: 64_000,
			nonMessageTokens: 8_000,
			qualityBurstRequired: true,
		});

		expect(budget.reserveTokens).toBe(32_000);
		expect(budget.steadyTarget).toBe(32_000);
		expect(budget.burstCeiling).toBe(32_000);
		expect(budget.selectedInputLimit).toBe(32_000);
		expect(budget.messageBudget).toBe(24_000);
	});

	test("returns zero message budget when non-message tokens consume the selected window", () => {
		const budget = resolveContextPlanBudget({
			settings: SETTINGS,
			contextWindow: 128_000,
			nonMessageTokens: 200_000,
		});

		expect(budget.messageBudget).toBe(0);
		expect(budget.planTokenBudget).toBe(0);
	});

	test("treats qualityWindowTokens=0 as the default 240K steady target", () => {
		const budget = resolveContextPlanBudget({
			settings: { ...SETTINGS, qualityWindowTokens: 0 },
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
		});

		expect(budget.steadyTarget).toBe(240_000);
		expect(budget.controlMax).toBe(260_000);
		expect(budget.burstCeiling).toBe(320_000);
	});
});
