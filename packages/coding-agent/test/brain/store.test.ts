import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SanBrainStore } from "@oh-my-pi/pi-coding-agent/brain/store";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainProfileCandidate,
} from "@oh-my-pi/pi-coding-agent/brain/types";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;
let stores: SanBrainStore[] = [];

function profileCandidate(id = "profile-1"): SanBrainProfileCandidate {
	return {
		schemaVersion: 1,
		candidateId: id,
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type: "user_preference",
		subject: "delivery",
		predicate: "format",
		value: "HTML",
		claimKey: "user:local:delivery:format",
		dedupeKey: `user:local:delivery:format:html:${id}`,
		taskTags: ["research"],
		confidence: 0.94,
		importance: 0.8,
		independentEvidenceCount: 1,
		sensitivity: "normal",
		evidence: [
			{
				sessionId: "session-1",
				entryIds: ["user-1"],
				digestEntryIds: ["digest-1"],
				loopRefs: [],
				fileRefs: [],
				toolCallIds: [],
				summary: "User requested HTML research documents.",
			},
		],
		createdAt: "2026-07-10T10:00:00.000Z",
	};
}

function approveDecision(ownerId = "profile-1", id = "decision-1"): SanBrainDecision {
	return {
		schemaVersion: 1,
		decisionId: id,
		ownerType: "profile_candidate",
		ownerId,
		action: "approve",
		previousRevision: 0,
		nextRevision: 1,
		requestedBy: "user",
		reason: "Explicitly approved preference.",
		policyVersion: "brain-m1",
		idempotencyKey: `approve:${ownerId}:1`,
		projectionIds: [],
		createdAt: "2026-07-10T10:01:00.000Z",
	};
}

function customEntry<T>(id: string, customType: string, data: T): CustomEntry<T> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-10T10:00:00.000Z",
		customType,
		data,
	};
}

function openStore(): SanBrainStore {
	if (!tempDir) throw new Error("Test temp directory is not initialized.");
	const store = new SanBrainStore(tempDir.join("brain.sqlite"));
	stores.push(store);
	return store;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-brain-store-");
	stores = [];
});

afterEach(async () => {
	for (const store of stores) store.close();
	stores = [];
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("SanBrainStore", () => {
	it("creates schema version 1 and preserves pending candidates across reopen", () => {
		const entries: SessionEntry[] = [
			customEntry("entry-profile-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profileCandidate()),
		];
		const store = openStore();
		const firstSync = store.syncSessionEntries("session-1", entries);

		expect(store.schemaVersion).toBe(1);
		expect(firstSync).toEqual({
			candidatesAdded: 1,
			decisionsAdded: 0,
			decisionsApplied: 0,
			decisionsBlocked: 0,
		});
		expect(store.listPendingCandidates().map(record => record.candidate.candidateId)).toEqual(["profile-1"]);
		store.close();
		stores = stores.filter(item => item !== store);

		const reopened = openStore();
		expect(reopened.listPendingCandidates()[0]?.candidate.candidateId).toBe("profile-1");
	});

	it("materializes an approved candidate and explains the decision chain", () => {
		const entries: SessionEntry[] = [
			customEntry("entry-profile-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profileCandidate()),
			customEntry("entry-decision-1", BRAIN_DECISION_CUSTOM_TYPE, approveDecision()),
		];
		const store = openStore();
		const result = store.syncSessionEntries("session-1", entries);

		expect(result.decisionsApplied).toBe(1);
		expect(store.listPendingCandidates()).toEqual([]);
		expect(store.listActiveStates()[0]?.candidate.candidateId).toBe("profile-1");
		expect(store.explain("decision-1")).toMatchObject({
			candidate: { status: "active", revision: 1 },
			decisions: [{ applicationState: "applied" }],
			activeState: { decisionId: "decision-1", revision: 1 },
		});
	});

	it("is idempotent across multiple store handles", () => {
		const entries: SessionEntry[] = [
			customEntry("entry-profile-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profileCandidate()),
			customEntry("entry-decision-1", BRAIN_DECISION_CUSTOM_TYPE, approveDecision()),
		];
		const first = openStore();
		const second = openStore();

		expect(first.syncSessionEntries("session-1", entries).candidatesAdded).toBe(1);
		expect(second.syncSessionEntries("session-1", entries)).toEqual({
			candidatesAdded: 0,
			decisionsAdded: 0,
			decisionsApplied: 0,
			decisionsBlocked: 0,
		});
		expect(second.listActiveStates()).toHaveLength(1);
	});

	it("blocks stale revisions instead of overwriting materialized state", () => {
		const stale = { ...approveDecision(), previousRevision: 2, nextRevision: 3 };
		const entries: SessionEntry[] = [
			customEntry("entry-profile-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profileCandidate()),
			customEntry("entry-decision-1", BRAIN_DECISION_CUSTOM_TYPE, stale),
		];
		const store = openStore();
		const result = store.syncSessionEntries("session-1", entries);

		expect(result.decisionsBlocked).toBe(1);
		expect(store.listActiveStates()).toEqual([]);
		expect(store.explain("decision-1")?.decisions[0]).toMatchObject({
			applicationState: "blocked",
			applicationError: "Expected candidate revision 2, found 0.",
		});
	});

	it("rejects an id collision with different payload", () => {
		const firstEntry = customEntry("entry-profile-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profileCandidate());
		const conflicting = profileCandidate();
		conflicting.value = "Markdown";
		const secondEntry = customEntry("entry-profile-2", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, conflicting);
		const store = openStore();

		store.syncSessionEntries("session-1", [firstEntry]);
		expect(() => store.syncSessionEntries("session-1", [secondEntry])).toThrow("Brain candidate collision");
	});
});
