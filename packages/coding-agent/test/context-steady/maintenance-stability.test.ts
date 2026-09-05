/** Regression coverage for Context Steady maintenance stability. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@san/agent";
import * as compactionModule from "@san/agent/compaction";
import { createMockModel, type MockResponse } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";
import { TURN_DIGEST_CUSTOM_TYPE } from "../../src/context-steady/types";

const readSchema = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
} as const;

function readParams(input: unknown): { path: string } {
	if (input && typeof input === "object" && "path" in input && typeof input.path === "string") {
		return { path: input.path };
	}
	throw new Error("Invalid read params");
}
const readPayload = "large-read-result ".repeat(2400);
const readTool: AgentTool<typeof readSchema, { path: string }> = {
	name: "read",
	label: "Read",
	description: "Read a large file for the maintenance churn reproducer.",
	parameters: readSchema,
	async execute(_toolCallId, params) {
		const { path: inputPath } = readParams(params);
		return { content: [{ type: "text", text: `${inputPath}\n${readPayload}` }] };
	},
};

describe("Context Steady maintenance stability", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-p3-repro-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		await authStorage?.close();
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	it("does not repeat physical maintenance for one growing logical turn", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 50_000, maxTokens: 2_000 };
		const responses: MockResponse[] = Array.from({ length: 4 }, (_, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `read_${index + 1}`,
					name: "read",
					arguments: { path: `fixture-${index + 1}.txt` },
				},
			],
		}));
		responses.push({ content: ["finished the continuous read task"] });
		const mock = createMockModel({ responses });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `maintenance summary ${preparation.messagesToSummarize.length}`,
			shortSummary: "maintenance summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["P3 maintenance reproducer"], tools: [readTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"san.contextSteady.enabled": true,
				"san.contextSteady.activationThresholdTokens": 0,
				"san.contextSteady.digest.enabled": false,
				"san.contextSteady.qualityWindowTokens": 8_000,
				"san.contextSteady.burstWindowTokens": 12_000,
				"san.contextSteady.reserveRatio": 0.2,
				"san.contextSteady.contextPlan.enabled": false,
				"san.contextSteady.segment.enabled": false,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 49_000,
				"compaction.keepRecentTokens": 2_000,
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});
		const triggers: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") triggers.push(event.trigger);
		});

		await session.prompt("Read four large files continuously without stopping.");
		await session.waitForIdle();

		expect({ calls: compactSpy.mock.calls.length, triggers }).toEqual({ calls: 1, triggers: ["steady_target"] });
	});

	it("keeps twelve duplicate large reads bounded on the production projection path", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 100_000, maxTokens: 2_000 };
		const responses: MockResponse[] = Array.from({ length: 12 }, (_, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `duplicate_read_${index + 1}`,
					name: "read",
					arguments: { path: "same-large-file.txt" },
				},
			],
		}));
		responses.push({ content: ["finished the duplicate read replay"] });
		const mock = createMockModel({ responses });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "unexpected replay compaction",
			shortSummary: "unexpected compaction",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Continuous read production replay"], tools: [readTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "replay-auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "replay-models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"san.contextSteady.enabled": true,
				"san.contextSteady.activationThresholdTokens": 0,
				"san.contextSteady.digest.enabled": false,
				"san.contextSteady.qualityWindowTokens": 60_000,
				"san.contextSteady.burstWindowTokens": 68_000,
				"san.contextSteady.reserveRatio": 0.2,
				"san.contextSteady.contextPlan.enabled": true,
				"san.contextSteady.contextPlan.maxTokens": 3_000,
				"san.contextSteady.contextPlan.recentExactTokens": 0,
				"san.contextSteady.contextPlan.stableProjection": true,
				"san.contextSteady.contextPlan.toolOutputOffload": true,
				"san.contextSteady.contextPlan.toolOutputOffloadMinTokens": 100,
				"san.contextSteady.segment.enabled": false,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 90_000,
				"compaction.keepRecentTokens": 2_000,
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"model.toolCallLoopGuard.enabled": false,
				"model.toolProgressGuard.enabled": false,
			}),
			modelRegistry,
		});

		await session.prompt("Read the same large source twelve times and then finish.");
		await session.waitForIdle();

		const fullBodiesPerRequest = mock.calls.map(
			call => JSON.stringify(call.context.messages).split(readPayload).length - 1,
		);
		const journalBodies = JSON.stringify(sessionManager.getBranch()).split(readPayload).length - 1;
		expect(mock.calls).toHaveLength(13);
		expect(fullBodiesPerRequest.at(-1)).toBeLessThanOrEqual(1);
		expect(Math.max(...fullBodiesPerRequest.slice(2))).toBeLessThanOrEqual(1);
		const planPayloads = mock.calls
			.map(call =>
				JSON.stringify(
					call.context.messages.find(message => JSON.stringify(message).includes("<san_context_plan>")),
				),
			)
			.filter((payload): payload is string => payload !== undefined);
		expect(new Set(planPayloads).size).toBe(1);
		expect(journalBodies).toBe(12);
		expect(compactSpy).not.toHaveBeenCalled();
	});
	it("does not generate a second summary after terminal compaction covers the settled turn", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		const model = { ...bundled, contextWindow: 50_000, maxTokens: 2_000 };
		const mock = createMockModel({
			responses: [
				{ content: ["seed turn complete"] },
				{
					content: ["terminal turn complete"],
					usage: { input: 45_000, output: 20, totalTokens: 45_020 },
				},
			],
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "terminal compaction summary",
			shortSummary: "terminal summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["P3 digest suppression reproducer"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		authStorage = await AuthStorage.create(path.join(tempDir, "digest-auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "digest-models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"san.contextSteady.enabled": true,
				"san.contextSteady.activationThresholdTokens": 0,
				"san.contextSteady.digest.enabled": true,
				"san.contextSteady.digest.persistFallback": true,
				"san.contextSteady.digest.llm.enabled": false,
				"san.contextSteady.qualityWindowTokens": 18_000,
				"san.contextSteady.contextPlan.enabled": false,
				"san.contextSteady.segment.enabled": false,
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 40_000,
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});

		await session.prompt("Seed one prior turn for compaction.");
		await session.waitForIdle();
		const digestCountBefore = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === TURN_DIGEST_CUSTOM_TYPE).length;

		await session.prompt("Finish this turn and compact it once.");
		await session.waitForIdle();
		const digestCountAfter = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === TURN_DIGEST_CUSTOM_TYPE).length;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect({ digestCountBefore, digestCountAfter }).toEqual({ digestCountBefore: 1, digestCountAfter: 1 });
	});
});
