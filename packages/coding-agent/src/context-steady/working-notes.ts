import { contextMessageText } from "./message-text";
import { contextSourcePathsOverlap, inspectContextToolSources } from "./tool-observations";
import type { TurnDigest } from "./types";

export const CONTEXT_WORK_NOTE_SCHEMA_VERSION = 1 as const;
export const CONTEXT_WORK_NOTE_CUSTOM_TYPE = "san.context_work_note" as const;

export type ContextWorkNoteKind = "method" | "hypothesis" | "decision" | "blocker" | "next_step";
export type ContextWorkNoteStatus = "active" | "superseded" | "invalidated";

export interface ContextWorkNoteInput {
	noteId?: string;
	subject: string;
	kind: ContextWorkNoteKind;
	text: string;
	sourceEntryRefs?: readonly string[];
	supersedesNoteId?: string;
	revision?: number;
	sourceDigestTurnId?: string;
	condition?: string;
	observationKind?: "tool_result" | "model_hypothesis";
}

export interface ContextWorkNote {
	schemaVersion: typeof CONTEXT_WORK_NOTE_SCHEMA_VERSION;
	noteId: string;
	subject: string;
	kind: ContextWorkNoteKind;
	text: string;
	status: ContextWorkNoteStatus;
	sourceEntryRefs: string[];
	createdAt: string;
	updatedAt: string;
	supersedesNoteId?: string;
	statusReason?: string;
	revision: number;
	sourceDigestTurnId?: string;
	condition?: string;
	observationKind?: "tool_result" | "model_hypothesis";
}

export interface ContextWorkNoteProjection {
	noteId: string;
	subject: string;
	kind: ContextWorkNoteKind;
	text: string;
	sourceEntryRefs: string[];
	status: "active";
	revision: number;
	condition?: string;
	observationKind?: "tool_result" | "model_hypothesis";
	requiresRevalidation?: boolean;
	statusReason?: string;
	observations?: Array<{
		entryId: string;
		toolCallId: string;
		toolName: string;
		outcome: "success" | "failure" | "unknown";
	}>;
	sourcePaths?: string[];
}

export interface ContextWorkNoteStateRecord {
	noteId: string;
	subject: string;
	kind: ContextWorkNoteKind;
	text: string;
	updatedAt: string;
	sourceEntryRefs?: readonly string[];
	condition?: string;
	observationKind?: "tool_result" | "model_hypothesis";
}

export type ContextWorkNoteAppender = (customType: string, data: unknown) => string;

interface CustomEntryLike {
	type: "custom";
	customType: string;
	data?: unknown;
	id: string;
}

const NOTE_KINDS: Record<ContextWorkNoteKind, true> = {
	method: true,
	hypothesis: true,
	decision: true,
	blocker: true,
	next_step: true,
};
const NOTE_STATUSES: Record<ContextWorkNoteStatus, true> = {
	active: true,
	superseded: true,
	invalidated: true,
};

function isContextWorkNote(value: unknown): value is ContextWorkNote {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ContextWorkNote>;
	return (
		candidate.schemaVersion === CONTEXT_WORK_NOTE_SCHEMA_VERSION &&
		typeof candidate.noteId === "string" &&
		typeof candidate.subject === "string" &&
		typeof candidate.kind === "string" &&
		NOTE_KINDS[candidate.kind as ContextWorkNoteKind] === true &&
		typeof candidate.text === "string" &&
		typeof candidate.status === "string" &&
		NOTE_STATUSES[candidate.status as ContextWorkNoteStatus] === true &&
		Array.isArray(candidate.sourceEntryRefs) &&
		candidate.sourceEntryRefs.every(ref => typeof ref === "string") &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		Number.isInteger(candidate.revision) &&
		(candidate.revision ?? 0) > 0 &&
		(candidate.observationKind === undefined ||
			candidate.observationKind === "tool_result" ||
			candidate.observationKind === "model_hypothesis")
	);
}

function isCustomEntry(value: unknown): value is CustomEntryLike {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<CustomEntryLike>;
	return entry.type === "custom" && typeof entry.customType === "string" && typeof entry.id === "string";
}

function stableNoteId(parts: readonly string[]): string {
	const key = parts.map(part => part.trim().toLowerCase()).join("\0");
	return `note-${Bun.hash(key).toString(36)}`;
}

export function collectContextWorkNotes(entries: readonly unknown[]): ContextWorkNote[] {
	return entries.flatMap(entry => {
		if (!isCustomEntry(entry) || entry.customType !== CONTEXT_WORK_NOTE_CUSTOM_TYPE) return [];
		return isContextWorkNote(entry.data) ? [entry.data] : [];
	});
}

