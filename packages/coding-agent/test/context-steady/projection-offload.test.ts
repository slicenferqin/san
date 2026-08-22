/**
 * M4 projection offload contracts: aged tool-output stubs, image-block
 * substitution, and orphan-audit compatibility for content-substituted messages.
 */

import { describe, expect, test } from "bun:test";
import { auditProjectionCoverage, materializeContextPlanMessages } from "../../src/context-steady/materialize";
import { buildContextPlan } from "../../src/context-steady/planner";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextPlan>[0]["entries"];
const asMessages = (messages: Record<string, unknown>[]) =>
	messages as unknown as Parameters<typeof materializeContextPlanMessages>[0];

const messageOf = (entry: unknown) => (entry as { message: Record<string, unknown> }).message;

function toolCallAssistant(id: string, callId: string, toolName: string, path: string): Record<string, unknown> {
	return messageEntry(id, {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: toolName, arguments: { path } }],
		timestamp: Date.now(),
		provider: "x",
		model: "x",
	});
}

function toolResultEntry(
	id: string,
	callId: string,
	toolName: string,
	text: string,
	timestamp: number,
): Record<string, unknown> {
	return messageEntry(id, {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		timestamp,
	});
}

describe("M4 projection offload", () => {
	test("stubs old large tool outputs with a re-readable reference and passes the orphan audit", () => {
		const oldOutput = `old file body ${"x".repeat(4000)}`;
		const recentOutput = `recent file body ${"y".repeat(4000)}`;
		const entries = asEntries([
			toolCallAssistant("a1", "c1", "read", "old.txt"),
			toolResultEntry("r1", "c1", "read", oldOutput, 1),
			toolCallAssistant("a2", "c2", "read", "recent.txt"),
			toolResultEntry("r2", "c2", "read", recentOutput, 2),
			messageEntry("u1", { role: "user", content: "Continue", timestamp: 3, provider: "x", model: "x" }),
		]);
		const messages = asMessages(entries.map(messageOf));

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u1"],
			baseRequiredEntryRefs: ["a2", "r2"],
			tokenEstimateByEntryRef: new Map([
				["r1", 3000],
				["r2", 3000],
			]),
			toolOutputOffload: { minTokens: 2000 },
		});

		const aged = plan.materials.filter(material => "stubKind" in material && material.stubKind === "aged");
		expect(aged).toHaveLength(1);
		expect((aged[0] as { resultEntryId: string }).resultEntryId).toBe("r1");

		const projected = materializeContextPlanMessages(messages, entries, plan);
		const text = JSON.stringify(projected);
		expect(text).toContain("earlier read output withheld");
		expect(text).toContain("old.txt");
		expect(text).not.toContain("old file body");
		// Protected recent output ships verbatim.
		expect(text).toContain("recent file body");

		// Same-message substitution must still count as present in the orphan audit.
		const audit = auditProjectionCoverage(projected, entries, plan);
		expect(audit.missingProjectableRefs).toEqual([]);
		expect(audit.stubbedRefs).toEqual(["r1"]);
	});

	test("respects the aged-offload reclaim budget", () => {
		const entries = asEntries([
			toolCallAssistant("a1", "c1", "read", "one.txt"),
			toolResultEntry("r1", "c1", "read", "x".repeat(4000), 1),
			toolCallAssistant("a2", "c2", "read", "two.txt"),
			toolResultEntry("r2", "c2", "read", "y".repeat(4000), 2),
			messageEntry("u1", { role: "user", content: "Continue", timestamp: 3, provider: "x", model: "x" }),
		]);

		// Tiny quality window ⇒ messageBudget/4 budget fits only one reclaim.
		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: { ...SETTINGS, qualityWindowTokens: 4_000 },
			contextWindow: 500_000,
			nonMessageTokens: 2_000,
			currentPromptEntryRefs: ["u1"],
			tokenEstimateByEntryRef: new Map([
				["r1", 3000],
				["r2", 3000],
			]),
			toolOutputOffload: { minTokens: 2000 },
		});

		const aged = plan.materials.filter(material => "stubKind" in material && material.stubKind === "aged");
		expect(aged).toHaveLength(1);
		expect((aged[0] as { resultEntryId: string }).resultEntryId).toBe("r1");
	});

	test("offloads earlier-turn image blocks while keeping the current turn verbatim", () => {
		const oldUser = {
			role: "user",
			content: [
				{ type: "text", text: "old turn with an image" },
				{ type: "image", data: "QUJD", mimeType: "image/png" },
			],
			timestamp: 1,
			provider: "x",
			model: "x",
		};
		const currentUser = {
			role: "user",
			content: [
				{ type: "text", text: "current turn with an image" },
				{ type: "image", data: "REVO", mimeType: "image/png" },
			],
			timestamp: 2,
			provider: "x",
			model: "x",
		};
		const entries = asEntries([messageEntry("u1", oldUser), messageEntry("u2", currentUser)]);

		const plan = buildContextPlan({
			entries,
			sessionId: "s1",
			requestKey: "r1",
			epochId: "e1",
			promptGeneration: 2,
			settings: SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 20_000,
			currentPromptEntryRefs: ["u2"],
			offloadAgedImages: true,
		});

		const projected = materializeContextPlanMessages(asMessages([oldUser, currentUser]), entries, plan);
		const text = JSON.stringify(projected);
		expect(text).toContain("image attachment from an earlier turn withheld");
		expect(text).not.toContain("QUJD");
		// Current-turn image ships verbatim.
		expect(text).toContain("REVO");
		// Journal untouched: the original entry still carries the image block.
		const original = messageOf(entries[0]) as unknown as { content: Array<{ type: string }> };
		expect(original.content.some(block => block.type === "image")).toBe(true);

		const audit = auditProjectionCoverage(projected, entries, plan);
		expect(audit.missingProjectableRefs).toEqual([]);
	});
});
