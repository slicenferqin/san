import { describe, expect, it } from "bun:test";
import { buildSanBrainStatePrelude } from "@san/coding-agent/brain/activation";
import { applySanBrainMutation } from "@san/coding-agent/brain/commands";
import { appendSanBrainExperienceCandidate } from "@san/coding-agent/brain/ledger";
import { buildSanBrainRecallPlan } from "@san/coding-agent/brain/recall";
import { type SanBrainActiveStateRecord, SanBrainStore } from "@san/coding-agent/brain/store";
import type { SanBrainExperienceCandidate } from "@san/coding-agent/brain/types";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

const createdAt = "2026-07-11T08:00:00.000Z";

function recallRecord(
	candidateId: string,
	queryTemplateId: string,
	overrides: Partial<SanBrainExperienceCandidate> = {},
): SanBrainActiveStateRecord {
	const candidate: SanBrainExperienceCandidate = {
		schemaVersion: 1,
		candidateId,
		scope: { kind: "repo", key: "/repo", resolverVersion: 1 },
		type: "recall",
		selector: { roles: ["primary"], taskFamilies: ["release"] },
		action: { kind: "recall_policy", queryTemplateId },
		taskTags: ["release"],
		claimKey: `${candidateId}:claim`,
		dedupeKey: `${candidateId}:dedupe`,
		conflictKey: `${candidateId}:conflict`,
		repeatCount: 2,
		confidence: 0.94,
		impact: "low",
		sensitivity: "normal",
		evidence: [],
		createdAt,
		...overrides,
	};
	return {
		kind: "experience",
		candidate,
		revision: 1,
		decisionId: `${candidateId}:decision`,
		updatedAt: createdAt,
	};
}

const options = {
	role: "primary" as const,
	scopes: [{ kind: "repo" as const, key: "/repo", resolverVersion: 1 as const }],
	promptText: "Review the release failure and run the required checks.",
	baseQuery: "Current prompt:\nReview the release failure and run the required checks.",
	maxItems: 3,
	tokenBudget: 1000,
	minConfidence: 0.75,
};

describe("San Brain M6 policy-aware recall", () => {
	it("uses the highest-ranked allowlisted policy and records skipped policies", () => {
		const selected = recallRecord("risk-history", "risk-history-v1");
		const unknown = recallRecord("unknown", "free-form-history-query");
		const wrongRole = recallRecord("worker-only", "task-relevant-v1", {
			selector: { roles: ["worker"], taskFamilies: ["release"] },
		});

		const plan = buildSanBrainRecallPlan([unknown, wrongRole, selected], options);

		expect(plan.suppressed).toBe(false);
		expect(plan.policyVersion).toBe("brain-m6-recall-v1");
		expect(plan.selectedPolicyIds).toEqual(["risk-history"]);
		expect(plan.queryTemplateId).toBe("risk-history-v1");
		expect(plan.memoryTypes).toEqual(["episodic", "fact"]);
		expect(plan.query).toContain("Review the release failure");
		expect(plan.query).toContain("Prior failures, recovery outcomes, and required checks");
		expect(plan.skipReasons).toEqual(
			expect.arrayContaining([
				{ ownerId: "unknown", reason: "unknown_template" },
				{ ownerId: "worker-only", reason: "role_mismatch" },
			]),
		);
	});

	it("suppresses recall when the current user disables Brain history", () => {
		const plan = buildSanBrainRecallPlan([recallRecord("task", "task-relevant-v1")], {
			...options,
			promptText: "Ignore Brain memory and use only the current repository state.",
			baseQuery: "Ignore Brain memory and use only the current repository state.",
		});

		expect(plan.suppressed).toBe(true);
		expect(plan.query).toBeUndefined();
		expect(plan.selectedPolicyIds).toEqual([]);
		expect(plan.skipReasons).toContainEqual({ ownerId: "task", reason: "current_user_conflict" });
	});

	it("keeps recall policies out of the rendered Brain instruction prelude", () => {
		const built = buildSanBrainStatePrelude([recallRecord("task", "task-relevant-v1")], {
			sessionId: "session-1",
			turnId: "turn-1",
			role: options.role,
			scopes: options.scopes,
			promptText: options.promptText,
			maxItems: 8,
			maxTokens: 1200,
			minConfidence: options.minConfidence,
			createdAt,
		});

		expect(built.content).toBeUndefined();
		expect(built.activation.selectedRules).toEqual([]);
	});

	it("does not fall back to unrelated recall when governed policies do not match", () => {
		const plan = buildSanBrainRecallPlan([recallRecord("task", "task-relevant-v1")], {
			...options,
			promptText: "Explain this TypeScript type error.",
			baseQuery: "Current prompt:\nExplain this TypeScript type error.",
		});

		expect(plan.suppressed).toBe(false);
		expect(plan.query).toBeUndefined();
		expect(plan.selectedPolicyIds).toEqual([]);
		expect(plan.skipReasons).toContainEqual({ ownerId: "task", reason: "selector_mismatch" });
	});

	it("preserves general recall when every policy is outside the current scope", () => {
		const plan = buildSanBrainRecallPlan(
			[
				recallRecord("other-repo", "task-relevant-v1", {
					scope: { kind: "repo", key: "/other", resolverVersion: 1 },
				}),
			],
			options,
		);

		expect(plan.query).toBe(options.baseQuery);
		expect(plan.selectedPolicyIds).toEqual([]);
		expect(plan.skipReasons).toContainEqual({ ownerId: "other-repo", reason: "scope_mismatch" });
	});

	it("rejects approval of a non-allowlisted recall template", () => {
		using tempDir = TempDir.createSync("@san-brain-recall-allowlist-");
		const manager = SessionManager.inMemory(tempDir.path());
		const store = new SanBrainStore(tempDir.join("brain.sqlite"));
		try {
			const candidate = recallRecord("unknown-policy", "free-form-history-query").candidate;
			if (!("selector" in candidate)) throw new Error("Expected an experience candidate.");
			appendSanBrainExperienceCandidate(manager, candidate);
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());

			expect(() => applySanBrainMutation(store, manager, { action: "approve", id: candidate.candidateId })).toThrow(
				"Unknown San Brain recall template: free-form-history-query.",
			);
			expect(store.getCandidate(candidate.candidateId)?.status).toBe("pending");
		} finally {
			store.close();
		}
	});
});
