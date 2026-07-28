/**
 * `/connect` provider management surface.
 *
 * Lists model providers (OAuth, API key, keyless/local). Connected providers
 * sort first with origin + model count. Non-model services stay excluded.
 */

import { PROVIDER_REGISTRY } from "@san/ai/registry/registry";
import type { ProviderDefinition } from "@san/ai/registry/types";
import type { ProviderCatalogEntry } from "@san/catalog/provider-models/descriptor-types";
import { CATALOG_PROVIDERS } from "@san/catalog/provider-models/descriptors";
import {
	Container,
	fuzzyFilter,
	matchesKey,
	ScrollView,
	type SgrMouseEvent,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@san/tui";
import type { ModelRegistry } from "../../config/model-registry";
import { settings } from "../../config/settings";
import { sanitizeStatusText } from "../../modes/shared";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage, CredentialOriginKind } from "../../session/auth-storage";
import { DynamicBorder } from "./dynamic-border";

const MAX_VISIBLE = 8;
const ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "runtime",
	config: "config",
	oauth: "oauth",
	api_key: "api key",
	env: "env",
	fallback: "fallback",
};

export type ConnectProviderKind = "login" | "api_key" | "keyless" | "external" | "custom";

export interface ConnectProviderRow {
	id: string;
	label: string;
	kind: ConnectProviderKind;
	connected: boolean;
	originLabel?: string;
	modelCount: number;
	/** Whether selecting this row starts an interactive login/connect flow. */
	connectable: boolean;
	/** Optional description for narrow-terminal detail pane. */
	detail?: string;
	/** Login alias when credentials are stored under a different model provider id. */
	authProviderId?: string;
	/** OAuth-style login is available alongside direct API-key entry. */
	allowManualApiKey?: boolean;
	supportsLogin?: boolean;
	verifiable?: boolean;
	removableConfig?: boolean;
}

export type ConnectSelectAction =
	| {
			type: "connect";
			providerId: string;
			authProviderId: string;
			kind: ConnectProviderKind;
			allowManualApiKey: boolean;
			supportsLogin: boolean;
	  }
	| {
			type: "manage";
			providerId: string;
			authProviderId: string;
			kind: ConnectProviderKind;
			modelCount: number;
			connectable: boolean;
			allowManualApiKey: boolean;
			supportsLogin: boolean;
			verifiable: boolean;
			removableConfig: boolean;
	  }
	| { type: "openModels"; providerId: string }
	| { type: "refresh"; providerId: string }
	| { type: "configureExternally"; providerId: string }
	| { type: "addCustom" };

function getDisabledProviderIds(): ReadonlySet<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

function formatKind(kind: ConnectProviderKind): string {
	switch (kind) {
		case "login":
			return "sign in";
		case "api_key":
			return "api key";
		case "keyless":
			return "local";
		case "external":
			return "environment";
		case "custom":
			return "custom";
	}
}

/**
 * Build the `/connect` inventory from the catalog's chat-model providers plus
 * configured custom providers. The broader auth registry also contains search
 * services, so it cannot be the inventory source.
 */
