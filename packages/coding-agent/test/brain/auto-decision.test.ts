import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runSanBrainAutoDecisions } from "@san/coding-agent/brain/auto-decision";
import { applySanBrainMutation } from "@san/coding-agent/brain/commands";
import { SanBrainStore } from "@san/coding-agent/brain/store";
import {
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainExperienceCandidate,
	type SanBrainProfileCandidate,
} from "@san/coding-agent/brain/types";
import type { SessionEntry } from "@san/coding-agent/session/session-entries";
import type { ReadonlySessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

let tempDir: TempDir | null = null;
let store: SanBrainStore | null = null;

function profile(overrides: Partial<SanBrainProfileCandidate> = {}): SanBrainProfileCandidate {
	return {
		schemaVersion: 1,
		candidateId: "profile-1",
		scope: { kind: "user", key: "user:local", resolverVersion: 1 },
		type: "user_preference",
		authorization: "inferred",
		subject: "delivery",
		predicate: "format",
		value: "Use concise output.",
		claimKey: "delivery:format",
		dedupeKey: "delivery:format:concise",
		taskTags: [],
		confidence: 0.9,
		importance: 0.9,
		independentEvidenceCount: 1,
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-28T10:00:00.000Z",
		...overrides,
	};
}

function experience(overrides: Partial<SanBrainExperienceCandidate> = {}): SanBrainExperienceCandidate {
	return {
		schemaVersion: 1,
		candidateId: "experience-1",
		scope: { kind: "project", key: "project-1", resolverVersion: 1 },
		type: "workflow_pattern",
		authorization: "inferred",
		selector: {},
		action: { kind: "workflow_suggestion", workflowId: "verify-first" },
		taskTags: [],
		claimKey: "workflow:verify",
		dedupeKey: "workflow:verify:first",
		conflictKey: "workflow:verify",
		repeatCount: 1,
		confidence: 0.9,
		impact: "low",
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-28T10:00:00.000Z",
		...overrides,
	};
}

function entry(id: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-28T10:00:00.000Z",
		customType,
		data,
	};
}
function createSessionManager(entries: SessionEntry[]): ReadonlySessionManager {
	let sequence = entries.length;
	return {
		getSessionId: () => "session-1",
		getEntries: () => [...entries],
		appendCustomEntry: (customType: string, data?: unknown) => {
			const id = `decision-entry-${++sequence}`;
			entries.push(entry(id, customType, data));
			return id;
		},
	} as ReadonlySessionManager;
}

