import { describe, expect, test } from "bun:test";
import { type AgentMessage, type AgentTool, type AgentToolContext, countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import type { SanBrainRecallPlan } from "../../src/brain/recall";
import type { SanBrainRecallAudit } from "../../src/brain/types";
import { expandDigestSpan } from "../../src/context-steady/expand";
import { searchContextHistory } from "../../src/context-steady/history-search";
import { buildContextPlan } from "../../src/context-steady/planner";
import { recallFromContextBranch } from "../../src/context-steady/recall";
import { runContextSteadyRecall } from "../../src/context-steady/recall-runtime";
import {
	persistContextWorkNotesFromDigest,
	projectActiveContextWorkNotes,
} from "../../src/context-steady/working-notes";
import type { MemoryBackend } from "../../src/memory-backend/types";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { stripOutputNotice, wrapToolWithMetaNotice } from "../../src/tools/output-meta";

const PLAN_SETTINGS = {
	qualityWindowTokens: 240_000,
	reserveRatio: 0.2,
	planMaxTokens: 3_000,
	burstWindowTokens: 320_000,
};

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-08T00:00:00.000Z",
		message: message as unknown as AgentMessage,
	};
}

function digest(turnId: string, decision: string, createdAt: string) {
	return {
		turnId,
		userIntent: "choose storage",
		actionsTaken: [],
		decisions: [decision],
		risks: [],
		nextSteps: [],
		openQuestions: [],
		source: {
			sessionId: "session-1",
			fromEntryId: `user-${turnId}`,
			toEntryId: `assistant-${turnId}`,
			promptGeneration: 1,
		},
		createdAt,
	};
}

function makeContext(sessionManager: object, settings: Settings): AgentToolContext {
	return {
		sessionManager,
		settings,
		executionScopeId: "scope-1",
		model: { contextWindow: 10_000 },
	} as unknown as AgentToolContext;
}

