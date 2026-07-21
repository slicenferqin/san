import { describe, expect, test } from "bun:test";

import { evaluatePolicy } from "../src/policy/evaluate";

const config = {
	emergencyFreeze: false,
	suspendedAccounts: [],
	accountLimits: { vip: 5000 },
	regionLimits: { eu: 1000 },
	defaultLimit: 500,
};

describe("policy evaluation", () => {
	test("uses account limits before region and default limits", () => {
		expect(
			evaluatePolicy(
				{ accountId: "vip", region: "eu", amount: 3000, mfaVerified: true, serviceAccount: false },
				config,
			),
		).toMatchObject({ allowed: true, limit: 5000, source: "account" });
	});
});
