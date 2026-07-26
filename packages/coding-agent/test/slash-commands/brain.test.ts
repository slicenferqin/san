import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainProfileCandidate,
} from "@san/coding-agent/brain/types";
import { Settings } from "@san/coding-agent/config/settings";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import type { SessionEntry } from "@san/coding-agent/session/session-entries";
import { executeBuiltinSlashCommand } from "@san/coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@san/utils";

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
	let sequence = 0;
	const appendCustomEntry = vi.fn((customType: string, data?: unknown) => {
		const entryId = `appended-${++sequence}`;
		entries.push(entry(entryId, customType, data));
		return entryId;
	});
	const sessionManager = {
		getSessionId: () => "session-1",
		getEntries: () => [...entries],
		getCwd: () => "/repo",
		appendCustomEntry,
	};
	const agentDir = tempDir.join("agent");
	const settings = Settings.isolated({
		"san.brain.enabled": false,
		"san.brain.mode": "review-only",
		"san.brain.projections.enabled": false,
	});
	vi.spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
	const ctx = {
		editor: { setText },
		showStatus,
		settings,
		sessionManager,
		session: { sessionManager },
		refreshSlashCommandState: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, showStatus, setText, entries, appendCustomEntry };
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

	it("approves and undoes a candidate through immutable decisions", async () => {
		const harness = createRuntime([entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile)]);

		expect(await executeBuiltinSlashCommand("/brain approve profile-1", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("San Brain approve: applied 1 decision(s)."),
		);
		const approveEntry = harness.entries.find(
			item => item.type === "custom" && item.customType === BRAIN_DECISION_CUSTOM_TYPE,
		);
		if (approveEntry?.type !== "custom") throw new Error("Approve decision entry was not appended.");
		const approveDecision = approveEntry.data as SanBrainDecision;

		harness.showStatus.mockClear();
		expect(await executeBuiltinSlashCommand(`/brain undo ${approveDecision.decisionId}`, harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("San Brain undo: applied 1 decision(s)."),
		);
		expect(harness.appendCustomEntry).toHaveBeenCalledTimes(2);

		harness.showStatus.mockClear();
		expect(await executeBuiltinSlashCommand("/brain profile", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("San Brain profile has no active state.");
	});

	it("reports duplicates and conflicts without approving them", async () => {
		const duplicate = { ...profile, candidateId: "profile-2" } satisfies SanBrainProfileCandidate;
		const conflicting = {
			...profile,
			candidateId: "profile-3",
			value: "Markdown",
			dedupeKey: "delivery:format:markdown",
		} satisfies SanBrainProfileCandidate;
		const harness = createRuntime([
			entry("profile-entry-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile),
			entry("profile-entry-2", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, duplicate),
			entry("profile-entry-3", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, conflicting),
		]);

		expect(await executeBuiltinSlashCommand("/brain consolidate", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("San Brain consolidation: duplicates=1 conflicts=1"),
		);
		expect(harness.appendCustomEntry).not.toHaveBeenCalled();
	});

	it("rejects explain without an id", async () => {
		const harness = createRuntime([]);

		expect(await executeBuiltinSlashCommand("/brain explain", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /brain explain <id>");
	});

	it("does not let an explicit project command bypass the disabled runtime policy", async () => {
		const harness = createRuntime([]);

		expect(await executeBuiltinSlashCommand("/brain project", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith(
			"San Brain project failed: projection is disabled by the effective runtime policy.",
		);
	});
});
