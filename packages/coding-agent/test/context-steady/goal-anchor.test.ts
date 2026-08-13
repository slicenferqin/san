/**
 * Goal anchor material (goal-fidelity plan A).
 *
 * Contract: when the host injects the immutable objective, the plan renders a
 * host-pinned goal block at the top of the plan message on every request; the
 * anchor never competes with content materials for budget (fit drops
 * recall/digest/checkpoint, never the anchor); no anchor input → byte-identical
 * previous behavior.
 */

import { describe, expect, test } from "bun:test";
import { buildContextPlan } from "../../src/context-steady/planner";
import type { TurnDigest } from "../../src/context-steady/types";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION } from "../../src/context-steady/types";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

function digest(turnId: string, fromEntryId: string, toEntryId: string, nextSteps: string[] = []): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: "2026-08-13T00:00:00.000Z",
		source: { sessionId: "s1", fromEntryId, toEntryId, promptGeneration: 1 },
		userIntent: `intent ${turnId}`,
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps,
		memoryCandidates: [],
		fallback: false,
	};
}

type PlanEntries = Parameters<typeof buildContextPlan>[0]["entries"];

function baseEntries(): Record<string, unknown>[] {
	return [
		messageEntry("u1", { role: "user", content: "old request", timestamp: 1 }),
		messageEntry("a1", { role: "assistant", content: "old answer", timestamp: 2 }),
		customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "u1", "a1", ["wire the anchor", "run tests"])),
		messageEntry("u2", { role: "user", content: "current prompt", timestamp: 9 }),
	];
}

function plan(
	goalAnchor?: { objective: string; todoLines?: string[]; pendingGates?: string[] },
	budgetOverride?: number,
) {
	return buildContextPlan({
		entries: baseEntries() as unknown as PlanEntries,
		sessionId: "s1",
		requestKey: "r1",
		epochId: "e1",
		promptGeneration: 2,
		settings: budgetOverride === undefined ? SETTINGS : { ...SETTINGS, planMaxTokens: budgetOverride },
		contextWindow: 500_000,
		nonMessageTokens: 20_000,
		currentPromptEntryRefs: ["u2"],
		goalAnchor,
	});
}

describe("goal anchor material", () => {
	test("renders the host-pinned objective, progress, gates, and next steps at the top of the plan", () => {
		const built = plan({
			objective: "重构解析器并保持所有测试通过",
			todoLines: ["[x] locate parser", "[ ] refactor tokenize"],
			pendingGates: ["same command flips to passing"],
		});
		const anchorAudit = built.audit.materials.find(material => material.kind === "goal_anchor");
		expect(anchorAudit?.representation).toBe("exact");
		expect(built.renderedContent).toContain("host-pinned");
		expect(built.renderedContent).toContain("重构解析器并保持所有测试通过");
		expect(built.renderedContent).toContain("[ ] refactor tokenize");
		expect(built.renderedContent).toContain("same command flips to passing");
		// nextSteps 由 planner 从最新 digest 补充。
		expect(built.renderedContent).toContain("wire the anchor");
		// 锚在渲染内容中先于 digest 区块出现。
		expect(built.renderedContent.indexOf("host-pinned")).toBeLessThan(
			built.renderedContent.indexOf("Recent turn digests"),
		);
	});

	test("no anchor input or empty objective produces no anchor material", () => {
		expect(plan(undefined).audit.materials.some(material => material.kind === "goal_anchor")).toBe(false);
		expect(plan({ objective: "   " }).audit.materials.some(material => material.kind === "goal_anchor")).toBe(false);
	});

	test("survives budget fitting that drops every content material", () => {
		// Budget small enough that recall/digests/checkpoints all get dropped.
		const built = plan({ objective: "the goal must survive" }, 1);
		const kinds = built.materials.map(material => material.audit.kind);
		expect(kinds).toContain("goal_anchor");
		expect(kinds).not.toContain("turn_digest");
		expect(built.renderedContent).toContain("the goal must survive");
	});

	test("clamps oversized anchor inputs to keep the anchor small", () => {
		const built = plan({
			objective: "x".repeat(2_000),
			todoLines: Array.from({ length: 30 }, (_, index) => `[ ] task ${index} ${"y".repeat(300)}`),
		});
		const anchor = built.materials.find(material => material.audit.kind === "goal_anchor");
		if (!anchor || !("objective" in anchor)) throw new Error("anchor material missing");
		expect(anchor.objective.length).toBeLessThanOrEqual(480);
		expect(anchor.todoLines.length).toBeLessThanOrEqual(8);
		for (const line of anchor.todoLines) expect(line.length).toBeLessThanOrEqual(160);
	});
});
