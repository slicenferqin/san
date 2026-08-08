import { describe, expect, test } from "bun:test";
import { buildModel } from "@san/catalog/build";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import { RUNTIME_ALLOWED_FALLBACK_CATEGORIES } from "@san/coding-agent/config/model-routes-schema";
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
test("同 route ID 换 selector 的 registry reload 通过 reconcile 重绑并保留 role/harnessProfile", () => {
	const a = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const b = { ...a, id: "b", name: "b" };
	const registryV1 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-sol",
				routes: [{ id: "main", model: "provider/a", equivalence: "exact" }],
			},
		},
		[a, b],
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-terra",
				routes: [{ id: "main", model: "provider/b", equivalence: "exact" }],
			},
		},
		[a, b],
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	expect(lease.select("logical", "default", {})?.route.modelSelector).toBe("provider/a");

	registry = registryV2;
	const rebound = lease.reconcile({});
	expect(rebound?.route.routeId).toBe("main");
	expect(rebound?.route.modelSelector).toBe("provider/b");
	expect(rebound?.model).toBe(registryV2.get("logical")?.routes[0]?.model);
	expect(lease.active).toMatchObject({
		logicalModelId: "logical",
		routeId: "main",
		modelSelector: "provider/b",
		policyVersion: registryV2.policyVersion,
		role: "default",
		harnessProfile: "gpt-5.6-sol",
	});
});

test("同 ID/同 selector 的无关 policy refresh 只刷新 lease version，不返回 selection", () => {
	const model = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const registryV1 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-sol",
				routes: [{ id: "main", model: "provider/a", equivalence: "exact" }],
			},
		},
		[model],
		{ policyVersion: 1 },
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-sol",
				routes: [{ id: "main", model: "provider/a", equivalence: "exact" }],
			},
		},
		[model],
		{ policyVersion: 2 },
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	lease.select("logical", "default", {});

	registry = registryV2;
	expect(lease.reconcile({})).toBeUndefined();
	expect(lease.active).toMatchObject({
		routeId: "main",
		modelSelector: "provider/a",
		policyVersion: 2,
		harnessProfile: "gpt-5.6-sol",
		role: "default",
	});

	registry = registryV1;
	expect(lease.reconcile({})).toBeUndefined();
	expect(lease.active?.policyVersion).toBe(1);
});

