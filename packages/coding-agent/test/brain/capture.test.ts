import { describe, expect, it } from "bun:test";
import { captureSanBrainTurn } from "@oh-my-pi/pi-coding-agent/brain/capture";
import { extractSanBrainCandidates } from "@oh-my-pi/pi-coding-agent/brain/extract";
import {
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/brain/types";
import type { TurnDigest } from "@oh-my-pi/pi-coding-agent/context-steady/types";
import {
	SAN_LOOP_REVIEW_CUSTOM_TYPE,
	SAN_LOOP_RUN_CUSTOM_TYPE,
	type SanLoopReviewReport,
	type SanLoopRunSnapshot,
} from "@oh-my-pi/pi-coding-agent/san-loop/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const digest: TurnDigest = {
	schemaVersion: 1,
	turnId: "turn-1",
	sessionId: "session-1",
	createdAt: "2026-07-10T10:00:00.000Z",
	fallback: true,
	source: {
		sessionId: "session-1",
		fromEntryId: "user-entry",
		toEntryId: "assistant-entry",
		promptGeneration: 1,
	},
	userIntent: "Implement deterministic Brain capture.",
	actionsTaken: [],
	decisions: [],
	filesTouched: [{ path: "packages/coding-agent/src/brain/capture.ts", action: "modified" }],
	factsLearned: [],
	openQuestions: [],
	risks: [],
	nextSteps: [],
	memoryCandidates: [
		{ type: "preference", content: "delivery format: HTML", importance: 0.9 },
		{ type: "project_fact", content: "Brain candidates remain review-only", importance: 0.88 },
		{ type: "workflow", content: "Run focused tests before bun check", importance: 0.85 },
	],
	toolEvidence: [{ tool: "bash", summary: "check failed because imports were unsorted" }],
};

function customEntry(id: string, customType: string, data: unknown, parentId: string | null): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-10T10:00:00.000Z",
		customType,
		data,
	};
}

function messageEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-10T10:00:00.000Z",
		message: {
			role: id === "user-entry" ? "user" : "assistant",
			content: [{ type: "text", text: id }],
			timestamp: 0,
		},
	} as SessionEntry;
}

const acceptedReview: SanLoopReviewReport = {
	schemaVersion: 1,
	reportId: "review-1",
	runId: "run-1",
	createdAt: "2026-07-10T10:00:00.000Z",
	reviewer: "supervisor",
	verdict: "pass",
	defects: [],
	testsRun: ["brain capture test"],
	evidence: ["focused test passed"],
	retryable: false,
	requiredNextActions: [],
	confidence: "high",
	assignmentId: "assignment-1",
};

const acceptedRun: SanLoopRunSnapshot = {
	schemaVersion: 1,
	revision: 0,
	runId: "run-1",
	sessionId: "session-1",
	createdAt: "2026-07-10T09:59:00.000Z",
	updatedAt: "2026-07-10T10:00:00.000Z",
	objective: "Implement deterministic Brain capture.",
	mode: "solo",
	status: "passed",
	contextPacketRefs: [],
	assignments: [
		{
			assignmentId: "assignment-1",
			runId: "run-1",
			createdAt: "2026-07-10T09:59:00.000Z",
			objective: "Implement capture.",
			taskNodeIds: [],
			instructions: "Implement deterministic capture.",
			acceptanceCriteria: [],
			contextRefs: [],
			checkRefs: [],
			status: "completed",
		},
	],
	workerResults: [
		{
			resultId: "attempt-1",
			runId: "run-1",
			assignmentId: "assignment-1",
			createdAt: "2026-07-10T09:59:30.000Z",
			status: "completed",
			summary: "Implemented deterministic capture.",
			changedFiles: ["packages/coding-agent/src/brain/capture.ts"],
			commandsRun: [],
			verification: ["brain capture test passed"],
			risks: [],
		},
	],
	reviewReports: [acceptedReview],
	decisions: [],
	budget: [],
	retryCount: 0,
	maxRetries: 2,
	finalVerdict: "pass",
};