export function buildConnectProviderRows(
	authStorage: AuthStorage,
	modelRegistry: Pick<
		ModelRegistry,
		| "getAvailable"
		| "getAll"
		| "getDiscoverableProviders"
		| "isProviderKeyless"
		| "canValidateProviderConnection"
		| "isProviderConfigured"
	>,
): ConnectProviderRow[] {
	const disabled = getDisabledProviderIds();
	const available = modelRegistry.getAvailable();
	const modelCountByProvider = new Map<string, number>();
	for (const model of available) {
		modelCountByProvider.set(model.provider, (modelCountByProvider.get(model.provider) ?? 0) + 1);
	}

	const rows: ConnectProviderRow[] = [];
	const seen = new Set<string>();
	const definitions = new Map<string, ProviderDefinition>(
		PROVIDER_REGISTRY.map(definition => [definition.id, definition]),
	);
	const catalogIds = new Set<string>(CATALOG_PROVIDERS.map(provider => provider.id));
	const catalogProviders: readonly ProviderCatalogEntry[] = CATALOG_PROVIDERS;

	for (const provider of catalogProviders) {
		if (disabled.has(provider.id)) continue;
		const definition = definitions.get(provider.id);
		const origin = authStorage.getCredentialOrigin(provider.id);
		const hasAuth = authStorage.hasAuth(provider.id);
		const modelCount = modelCountByProvider.get(provider.id) ?? 0;
		const keyless = modelRegistry.isProviderKeyless(provider.id) && !hasAuth;
		const supportsLogin = Boolean(definition?.login);
		const verifiable = modelRegistry.canValidateProviderConnection(provider.id);
		const supportsApiKey = Boolean(provider.envVars && verifiable);
		let kind: ConnectProviderKind;
		if (keyless) kind = "keyless";
		else if (supportsLogin) kind = "login";
		else if (supportsApiKey) kind = "api_key";
		else kind = "external";
		rows.push({
			id: provider.id,
			label: sanitizeStatusText(definition?.name ?? provider.catalogDiscovery?.label ?? provider.id),
			kind,
			connected: hasAuth || modelCount > 0,
			originLabel: origin ? ORIGIN_LABELS[origin.kind] : undefined,
			modelCount,
			connectable: kind !== "external",
			detail: sanitizeStatusText(definition?.name ?? provider.id),
			authProviderId: definition?.id ?? provider.id,
			allowManualApiKey: supportsLogin && supportsApiKey,
			supportsLogin,
			verifiable,
			removableConfig: modelRegistry.isProviderConfigured(provider.id),
		});
		seen.add(provider.id);
	}

	const allProviderIds = new Set([
		...modelRegistry.getAll().map(model => model.provider),
		...modelRegistry.getDiscoverableProviders(),
	]);
	for (const providerId of allProviderIds) {
		if (seen.has(providerId) || catalogIds.has(providerId) || disabled.has(providerId)) continue;
		const origin = authStorage.getCredentialOrigin(providerId);
		const hasAuth = authStorage.hasAuth(providerId);
		const modelCount = modelCountByProvider.get(providerId) ?? 0;
		const definition = definitions.get(providerId);
		const keyless = modelRegistry.isProviderKeyless(providerId) && !hasAuth;
		const supportsLogin = Boolean(definition?.login);
		const verifiable = modelRegistry.canValidateProviderConnection(providerId);
		const supportsApiKey = !keyless && verifiable && (!definition || typeof definition.envKeys === "string");
		const kind: ConnectProviderKind = origin
			? supportsLogin
				? "login"
				: supportsApiKey
					? "api_key"
					: "external"
			: keyless
				? "keyless"
				: supportsLogin
					? "login"
					: typeof definition?.envKeys === "function"
						? "external"
						: supportsApiKey
							? "api_key"
							: "external";
		rows.push({
			id: providerId,
			label: sanitizeStatusText(definition?.name ?? providerId),
			kind,
			connected: hasAuth || modelCount > 0,
			originLabel: origin ? ORIGIN_LABELS[origin.kind] : modelCount > 0 ? "custom" : undefined,
			modelCount,
			connectable: kind !== "external",
			detail: sanitizeStatusText(providerId),
			authProviderId: providerId,
			allowManualApiKey: supportsLogin && supportsApiKey,
			supportsLogin,
			verifiable,
			removableConfig: modelRegistry.isProviderConfigured(providerId),
		});
	}

	rows.sort((a, b) => {
		if (a.connected !== b.connected) return a.connected ? -1 : 1;
		return a.label.localeCompare(b.label);
	});
	return rows;
}

export class ConnectSelectorComponent extends Container {
	#listContainer: Container;
	#detailContainer: Container;
	#searchContainer: Container;
	#allRows: ConnectProviderRow[] = [];
	#filteredRows: ConnectProviderRow[] = [];
	#searchQuery = "";
	#selectedIndex = 0;
	#scrollStart = 0;
	#visibleCount = 0;
	#customRowLine = -1;
	#terminalColumns: number;
	#listLineOffset = 0;
	#showCustom = true;
	#onSelect: (action: ConnectSelectAction) => void;
	#onCancel: () => void;

