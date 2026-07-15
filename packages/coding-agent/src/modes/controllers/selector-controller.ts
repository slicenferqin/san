import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Component, OverlayHandle } from "@oh-my-pi/pi-tui";
import { Input, Loader, Spacer, setTuiTight, Text } from "@oh-my-pi/pi-tui";
import {
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	normalizePathForComparison,
	wrapFetchForExtraCa,
} from "@oh-my-pi/pi-utils";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { discoverModelsByProviderType, normalizeOpenAIModelsListBaseUrl } from "../../config/model-discovery";
import { formatModelSelectorValue, resolveAdvisorRoleSelection } from "../../config/model-resolver";
import { getRoleInfo } from "../../config/model-roles";
import {
	removeCustomProviderConfig,
	validateCustomProviderConfigDestination,
	writeCustomProviderConfig,
} from "../../config/models-config-writer";
import { settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import { sanitizeStatusText } from "../../modes/shared";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setMarkdownMermaidRendering,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import {
	isImageProviderPreference,
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredImageProvider,
	setPreferredSearchProvider,
} from "../../tools";
import { shortenPath } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { repo } from "../../utils/git";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "../components/advisor-config";
import { AgentDashboard } from "../components/agent-dashboard";
import { AgentHubOverlayComponent } from "../components/agent-hub";
import { AssistantMessageComponent } from "../components/assistant-message";
import {
	buildConnectProviderRows,
	type ConnectProviderKind,
	type ConnectSelectAction,
	ConnectSelectorComponent,
} from "../components/connect-selector";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { ModelSelectorComponent } from "../components/model-selector";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { buildCopyTargets } from "../utils/copy-targets";

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	/**
	 * Restore keyboard focus to whatever currently owns the editor slot. The
	 * slot can hold the editor itself or a hook selector/input/editor pushed
	 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
	 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
	 * the component focused when the overlay opened, which is stale in that
	 * case (the editor was swapped out): keys land on a hidden editor and the
	 * visible prompt receives nothing (issue #3349). Call this after the
	 * overlay hides to re-target focus at the visible slot owner.
	 */
	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		let component: Component | undefined;
		const done = () => {
			component?.dispose?.();
			if (component && this.ctx.editorContainer.children[0] !== component) return;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const created = create(done);
		component = created.component;
		const displaced = this.ctx.editorContainer.children[0];
		if (displaced && displaced !== this.ctx.editor && displaced !== created.component) displaced.dispose?.();
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(created.component);
		this.ctx.ui.setFocus(created.focus);
		this.ctx.ui.requestRender();
	}

	#editorAreaIsIdle(): boolean {
		return this.ctx.editorContainer.children[0] === this.ctx.editor;
	}

	async #reopenConnectIfIdle(): Promise<void> {
		if (this.#editorAreaIsIdle()) await this.showConnectSelector();
	}

	#safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
		let message = error instanceof Error ? error.message : String(error);
		for (const secret of secrets) {
			if (secret) message = message.replaceAll(secret, "[redacted]");
		}
		return sanitizeStatusText(message) || "Unknown error";
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			// Fullscreen settings editor on the alternate screen: the overlay
			// enables mouse tracking (click/hover/wheel) for its lifetime and
			// the transcript stays untouched underneath.
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						// Update status line with preview settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							...previewSettings,
						});
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// Return the rendered status line for inline preview
						const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						return this.ctx.statusLine.getTopBorder(availableWidth).content;
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSlashCommandState();
						await this.ctx.session.refreshSshTool({ activateIfAvailable: true });
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						// Restore status line to saved settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
						});
						this.ctx.ui.requestRender();
					},
				},
			);
			overlayHandle = this.ctx.ui.showOverlay(selector, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
		});
	}

	showAdvisorConfigure(): void {
		const cwd = this.ctx.sessionManager.getCwd();
		const agentDir = getAgentDir() ?? getProjectDir();
		const initialScope: AdvisorConfigScope = "project";
		void (async () => {
			// "Project" scope edits the repo-root WATCHDOG.yml (the project-level file
			// discovery walks), not the launch subdir — `getProjectDir()` is only cwd.
			let projectDir = cwd;
			try {
				projectDir = (await repo.root(cwd)) ?? cwd;
			} catch {
				projectDir = cwd;
			}
			const dirs = { projectDir, agentDir };
			const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));
			// Fullscreen editor on the alternate screen (the /settings idiom): the
			// overlay holds the alt buffer + mouse tracking; the transcript stays put.
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			// Label the seeded implicit-default row with the actual advisor-role model
			// (NOT the first live advisor, which may be a named advisor from another scope).
			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const overlay = new AdvisorConfigOverlayComponent(this.ctx.ui, deps, initialScope, initialDoc, {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
					// Re-discover the merged roster (project + user) so the live advisors
					// reflect cross-level precedence, not just the edited file.
					const discovered = await discoverAdvisorConfigs(cwd, agentDir);
					const count = this.ctx.session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
					this.ctx.statusLine.invalidate();
					this.ctx.showStatus(
						count > 0
							? `Saved ${scope} WATCHDOG.yml — ${count} advisor${count === 1 ? "" : "s"} active.`
							: `Saved ${scope} WATCHDOG.yml. Run /advisor on to activate the configured advisors.`,
					);
					this.ctx.ui.requestRender();
				},
				close: done,
				requestRender: () => this.ctx.ui.requestRender(),
				notify: message => this.ctx.showStatus(message),
			});
			overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern,
		});
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			case "personality":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply personality: ${err}`);
				});
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}
				// Full clear + replay so blocks frozen in committed scrollback on
				// ED3-risk terminals retire their stale snapshots too (see
				// InputController.toggleThinkingBlockVisibility).
				this.ctx.ui.resetDisplay();
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.resetDisplay();
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;

			case "tui.renderMermaid":
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`Failed to apply Mermaid rendering setting: ${err}`);
				});
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "git.enabled":
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					sessionAccent: settings.get("statusLine.sessionAccent"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.image":
				if (isImageProviderPreference(value)) {
					setPreferredImageProvider(value);
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	/**
	 * Session model picker (default `/model`, Alt+M, `/switch`).
	 * Enter selects the model for this session only and closes.
	 */
	showModelSelector(options?: {
		temporaryOnly?: boolean;
		roleMode?: boolean;
		providerFilter?: string;
		directSelect?: boolean;
		hideProviderTabs?: boolean;
		pickerHint?: string;
		onCancel?: () => void;
		terminalColumns?: number;
	}): void {
		// Only auto-route to /connect when the session can report available models
		// and the list is empty. Test harnesses and role mode skip this gate.
		if (!options?.roleMode && typeof this.ctx.session.getAvailableModels === "function") {
			const available = this.ctx.session.getAvailableModels();
			if (available.length === 0) {
				if (this.ctx.session.modelRegistry.getAvailable().length > 0) {
					this.ctx.showWarning("No models match the current --models or enabled-model scope.");
					return;
				}
				this.ctx.showStatus("No models available. Connect a provider first.");
				void this.showConnectSelector();
				return;
			}
		}

		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const roleMode = options?.roleMode === true;
		const sessionSelect = !roleMode;
		this.showSelector(done => {
			const selector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async (model, role, thinkingLevel, selectorValue, action) => {
					// `auto` is session-global: never baked into a per-role model value
					// (it can't round-trip through `model:<level>`). Apply it to the session
					// separately and persist via `defaultThinkingLevel`.
					const isAuto = thinkingLevel === AUTO_THINKING;
					const concreteThinking = isAuto ? undefined : thinkingLevel;
					const modelSelector = selectorValue ?? `${model.provider}/${model.id}`;
					try {
						if (action === "retryFallback" && role !== null) {
							const fallbackSelector = formatModelSelectorValue(modelSelector, concreteThinking);
							const fallbackChains = this.ctx.settings.get("retry.fallbackChains");
							const chain = Array.isArray(fallbackChains[role]) ? fallbackChains[role] : [];
							this.ctx.settings.set("retry.fallbackChains", {
								...fallbackChains,
								[role]: [fallbackSelector, ...chain.filter(existing => existing !== fallbackSelector)],
							});
							const roleInfo = getRoleInfo(role, settings);
							const roleLabel = roleInfo?.name ?? role;
							this.ctx.showStatus(`${roleLabel} fallback model: ${fallbackSelector}`);
							return;
						}
						if (role === null) {
							// Session-only: update agent state but don't persist modelRoles
							const previousConfigured = this.ctx.session.configuredThinkingLevel();
							const previousConcrete = this.ctx.session.thinkingLevel;
							await this.ctx.session.setModelTemporary(model, thinkingLevel);
							const effortNote =
								thinkingLevel === undefined
									? this.#applySessionEffortAfterModelChange(model, previousConfigured, previousConcrete)
									: undefined;
							const configured = this.ctx.session.configuredThinkingLevel();
							const effortLabel = configured ? getConfiguredThinkingLevelMetadata(configured).label : undefined;
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							const effortPart = effortLabel ? ` · effort ${effortLabel}` : "";
							const notePart = effortNote ? ` · ${effortNote}` : "";
							this.ctx.showStatus(
								`Model: ${modelSelector}${effortPart}${notePart}. /effort or Shift+Tab to change. Roles: /model roles.`,
							);
							done();
							this.ctx.ui.requestRender();
						} else if (role === "default") {
							const { switched } = await this.ctx.session.setModel(model, role, {
								selector: selectorValue,
								thinkingLevel: concreteThinking,
								persist: true,
								currentContextTokens,
							});
							if (isAuto) {
								if (switched) {
									this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
								} else {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else if (switched && concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
								this.ctx.session.setThinkingLevel(concreteThinking);
							}
							if (switched) {
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`Default model: ${modelSelector}`);
							// Don't call done() - selector stays open for role assignment
						} else {
							// Other roles (smol, slow): just update settings, not current model
							this.ctx.settings.setModelRole(
								role,
								formatModelSelectorValue(selectorValue ?? `${model.provider}/${model.id}`, concreteThinking),
							);
							if (isAuto) {
								this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
							}
							const roleInfo = getRoleInfo(role, settings);
							const roleLabel = roleInfo?.name ?? role;
							this.ctx.showStatus(`${roleLabel} model: ${modelSelector}`);
							// Don't call done() - selector stays open
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					options?.onCancel?.();
					this.ctx.ui.requestRender();
				},
				{
					temporaryOnly: sessionSelect || options?.temporaryOnly === true,
					directSelect: sessionSelect || options?.directSelect === true,
					hideProviderTabs: sessionSelect || options?.hideProviderTabs === true,
					providerFilter: options?.providerFilter,
					pickerHint: options?.pickerHint,
					currentContextTokens,
					terminalColumns: options?.terminalColumns,
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Expert role assignment picker (`/model roles`). Keeps the legacy
	 * model → role → thinking flow and can persist modelRoles.
	 */
	showModelRoleSelector(): void {
		this.showModelSelector({ roleMode: true });
	}

	/**
	 * Unified provider connect surface (`/connect`).
	 */
	async showConnectSelector(): Promise<void> {
		const registry = this.ctx.session.modelRegistry;
		const authStorage = registry.authStorage;
		const rows = buildConnectProviderRows(authStorage, registry);
		this.showSelector(done => {
			const selector = new ConnectSelectorComponent(
				rows,
				action => {
					done();
					void this.#handleConnectAction(action);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				{ terminalColumns: process.stdout.columns ?? 80 },
			);
			return { component: selector, focus: selector };
		});
	}

	#applySessionEffortAfterModelChange(
		model: Model,
		previousConfigured: ConfiguredThinkingLevel | undefined,
		previousConcrete: ThinkingLevel | undefined,
	): string | undefined {
		// setModelTemporary already reapplied default/clamp. If the previous
		// concrete effort is unsupported, surface a non-blocking Auto note.
		if (previousConfigured === AUTO_THINKING) {
			this.ctx.session.setThinkingLevel(AUTO_THINKING);
			return undefined;
		}
		if (previousConcrete === ThinkingLevel.Off) {
			this.ctx.session.setThinkingLevel(ThinkingLevel.Off);
			return undefined;
		}
		if (!model.reasoning) {
			if (previousConcrete && previousConcrete !== ThinkingLevel.Inherit) {
				this.ctx.session.setThinkingLevel(AUTO_THINKING);
				return "thinking reset to Auto (model has no controllable effort)";
			}
			return undefined;
		}
		const supported = getSupportedEfforts(model);
		if (previousConcrete && previousConcrete !== ThinkingLevel.Inherit && supported.includes(previousConcrete)) {
			this.ctx.session.setThinkingLevel(previousConcrete);
			return undefined;
		}
		if (previousConcrete && previousConcrete !== ThinkingLevel.Inherit && !supported.includes(previousConcrete)) {
			this.ctx.session.setThinkingLevel(AUTO_THINKING);
			return "thinking reset to Auto (previous effort unsupported)";
		}
		return undefined;
	}

	async #handleConnectAction(action: ConnectSelectAction): Promise<void> {
		if (action.type === "openModels") {
			this.#showConnectedProviderModels(action.providerId, `Models for ${action.providerId}`);
			return;
		}
		if (action.type === "refresh") {
			await this.#finishProviderConnection(action.providerId, `Refreshed ${action.providerId}`);
			return;
		}
		if (action.type === "manage") {
			await this.#handleManageProvider(action);
			return;
		}
		if (action.type === "configureExternally") {
			this.ctx.showWarning(`${action.providerId} uses external environment or platform credentials.`);
			await this.#reopenConnectIfIdle();
			return;
		}
		if (action.type === "addCustom") {
			await this.#handleAddCustomProvider();
			return;
		}
		const selectedKind = await this.#chooseProviderConnectionKind(action);
		if (!selectedKind) {
			await this.#reopenConnectIfIdle();
			return;
		}
		let connected = false;
		if (selectedKind === "login") {
			connected = await this.#handleOAuthLogin(action.authProviderId, action.providerId);
		} else if (selectedKind === "api_key" || selectedKind === "custom") {
			connected = await this.#handleApiKeyConnect(action.providerId);
		} else if (selectedKind === "keyless") {
			connected = true;
		}
		if (!connected) {
			await this.#reopenConnectIfIdle();
			return;
		}
		await this.#finishProviderConnection(action.providerId, `Connected ${action.providerId}`);
	}

	async #chooseProviderConnectionKind(
		action: Extract<ConnectSelectAction, { type: "connect" | "manage" }>,
	): Promise<ConnectProviderKind | undefined> {
		if (action.kind === "keyless" && action.supportsLogin) return "login";
		if (action.kind !== "login" || !action.allowManualApiKey) return action.kind;
		const signIn = "Sign in (recommended)";
		const apiKey = "Enter API key";
		const selected = await this.ctx.showHookSelector(`Connect ${action.providerId}`, [
			{ label: signIn, description: "Use the provider login flow" },
			{ label: apiKey, description: "Store a validated API key in AuthStorage" },
		]);
		if (selected === signIn) return "login";
		if (selected === apiKey) return "api_key";
		return undefined;
	}

	async #finishProviderConnection(providerId: string, label: string): Promise<void> {
		try {
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
		} catch (error) {
			this.ctx.showError(`Could not refresh ${providerId}: ${this.#safeErrorMessage(error)}`);
			await this.#reopenConnectIfIdle();
			return;
		}
		const registryModels = this.ctx.session.modelRegistry
			.getAvailable()
			.filter(model => model.provider === providerId);
		if (registryModels.length === 0) {
			this.ctx.showWarning(`${providerId} has no available models. Check its endpoint and credentials.`);
			await this.#reopenConnectIfIdle();
			return;
		}
		const sessionModels = this.ctx.session.getAvailableModels().filter(model => model.provider === providerId);
		if (sessionModels.length === 0) {
			this.ctx.showWarning(`${providerId} is connected, but its models are excluded by the current model scope.`);
			await this.#reopenConnectIfIdle();
			return;
		}
		this.#showConnectedProviderModels(providerId, label);
	}

	async #handleManageProvider(action: Extract<ConnectSelectAction, { type: "manage" }>): Promise<void> {
		const viewModels = "View models";
		const verify = "Verify connection";
		const reconnect = "Reconnect / add credential";
		const removeCredential = "Remove stored credential";
		const removeProvider = "Remove provider configuration";
		const back = "Back";
		const storedCredentials = this.ctx.session.modelRegistry.authStorage.listStoredCredentials(action.providerId);
		const options = [
			...(action.modelCount > 0
				? [{ label: viewModels, description: `${action.modelCount} available models` }]
				: []),
			...(action.verifiable ? [{ label: verify, description: "Validate positive live model discovery" }] : []),
			...(action.supportsLogin || action.kind === "api_key" || action.kind === "custom"
				? [{ label: reconnect, description: "Keep existing accounts and add refreshed credentials" }]
				: []),
			...(action.removableConfig
				? [{ label: removeProvider, description: "Remove models.yml entry and stored credentials" }]
				: storedCredentials.length > 0
					? [{ label: removeCredential, description: `${storedCredentials.length} stored credential(s)` }]
					: []),
			back,
		];
		const selected = await this.ctx.showHookSelector(`Manage ${action.providerId}`, options);
		if (selected === viewModels) {
			if (!this.ctx.session.getAvailableModels().some(model => model.provider === action.providerId)) {
				this.ctx.showWarning(
					`${action.providerId} is connected, but its models are excluded by the current model scope.`,
				);
				await this.#reopenConnectIfIdle();
				return;
			}
			this.#showConnectedProviderModels(action.providerId, `Models for ${action.providerId}`);
			return;
		}
		if (selected === verify) {
			try {
				const count = await this.ctx.session.modelRegistry.validateProviderConnection(action.providerId);
				await this.ctx.session.modelRegistry.refreshProvider(action.providerId, "online");
				this.ctx.showStatus(`${action.providerId} verified · ${count} models`);
			} catch (error) {
				this.ctx.showError(`Could not verify ${action.providerId}: ${this.#safeErrorMessage(error)}`);
			}
			await this.#reopenConnectIfIdle();
			return;
		}
		if (selected === reconnect) {
			const kind = await this.#chooseProviderConnectionKind(action);
			if (!kind) {
				await this.#reopenConnectIfIdle();
				return;
			}
			const connected =
				kind === "login"
					? await this.#handleOAuthLogin(action.authProviderId, action.providerId)
					: await this.#handleApiKeyConnect(action.providerId);
			if (connected) await this.#finishProviderConnection(action.providerId, `Reconnected ${action.providerId}`);
			else await this.#reopenConnectIfIdle();
			return;
		}
		if (selected === removeProvider) {
			await this.#handleCustomProviderRemoval(action.providerId);
			return;
		}
		if (selected === removeCredential) {
			await this.#handleConnectCredentialRemoval(action.providerId);
			return;
		}
		await this.#reopenConnectIfIdle();
	}

	async #handleConnectCredentialRemoval(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			this.ctx.showWarning(`${providerId} has no removable stored credentials.`);
			await this.#reopenConnectIfIdle();
			return;
		}
		const options = accounts.map((account, index) => ({
			label: `${index + 1}. ${account.label}`,
			description: account.detail,
		}));
		const selected = await this.ctx.showHookSelector(`Remove ${providerId} credential`, options);
		const index = selected ? Number.parseInt(selected.split(".", 1)[0] ?? "", 10) - 1 : -1;
		const account = accounts[index];
		if (!account) {
			await this.#reopenConnectIfIdle();
			return;
		}
		const confirmed = await this.ctx.showHookConfirm(
			"Remove credential",
			`Remove ${account.label} from ${providerId}?`,
		);
		if (confirmed) await this.#handleCredentialLogout(providerId, account);
		await this.#reopenConnectIfIdle();
	}

	async #handleCustomProviderRemoval(providerId: string): Promise<void> {
		const confirmed = await this.ctx.showHookConfirm(
			"Remove provider",
			`Remove ${providerId} from models.yml and delete its stored credentials?`,
		);
		if (!confirmed) {
			await this.#reopenConnectIfIdle();
			return;
		}
		try {
			const result = await removeCustomProviderConfig(providerId);
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			if (authStorage.listStoredCredentials(providerId).length > 0) await authStorage.remove(providerId);
			await this.ctx.session.modelRegistry.refresh("offline");
			this.ctx.showStatus(`Removed ${providerId} from ${shortenPath(result.path)}.`);
		} catch (error) {
			this.ctx.showError(`Could not remove ${providerId}: ${this.#safeErrorMessage(error)}`);
		}
		await this.#reopenConnectIfIdle();
	}

	#showConnectedProviderModels(providerId: string, label: string): void {
		if (!this.#editorAreaIsIdle()) {
			this.ctx.showStatus(`${label}. Use /model to select it when the current prompt closes.`);
			return;
		}
		this.showModelSelector({
			temporaryOnly: true,
			directSelect: true,
			hideProviderTabs: true,
			providerFilter: providerId,
			pickerHint: `${label} · pick a session model`,
			onCancel: () => void this.#reopenConnectIfIdle(),
		});
	}

	async #handleApiKeyConnect(providerId: string): Promise<boolean> {
		const apiKey = await this.#promptLine(`API key for ${providerId}:`, { secret: true });
		if (apiKey === undefined) {
			this.ctx.showStatus("Provider connection cancelled.");
			return false;
		}
		if (!apiKey.trim()) {
			this.ctx.showWarning("API key cannot be empty.");
			return false;
		}
		const normalizedApiKey = apiKey.trim();
		try {
			await this.ctx.session.modelRegistry.validateProviderApiKey(providerId, normalizedApiKey);
			await this.ctx.session.modelRegistry.authStorage.upsertLoginApiKey(providerId, normalizedApiKey);
			return true;
		} catch (error) {
			this.ctx.showError(`Could not connect ${providerId}: ${this.#safeErrorMessage(error, [normalizedApiKey])}`);
			return false;
		}
	}

	async #handleAddCustomProvider(): Promise<void> {
		const name = await this.#promptLine("Custom provider id (e.g. my-proxy):");
		if (!name?.trim()) {
			this.ctx.showStatus("Custom provider cancelled.");
			await this.#reopenConnectIfIdle();
			return;
		}
		const providerId = name.trim().toLowerCase();
		const baseUrl = await this.#promptLine("Base URL (OpenAI-compatible, e.g. https://host/v1):");
		if (!baseUrl?.trim()) {
			this.ctx.showStatus("Custom provider cancelled.");
			await this.#reopenConnectIfIdle();
			return;
		}
		const apiKey = await this.#promptLine("API key (optional for a keyless endpoint):", { secret: true });
		if (apiKey === undefined) {
			this.ctx.showStatus("Custom provider cancelled.");
			await this.#reopenConnectIfIdle();
			return;
		}
		const normalizedBaseUrl = normalizeOpenAIModelsListBaseUrl(baseUrl.trim());
		const normalizedApiKey = apiKey.trim();
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		if (authStorage.listStoredCredentials(providerId).length > 0) {
			this.ctx.showError(`Custom provider failed: credentials already exist for provider id "${providerId}".`);
			await this.#reopenConnectIfIdle();
			return;
		}
		const providerConfig = {
			name: providerId,
			baseUrl: normalizedBaseUrl,
			api: "openai-completions" as const,
			auth: normalizedApiKey ? ("apiKey" as const) : ("none" as const),
			discovery: { type: "openai-models-list" as const },
		};

		let wroteProviderConfig = false;
		try {
			await validateCustomProviderConfigDestination(providerConfig);
			const discovered = await discoverModelsByProviderType(
				{
					provider: providerId,
					baseUrl: normalizedBaseUrl,
					api: "openai-completions",
					discovery: { type: "openai-models-list" },
				},
				{
					fetch: wrapFetchForExtraCa(fetch),
					getBearerApiKeyResolver: async () => normalizedApiKey || undefined,
				},
			);
			if (discovered.length === 0) {
				throw new Error("the endpoint returned no models");
			}
			const writeResult = await writeCustomProviderConfig(providerConfig);
			wroteProviderConfig = true;
			if (normalizedApiKey) {
				await authStorage.upsertLoginApiKey(providerId, normalizedApiKey);
			}
			await this.ctx.session.modelRegistry.refresh();
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const availableModels = this.ctx.session.modelRegistry
				.getAvailable()
				.filter(model => model.provider === providerId);
			if (availableModels.length === 0) throw new Error("no models loaded into the registry");
			if (!this.ctx.session.getAvailableModels().some(model => model.provider === providerId)) {
				// Config + credentials are valid; scope exclusion is not a setup failure.
				this.ctx.showWarning(`${providerId} is connected, but its models are excluded by the current model scope.`);
				await this.#reopenConnectIfIdle();
				return;
			}
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Custom provider ${providerId} saved to ${shortenPath(writeResult.path)}`,
					),
					1,
					0,
				),
			);
			block.addChild(
				new Text(
					theme.fg(
						"dim",
						normalizedApiKey ? "API key stored in AuthStorage (not models.yml)." : "Keyless endpoint configured.",
					),
					1,
					0,
				),
			);
			this.ctx.present(block);
			this.#showConnectedProviderModels(providerId, `Provider ${providerId}`);
		} catch (error) {
			if (wroteProviderConfig) {
				await this.#rollbackCustomProviderSetup(providerId);
			}
			this.ctx.showError(`Custom provider failed: ${this.#safeErrorMessage(error, [normalizedApiKey])}`);
			await this.#reopenConnectIfIdle();
		}
	}

	/**
	 * Best-effort compensation when a newly written custom provider never becomes
	 * usable (key store or first registry load fails). Leaves no half-written
	 * models.yml entry or login credential behind.
	 */
	async #rollbackCustomProviderSetup(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await removeCustomProviderConfig(providerId);
		} catch {
			// Destination may already be gone or invalid; keep cleaning credentials.
		}
		try {
			if (authStorage.listStoredCredentials(providerId).length > 0) {
				await authStorage.remove(providerId);
			}
		} catch {
			// Ignore credential cleanup failure after the primary error is shown.
		}
		try {
			await this.ctx.session.modelRegistry.refresh("offline");
		} catch {
			// Offline refresh is best-effort during rollback.
		}
	}

	#promptLine(message: string, options?: { secret?: boolean }): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		let input: Input | undefined;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			if (input && this.ctx.editorContainer.children[0] === input) {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.ui.setFocus(this.ctx.editor);
			}
			resolve(value);
		};
		const promptBlock = new TranscriptBlock();
		promptBlock.addChild(new Text(theme.fg("warning", message), 1, 0));
		this.ctx.present(promptBlock);
		input = new Input();
		if (options?.secret) input.setMaskCharacter("*");
		input.onSubmit = () => {
			finish(input.getValue());
		};
		input.onEscape = () => finish(undefined);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(input);
		this.ctx.ui.setFocus(input);
		this.ctx.ui.requestRender();
		return promise;
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("Nothing to copy yet.");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(targets, {
			onPick: target => {
				done();
				if (target.content === undefined) return;
				void copyToClipboard(target.content);
				this.ctx.showStatus(target.copyMessage ?? "Copied to clipboard");
			},
			onCancel: done,
		});

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
		// Always open in current-folder scope; the empty-state hint in SessionList
		// invites the user to Tab into all-projects rather than silently surfacing
		// every project's history when the cwd has nothing to resume. See #3099.
		const historyStorage = this.ctx.historyStorage;
		const historyMatcher = historyStorage ? (query: string) => historyStorage.matchingSessionIds(query) : undefined;
		// Fullscreen session picker on the alternate screen (the /settings idiom):
		// the overlay borrows the alt buffer and enables mouse tracking (wheel
		// scroll + click-to-resume) for its lifetime, leaving the transcript
		// untouched underneath. Anchored top-left at full size so a mouse row maps
		// directly to a rendered line (the overlay paints from screen row 0), and
		// `fillHeight` pads the body so the footer pins to the screen bottom.
		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				done();
				await this.handleResumeSession(session.path);
			},
			() => {
				done();
			},
			() => {
				// Release the alt buffer before teardown: shutdown() awaits flush/save/
				// dispose/drain before stop() leaves the alt screen, so without this the
				// fullscreen picker would freeze on screen for that window on Ctrl+C.
				done();
				void this.ctx.shutdown();
			},
			{
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (err) {
						throw new Error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, {
							cause: err,
						});
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(),
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.ctx.clearTransientSessionUi();

		const previousCwd = this.ctx.sessionManager.getCwd();
		// Switch session via AgentSession (emits hook and tool session events). The
		// SessionManager adopts the resumed session's own cwd when it differs.
		await this.ctx.session.switchSession(sessionPath);
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			// Resumed a session from another project: re-point the process and every
			// cwd-derived cache at it before rendering.
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `Resumed session in ${shortenPath(newCwd)}` : "Resumed session");
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	async #handleOAuthLogin(providerId: string, modelProviderId = providerId): Promise<boolean> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		const abortController = new AbortController();
		const originalOnEscape = this.ctx.editor.onEscape;
		const cancelLogin = () => abortController.abort(new LoginCancelledError());
		this.ctx.editor.onEscape = cancelLogin;
		try {
			await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: abortController.signal,
				validateApiKey: this.ctx.session.modelRegistry.canValidateProviderConnection(modelProviderId)
					? apiKey => this.ctx.session.modelRegistry.validateProviderApiKey(modelProviderId, apiKey)
					: undefined,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					const block = new TranscriptBlock();
					// Full URL first: works from any machine, including SSH boxes
					// where the OMP-hosted `launchUrl` would resolve against the
					// user's local browser and fail.
					block.addChild(new Text(theme.fg("dim", info.url), 1, 0));
					const hyperlink = `\x1b]8;;${info.url}\x07Click here to login\x1b]8;;\x07`;
					block.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
					if (info.launchUrl && info.launchUrl !== info.url) {
						block.addChild(
							new Text(theme.fg("dim", `Local shortcut (this machine only): ${info.launchUrl}`), 1, 0),
						);
					}
					if (info.instructions) {
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
					}
					if (useManualInput) {
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("dim", MANUAL_LOGIN_TIP), 1, 0));
					}
					this.ctx.present(block);
					this.ctx.openInBrowser(info.url);
				},
				onPrompt: async (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => {
					const promptText = prompt.placeholder ? `${prompt.message} (${prompt.placeholder})` : prompt.message;
					const secret = /(?:api\s*key|access\s*token|secret|bearer)/i.test(promptText);
					const value = await this.#promptLine(promptText, { secret });
					if (value === undefined) throw new LoginCancelledError();
					if (!prompt.allowEmpty && !value.trim()) throw new LoginCancelledError("Login input was empty");
					return value;
				},
				onProgress: (message: string) => {
					this.ctx.present(new Text(theme.fg("dim", sanitizeStatusText(message)), 1, 0));
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
			});
			await this.ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`), 1, 0),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${shortenPath(getAgentDbPath())}`), 1, 0));
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (abortController.signal.aborted || error instanceof LoginCancelledError) {
				this.ctx.showStatus("Login cancelled.");
			} else {
				this.ctx.showError(`Login failed: ${this.#safeErrorMessage(error)}`);
			}
			return false;
		} finally {
			if (this.ctx.editor.onEscape === cancelLogin) this.ctx.editor.onEscape = originalOnEscape;
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
		}
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`Logout skipped: ${account.label} is no longer stored for ${providerId}.`);
				return;
			}

			await this.ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} Successfully logged out ${account.label} from ${providerId}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getAgentDbPath()}`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerId} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(
				`Could not load stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
			this.ctx.showError(`Logout skipped: no stored credentials for ${providerId}.${suffix}`);
			return;
		}

		this.showSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				provider?.name ?? providerId,
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
				return;
			}
		}

		this.showSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(`Could not load saved resets: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("No Codex accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.showSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(`Spending 1 saved reset for ${account.label}…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				`Reset failed for ${account.label}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const message = describeRedeemOutcome(outcome, account.label);
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../debug");
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showAgentHub(observers: SessionObserverRegistry, options?: { requireContent?: boolean }): void {
		const hubKeys = [
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		];
		let hub: AgentHubOverlayComponent | undefined;

		// Render the hub inline in the editor slot — the same anchored region
		// every other selector (model, session, tree, the `ask` tool) uses —
		// rather than a floating overlay. A non-fullscreen overlay composited over
		// a live transcript strands a stale copy in native scrollback every time a
		// running subagent's progress grows the frame and scrolls the window; the
		// hub is opened mid-run, so those copies stacked into a wall of duplicate
		// "Agent Hub" frames bleeding the task tree behind them. As an editor-slot
		// component it rides the normal append-only commit path: the transcript
		// commits above it exactly once and the hub repaints in place.
		const done = () => {
			hub?.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};

		hub = new AgentHubOverlayComponent({
			observers,
			hubKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.hubRemote,
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
		});

		const showReadyHub = () => {
			// The double-← gesture passes requireContent so it stays inert when
			// neither live nor persisted subagents are available. Persisted rows now
			// load asynchronously, so defer the gate until that scan has refreshed the
			// hub instead of treating the initial empty table as authoritative.
			if (options?.requireContent && hub.isEmpty) {
				hub.dispose();
				return;
			}

			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(hub);
			this.ctx.ui.setFocus(hub);
			this.ctx.ui.requestRender();
		};

		if (options?.requireContent && hub.isEmpty) {
			void hub.persistedSubagentsReady.then(showReadyHub);
			return;
		}

		showReadyHub();
	}
}