function run(entries: SessionEntry[], candidateIds?: readonly string[]) {
	if (!store) throw new Error("Test Brain store is not initialized.");
	return runSanBrainAutoDecisions({
		store,
		sessionManager: createSessionManager(entries),
		candidateIds,
		explicitMinConfidence: 0.75,
		inferredMinConfidence: 0.85,
		minIndependentEvidence: 2,
		maxPerTurn: 100,
		createdAt: "2026-07-28T10:01:00.000Z",
	});
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-brain-auto-decision-");
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

describe("San Brain automatic decisions", () => {
	it("activates an explicit durable user preference without review", () => {
		const candidate = profile({ authorization: "explicit_user", confidence: 0.8 });
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];

		const result = run(entries, [candidate.candidateId]);

		expect(result).toMatchObject({
			evaluated: 1,
			automaticallyHandled: 1,
			escalated: 0,
			failures: [],
			outcomes: [{ candidateId: candidate.candidateId, action: "approve", authorization: "explicit_user" }],
		});
		expect(store?.getCandidate(candidate.candidateId)).toMatchObject({ status: "active", revision: 1 });
		const explanation = store?.explain(candidate.candidateId);
		expect(explanation?.decisions).toMatchObject([
			{ applicationState: "applied", decision: { action: "approve", requestedBy: "policy" } },
		]);
		expect(store?.getAutomationMetrics()).toMatchObject({
			automaticallyApproved: 1,
			automaticallyHandled: 1,
			escalated: 0,
			automationRate: 1,
		});
	});

	it("treats legacy candidates without authorization as inferred", () => {
		const candidate = profile();
		delete candidate.authorization;
		candidate.value = "Please remember to use concise output.";
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];

		const result = run(entries);

		expect(result.outcomes).toMatchObject([
			{ candidateId: candidate.candidateId, action: "observe", authorization: "inferred" },
		]);
		expect(store?.getCandidate(candidate.candidateId)).toMatchObject({ status: "observed" });
	});

	it("observes a single inferred preference without putting it in the review queue", () => {
		const candidate = profile();
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];

		const result = run(entries);

		expect(result.outcomes).toMatchObject([{ candidateId: candidate.candidateId, action: "observe" }]);
		expect(store?.getCandidate(candidate.candidateId)).toMatchObject({ status: "observed" });
		expect(store?.listPendingCandidates()).toEqual([]);
	});

	it("activates repeated inferred evidence and supersedes its duplicate automatically", () => {
		const first = profile({ candidateId: "profile-1" });
		const second = profile({ candidateId: "profile-2" });
		const entries = [
			entry("profile-entry-1", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, first),
			entry("profile-entry-2", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, second),
		];

		const result = run(entries);

		expect(result).toMatchObject({ evaluated: 1, automaticallyHandled: 1, escalated: 0, failures: [] });
		expect(result.outcomes[0]).toMatchObject({ action: "approve", evidenceCount: 2 });
		expect(result.outcomes[0]?.decisionIds).toHaveLength(2);
		expect(
			[store?.getCandidate(first.candidateId)?.status, store?.getCandidate(second.candidateId)?.status].sort(),
		).toEqual(["active", "superseded"]);
		expect(store?.getAutomationMetrics()).toMatchObject({
			automaticallyApproved: 1,
			automaticallySuperseded: 1,
			automaticallyHandled: 2,
			evaluated: 2,
			automationRate: 1,
		});
	});

	it("discards sensitive candidates instead of activating or escalating them", () => {
		const candidate = profile({ sensitivity: "sensitive" });
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];

		const result = run(entries);

		expect(result.outcomes).toMatchObject([{ candidateId: candidate.candidateId, action: "discard" }]);
		expect(store?.getCandidate(candidate.candidateId)).toMatchObject({ status: "discarded" });
		expect(store?.listActiveStates()).toEqual([]);
		expect(store?.listPendingCandidates()).toEqual([]);
	});

	it("escalates only a high-impact inferred candidate into the review queue", () => {
		const candidate = experience({ impact: "high" });
		const entries = [entry("experience-entry", BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE, candidate)];

		const result = run(entries);

		expect(result).toMatchObject({ evaluated: 1, automaticallyHandled: 0, escalated: 1, failures: [] });
		expect(result.outcomes).toMatchObject([{ candidateId: candidate.candidateId, action: "escalate" }]);
		expect(store?.getCandidate(candidate.candidateId)).toMatchObject({ status: "review" });
		expect(store?.listPendingCandidates()).toMatchObject([{ candidate: { candidateId: candidate.candidateId } }]);
		expect(store?.getAutomationMetrics()).toMatchObject({ escalated: 1, reviewQueue: 1, automationRate: 0 });
	});

	it("lets an explicit current preference supersede conflicting active state", () => {
		const previous = profile({
			candidateId: "profile-old",
			value: "Use Markdown.",
			dedupeKey: "delivery:format:markdown",
		});
		const current = profile({
			candidateId: "profile-current",
			authorization: "explicit_user",
			value: "Use HTML.",
			dedupeKey: "delivery:format:html",
		});
		const entries = [entry("profile-old-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, previous)];
		const manager = createSessionManager(entries);
		if (!store) throw new Error("Test Brain store is not initialized.");
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		applySanBrainMutation(store, manager, {
			action: "approve",
			id: previous.candidateId,
			createdAt: "2026-07-28T10:00:30.000Z",
		});
		entries.push(entry("profile-current-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, current));

		const result = run(entries, [current.candidateId]);

		expect(result.outcomes).toMatchObject([{ candidateId: current.candidateId, action: "approve" }]);
		expect(store.getCandidate(previous.candidateId)).toMatchObject({ status: "superseded" });
		expect(store.getCandidate(current.candidateId)).toMatchObject({ status: "active" });
	});

	it("tracks user undo of a policy approval as an automatic revocation", () => {
		const candidate = profile({ authorization: "explicit_user", confidence: 0.8 });
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];
		const manager = createSessionManager(entries);
		if (!store) throw new Error("Test Brain store is not initialized.");

		const result = runSanBrainAutoDecisions({
			store,
			sessionManager: manager,
			candidateIds: [candidate.candidateId],
			explicitMinConfidence: 0.75,
			inferredMinConfidence: 0.85,
			minIndependentEvidence: 2,
			maxPerTurn: 100,
			createdAt: "2026-07-28T10:01:00.000Z",
		});
		const approveDecisionId = result.outcomes[0]?.decisionIds[0];
		if (!approveDecisionId) throw new Error("Expected an automatic approve decision.");
		applySanBrainMutation(store, manager, {
			action: "undo",
			id: approveDecisionId,
			createdAt: "2026-07-28T10:02:00.000Z",
		});

		expect(store.getAutomationMetrics()).toMatchObject({
			automaticallyApproved: 1,
			automaticallyRevoked: 1,
			automaticRevocationRate: 1,
		});
	});

	it("tracks user discard of a policy approval as an automatic revocation", () => {
		const candidate = profile({ authorization: "explicit_user", confidence: 0.8 });
		const entries = [entry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate)];
		const manager = createSessionManager(entries);
		if (!store) throw new Error("Test Brain store is not initialized.");

		runSanBrainAutoDecisions({
			store,
			sessionManager: manager,
			candidateIds: [candidate.candidateId],
			explicitMinConfidence: 0.75,
			inferredMinConfidence: 0.85,
			minIndependentEvidence: 2,
			maxPerTurn: 100,
			createdAt: "2026-07-28T10:01:00.000Z",
		});
		applySanBrainMutation(store, manager, {
			action: "discard",
			id: candidate.candidateId,
			createdAt: "2026-07-28T10:02:00.000Z",
		});

		expect(store.getCandidate(candidate.candidateId)).toMatchObject({ status: "discarded" });
		expect(store.getAutomationMetrics()).toMatchObject({
			automaticallyApproved: 1,
			automaticallyRevoked: 1,
			automaticRevocationRate: 1,
		});
	});

	it("tracks user conflict resolution that supersedes a policy approval", () => {
		const previous = profile({
			candidateId: "profile-old",
			value: "Use Markdown.",
			dedupeKey: "delivery:format:markdown",
			authorization: "explicit_user",
			confidence: 0.8,
		});
		const current = profile({
			candidateId: "profile-current",
			value: "Use HTML.",
			dedupeKey: "delivery:format:html",
		});
		const entries = [entry("profile-old-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, previous)];
		const manager = createSessionManager(entries);
		if (!store) throw new Error("Test Brain store is not initialized.");

		runSanBrainAutoDecisions({
			store,
			sessionManager: manager,
			candidateIds: [previous.candidateId],
			explicitMinConfidence: 0.75,
			inferredMinConfidence: 0.85,
			minIndependentEvidence: 2,
			maxPerTurn: 100,
			createdAt: "2026-07-28T10:01:00.000Z",
		});
		entries.push(entry("profile-current-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, current));
		applySanBrainMutation(store, manager, {
			action: "approve",
			id: current.candidateId,
			createdAt: "2026-07-28T10:02:00.000Z",
		});

		expect(store.getCandidate(previous.candidateId)).toMatchObject({ status: "superseded" });
		expect(store.getCandidate(current.candidateId)).toMatchObject({ status: "active" });
		expect(store.getAutomationMetrics()).toMatchObject({
			automaticallyApproved: 1,
			automaticallyRevoked: 1,
			automaticRevocationRate: 1,
		});
	});

	it("reports a 95 percent automatic handling rate from immutable policy decisions", () => {
		const entries: SessionEntry[] = [];
		for (let index = 0; index < 19; index++) {
			const candidate = profile({
				candidateId: `profile-${index}`,
				claimKey: `preference:${index}`,
				dedupeKey: `preference:${index}:value`,
				confidence: 0.8,
			});
			entries.push(entry(`profile-entry-${index}`, BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, candidate));
		}
		const reviewCandidate = experience({ candidateId: "review-candidate", impact: "high" });
		entries.push(entry("review-entry", BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE, reviewCandidate));

		const result = run(entries);

		expect(result).toMatchObject({ evaluated: 20, automaticallyHandled: 19, escalated: 1, failures: [] });
		expect(store?.getAutomationMetrics()).toMatchObject({
			evaluated: 20,
			automaticallyHandled: 19,
			escalated: 1,
			automationRate: 0.95,
			reviewQueue: 1,
		});
	});
});
