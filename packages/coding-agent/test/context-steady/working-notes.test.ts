import { describe, expect, test } from "bun:test";
import {
	appendContextWorkNote,
	appendContextWorkNoteInvalidation,
	type ContextWorkNote,
	contextWorkNotesFromDigest,
	persistContextWorkNotesFromDigest,
	projectActiveContextWorkNotes,
} from "../../src/context-steady/working-notes";

function customEntry(id: string, data: unknown) {
	return { type: "custom" as const, customType: "san.context_work_note", data, id };
}

function messageEntry(id: string, message: Record<string, unknown>) {
	return { type: "message" as const, id, parentId: null, timestamp: "2026-09-05T00:00:00.000Z", message };
}

function assistantCall(id: string, toolCallId: string, name: string, args: Record<string, unknown>) {
	return messageEntry(id, {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
	});
}

function toolResult(id: string, toolCallId: string, toolName: string, isError: boolean, text: string) {
	return messageEntry(id, {
		role: "toolResult",
		toolCallId,
		toolName,
		isError,
		content: [{ type: "text", text }],
	});
}

function note(overrides: Partial<ContextWorkNote> = {}): ContextWorkNote {
	return {
		schemaVersion: 1,
		noteId: "note-1",
		subject: "fix flaky test",
		kind: "hypothesis",
		text: "The timeout is caused by a stale worker.",
		status: "active",
		sourceEntryRefs: ["entry-1"],
		createdAt: "2026-09-05T00:00:00.000Z",
		updatedAt: "2026-09-05T00:00:00.000Z",
		revision: 1,
		...overrides,
	};
}

