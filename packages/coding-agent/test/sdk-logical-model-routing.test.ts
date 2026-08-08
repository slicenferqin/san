import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderSessionState } from "@san/ai";
import { createMockModel } from "@san/ai/providers/mock";
import { ModelRegistry, type ProviderConfigInput } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import type { ModelHubComponent } from "@san/coding-agent/modes/components/model-hub";
import type { ModelPickerComponent } from "@san/coding-agent/modes/components/model-picker";
import { SelectorController } from "@san/coding-agent/modes/controllers/selector-controller";
import { RpcV2SessionManager } from "@san/coding-agent/modes/rpc-v2/session-manager";
import { initTheme } from "@san/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import { createAgentSession } from "@san/coding-agent/sdk";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { activeModelRouteFromResolution } from "@san/coding-agent/session/model-route-lease";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

function provider(modelId: string): ProviderConfigInput & { auth: "none" } {
	return {
		baseUrl: "https://routing.example.invalid/v1",
		api: "openai-responses",
		auth: "none",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	};
}

describe("createAgentSession Logical Model startup", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `san-sdk-logical-routing-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					primary: provider("chat"),
					backup: provider("chat"),
					worker: provider("small"),
					"worker-backup": provider("small"),
					final: provider("last"),
				},
				logicalModels: {
					logical: {
						routes: [
							{ id: "primary", model: "primary/chat", priority: 0, equivalence: "exact" },
							{ id: "backup", model: "backup/chat", priority: 10, equivalence: "exact" },
						],
					},
					worker: {
						routes: [
							{ id: "worker", model: "worker/small", priority: 0, equivalence: "exact" },
							{
								id: "worker-backup",
								model: "worker-backup/small",
								priority: 10,
								equivalence: "exact",
							},
						],
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function options(settings: Settings, sessionManager: SessionManager, modelPattern?: string) {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...(modelPattern !== undefined && { modelPattern }),
		};
	}

	function suppressLogicalRoutes(): void {
		const until = Date.now() + 60_000;
		modelRegistry.suppressSelector("primary/chat", until);
		modelRegistry.suppressSelector("backup/chat", until);
	}

	test("modelRoles.default starts a route lease and persists logical intent", async () => {
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));

		try {
			expect(session.model?.provider).toBe("primary");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "primary",
				role: "default",
			});
			const context = sessionManager.buildSessionContext();
			expect(context.logicalModels).toEqual({ default: "logical" });
			expect(context.modelRoutes).toEqual({ logical: "primary" });
		} finally {
			await session.dispose();
		}
	});

	test("an explicit logical modelPattern retains its route lease", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, modelFallbackMessage } = await createAgentSession(options(settings, sessionManager, "logical"));

		try {
			expect(modelFallbackMessage).toBeUndefined();
			expect(session.model?.provider).toBe("primary");
			expect(session.activeModelRoute?.logicalModelId).toBe("logical");
			expect(sessionManager.buildSessionContext().logicalModels.default).toBe("logical");
		} finally {
			await session.dispose();
		}
	});

	test("rejects a route lease whose concrete model does not match", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		const workerModel = modelRegistry.find("worker", "small");
		const initialModelRoute = activeModelRouteFromResolution(
			modelRegistry.getModelRouteRegistry().resolve("logical"),
			"default",
		);
		if (!workerModel || !initialModelRoute) throw new Error("Expected worker model and logical route fixture");

		await expect(
			createAgentSession({
				...options(settings, sessionManager),
				model: workerModel,
				initialModelRoute,
			}),
		).rejects.toThrow('initialModelRoute "logical/primary" selects "primary/chat", but model is "worker/small"');
	});

	test("fails when a configured logical default keeps no eligible route after extension refresh", async () => {
		const staleModelsPath = path.join(tempDir, "stale-models.json");
		await Bun.write(
			staleModelsPath,
			JSON.stringify({
				providers: { primary: provider("chat") },
				logicalModels: {
					logical: {
						routes: [{ id: "runtime", model: "runtime/chat", equivalence: "exact" }],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, staleModelsPath);
		authStorage.setRuntimeApiKey("runtime", "test-key");
		modelRegistry.registerProvider("runtime", provider("chat"), "ext://old");
		expect(modelRegistry.find("runtime", "chat")).toBeDefined();
		expect(modelRegistry.getModelRouteRegistry().resolve("logical")?.route?.model.provider).toBe("runtime");

		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, modelFallbackMessage } = await createAgentSession(options(settings, sessionManager));

		try {
			expect(modelRegistry.find("runtime", "chat")).toBeUndefined();
			expect(session.model).toBeUndefined();
			expect(session.activeModelRoute).toBeUndefined();
			expect(modelFallbackMessage).toContain('No eligible route for logical model "logical"');
		} finally {
			await session.dispose();
		}
	});

	test("does not replace an ineligible configured logical default with an arbitrary concrete model", async () => {
		suppressLogicalRoutes();
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, modelFallbackMessage } = await createAgentSession(options(settings, sessionManager));

		try {
			expect(session.model).toBeUndefined();
			expect(session.activeModelRoute).toBeUndefined();
			expect(modelFallbackMessage).toContain('No eligible route for logical model "logical"');
			expect(modelFallbackMessage).toContain("suppressed");
		} finally {
			await session.dispose();
		}
	});

	test("does not restore the saved concrete route when persisted logical intent is known but ineligible", async () => {
		suppressLogicalRoutes();
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "backup",
		});

		const { session, modelFallbackMessage } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.model).toBeUndefined();
			expect(session.activeModelRoute).toBeUndefined();
			expect(modelFallbackMessage).toContain('No eligible route for logical model "logical"');
		} finally {
			await session.dispose();
		}
	});

	test("restores the saved concrete model when persisted logical intent no longer exists", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "retired-logical",
			routeId: "retired-route",
		});

		const { session, modelFallbackMessage } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.model).toMatchObject({ provider: "backup", id: "chat" });
			expect(session.activeModelRoute).toBeUndefined();
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("continues to the next explicit candidate after an ineligible logical model", async () => {
		suppressLogicalRoutes();
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session, modelFallbackMessage } = await createAgentSession(
			options(settings, sessionManager, "logical,worker/small"),
		);

		try {
			expect(session.model).toMatchObject({ provider: "worker", id: "small" });
			expect(session.activeModelRoute).toBeUndefined();
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resume honors the saved healthy route as session affinity", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "backup",
		});

		const { session } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.model?.provider).toBe("backup");
			expect(session.activeModelRoute?.routeId).toBe("backup");
		} finally {
			await session.dispose();
		}
	});

	test("resume treats persisted logical metadata as concrete when routing is disabled", async () => {
		const settings = Settings.isolated({ "routing.enabled": false });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "backup",
		});

		const { session } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.model?.provider).toBe("backup");
			expect(session.activeModelRoute).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resume recovers a removed route without losing logical intent", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "removed",
		});

		const { session } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.model?.provider).toBe("primary");
			expect(session.activeModelRoute?.routeId).toBe("primary");
			expect(sessionManager.buildSessionContext().modelRoutes.logical).toBe("primary");
			expect(sessionManager.getBranch().findLast(entry => entry.type === "model_route_change")).toMatchObject({
				logicalModel: "logical",
				fromRoute: "removed",
				toRoute: "primary",
				reason: "recovery",
			});
		} finally {
			await session.dispose();
		}
	});

	test("switchSession restores the target logical route lease", async () => {
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sourceManager = SessionManager.create(tempDir, path.join(tempDir, "source-sessions"));
		const targetManager = SessionManager.create(tempDir, path.join(tempDir, "target-sessions"));
		targetManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "backup",
		});
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target session file");
		await targetManager.close();

		const { session } = await createAgentSession(options(settings, sourceManager));
		try {
			expect(await session.switchSession(targetFile)).toBe(true);
			expect(session.model?.provider).toBe("backup");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "backup",
				role: "default",
			});
		} finally {
			await session.dispose();
		}
	});

	test("role cycling keeps logical route metadata", async () => {
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical", smol: "worker" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));

		try {
			const result = await session.cycleRoleModels(["default", "smol"]);
			expect(result?.role).toBe("smol");
			expect(session.model?.provider).toBe("worker");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "worker",
				routeId: "worker",
				role: "smol",
			});
			expect(sessionManager.buildSessionContext().logicalModels.smol).toBe("worker");
		} finally {
			await session.dispose();
		}
	});

	test("/models selecting a logical row keeps the live route lease", async () => {
		await initTheme();
		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager, "primary/chat"));
		let hub: ModelHubComponent | undefined;
		const routeSelected = Promise.withResolvers<void>();
		const selectLogicalModel = session.selectLogicalModel.bind(session);
		vi.spyOn(session, "selectLogicalModel").mockImplementation(async (...args) => {
			const result = await selectLogicalModel(...args);
			routeSelected.resolve();
			return result;
		});
		const controller = new SelectorController({
			session,
			settings,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: {
				showOverlay: vi.fn(component => {
					hub = component as ModelHubComponent;
					return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { rows: 40 },
			},
		} as unknown as InteractiveModeContext);

		try {
			controller.showModelRoleSelector();
			if (!hub) throw new Error("Expected /models to open the model hub");
			hub.handleInput("\x1b[A");
			hub.handleInput("\n");
			hub.handleInput("\n");
			await routeSelected.promise;

			expect(settings.getModelRole("default")).toBe("logical");
			expect(session.model?.provider).toBe("primary");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "primary",
				role: "default",
			});
		} finally {
			hub?.dispose();
			await session.dispose();
		}
	});

	test("RPC v2 snapshot projects logical intent and the active route", async () => {
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "rpc-sessions"));
		const { session } = await createAgentSession(options(settings, sessionManager));
		const rpcManager = new RpcV2SessionManager({
			runtimeId: `runtime_${Snowflake.next()}`,
			initialHandle: { session },
		});

		try {
			await rpcManager.create({ cwd: tempDir });
			const snapshot = await rpcManager.buildCurrentSnapshot();

			expect(snapshot.model).toMatchObject({
				provider: "primary",
				modelId: "chat",
				logicalModel: "logical",
				routeId: "primary",
			});
		} finally {
			await rpcManager.close({ abortRunning: true });
			await session.dispose();
		}
	});

	test("cross-model retry fallback does not project the stale logical route", async () => {
		await initTheme();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "backup/chat": ["worker/small"] },
			"routing.enabled": true,
			"routing.routeFallback": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "rpc-fallback-sessions"));
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			if (model.provider === "worker") {
				mock.push({ content: ["Recovered on the cross-model fallback"] });
			} else {
				mock.push({ throw: "HTTP 404: model unavailable on this route" });
			}
			return mock.stream(model, context, streamOptions);
		};

		const rpcManager = new RpcV2SessionManager({
			runtimeId: `runtime_${Snowflake.next()}`,
			initialHandle: { session },
		});
		let picker: ModelPickerComponent | undefined;

		try {
			await session.prompt("Exhaust the logical routes");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["primary/chat", "backup/chat", "worker/small"]);
			expect(session.model).toMatchObject({ provider: "worker", id: "small" });
			expect(session.activeModelRoute).toBeUndefined();

			await rpcManager.create({ cwd: tempDir });
			const snapshot = await rpcManager.buildCurrentSnapshot();
			expect(snapshot.model).toMatchObject({ provider: "worker", modelId: "small" });
			expect(snapshot.model).not.toHaveProperty("logicalModel");
			expect(snapshot.model).not.toHaveProperty("routeId");

			const picked = Promise.withResolvers<"concrete" | "logical">();
			const setModelTemporary = session.setModelTemporary.bind(session);
			vi.spyOn(session, "setModelTemporary").mockImplementation(async (...args) => {
				picked.resolve("concrete");
				return setModelTemporary(...args);
			});
			const selectLogicalModel = session.selectLogicalModel.bind(session);
			vi.spyOn(session, "selectLogicalModel").mockImplementation(async (...args) => {
				picked.resolve("logical");
				return selectLogicalModel(...args);
			});
			const controller = new SelectorController({
				session,
				settings,
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				ui: {
					showOverlay: vi.fn(component => {
						picker = component as ModelPickerComponent;
						return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
					}),
					setFocus: vi.fn(),
					requestRender: vi.fn(),
					terminal: { rows: 40 },
				},
			} as unknown as InteractiveModeContext);
			controller.showModelSelector({ temporaryOnly: true });
			if (!picker) throw new Error("Expected /switch to open the model picker");
			picker.handleInput("\n");

			expect(await picked.promise).toBe("concrete");
			expect(session.setModelTemporary).toHaveBeenCalledWith(
				expect.objectContaining({ provider: "worker", id: "small" }),
				undefined,
			);
		} finally {
			await rpcManager.close({ abortRunning: true });
			await session.dispose();
		}
	});

	test("concrete cross-model fallback restores the original Logical Model lease after cooldown", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "backup/chat": ["worker/small"] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
			"routing.enabled": true,
			"routing.routeFallback": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		let firstTurn = true;
		session.agent.streamFn = (model, context, streamOptions) => {
			const selector = `${model.provider}/${model.id}`;
			requestedModels.push(selector);
			if (firstTurn && model.provider !== "worker") {
				mock.push({ throw: `HTTP 404: ${selector} unavailable retry-after-ms=200` });
			} else {
				mock.push({ content: [`ok:${selector}`] });
			}
			return mock.stream(model, context, streamOptions);
		};
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		try {
			await session.prompt("Fall through the logical group");
			await session.waitForIdle();
			expect(session.model).toMatchObject({ provider: "worker", id: "small" });
			expect(session.activeModelRoute).toBeUndefined();

			firstTurn = false;
			now += 240;
			await session.prompt("Restore the original logical intent");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["primary/chat", "backup/chat", "worker/small", "primary/chat"]);
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "primary",
			});
		} finally {
			await session.dispose();
		}
	});

	test("cross-model retry fallback into a Logical Model retains its own route fallback", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "backup/chat": ["worker"] },
			"routing.enabled": true,
			"routing.routeFallback": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			const selector = `${model.provider}/${model.id}`;
			requestedModels.push(selector);
			if (model.provider === "worker-backup") {
				mock.push({ content: ["Recovered on the nested logical fallback route"] });
			} else {
				mock.push({ throw: `HTTP 404: ${selector} unavailable` });
			}
			return mock.stream(model, context, streamOptions);
		};

		try {
			await session.prompt("Exhaust both logical groups");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["primary/chat", "backup/chat", "worker/small", "worker-backup/small"]);
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "worker",
				routeId: "worker-backup",
			});
		} finally {
			await session.dispose();
		}
	});

	test("exhausts a cross-model Logical Model group before continuing the fallback chain", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "backup/chat": ["worker", "final/last"] },
			"routing.enabled": true,
			"routing.routeFallback": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			const selector = `${model.provider}/${model.id}`;
			requestedModels.push(selector);
			if (model.provider === "final") {
				mock.push({ content: ["Recovered after exhausting the nested logical group"] });
			} else {
				mock.push({ throw: `HTTP 404: ${selector} unavailable` });
			}
			return mock.stream(model, context, streamOptions);
		};

		try {
			await session.prompt("Continue after exhausting the logical fallback candidate");
			await session.waitForIdle();

			expect(requestedModels).toEqual([
				"primary/chat",
				"backup/chat",
				"worker/small",
				"worker-backup/small",
				"final/last",
			]);
			expect(session.model).toMatchObject({ provider: "final", id: "last" });
			expect(session.activeModelRoute).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("cross-model Logical Model fallback skips a route whose real API key lookup fails", async () => {
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) =>
			model.provider === "worker" ? Promise.resolve(undefined) : originalGetApiKey(model, sessionId),
		);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "backup/chat": ["worker"] },
			"routing.enabled": true,
			"routing.routeFallback": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			const selector = `${model.provider}/${model.id}`;
			requestedModels.push(selector);
			if (model.provider === "worker-backup") {
				mock.push({ content: ["Recovered after logical route authentication failover"] });
			} else {
				mock.push({ throw: `HTTP 404: ${selector} unavailable` });
			}
			return mock.stream(model, context, streamOptions);
		};

		try {
			await session.prompt("Skip the unauthenticated route in the fallback group");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["primary/chat", "backup/chat", "worker-backup/small"]);
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "worker",
				routeId: "worker-backup",
			});
		} finally {
			await session.dispose();
		}
	});

	test("config refresh 后下一 prompt 把同 ID 的 stale lease 重绑到新 selector", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		const write = async (selector: string): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: { pa: provider("chat"), pb: provider("chat") },
					logicalModels: {
						logical: { routes: [{ id: "main", model: selector, equivalence: "exact" }] },
					},
				}),
			);
			const future = new Date(Date.now() + 2_000);
			await fs.promises.utimes(modelsPath, future, future);
		};
		await write("pa/chat");
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "rebind-sessions"));
		const { session } = await createAgentSession(options(settings, sessionManager));
		const setModel = session.agent.setModel.bind(session.agent);
		const setModelCalls: string[] = [];
		vi.spyOn(session.agent, "setModel").mockImplementation(model => {
			setModelCalls.push(`${model.provider}/${model.id}`);
			return setModel(model);
		});
		const resolvedEvents: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "model_route_resolved") {
				resolvedEvents.push(event.model);
			}
		});
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			return mock.stream(model, context, streamOptions);
		};

		try {
			expect(session.model?.provider).toBe("pa");
			expect(session.activeModelRoute?.modelSelector).toBe("pa/chat");

			await write("pb/chat");
			await modelRegistry.refresh("offline");
			expect(session.activeModelRoute?.modelSelector).toBe("pa/chat");

			await session.prompt("rebind to the refreshed target");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["pb/chat"]);
			expect(session.model?.provider).toBe("pb");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "main",
				modelSelector: "pb/chat",
				role: "default",
			});
			expect(session.activeModelRoute?.policyVersion).toBe(modelRegistry.getModelRouteRegistry().policyVersion);
			expect(resolvedEvents).toEqual(["pb/chat"]);
			expect(setModelCalls).toEqual(["pb/chat"]);
			expect(sessionManager.getBranch().findLast(entry => entry.type === "model_route_change")).toBeUndefined();
		} finally {
			unsubscribe();
			await session.dispose();
		}
	});

	test("同 ID/同 selector 的无关 policy refresh 只刷新 lease version 不 reset", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		const write = async (): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: { pa: provider("chat") },
					logicalModels: {
						logical: { routes: [{ id: "main", model: "pa/chat", equivalence: "exact" }] },
					},
				}),
			);
			const future = new Date(Date.now() + 2_000);
			await fs.promises.utimes(modelsPath, future, future);
		};
		await write();
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const setModel = session.agent.setModel.bind(session.agent);
		const setModelSpy = vi.spyOn(session.agent, "setModel").mockImplementation(model => setModel(model));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			mock.push({ content: ["still the same target"] });
			return mock.stream(model, context, streamOptions);
		};

		try {
			await write();
			await modelRegistry.refresh("offline");
			await session.prompt("no-op refresh");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["pa/chat"]);
			expect(session.model?.provider).toBe("pa");
			expect(session.activeModelRoute?.modelSelector).toBe("pa/chat");
			expect(session.activeModelRoute?.policyVersion).toBe(modelRegistry.getModelRouteRegistry().policyVersion);
			expect(setModelSpy).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("重绑目标不 eligible 时选择下一条 eligible route，不回旧 A", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		const write = async (mainSelector: string): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: { pa: provider("chat"), pb: provider("chat"), pc: provider("chat") },
					logicalModels: {
						logical: {
							routes: [
								{ id: "main", model: mainSelector, priority: 0, equivalence: "exact" },
								{ id: "backup", model: "pb/chat", priority: 10, equivalence: "exact" },
							],
						},
					},
				}),
			);
			const future = new Date(Date.now() + 2_000);
			await fs.promises.utimes(modelsPath, future, future);
		};
		await write("pa/chat");
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const mock = createMockModel();
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			mock.push({ content: [`ok:${model.provider}/${model.id}`] });
			return mock.stream(model, context, streamOptions);
		};

		try {
			await write("pc/chat");
			await modelRegistry.refresh("offline");
			modelRegistry.suppressSelector("pc/chat", Date.now() + 60_000);

			await session.prompt("fall over the suppressed refreshed target");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["pb/chat"]);
			expect(session.model?.provider).toBe("pb");
			expect(session.activeModelRoute).toMatchObject({
				logicalModelId: "logical",
				routeId: "backup",
				modelSelector: "pb/chat",
			});
		} finally {
			await session.dispose();
		}
	});

	test("billing override 的 effective model 贯穿 hard budget 与 usage 价格", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { primary: provider("chat"), backup: provider("chat") },
				logicalModels: {
					logical: {
						routes: [
							{
								id: "primary",
								model: "primary/chat",
								priority: 0,
								equivalence: "exact",
								billing: { source: "override", input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
							},
							{ id: "backup", model: "backup/chat", priority: 10, equivalence: "exact" },
						],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			...options(settings, sessionManager),
			maxTotalCost: 10,
			maxOutputTokens: 8,
		});
		const mock = createMockModel();
		const requestedModels: string[] = [];
		const streamModelCosts: number[] = [];
		const maxTokens: number[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			streamModelCosts.push(model.cost.output);
			if (streamOptions?.maxTokens !== undefined) maxTokens.push(streamOptions.maxTokens);
			mock.push({ content: ["charged turn"] });
			return mock.stream(model, context, streamOptions);
		};

		try {
			expect(session.activeModelRoute?.routeId).toBe("primary");
			await session.selectLogicalModel("logical");
			expect(session.model?.cost).toEqual({ input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 });
			expect(session.activeModelRoute?.modelSelector).toBe("primary/chat");
			expect(modelRegistry.find("primary", "chat")?.cost.output).toBe(0);
			expect(modelRegistry.find("backup", "chat")?.cost.output).toBe(0);

			await session.prompt("charge the effective price");
			await session.waitForIdle();

			expect(requestedModels).toEqual(["primary/chat"]);
			expect(streamModelCosts).toEqual([2_000_000]);
			expect(maxTokens).toEqual([5]);
		} finally {
			await session.dispose();
		}
	});

	test("startup default logical model 的 billing override 直接生效，hard budget 读 override", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { primary: provider("chat"), backup: provider("chat") },
				logicalModels: {
					logical: {
						routes: [
							{
								id: "primary",
								model: "primary/chat",
								priority: 0,
								equivalence: "exact",
								billing: { source: "override", input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
							},
							{ id: "backup", model: "backup/chat", priority: 10, equivalence: "exact" },
						],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			...options(settings, sessionManager),
			maxTotalCost: 10,
			maxOutputTokens: 8,
		});
		const mock = createMockModel();
		const streamModelCosts: number[] = [];
		const maxTokens: number[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			streamModelCosts.push(model.cost.output);
			if (streamOptions?.maxTokens !== undefined) maxTokens.push(streamOptions.maxTokens);
			mock.push({ content: ["charged turn"] });
			return mock.stream(model, context, streamOptions);
		};

		try {
			// startup 即携带 route-local effective cost，而非 catalog cost。
			expect(session.activeModelRoute?.routeId).toBe("primary");
			expect(session.model?.cost).toEqual({ input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 });
			expect(modelRegistry.find("primary", "chat")?.cost.output).toBe(0);
			expect(modelRegistry.find("backup", "chat")?.cost.output).toBe(0);

			await session.prompt("charge the effective price");
			await session.waitForIdle();

			expect(streamModelCosts).toEqual([2_000_000]);
			// hard budget 按 override 价格计算：10 / 2e6 * 1e6 = 5。
			expect(maxTokens).toEqual([5]);
		} finally {
			await session.dispose();
		}
	});

	test("persisted logical resume 的 billing override 在 startup 恢复路径保持", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { primary: provider("chat"), backup: provider("chat") },
				logicalModels: {
					logical: {
						routes: [
							{ id: "primary", model: "primary/chat", priority: 0, equivalence: "exact" },
							{
								id: "backup",
								model: "backup/chat",
								priority: 10,
								equivalence: "exact",
								billing: { source: "override", input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({ "routing.enabled": true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("backup/chat", "default", {
			logicalModel: "logical",
			routeId: "backup",
		});

		const { session } = await createAgentSession(options(settings, sessionManager));
		try {
			expect(session.activeModelRoute?.routeId).toBe("backup");
			expect(session.model?.cost).toEqual({ input: 0, output: 2_000_000, cacheRead: 0, cacheWrite: 0 });
			expect(modelRegistry.find("backup", "chat")?.cost.output).toBe(0);
		} finally {
			await session.dispose();
		}
	});

	test("同 selector 的 billing refresh 在下一请求边界切换 effective cost，不 reset provider session", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		const write = async (outputPrice: number): Promise<void> => {
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: { pa: provider("chat") },
					logicalModels: {
						logical: {
							routes: [
								{
									id: "main",
									model: "pa/chat",
									equivalence: "exact",
									billing: {
										source: "override",
										input: 0,
										output: outputPrice,
										cacheRead: 0,
										cacheWrite: 0,
									},
								},
							],
						},
					},
				}),
			);
			const future = new Date(Date.now() + 2_000);
			await fs.promises.utimes(modelsPath, future, future);
		};
		await write(1_000_000);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			modelRoles: { default: "logical" },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession(options(settings, sessionManager));
		const setModel = session.agent.setModel.bind(session.agent);
		const setModelSpy = vi.spyOn(session.agent, "setModel").mockImplementation(model => setModel(model));
		const mock = createMockModel();
		const streamModelCosts: number[] = [];
		session.agent.streamFn = (model, context, streamOptions) => {
			streamModelCosts.push(model.cost.output);
			mock.push({ content: ["billing refresh turn"] });
			return mock.stream(model, context, streamOptions);
		};
		const closeSpy = vi.fn();
		session.providerSessionState.set("pa", { close: closeSpy } satisfies ProviderSessionState);

		try {
			expect(session.model?.cost.output).toBe(1_000_000);
			await write(2_000_000);
			await modelRegistry.refresh("offline");

			await session.prompt("charge the refreshed price");
			await session.waitForIdle();

			expect(session.model?.cost.output).toBe(2_000_000);
			expect(session.activeModelRoute?.policyVersion).toBe(modelRegistry.getModelRouteRegistry().policyVersion);
			expect(streamModelCosts).toEqual([2_000_000]);
			// cost-only refresh：setModel 只更新 state.model，不关闭 provider session。
			expect(setModelSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).not.toHaveBeenCalled();
			expect(session.providerSessionState.get("pa")).toBeDefined();
			expect(modelRegistry.find("pa", "chat")?.cost.output).toBe(0);

			// 同 selector 同 billing 的无关 refresh：不再 setModel。
			await write(2_000_000);
			await modelRegistry.refresh("offline");
			await session.prompt("no-op billing refresh");
			await session.waitForIdle();
			expect(setModelSpy).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	});
});
