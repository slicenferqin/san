import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

function renderSelector(selector: ModelSelectorComponent): string {
	return normalizeRenderedText(selector.render(100).join("\n"));
}

describe("session model effort picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	it("opens effort step after selecting a reasoning model in session mode", async () => {
		const model = buildModel({
			id: "reasoning-model",
			name: "Reasoning Model",
			provider: "test",
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: true,
			thinking: {
				mode: "effort",
				defaultLevel: Effort.High,
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			},
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const onSelect = vi.fn(async () => {});
		const registry = {
			refresh: async () => {},
			refreshProvider: async () => {},
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = new ModelSelectorComponent(
			ui,
			model,
			Settings.isolated({ defaultThinkingLevel: ThinkingLevel.High }),
			registry,
			[],
			onSelect,
			() => {},
			{ temporaryOnly: true, directSelect: true, hideProviderTabs: true },
		);
		// Flush the offline refresh microtask without sleeping.
		await Promise.resolve();

		selector.handleInput("\n");
		const rendered = renderSelector(selector);
		expect(rendered).toContain("Effort for session");
		expect(rendered).toContain("high");
		expect(onSelect).not.toHaveBeenCalled();

		selector.handleInput("\n");
		await Promise.resolve();
		expect(onSelect).toHaveBeenCalledTimes(1);
		const call = onSelect.mock.calls[0] as unknown as [
			unknown,
			string | null,
			string | undefined,
			string | undefined,
			string | undefined,
		];
		expect(call[1]).toBeNull();
		expect(call[2]).toBe(ThinkingLevel.High);
	});

	it("selects non-reasoning models immediately without effort step", async () => {
		const model = buildModel({
			id: "plain-model",
			name: "Plain Model",
			provider: "test",
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const onSelect = vi.fn(async () => {});
		const registry = {
			refresh: async () => {},
			refreshProvider: async () => {},
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = new ModelSelectorComponent(ui, model, Settings.isolated({}), registry, [], onSelect, () => {}, {
			temporaryOnly: true,
			directSelect: true,
			hideProviderTabs: true,
		});
		await Promise.resolve();

		selector.handleInput("\n");
		await Promise.resolve();
		expect(onSelect).toHaveBeenCalledTimes(1);
		const call = onSelect.mock.calls[0] as unknown as [
			unknown,
			string | null,
			string | undefined,
			string | undefined,
			string | undefined,
		];
		expect(call[1]).toBeNull();
		expect(call[2]).toBeUndefined();
	});
});
