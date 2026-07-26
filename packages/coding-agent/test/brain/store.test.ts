import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rebuildSanBrainStore } from "@san/coding-agent/brain/rebuild";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainProfileCandidate,
} from "@san/coding-agent/brain/types";
import type { SessionEntry } from "@san/coding-agent/session/session-entries";
import { TempDir } from "@san/utils";

let tempDir: TempDir | null = null;
const openStores = new Set<SanBrainStore>();

function profile(overrides: Partial<SanBrainProfileCandidate> = {}): SanBrainProfileCandidate {
	return {
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
		...overrides,
	};
}

function decision(overrides: Partial<SanBrainDecision> = {}): SanBrainDecision {
	return {
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
		...overrides,
	};
}

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

function createStore(dbPath: string): SanBrainStore {
	const store = new SanBrainStore(dbPath);
	openStores.add(store);
	return store;
}

function closeStore(store: SanBrainStore): void {
	store.close();
	openStores.delete(store);
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-brain-store-");
});

afterEach(async () => {
	for (const store of openStores) store.close();
	openStores.clear();
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("SanBrainStore", () => {
	it("rebuilds materialized state from every persisted session ledger", async () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const store = createStore(tempDir.join("brain.sqlite"));
		store.syncSessionEntries("stale-session", [
			entry("stale-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile({ candidateId: "stale-profile" })),
		]);
		const sessionHeader = (id: string) => ({
			type: "session" as const,
			version: 3,
			id,
			timestamp: "2026-07-10T10:00:00.000Z",
			cwd: tempDir!.path(),
		});
		await Bun.write(
			tempDir.join("sessions", "project-a", "one.jsonl"),
			`${[
				sessionHeader("session-one"),
				entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile()),
				entry("decision-entry", BRAIN_DECISION_CUSTOM_TYPE, decision()),
			]
				.map(value => JSON.stringify(value))
				.join("\n")}\n`,
		);
		await Bun.write(
			tempDir.join("sessions", "project-b", "two.jsonl"),
			`${[
				sessionHeader("session-two"),
				entry(
					"profile-entry-two",
					BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
					profile({ candidateId: "profile-2", dedupeKey: "delivery:format:markdown", value: "Markdown" }),
				),
			]
				.map(value => JSON.stringify(value))
				.join("\n")}\n`,
		);

		const rebuilt = await rebuildSanBrainStore(store, tempDir.path());

		expect(rebuilt).toMatchObject({
			sessionsScanned: 2,
			sessionsWithBrainState: 2,
			candidatesAdded: 2,
			decisionsAdded: 1,
			decisionsApplied: 1,
		});
		expect(store.getCandidate("stale-profile")).toBeUndefined();
		expect(store.listActiveStates()).toMatchObject([{ candidate: { candidateId: "profile-1" } }]);
		expect(store.listPendingCandidates()).toMatchObject([{ candidate: { candidateId: "profile-2" } }]);
	});

	it("rebuilds active state from the immutable ledger and remains idempotent after resume", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("brain.sqlite");
		const entries = [
			entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile()),
			entry("decision-entry", BRAIN_DECISION_CUSTOM_TYPE, decision()),
		];
		const store = createStore(dbPath);

		expect(store.schemaVersion).toBe(2);
		expect(store.syncSessionEntries("session-1", entries)).toEqual({
			candidatesAdded: 1,
			decisionsAdded: 1,
			decisionsApplied: 1,
			decisionsBlocked: 0,
		});
		expect(store.syncSessionEntries("session-1", entries)).toEqual({
			candidatesAdded: 0,
			decisionsAdded: 0,
			decisionsApplied: 0,
			decisionsBlocked: 0,
		});
		expect(store.listPendingCandidates()).toEqual([]);
		expect(store.listActiveStates()).toMatchObject([
			{ kind: "profile", revision: 1, decisionId: "decision-1", candidate: { candidateId: "profile-1" } },
		]);

		closeStore(store);
		const resumed = createStore(dbPath);
		expect(resumed.schemaVersion).toBe(2);
		expect(resumed.explain("decision-1")).toMatchObject({
			candidate: { status: "active", revision: 1, candidate: { candidateId: "profile-1" } },
			decisions: [{ applicationState: "applied", decision: { decisionId: "decision-1" } }],
			activeState: { revision: 1, decisionId: "decision-1" },
		});
	});

	it("reconciles a decision that was persisted before its candidate", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const store = createStore(tempDir.join("brain.sqlite"));

		expect(
			store.syncSessionEntries("session-1", [entry("decision-entry", BRAIN_DECISION_CUSTOM_TYPE, decision())]),
		).toEqual({ candidatesAdded: 0, decisionsAdded: 1, decisionsApplied: 0, decisionsBlocked: 0 });
		expect(store.listActiveStates()).toEqual([]);

		expect(
			store.syncSessionEntries("session-1", [
				entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile()),
			]),
		).toEqual({ candidatesAdded: 1, decisionsAdded: 0, decisionsApplied: 1, decisionsBlocked: 0 });
		expect(store.listActiveStates()).toMatchObject([{ revision: 1, decisionId: "decision-1" }]);
	});

	it("blocks a stale revision from a second writer without replacing active state", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("brain.sqlite");
		const first = createStore(dbPath);
		const second = createStore(dbPath);
		const candidateEntry = entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile());

		first.syncSessionEntries("session-1", [candidateEntry]);
		expect(
			first.syncSessionEntries("session-1", [entry("approve-entry", BRAIN_DECISION_CUSTOM_TYPE, decision())]),
		).toMatchObject({ decisionsApplied: 1, decisionsBlocked: 0 });
		expect(
			second.syncSessionEntries("session-2", [
				candidateEntry,
				entry(
					"discard-entry",
					BRAIN_DECISION_CUSTOM_TYPE,
					decision({
						decisionId: "decision-2",
						action: "discard",
						idempotencyKey: "discard:profile-1:1",
						createdAt: "2026-07-10T10:02:00.000Z",
					}),
				),
			]),
		).toMatchObject({ decisionsApplied: 0, decisionsBlocked: 1 });

		const explanation = first.explain("profile-1");
		expect(explanation?.activeState).toMatchObject({ revision: 1, decisionId: "decision-1" });
		expect(explanation?.decisions).toMatchObject([
			{ applicationState: "applied", decision: { decisionId: "decision-1" } },
			{
				applicationState: "blocked",
				applicationError: "Expected candidate revision 0, found 1.",
				decision: { decisionId: "decision-2" },
			},
		]);
	});

	it("rejects a database schema newer than the runtime supports", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("brain.sqlite");
		const db = new Database(dbPath);
		db.run("PRAGMA user_version = 99");
		db.close();

		expect(() => createStore(dbPath)).toThrow("Brain database schema 99 is newer than supported version 2.");
	});

	it("migrates a v1 projection audit to v2 without losing its durable fields", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("brain.sqlite");
		const db = new Database(dbPath);
		db.run(`
			CREATE TABLE projections (
				projection_id TEXT PRIMARY KEY,
				decision_id TEXT NOT NULL,
				target TEXT NOT NULL,
				state TEXT NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				revision INTEGER,
				before_hash TEXT,
				after_hash TEXT,
				error TEXT,
				updated_at TEXT NOT NULL
			)
		`);
		db.prepare(
			`INSERT INTO projections (
				projection_id, decision_id, target, state, attempt_count, revision,
				before_hash, after_hash, error, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"projection-v1",
			"decision-v1",
			"managed_skill",
			"failed",
			2,
			1,
			"before-v1",
			"after-v1",
			"legacy failure",
			"2026-07-10T11:00:00.000Z",
		);
		db.run("PRAGMA user_version = 1");
		db.close();

		const store = createStore(dbPath);
		expect(store.schemaVersion).toBe(2);
		expect(store.getProjection("projection-v1")).toEqual({
			projectionId: "projection-v1",
			decisionId: "decision-v1",
			target: "managed_skill",
			state: "failed",
			attemptCount: 2,
			revision: 1,
			beforeHash: "before-v1",
			afterHash: "after-v1",
			error: "legacy failure",
			updatedAt: "2026-07-10T11:00:00.000Z",
		});
	});
});
