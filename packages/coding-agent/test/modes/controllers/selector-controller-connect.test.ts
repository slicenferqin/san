import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as modelDiscovery from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import * as modelsConfigWriter from "@oh-my-pi/pi-coding-agent/config/models-config-writer";
import { ConnectSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/connect-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Input, Text } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createHarness(options: {
	connected: boolean;
	validateError?: Error;
	upsertLoginApiKeyError?: Error;
	refreshProviderError?: Error;
}) {
	const editorContainer = new Container();
	const editor = new Text("editor", 0, 0);
	editorContainer.addChild(editor);
	const upsertLoginApiKey = vi.fn(async (_provider: string, _apiKey: string) => {
		if (options.upsertLoginApiKeyError) throw options.upsertLoginApiKeyError;
	});
	const validateProviderApiKey = vi.fn(async (_provider: string, _apiKey: string) => {
		if (options.validateError) throw options.validateError;
	});
	const remove = vi.fn(async (_provider: string) => true);
	const refresh = vi.fn(async (_strategy?: string) => {});
	const refreshProvider = vi.fn(async (_provider: string, _strategy?: string) => {
		if (options.refreshProviderError) throw options.refreshProviderError;
	});
	const openAiModel = { provider: "openai", id: "gpt-test" } as Model;
	const storedCredentials: Array<{ id: string }> = [];
	const authStorage = {
		hasAuth: (provider: string) => options.connected && provider === "openai",
		getCredentialOrigin: (provider: string) =>
			options.connected && provider === "openai" ? { kind: "api_key" as const } : undefined,
		listStoredCredentials: (provider?: string) => {
			void provider;
			return storedCredentials;
		},
		upsertLoginApiKey: async (provider: string, apiKey: string) => {
			await upsertLoginApiKey(provider, apiKey);
			storedCredentials.push({ id: "login-key" });
		},
		remove,
	};
	const modelRegistry = {
		authStorage,
		getAvailable: () => (options.connected ? [openAiModel] : []),
		getAll: () => [openAiModel],
		getDiscoverableProviders: () => [],
		isProviderKeyless: () => false,
		isProviderConfigured: () => false,
		canValidateProviderConnection: () => true,
		validateProviderApiKey,
		validateProviderConnection: vi.fn(async () => 1),
		refresh,
		refreshProvider,
	};
	const showHookSelector = vi.fn(async () => "Back");
	const showError = vi.fn();
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const present = vi.fn();
	const ctx = {
		editorContainer,
		editor,
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			terminal: { columns: 80, rows: 24 },
		},
		session: {
			modelRegistry,
			sessionId: "connect-test",
			getAvailableModels: () => (options.connected ? [openAiModel] : []),
		},
		showHookSelector,
		showHookConfirm: vi.fn(async () => false),
		showStatus,
		showWarning,
		showError,
		present,
	} as unknown as InteractiveModeContext;
	return {
		controller: new SelectorController(ctx),
		editorContainer,
		showHookSelector,
		showError,
		showWarning,
		showStatus,
		present,
		upsertLoginApiKey,
		validateProviderApiKey,
		remove,
		refresh,
		refreshProvider,
		authStorage,
	};
}

async function waitForInput(editorContainer: Container): Promise<Input> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const child = editorContainer.children[0];
		if (child instanceof Input) return child;
		await Promise.resolve();
	}
	throw new Error("Expected a focused Input prompt");
}

async function fillPrompt(editorContainer: Container, value: string): Promise<void> {
	const input = await waitForInput(editorContainer);
	input.pasteText(value);
	input.handleInput("\n");
	await Promise.resolve();
	await Promise.resolve();
}

describe("SelectorController provider connect flow", () => {
	it("opens management actions for a connected provider", async () => {
		const harness = createHarness({ connected: true });
		await harness.controller.showConnectSelector();
		const selector = harness.editorContainer.children[0];
		expect(selector).toBeInstanceOf(ConnectSelectorComponent);
		for (const char of "openai") (selector as ConnectSelectorComponent).handleInput(char);
		(selector as ConnectSelectorComponent).handleInput("\n");
		await Promise.resolve();

		expect(harness.showHookSelector).toHaveBeenCalledWith(
			"Manage openai",
			expect.arrayContaining([
				expect.objectContaining({ label: "View models" }),
				expect.objectContaining({ label: "Verify connection" }),
				"Back",
			]),
		);
	});

	it("validates an API key before storing it", async () => {
		const harness = createHarness({ connected: false, validateError: new Error("invalid credential") });
		await harness.controller.showConnectSelector();
		const selector = harness.editorContainer.children[0] as ConnectSelectorComponent;
		for (const char of "openai") selector.handleInput(char);
		selector.handleInput("\n");
		await Promise.resolve();
		const input = await waitForInput(harness.editorContainer);
		input.pasteText("bad-key");
		input.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.validateProviderApiKey).toHaveBeenCalledWith("openai", "bad-key");
		expect(harness.upsertLoginApiKey).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Could not connect openai: invalid credential");
	});

	it("rolls back a newly written custom provider when key persistence fails", async () => {
		const harness = createHarness({
			connected: false,
			upsertLoginApiKeyError: new Error("auth store unavailable"),
		});
		vi.spyOn(modelDiscovery, "discoverModelsByProviderType").mockResolvedValue([
			{ id: "proxy-model", provider: "team-proxy" } as never,
		]);
		const writeSpy = vi.spyOn(modelsConfigWriter, "writeCustomProviderConfig").mockResolvedValue({
			path: "/tmp/models.yml",
			changed: true,
			persisted: true,
		});
		const removeConfigSpy = vi.spyOn(modelsConfigWriter, "removeCustomProviderConfig").mockResolvedValue({
			path: "/tmp/models.yml",
			changed: true,
			removed: true,
		});
		vi.spyOn(modelsConfigWriter, "validateCustomProviderConfigDestination").mockResolvedValue(undefined);

		await harness.controller.showConnectSelector();
		const selector = harness.editorContainer.children[0] as ConnectSelectorComponent;
		// Filter to the always-available custom action (no provider names match "custom").
		for (const char of "custom") selector.handleInput(char);
		selector.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		await fillPrompt(harness.editorContainer, "team-proxy");
		await fillPrompt(harness.editorContainer, "https://proxy.example/v1");
		await fillPrompt(harness.editorContainer, "sk-test-secret");
		// Allow the async setup + rollback chain to settle.
		for (let i = 0; i < 10; i++) await Promise.resolve();

		expect(writeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ name: "team-proxy", baseUrl: "https://proxy.example/v1" }),
		);
		expect(harness.upsertLoginApiKey).toHaveBeenCalledWith("team-proxy", "sk-test-secret");
		// Key store failed before any credential row was created; only models.yml is rolled back.
		expect(removeConfigSpy).toHaveBeenCalledWith("team-proxy");
		expect(harness.remove).not.toHaveBeenCalled();
		expect(harness.refresh).toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith(
			expect.stringContaining("Custom provider failed: auth store unavailable"),
		);
	});
});
