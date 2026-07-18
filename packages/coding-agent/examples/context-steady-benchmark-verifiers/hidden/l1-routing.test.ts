import { describe, expect, test } from "bun:test";

import { compileRoutes } from "./src/routing/compile";
import { normalizeRoute } from "./src/routing/normalize";
import type { LegacyRouteDefinition } from "./src/routing/types";

const base: LegacyRouteDefinition = {
	id: "orders.read",
	method: "get",
	path: "//orders///:id/",
	timeoutSeconds: 2.5,
	retryLimit: 2,
	owner: "orders",
};

describe("L1 hidden route contract", () => {
	test("normalizes without mutating the legacy input", () => {
		const input = structuredClone(base);
		expect(normalizeRoute(input)).toEqual({
			id: "orders.read",
			match: { method: "GET", path: "/orders/:id" },
			delivery: { timeoutMs: 2500, retryLimit: 2 },
			owner: "orders",
		});
		expect(input).toEqual(base);
	});

	test("rejects unsupported methods with route identity", () => {
		expect(() => normalizeRoute({ ...base, id: "bad.route", method: "TRACE" })).toThrow(/bad\.route.*method/i);
	});

	test("rejects duplicate route ids with both source indexes", () => {
		expect(() => compileRoutes([base, { ...base }])).toThrow(/orders\.read.*0.*1/i);
	});

	test("rejects invalid delivery values explicitly", () => {
		expect(() => normalizeRoute({ ...base, timeoutSeconds: 0 })).toThrow(/orders\.read.*timeout/i);
		expect(() => normalizeRoute({ ...base, retryLimit: -1 })).toThrow(/orders\.read.*retry/i);
	});
});
