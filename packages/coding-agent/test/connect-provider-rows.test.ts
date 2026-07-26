import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@san/ai";
import type { ModelRegistry } from "../src/config/model-registry";
import {
	buildConnectProviderRows,
	type ConnectSelectAction,
	ConnectSelectorComponent,
} from "../src/modes/components/connect-selector";
import { initTheme } from "../src/modes/theme/theme";
import type { AuthStorage } from "../src/session/auth-storage";

beforeAll(async () => {
	await initTheme();
});

function makeAuth(overrides: {
	hasAuth?: (id: string) => boolean;
	origin?: (id: string) => { kind: "oauth" | "api_key" | "env" | "config" | "runtime" | "fallback" } | undefined;
}): AuthStorage {
	return {
		hasAuth: overrides.hasAuth ?? (() => false),
		getCredentialOrigin: overrides.origin ?? (() => undefined),
	} as unknown as AuthStorage;
}

function makeRegistry(
	availableModels: Array<{ provider: string; id: string }>,
	allModels: Array<{ provider: string; id: string }> = availableModels,
	discoverableProviders: string[] = [],
	keylessProviders: string[] = ["llama.cpp", "lm-studio", "ollama"],
): ModelRegistry {
	return {
		getAvailable: () => availableModels as unknown as Model[],
		getAll: () => allModels as unknown as Model[],
		getDiscoverableProviders: () => discoverableProviders,
		isProviderKeyless: (provider: string) => keylessProviders.includes(provider),
		canValidateProviderConnection: () => true,
		isProviderConfigured: (provider: string) => discoverableProviders.includes(provider),
	} as unknown as ModelRegistry;
}

