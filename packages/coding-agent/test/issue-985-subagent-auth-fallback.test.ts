import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@san/ai";
import { buildModel } from "@san/catalog/build";
import { kNoAuth } from "@san/coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@san/coding-agent/config/model-resolver";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import { Settings } from "@san/coding-agent/config/settings";

/**
 * Regression test for #985.
 *
 * Reporter screenshot showed parent session on DeepSeek V4 Pro dispatching a
 * task subagent that resolved to `qwen3.6-plus-free` — an opencode-zen model
 * the user has no working credentials for. The dispatch hit a provider that
 * could not serve the model and surfaced a confusing API rejection instead of
 * silently using the parent's already-authenticated model.
 *
 * The fix: at dispatch time, if the resolved subagent model has no working
 * credentials, fall back to the parent session's active model (which by
 * definition has working auth — the parent turn is using it).
 */

const parentModel: Model<Api> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const keylessParentModel: Model<Api> = buildModel({
	id: "qwen3:8b",
	name: "Qwen3 8B",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedTaskModel: Model<Api> = buildModel({
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedBackupModel: Model<Api> = buildModel({
	id: "task-backup",
	name: "Task Backup",
	api: "openai-completions",
	provider: "unauthed-backup",
	baseUrl: "https://backup.example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const sharedModel: Model<Api> = buildModel({
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
	} as unknown as ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> };
}

describe("issue #985: subagent dispatch auth fallback", () => {
	test("falls back to parent active model when resolved subagent model has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});

	test("does not fall back when resolved subagent model has working auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek", "opencode-zen"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when parent active model also has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("falls back when the parent active model is a keyless provider", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [keylessParentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => (model.provider === "ollama" ? kNoAuth : undefined),
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], "ollama/qwen3:8b", registry);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("ollama");
		expect(result.model?.id).toBe("qwen3:8b");
	});

	test("falls back when every logical route is rejected only for missing auth", async () => {
		const models = [parentModel, unauthedTaskModel, unauthedBackupModel];
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-task": {
					routes: [
						{ id: "primary", model: "opencode-zen/qwen3.6-plus-free", equivalence: "exact" },
						{ id: "backup", model: "unauthed-backup/task-backup", equivalence: "exact" },
					],
				},
			},
			models,
		);
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => models,
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: (model: Model<Api>) => model.provider === "deepseek",
			getApiKey: async (model: Model<Api>) => (model.provider === "deepseek" ? "sk-test-token" : undefined),
		} as never;
		const settings = Settings.isolated({ "routing.enabled": true });

		const result = await resolveModelOverrideWithAuthFallback(
			["logical-task"],
			"deepseek/deepseek-v4-pro",
			registry,
			settings,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
		expect(result.warning).toContain("unauthenticated");
	});

	test("checks logical routes in priority order before falling back to the parent", async () => {
		const models = [parentModel, unauthedTaskModel, unauthedBackupModel];
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-task": {
					routes: [
						{ id: "primary", model: "opencode-zen/qwen3.6-plus-free", equivalence: "exact" },
						{ id: "backup", model: "unauthed-backup/task-backup", equivalence: "exact" },
					],
				},
			},
			models,
		);
		const checked: string[] = [];
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => models,
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: () => true,
			isProviderEnabled: () => true,
			isSelectorSuppressed: () => false,
			getApiKey: async (model: Model<Api>) => {
				checked.push(model.provider);
				return model.provider === "unauthed-backup" || model.provider === "deepseek" ? "sk-test-token" : undefined;
			},
		} as never;
		const settings = Settings.isolated({ "routing.enabled": true });

		const result = await resolveModelOverrideWithAuthFallback(
			["logical-task"],
			"deepseek/deepseek-v4-pro",
			registry,
			settings,
		);

		expect(checked).toEqual(["opencode-zen", "unauthed-backup"]);
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model).toBe(unauthedBackupModel);
		expect(result.routeId).toBe("backup");
		expect(result.routeResolution?.route?.id).toBe("backup");
		expect(result.routeResolution?.trace.find(route => route.routeId === "backup")?.selected).toBe(true);
		expect(result.runtimeRejections).toEqual([
			{
				routeId: "primary",
				code: "api_key_unavailable",
				message: "No usable API key for opencode-zen/qwen3.6-plus-free",
			},
		]);
	});

	test("falls back to the parent only after every logical route fails real key lookup", async () => {
		const models = [parentModel, unauthedTaskModel, unauthedBackupModel];
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-task": {
					routes: [
						{ id: "primary", model: "opencode-zen/qwen3.6-plus-free", equivalence: "exact" },
						{ id: "backup", model: "unauthed-backup/task-backup", equivalence: "exact" },
					],
				},
			},
			models,
		);
		const checked: string[] = [];
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => models,
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: () => true,
			isProviderEnabled: () => true,
			isSelectorSuppressed: () => false,
			getApiKey: async (model: Model<Api>) => {
				checked.push(model.provider);
				if (model.provider === "unauthed-backup") throw new Error("credential store unavailable");
				return model.provider === "deepseek" ? "sk-parent-token" : undefined;
			},
		} as never;
		const settings = Settings.isolated({ "routing.enabled": true });

		const result = await resolveModelOverrideWithAuthFallback(
			["logical-task"],
			"deepseek/deepseek-v4-pro",
			registry,
			settings,
		);

		expect(checked).toEqual(["opencode-zen", "unauthed-backup", "deepseek"]);
		expect(result.authFallbackUsed).toBe(true);
		expect(result.model).toBe(parentModel);
		expect(result.runtimeRejections).toEqual([
			expect.objectContaining({ routeId: "primary", code: "api_key_unavailable" }),
			expect.objectContaining({
				routeId: "backup",
				code: "api_key_error",
				message: "API key lookup for unauthed-backup/task-backup failed: Error: credential store unavailable",
			}),
		]);
		expect(result.warning).toContain("primary (opencode-zen/qwen3.6-plus-free): api_key_unavailable");
		expect(result.warning).toContain("backup (unauthed-backup/task-backup): api_key_error");
	});

	test("does not hide a logical route failure unrelated to auth", async () => {
		const models = [parentModel, unauthedTaskModel];
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-task": {
					routes: [
						{
							id: "disabled",
							model: "opencode-zen/qwen3.6-plus-free",
							enabled: false,
							equivalence: "exact",
						},
					],
				},
			},
			models,
		);
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => models,
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: () => true,
			getApiKey: async (model: Model<Api>) => (model.provider === "deepseek" ? "sk-test-token" : undefined),
		} as never;
		const settings = Settings.isolated({ "routing.enabled": true });

		const result = await resolveModelOverrideWithAuthFallback(
			["logical-task"],
			"deepseek/deepseek-v4-pro",
			registry,
			settings,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model).toBeUndefined();
		expect(result.logicalModelId).toBe("logical-task");
		expect(result.warning).toContain("disabled");
	});

	test("returns primary unchanged when no parent active model is provided", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], undefined, registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
	});

	test("does not fall back when subagent and parent resolve to the same model", async () => {
		const registry = createMockRegistry({
			models: [sharedModel],
			authedProviders: new Set(), // even with no auth, identical model means no benefit
		});

		const result = await resolveModelOverrideWithAuthFallback(["deepseek/shared-id"], "deepseek/shared-id", registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.id).toBe("shared-id");
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials. The helper treats this as authenticated so an explicitly
		// configured local model is never silently rerouted to the parent's
		// remote provider (see #1008).
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
});