function sourceEntries(): SessionEntry[] {
	return [
		messageEntry("user-entry", null),
		customEntry("run-entry", SAN_LOOP_RUN_CUSTOM_TYPE, acceptedRun, "user-entry"),
		customEntry("review-entry", SAN_LOOP_REVIEW_CUSTOM_TYPE, acceptedReview, "run-entry"),
		messageEntry("assistant-entry", "review-entry"),
	];
}

describe("San Brain deterministic capture", () => {
	it("suppresses secrets and keeps sensitive candidates review-only", () => {
		const result = extractSanBrainCandidates({
			digest: {
				...digest,
				memoryCandidates: [
					{ type: "preference", content: "api_key=sk-1234567890abcdefghijkl", importance: 0.99 },
					{ type: "project_fact", content: "Release owner: owner@example.com", importance: 0.9 },
				],
				toolEvidence: [],
			},
			entries: sourceEntries(),
			sourceMode: "turn_digest",
			maxCandidates: 10,
			minConfidence: 0.8,
		});

		expect(result.profileCandidates).toHaveLength(1);
		expect(result.profileCandidates[0]).toMatchObject({
			value: "Release owner: owner@example.com",
			sensitivity: "sensitive",
		});
	});

	it("extracts bounded review-only candidates with accepted San Loop provenance", () => {
		const result = extractSanBrainCandidates({
			digest,
			digestEntryId: "digest-entry",
			entries: sourceEntries(),
			sourceMode: "turn_digest",
			maxCandidates: 3,
			minConfidence: 0.8,
		});

		expect(result.profileCandidates).toHaveLength(2);
		expect(result.experienceCandidates).toHaveLength(1);
		expect(result.profileCandidates[0]?.evidence[0]).toMatchObject({
			digestEntryIds: ["digest-entry"],
			entryIds: ["user-entry", "assistant-entry", "run-entry", "review-entry"],
			loopRefs: [
				{
					runId: "run-1",
					assignmentId: "assignment-1",
					attemptId: "attempt-1",
					reviewId: "review-1",
					accepted: true,
				},
			],
			summary: "turn_digest: Implement deterministic Brain capture.",
		});
		expect(result.profileCandidates.every(candidate => candidate.confidence >= 0.8)).toBe(true);
	});

	it("persists each deterministic candidate once across repeated capture", () => {
		const entries = sourceEntries();
		let sequence = 0;
		const sessionManager = {
			getEntries: () => entries,
			appendCustomEntry: (customType: string, data?: unknown) => {
				const id = `brain-entry-${++sequence}`;
				entries.push(customEntry(id, customType, data, entries.at(-1)?.id ?? null));
				return id;
			},
		} as unknown as ReadonlySessionManager;
		const options = {
			digest,
			digestEntryId: "digest-entry",
			sourceMode: "turn_digest" as const,
			maxCandidates: 10,
			minConfidence: 0.8,
		};

		const first = captureSanBrainTurn(sessionManager, options);
		const second = captureSanBrainTurn(sessionManager, options);

		expect(first).toMatchObject({ profileCandidates: 2, experienceCandidates: 5 });
		expect(second).toEqual({ profileCandidates: 0, experienceCandidates: 0, entryIds: [] });
		expect(
			entries.flatMap(entry =>
				entry.type === "custom" && entry.customType === BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE
					? [(entry.data as { type: string }).type]
					: [],
			),
		).toEqual(["workflow_pattern", "skill_candidate", "failure_posture", "check_candidate", "recall"]);
		expect(
			entries.filter(entry => entry.type === "custom" && entry.customType === BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE),
		).toHaveLength(2);
		expect(
			entries.filter(
				entry => entry.type === "custom" && entry.customType === BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
			),
		).toHaveLength(5);
	});
});