describe("context steady review regressions", () => {
	test("never exposes hidden thinking through history recovery", () => {
		const branch = [
			messageEntry("assistant-1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_REASONING_TOKEN_123" },
					{ type: "text", text: "public answer" },
				],
				details: { hiddenTrace: "PRIVATE_METADATA_TOKEN_456" },
			}),
		];

		expect(searchContextHistory(branch, "PRIVATE_REASONING_TOKEN_123").total).toBe(0);
		const expanded = expandDigestSpan(branch, "source:assistant-1");
		expect(expanded?.text).toContain("public answer");
		expect(expanded?.text).not.toContain("PRIVATE_REASONING_TOKEN_123");
		expect(searchContextHistory(branch, "PRIVATE_METADATA_TOKEN_456").total).toBe(0);
		expect(expanded?.text).not.toContain("PRIVATE_METADATA_TOKEN_456");
	});

	test("keeps current working notes when history materials are frozen", () => {
		const baseNote = {
			noteId: "parser-state",
			subject: "parser state",
			kind: "method" as const,
			text: "The parser source was read before editing.",
			sourceEntryRefs: ["result-read"],
			status: "active" as const,
			revision: 1,
			observationKind: "tool_result" as const,
		};
		const initial = buildContextPlan({
			entries: [],
			sessionId: "session-1",
			requestKey: "request-1",
			epochId: "epoch-1",
			promptGeneration: 1,
			settings: PLAN_SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 0,
			workingNotes: [baseNote],
		});
		const rebuilt = buildContextPlan({
			entries: [],
			sessionId: "session-1",
			requestKey: "request-2",
			epochId: "epoch-1",
			promptGeneration: 1,
			settings: PLAN_SETTINGS,
			contextWindow: 500_000,
			nonMessageTokens: 0,
			frozenMaterials: initial.materials.filter(material => "digest" in material || "checkpoint" in material),
			workingNotes: [{ ...baseNote, requiresRevalidation: true, statusReason: "Source changed." }],
		});

		expect(rebuilt.renderedContent).toContain("The parser source was read before editing.");
		expect(rebuilt.renderedContent).toContain("REVALIDATION REQUIRED");
	});

	test("projects authoritative active state into current working notes", () => {
		const notes = projectActiveContextWorkNotes([], {
			stateRecords: [
				{
					noteId: "brain:decision-1",
					subject: "parser strategy",
					kind: "decision",
					text: "Use the verified parser path.",
					updatedAt: "2026-09-08T00:00:00.000Z",
				},
			],
		});

		expect(notes).toEqual([
			expect.objectContaining({ noteId: "brain:decision-1", text: "Use the verified parser path." }),
		]);
	});

	test("interleaves backend and branch recall while auditing delivered results", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const plan: SanBrainRecallPlan = {
			policyVersion: "brain-m6-recall-v1",
			selectedPolicyIds: [],
			query: "parser failure",
			memoryTypes: [],
			scopeKeys: [],
			role: "primary",
			maxItems: 3,
			tokenBudget: 1_000,
			suppressed: false,
			skipReasons: [],
		};
		const backend = {
			id: "local",
			search: async () => ({
				backend: "local",
				query: "parser failure",
				count: 2,
				items: [
					{ id: "backend-1", content: "backend first" },
					{ id: "backend-2", content: "backend second" },
				],
			}),
		} as unknown as MemoryBackend;
		const layer = await runContextSteadyRecall({
			baseQuery: "parser failure",
			localItems: [
				{ id: "local-1", content: "branch first" },
				{ id: "local-2", content: "branch second" },
			],
			plan,
			configuredBackend: "local",
			resolveBackend: async () => backend,
			backendContext: { agentDir: process.cwd(), cwd: process.cwd() },
			sessionManager: manager,
			sessionId: manager.getSessionId(),
			turnId: "brain_recall_1",
		});

		expect(layer?.items.map(item => item.id)).toEqual(["backend-1", "local-1", "backend-2"]);
		const audit = manager.getEntries().at(-1);
		expect(audit?.type).toBe("custom");
		if (audit?.type !== "custom") throw new Error("recall audit entry missing");
		expect(audit.data as SanBrainRecallAudit).toMatchObject({ outcome: "applied", resultCount: 3 });
	});

	test("does not merge distinct nested tool arguments into one note", () => {
		const entries: Array<Record<string, unknown>> = [];
		const manager = {
			appendCustomEntry(customType: string, data: unknown) {
				const id = `note-${entries.length + 1}`;
				entries.push({ type: "custom", customType, data, id });
				return id;
			},
			getEntries: () => entries,
		};
		const persist = (mode: string, turnId: string) =>
			persistContextWorkNotesFromDigest(manager, digest(turnId, "", `2026-09-08T00:0${turnId}.000Z`), [
				{
					entryId: `call-${turnId}`,
					role: "assistant",
					content: [
						{ type: "toolCall", id: `tool-${turnId}`, name: "custom_tool", arguments: { options: { mode } } },
					],
				},
				{
					entryId: `result-${turnId}`,
					role: "toolResult",
					toolCallId: `tool-${turnId}`,
					toolName: "custom_tool",
					isError: false,
					content: [{ type: "text", text: mode }],
				},
			]);

		persist("alpha", "1");
		persist("beta", "2");
		expect(projectActiveContextWorkNotes(entries)).toHaveLength(2);
	});

	test("revises an evolving digest decision instead of keeping conflicting active notes", () => {
		const entries: Array<Record<string, unknown>> = [];
		const manager = {
			appendCustomEntry(customType: string, data: unknown) {
				const id = `note-${entries.length + 1}`;
				entries.push({ type: "custom", customType, data, id });
				return id;
			},
			getEntries: () => entries,
		};

		persistContextWorkNotesFromDigest(manager, digest("1", "Use SQLite.", "2026-09-08T00:00:00.000Z"), []);
		persistContextWorkNotesFromDigest(
			manager,
			digest("2", "Use PostgreSQL instead.", "2026-09-08T00:01:00.000Z"),
			[],
		);

		const active = projectActiveContextWorkNotes(entries);
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({ text: "Use PostgreSQL instead.", revision: 2 });
	});

	test("recalls structured identifiers followed by sentence punctuation", () => {
		const branch = [
			messageEntry("old-failure", {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-old",
				content: [{ type: "text", text: "E_PARSE_17 stale delimiter state" }],
				isError: true,
			}),
		];
		const items = recallFromContextBranch(branch, "continue E_PARSE_17.", {
			maxItems: 3,
			maxTokens: 1_000,
			fallbackQuery: "continue E_PARSE_17.",
		});
		expect(items).toEqual([expect.objectContaining({ source: "source:old-failure" })]);
	});

	test("bounds emergency previews across the whole logical turn", async () => {
		const saved: string[] = [];
		const sessionManager = {
			saveArtifact: async (content: string) => {
				saved.push(content);
				return `artifact-${saved.length}`;
			},
		};
		const settings = Settings.isolated({
			"tools.logicalTurnOutputTokens": 1,
			"tools.outputPreviewTokens": 96,
		});
		const tool = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: "diagnostic data ".repeat(1_000) }] }),
		} as unknown as AgentTool);
		const context = makeContext(sessionManager, settings);
		const bodyTokens: number[] = [];
		for (let index = 0; index < 6; index++) {
			const result = await tool.execute(`call-${index}`, {}, undefined, undefined, context);
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			bodyTokens.push(countTokens(stripOutputNotice(text, result.details?.meta)));
		}

		expect(bodyTokens[1]).toBeGreaterThan(0);
		expect(bodyTokens.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(97);
	});
});
