import { beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@san/ai";
import { buildModel } from "@san/catalog/build";
import type { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import type { LogicalModelsConfig } from "@san/coding-agent/config/model-routes-schema";
import { Settings } from "@san/coding-agent/config/settings";
import {
	buildBrowserItems,
	buildLogicalBrowserItems,
	type LogicalBrowserResolutionConstraints,
	ModelBrowser,
	type ModelBrowserItem,
	sortModelItems,
} from "@san/coding-agent/modes/components/model-browser";
import { initTheme } from "@san/coding-agent/modes/theme/theme";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

/** Browser preloaded with `models`, MRU-sorted like the hub does on sync. */
function makeBrowser(models: Model[], mruOrder: string[]): ModelBrowser {
	const browser = new ModelBrowser(Settings.isolated({}));
	const items = buildBrowserItems(models);
	sortModelItems(items, { mruOrder });
	browser.setMruOrder(mruOrder);
	browser.setItems(items);
	return browser;
}

describe("ModelBrowser search ranking", () => {
	test("an exact query match outranks the MRU model", () => {
		// Regression: with gpt-5.6-sol as the active (MRU) model, typing
		// "gpt-5.5" must select gpt-5.5, not keep the MRU pinned on top.
		const browser = makeBrowser(
			[
				makeModel("openai-codex", "gpt-5.6-sol"),
				makeModel("openai-codex", "gpt-5.6-luna"),
				makeModel("openai-codex", "gpt-5.5"),
				makeModel("openai-codex", "gpt-5.4"),
			],
			["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
		);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("openai-codex/gpt-5.5");
	});

	test("MRU breaks ties between equally good matches", () => {
		// Same model id under two providers: match quality is identical, so
		// the recently used provider must win over alphabetical order.
		const browser = makeBrowser([makeModel("g0i", "gpt-5.5"), makeModel("zenmux", "gpt-5.5")], ["zenmux/gpt-5.5"]);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("zenmux/gpt-5.5");
	});
});

describe("ModelBrowser perf display", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton.
		await initTheme(false);
	});

	function makePerfBrowser(): ModelBrowser {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));
		return browser;
	}

	function renderPlain(browser: ModelBrowser, width: number): string[] {
		return browser.render(width).map(line => Bun.stripANSI(line));
	}

	test("row perf column scales with width: off, TPS-only, TTFT+TPS", () => {
		const browser = makePerfBrowser();

		expect(renderPlain(browser, 70)[2]).not.toContain("t/s");
		expect(renderPlain(browser, 80)[2]).toContain("118t/s");
		const wideRow = renderPlain(browser, 120)[2];
		expect(wideRow).toContain("0.9s 118t/s");
	});

	test("detail line shows measured perf regardless of width", () => {
		const browser = makePerfBrowser();

		const lines = renderPlain(browser, 70);
		expect(lines[lines.length - 2]).toContain("~118t/s · 0.9s ttft");
	});

	test("models without measurements render no perf cell", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));

		expect(renderPlain(browser, 120)[2]).not.toContain("t/s");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// LMR-04: logical-group eligibility must come from the route resolver, using
// the current session context, not from a single representative model's window.
// ────────────────────────────────────────────────────────────────────────────

function makeRouteModel(id: string, contextWindow: number): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "routes",
		baseUrl: "https://routes.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

interface LogicalRegistryStubOptions {
	suppressedSelectors?: readonly string[];
	auth?: (selector: string) => boolean;
	providerEnabled?: (provider: string) => boolean;
}

function makeLogicalRegistry(
	models: Model[],
	groups: LogicalModelsConfig,
	options: LogicalRegistryStubOptions = {},
): ModelRegistry {
	const routeRegistry = compileModelRouteRegistry(groups, models);
	const suppressed = new Set(options.suppressedSelectors ?? []);
	return {
		getModelRouteRegistry: () => routeRegistry,
		isSelectorSuppressed: (selector: string) => suppressed.has(selector),
		hasConfiguredAuth: (model: Model) => (options.auth ? options.auth(`${model.provider}/${model.id}`) : true),
		isProviderEnabled: (provider: string) => options.providerEnabled?.(provider) ?? true,
	} as unknown as ModelRegistry;
}

const LOGICAL_SETTINGS = Settings.isolated({ "routing.enabled": true });

function makeLogicalBrowser(items: ModelBrowserItem[], currentContextTokens: number): ModelBrowser {
	const browser = new ModelBrowser(LOGICAL_SETTINGS, { currentContextTokens, disableOverContext: true });
	browser.setItems(items);
	return browser;
}

