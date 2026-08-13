/**
 * Superseded-edit representation downgrade (magic-context study §4.4).
 *
 * Contract: when the same file has a later complete mutation, the older
 * mutation's toolResult is substituted with a small stub at materialization
 * time — pairing preserved, message not omitted, coverage untouched.
 */

import { describe, expect, test } from "bun:test";
import { materializeContextPlanMessages } from "../../src/context-steady/materialize";
import { buildContextPlan } from "../../src/context-steady/planner";
import { buildContextSourceIndex } from "../../src/context-steady/source-index";

const SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 240_000,
	burstWindowTokens: 320_000,
};

function messageEntry(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function editCall(toolCallId: string, path: string) {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: toolCallId, name: "edit", arguments: { path, old_string: "a", new_string: "b" } },
		],
		timestamp: Date.now(),
		provider: "x",
		model: "x",
	};
}

function editResult(toolCallId: string, text: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "edit",
		content: [{ type: "text", text }],
		details: { diff: text },
		timestamp: Date.now(),
	};
}

function bashCall(toolCallId: string, command: string) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command } }],
		timestamp: Date.now(),
		provider: "x",
		model: "x",
	};
}

type PlanEntries = Parameters<typeof buildContextPlan>[0]["entries"];
type PlanMessages = Parameters<typeof materializeContextPlanMessages>[0];

function scenario() {
	const user = { role: "user", content: "fix app.ts twice", timestamp: 1, provider: "x", model: "x" };
	const edit1 = editCall("tc-1", "src/app.ts");
	const result1 = editResult("tc-1", "edited v1 intermediate diff");
	const edit2 = editCall("tc-2", "src/app.ts");
	const result2 = editResult("tc-2", "edited v2 final diff");
	const editOther = editCall("tc-3", "src/other.ts");
	const resultOther = editResult("tc-3", "edited other diff");
	const bash = bashCall("tc-4", "bun test");
	const bashResult = {
		role: "toolResult",
		toolCallId: "tc-4",
		toolName: "bash",
		content: [{ type: "text", text: "bash output once" }],
		timestamp: Date.now(),
	};
	const currentUser = { role: "user", content: "current prompt", timestamp: 99, provider: "x", model: "x" };
	const messages = [user, edit1, result1, edit2, result2, editOther, resultOther, bash, bashResult, currentUser];
	const entries = [
		messageEntry("u1", user),
		messageEntry("a1", edit1),
		messageEntry("r1", result1),
		messageEntry("a2", edit2),
		messageEntry("r2", result2),
		messageEntry("a3", editOther),
		messageEntry("r3", resultOther),
		messageEntry("a4", bash),
		messageEntry("r4", bashResult),
		messageEntry("u2", currentUser),
	] as unknown as PlanEntries;
	return { entries, messages: messages as unknown as PlanMessages };
}

describe("source index superseded mutation marking", () => {
	test("marks only earlier complete mutations of the same path", () => {
		const { entries } = scenario();
		const index = buildContextSourceIndex(entries);
		const byCallId = new Map(index.toolPairs.map(pair => [pair.toolCallId, pair]));
		expect(byCallId.get("tc-1")?.supersededByToolCallId).toBe("tc-2");
		expect(byCallId.get("tc-1")?.path).toBe("src/app.ts");
		expect(byCallId.get("tc-2")?.supersededByToolCallId).toBeUndefined();
		expect(byCallId.get("tc-3")?.supersededByToolCallId).toBeUndefined();
		expect(byCallId.get("tc-4")?.supersededByToolCallId).toBeUndefined();
	});

	test("never marks an incomplete pair even when a later mutation exists", () => {
		const edit1 = editCall("tc-1", "src/app.ts");
		const edit2 = editCall("tc-2", "src/app.ts");
		const result2 = editResult("tc-2", "v2");
		const entries = [
			messageEntry("a1", edit1),
			// tc-1 has no result — open arc, must stay untouched.
			messageEntry("a2", edit2),
			messageEntry("r2", result2),
		] as unknown as PlanEntries;
		const index = buildContextSourceIndex(entries);
		const open = index.toolPairs.find(pair => pair.toolCallId === "tc-1");
		expect(open?.complete).toBe(false);
		expect(open?.supersededByToolCallId).toBeUndefined();
	});
});

describe("plan materialization with tool stubs", () => {
	test("substitutes the superseded toolResult with a stub, preserving pairing and everything else", () => {
		const { entries, messages } = scenario();
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
		});

		const stubAudits = plan.audit.materials.filter(material => material.materialId.startsWith("tool_stub_"));
		expect(stubAudits).toHaveLength(1);
		expect(stubAudits[0]?.representation).toBe("evidence_stub");
		expect(stubAudits[0]?.entryRefs).toEqual(["r1"]);
		// Stubs never authorize omission: coverage must not claim r1.
		expect(plan.coverageEntryRefs).not.toContain("r1");

		const projected = materializeContextPlanMessages(messages, entries, plan);
		// Substitution, not omission: same number of messages plus the plan message.
		expect(projected.length).toBe(messages.length + 1);
		const substituted = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-1");
		expect(substituted).toBeDefined();
		const substitutedText = JSON.stringify(substituted);
		expect(substitutedText).toContain("superseded");
		expect(substitutedText).toContain("src/app.ts");
		expect(substitutedText).not.toContain("edited v1 intermediate diff");

		const latest = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-2");
		expect(JSON.stringify(latest)).toContain("edited v2 final diff");
		const other = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-3");
		expect(JSON.stringify(other)).toContain("edited other diff");
	});

	test("substitutes via content key when message objects are clones of the journal entries", () => {
		const { entries, messages } = scenario();
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
		});
		const cloned = (messages as unknown as Record<string, unknown>[]).map(message => ({
			...message,
		})) as unknown as PlanMessages;
		const projected = materializeContextPlanMessages(cloned, entries, plan);
		const substituted = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-1");
		expect(JSON.stringify(substituted)).toContain("superseded");
	});

	test("protected entries are never stubbed", () => {
		const { entries, messages } = scenario();
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
			baseRequiredEntryRefs: ["r1"],
		});
		expect(plan.audit.materials.some(material => material.materialId.startsWith("tool_stub_"))).toBe(false);
		const projected = materializeContextPlanMessages(messages, entries, plan);
		const kept = projected.find(message => message.role === "toolResult" && message.toolCallId === "tc-1");
		expect(JSON.stringify(kept)).toContain("edited v1 intermediate diff");
	});
});