test("reconcile 在 affinity route 不 eligible 时选择下一条 eligible route", () => {
	const a = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const b = { ...a, id: "b", name: "b" };
	const c = { ...a, provider: "second", id: "c", name: "c" };
	const registryV1 = compileModelRouteRegistry(
		{
			logical: {
				routes: [
					{ id: "main", model: "provider/a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "second/c", priority: 10, equivalence: "exact" },
				],
			},
		},
		[a, b, c],
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: {
				routes: [
					{ id: "main", model: "provider/b", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "second/c", priority: 10, equivalence: "exact" },
				],
			},
		},
		[a, b, c],
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	lease.select("logical", "default", {});
	registry = registryV2;

	const rebound = lease.reconcile({ isAvailable: route => route.modelSelector !== "provider/b" });
	expect(rebound?.route.routeId).toBe("backup");
	expect(rebound?.route.modelSelector).toBe("second/c");
	expect(lease.active).toMatchObject({ routeId: "backup", modelSelector: "second/c", role: "default" });
});

test("reconcile 全组不 eligible 时返回 undefined 且不改动 lease", () => {
	const a = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const b = { ...a, id: "b", name: "b" };
	const registryV1 = compileModelRouteRegistry(
		{
			logical: { routes: [{ id: "main", model: "provider/a", equivalence: "exact" }] },
		},
		[a, b],
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: { routes: [{ id: "main", model: "provider/b", equivalence: "exact" }] },
		},
		[a, b],
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	lease.select("logical", "default", {});
	registry = registryV2;

	expect(lease.reconcile({ isAvailable: () => false })).toBeUndefined();
	expect(lease.active).toMatchObject({ routeId: "main", modelSelector: "provider/a" });
});

test("select/failover 返回 billing effective model，selector 与 capability 不变", () => {
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
					{
						id: "primary",
						model: "routes/primary",
						priority: 0,
						equivalence: "exact",
						billing: { source: "override", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
					},
					{
						id: "backup",
						model: "backup/primary",
						priority: 10,
						equivalence: "exact",
						billing: { source: "override", input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
					},
				],
			},
		},
		[primary, backup],
	);
	const lease = new ModelRouteLeaseController(() => registry);
	const selection = lease.select("logical", "default", {});
	expect(selection?.route.modelSelector).toBe("routes/primary");
	expect(selection?.model.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
	expect(selection?.model.contextWindow).toBe(primary.contextWindow);

	const failover = lease.failover({});
	expect(failover?.route.modelSelector).toBe("backup/primary");
	expect(failover?.model.cost).toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
	expect(primary.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	expect(backup.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("runtime defense-in-depth 对手工构造的 unsafe 输入仍返回 not_allowed", () => {
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
	lease.select("logical", "default", {});
	for (const category of ["refusal", "user_abort", "context_overflow"] as const) {
		expect(lease.resolveFallbackDecision(category)).toBe("not_allowed");
	}
});

test("可配置 fallbackOn 集合与 runtime replay 允许集合一致", () => {
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
	for (const category of RUNTIME_ALLOWED_FALLBACK_CATEGORIES) {
		const registry = compileModelRouteRegistry(
			{
				logical: {
					policy: { fallbackOn: [category] },
					routes: [{ id: "primary", model: "routes/primary", equivalence: "exact" }],
				},
			},
			[model],
		);
		const lease = new ModelRouteLeaseController(() => registry);
		lease.select("logical", "default", {});
		expect(["retry_same_route", "fallback"]).toContain(lease.resolveFallbackDecision(category));
	}
});
test("同 ID/同 selector 的 billing override 变化时 reconcile 返回 costRefresh selection，不换 route", () => {
	const model = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const registryV1 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-sol",
				routes: [
					{
						id: "main",
						model: "provider/a",
						equivalence: "exact",
						billing: { source: "override", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
					},
				],
			},
		},
		[model],
		{ policyVersion: 1 },
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: {
				harnessProfile: "gpt-5.6-sol",
				routes: [
					{
						id: "main",
						model: "provider/a",
						equivalence: "exact",
						billing: { source: "override", input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
					},
				],
			},
		},
		[model],
		{ policyVersion: 2 },
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	const selected = lease.select("logical", "default", {});
	expect(selected?.route.modelSelector).toBe("provider/a");
	expect(selected?.model.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });

	registry = registryV2;
	const refreshed = lease.reconcile({});
	expect(refreshed?.costRefresh).toBe(true);
	expect(refreshed?.route.routeId).toBe("main");
	expect(refreshed?.route.modelSelector).toBe("provider/a");
	expect(refreshed?.route.policyVersion).toBe(2);
	expect(refreshed?.model.cost).toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
	expect(refreshed?.model).toBe(registryV2.get("logical")?.routes[0]?.model);
	expect(lease.active).toMatchObject({ routeId: "main", modelSelector: "provider/a", policyVersion: 2 });
	expect(lease.active?.modelCost).toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
	// catalog model 的 cost 不被 route-local override 污染。
	expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	// 已生效的 cost refresh 后再次 reconcile 不再返回 selection。
	expect(lease.reconcile({})).toBeUndefined();
});

test("同 selector、同 billing 的无关 version refresh 仍不返回 selection", () => {
	const model = buildModel({
		provider: "provider",
		id: "a",
		name: "a",
		api: "openai-responses",
		baseUrl: "https://provider.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
	const billing = { source: "override", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } as const;
	const registryV1 = compileModelRouteRegistry(
		{
			logical: {
				routes: [{ id: "main", model: "provider/a", equivalence: "exact", billing }],
			},
		},
		[model],
		{ policyVersion: 1 },
	);
	const registryV2 = compileModelRouteRegistry(
		{
			logical: {
				routes: [{ id: "main", model: "provider/a", equivalence: "exact", billing }],
			},
		},
		[model],
		{ policyVersion: 2 },
	);
	let registry = registryV1;
	const lease = new ModelRouteLeaseController(() => registry);
	lease.select("logical", "default", {});
	registry = registryV2;

	expect(lease.reconcile({})).toBeUndefined();
	expect(lease.active).toMatchObject({ routeId: "main", modelSelector: "provider/a", policyVersion: 2 });
	expect(lease.active?.modelCost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});