describe("issue #5325: sessionId forwarded to getApiKey for session-sticky OAuth", () => {
	// The pre-flight auth check in resolveModelOverrideWithAuthFallback calls
	// getApiKey without a session id. For providers with session-sticky OAuth
	// credentials, this can return undefined even though the credential is
	// usable once the subagent session starts. The fix forwards a sessionId
	// so session-sticky credentials resolve during the pre-flight check.
	test("forwards sessionId to getApiKey for the primary model", async () => {
		let receivedSessionId: string | undefined;
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (model.provider === "opencode-zen") {
					receivedSessionId = sessionId;
					// Without sessionId, OAuth can't resolve; with it, it can.
					return sessionId ? "sk-resolved-token" : undefined;
				}
				if (model.provider === "deepseek") return "sk-test";
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-123",
		);

		expect(receivedSessionId).toBe("subagent-session-123");
		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
	test("forwards sessionId to getApiKey for the fallback model", async () => {
		const receivedSessionIds: string[] = [];
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (sessionId) receivedSessionIds.push(`${model.provider}:${sessionId}`);
				if (model.provider === "opencode-zen") return undefined;
				return sessionId ? "sk-resolved-token" : undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-456",
		);

		expect(receivedSessionIds).toEqual(["opencode-zen:subagent-session-456", "deepseek:subagent-session-456"]);
		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
	});
	test("preserves the requested model warning when auth falls back", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => (model.provider === "deepseek" ? "sk-test" : undefined),
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free:invalid"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.warning).toBe(
			'Invalid thinking level "invalid" in pattern "qwen3.6-plus-free:invalid". Using default instead.',
		);
	});

	test("still falls back when getApiKey returns undefined even with sessionId", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, _sessionId?: string) => {
				if (model.provider === "deepseek") return "sk-test";
				// Genuinely broken: undefined even with sessionId (stale OAuth, revoked token)
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
			undefined,
			"subagent-session-456",
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});
});
