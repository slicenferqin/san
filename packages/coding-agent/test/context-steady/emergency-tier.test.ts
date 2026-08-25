/**
 * Emergency stub downgrade tier (magic-context study §4.3).
 *
 * Contract: when projected input exceeds the burst ceiling but the excess is
 * reclaimable by stubbing non-protected completed tool outputs (oldest
 * first), the quality gate downgrades hard_pressure to burst_required and
 * names the stubbed entries. Protected-set overflow and missing required
 * entries stay fail-closed. The planner turns the named entries into
 * emergency tool_stub materials rendered with the pressure template.
 */

import { describe, expect, test } from "bun:test";
import { materializeContextPlanMessages } from "../../src/context-steady/materialize";
import type { ContextSourceIndex } from "../../src/context-steady/plan-types";
import { buildContextPlan } from "../../src/context-steady/planner";
import { evaluateContextPlanQualityGate } from "../../src/context-steady/quality-gate";

function sourceIndexWithPairs(
	pairs: Array<{ toolCallId: string; resultEntryId?: string; complete?: boolean; entryIds?: string[] }>,
	extraEntryIds: string[] = [],
): ContextSourceIndex {
	const entryIds = [
		...new Set([
			...pairs.flatMap(pair => pair.entryIds ?? []),
			...pairs.flatMap(p => (p.resultEntryId ? [p.resultEntryId] : [])),
			...extraEntryIds,
		]),
	];
	return {
		exactEntries: [],
		turnBundles: [],
		toolPairs: pairs.map(pair => ({
			kind: "tool_pair",
			entryIds: pair.entryIds ?? (pair.resultEntryId ? [pair.resultEntryId] : []),
			toolCallId: pair.toolCallId,
			resultEntryId: pair.resultEntryId,
			complete: pair.complete ?? true,
		})),
		fileEvidence: [],
		attachments: [],
		digests: [],
		checkpoints: [],
		entryIds,
	};
}

const GATE_BUDGET = {
	messageBudget: 100_000,
	controlMax: 110_000,
	burstCeiling: 120_000,
	nonMessageTokens: 10_000,
};

