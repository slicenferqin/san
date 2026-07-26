import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@san/agent";
import * as ai from "@san/ai";
import { type AssistantMessage, z } from "@san/ai";
import { createMockModel, type MockResponse } from "@san/ai/providers/mock";
import {
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainExperienceCandidate,
} from "@san/coding-agent/brain/types";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { TURN_DIGEST_CUSTOM_TYPE, type TurnDigest } from "@san/coding-agent/context-steady/types";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import type { CustomEntry, SessionEntry } from "@san/coding-agent/session/session-entries";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";
import { resolveRuntimeScopeIdentity } from "../../src/identity";

const failureToolSchema = z.object({ reason: z.string() });

const failureTool: AgentTool<typeof failureToolSchema, { reason: string }> = {
	name: "failure_probe",
	label: "Failure probe",
	description: "Return a deterministic failed tool result",
	parameters: failureToolSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `error: ${params.reason}` }],
			details: { reason: params.reason },
			isError: true,
		};
	},
};

interface Harness {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	sessionManager: SessionManager;
}

const activeHarnesses: Harness[] = [];

function failureCall(reason: string): MockResponse {
	return {
		content: [{ type: "toolCall", id: "failure-call", name: failureTool.name, arguments: { reason } }],
		stopReason: "toolUse",
	};
}

function digestAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "brain-digest",
				name: "record_turn_digest",
				arguments: {
					userIntent: "Run the failure probe and finish.",
					actionsTaken: ["Ran the requested failure probe."],
					decisions: [],
					filesTouched: [],
					factsLearned: [],
					openQuestions: [],
					risks: [],
					nextSteps: [],
					memoryCandidates: [
						{ content: "User preference: 使用简洁中文回复。", type: "preference", importance: 0.9 },
					],
				},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function customEntries(entries: readonly SessionEntry[]): CustomEntry[] {
	return entries.filter((entry): entry is CustomEntry => entry.type === "custom");
}

async function createHarness(contextSteadyEnabled: boolean, llmDigestEnabled = false): Promise<Harness> {
	const tempDir = TempDir.createSync("@san-brain-capture-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const mock = createMockModel({
		responses: [failureCall("focused verification failed"), { content: ["Done"], stopReason: "stop" }],
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = await Settings.loadIsolated({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		inMemory: true,
		overrides: {
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"san.contextSteady.enabled": contextSteadyEnabled,
			"san.contextSteady.activationThresholdTokens": 0,
			"san.contextSteady.digest.enabled": true,
			"san.contextSteady.digest.persistFallback": true,
			"san.contextSteady.digest.timeoutMs": 1000,
			"san.contextSteady.digest.llm.enabled": llmDigestEnabled,
			"san.contextSteady.digest.llm.modelRole": "anthropic/claude-sonnet-4-5",
			"san.brain.enabled": true,
			"san.brain.capture.enabled": true,
			"san.brain.capture.maxCandidatesPerTurn": 5,
			"san.brain.capture.minConfidence": 0.72,
		},
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [failureTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir, sessionManager };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0).reverse()) {
		await harness.session.dispose();
		await harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("San Brain M2 AgentSession capture lifecycle", () => {
	it("persists the digest before its candidates and drains capture before prompt resolves", async () => {
		const { session, sessionManager, tempDir } = await createHarness(true);

		await session.prompt("Run the failure probe and finish.");

		const branch = sessionManager.getBranch();
		const entries = customEntries(branch);
		const digestEntry = entries.find(entry => entry.customType === TURN_DIGEST_CUSTOM_TYPE);
		const candidateEntry = entries.find(entry => entry.customType === BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE);
		expect(digestEntry).toBeDefined();
		expect(candidateEntry).toBeDefined();
		expect(branch.findIndex(entry => entry.id === digestEntry?.id)).toBeLessThan(
			branch.findIndex(entry => entry.id === candidateEntry?.id),
		);

		const candidate = candidateEntry?.data as SanBrainExperienceCandidate;
		expect(candidate.type).toBe("failure_posture");
		const identity = await resolveRuntimeScopeIdentity({
			agentDir: tempDir.path(),
			cwd: sessionManager.getCwd(),
			sessionId: sessionManager.getSessionId(),
		});
		expect(candidate.scope).toEqual({ kind: "project", key: identity.projectKey, resolverVersion: 1 });
		expect(candidate.evidence[0]).toMatchObject({
			sourceMode: "turn_digest",
			digestEntryIds: [digestEntry?.id],
		});
	});

	it("captures from a deterministic message-span fallback without persisting a digest", async () => {
		const { session, sessionManager, tempDir } = await createHarness(false);

		await session.prompt("Run the failure probe and finish.");

		const entries = customEntries(sessionManager.getBranch());
		expect(entries.some(entry => entry.customType === TURN_DIGEST_CUSTOM_TYPE)).toBe(false);
		const candidateEntry = entries.find(entry => entry.customType === BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE);
		expect(candidateEntry).toBeDefined();
		const candidate = candidateEntry?.data as SanBrainExperienceCandidate;
		const identity = await resolveRuntimeScopeIdentity({
			agentDir: tempDir.path(),
			cwd: sessionManager.getCwd(),
			sessionId: sessionManager.getSessionId(),
		});
		expect(candidate.scope).toEqual({ kind: "project", key: identity.projectKey, resolverVersion: 1 });
		expect(candidate.evidence[0]).toMatchObject({
			sourceMode: "message_span_fallback",
			digestEntryIds: [],
		});
	});

	it("uses the configured digest timeout while capturing Brain candidates", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
		const digestSpy = vi.spyOn(ai, "completeSimple").mockImplementation(async () => digestAssistant());
		const { session, sessionManager } = await createHarness(true, true);

		await session.prompt("Run the failure probe and finish.");

		const entries = customEntries(sessionManager.getBranch());
		const digestEntry = entries.find(entry => entry.customType === TURN_DIGEST_CUSTOM_TYPE);
		const profileEntry = entries.find(entry => entry.customType === BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE);
		expect(timeoutSpy).toHaveBeenCalledWith(1000);
		expect(digestSpy).toHaveBeenCalledTimes(1);
		expect(digestEntry?.data as TurnDigest).toMatchObject({
			fallback: false,
			memoryCandidates: [{ type: "preference" }],
		});
		expect(profileEntry?.data).toMatchObject({
			type: "user_preference",
			value: expect.stringContaining("简洁中文"),
		});
	});
});
