import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySanBrainMutation, buildSanBrainConsolidation } from "@san/coding-agent/brain/commands";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainProfileCandidate,
} from "@san/coding-agent/brain/types";
import type { SessionEntry } from "@san/coding-agent/session/session-entries";
import type { ReadonlySessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

let tempDir: TempDir | null = null;
let store: SanBrainStore | null = null;

function profile(
	candidateId: string,
	value: string,
	overrides: Partial<SanBrainProfileCandidate> = {},
): SanBrainProfileCandidate {
	return {
		schemaVersion: 1,
		candidateId,
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type: "user_preference",
		subject: "delivery",
		predicate: "format",
		value,
		claimKey: "user:user:local:user_preference:delivery:format",
		dedupeKey: `user:user:local:user_preference:delivery:format:${value.toLowerCase()}`,
		taskTags: [],
		confidence: 0.9,
		importance: 0.8,
		independentEvidenceCount: 1,
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-10T10:00:00.000Z",
		...overrides,
	};
}

function decision(overrides: Partial<SanBrainDecision> = {}): SanBrainDecision {
	return {
		schemaVersion: 1,
		decisionId: "decision-old-approve",
		ownerType: "profile_candidate",
		ownerId: "profile-old",
		action: "approve",
		previousRevision: 0,
		nextRevision: 1,
		requestedBy: "user",
		reason: "Approved.",
		policyVersion: "brain-m3",
		idempotencyKey: "brain-m3:approve:profile-old:1",
		projectionIds: [],
		createdAt: "2026-07-10T10:01:00.000Z",
		...overrides,
	};
}

function entry(id: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp:
			typeof data === "object" && data !== null && "createdAt" in data && typeof data.createdAt === "string"
				? data.createdAt
				: "2026-07-10T10:00:00.000Z",
		customType,
		data,
	};
}

function sessionManager(entries: SessionEntry[]): ReadonlySessionManager {
	let sequence = 0;
	return {
		getSessionId: () => "session-1",
		getEntries: () => [...entries],
		appendCustomEntry: (customType: string, data?: unknown) => {
			const entryId = `appended-${++sequence}`;
			entries.push(entry(entryId, customType, data));
			return entryId;
		},
	} as unknown as ReadonlySessionManager;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-brain-consolidate-");
	store = new SanBrainStore(tempDir.join("brain.sqlite"));
});

afterEach(async () => {
	store?.close();
	store = null;
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("San Brain M3 consolidation", () => {
	it("approves a consolidated candidate and supersedes duplicate and conflicting active state", () => {
		if (!store) throw new Error("Brain store is not initialized.");
		const entries = [
			entry("candidate-old", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile("profile-old", "Markdown")),
			entry("candidate-new", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile("profile-new", "HTML")),
			entry(
				"candidate-duplicate",
				BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
				profile("profile-duplicate", "HTML", { independentEvidenceCount: 2, confidence: 0.95 }),
			),
			entry("decision-old", BRAIN_DECISION_CUSTOM_TYPE, decision()),
		];
		const manager = sessionManager(entries);
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());

		const report = buildSanBrainConsolidation(store);
		expect(report.duplicateGroups).toHaveLength(1);
		expect(report.conflictGroups).toHaveLength(1);

		const result = applySanBrainMutation(store, manager, {
			action: "approve",
			id: "profile-new",
			createdAt: "2026-07-10T10:02:00.000Z",
		});
		expect(result.decisions.map(item => [item.action, item.ownerId])).toEqual([
			["approve", "profile-new"],
			["supersede", "profile-duplicate"],
			["supersede", "profile-old"],
		]);
		expect(store.listActiveStates()).toMatchObject([
			{
				candidate: { candidateId: "profile-new", independentEvidenceCount: 3, confidence: 0.95 },
				revision: 1,
			},
		]);
		expect(store.getCandidate("profile-duplicate")).toMatchObject({ status: "superseded", revision: 1 });
		expect(store.getCandidate("profile-old")).toMatchObject({ status: "superseded", revision: 2 });

		const entryCount = entries.length;
		expect(applySanBrainMutation(store, manager, { action: "approve", id: "profile-new" })).toMatchObject({
			changed: false,
			decisions: [],
		});
		expect(entries).toHaveLength(entryCount);
	});

	it("undoes the current approval and permits a later revision", () => {
		if (!store) throw new Error("Brain store is not initialized.");
		const entries = [entry("candidate-new", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile("profile-new", "HTML"))];
		const manager = sessionManager(entries);
		const approved = applySanBrainMutation(store, manager, {
			action: "approve",
			id: "profile-new",
			createdAt: "2026-07-10T10:02:00.000Z",
		});
		const approveDecision = approved.decisions[0]!;

		applySanBrainMutation(store, manager, {
			action: "undo",
			id: approveDecision.decisionId,
			createdAt: "2026-07-10T10:03:00.000Z",
		});
		expect(store.listActiveStates()).toEqual([]);
		expect(store.getCandidate("profile-new")).toMatchObject({ status: "undone", revision: 2 });

		applySanBrainMutation(store, manager, {
			action: "approve",
			id: "profile-new",
			createdAt: "2026-07-10T10:04:00.000Z",
		});
		expect(store.listActiveStates()).toMatchObject([{ candidate: { candidateId: "profile-new" }, revision: 3 }]);
	});
});