describe("context working notes", () => {
	test("keeps only the newest revision while retaining append-only history", () => {
		const entries = [
			customEntry("custom-1", note()),
			customEntry("custom-2", note({ revision: 2, text: "The timeout is caused by a leaked timer." })),
		];

		expect(projectActiveContextWorkNotes(entries)).toEqual([
			{
				noteId: "note-1",
				subject: "fix flaky test",
				kind: "hypothesis",
				text: "The timeout is caused by a leaked timer.",
				sourceEntryRefs: ["entry-1"],
				status: "active",
				revision: 2,
			},
		]);
	});

	test("removes superseded and invalidated notes from the active projection", () => {
		const oldNote = note();
		const replacement = note({
			noteId: "note-2",
			kind: "decision",
			text: "Use a bounded worker shutdown instead.",
			supersedesNoteId: oldNote.noteId,
		});
		const invalidated = note({ noteId: "note-3", status: "invalidated", statusReason: "The environment changed." });

		expect(
			projectActiveContextWorkNotes([
				customEntry("1", oldNote),
				customEntry("2", replacement),
				customEntry("3", invalidated),
			]),
		).toEqual([
			{
				noteId: "note-2",
				subject: "fix flaky test",
				kind: "decision",
				text: "Use a bounded worker shutdown instead.",
				sourceEntryRefs: ["entry-1"],
				status: "active",
				revision: 1,
			},
		]);
	});

	test("writes and invalidates through the session custom-entry seam", () => {
		const appended: Array<{ customType: string; data: unknown }> = [];
		const append = (customType: string, data: unknown) => {
			appended.push({ customType, data });
			return `entry-${appended.length}`;
		};
		const createdId = appendContextWorkNote(
			append,
			{ subject: "fix flaky test", kind: "method", text: "Run the test with one worker." },
			{ createdAt: "2026-09-05T00:00:00.000Z" },
		);
		const created = appended[0]?.data as ContextWorkNote | undefined;
		if (!created) throw new Error("created working note is missing");
		const invalidatedId = appendContextWorkNoteInvalidation(append, created, {
			updatedAt: "2026-09-05T00:01:00.000Z",
			reason: "The test is no longer flaky after the code change.",
		});
		const invalidated = appended[1]?.data as ContextWorkNote | undefined;
		if (!invalidated) throw new Error("invalidated working note is missing");

		expect(createdId).toBe("entry-1");
		expect(invalidatedId).toBe("entry-2");
		expect(appended[0]?.customType).toBe("san.context_work_note");
		expect(invalidated.status).toBe("invalidated");
		expect(invalidated.revision).toBe(2);
	});

	test("converts settled digest fields into bounded, source-linked notes", () => {
		const notes = contextWorkNotesFromDigest({
			turnId: "turn-1",
			userIntent: "repair flaky test",
			actionsTaken: ["Ran the test with one worker."],
			decisions: ["Keep the bounded shutdown."],
			risks: ["The remote worker may still outlive the test."],
			openQuestions: ["Does the CI runner use the same worker limit?"],
			nextSteps: ["Run the CI smoke probe."],
			source: { sessionId: "session-1", fromEntryId: "entry-1", toEntryId: "entry-4", promptGeneration: 2 },
			createdAt: "2026-09-05T00:00:00.000Z",
		});

		expect(notes.map(({ kind, text }) => ({ kind, text }))).toEqual([
			{ kind: "method", text: "Ran the test with one worker." },
			{ kind: "decision", text: "Keep the bounded shutdown." },
			{ kind: "blocker", text: "The remote worker may still outlive the test." },
			{ kind: "hypothesis", text: "Does the CI runner use the same worker limit?" },
			{ kind: "next_step", text: "Run the CI smoke probe." },
		]);
		expect(notes.every(item => item.sourceEntryRefs.join(",") === "entry-1,entry-4")).toBe(true);
	});

	test("correlates real tool calls and revalidates observations only after matching successful mutations", () => {
		const observed = note({
			noteId: "parser-state",
			kind: "method",
			text: "The parser source was read before editing.",
			sourceEntryRefs: ["result-read"],
			observationKind: "tool_result",
		});
		const baseEntries = [
			assistantCall("call-read", "read-1", "read", { path: "src/parser.ts" }),
			toolResult("result-read", "read-1", "read", false, "previous parser source"),
			customEntry("note-1", observed),
		];

		expect(
			projectActiveContextWorkNotes([
				...baseEntries,
				assistantCall("call-edit", "edit-1", "edit", { input: "[src/parser.ts#A1B2]\nSWAP 1.=1:\n+fixed" }),
				toolResult("result-edit", "edit-1", "edit", false, "updated parser source"),
			]),
		).toEqual([
			expect.objectContaining({
				requiresRevalidation: true,
				sourcePaths: ["src/parser.ts"],
				observations: [
					{
						entryId: "result-read",
						toolCallId: "read-1",
						toolName: "read",
						outcome: "success",
					},
				],
			}),
		]);

		for (const mutation of [
			[
				assistantCall("call-failed-edit", "edit-2", "edit", {
					input: "[src/parser.ts#A1B2]\nSWAP 1.=1:\n+rejected",
				}),
				toolResult("result-failed-edit", "edit-2", "edit", true, "edit rejected"),
			],
			[
				assistantCall("call-other-edit", "edit-3", "edit", { input: "[src/other.ts#C3D4]\nSWAP 1.=1:\n+updated" }),
				toolResult("result-other-edit", "edit-3", "edit", false, "updated unrelated source"),
			],
		]) {
			expect(projectActiveContextWorkNotes([...baseEntries, ...mutation])[0]?.requiresRevalidation).toBeUndefined();
		}

		const refreshed = note({
			...observed,
			revision: 2,
			text: "The parser source was read after editing.",
			sourceEntryRefs: ["result-read", "result-reread"],
			updatedAt: "2026-09-05T00:01:00.000Z",
		});
		const afterFreshObservation = projectActiveContextWorkNotes([
			...baseEntries,
			assistantCall("call-edit", "edit-1", "edit", { input: "[src/parser.ts#A1B2]\nSWAP 1.=1:\n+fixed" }),
			toolResult("result-edit", "edit-1", "edit", false, "updated parser source"),
			assistantCall("call-reread", "read-2", "read", { path: "src/parser.ts" }),
			toolResult("result-reread", "read-2", "read", false, "current parser source"),
			customEntry("note-2", refreshed),
		]);
		expect(afterFreshObservation[0]?.requiresRevalidation).toBeUndefined();
		expect(afterFreshObservation[0]?.observations?.at(-1)?.entryId).toBe("result-reread");
	});

	test("revises the same tool target across turns while retaining source history", () => {
		const entries: Array<Record<string, unknown>> = [];
		const sessionManager = {
			appendCustomEntry(customType: string, data: unknown) {
				expect(customType).toBe("san.context_work_note");
				const id = `custom-${entries.length + 1}`;
				entries.push(customEntry(id, data));
				return id;
			},
			getEntries: () => entries,
		};
		const persist = (turnId: string, resultEntryId: string, createdAt: string, result: string) =>
			persistContextWorkNotesFromDigest(
				sessionManager,
				{
					turnId,
					userIntent: "inspect parser state",
					actionsTaken: [],
					decisions: [],
					risks: [],
					nextSteps: [],
					openQuestions: [],
					source: {
						sessionId: "session-1",
						fromEntryId: `user-${turnId}`,
						toEntryId: resultEntryId,
						promptGeneration: 1,
					},
					createdAt,
				},
				[
					{
						entryId: `call-${turnId}`,
						role: "assistant",
						content: [
							{ type: "toolCall", id: `read-${turnId}`, name: "read", arguments: { path: "src/parser.ts" } },
						],
					},
					{
						entryId: resultEntryId,
						role: "toolResult",
						toolCallId: `read-${turnId}`,
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: result }],
					},
				],
			);

		expect(persist("turn-1", "result-1", "2026-09-05T00:00:00.000Z", "first source")).toHaveLength(1);
		expect(persist("turn-2", "result-2", "2026-09-05T00:01:00.000Z", "updated source")).toHaveLength(1);
		const revisions = entries.map(entry => entry.data as ContextWorkNote);
		expect(revisions.map(item => item.noteId)).toEqual([revisions[0]!.noteId, revisions[0]!.noteId]);
		expect(revisions[1]).toMatchObject({
			revision: 2,
			createdAt: "2026-09-05T00:00:00.000Z",
			updatedAt: "2026-09-05T00:01:00.000Z",
			sourceEntryRefs: ["result-1", "result-2"],
		});
	});
});