export function projectActiveContextWorkNotes(
	entries: readonly unknown[],
	options: {
		maxNotes?: number;
		currentPrompt?: string;
		stateRecords?: readonly ContextWorkNoteStateRecord[];
	} = {},
): ContextWorkNoteProjection[] {
	const latest = new Map<string, ContextWorkNote>();
	for (const note of collectContextWorkNotes(entries)) {
		const previous = latest.get(note.noteId);
		if (!previous || note.revision >= previous.revision) latest.set(note.noteId, note);
	}
	for (const state of options.stateRecords ?? []) {
		const previous = latest.get(state.noteId);
		if (previous && previous.updatedAt > state.updatedAt) continue;
		latest.set(state.noteId, {
			schemaVersion: CONTEXT_WORK_NOTE_SCHEMA_VERSION,
			noteId: state.noteId,
			subject: state.subject,
			kind: state.kind,
			text: state.text,
			status: "active",
			sourceEntryRefs: [...new Set(state.sourceEntryRefs ?? [])],
			createdAt: previous?.createdAt ?? state.updatedAt,
			updatedAt: state.updatedAt,
			revision: Math.max(1, (previous?.revision ?? 0) + 1),
			...(state.condition ? { condition: state.condition } : {}),
			...(state.observationKind ? { observationKind: state.observationKind } : {}),
		});
	}

	const superseded = new Set<string>();
	for (const note of latest.values()) if (note.supersedesNoteId) superseded.add(note.supersedesNoteId);
	const source = inspectContextToolSources(entries);
	const prompt = options.currentPrompt?.toLowerCase();
	const notes = [...latest.values()]
		.filter(note => note.status === "active" && !superseded.has(note.noteId))
		.filter(
			note =>
				!prompt ||
				!note.condition ||
				prompt.includes(note.condition.toLowerCase()) ||
				note.sourceEntryRefs.some(ref => prompt.includes(ref.toLowerCase())),
		)
		.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
		.map(note => {
			const observations =
				note.observationKind === "tool_result"
					? note.sourceEntryRefs.flatMap(ref => source.resultsById.get(ref) ?? [])
					: [];
			const sourcePaths = [...new Set(observations.flatMap(observation => observation.paths))];
			const latestObservationPosition = observations.reduce(
				(maximum, observation) => Math.max(maximum, observation.position),
				-1,
			);
			const invalidatingMutation =
				note.observationKind === "tool_result" && sourcePaths.length > 0
					? source.mutations.find(
							mutation =>
								mutation.outcome === "success" &&
								mutation.position > latestObservationPosition &&
								mutation.paths.some(changed =>
									sourcePaths.some(observed => contextSourcePathsOverlap(changed, observed)),
								),
						)
					: undefined;
			return {
				noteId: note.noteId,
				subject: note.subject,
				kind: note.kind,
				text: note.text,
				sourceEntryRefs: [...note.sourceEntryRefs],
				status: "active" as const,
				revision: note.revision,
				...(note.condition ? { condition: note.condition } : {}),
				...(note.observationKind ? { observationKind: note.observationKind } : {}),
				...(note.statusReason ? { statusReason: note.statusReason } : {}),
				...(observations.length
					? {
							observations: observations.map(({ entryId, toolCallId, toolName, outcome }) => ({
								entryId,
								toolCallId,
								toolName,
								outcome,
							})),
						}
					: {}),
				...(sourcePaths.length ? { sourcePaths } : {}),
				...(invalidatingMutation
					? {
							requiresRevalidation: true,
							statusReason: `Affected source changed after this observation: ${invalidatingMutation.paths.join(", ")}.`,
						}
					: {}),
			};
		});
	const maxNotes = Number.isFinite(options.maxNotes)
		? Math.min(100, Math.max(0, Math.floor(options.maxNotes ?? 12)))
		: 12;
	return maxNotes < 1 ? [] : notes.slice(-maxNotes);
}

export function createContextWorkNote(input: ContextWorkNoteInput, metadata: { createdAt: string }): ContextWorkNote {
	const noteId = input.noteId ?? `note-${crypto.randomUUID()}`;
	return {
		schemaVersion: CONTEXT_WORK_NOTE_SCHEMA_VERSION,
		noteId,
		subject: input.subject.trim(),
		kind: input.kind,
		text: input.text.trim(),
		status: "active",
		sourceEntryRefs: [...new Set(input.sourceEntryRefs ?? [])],
		createdAt: metadata.createdAt,
		updatedAt: metadata.createdAt,
		supersedesNoteId: input.supersedesNoteId,
		revision: input.revision ?? 1,
		...(input.sourceDigestTurnId ? { sourceDigestTurnId: input.sourceDigestTurnId } : {}),
		...(input.condition ? { condition: input.condition } : {}),
		...(input.observationKind ? { observationKind: input.observationKind } : {}),
	};
}

export function appendContextWorkNote(
	append: ContextWorkNoteAppender,
	input: ContextWorkNoteInput,
	metadata: { createdAt: string },
): string {
	return append(CONTEXT_WORK_NOTE_CUSTOM_TYPE, createContextWorkNote(input, metadata));
}

