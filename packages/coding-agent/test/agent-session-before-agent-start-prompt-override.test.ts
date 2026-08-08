import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@san/agent";
import type { Model } from "@san/ai";
import { createMockModel, type MockResponseSource } from "@san/ai/providers/mock";
import { buildModel } from "@san/catalog/build";
import { Settings } from "@san/coding-agent/config/settings";
import type { ExtensionRunner } from "@san/coding-agent/extensibility/extensions";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { convertToLlm } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";

const OVERRIDE = "OVERRIDE-SYSTEM-PROMPT-LIFEOS_ROUTE";
const REBUILT_BASE = "REBUILT-BASE-WITH-TOOL-CATALOG";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession before_agent_start system prompt override", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function createSession(
		responses: MockResponseSource,
		options: { rebuildBeforeProvider?: boolean } = {},
	): { session: AgentSession; systemPrompts: string[][] } {
		const mock = createMockModel({ responses });
		const systemPrompts: string[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(model, context, streamOptions);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => ({ systemPrompt: [OVERRIDE] }),
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: [REBUILT_BASE] }),
		});
		const activeSession = session;
		if (options.rebuildBeforeProvider) {
			const originalPrompt = agent.prompt.bind(agent);
			Object.defineProperty(agent, "prompt", {
				configurable: true,
				value: async (...args: Parameters<Agent["prompt"]>): Promise<void> => {
					await activeSession.refreshBaseSystemPrompt();
					await Reflect.apply(originalPrompt, agent, args);
				},
			});
		}

		return { session, systemPrompts };
	}

	it("keeps the override when a base rebuild fires before the provider request", async () => {
		const result = createSession([{ content: ["Done"] }], { rebuildBeforeProvider: true });

		await result.session.prompt("hello");
		await result.session.waitForIdle();

		expect(result.systemPrompts).toEqual([[OVERRIDE]]);
	});

	it("restores rebuilt base prompt after the turn ends", async () => {
		const result = createSession([{ content: ["Done"] }]);

		await result.session.prompt("hello");
		await result.session.waitForIdle();
		await result.session.refreshBaseSystemPrompt();

		expect(result.session.systemPrompt).toEqual([REBUILT_BASE]);
	});
});
