import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@san/agent";
import { z } from "@san/ai";
import { createMockModel } from "@san/ai/providers/mock";
import { kNoAuth, ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { createAgentSession } from "@san/coding-agent/sdk";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { activeModelRouteFromResolution } from "@san/coding-agent/session/model-route-lease";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { AUTO_THINKING } from "@san/coding-agent/thinking";
import { TempDir } from "@san/utils";

const probeToolParameters = z.object({ value: z.string() });
const probeTool: AgentTool<typeof probeToolParameters> = {
	name: "probe",
	label: "Probe",
	description: "Probe the active wire tool transport.",
	parameters: probeToolParameters,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: params.value }],
			details: {},
		};
	},
};

function provider(modelId: string, supportsTools: boolean, input: Array<"text" | "image"> = ["text"]) {
	return {
		baseUrl: "https://routing.example.invalid/v1",
		api: "openai-responses",
		auth: "none",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input,
				supportsTools,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	};
}

describe("Logical Model harness profile", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@logical-harness-profile-");
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					primary: provider("legacy-chat", true),
					backup: provider("gpt-5.6-sol", true),
					"dialect-native": provider("legacy-native", true),
					inband: provider("qwen3-coder-plus", false),
					other: provider("other-chat", true),
					"vision-text": provider("vision-text-chat", true),
					vision: provider("vision-chat", true, ["text", "image"]),
				},
				logicalModels: {
					stable: {
						harnessProfile: "gpt-5.6-sol",
						routes: [
							{ id: "primary", model: "primary/legacy-chat", priority: 0, equivalence: "exact" },
							{ id: "backup", model: "backup/gpt-5.6-sol", priority: 1, equivalence: "compatible" },
						],
					},
					dialect: {
						harnessProfile: "gpt-5.6-sol",
						routes: [
							{
								id: "native",
								model: "dialect-native/legacy-native",
								priority: 0,
								equivalence: "exact",
							},
							{ id: "inband", model: "inband/qwen3-coder-plus", priority: 1, equivalence: "compatible" },
						],
					},
					other: {
						harnessProfile: "claude-opus-4",
						routes: [{ id: "other", model: "other/other-chat", equivalence: "exact" }],
					},
					vision: {
						harnessProfile: "gpt-5.6-sol",
						routes: [
							{ id: "text", model: "vision-text/vision-text-chat", priority: 0, equivalence: "exact" },
							{ id: "vision", model: "vision/vision-chat", priority: 1, equivalence: "exact" },
						],
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const registryError = modelRegistry.getError();
		if (registryError) throw registryError;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		await tempDir.remove();
	});

	test("system guidance follows harnessProfile and remains byte-stable across equivalent routes", async () => {
		const settings = Settings.isolated({ "routing.enabled": true });
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelPattern: "stable",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;

		const initialPrompt = [...session.agent.state.systemPrompt];
		const rendered = initialPrompt.join("\n\n");
		expect(session.model).toMatchObject({ provider: "primary", id: "legacy-chat" });
		expect(session.activeModelRoute?.harnessProfile).toBe("gpt-5.6-sol");
		expect(rendered).toContain("Model: gpt-5.6-sol");
		expect(rendered).toContain(
			"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask",
		);
		expect(rendered).not.toContain("Model: primary/legacy-chat");

		await session.selectLogicalModel("stable", "default", { routeId: "backup" });

		expect(session.model).toMatchObject({ provider: "backup", id: "gpt-5.6-sol" });
		expect(session.activeModelRoute).toMatchObject({
			logicalModelId: "stable",
			harnessProfile: "gpt-5.6-sol",
			routeId: "backup",
		});
		expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
	});

	test("concrete tool dialect still rebuilds prompt transport guidance", async () => {
		const registry = modelRegistry.getModelRouteRegistry();
		const initialResolution = registry.resolve("dialect", { manualRouteId: "native" });
		if (!initialResolution?.route) throw new Error("Expected native route");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: initialResolution.route.model,
				systemPrompt: ["transport:dialect-native/legacy-native"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"routing.enabled": true,
			"tools.format": "auto",
		});
		let rebuildCount = 0;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			initialModelRoute: activeModelRouteFromResolution(initialResolution, "default"),
			toolRegistry: new Map([[probeTool.name, probeTool]]),
			rebuildSystemPrompt: async () => {
				rebuildCount++;
				const model = session?.model;
				return { systemPrompt: [`transport:${model?.provider}/${model?.id}`] };
			},
		});
		await session.selectLogicalModel("dialect", "default", { routeId: "inband" });
		session.agent.setTools([probeTool]);
		const inbandContext = await session.agent.buildSideRequestContext([]);

		expect(session.activeModelRoute?.harnessProfile).toBe("gpt-5.6-sol");
		expect(session.model).toMatchObject({ provider: "inband", id: "qwen3-coder-plus" });
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["transport:inband/qwen3-coder-plus"]);
		expect(inbandContext.tools).toEqual([]);

		await session.selectLogicalModel("dialect", "default", { routeId: "native" });
		const restoredNativeContext = await session.agent.buildSideRequestContext([]);

		expect(restoredNativeContext.tools?.map(tool => tool.name)).toEqual(["probe"]);
		expect(rebuildCount).toBe(2);
	});

	test("prompt auth preflight skips a throwing route and accepts a keyless backup", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false, "routing.enabled": true });
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelPattern: "stable",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;

		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) => {
			if (model.provider === "primary") return Promise.reject(new Error("primary key lookup failed"));
			if (model.provider === "backup") return Promise.resolve(kNoAuth);
			return originalGetApiKey(model, sessionId);
		});
		const mock = createMockModel({ responses: [{ content: ["backup response"] }] });
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			return mock.stream(model, context, options);
		};

		await session.prompt("Use an authenticated logical route");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["backup/gpt-5.6-sol"]);
		expect(session.activeModelRoute).toMatchObject({ logicalModelId: "stable", routeId: "backup" });
	});

	test("historical images keep text-only routes ineligible for a text prompt", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false, "routing.enabled": true });
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelPattern: "vision",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		session.agent.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "Earlier image" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		const mock = createMockModel({ responses: [{ content: ["vision response"] }] });
		const requestedModels: string[] = [];
		session.agent.streamFn = (model, context, options) => {
			requestedModels.push(`${model.provider}/${model.id}`);
			return mock.stream(model, context, options);
		};

		await session.prompt("Continue with text only");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["vision/vision-chat"]);
		expect(session.activeModelRoute).toMatchObject({ logicalModelId: "vision", routeId: "vision" });
	});

	test("failed logical selection restores the previous concrete model and route lease", async () => {
		const registry = modelRegistry.getModelRouteRegistry();
		const initialResolution = registry.resolve("stable", { manualRouteId: "primary" });
		if (!initialResolution?.route) throw new Error("Expected primary route");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: initialResolution.route.model,
				systemPrompt: ["profile:gpt-5.6-sol"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "routing.enabled": true }),
			modelRegistry,
			initialModelRoute: activeModelRouteFromResolution(initialResolution, "default"),
			thinkingLevel: AUTO_THINKING,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => {
				throw new Error("prompt rebuild failed");
			},
		});
		const previousThinking = {
			configured: session.configuredThinkingLevel(),
			effective: session.thinkingLevel,
			isAuto: session.isAutoThinking,
			autoResolved: session.autoResolvedThinkingLevel(),
		};
		const previousBranch = [...sessionManager.getBranch()];
		const routeEvents: string[] = [];
		session.subscribe(event => {
			if (event.type === "model_route_resolved") routeEvents.push(event.routeId);
		});

		await expect(session.selectLogicalModel("other")).rejects.toThrow("prompt rebuild failed");

		expect(session.model).toMatchObject({ provider: "primary", id: "legacy-chat" });
		expect(session.activeModelRoute).toMatchObject({
			logicalModelId: "stable",
			harnessProfile: "gpt-5.6-sol",
			routeId: "primary",
		});
		expect(session.agent.state.systemPrompt).toEqual(["profile:gpt-5.6-sol"]);
		expect({
			configured: session.configuredThinkingLevel(),
			effective: session.thinkingLevel,
			isAuto: session.isAutoThinking,
			autoResolved: session.autoResolvedThinkingLevel(),
		}).toEqual(previousThinking);
		expect(sessionManager.getBranch()).toEqual(previousBranch);
		expect(routeEvents).toEqual([]);
	});

	test("switchSession refreshes a changed profile and fully restores prompt routing state after failure", async () => {
		const registry = modelRegistry.getModelRouteRegistry();
		const initialResolution = registry.resolve("stable", { manualRouteId: "primary" });
		if (!initialResolution?.route) throw new Error("Expected primary route");

		const targetManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "target-sessions"));
		targetManager.appendModelChange("other/other-chat", "default", {
			logicalModel: "other",
			routeId: "other",
		});
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: initialResolution.route.model,
				systemPrompt: ["profile:gpt-5.6-sol"],
				tools: [],
				messages: [],
			},
		});
		let failRebuild = true;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "source-sessions")),
			settings: Settings.isolated({ "compaction.enabled": false, "routing.enabled": true }),
			modelRegistry,
			initialModelRoute: activeModelRouteFromResolution(initialResolution, "default"),
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => {
				if (failRebuild) throw new Error("switch prompt rebuild failed");
				return { systemPrompt: [`profile:${session?.activeModelRoute?.harnessProfile}`] };
			},
		});

		await expect(session.switchSession(targetFile)).rejects.toThrow("switch prompt rebuild failed");
		expect(session.model).toMatchObject({ provider: "primary", id: "legacy-chat" });
		expect(session.activeModelRoute).toMatchObject({ logicalModelId: "stable", routeId: "primary" });
		expect(session.agent.state.systemPrompt).toEqual(["profile:gpt-5.6-sol"]);

		failRebuild = false;
		expect(await session.switchSession(targetFile)).toBe(true);
		expect(session.model).toMatchObject({ provider: "other", id: "other-chat" });
		expect(session.activeModelRoute).toMatchObject({ logicalModelId: "other", harnessProfile: "claude-opus-4" });
		expect(session.agent.state.systemPrompt).toEqual(["profile:claude-opus-4"]);
	});
});
