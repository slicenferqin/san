import { describe, expect, test } from "bun:test";

import { evaluatePolicy } from "./src/policy/evaluate";
import type { PolicyConfig, PolicyRequest } from "./src/policy/types";

const config: PolicyConfig = {
	emergencyFreeze: false,
	suspendedAccounts: ["suspended"],
	accountLimits: { vip: 5000 },
	regionLimits: { eu: 1000 },
	defaultLimit: 500,
};
const request: PolicyRequest = {
	accountId: "vip",
	region: "eu",
	amount: 5000,
	mfaVerified: true,
	serviceAccount: false,
};

describe("L3 final evolved policy", () => {
	test("emergency freeze denies every account including trusted services", () => {
		expect(evaluatePolicy({ ...request, serviceAccount: true }, { ...config, emergencyFreeze: true })).toEqual({
			allowed: false,
			reason: "emergency freeze",
			limit: 0,
			source: "freeze",
		});
	});

	test("suspension precedes all amount policies", () => {
		expect(evaluatePolicy({ ...request, accountId: "suspended", amount: 1 }, config)).toMatchObject({
			allowed: false,
			source: "suspension",
		});
	});

	test("EU requests require MFA before applying account overrides", () => {
		const decision = evaluatePolicy({ ...request, mfaVerified: false, amount: 1 }, config);
		expect(decision).toMatchObject({
			allowed: false,
			source: "region",
		});
		expect(decision.reason).toMatch(/mfa/i);
	});

	test("account, region, and default limits use inclusive boundaries", () => {
		expect(evaluatePolicy(request, config)).toMatchObject({ allowed: true, limit: 5000, source: "account" });
		expect(evaluatePolicy({ ...request, accountId: "regular", amount: 1000 }, config)).toMatchObject({
			allowed: true,
			limit: 1000,
			source: "region",
		});
		expect(evaluatePolicy({ ...request, accountId: "regular", region: "ap", amount: 500 }, config)).toMatchObject({
			allowed: true,
			limit: 500,
			source: "default",
		});
	});
});
