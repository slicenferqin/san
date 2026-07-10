import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import {
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainExperienceCandidate,
} from "@oh-my-pi/pi-coding-agent/brain/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TURN_DIGEST_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/context-steady/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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

function customEntries(entries: readonly SessionEntry[]): CustomEntry[] {
	return entries.filter((entry): entry is CustomEntry => entry.type === "custom");
}

async function createHarness(contextSteadyEnabled: boolean): Promise<Harness> {
	const tempDir = TempDir.createSync("@san-brain-capture-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const mock = createMockModel({
		responses: [failureCall("focused verification failed"), { content: ["Done"], stopReason: "stop" }],
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"san.contextSteady.enabled": contextSteadyEnabled,
		"san.contextSteady.digest.enabled": true,
		"san.contextSteady.digest.persistFallback": true,
		"san.contextSteady.digest.llm.enabled": false,
		"san.brain.enabled": true,
		"san.brain.capture.enabled": true,
		"san.brain.capture.maxCandidatesPerTurn": 5,
		"san.brain.capture.minConfidence": 0.72,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	authStorage.setRuntimeApiKey(mock.provider, "test-key");

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
});

describe("San Brain M2 AgentSession capture lifecycle", () => {
	it("persists the digest before its candidates and drains capture before prompt resolves", async () => {
		const { session, sessionManager } = await createHarness(true);

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
		expect(candidate.evidence[0]).toMatchObject({
			sourceMode: "turn_digest",
			digestEntryIds: [digestEntry?.id],
		});
	});

	it("captures from a deterministic message-span fallback without persisting a digest", async () => {
		const { session, sessionManager } = await createHarness(false);

		await session.prompt("Run the failure probe and finish.");

		const entries = customEntries(sessionManager.getBranch());
		expect(entries.some(entry => entry.customType === TURN_DIGEST_CUSTOM_TYPE)).toBe(false);
		const candidateEntry = entries.find(entry => entry.customType === BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE);
		expect(candidateEntry).toBeDefined();
		const candidate = candidateEntry?.data as SanBrainExperienceCandidate;
		expect(candidate.evidence[0]).toMatchObject({
			sourceMode: "message_span_fallback",
			digestEntryIds: [],
		});
	});
});