	constructor(
		rows: ConnectProviderRow[],
		onSelect: (action: ConnectSelectAction) => void,
		onCancel: () => void,
		options?: { terminalColumns?: number },
	) {
		super();
		this.#allRows = rows;
		this.#filteredRows = rows;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#terminalColumns = options?.terminalColumns ?? process.stdout.columns ?? 80;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Connect a model provider")));
		this.#searchContainer = new Container();
		this.addChild(this.#searchContainer);
		this.addChild(new Spacer(1));

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.#detailContainer = new Container();
		this.addChild(this.#detailContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	#narrow(): boolean {
		return this.#terminalColumns < 60;
	}

	#updateList(): void {
		this.#listContainer.clear();
		this.#detailContainer.clear();
		this.#searchContainer.clear();
		const searchLabel = this.#searchQuery ? `Search: ${sanitizeStatusText(this.#searchQuery)}` : "Type to search";
		this.#searchContainer.addChild(new TruncatedText(theme.fg("muted", searchLabel)));
		const rows = this.#filteredRows;
		const maxVisible = Math.min(MAX_VISIBLE, rows.length);
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), rows.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, rows.length);
		this.#scrollStart = startIndex;
		this.#visibleCount = Math.max(0, endIndex - startIndex);

		const lines: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const row = rows[i];
			if (!row) continue;
			const selected = i === this.#selectedIndex;
			const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const status = row.connected ? theme.fg("success", "●") : theme.fg("dim", "○");
			const safeLabel = sanitizeStatusText(row.label);
			const name = selected ? theme.fg("accent", safeLabel) : safeLabel;
			const metaParts: string[] = [];
			if (!this.#narrow()) {
				metaParts.push(formatKind(row.kind));
				if (row.originLabel) metaParts.push(row.originLabel);
				metaParts.push(`${row.modelCount} models`);
			} else {
				metaParts.push(row.originLabel ?? formatKind(row.kind));
				metaParts.push(`${row.modelCount}`);
			}
			const meta = metaParts.length > 0 ? theme.fg("dim", `  ${metaParts.join(" · ")}`) : "";
			lines.push(truncateToWidth(`${cursor}${status} ${name}${meta}`, Math.max(1, this.#terminalColumns)));
		}

		// Always-available custom endpoint entry at end of list when not searching,
		// or when search matches "custom".
		const showCustom =
			!this.#searchQuery.trim() ||
			"custom".includes(this.#searchQuery.trim().toLowerCase()) ||
			"endpoint".includes(this.#searchQuery.trim().toLowerCase());
		this.#showCustom = showCustom;
		this.#customRowLine = showCustom ? (lines.length > 0 ? lines.length : 1) : -1;

		if (lines.length > 0) {
			const sv = new ScrollView(lines, {
				height: lines.length,
				scrollbar: "auto",
				totalRows: rows.length,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		} else {
			this.#listContainer.addChild(new Text(theme.fg("muted", "  No matching providers"), 0, 0));
		}

		// Add custom endpoint action row
		const customSelected = this.#selectedIndex === rows.length;
		if (showCustom) {
			const cursor = customSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = customSelected ? theme.fg("accent", "Add custom endpoint…") : "Add custom endpoint…";
			this.#listContainer.addChild(new Text(`${cursor}${theme.fg("dim", "+")} ${label}`, 0, 0));
		}

		const selected = rows[this.#selectedIndex];
		if (selected) {
			this.#detailContainer.addChild(new Spacer(1));
			const fullId = sanitizeStatusText(selected.id);
			this.#detailContainer.addChild(new TruncatedText(theme.fg("muted", `  ${fullId}`)));
			const auth = selected.originLabel ?? formatKind(selected.kind);
			this.#detailContainer.addChild(
				new TruncatedText(
					theme.fg("dim", `  ${selected.connected ? "connected" : "not connected"} · auth: ${auth}`),
				),
			);
			this.#detailContainer.addChild(
				new TruncatedText(theme.fg("dim", `  ${selected.modelCount} available models`)),
			);
		} else if (this.#selectedIndex === rows.length && showCustom) {
			this.#detailContainer.addChild(new Spacer(1));
			this.#detailContainer.addChild(
				new Text(theme.fg("muted", "  Persist OpenAI-compatible base URL via models.yml (no keys in YAML)"), 0, 0),
			);
		}
	}

	#maxIndex(): number {
		return this.#filteredRows.length - 1 + (this.#showCustom ? 1 : 0);
	}

	#selectCurrent(): void {
		if (this.#showCustom && this.#selectedIndex === this.#filteredRows.length) {
			this.#onSelect({ type: "addCustom" });
			return;
		}
		const row = this.#filteredRows[this.#selectedIndex];
		if (!row) return;
		if (row.connected || row.removableConfig) {
			this.#onSelect({
				type: "manage",
				providerId: row.id,
				authProviderId: row.authProviderId ?? row.id,
				kind: row.kind,
				modelCount: row.modelCount,
				connectable: row.connectable,
				allowManualApiKey: row.allowManualApiKey ?? false,
				supportsLogin: row.supportsLogin ?? false,
				verifiable: row.verifiable ?? false,
				removableConfig: row.removableConfig ?? false,
			});
			return;
		}
		if (!row.connectable) {
			this.#onSelect({ type: "configureExternally", providerId: row.id });
			return;
		}
		this.#onSelect({
			type: "connect",
			providerId: row.id,
			authProviderId: row.authProviderId ?? row.id,
			kind: row.kind,
			allowManualApiKey: row.allowManualApiKey ?? false,
			supportsLogin: row.supportsLogin ?? false,
		});
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			const max = this.#maxIndex();
			if (max < 0) return;
			this.#selectedIndex = this.#selectedIndex <= 0 ? max : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}
		if (matchesSelectDown(keyData)) {
			const max = this.#maxIndex();
			if (max < 0) return;
			this.#selectedIndex = this.#selectedIndex >= max ? 0 : this.#selectedIndex + 1;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrent();
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#onCancel();
			return;
		}

		// Search
		if (keyData === "\x7f" || keyData === "\b") {
			this.#searchQuery = this.#searchQuery.slice(0, -1);
		} else if (keyData.length === 1 && keyData >= " ") {
			this.#searchQuery += keyData;
		} else {
			return;
		}
		if (this.#searchQuery.trim()) {
			this.#filteredRows = fuzzyFilter(this.#allRows, this.#searchQuery, row => `${row.label} ${row.id}`);
		} else {
			this.#filteredRows = this.#allRows;
		}
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#maxIndex()));
		this.#updateList();
	}

	override render(width: number): readonly string[] {
		const nextWidth = Math.max(1, width);
		if (nextWidth !== this.#terminalColumns) {
			this.#terminalColumns = nextWidth;
			this.#updateList();
		}
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(nextWidth);
			if (child === this.#listContainer) this.#listLineOffset = lines.length;
			lines.push(...childLines);
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			if (event.wheel < 0) this.handleInput("\x1b[A");
			else this.handleInput("\x1b[B");
			return;
		}
		const rowLine = line - this.#listLineOffset;
		if (rowLine < 0) return;
		const index =
			rowLine === this.#customRowLine
				? this.#filteredRows.length
				: rowLine < this.#visibleCount
					? this.#scrollStart + rowLine
					: -1;
		if (index < 0 || index > this.#maxIndex()) return;
		if (event.motion) {
			if (index !== this.#selectedIndex) {
				this.#selectedIndex = index;
				this.#updateList();
			}
			return;
		}
		if (event.leftClick) {
			this.#selectedIndex = index;
			this.#selectCurrent();
		}
	}
}
