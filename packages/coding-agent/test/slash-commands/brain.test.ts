import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainProfileCandidate,
} from "@oh-my-pi/pi-coding-agent/brain/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

const profile: SanBrainProfileCandidate = {
	schemaVersion: 1,
	candidateId: "profile-1",
	scope: { kind: "user", key: "user:local", resolverVersion: 1 },
	type: "user_preference",
	subject: "delivery",
	predicate: "format",
	value: "HTML",
	claimKey: "delivery:format",
	dedupeKey: "delivery:format:html",
	taskTags: [],
	confidence: 0.92,
	importance: 0.8,
	independentEvidenceCount: 1,
	sensitivity: "normal",
	evidence: [],
	createdAt: "2026-07-10T10:00:00.000Z",
};

const decision: SanBrainDecision = {
	schemaVersion: 1,
	decisionId: "decision-1",
	ownerType: "profile_candidate",
	ownerId: "profile-1",
	action: "approve",
	previousRevision: 0,
	nextRevision: 1,
	requestedBy: "user",
	reason: "Approved.",
	policyVersion: "brain-m1",
	idempotencyKey: "approve:profile-1:1",
	projectionIds: [],
	createdAt: "2026-07-10T10:01:00.000Z",
};

function entry(id: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-10T10:00:00.000Z",
		customType,
		data,
	};
}

function createRuntime(entries: SessionEntry[]) {
	if (!tempDir) throw new Error("Test temp directory is not initialized.");
	const showStatus = vi.fn();
	const setText = vi.fn();
	const sessionManager = {
		getSessionId: () => "session-1",
		getEntries: () => [...entries],
		getCwd: () => "/repo",
	};
	const agentDir = tempDir.join("agent");
	const settings = { getAgentDir: () => agentDir };
	const ctx = {
		editor: { setText },
		showStatus,
		settings,
		sessionManager,
		session: { sessionManager },
		refreshSlashCommandState: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, showStatus, setText };
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-brain-command-");
});

afterEach(async () => {
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("/brain slash command", () => {
	it("lists pending candidates from the current session ledger", async () => {
		const harness = createRuntime([entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile)]);

		expect(await executeBuiltinSlashCommand("/brain inbox", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("San Brain inbox (1)"));
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("profile-1 [profile]"));
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows active profile and explains its decision", async () => {
		const entries = [
			entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile),
			entry("decision-entry", BRAIN_DECISION_CUSTOM_TYPE, decision),
		];
		const harness = createRuntime(entries);

		expect(await executeBuiltinSlashCommand("/brain profile", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("San Brain active profile (1)"));

		harness.showStatus.mockClear();
		expect(await executeBuiltinSlashCommand("/brain explain decision-1", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("San Brain explanation: profile-1"));
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Status: active"));
	});

	it("rejects explain without an id", async () => {
		const harness = createRuntime([]);

		expect(await executeBuiltinSlashCommand("/brain explain", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /brain explain <id>");
	});
});
