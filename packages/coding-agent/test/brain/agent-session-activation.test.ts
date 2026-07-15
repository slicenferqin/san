import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { BRAIN_STATE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/brain/activation";
import {
	appendSanBrainDecision,
	appendSanBrainProfileCandidate,
	listSanBrainLedgerEntries,
} from "@oh-my-pi/pi-coding-agent/brain/ledger";
import type { SanBrainDecision, SanBrainProfileCandidate } from "@oh-my-pi/pi-coding-agent/brain/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Harness {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	sessionManager: SessionManager;
	mock: MockModel;
}

const activeHarnesses: Harness[] = [];
const createdAt = "2026-07-10T08:00:00.000Z";

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@san-brain-activation-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const mock = createMockModel({
		responses: [
			{ content: ["Synthetic done"], stopReason: "stop" },
			{ content: ["User done"], stopReason: "stop" },
		],
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"san.contextSteady.enabled": false,
		"san.executionLoop.enabled": false,
		"san.brain.enabled": true,
		"san.brain.mode": "activation",
		"san.brain.capture.enabled": false,
		"san.brain.activation.maxItems": 8,
		"san.brain.activation.maxTokens": 1200,
		"san.brain.activation.minConfidence": 0.75,
		"san.brain.activation.globalMaxTokens": 6000,
	});
	vi.spyOn(settings, "getAgentDir").mockReturnValue(tempDir.path());
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	authStorage.setRuntimeApiKey(mock.provider, "test-key");

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const candidate: SanBrainProfileCandidate = {
		schemaVersion: 1,
		candidateId: "profile-active",
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type: "standing_decision",
		subject: "delivery",
		predicate: "format",
		value: "HTML",
		claimKey: "delivery:format",
		dedupeKey: "delivery:format:html",
		taskTags: [],
		confidence: 0.95,
		importance: 0.9,
		independentEvidenceCount: 2,
		sensitivity: "normal",
		evidence: [],
		createdAt,
	};
	const decision: SanBrainDecision = {
		schemaVersion: 1,
		decisionId: "decision-active",
		ownerType: "profile_candidate",
		ownerId: candidate.candidateId,
		action: "approve",
		nextRevision: 1,
		requestedBy: "user",
		reason: "approved for activation test",
		policyVersion: "brain-m3-v1",
		idempotencyKey: "decision-active",
		projectionIds: [],
		createdAt,
	};
	appendSanBrainProfileCandidate(sessionManager, candidate);
	appendSanBrainDecision(sessionManager, decision);

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry: new Map() });
	const harness = { session, authStorage, tempDir, sessionManager, mock };
	activeHarnesses.push(harness);
	return harness;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses.splice(0).reverse()) {
		await harness.session.dispose();
		await harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

describe("San Brain M4 AgentSession activation", () => {
	it("applies the shared global budget to Brain and the production ContextPlan", async () => {
		const { session, sessionManager, mock } = await createHarness();
		session.settings.override("san.contextSteady.enabled", true);
		session.settings.override("san.contextSteady.contextPlan.enabled", true);
		session.settings.override("san.contextSteady.contextPlan.maxTokens", 1000);
		session.settings.override("san.brain.activation.globalMaxTokens", 1000);

		await session.prompt("Prepare the release summary.");

		const providerPayload = JSON.stringify(mock.calls[0]?.context.messages ?? []);
		expect(providerPayload).toContain("<san_brain_state");
		expect(providerPayload).not.toContain("<san_context_plan>");
		const activation = listSanBrainLedgerEntries(sessionManager.getEntries()).activations[0]?.data;
		expect(activation?.sourceBudgets).toContainEqual({
			source: "context_packet",
			tokenEstimate: 1000,
			included: false,
			reason: "global_token_budget",
		});
	});

	it("injects approved state only on the next real user turn and records its audit", async () => {
		const { session, sessionManager, mock } = await createHarness();

		await session.prompt("Synthetic continuation", { synthetic: true });
		expect(listSanBrainLedgerEntries(sessionManager.getEntries()).activations).toHaveLength(0);

		await session.prompt("Prepare the release summary.");

		const providerMessages = mock.calls[1]?.context.messages ?? [];
		const stateIndex = providerMessages.findIndex(message => JSON.stringify(message).includes("<san_brain_state"));
		const userIndex = providerMessages.findIndex(message =>
			JSON.stringify(message).includes("Prepare the release summary."),
		);
		expect(stateIndex).toBeGreaterThanOrEqual(0);
		expect(userIndex).toBeGreaterThan(stateIndex);
		expect(providerMessages[stateIndex]?.role).toBe("user");
		expect(
			providerMessages.some(
				message => message.role === "developer" && JSON.stringify(message).includes("<san_brain_state"),
			),
		).toBe(false);

		const ledger = listSanBrainLedgerEntries(sessionManager.getEntries());
		expect(ledger.activations).toHaveLength(1);
		expect(ledger.activations[0].data).toMatchObject({
			role: "primary",
			selectedRules: [{ ownerId: "profile-active", actionKind: "prelude_fact" }],
			globalTokenBudget: 6000,
		});
		expect(ledger.activations[0].data.globalTokenEstimate).toBeLessThanOrEqual(6000);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === BRAIN_STATE_MESSAGE_TYPE,
			),
		).toHaveLength(1);
	});
});
