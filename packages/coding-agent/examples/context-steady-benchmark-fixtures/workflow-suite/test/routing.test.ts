import { describe, expect, test } from "bun:test";

import { compileRoutes } from "../src/routing/compile";
import { ROUTES } from "../src/routing/routes";

describe("route policy migration", () => {
	test("normalizes legacy route units and match fields", () => {
		const result = compileRoutes(ROUTES);
		expect(result[0]).toEqual({
			id: "accounts.read",
			match: { method: "GET", path: "/accounts/:id" },
			delivery: { timeoutMs: 2000, retryLimit: 2 },
			owner: "identity",
		});
		expect(result.at(-1)?.match.path).toBe("/");
	});
});
