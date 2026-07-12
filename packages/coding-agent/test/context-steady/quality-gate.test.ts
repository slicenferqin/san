/**
 * ContextPlan quality-gate contract tests.
 */

import { describe, expect, test } from "bun:test";
import type { ContextSourceIndex } from "../../src/context-steady/plan-types";
import { evaluateContextPlanQualityGate } from "../../src/context-steady/quality-gate";

function sourceIndex(entryIds: string[]): ContextSourceIndex {
	return {
		exactEntries: [],
		turnBundles: [],
		toolPairs: [
			{
				kind: "tool_pair",
				entryIds: ["a-tool", "tr-tool"],
				toolCallId: "tc-1",
				toolName: "read",
				assistantEntryId: "a-tool",
				resultEntryId: "tr-tool",
				complete: true,
			},
			{
				kind: "tool_pair",
				entryIds: ["a-open"],
				toolCallId: "tc-open",
				toolName: "edit",
				assistantEntryId: "a-open",
				complete: false,
			},
		],
		fileEvidence: [],
		attachments: [],
		digests: [],
		checkpoints: [],
		entryIds,
	};
}

describe("evaluateContextPlanQualityGate", () => {
	test("protects current prompt, live tail, explicit requirements, and active tool pair entries", () => {
		const result = evaluateContextPlanQualityGate({
			sourceIndex: sourceIndex(["spec", "prompt", "tail", "a-tool", "tr-tool", "a-open"]),
			baseRequiredEntryRefs: ["spec"],
			currentPromptEntryRefs: ["prompt"],
			liveTailEntryRefs: ["tail"],
			activeToolCallIds: ["tc-1"],
			messageBudget: 100_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			nonMessageTokens: 20_000,
		});

		expect(result.outcome).toBe("pass");
		expect(result.protectedEntryRefs).toEqual(["spec", "prompt", "tail", "a-tool", "tr-tool"]);
		expect(result.missingEntryRefs).toEqual([]);
	});

	test("protects incomplete tool pairs even without explicit active tool ids", () => {
		const result = evaluateContextPlanQualityGate({
			sourceIndex: sourceIndex(["a-open"]),
			messageBudget: 100_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			nonMessageTokens: 20_000,
		});

		expect(result.outcome).toBe("pass");
		expect(result.protectedEntryRefs).toEqual(["a-open"]);
	});

	test("requires burst when protected entries exceed steady message budget but fit burst", () => {
		const result = evaluateContextPlanQualityGate({
			sourceIndex: sourceIndex(["spec", "prompt", "a-open"]),
			baseRequiredEntryRefs: ["spec"],
			currentPromptEntryRefs: ["prompt"],
			tokenEstimateByEntryRef: new Map([
				["spec", 180_000],
				["prompt", 80_000],
			]),
			messageBudget: 240_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			nonMessageTokens: 20_000,
		});

		expect(result.outcome).toBe("burst_required");
		expect(result.reasons).toEqual([
			"protected_entries_exceed_message_budget",
			"protected_entries_exceed_control_band",
		]);
		expect(result.requiredBurstTokens).toBe(20_000);
	});

	test("reports hard pressure for missing required refs or burst overflow", () => {
		const missing = evaluateContextPlanQualityGate({
			sourceIndex: sourceIndex(["prompt", "a-open"]),
			baseRequiredEntryRefs: ["missing-spec"],
			currentPromptEntryRefs: ["prompt"],
			messageBudget: 240_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			nonMessageTokens: 20_000,
		});
		const overflow = evaluateContextPlanQualityGate({
			sourceIndex: sourceIndex(["spec", "prompt", "a-open"]),
			baseRequiredEntryRefs: ["spec"],
			currentPromptEntryRefs: ["prompt"],
			tokenEstimateByEntryRef: new Map([
				["spec", 250_000],
				["prompt", 80_000],
			]),
			messageBudget: 240_000,
			controlMax: 260_000,
			burstCeiling: 320_000,
			nonMessageTokens: 20_000,
		});

		expect(missing.outcome).toBe("hard_pressure");
		expect(missing.missingEntryRefs).toEqual(["missing-spec"]);
		expect(overflow.outcome).toBe("hard_pressure");
		expect(overflow.reasons).toContain("protected_entries_exceed_burst_ceiling");
	});
});