describe("LMR-04 logical group eligibility (buildLogicalBrowserItems)", () => {
	test("8k primary + 128k backup at 16k context: row selectable, representative is the backup, activation stays logical", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});

		const constraints: LogicalBrowserResolutionConstraints = { requiredContextTokens: 16_000 };
		const items = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry, undefined, constraints);
		expect(items).toHaveLength(1);
		const item = items[0]!;
		expect(item.noEligibleRoute).toBeUndefined();
		// Representative/context comes from the resolver-selected backup.
		expect(item.model.contextWindow).toBe(128_000);
		expect(item.logicalRoute?.currentRouteId).toBe("backup");
		expect(item.logicalRoute?.currentModelSelector).toBe("routes/backup-b");
		// The row itself must stay selectable in the context-sensitive browser.
		const browser = makeLogicalBrowser(items, 16_000);
		const activated: string[] = [];
		browser.onActivate = selected => activated.push(selected.selector);
		browser.handleInput("\n");
		expect(activated).toEqual(["logical"]);
		expect(browser.getSelected()?.selector).toBe("logical");
	});

	test("active 8k route at 16k context does not override the eligible 128k backup", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});
		const activeRoute = { logicalModelId: "logical", routeId: "primary", modelSelector: "routes/primary-a" };

		const items = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry, activeRoute, {
			requiredContextTokens: 16_000,
		});
		const item = items[0]!;
		// Active route is ineligible in the trace, so the backup is the representative.
		expect(item.model.contextWindow).toBe(128_000);
		expect(item.noEligibleRoute).toBeUndefined();
		expect(makeLogicalBrowser(items, 16_000).getSelected()?.selector).toBe("logical");
	});

	test("eligible active route keeps affinity as representative", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});
		const activeRoute = { logicalModelId: "logical", routeId: "primary", modelSelector: "routes/primary-a" };

		const items = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry, activeRoute, {
			requiredContextTokens: 4_096,
		});
		const item = items[0]!;
		expect(item.model.contextWindow).toBe(8_192);
		expect(item.logicalRoute?.currentRouteId).toBe("primary");
		expect(item.noEligibleRoute).toBeUndefined();
	});

	test("all routes below the context: group disabled, Enter does not activate, hint names the group", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 8_192)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});

		const items = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry, undefined, {
			requiredContextTokens: 16_000,
		});
		const item = items[0]!;
		expect(item.noEligibleRoute).toBe(true);

		const browser = makeLogicalBrowser(items, 16_000);
		const activated: string[] = [];
		browser.onActivate = selected => activated.push(selected.selector);
		browser.handleInput("\n");
		expect(activated).toEqual([]);

		const plain = browser
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(plain).toContain("no eligible route");
	});

	test("an unauthenticated or suppressed 128k backup cannot unlock the group", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const groups = {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		} satisfies LogicalModelsConfig;

		// Without auth the resolver rejects the backup; the primary is too small.
		const noAuth = makeLogicalRegistry(models, groups, {
			auth: selector => selector === "routes/primary-a",
		});
		const noAuthItems = buildLogicalBrowserItems(LOGICAL_SETTINGS, noAuth, undefined, {
			requiredContextTokens: 16_000,
		});
		expect(noAuthItems[0]?.noEligibleRoute).toBe(true);

		// Suppression has the same effect through the shared resolver.
		const suppressed = makeLogicalRegistry(models, groups, {
			suppressedSelectors: ["routes/backup-b"],
		});
		const suppressedItems = buildLogicalBrowserItems(LOGICAL_SETTINGS, suppressed, undefined, {
			requiredContextTokens: 16_000,
		});
		expect(suppressedItems[0]?.noEligibleRoute).toBe(true);
	});

	test("ModelHub-style call without context constraints keeps global rows enabled", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});
		// No context passed: the resolver picks the primary and the row is not marked.
		const items = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry);
		expect(items[0]?.noEligibleRoute).toBeUndefined();
		expect(items[0]?.model.contextWindow).toBe(8_192);
	});

	test("concrete rows keep their own context disabling alongside logical rows", () => {
		const models = [makeRouteModel("primary-a", 8_192), makeRouteModel("backup-b", 128_000)];
		const registry = makeLogicalRegistry(models, {
			logical: {
				routes: [
					{ id: "primary", model: "routes/primary-a", priority: 0, equivalence: "exact" },
					{ id: "backup", model: "routes/backup-b", priority: 10, equivalence: "exact" },
				],
			},
		});
		const logicalItems = buildLogicalBrowserItems(LOGICAL_SETTINGS, registry, undefined, {
			requiredContextTokens: 16_000,
		});
		const concreteItems = buildBrowserItems(models);
		const browser = new ModelBrowser(LOGICAL_SETTINGS, { currentContextTokens: 16_000, disableOverContext: true });
		browser.setItems([...logicalItems, ...concreteItems]);

		// Logical group is selectable (backup eligible); the small concrete row is not.
		expect(browser.getSelected()?.selector).toBe("logical");
		browser.selectSelector("routes/primary-a");
		// Disabled rows are skipped by selection coercion: the 8k concrete row
		// is never selected, the browser lands on the next enabled row.
		expect(browser.getSelected()?.selector).toBe("routes/backup-b");
	});
});
