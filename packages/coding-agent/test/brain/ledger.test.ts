import { describe, expect, it, vi } from "bun:test";
import {
	appendSanBrainDecision,
	appendSanBrainExperienceCandidate,
	appendSanBrainProfileCandidate,
	listSanBrainLedgerEntries,
} from "@oh-my-pi/pi-coding-agent/brain/ledger";
import {
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	type SanBrainDecision,
	type SanBrainExperienceCandidate,
	type SanBrainProfileCandidate,
} from "@oh-my-pi/pi-coding-agent/brain/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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
	confidence: 0.9,
	importance: 0.8,
	independentEvidenceCount: 1,
	sensitivity: "normal",
	evidence: [],
	createdAt: "2026-07-10T10:00:00.000Z",
};

const experience: SanBrainExperienceCandidate = {
	schemaVersion: 1,
	candidateId: "experience-1",
	scope: { kind: "user", key: "user:local", resolverVersion: 1 },
	type: "failure_posture",
	selector: { taskFamilies: ["research"], riskClasses: ["external-entity"] },
	action: { kind: "risk_rule", riskClass: "external-entity", requiredCheck: "primary-source" },
	taskTags: ["research"],
	claimKey: "research:external-entity",
	dedupeKey: "research:external-entity:primary-source",
	conflictKey: "research:external-entity:verification-policy",
	repeatCount: 1,
	confidence: 0.95,
	impact: "low",
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

function sessionEntry(id: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-10T10:00:00.000Z",
		customType,
		data,
	};
}

describe("San Brain session ledger", () => {
	it("appends every M1 entry through SessionManager custom entries", () => {
		const appendCustomEntry = vi.fn((customType: string, _data?: unknown) => `entry:${customType}`);
		const sessionManager = { appendCustomEntry } as unknown as ReadonlySessionManager;

		expect(appendSanBrainProfileCandidate(sessionManager, profile)).toBe(
			`entry:${BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE}`,
		);
		expect(appendSanBrainExperienceCandidate(sessionManager, experience)).toBe(
			`entry:${BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE}`,
		);
		expect(appendSanBrainDecision(sessionManager, decision)).toBe(`entry:${BRAIN_DECISION_CUSTOM_TYPE}`);
		expect(appendCustomEntry.mock.calls).toEqual([
			[BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile],
			[BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE, experience],
			[BRAIN_DECISION_CUSTOM_TYPE, decision],
		]);
	});

	it("rebuilds valid entries in chronological ledger order and ignores malformed payloads", () => {
		const snapshot = listSanBrainLedgerEntries([
			sessionEntry("profile-entry", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, profile),
			sessionEntry("invalid-profile", BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE, { candidateId: "broken" }),
			sessionEntry("experience-entry", BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE, experience),
			sessionEntry("decision-entry", BRAIN_DECISION_CUSTOM_TYPE, decision),
		]);

		expect(snapshot.profileCandidates.map(entry => entry.entryId)).toEqual(["profile-entry"]);
		expect(snapshot.experienceCandidates.map(entry => entry.entryId)).toEqual(["experience-entry"]);
		expect(snapshot.decisions.map(entry => entry.entryId)).toEqual(["decision-entry"]);
	});
});
