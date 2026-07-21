import { describe, expect, test } from "bun:test";

import { analyzeIncidentEvidence } from "../src/incident/analyze";

describe("incident evidence analyzer", () => {
	test("aggregates failures and risk in step order", () => {
		const report = analyzeIncidentEvidence([
			{
				step: 1,
				serviceId: "svc-001",
				region: "eu-west",
				owner: "orders",
				targetRoute: "/v2/orders/eu-west/001",
				sampleCount: 100,
				failureCount: 25,
				p95Ms: 2100,
				retryLimit: 1,
				requiresIdempotency: true,
				constraint: "keep route",
			},
		]);
		expect(report).toMatchObject({
			totalServices: 1,
			totalFailures: 25,
			highRiskServiceIds: ["svc-001"],
			idempotencyRequiredServiceIds: ["svc-001"],
		});
	});
});