describe("buildConnectProviderRows", () => {
	it("sorts connected providers first and reports model counts", () => {
		const auth = makeAuth({
			hasAuth: id => id === "openai",
			origin: id => (id === "openai" ? { kind: "oauth" } : undefined),
		});
		const registry = makeRegistry([
			{ provider: "openai", id: "gpt-4.1" },
			{ provider: "openai", id: "gpt-4.1-mini" },
			{ provider: "ollama", id: "llama3" },
		]);
		const rows = buildConnectProviderRows(auth, registry);
		expect(rows.length).toBeGreaterThan(0);
		const connected = rows.filter(row => row.connected);
		const disconnected = rows.filter(row => !row.connected);
		// All connected rows appear before disconnected ones.
		if (connected.length > 0 && disconnected.length > 0) {
			const firstDisconnected = rows.findIndex(row => !row.connected);
			const lastConnected = rows.map(row => row.connected).lastIndexOf(true);
			expect(lastConnected).toBeLessThan(firstDisconnected);
		}
		const openai = rows.find(row => row.id === "openai");
		expect(openai?.modelCount).toBe(2);
		expect(openai?.connected).toBe(true);
		// Web search / STT / TTS ids must not appear as connect targets.
		expect(rows.some(row => row.id === "tavily" || row.id === "kagi" || row.id === "parallel")).toBe(false);
	});

	it("includes disconnected API-key providers and classifies local providers without claiming connectivity", () => {
		const auth = makeAuth({});
		const registry = makeRegistry([]);
		const rows = buildConnectProviderRows(auth, registry);
		expect(rows.find(row => row.id === "openai")).toMatchObject({ kind: "api_key", connected: false });
		expect(rows.find(row => row.id === "openrouter")).toMatchObject({ kind: "login", connected: false });
		expect(rows.find(row => row.id === "anthropic")).toMatchObject({
			kind: "login",
			allowManualApiKey: true,
		});
		expect(rows.find(row => row.id === "kilo")).toMatchObject({ kind: "login", allowManualApiKey: true });
		expect(rows.find(row => row.id === "ollama")).toMatchObject({ kind: "keyless", connected: false });
		expect(rows.find(row => row.id === "zenmux")).toMatchObject({ kind: "login", connected: false });
		expect(rows.find(row => row.id === "google-vertex")).toMatchObject({ kind: "external", connected: false });
	});

	it("keeps provider capabilities stable when auth origins change", () => {
		const auth = makeAuth({
			hasAuth: id => id === "zenmux" || id === "google-vertex",
			origin: id => (id === "zenmux" ? { kind: "api_key" } : id === "google-vertex" ? { kind: "env" } : undefined),
		});
		const rows = buildConnectProviderRows(auth, makeRegistry([], [], [], ["vllm"]));
		expect(rows.find(row => row.id === "zenmux")).toMatchObject({ kind: "login", connected: true });
		expect(rows.find(row => row.id === "google-vertex")).toMatchObject({ kind: "external", connected: true });
		expect(rows.find(row => row.id === "vllm")).toMatchObject({ kind: "keyless" });
	});

	it("includes configured custom providers even before credentials make their models available", () => {
		const rows = buildConnectProviderRows(makeAuth({}), makeRegistry([], [], ["team-proxy"]));
		expect(rows.find(row => row.id === "team-proxy")).toMatchObject({
			kind: "api_key",
			connected: false,
			modelCount: 0,
			removableConfig: true,
		});
	});

	it("allows connected bundled provider overrides to be removed", () => {
		const auth = makeAuth({ hasAuth: id => id === "openai" });
		const rows = buildConnectProviderRows(
			auth,
			makeRegistry([{ provider: "openai", id: "gpt-4.1" }], [], ["openai"]),
		);
		expect(rows.find(row => row.id === "openai")).toMatchObject({
			connected: true,
			removableConfig: true,
		});
	});

	it("does not select the hidden custom action when search has no matches", () => {
		const actions: ConnectSelectAction[] = [];
		const selector = new ConnectSelectorComponent(
			[],
			action => actions.push(action),
			() => {},
		);
		for (const char of "missing") selector.handleInput(char);
		selector.handleInput("\n");
		expect(actions).toEqual([]);
	});

	it("sanitizes provider labels and stays within a 40-column viewport", () => {
		const selector = new ConnectSelectorComponent(
			[
				{
					id: "hostile",
					label: "bad\u001b[31m\tprovider\nname",
					kind: "api_key",
					connected: false,
					modelCount: 0,
					connectable: true,
				},
			],
			() => {},
			() => {},
		);
		const lines = selector.render(40);
		expect(lines.length).toBeLessThanOrEqual(24);
		for (const line of lines) {
			expect(Bun.stringWidth(line, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(40);
			expect(Bun.stripANSI(line)).not.toContain("\t");
		}
		expect(Bun.stripANSI(lines.join("\n"))).not.toContain("[31m");
		expect(Bun.stripANSI(lines.join("\n"))).toContain("auth: api key");
		expect(Bun.stripANSI(lines.join("\n"))).toContain("0 available models");
	});

	it("routes a scrolled custom-endpoint mouse click to the custom action", () => {
		const actions: ConnectSelectAction[] = [];
		const rows = Array.from({ length: 10 }, (_, index) => ({
			id: `provider-${index}`,
			label: `Provider ${index}`,
			kind: "api_key" as const,
			connected: false,
			modelCount: 0,
			connectable: true,
		}));
		const selector = new ConnectSelectorComponent(
			rows,
			action => actions.push(action),
			() => {},
		);
		const rendered = selector.render(80).map(Bun.stripANSI);
		const customLine = rendered.findIndex(line => line.includes("Add custom endpoint"));
		expect(customLine).toBeGreaterThanOrEqual(0);
		selector.routeMouse(
			{ button: 0, col: 0, row: customLine, release: false, wheel: null, motion: false, leftClick: true },
			customLine,
			0,
		);
		expect(actions).toEqual([{ type: "addCustom" }]);
	});

	it("opens provider management for a connected row even when it has no cached models", () => {
		const actions: ConnectSelectAction[] = [];
		const selector = new ConnectSelectorComponent(
			[
				{
					id: "connected",
					label: "Connected",
					kind: "api_key",
					connected: true,
					modelCount: 0,
					connectable: true,
				},
			],
			action => actions.push(action),
			() => {},
		);
		selector.handleInput("\n");
		expect(actions).toEqual([
			{
				type: "manage",
				providerId: "connected",
				authProviderId: "connected",
				kind: "api_key",
				modelCount: 0,
				connectable: true,
				allowManualApiKey: false,
				supportsLogin: false,
				verifiable: false,
				removableConfig: false,
			},
		]);
	});

	it("opens provider management for a disconnected removable configuration", () => {
		const actions: ConnectSelectAction[] = [];
		const selector = new ConnectSelectorComponent(
			[
				{
					id: "broken-config",
					label: "Broken config",
					kind: "api_key",
					connected: false,
					modelCount: 0,
					connectable: true,
					verifiable: true,
					removableConfig: true,
				},
			],
			action => actions.push(action),
			() => {},
		);

		selector.handleInput("\n");

		expect(actions).toEqual([
			{
				type: "manage",
				providerId: "broken-config",
				authProviderId: "broken-config",
				kind: "api_key",
				modelCount: 0,
				connectable: true,
				allowManualApiKey: false,
				supportsLogin: false,
				verifiable: true,
				removableConfig: true,
			},
		]);
	});
});
