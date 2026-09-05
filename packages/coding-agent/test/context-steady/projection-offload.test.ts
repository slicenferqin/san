/**
 * M4 projection offload contracts: aged tool-output stubs, image-block
 * substitution, and orphan-audit compatibility for content-substituted messages.
 */

import { describe, expect, test } from "bun:test";
import {
	auditProjectionCoverage,
	contextWireSequenceTokens,
	materializeContextPlanMessages,
	wireSequencePrefixRetained,
} from "../../src/context-steady/materialize";
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
	test("aged stub substitution breaks wire-prefix retention but not the rendered plan", () => {
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
		const planOptions = {
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
		};

		// Same transcript, same budget: the only difference is whether aged
		// offload is eligible to stub `r1`.
		const withoutOffload = buildContextPlan(planOptions);
		const withOffload = buildContextPlan({ ...planOptions, toolOutputOffload: { minTokens: 2000 } });
		expect(withoutOffload.materials.some(m => "stubKind" in m && m.stubKind === "aged")).toBe(false);
		expect(withOffload.materials.some(m => "stubKind" in m && m.stubKind === "aged")).toBe(true);

		const baseline = materializeContextPlanMessages(messages, entries, withoutOffload);
		const stubbed = materializeContextPlanMessages(messages, entries, withOffload);

		// The stub really did rewrite an earlier message's wire bytes, which is
		// what voids a provider prefix cache mid-transcript.
		expect(JSON.stringify(baseline)).toContain("old file body");
		expect(JSON.stringify(stubbed)).not.toContain("old file body");

		// Regression guard: the rendered plan text — the only projection input the
		// probe fingerprint hashes — cannot see this rewrite, so retention of the
		// shipped sequence is the signal that must move.
		expect(withOffload.renderedContent).toBe(withoutOffload.renderedContent);
		expect(wireSequencePrefixRetained(contextWireSequenceTokens(baseline), contextWireSequenceTokens(stubbed))).toBe(
			false,
		);

		// Appending a turn to an unrewritten sequence keeps the prefix, or every
		// request would look churned and the signal would be worthless.
		const appended = [...baseline, { role: "user", content: "next", timestamp: 4 }] as typeof baseline;
		expect(wireSequencePrefixRetained(contextWireSequenceTokens(baseline), contextWireSequenceTokens(appended))).toBe(
			true,
		);
	});

	test("stubs the older exact duplicate read while preserving journal entries", () => {
		const duplicateText = "same source snapshot ".repeat(500);
		const entries = asEntries([
			toolCallAssistant("a1", "c1", "read", "src/app.ts"),
			toolResultEntry("r1", "c1", "read", duplicateText, 1),
			toolCallAssistant("a2", "c2", "read", "src/app.ts"),
			toolResultEntry("r2", "c2", "read", duplicateText, 2),
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
			// Every pair is quality-protected; identical snapshots still retain one exact representative.
			baseRequiredEntryRefs: ["a1", "r1", "a2", "r2"],
			tokenEstimateByEntryRef: new Map([
				["r1", 1_000],
				["r2", 1_000],
			]),
			toolOutputOffload: { minTokens: 2_000 },
		});

		expect(
			plan.materials.filter(material => "stubKind" in material && material.stubKind === "duplicate"),
		).toHaveLength(1);
		const projected = materializeContextPlanMessages(messages, entries, plan);
		const body = JSON.stringify(projected);
		expect(body.split(duplicateText).length - 1).toBe(1);
		expect(body).toContain("src/app.ts");
		// Projection-only rewrite must not alter the append-only journal.
		expect(JSON.stringify(entries)).toContain(duplicateText);
		expect(auditProjectionCoverage(projected, entries, plan).missingProjectableRefs).toEqual([]);
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
