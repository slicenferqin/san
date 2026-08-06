import { describe, expect, test } from "bun:test";
import { buildModel } from "@san/catalog/build";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import { ModelRouteLeaseController } from "@san/coding-agent/session/model-route-lease";

describe("ModelRouteLeaseController", () => {
	test("route leases retain the selected harness profile across registry reload, failover, recovery, and restore", () => {
		const primary = buildModel({
			provider: "routes",
			id: "primary",
			name: "primary",
			api: "openai-responses",
			baseUrl: "https://routes.example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const backup = { ...primary, provider: "backup", name: "backup" };
		const registryV1 = compileModelRouteRegistry(
			{
				logical: {
					harnessProfile: "gpt-5.6-sol",
					routes: [
						{ id: "primary", model: "routes/primary", equivalence: "exact" },
						{ id: "backup", model: "backup/primary", equivalence: "exact" },
					],
				},
			},
			[primary, backup],
		);
		const registryV2 = compileModelRouteRegistry(
			{
				logical: {
					harnessProfile: "gpt-5.6-terra",
					routes: [
						{ id: "primary", model: "routes/primary", equivalence: "exact" },
						{ id: "backup", model: "backup/primary", equivalence: "exact" },
					],
				},
			},
			[primary, backup],
		);
		let registry = registryV1;
		const lease = new ModelRouteLeaseController(() => registry);

		expect(lease.select("logical", "default", {})?.route).toMatchObject({
			routeId: "primary",
			harnessProfile: "gpt-5.6-sol",
		});
		registry = registryV2;
		expect(lease.failover({})?.route).toMatchObject({
			routeId: "backup",
			harnessProfile: "gpt-5.6-sol",
		});
		expect(lease.recover({})?.route).toMatchObject({
			routeId: "primary",
			harnessProfile: "gpt-5.6-sol",
		});

		const state = lease.captureState();
		lease.clear();
		lease.restoreState(state);
		expect(lease.active).toMatchObject({ routeId: "primary", harnessProfile: "gpt-5.6-sol" });
	});

	test("a successful same-route retry resets the transient retry budget", () => {
		const model = buildModel({
			provider: "routes",
			id: "primary",
			name: "primary",
			api: "openai-responses",
			baseUrl: "https://routes.example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: [{ id: "primary", model: "routes/primary", equivalence: "exact" }],
				},
			},
			[model],
		);
		const lease = new ModelRouteLeaseController(() => registry);
		expect(lease.select("logical", "default", {})?.route.routeId).toBe("primary");

		expect(lease.resolveFallbackDecision("network")).toBe("retry_same_route");
		lease.markSuccess();
		expect(lease.resolveFallbackDecision("network")).toBe("retry_same_route");
	});

	test("restoring controller state preserves a consumed same-route retry", () => {
		const primary = buildModel({
			provider: "routes",
			id: "primary",
			name: "primary",
			api: "openai-responses",
			baseUrl: "https://routes.example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		const backup = { ...primary, provider: "backup", name: "backup" };
		const registry = compileModelRouteRegistry(
			{
				logical: {
					routes: [
						{ id: "primary", model: "routes/primary", equivalence: "exact" },
						{ id: "backup", model: "backup/primary", equivalence: "exact" },
					],
				},
			},
			[primary, backup],
		);
		const lease = new ModelRouteLeaseController(() => registry);
		expect(lease.select("logical", "default", {})?.route.routeId).toBe("primary");
		expect(lease.resolveFallbackDecision("network")).toBe("retry_same_route");

		const state = lease.captureState();
		lease.clear();
		lease.restoreState(state);

		expect(lease.resolveFallbackDecision("network")).toBe("fallback");
	});
});
