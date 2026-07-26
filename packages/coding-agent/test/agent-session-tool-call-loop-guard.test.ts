import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@san/agent";
import type { AssistantMessage, Context } from "@san/ai";
import { createMockModel } from "@san/ai/providers/mock";
import { AssistantMessageEventStream } from "@san/ai/utils/event-stream";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";
import { type } from "arktype";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("injects a hidden redirect before the next model call", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 5;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 5,
			"model.toolCallLoopGuard.exemptTools": ["hub"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(6);
		expect(JSON.stringify(contexts[5]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[5]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it("forces a no-tool answer after an unchanged A/B evidence cycle ignores the redirect", async () => {
		const responses = Array.from({ length: 8 }, (_, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `cycle-${index + 1}`,
					name: "read",
					arguments: { path: index % 2 === 0 ? "a.log" : "b.log" },
				},
			],
		}));
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-progress-cycle",
			responses: [...responses, { content: ["Concluded from existing evidence."] }],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ path: "string" }),
			execute: async (_toolCallId, params) => {
				const path = typeof params === "object" && params && "path" in params ? String(params.path) : "unknown";
				return { content: [{ type: "text" as const, text: path === "a.log" ? "same A" : "same B" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			getToolChoice: () => session?.nextToolChoiceDirective(),
			initialState: { model: mock, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			"model.toolProgressGuard.enabled": true,
			"model.toolProgressGuard.mode": "hard",
			"model.toolProgressGuard.repeatThreshold": 3,
			"model.toolProgressGuard.saturationWindow": 8,
			"model.toolProgressGuard.saturationMaxResources": 2,
			"model.toolProgressGuard.finalizeAfterNoProgress": 3,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[readTool.name, readTool]]),
		});

		await session.prompt("inspect the two logs");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(9);
		expect(mock.calls.at(-1)?.options?.toolChoice).toBe("none");
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-progress-redirect",
			),
		).toHaveLength(1);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-progress-finalize",
			),
		).toHaveLength(1);
	});

	it("allows repeated observations whose result keeps changing", async () => {
		const responses = Array.from({ length: 12 }, (_, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `changing-${index + 1}`,
					name: "read",
					arguments: { path: "changing.log" },
				},
			],
		}));
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-progress-changing",
			responses: [...responses, { content: ["All changes inspected."] }],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		let resultVersion = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock changing read tool",
			parameters: type({ path: "string" }),
			execute: async () => ({
				content: [{ type: "text" as const, text: `version-${++resultVersion}` }],
			}),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			getToolChoice: () => session?.nextToolChoiceDirective(),
			initialState: { model: mock, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			"model.toolProgressGuard.enabled": true,
			"model.toolProgressGuard.mode": "hard",
			"model.toolProgressGuard.repeatThreshold": 3,
			"model.toolProgressGuard.finalizeAfterNoProgress": 3,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[readTool.name, readTool]]),
		});

		await session.prompt("watch the changing log");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(13);
		expect(mock.calls.every(call => call.options?.toolChoice !== "none")).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType.startsWith("tool-progress-"),
			),
		).toBe(false);
	});

	it("delivers a queued user steer before convergence can force finalization", async () => {
		const responses = Array.from({ length: 6 }, (_, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `steer-cycle-${index + 1}`,
					name: "read",
					arguments: { path: index % 2 === 0 ? "a.log" : "b.log" },
				},
			],
		}));
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-progress-steer",
			responses: [...responses, { content: ["Stopped investigating and returned the conclusion."] }],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		let executionCount = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ path: "string" }),
			execute: async (_toolCallId, params) => {
				executionCount++;
				if (executionCount === 6) await session?.steer("停止调查，直接给结论");
				const path = typeof params === "object" && params && "path" in params ? String(params.path) : "unknown";
				return { content: [{ type: "text" as const, text: path === "a.log" ? "same A" : "same B" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			getToolChoice: () => session?.nextToolChoiceDirective(),
			initialState: { model: mock, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			"model.toolProgressGuard.enabled": true,
			"model.toolProgressGuard.mode": "hard",
			"model.toolProgressGuard.repeatThreshold": 3,
			"model.toolProgressGuard.saturationWindow": 8,
			"model.toolProgressGuard.saturationMaxResources": 2,
			"model.toolProgressGuard.finalizeAfterNoProgress": 3,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[readTool.name, readTool]]),
		});

		await session.prompt("inspect the two logs");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(7);
		expect(mock.calls.at(-1)?.options?.toolChoice).not.toBe("none");
		expect(JSON.stringify(mock.calls.at(-1)?.context.messages)).toContain("停止调查，直接给结论");
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "tool-progress-finalize",
			),
		).toBe(false);
	});

	it("resets pending convergence after a successful mutation", async () => {
		const observationResponses = (start: number, count: number) =>
			Array.from({ length: count }, (_, offset) => {
				const index = start + offset;
				return {
					content: [
						{
							type: "toolCall" as const,
							id: `read-${index}`,
							name: "read",
							arguments: { path: index % 2 === 0 ? "a.log" : "b.log" },
						},
					],
				};
			});
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-progress-mutation",
			responses: [
				...observationResponses(0, 5),
				{
					content: [
						{
							type: "toolCall" as const,
							id: "edit-1",
							name: "edit",
							arguments: { path: "src/fix.ts", oldText: "before", newText: "after" },
						},
					],
				},
				...observationResponses(5, 4),
				{ content: ["Mutation verified from the available evidence."] },
			],
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ path: "string" }),
			execute: async (_toolCallId, params) => {
				const path = typeof params === "object" && params && "path" in params ? String(params.path) : "unknown";
				return { content: [{ type: "text" as const, text: path === "a.log" ? "same A" : "same B" }] };
			},
		};
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Mock edit tool",
			parameters: type({ path: "string", oldText: "string", newText: "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "Updated src/fix.ts" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			getToolChoice: () => session?.nextToolChoiceDirective(),
			initialState: { model: mock, systemPrompt: ["Test"], tools: [readTool, editTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
			"model.toolProgressGuard.enabled": true,
			"model.toolProgressGuard.mode": "hard",
			"model.toolProgressGuard.repeatThreshold": 3,
			"model.toolProgressGuard.saturationWindow": 8,
			"model.toolProgressGuard.saturationMaxResources": 2,
			"model.toolProgressGuard.finalizeAfterNoProgress": 3,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([
				[readTool.name, readTool],
				[editTool.name, editTool],
			]),
		});

		await session.prompt("investigate and fix the loop");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(11);
		expect(mock.calls.every(call => call.options?.toolChoice !== "none")).toBe(true);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-progress-redirect",
			),
		).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "tool-progress-finalize",
			),
		).toBe(false);
	});
});