export function invalidateContextWorkNote(
	previous: ContextWorkNote,
	metadata: { updatedAt: string; reason?: string },
): ContextWorkNote {
	return {
		...previous,
		status: "invalidated",
		updatedAt: metadata.updatedAt,
		...(metadata.reason ? { statusReason: metadata.reason } : {}),
		revision: previous.revision + 1,
	};
}

export function appendContextWorkNoteInvalidation(
	append: ContextWorkNoteAppender,
	previous: ContextWorkNote,
	metadata: { updatedAt: string; reason?: string },
): string {
	return append(CONTEXT_WORK_NOTE_CUSTOM_TYPE, invalidateContextWorkNote(previous, metadata));
}

function toolObservationNotes(
	digest: Pick<TurnDigest, "turnId" | "userIntent" | "createdAt">,
	messages: readonly unknown[],
): ContextWorkNote[] {
	const sources = inspectContextToolSources(messages);
	return messages.flatMap((entry, index) => {
		const wrapper = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
		const message =
			wrapper.message && typeof wrapper.message === "object"
				? (wrapper.message as Record<string, unknown>)
				: wrapper;
		const entryId =
			typeof wrapper.id === "string"
				? wrapper.id
				: typeof message.entryId === "string"
					? message.entryId
					: `entry:${index}`;
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return [];
		const observation = sources.resultsById.get(entryId)?.[0];
		if (!observation) return [];
		const excerpt = contextMessageText(message).slice(0, 500);
		return [
			createContextWorkNote(
				{
					noteId: stableNoteId(["tool", observation.toolName, observation.condition]),
					subject: digest.userIntent,
					kind: "method",
					text: `${observation.toolName} ${observation.outcome}: ${excerpt}`.trim(),
					sourceEntryRefs: [entryId],
					sourceDigestTurnId: digest.turnId,
					condition: observation.condition,
					observationKind: "tool_result",
				},
				{ createdAt: digest.createdAt },
			),
		];
	});
}

export function contextWorkNotesFromDigest(
	digest: Pick<
		TurnDigest,
		| "turnId"
		| "userIntent"
		| "actionsTaken"
		| "decisions"
		| "risks"
		| "nextSteps"
		| "openQuestions"
		| "source"
		| "createdAt"
	>,
): ContextWorkNote[] {
	const sourceEntryRefs = [digest.source.fromEntryId, digest.source.toEntryId];
	const groups: Array<[ContextWorkNoteKind, readonly string[]]> = [
		["method", digest.actionsTaken],
		["decision", digest.decisions],
		["blocker", digest.risks],
		["hypothesis", digest.openQuestions],
		["next_step", digest.nextSteps],
	];
	return groups.flatMap(([kind, values]) =>
		values
			.map(text => text.trim())
			.filter(Boolean)
			.map((text, index) =>
				createContextWorkNote(
					{
						noteId: stableNoteId(["digest", digest.userIntent, kind, String(index)]),
						subject: digest.userIntent,
						kind,
						text,
						sourceEntryRefs,
						sourceDigestTurnId: digest.turnId,
						observationKind: "model_hypothesis",
					},
					{ createdAt: digest.createdAt },
				),
			),
	);
}

/** Persist digest-derived notes idempotently, preserving append-only history. */
export function persistContextWorkNotesFromDigest(
	sessionManager: {
		appendCustomEntry(customType: string, data: unknown): string;
		getEntries(): readonly unknown[];
		getBranch?: () => readonly unknown[];
	},
	digest: Parameters<typeof contextWorkNotesFromDigest>[0],
	messages: readonly unknown[],
): string[] {
	const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries();
	const byId = new Map<string, ContextWorkNote>();
	for (const note of collectContextWorkNotes(entries)) {
		const previous = byId.get(note.noteId);
		if (!previous || note.revision >= previous.revision) byId.set(note.noteId, note);
	}
	const candidates = [...contextWorkNotesFromDigest(digest), ...toolObservationNotes(digest, messages)];
	const persisted: string[] = [];
	for (const note of candidates) {
		const previous = byId.get(note.noteId);
		const hasAllSourceRefs = previous
			? note.sourceEntryRefs.every(ref => previous.sourceEntryRefs.includes(ref))
			: false;
		if (
			previous &&
			previous.text === note.text &&
			previous.status === "active" &&
			previous.condition === note.condition &&
			hasAllSourceRefs
		) {
			continue;
		}
		const next = previous
			? {
					...note,
					createdAt: previous.createdAt,
					revision: previous.revision + 1,
					sourceEntryRefs: [...new Set([...previous.sourceEntryRefs, ...note.sourceEntryRefs])],
				}
			: note;
		try {
			persisted.push(sessionManager.appendCustomEntry(CONTEXT_WORK_NOTE_CUSTOM_TYPE, next));
			byId.set(note.noteId, next);
		} catch {
			break;
		}
	}
	return persisted;
}
