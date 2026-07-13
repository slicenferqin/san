import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { ConnectSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/connect-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Input, Text } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

function createHarness(options: { connected: boolean; validateError?: Error }) {
	const editorContainer = new Container();
	const editor = new Text("editor", 0, 0);
	editorContainer.addChild(editor);
	const upsertLoginApiKey = vi.fn(async () => {});
	const validateProviderApiKey = vi.fn(async () => {
		if (options.validateError) throw options.validateError;
	});
	const openAiModel = { provider: "openai", id: "gpt-test" } as Model;
	const authStorage = {
		hasAuth: (provider: string) => options.connected && provider === "openai",
		getCredentialOrigin: (provider: string) =>
			options.connected && provider === "openai" ? { kind: "api_key" as const } : undefined,
		listStoredCredentials: () => [],
		upsertLoginApiKey,
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
	};
	const showHookSelector = vi.fn(async () => "Back");
	const showError = vi.fn();
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
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError,
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		controller: new SelectorController(ctx),
		editorContainer,
		showHookSelector,
		showError,
		upsertLoginApiKey,
		validateProviderApiKey,
	};
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
		const input = harness.editorContainer.children[0];
		expect(input).toBeInstanceOf(Input);
		(input as Input).pasteText("bad-key");
		(input as Input).handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.validateProviderApiKey).toHaveBeenCalledWith("openai", "bad-key");
		expect(harness.upsertLoginApiKey).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Could not connect openai: invalid credential");
	});
});
