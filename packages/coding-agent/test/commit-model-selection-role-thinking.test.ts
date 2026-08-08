import { describe, expect, it } from "bun:test";
import { Effort } from "@san/ai";
import { getBundledModel } from "@san/catalog/models";
import { resolvePrimaryModel, resolveSmolModel } from "@san/coding-agent/commit/model-selection";
import { compileModelRouteRegistry, ModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>, routingEnabled = false) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
		setModelRole(role: string, value: string) {
			modelRoles[role] = value;
		},
		get(path: string) {
			if (path === "routing.enabled") return routingEnabled;
			if (path === "modelRoles") return modelRoles;
			return undefined;
		},
	} as never;
}

describe("commit role thinking selection", () => {
	it("returns explicit thinking for commit and smol roles, including alias overrides", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:low`,
			smol: "@default:minimal",
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getModelRouteRegistry: () => ModelRouteRegistry.empty(),
			hasConfiguredAuth: () => true,
			isProviderEnabled: () => true,
			isSelectorSuppressed: () => false,
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(commitModel.id);
		expect(primary.thinkingLevel).toBe(Effort.Low);

		const smol = await resolveSmolModel(settings, registry, commitModel, "fallback-key");
		expect(smol.model.id).toBe(defaultModel.id);
		expect(smol.thinkingLevel).toBe(Effort.Minimal);
	});

	it("resolves an explicit logical commit override through the route registry", async () => {
		const fallbackModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-commit": {
					routes: [
						{
							id: "primary",
							model: `${commitModel.provider}/${commitModel.id}`,
							equivalence: "exact",
						},
					],
				},
			},
			[fallbackModel, commitModel],
		);
		const settings = createSettings({}, true);
		const registry = {
			getAvailable: () => [fallbackModel, commitModel],
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: () => true,
			isProviderEnabled: () => true,
			isSelectorSuppressed: () => false,
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const primary = await resolvePrimaryModel("logical-commit", settings, registry);

		expect(primary.model).toBe(commitModel);
	});
});