describe("quality gate emergency downgrade", () => {
	test("downgrades recoverable projected overflow to burst_required and names the stubbed entries", () => {
		const sourceIndex = sourceIndexWithPairs(
			[
				{ toolCallId: "tc-1", resultEntryId: "r1", entryIds: ["a1", "r1"] },
				{ toolCallId: "tc-2", resultEntryId: "r2", entryIds: ["a2", "r2"] },
				{ toolCallId: "tc-3", resultEntryId: "r3", entryIds: ["a3", "r3"] },
			],
			["u-now"],
		);
		const gate = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["u-now"],
			tokenEstimateByEntryRef: new Map([
				["r1", 4_000],
				["r2", 4_000],
				["r3", 4_000],
			]),
			projectedInputTokens: 125_000,
			...GATE_BUDGET,
		});
		expect(gate.outcome).toBe("burst_required");
		expect(gate.reasons).toContain("emergency_tool_stub_downgrade");
		// Deficit is 5k; the first two pairs (oldest first) reclaim ~7.9k — enough,
		// so the third stays untouched.
		expect(gate.emergencyStubEntryRefs).toEqual(["r1", "r2"]);
		expect(gate.emergencyStubReclaimedTokens).toBeGreaterThan(5_000);
	});

	test("downgrades when emergency stubs exactly cover the projected deficit", () => {
		const sourceIndex = sourceIndexWithPairs(
			[
				{ toolCallId: "tc-1", resultEntryId: "r1", entryIds: ["a1", "r1"] },
				{ toolCallId: "tc-2", resultEntryId: "r2", entryIds: ["a2", "r2"] },
			],
			["u-now"],
		);
		const gate = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["u-now"],
			// The first stub costs 40 tokens, so it reclaims exactly the
			// 100-token overflow. Selection must stop before the second pair.
			tokenEstimateByEntryRef: new Map([
				["r1", 140],
				["r2", 1_000],
			]),
			projectedInputTokens: 120_100,
			...GATE_BUDGET,
		});
		expect(gate.outcome).toBe("burst_required");
		expect(gate.emergencyStubEntryRefs).toEqual(["r1"]);
		expect(gate.emergencyStubReclaimedTokens).toBe(100);
	});

	test("stays hard_pressure when reclaimable outputs cannot cover the deficit", () => {
		const sourceIndex = sourceIndexWithPairs(
			[{ toolCallId: "tc-1", resultEntryId: "r1", entryIds: ["a1", "r1"] }],
			["u-now"],
		);
		const gate = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["u-now"],
			tokenEstimateByEntryRef: new Map([["r1", 1_000]]),
			projectedInputTokens: 150_000,
			...GATE_BUDGET,
		});
		expect(gate.outcome).toBe("hard_pressure");
		expect(gate.emergencyStubEntryRefs).toBeUndefined();
	});

	test("never downgrades protected-set overflow or missing required entries", () => {
		const sourceIndex = sourceIndexWithPairs(
			[{ toolCallId: "tc-1", resultEntryId: "r1", entryIds: ["a1", "r1"] }],
			["u-now"],
		);
		const protectedOverflow = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["u-now"],
			tokenEstimateByEntryRef: new Map([
				["u-now", 130_000],
				["r1", 50_000],
			]),
			projectedInputTokens: 125_000,
			...GATE_BUDGET,
		});
		expect(protectedOverflow.outcome).toBe("hard_pressure");
		expect(protectedOverflow.emergencyStubEntryRefs).toBeUndefined();

		const missingRequired = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["ghost-entry"],
			tokenEstimateByEntryRef: new Map([["r1", 50_000]]),
			projectedInputTokens: 125_000,
			...GATE_BUDGET,
		});
		expect(missingRequired.outcome).toBe("hard_pressure");
		expect(missingRequired.emergencyStubEntryRefs).toBeUndefined();
	});

	test("skips protected and incomplete pairs when selecting candidates", () => {
		const sourceIndex = sourceIndexWithPairs(
			[
				{ toolCallId: "tc-open", resultEntryId: undefined, complete: false, entryIds: ["a0"] },
				{ toolCallId: "tc-protected", resultEntryId: "rp", entryIds: ["ap", "rp"] },
				{ toolCallId: "tc-free", resultEntryId: "rf", entryIds: ["af", "rf"] },
			],
			["u-now"],
		);
		const gate = evaluateContextPlanQualityGate({
			sourceIndex,
			currentPromptEntryRefs: ["u-now"],
			baseRequiredEntryRefs: ["rp"],
			tokenEstimateByEntryRef: new Map([
				["rp", 50_000],
				["rf", 10_000],
			]),
			projectedInputTokens: 125_000,
			...GATE_BUDGET,
		});
		expect(gate.outcome).toBe("burst_required");
		expect(gate.emergencyStubEntryRefs).toEqual(["rf"]);
	});
});

describe("plan-level emergency stubbing", () => {
	function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
		return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
	}

	type PlanEntries = Parameters<typeof buildContextPlan>[0]["entries"];
	type PlanMessages = Parameters<typeof materializeContextPlanMessages>[0];

	test("materializes emergency stubs with the pressure template", () => {
		const user = { role: "user", content: "long session", timestamp: 1 };
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "bun test" } }],
			timestamp: 2,
		};
		const result = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "huge old bash output" }],
			timestamp: 3,
		};
		const currentUser = { role: "user", content: "current prompt", timestamp: 9 };
		const entries = [
			messageEntry("u1", user),
			messageEntry("a1", call),
			messageEntry("r1", result),
			messageEntry("u2", currentUser),
		] as unknown as PlanEntries;
		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: {
				qualityWindowTokens: 100_000,
				reserveRatio: 0.2,
				planMaxTokens: 100_000,
				burstWindowTokens: 120_000,
			},
			contextWindow: 200_000,
			nonMessageTokens: 10_000,
			currentPromptEntryRefs: ["u2"],
			tokenEstimateByEntryRef: new Map([["r1", 60_000]]),
			projectedInputTokens: 130_000,
		});
		expect(plan.audit.qualityGate.reasons).toContain("emergency_tool_stub_downgrade");
		const stubAudit = plan.audit.materials.find(material => material.materialId === "tool_stub_r1");
		expect(stubAudit?.reason).toContain("emergency pressure downgrade");

		const projected = materializeContextPlanMessages(
			[user, call, result, currentUser] as unknown as PlanMessages,
			entries,
			plan,
		);
		const substituted = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-1");
		const text = JSON.stringify(substituted);
		expect(text).toContain("elided under context pressure");
		expect(text).not.toContain("huge old bash output");
	});
});
