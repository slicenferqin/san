/**
 * Context Steady State M2 — AgentSession ContextPacket integration tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry, CustomMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	TURN_DIGEST_CUSTOM_TYPE,
} from "../../src/context-steady/types";

const BASE_SETTINGS = {
	"san.contextSteady.enabled": true,
	"san.contextSteady.digest.enabled": true,
	"san.contextSteady.digest.persistFallback": true,
	"san.contextSteady.digest.timeoutMs": 5000,
	"san.contextSteady.contextPacket.enabled": true,
	"san.contextSteady.contextPacket.maxTokens": 2000,
};

const echoToolSchema = {
	type: "object",
	properties: {
		value: { type: "string" },
	},
	required: ["value"],
	additionalProperties: false,
} as const;

function echoParams(input: unknown): { value: string } {
	if (input && typeof input === "object" && "value" in input && typeof input.value === "string") {
		return { value: input.value };
	}
	throw new Error("Invalid echo params");
}

const echoTool: AgentTool<typeof echoToolSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo a value for context steady tests.",
	parameters: echoToolSchema,
	async execute(_toolCallId, params) {
		const parsed = echoParams(params);
		return {
			content: [{ type: "text", text: `echo:${parsed.value}` }],
			details: parsed,
		};
	},
};

function customEntries(sessionManager: SessionManager, customType: string): CustomEntry[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

function customMessageEntries(sessionManager: SessionManager, customType: string): CustomMessageEntry[] {
	return sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === customType,
		);
}

describe("Context Steady State M2 — AgentSession ContextPacket integration", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-context-packet-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages) {
			await authStorage.close();
		}
		removeSyncWithRetries(tempDir);
	});

	it("injects the previous turn digest into the next real user prompt and writes debug entry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: context => ({
				content: [`seen ${context.messages.length} messages`],
			}),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Fix the parser bug");
		await session.waitForIdle();

		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(1);
		expect(
			mock.calls[0]?.context.messages.some(message =>
				JSON.stringify(message.content).includes("<san_context_packet>"),
			),
		).toBe(false);

		await session.prompt("Continue with tests");
		await session.waitForIdle();

		const secondCallMessages = mock.calls[1]!.context.messages;
		const packetMessage = secondCallMessages.find(message =>
			JSON.stringify(message.content).includes("<san_context_packet>"),
		);
		expect(packetMessage).toBeDefined();
		expect(packetMessage?.role).toBe("developer");
		expect(JSON.stringify(packetMessage?.content)).toContain("Fix the parser bug");

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries).toHaveLength(1);
		const packetData = debugEntries[0]!.data as Record<string, unknown>;
		expect(packetData.injectedMessageCustomType).toBe(CONTEXT_PACKET_MESSAGE_TYPE);
		expect(packetData.digestRefs).toHaveLength(1);

		const injectedEntries = customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE);
		expect(injectedEntries).toHaveLength(1);
		expect(injectedEntries[0]!.display).toBe(false);
		expect(injectedEntries[0]!.details).toEqual({
			packetId: packetData.packetId,
			digestRefs: packetData.digestRefs,
		});

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		const secondDigest = digests[1]!.data as Record<string, unknown>;
		const secondDigestSource = secondDigest.source as Record<string, string>;
		const fromEntry = sessionManager.getEntry(secondDigestSource.fromEntryId);
		expect(fromEntry?.type).toBe("message");
	});

	it("does not inject ContextPacket when context packet setting is disabled", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			...BASE_SETTINGS,
			"san.contextSteady.contextPacket.enabled": false,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("First");
		await session.waitForIdle();
		await session.prompt("Second");
		await session.waitForIdle();

		expect(customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE)).toHaveLength(2);
		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(0);
		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(0);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				JSON.stringify(message.content).includes("<san_context_packet>"),
			),
		).toBe(false);
	});

	it("uses the default latest-five digest ledger window", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		for (let index = 1; index <= 6; index++) {
			await session.prompt(`M2 default window task ${index}`);
			await session.waitForIdle();
		}

		const debugEntries = customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE);
		expect(debugEntries).toHaveLength(5);
		const finalPacket = debugEntries.at(-1)!.data as Record<string, unknown>;
		const finalRefs = finalPacket.digestRefs as string[];
		expect(finalRefs).toHaveLength(5);

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		expect(finalRefs).toEqual(digests.slice(0, 5).map(entry => entry.id));
		expect(finalPacket.trimDecisions).toEqual([]);

		const finalPacketMessage = mock.calls
			.at(-1)!
			.context.messages.find(message => JSON.stringify(message.content).includes("<san_context_packet>"));
		expect(
			mock.calls
				.at(-1)!
				.context.messages.filter(message => JSON.stringify(message.content).includes("<san_context_packet>")),
		).toHaveLength(1);
		const finalPacketContent = JSON.stringify(finalPacketMessage?.content);
		expect(finalPacketContent).toContain("M2 default window task 1");
		expect(finalPacketContent).toContain("M2 default window task 5");
		expect(finalPacketContent).not.toContain("M2 default window task 6");
	});

	it("writes a digest for a tool-using turn after injecting ContextPacket", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["First done"] },
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "probe" } }] },
				{ content: ["Final answer after tool"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echoTool] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(BASE_SETTINGS);
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Remember the baseline");
		await session.waitForIdle();
		await session.prompt("Use a tool, then conclude");
		await session.waitForIdle();

		const digests = customEntries(sessionManager, TURN_DIGEST_CUSTOM_TYPE);
		expect(digests).toHaveLength(2);
		const secondDigest = digests[1]!.data as Record<string, unknown>;
		expect(secondDigest.userIntent).toBe("Use a tool, then conclude");
		expect(JSON.stringify(secondDigest.toolEvidence)).toContain("echo");

		const source = secondDigest.source as Record<string, string>;
		const fromEntry = sessionManager.getEntry(source.fromEntryId);
		const toEntry = sessionManager.getEntry(source.toEntryId);
		expect(fromEntry?.type).toBe("message");
		expect(toEntry?.type).toBe("message");
		expect(fromEntry && "message" in fromEntry ? fromEntry.message.role : undefined).toBe("user");
		expect(toEntry && "message" in toEntry ? toEntry.message.role : undefined).toBe("assistant");
		const toMessageContent =
			toEntry?.type === "message" && toEntry.message.role === "assistant"
				? JSON.stringify(toEntry.message.content)
				: "";
		expect(toMessageContent).toContain("Final answer after tool");

		expect(customEntries(sessionManager, CONTEXT_PACKET_CUSTOM_TYPE)).toHaveLength(1);
		expect(customMessageEntries(sessionManager, CONTEXT_PACKET_MESSAGE_TYPE)).toHaveLength(1);
	});
});
