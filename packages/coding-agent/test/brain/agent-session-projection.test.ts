import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { createMockModel } from "@san/ai/providers/mock";
import { applySanBrainMutation } from "@san/coding-agent/brain/commands";
import { appendSanBrainExperienceCandidate, listSanBrainLedgerEntries } from "@san/coding-agent/brain/ledger";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import type { SanBrainExperienceCandidate } from "@san/coding-agent/brain/types";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

interface Harness {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
	sessionManager: SessionManager;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0).reverse()) {
		await harness.session.dispose();
		await harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@san-brain-session-projection-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const mock = createMockModel({
		responses: [
			{ content: ["First task continued."], stopReason: "stop" },
			{ content: ["Second task continued."], stopReason: "stop" },
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
		"san.brain.mode": "projection",
		"san.brain.capture.enabled": false,
		"san.brain.projections.enabled": true,
		"san.brain.projections.maxAttempts": 3,
		"san.brain.projections.attemptTimeoutMs": 1000,
		"san.brain.projections.maxPerTurn": 4,
	});
	vi.spyOn(settings, "getAgentDir").mockReturnValue(tempDir.path());
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const candidate: SanBrainExperienceCandidate = {
		schemaVersion: 1,
		candidateId: "unsafe-check",
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type: "check_candidate",
		selector: {},
		action: { kind: "check_suggestion", checkId: "../unsafe", body: "Never escape the managed root." },
		taskTags: [],
		claimKey: "check:unsafe",
		dedupeKey: "check:unsafe:v1",
		conflictKey: "check:unsafe",
		repeatCount: 1,
		confidence: 0.95,
		impact: "high",
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-11T08:00:00.000Z",
	};
	appendSanBrainExperienceCandidate(sessionManager, candidate);
	const store = SanBrainStore.open(tempDir.path());
	try {
		store.syncSessionEntries(sessionManager.getSessionId(), sessionManager.getEntries());
		applySanBrainMutation(store, sessionManager, { action: "approve", id: candidate.candidateId });
	} finally {
		store.close();
	}
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	const harness = { session, authStorage, tempDir, sessionManager };
	harnesses.push(harness);
	return harness;
}

describe("San Brain M6 AgentSession projection UX", () => {
	it("continues both user tasks and emits one UI-only blocked notification", async () => {
		const { session, sessionManager } = await createHarness();
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "brain") notices.push(event);
		});

		await session.prompt("Complete the first task.");
		await session.waitForIdle();
		await session.prompt("Complete the second task.");
		await session.waitForIdle();

		expect(session.getLastAssistantText()).toBe("Second task continued.");
		expect(notices).toEqual([
			{
				type: "notice",
				level: "warning",
				message: "1 San Brain projection is blocked; use /brain debug blocked.",
				source: "brain",
			},
		]);
		const ledger = listSanBrainLedgerEntries(sessionManager.getEntries());
		expect(ledger.projections.filter(entry => entry.data.state === "blocked")).toHaveLength(1);
		expect(ledger.projectionNotifications).toHaveLength(1);
		const finalProjectionId = ledger.projections.at(-1)?.data.projectionId;
		if (!finalProjectionId) throw new Error("Expected a projection audit.");
		expect(ledger.projectionNotifications[0]?.data.projectionId).toBe(finalProjectionId);
	});
});
