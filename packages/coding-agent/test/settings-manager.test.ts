import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@san/ai";
import { clearCustomApis } from "@san/ai/api-registry";
import { createMockModel, registerMockApi } from "@san/ai/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "@san/ai/stream";
import type { Context } from "@san/ai/types";
import {
	getDefault,
	getEnumValues,
	onAppendOnlyModeChanged,
	onStatusLineSessionAccentChanged,
	resetSettingsForTest,
	type SettingPath,
	Settings,
} from "@san/coding-agent/config/settings";
import { AgentStorage } from "@san/coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@san/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

describe("Settings", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();

		// Use TempDir for Windows-safe cleanup (retries on EBUSY from SQLite
		// file handle release delays).
		tempDir = TempDir.createSync("@pi-settings-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");

		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(async () => {
		clearCustomApis();
		__providerInFlightForTesting.setRoot(undefined);
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	describe("main config file selection", () => {
		it("loads and updates an existing config.yaml without creating config.yml", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("setupVersion")).toBe(1);

			settings.set("setupVersion", 2);
			await settings.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("clones the selected config.yaml path for persisted settings", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const cloned = await settings.cloneForCwd(tempDir.join("other-project"));

			cloned.set("setupVersion", 2);
			await cloned.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("creates config.yml for new persisted settings when no main config exists", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 1);
			await settings.flush();

			expect(await Bun.file(getConfigPath()).exists()).toBe(true);
			expect(await Bun.file(yamlConfigPath).exists()).toBe(false);
			expect((await readSettings()).setupVersion).toBe(1);
		});
	});

	describe("unknown key tolerance", () => {
		it("loads configs containing unknown keys without failing and keeps known values readable", async () => {
			// Old configs may carry keys that a newer schema no longer knows
			// (or that a future round demotes to constants). Loading must never
			// fail because of them — M1 plan §3.3 migration safety.
			await writeSettings({
				setupVersion: 3,
				totallyUnknownTopLevel: "whatever",
				compaction: { enabled: false, retiredKnob: 42 },
				retired: { nested: { key: true } },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("setupVersion")).toBe(3);
			expect(settings.get("compaction.enabled")).toBe(false);

			// Writing through the live instance keeps working with unknown keys
			// present in the underlying file.
			settings.set("setupVersion", 4);
			await settings.flush();
			expect((await readSettings()).setupVersion).toBe(4);
		});
	});

	describe("defaults", () => {
		it("keeps eight inline images live by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("tui.maxInlineImages")).toBe(8);
		});

		it("keeps native terminal progress disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("terminal.showProgress")).toBe(false);
			expect(getDefault("terminal.showProgress")).toBe(false);
		});

		it("keeps the normal startup splash disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("startup.showSplash")).toBe(false);
			expect(getDefault("startup.showSplash")).toBe(false);
		});

		it("defaults provider in-flight request limits to an empty map", async () => {
			const settings = Settings.isolated();
			expect(settings.get("providers.maxInFlightRequests")).toEqual({});
			expect(getDefault("providers.maxInFlightRequests")).toEqual({});
		});

		it("exposes all tool calling mode options", () => {
			const values = getEnumValues("tools.format");
			expect(values).toEqual([
				"auto",
				"native",
				"glm",
				"hermes",
				"kimi",
				"xml",
				"anthropic",
				"deepseek",
				"harmony",
				"qwen3",
				"gemini",
				"gemma",
				"minimax",
			]);
		});

		it("exposes max and ultra exactly once in the default thinking options", () => {
			const values = getEnumValues("defaultThinkingLevel");
			if (!values) throw new Error("defaultThinkingLevel must expose enum values");
			expect(values).toContain(Effort.Max);
			expect(values).toContain(Effort.Ultra);
			expect(new Set(values).size).toBe(values.length);
		});

		it("keeps logical-model routing opt-in with V1-only policy values", () => {
			const isolated = Settings.isolated();
			expect(isolated.getGroup("routing")).toEqual({
				enabled: false,
				routeFallback: true,
				defaultAffinity: "session",
				diagnostics: "summary",
			});
			expect(getEnumValues("routing.defaultAffinity")).toEqual(["session"]);
			expect(getEnumValues("routing.diagnostics")).toEqual(["summary"]);
		});
	});

	describe("get()", () => {
		it("rejects future routing policies instead of silently treating them as V1 session affinity", () => {
			expect(() => Settings.isolated({ "routing.defaultAffinity": "turn" })).toThrow(
				'routing.defaultAffinity only supports "session" in V1; received "turn"',
			);

			expect(() => Settings.isolated({ "routing.diagnostics": "verbose" })).toThrow(
				'routing.diagnostics only supports "summary" in V1; received "verbose"',
			);
		});

		it("resolves overrides, schema defaults, and falsey values", () => {
			const isolated = Settings.isolated({
				"display.showTokenUsage": false,
				setupVersion: 0,
				shellPath: "",
				enabledModels: [],
			});

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			expect(isolated.get("setupVersion")).toBe(0);
			expect(isolated.get("shellPath")).toBe("");
			expect(isolated.get("enabledModels")).toEqual([]);
			expect(isolated.get("tui.maxInlineImages")).toBe(getDefault("tui.maxInlineImages"));
		});

		it("invalidates cached resolved values after set, override, and clearOverride", () => {
			const isolated = Settings.isolated();

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			isolated.set("display.showTokenUsage", true);
			expect(isolated.get("display.showTokenUsage")).toBe(true);

			isolated.override("display.showTokenUsage", false);
			expect(isolated.get("display.showTokenUsage")).toBe(false);

			isolated.clearOverride("display.showTokenUsage");
			expect(isolated.get("display.showTokenUsage")).toBe(true);
		});

		it("re-resolves path-scoped arrays when cwd changes", async () => {
			const otherDir = path.join(tempDir.toString(), "other-project");
			fs.mkdirSync(otherDir, { recursive: true });

			const settings = await Settings.init({
				cwd: projectDir,
				agentDir,
				inMemory: true,
				overrides: {
					enabledModels: [
						"always-model",
						{ path: projectDir, models: ["project-model"] },
						{ path: otherDir, models: ["other-model"] },
					],
					disabledProviders: [
						"always-provider",
						{ pathPrefix: projectDir, providers: ["project-provider"] },
						{ pathPrefix: otherDir, providers: ["other-provider"] },
					],
				},
			});

			expect(settings.get("enabledModels")).toEqual(["always-model", "project-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "project-provider"]);

			await settings.reloadForCwd(otherDir);

			expect(settings.get("enabledModels")).toEqual(["always-model", "other-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "other-provider"]);
		});

		it("migrates legacy snapcompact system prompt booleans to scoped modes", () => {
			expect(Settings.isolated({ "snapcompact.systemPrompt": true }).get("snapcompact.systemPrompt")).toBe("all");
			const nestedLegacy = { snapcompact: { systemPrompt: false } } as Partial<Record<SettingPath, unknown>>;
			expect(Settings.isolated(nestedLegacy).get("snapcompact.systemPrompt")).toBe("none");
		});

		it("migrates legacy inlineToolDescriptors booleans to the on/off enum", () => {
			expect(Settings.isolated({ inlineToolDescriptors: true }).get("inlineToolDescriptors")).toBe("on");
			expect(Settings.isolated({ inlineToolDescriptors: false }).get("inlineToolDescriptors")).toBe("off");
			expect(Settings.isolated().get("inlineToolDescriptors")).toBe("auto");
		});
	});

	describe("statusLine.sessionAccent hooks", () => {
		it("notifies subscribers only when the effective value changes", () => {
			const isolated = Settings.isolated();
			const values: boolean[] = [];
			const unsubscribe = onStatusLineSessionAccentChanged(() => {
				values.push(isolated.get("statusLine.sessionAccent"));
			});

			try {
				isolated.set("statusLine.sessionAccent", true);
				expect(values).toEqual([]);

				isolated.set("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", true);
				expect(values).toEqual([false, true]);

				isolated.clearOverride("statusLine.sessionAccent");
				expect(values).toEqual([false, true, false]);
			} finally {
				unsubscribe();
			}

			isolated.set("statusLine.sessionAccent", true);
			expect(values).toEqual([false, true, false]);
		});
	});

	describe("provider.appendOnlyContext hooks", () => {
		it("isolates a throwing listener so the rest still receive the value", () => {
			const isolated = Settings.isolated();
			const received: string[] = [];
			const unsubscribeThrower = onAppendOnlyModeChanged(() => {
				throw new Error("boom");
			});
			const unsubscribeOk = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				expect(() => isolated.set("provider.appendOnlyContext", "on")).not.toThrow();
				expect(received).toEqual(["on"]);
			} finally {
				unsubscribeThrower();
				unsubscribeOk();
			}
		});
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("persists native terminal progress only after the user changes it", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(await readSettings()).toEqual({});

			settings.set("terminal.showProgress", true);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.terminal).toEqual({ showProgress: true });
		});

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		});
		it("clears a role when setModelRole receives undefined", () => {
			const settings = Settings.isolated();

			settings.setModelRole("smol", "x/y");
			expect(settings.getModelRole("smol")).toBe("x/y");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});

		it("clears a role from the runtime override layer so the effective view updates immediately", () => {
			const settings = Settings.isolated({
				modelRoles: { smol: "anthropic/claude-haiku-4-5" },
			});

			settings.overrideModelRoles({ smol: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("smol")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});
	});

	describe("getEditVariantForModel", () => {
		it("matches configured model variants case-insensitively", async () => {
			await writeSettings({
				edit: {
					modelVariants: {
						kimi: "hashline",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");
		});

		it("refreshes cached model variants when the active project settings change", async () => {
			const otherProjectDir = tempDir.join("other-project");
			fs.mkdirSync(getProjectAgentDir(otherProjectDir), { recursive: true });

			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { kimi: "hashline" } } }),
			);
			await Bun.write(
				path.join(getProjectAgentDir(otherProjectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { "gpt-5": "apply_patch" } } }),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");

			await settings.reloadForCwd(otherProjectDir);

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBeNull();
			expect(settings.getEditVariantForModel("openai/gpt-5.2-codex")).toBe("apply_patch");
		});
	});

	describe("migrations", () => {
		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("drops the removed title-only tiny model setting", async () => {
			await writeSettings({
				providers: {
					tinyModel: "lfm2-700m",
					tinyModelDevice: "cpu",
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("providers.tinyModelDevice")).toBe("cpu");
			expect(settings.isConfigured("providers.tinyModelDevice")).toBe(true);
			settings.set("setupVersion", 1);
			await settings.flush();
			const saved = await readSettings();
			expect(saved.providers).toEqual({ tinyModelDevice: "cpu" });
		});

		it("drops removed local speech settings from nested and flat forms", async () => {
			await writeSettings({
				stt: { enabled: true, language: "zh", modelName: "parakeet", submitTrigger: "release" },
				speech: { enabled: true, mode: "all", enhanced: true, voice: "af_heart" },
				tts: { localModel: "kokoro", localVoice: "af_heart" },
				speechgen: { enabled: true },
				providers: { tts: "xai", tinyModelDevice: "cpu" },
				"stt.enabled": true,
				"stt.language": "zh",
				"stt.modelName": "parakeet",
				"stt.submitTrigger": "release",
				"speech.enabled": true,
				"speech.mode": "all",
				"speech.enhanced": true,
				"speech.voice": "af_heart",
				"tts.localModel": "kokoro",
				"tts.localVoice": "af_heart",
				"speechgen.enabled": true,
				"providers.tts": "local",
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 1);
			await settings.flush();

			expect(await readSettings()).toEqual({ providers: { tinyModelDevice: "cpu" }, setupVersion: 1 });
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});

		it("migrates the legacy mnemosyne memory backend to mnemopi", async () => {
			await writeSettings({
				memory: { backend: "mnemosyne" },
				mnemosyne: { dbPath: "/tmp/old.db", scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("memory.backend")).toBe("mnemopi");
			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/old.db");
			expect(settings.get("mnemopi.scoping")).toBe("global");
		});

		it("does not clobber an explicit mnemopi block when the legacy mnemosyne block is also present", async () => {
			await writeSettings({
				mnemosyne: { dbPath: "/tmp/old.db" },
				mnemopi: { dbPath: "/tmp/new.db" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/new.db");
		});

		it("migrates boolean task.eager/todo.eager true to always", async () => {
			await writeSettings({
				task: { eager: true },
				todo: { eager: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` reproduced the previous "on" behavior, now `always`.
			expect(settings.get("task.eager")).toBe("always");
			expect(settings.get("todo.eager")).toBe("always");
		});

		it("migrates boolean task.eager/todo.eager false to default", async () => {
			await writeSettings({
				task: { eager: false },
				todo: { eager: false },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Load-bearing direction: consumers treat any non-`default` value as enabled
			// (`false !== "default"`), so an un-coerced boolean `false` would read as ON.
			expect(settings.get("task.eager")).toBe("default");
			expect(settings.get("todo.eager")).toBe("default");
		});

		it("moves legacy lastChangelogVersion out of config.yml into the marker file", async () => {
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Marker seeded from the legacy key.
			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.40.0");

			// Key stripped from config.yml on the next save.
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			const onDisk = await readSettings();
			expect("lastChangelogVersion" in onDisk).toBe(false);
			expect((onDisk.display as Record<string, unknown>).showTokenUsage).toBe(true);
		});

		it("never clobbers an existing marker with the legacy config value", async () => {
			fs.writeFileSync(path.join(agentDir, "last-changelog-version"), "0.41.0");
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			await Settings.init({ cwd: projectDir, agentDir });

			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.41.0");
		});

		it("migrates legacy find and search settings to glob and grep", async () => {
			await writeSettings({
				find: { enabled: false },
				search: {
					enabled: false,
					contextBefore: 2,
					contextAfter: 5,
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("migrates flat legacy find and search settings keys to nested glob and grep", async () => {
			await writeSettings({
				"find.enabled": false,
				"search.enabled": false,
				"search.contextBefore": 2,
				"search.contextAfter": 5,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("does not clobber existing glob/grep settings when migrating legacy find/search ones", async () => {
			await writeSettings({
				find: { enabled: false },
				glob: { enabled: true },
				search: { enabled: false },
				grep: { enabled: true },
				"find.enabled": false,
				"glob.enabled": true,
				"search.enabled": false,
				"grep.enabled": true,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(true);
			expect(settings.get("grep.enabled")).toBe(true);
		});

		it("migrates nested dev.autoqa.consent and todo.reminders.max without enabling parents", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "granted" } },
				todo: { reminders: { max: 5 } },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("granted");
			expect(settings.get("dev.autoqa")).toBe(false);
			expect(settings.isConfigured("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(5);
			expect(settings.get("todo.reminders")).toBe(true);
			expect(settings.isConfigured("todo.reminders")).toBe(false);
		});

		it("migrates quoted dotted legacy keys for consent and reminders max", async () => {
			await Bun.write(getConfigPath(), `"dev.autoqa.consent": denied\n"todo.reminders.max": 2\n`);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("denied");
			expect(settings.get("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(2);
			expect(settings.get("todo.reminders")).toBe(true);
		});

		it("lets explicit new keys win over legacy nested consent/max values", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "denied" }, autoqaConsent: "granted" },
				todo: { reminders: { max: 1 }, remindersMax: 9 },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqaConsent")).toBe("granted");
			expect(settings.get("dev.autoqa")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(9);
			expect(settings.get("todo.reminders")).toBe(true);
		});

		it("preserves recoverable parent booleans alongside legacy leaf keys", async () => {
			await Bun.write(
				getConfigPath(),
				`dev:\n  autoqa: true\n"dev.autoqa.consent": unset\ntodo:\n  reminders: false\n"todo.reminders.max": 4\n`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("dev.autoqa")).toBe(true);
			expect(settings.get("dev.autoqaConsent")).toBe("unset");
			expect(settings.get("todo.reminders")).toBe(false);
			expect(settings.get("todo.remindersMax")).toBe(4);
		});

		it("migrates denied/granted/unset consent values through isolated overrides", () => {
			for (const consent of ["denied", "granted", "unset"] as const) {
				const settings = Settings.isolated({
					"dev.autoqa.consent": consent,
				} as Partial<Record<SettingPath, unknown>>);
				expect(settings.get("dev.autoqaConsent")).toBe(consent);
				expect(settings.get("dev.autoqa")).toBe(false);
			}
		});

		it("persists migrated consent/max keys and drops legacy nested parents on save", async () => {
			await writeSettings({
				dev: { autoqa: { consent: "denied" } },
				todo: { reminders: { max: 1 } },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("dev.autoqaConsent")).toBe("denied");
			expect(settings.get("todo.remindersMax")).toBe(1);

			// Touch an unrelated key so the migrated tree is written back.
			settings.set("display.showTokenUsage", true);
			await settings.flush();

			const onDisk = await readSettings();
			const dev = onDisk.dev as Record<string, unknown>;
			const todo = onDisk.todo as Record<string, unknown>;
			expect(dev.autoqaConsent).toBe("denied");
			expect(dev.autoqa).toBeUndefined();
			expect(todo.remindersMax).toBe(1);
			expect(todo.reminders).toBeUndefined();
			expect(onDisk["dev.autoqa.consent"]).toBeUndefined();
			expect(onDisk["todo.reminders.max"]).toBeUndefined();

			const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(reloaded.get("dev.autoqaConsent")).toBe("denied");
			expect(reloaded.get("dev.autoqa")).toBe(false);
			expect(reloaded.get("todo.remindersMax")).toBe(1);
			expect(reloaded.get("todo.reminders")).toBe(true);
		});

		it("migrates nested tui.scrollbackRebuild=true to tui.resizeScrollback=rebuild", async () => {
			await writeSettings({ tui: { scrollbackRebuild: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.resizeScrollback")).toBe("rebuild");
		});

		it("migrates nested tui.scrollbackRebuild=false to tui.resizeScrollback=preserve", async () => {
			await writeSettings({ tui: { scrollbackRebuild: false } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` gated the destructive erase-and-replay rebuild; `false`
			// kept rows untouched. `append` is new behavior with no legacy
			// equivalent, so the off state maps to `preserve`.
			expect(settings.get("tui.resizeScrollback")).toBe("preserve");
		});

		it("migrates flat tui.scrollbackRebuild to tui.resizeScrollback", async () => {
			await writeSettings({ "tui.scrollbackRebuild": true });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.resizeScrollback")).toBe("rebuild");
		});

		it("lets an explicit nested tui.resizeScrollback win over the legacy boolean", async () => {
			await writeSettings({
				tui: { scrollbackRebuild: true, resizeScrollback: "append" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.resizeScrollback")).toBe("append");
		});

		it("lets an explicit flat tui.resizeScrollback win over the legacy boolean", async () => {
			await writeSettings({
				tui: { scrollbackRebuild: true },
				"tui.resizeScrollback": "preserve",
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tui.resizeScrollback")).toBe("preserve");
		});

		it("drops legacy tui.scrollbackRebuild keys, preserves unrelated tui settings, and reloads cleanly", async () => {
			await writeSettings({
				tui: { tight: true, scrollbackRebuild: false, maxInlineImages: 4 },
				"tui.scrollbackRebuild": true,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("tui.resizeScrollback")).toBe("preserve");
			expect(settings.get("tui.tight")).toBe(true);
			expect(settings.get("tui.maxInlineImages")).toBe(4);

			// Touch an unrelated key so the migrated tree is written back.
			settings.set("display.showTokenUsage", true);
			await settings.flush();

			const onDisk = await readSettings();
			const tui = onDisk.tui as Record<string, unknown>;
			expect(tui.resizeScrollback).toBe("preserve");
			expect(tui.tight).toBe(true);
			expect(tui.maxInlineImages).toBe(4);
			expect(tui.scrollbackRebuild).toBeUndefined();
			expect(onDisk["tui.scrollbackRebuild"]).toBeUndefined();
			expect(onDisk["tui.resizeScrollback"]).toBeUndefined();

			// Idempotent: a reload over the migrated file is unchanged.
			const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			expect(reloaded.get("tui.resizeScrollback")).toBe("preserve");
			expect(reloaded.get("tui.tight")).toBe(true);
			expect(reloaded.get("tui.maxInlineImages")).toBe(4);
		});

		it("migrates legacy booleans and explicit values idempotently through isolated overrides", () => {
			const fromLegacy = Settings.isolated({
				"tui.scrollbackRebuild": true,
			} as Partial<Record<SettingPath, unknown>>);
			expect(fromLegacy.get("tui.resizeScrollback")).toBe("rebuild");

			const alreadyNew = Settings.isolated({ "tui.resizeScrollback": "append" });
			expect(alreadyNew.get("tui.resizeScrollback")).toBe("append");
		});

		it("drops dead BM25-discovery keys and leaves tools.xdev at its default", async () => {
			await writeSettings({
				tools: { discoveryMode: "off", essentialOverride: ["read"] },
				mcp: { discoveryMode: "auto", discoveryDefaultServers: ["gh"] },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// No migration mapping: legacy discovery intent is discarded, xdev
			// keeps its own default. An explicit xdev value is untouched.
			expect(settings.get("tools.xdev")).toBe(true);
			expect(settings.isConfigured("tools.xdev")).toBe(false);
		});

		it("migrates from settings.json containing comments", async () => {
			const jsonPath = path.join(agentDir, "settings.json");
			await fs.promises.writeFile(
				jsonPath,
				`{
					// This is a comment
					"display": {
						/* Multiline comment */
						"showTokenUsage": true
					}
				}`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("display.showTokenUsage")).toBe(true);
			expect(fs.existsSync(jsonPath)).toBe(false);
			expect(fs.existsSync(`${jsonPath}.bak`)).toBe(true);
		});

		it("migrates from legacy .omp sibling settings.json when San config is missing", async () => {
			const sanAgentDir = path.join(tempDir.toString(), ".san", "agent");
			const legacyJsonPath = path.join(tempDir.toString(), ".omp", "agent", "settings.json");
			await fs.promises.mkdir(path.dirname(legacyJsonPath), { recursive: true });
			await fs.promises.writeFile(legacyJsonPath, JSON.stringify({ display: { showTokenUsage: true } }));

			const settings = await Settings.init({ cwd: projectDir, agentDir: sanAgentDir });

			expect(settings.get("display.showTokenUsage")).toBe(true);
			expect(fs.existsSync(legacyJsonPath)).toBe(false);
			expect(fs.existsSync(`${legacyJsonPath}.bak`)).toBe(true);
			expect(fs.existsSync(path.join(sanAgentDir, "config.yml"))).toBe(true);
		});

		it("migrates legacy power booleans with system=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: true,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("migrates legacy power booleans with display=true to display level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: true,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("migrates legacy power booleans with declareUserActive=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: true,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("preserves old idle default when only non-idle keys are set", async () => {
			// Old default was preventIdleSleep=true; user only set display=false.
			// Migration should yield "idle", not "off".
			await writeSettings({
				power: { preventDisplaySleep: false },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("idle");
		});

		it("migrates all-false power booleans to off", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: false,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		it("migrates flat-key power booleans to the enum", async () => {
			await writeSettings({
				"power.preventIdleSleep": true,
				"power.preventDisplaySleep": true,
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("does not overwrite an explicit power.sleepPrevention", async () => {
			await writeSettings({
				power: { sleepPrevention: "off", preventIdleSleep: true },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		describe("provider request limits", () => {
			it("uses the effective merged value when configuring hooks", async () => {
				const settings = Settings.isolated({ "providers.maxInFlightRequests": { openai: 1 } });
				__providerInFlightForTesting.setRoot(tempDir.join("provider-inflight"));
				registerMockApi();
				const firstStarted = Promise.withResolvers<void>();
				const releaseFirst = Promise.withResolvers<void>();
				let active = 0;
				let maxActive = 0;
				let callIndex = 0;
				const mock = createMockModel({
					provider: "openai",
					handler: async () => {
						callIndex++;
						active++;
						maxActive = Math.max(maxActive, active);
						try {
							if (callIndex === 1) {
								firstStarted.resolve();
								await releaseFirst.promise;
							}
							return { content: [`reply ${callIndex}`] };
						} finally {
							active--;
						}
					},
				});

				settings.set("providers.maxInFlightRequests", { openai: 4 });

				const first = streamSimple(mock.model, context());
				const firstResult = first.result();
				await firstStarted.promise;
				const second = streamSimple(mock.model, context());
				await Bun.sleep(20);

				expect(settings.get("providers.maxInFlightRequests")).toEqual({ openai: 1 });
				expect(mock.calls).toHaveLength(1);

				releaseFirst.resolve();
				await Promise.all([firstResult, second.result()]);
				expect(maxActive).toBe(1);
			});

			it("rejects invalid provider limits from config.yml", async () => {
				await writeSettings({ providers: { maxInFlightRequests: { openai: "2" } } });

				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
					"Provider request limits must be positive numbers: openai",
				);
			});

			it("rejects invalid provider limits from project settings", async () => {
				await Bun.write(
					path.join(getProjectAgentDir(projectDir), "settings.json"),
					JSON.stringify({ providers: { maxInFlightRequests: { anthropic: 0 } } }),
				);

				await expect(Settings.init({ cwd: projectDir, agentDir, inMemory: true })).rejects.toThrow(
					"Provider request limits must be positive numbers: anthropic",
				);
			});

			it("rejects invalid provider limits from config overlays", async () => {
				const overlayPath = tempDir.join("overlay.yml");
				await Bun.write(overlayPath, YAML.stringify({ providers: { maxInFlightRequests: { umans: -1 } } }));

				await expect(
					Settings.init({ cwd: projectDir, agentDir, inMemory: true, configFiles: [overlayPath] }),
				).rejects.toThrow("Provider request limits must be positive numbers: umans");
			});

			it("keeps San v0.4 Workflows and isolated writes opt-in", async () => {
				const settings = await Settings.init({ cwd: projectDir, agentDir, inMemory: true });

				expect(settings.get("san.workflows.enabled")).toBe(false);
				expect(settings.get("san.workflows.adHocEnabled")).toBe(false);
				expect(settings.get("san.workflows.allowIsolatedWrite")).toBe(false);
			});

			it("loads the recommended San context steady overlay", async () => {
				const overlayPath = path.resolve(
					import.meta.dir,
					"..",
					"examples",
					"config",
					"san-context-steady-recommended.yml",
				);

				const settings = await Settings.init({
					cwd: projectDir,
					agentDir,
					inMemory: true,
					configFiles: [overlayPath],
				});

				expect(settings.get("san.contextSteady.enabled")).toBe(true);
				expect(settings.get("san.contextSteady.activationThresholdTokens")).toBe(240000);
				expect(settings.get("san.contextSteady.digest.enabled")).toBe(true);
				expect(settings.get("san.contextSteady.digest.persistFallback")).toBe(true);
				expect(settings.get("san.contextSteady.qualityWindowTokens")).toBe(240000);
				expect(settings.get("san.contextSteady.reserveRatio")).toBe(0.25);
				expect(settings.get("san.contextSteady.contextPlan.enabled")).toBe(true);
				expect(settings.get("san.contextSteady.contextPlan.recentDigests")).toBe(5);
				expect(settings.get("san.contextSteady.contextPlan.maxTokens")).toBe(3000);
				expect(settings.get("san.contextSteady.checkpoint.enabled")).toBe(true);
				expect(settings.get("san.contextSteady.checkpoint.everyTurns")).toBe(6);
				expect(settings.get("san.contextSteady.checkpoint.maxTokens")).toBe(12000);
				expect(settings.get("san.contextSteady.recall.enabled")).toBe(false);
				expect(settings.get("san.contextSteady.recall.maxItems")).toBe(3);
				expect(settings.get("san.contextSteady.recall.maxTokens")).toBe(1000);
				expect(settings.get("san.contextSteady.recall.maxQueryChars")).toBe(2000);
			});

			it("loads the recommended San execution loop overlay", async () => {
				const overlayPath = path.resolve(
					import.meta.dir,
					"..",
					"examples",
					"config",
					"san-execution-loop-recommended.yml",
				);

				const settings = await Settings.init({
					cwd: projectDir,
					agentDir,
					inMemory: true,
					configFiles: [overlayPath],
				});

				expect(settings.get("san.contextSteady.enabled")).toBe(true);
				expect(settings.get("san.executionLoop.enabled")).toBe(true);
				expect(settings.get("san.executionLoop.defaultMode")).toBe("team");
				expect(settings.get("san.executionLoop.maxRetries")).toBe(2);
				expect(settings.get("san.executionLoop.maxWorkers")).toBe(3);
				expect(settings.get("san.executionLoop.ledger.enabled")).toBe(true);
				expect(settings.get("san.executionLoop.ledger.persistRolePackets")).toBe(true);
				expect(settings.get("san.executionLoop.checks.enabled")).toBe(true);
				expect(settings.get("san.executionLoop.checks.includeBuiltins")).toBe(true);
				expect(settings.get("san.executionLoop.checks.projectDir")).toBe(".san/checks");
				expect(settings.get("san.executionLoop.roles.commander.modelRole")).toBe("slow");
				expect(settings.get("san.executionLoop.roles.worker.modelRole")).toBe("default");
				expect(settings.get("san.executionLoop.roles.supervisor.modelRole")).toBe("advisor");
				expect(settings.get("san.executionLoop.roles.oracle.modelRole")).toBe("plan");
				expect(settings.get("san.executionLoop.roles.oracle.enabledInModes")).toEqual(["council"]);
				expect(settings.get("san.executionLoop.roleContext.tokenBudget")).toBe(2000);
				expect(settings.get("san.executionLoop.roleContext.maxEvents")).toBe(8);
				expect(settings.get("san.executionLoop.roleContext.maxDecisions")).toBe(8);
				expect(settings.get("san.executionLoop.budget.soloMaxTurns")).toBe(3);
				expect(settings.get("san.executionLoop.budget.teamMaxTurns")).toBe(8);
				expect(settings.get("san.executionLoop.budget.councilMaxTurns")).toBe(16);
				expect(settings.get("san.executionLoop.budget.reserveRatio")).toBe(0.25);
			});
		});
	});
});
