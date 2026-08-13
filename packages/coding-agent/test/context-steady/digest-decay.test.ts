/**
 * Digest decay tiering (magic-context study §4.1, San form).
 *
 * Contract: rendering granularity of digest materials degrades
 * deterministically with age and budget pressure; the newest digest and
 * low-pressure sessions never degrade; anchor/compact views are pure
 * projections of the structured digest (no schema change, old digests
 * fully compatible).
 */

import { describe, expect, test } from "bun:test";
import { projectDigestTier, selectDigestTier } from "../../src/context-steady/decay";
import { buildContextPlan } from "../../src/context-steady/planner";
import type { TurnDigest } from "../../src/context-steady/types";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION } from "../../src/context-steady/types";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

function digest(turnId: string, fromEntryId: string, toEntryId: string, userIntent: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: "2026-08-13T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId, toEntryId, promptGeneration: 1 },
		userIntent,
		actionsTaken: [`unique-action-${turnId}`],
		decisions: [`unique-decision-${turnId}`],
		filesTouched: [{ path: `src/${turnId}.ts`, action: "modified" }],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [`unique-risk-${turnId}`],
		nextSteps: [],
		memoryCandidates: [],
		fallback: false,
	};
}

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

describe("selectDigestTier", () => {
	test("the newest digest never degrades regardless of pressure", () => {
		expect(selectDigestTier(0, 2)).toBe("full");
	});

	test("no degradation below the pressure floor", () => {
		expect(selectDigestTier(50, 0.49)).toBe("full");
		expect(selectDigestTier(50, 0)).toBe("full");
	});

	test("degrades older digests progressively as pressure rises", () => {
		// pressure 0.8: compact from ceil(2.4/0.8)=3, anchor from ceil(4.8/0.8)=6.
		expect(selectDigestTier(2, 0.8)).toBe("full");
		expect(selectDigestTier(3, 0.8)).toBe("compact");
		expect(selectDigestTier(5, 0.8)).toBe("compact");
		expect(selectDigestTier(6, 0.8)).toBe("anchor");
		// Higher pressure pulls the thresholds in: ceil(2.4/1.2)=2, ceil(4.8/1.2)=4.
		expect(selectDigestTier(2, 1.2)).toBe("compact");
		expect(selectDigestTier(4, 1.2)).toBe("anchor");
	});
});

describe("projectDigestTier", () => {
	const sample = digest("t1", "e1", "e2", "refactor the parser");

	test("anchor collapses to a single intent line with file count", () => {
		const view = projectDigestTier(sample, "anchor");
		expect(view.userIntent).toContain("refactor the parser");
		expect(view.userIntent).toContain("1 file");
		expect(view.actionsTaken).toEqual([]);
		expect(view.decisions).toEqual([]);
		expect(view.filesTouched).toEqual([]);
		expect(view.risks).toEqual([]);
	});

	test("compact keeps a bounded core and drops risks", () => {
		const wide = {
			...sample,
			actionsTaken: ["a1", "a2", "a3", "a4"],
			filesTouched: Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, action: "modified" as const })),
		};
		const view = projectDigestTier(wide, "compact");
		expect(view.actionsTaken).toHaveLength(2);
		expect(view.filesTouched).toHaveLength(4);
		expect(view.risks).toEqual([]);
	});

	test("full preserves the current rendering shape", () => {
		const view = projectDigestTier(sample, "full");
		expect(view.actionsTaken).toEqual(["unique-action-t1"]);
		expect(view.risks).toEqual(["unique-risk-t1"]);
	});
});

describe("plan-level decay under pressure", () => {
	function entriesWithDigests(count: number): Record<string, unknown>[] {
		const entries: Record<string, unknown>[] = [];
		for (let index = 1; index <= count; index++) {
			const from = `u${index}`;
			const to = `a${index}`;
			entries.push(
				messageEntry(from, { role: "user", content: `old request ${index}`, timestamp: index * 10 }),
				messageEntry(to, { role: "assistant", content: `old answer ${index}`, timestamp: index * 10 + 1 }),
				customEntry(`d${index}`, TURN_DIGEST_CUSTOM_TYPE, digest(`t${index}`, from, to, `continue task ${index}`)),
			);
		}
		entries.push(messageEntry("u-now", { role: "user", content: "continue the work", timestamp: 999 }));
		return entries;
	}

	type PlanEntries = Parameters<typeof buildContextPlan>[0]["entries"];

	function planAtPressure(highPressure: boolean) {
		const entries = entriesWithDigests(8);
		return buildContextPlan({
			entries: entries as unknown as PlanEntries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u-now"],
			maxDigestMaterials: 8,
			// The production caller passes its projected payload estimate; the
			// decay pressure signal is that projection over the message budget.
			projectedInputTokens: highPressure ? 216_000 : 60_000,
		});
	}

	test("low pressure keeps every digest material at full tier", () => {
		const plan = planAtPressure(false);
		const digestAudits = plan.audit.materials.filter(material => material.kind === "turn_digest");
		expect(digestAudits.length).toBeGreaterThan(0);
		for (const audit of digestAudits) {
			expect(audit.reason).toContain("(tier: full)");
		}
	});

	test("high pressure degrades older digests and elides their detail from the rendered plan", () => {
		const plan = planAtPressure(true);
		const digestAudits = plan.audit.materials.filter(material => material.kind === "turn_digest");
		expect(digestAudits.length).toBeGreaterThan(2);
		const reasons = digestAudits.map(audit => audit.reason);
		expect(reasons.some(reason => reason.includes("(tier: anchor)") || reason.includes("(tier: compact)"))).toBe(
			true,
		);
		// The newest digest stays full even under pressure.
		const newest = digestAudits.at(-1);
		expect(newest?.reason).toContain("(tier: full)");
		// An anchored digest's per-turn detail must not leak into the rendered plan.
		const anchoredIndex = reasons.findIndex(reason => reason.includes("(tier: anchor)"));
		if (anchoredIndex >= 0) {
			const anchoredTurn = anchoredIndex + 1;
			expect(plan.renderedContent).not.toContain(`unique-action-t${anchoredTurn}`);
			expect(plan.renderedContent).toContain(`continue task ${anchoredTurn}`);
		}
	});

	test("tier selection is deterministic across rebuilds", () => {
		const first = planAtPressure(true)
			.audit.materials.filter(material => material.kind === "turn_digest")
			.map(material => material.reason);
		const second = planAtPressure(true)
			.audit.materials.filter(material => material.kind === "turn_digest")
			.map(material => material.reason);
		expect(second).toEqual(first);
	});
});
