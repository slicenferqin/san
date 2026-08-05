import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@san/catalog/build";
import { ModelRegistry, type ProviderConfigInput } from "@san/coding-agent/config/model-registry";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import { validateLogicalModelsConfiguration } from "@san/coding-agent/config/model-routes-schema";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { TempDir } from "@san/utils";

function concreteModel(provider: string, id: string, contextWindow = 128_000) {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: `https://${provider}.example.invalid/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8_192,
	});
}

function configuredProvider(modelId: string, contextWindow = 128_000) {
	return {
		baseUrl: "https://provider.example.invalid/v1",
		api: "openai-responses",
		auth: "none",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: 8_192,
			},
		],
	};
}

describe("Logical Model route registry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-route-registry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(async () => {
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	test("只编译显式声明的 route，不按同名 concrete model 自动归组", () => {
		const models = [concreteModel("first", "shared"), concreteModel("second", "shared")];
		const registry = compileModelRouteRegistry(
			{
				shared: {
					routes: [{ model: "first/shared", equivalence: "exact" }],
				},
			},
			models,
		);

		const group = registry.get("shared");
		expect(group?.routes.map(route => route.modelSelector)).toEqual(["first/shared"]);
		expect(group?.routes[0].id).toBe("first/shared");
		expect(registry.findRouteBySelector("shared", "second/shared")).toBeUndefined();
	});

	test("配置校验为非法 id、空组和重复 route 给出精确路径", () => {
		expect(() =>
			validateLogicalModelsConfiguration({
				"bad/id": { routes: [{ id: "route", model: "first/shared", equivalence: "exact" }] },
			}),
		).toThrow("logicalModels.bad/id");
		expect(() => validateLogicalModelsConfiguration({ empty: { routes: [] } })).toThrow("logicalModels.empty.routes");
		expect(() =>
			validateLogicalModelsConfiguration({
				shared: {
					routes: [
						{ id: "duplicate", model: "first/shared", equivalence: "exact" },
						{ id: "duplicate", model: "second/shared", equivalence: "exact" },
					],
				},
			}),
		).toThrow("logicalModels.shared.routes[1].id");
	});

	test("models.yml 加载时拒绝无法精确绑定的 concrete selector", async () => {
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { first: configuredProvider("shared") },
				logicalModels: {
					shared: {
						routes: [{ id: "missing", model: "first/missing", equivalence: "exact" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()?.message).toContain("logicalModels.shared.routes[0].model");
		expect(registry.getError()?.message).toContain('unknown concrete model "first/missing"');
		expect(registry.getModelRouteRegistry().getAll()).toEqual([]);
	});

	test("refresh 原子替换 policy snapshot 并保留旧快照供在途请求使用", async () => {
		const modelsPath = path.join(tempDir.path(), "models.json");
		const write = async (routeId: string, selector: string): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						first: configuredProvider("shared"),
						second: configuredProvider("shared"),
					},
					logicalModels: {
						shared: { routes: [{ id: routeId, model: selector, equivalence: "exact" }] },
					},
				}),
			);
		};
		await write("first", "first/shared");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const previousSnapshot = registry.getModelRouteRegistry();

		await write("second", "second/shared");
		const future = new Date(Date.now() + 2_000);
		await fs.utimes(modelsPath, future, future);
		await registry.refresh("offline");

		expect(previousSnapshot.get("shared")?.routes[0].id).toBe("first");
		expect(registry.getModelRouteRegistry().get("shared")?.routes[0].id).toBe("second");
		expect(registry.getModelRouteRegistry().policyVersion).toBeGreaterThan(previousSnapshot.policyVersion);
	});

	test("hot reload 编译失败时保留旧 route snapshot 并暴露新配置错误", async () => {
		const modelsPath = path.join(tempDir.path(), "models.json");
		const write = async (selector: string): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: { first: configuredProvider("shared") },
					logicalModels: {
						shared: { routes: [{ id: "route", model: selector, equivalence: "exact" }] },
					},
				}),
			);
			const future = new Date(Date.now() + 2_000);
			await fs.utimes(modelsPath, future, future);
		};
		await write("first/shared");
		const registry = new ModelRegistry(authStorage, modelsPath);
		const previousSnapshot = registry.getModelRouteRegistry();

		await write("first/missing");
		await registry.refresh("offline");

		expect(registry.getError()?.message).toContain("logicalModels.shared.routes[0].model");
		expect(registry.getModelRouteRegistry()).toBe(previousSnapshot);
		expect(registry.getModelRouteRegistry().get("shared")?.routes[0].modelSelector).toBe("first/shared");
	});

	test("runtime provider 替换 concrete model 后同步重编译 route 能力", async () => {
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { runtime: configuredProvider("shared", 32_000) },
				logicalModels: {
					shared: { routes: [{ id: "runtime", model: "runtime/shared", equivalence: "exact" }] },
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const previousVersion = registry.getModelRouteRegistry().policyVersion;
		const runtimeModel: NonNullable<ProviderConfigInput["models"]>[number] = {
			id: "shared",
			name: "shared",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 16_384,
		};

		registry.registerProvider("runtime", {
			baseUrl: "https://runtime-new.example.invalid/v1",
			apiKey: "TEST_KEY",
			api: "openai-responses",
			models: [runtimeModel],
		});

		const route = registry.getModelRouteRegistry().get("shared")?.routes[0];
		expect(route?.model.contextWindow).toBe(256_000);
		expect(route?.model.baseUrl).toBe("https://runtime-new.example.invalid/v1");
		expect(registry.getModelRouteRegistry().policyVersion).toBeGreaterThan(previousVersion);
	});
});
