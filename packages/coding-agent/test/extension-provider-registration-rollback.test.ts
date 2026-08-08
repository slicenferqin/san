import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { unregisterOAuthProvider } from "@san/ai/oauth";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@san/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@san/coding-agent/extensibility/extensions/runner";
import type { ProviderConfig } from "@san/coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { EventBus } from "@san/coding-agent/utils/event-bus";
import { TempDir } from "@san/utils";

const testProviderConfig: ProviderConfig = {
	baseUrl: "https://example.invalid/v1",
	apiKey: "TEST_PROVIDER_API_KEY",
	api: "openai-completions",
	models: [
		{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 4_096,
		},
	],
};

describe("extension provider registration rollback", () => {
	test("removes registrations added by a failed extension", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("should-not-survive", testProviderConfig);
					throw new Error("intentional initialization failure");
				},
				process.cwd(),
				events,
				runtime,
				"broken-inline-extension",
			),
		).rejects.toThrow("intentional initialization failure");

		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	test("restores an earlier queued registration when a later extension fails", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();
		await loadExtensionFromFactory(
			pi => pi.registerProvider("working-provider", testProviderConfig),
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.unregisterProvider("working-provider");
					throw new Error("failed after unregistering");
				},
				process.cwd(),
				events,
				runtime,
				"broken-extension",
			),
		).rejects.toThrow("failed after unregistering");

		expect(runtime.pendingProviderRegistrations.map(registration => registration.name)).toEqual(["working-provider"]);
	});

	test("replaces a queued provider after unregistering it", async () => {
		const runtime = new ExtensionRuntime();
		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("cliproxyapi", testProviderConfig);
				pi.unregisterProvider("cliproxyapi");
				pi.registerProvider("cliproxyapi", { baseUrl: "https://replacement.example.invalid/v1" });
			},
			process.cwd(),
			new EventBus(),
			runtime,
			"pi-cliproxyapi-provider@1.4.13",
		);

		expect(runtime.pendingProviderRegistrations).toEqual([
			{
				name: "cliproxyapi",
				config: { baseUrl: "https://replacement.example.invalid/v1" },
				sourceId: "pi-cliproxyapi-provider@1.4.13",
			},
		]);
	});

	test("applies provider replacement after runtime initialization", async () => {
		const tempDir = TempDir.createSync("@provider-replacement-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));
			modelRegistry.registerProvider("cliproxyapi", testProviderConfig, "pi-cliproxyapi-provider");

			const runtime = new ExtensionRuntime();
			let replaceProvider: (() => void) | undefined;
			const extension = await loadExtensionFromFactory(
				pi => {
					replaceProvider = () => {
						pi.unregisterProvider("cliproxyapi");
						pi.registerProvider("cliproxyapi", {
							...testProviderConfig,
							apiKey: undefined,
							baseUrl: "https://replacement.example.invalid/v1",
							oauth: { name: "CLIProxyAPI", login: async () => "test-token" },
						});
					};
				},
				process.cwd(),
				new EventBus(),
				runtime,
				"pi-cliproxyapi-provider",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			if (!replaceProvider) throw new Error("Extension did not expose provider replacement");
			replaceProvider();

			expect(modelRegistry.authStorage.hasAuth("cliproxyapi")).toBe(false);
			expect(modelRegistry.find("cliproxyapi", "test-model")?.baseUrl).toBe(
				"https://replacement.example.invalid/v1",
			);
		} finally {
			unregisterOAuthProvider("cliproxyapi");
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
