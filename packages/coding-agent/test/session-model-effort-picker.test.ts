import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@san/agent";
import { Effort, type Model } from "@san/ai";
import { buildModel } from "@san/catalog/build";
import type { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { ModelHubComponent, resetProviderAutoRefreshGuard } from "@san/coding-agent/modes/components/model-hub";
import { getThemeByName, setThemeInstance } from "@san/coding-agent/modes/theme/theme";
import type { ConfiguredThinkingLevel } from "@san/coding-agent/thinking";
import type { TUI } from "@san/tui";

const openHubs: ModelHubComponent[] = [];

function normalizeRenderedText(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

function createHub(model: Model, initialThinkingLevel?: ConfiguredThinkingLevel) {
	const onPick = vi.fn();
	const registry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(
		ui,
		Settings.isolated({}),
		registry,
		[{ model }],
		{
			onAssign: vi.fn(),
			onUnassign: vi.fn(),
			onPick,
			onCancel: vi.fn(),
		},
		{ mode: "pick", initialThinkingLevel },
	);
	openHubs.push(hub);
	return { hub, onPick };
}

describe("session model effort picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) hub.dispose();
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
		const { hub, onPick } = createHub(model, ThinkingLevel.High);
		await Promise.resolve();

		hub.handleInput("\n");
		const rendered = normalizeRenderedText(hub.render(100));
		expect(rendered).toContain("Effort for session");
		expect(rendered).toContain("high");
		expect(onPick).not.toHaveBeenCalled();

		hub.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(model);
		expect(onPick.mock.calls[0]?.[2]).toBe(ThinkingLevel.High);
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
		const { hub, onPick } = createHub(model);
		await Promise.resolve();

		hub.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(model);
		expect(onPick.mock.calls[0]?.[2]).toBeUndefined();
	});
});
