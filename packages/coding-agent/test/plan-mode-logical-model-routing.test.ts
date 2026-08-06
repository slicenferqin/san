import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { ModelRegistry, type ProviderConfigInput } from "@san/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@san/coding-agent/config/settings";
import { InteractiveMode } from "@san/coding-agent/modes/interactive-mode";
import { initTheme } from "@san/coding-agent/modes/theme/theme";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { HistoryStorage } from "@san/coding-agent/session/history-storage";
import { activeModelRouteFromResolution } from "@san/coding-agent/session/model-route-lease";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

function provider(): ProviderConfigInput & { auth: "none" } {
	return {
		baseUrl: "https://plan-routing.example.invalid/v1",
		api: "openai-responses",
		auth: "none",
		models: [
			{
				id: "chat",
				name: "chat",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	};
}

describe("plan mode Logical Model lifecycle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@san-plan-logical-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: { fixture: provider() },
				logicalModels: {
					planning: {
						routes: [{ id: "planning-route", model: "fixture/chat", equivalence: "exact" }],
					},
				},
			}),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const registryError = modelRegistry.getError();
		if (registryError) throw registryError;
		const model = modelRegistry.find("fixture", "chat");
		const initialRoute = activeModelRouteFromResolution(
			modelRegistry.getModelRouteRegistry().resolve("planning"),
			"task",
		);
		if (!model || !initialRoute) throw new Error("Expected plan Logical Model fixture");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({
				"routing.enabled": true,
				modelRoles: { plan: "planning" },
			}),
			modelRegistry,
			initialModelRoute: initialRoute,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.resetInstance();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("establishes the plan lease when the concrete model is unchanged", async () => {
		await mode.handlePlanModeCommand();

		expect(session.activeModelRoute).toMatchObject({
			logicalModelId: "planning",
			routeId: "planning-route",
			role: "plan",
		});
	});

	it("preserves the logical route through a deferred entry switch", async () => {
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);

		await mode.handlePlanModeCommand();
		expect(session.activeModelRoute?.role).toBe("task");

		streaming = false;
		await mode.flushPendingModelSwitch();
		expect(session.activeModelRoute).toMatchObject({
			logicalModelId: "planning",
			routeId: "planning-route",
			role: "plan",
		});
	});

	it("restores the previous logical lease and role on exit", async () => {
		await mode.handlePlanModeCommand();
		expect(session.activeModelRoute?.logicalModelId).toBe("planning");

		await mode.handlePlanModeCommand();

		expect(mode.planModeEnabled).toBe(false);
		expect(session.activeModelRoute).toMatchObject({
			logicalModelId: "planning",
			routeId: "planning-route",
			role: "task",
		});
	});
});
