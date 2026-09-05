import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { Effort, type Model } from "@san/ai";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

describe("issue #775: per-model defaultLevel", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-775-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getOpus() {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5");
		return model;
	}

	function getSonnet() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5");
		return model;
	}

	async function createSession(initialModel: Model, settings: Settings) {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(Effort.Low);
	}

	it("setModel preserves a supported selection instead of adopting the new model default", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();
		const opusWithDefault: Model = {
			...opus,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				defaultLevel: Effort.XHigh,
			},
		};

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opusWithDefault);

		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
	});

	it("setModel preserves current level when model has no defaultLevel", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opus);

		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("uses the new default only when the current effort is unsupported or absent", async () => {
		await createSession(getSonnet(), Settings.isolated());
		const target: Model = {
			...getOpus(),
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium], defaultLevel: Effort.Low },
		};
		session.setThinkingLevel(Effort.XHigh);
		await session.setModel(target);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
		session.setThinkingLevel(undefined);
		await session.setModel(target);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("temporary switches preserve a supported level unless explicitly overridden", async () => {
		await createSession(getSonnet(), Settings.isolated());
		const target: Model = {
			...getOpus(),
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.High },
		};
		await session.setModelTemporary(target);
		expect(session.thinkingLevel).toBe(Effort.Low);
		await session.setModelTemporary(target, Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("preserves explicit off but clears unsupported reasoning on non-reasoning models", async () => {
		await createSession(getSonnet(), Settings.isolated());
		session.setThinkingLevel("off");
		await session.setModel({
			...getOpus(),
			thinking: { mode: "effort", efforts: [Effort.High], defaultLevel: Effort.High },
		});
		expect(session.thinkingLevel).toBe("off");
		expect(session.agent.state.disableReasoning).toBe(true);
		session.setThinkingLevel(Effort.High);
		await session.setModel({ ...getOpus(), reasoning: false, thinking: undefined });
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
	});

	it("notifies when switching models changes auto's provisional effort", async () => {
		await createSession(getSonnet(), Settings.isolated());
		session.setThinkingLevel("auto");
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		const target: Model = {
			...getOpus(),
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium], defaultLevel: Effort.Low },
		};
		await session.setModel(target);
		expect(session.configuredThinkingLevel()).toBe("auto");
		expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
		expect(events.filter(event => event.type === "thinking_level_changed")).toEqual([
			{ type: "thinking_level_changed", thinkingLevel: Effort.Low, configured: "auto" },
		]);
	});
});
