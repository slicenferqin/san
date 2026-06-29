/**
 * Session-level helpers for TurnDigest persistence and source-span extraction.
 *
 * M1 uses CustomEntry (not CustomMessageEntry) so digests are stored
 * without polluting LLM context. All persistence goes through
 * `sessionManager.appendCustomEntry("san.turn_digest", data)`.
 */

import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import type { TurnDigest, TurnDigestSource } from "./types";
import { TURN_DIGEST_CUSTOM_TYPE } from "./types";

/** Internal session manager interface we need at runtime. */
interface SessionManagerInternal {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): Array<Record<string, unknown>>;
}

// ── Source span extraction ──────────────────────────────────────────────────

/**
 * Extract the entry range for a turn from a session branch, given the
 * pre-turn leaf ID and the current leaf ID.
 *
 * Returns `{ fromEntryId, toEntryId }` or null if the range is empty.
 *
 * This is extracted as a pure function so the source-span computation can
 * be unit-tested independently of AgentSession.
 */
export function computeTurnSourceSpan(
	branch: ReadonlyArray<{ id: string; type: string }>,
	preTurnLeafId: string | null,
	currentLeafId: string | null,
): { fromEntryId: string; toEntryId: string } | null {
	const toEntryId = currentLeafId ?? "";
	if (!toEntryId) return null;

	let fromEntryId = "";
	if (preTurnLeafId) {
		const preTurnIndex = branch.findIndex(e => e.id === preTurnLeafId);
		if (preTurnIndex >= 0 && preTurnIndex + 1 < branch.length) {
			fromEntryId = branch[preTurnIndex + 1].id;
		} else {
			fromEntryId = preTurnLeafId;
		}
	} else if (branch.length > 0) {
		fromEntryId = branch[0].id;
	}

	if (!fromEntryId) return null;
	return { fromEntryId, toEntryId };
}

// ── Message extraction from branch ──────────────────────────────────────────

/**
 * Extract message-like objects from a session branch within a source range.
 *
 * Covers both `type === "message"` (regular AgentMessage, has `.message`
 * field on the entry) and `type === "custom_message"` (CustomMessageEntry,
 * stores its data as top-level entry fields: `customType`, `content`,
 * `details`, `display`, `attribution`). For custom_message entries a
 * digest-compatible shim object is created since the entry's schema does
 * not carry a nested `.message` property.
 */
export function extractSpanMessages(
	branch: ReadonlyArray<{
		id: string;
		type: string;
		message?: unknown;
		customType?: string;
		content?: unknown;
		details?: unknown;
		display?: boolean;
		attribution?: string;
	}>,
	fromEntryId: string,
	toEntryId: string,
): unknown[] {
	let inSpan = false;
	const messages: unknown[] = [];
	for (const entry of branch) {
		if (entry.id === fromEntryId) inSpan = true;
		if (inSpan) {
			if (entry.type === "message" && entry.message !== undefined) {
				messages.push(entry.message);
			} else if (entry.type === "custom_message") {
				// CustomMessageEntry does not carry a nested .message. Build a
				// digest-compatible shim so the fallback digest can read role,
				// content (as text), and provider/model placeholders.
				const textContent =
					typeof entry.content === "string"
						? entry.content
						: Array.isArray(entry.content)
							? entry.content.map(c => (c && typeof c === "object" && "text" in c ? c.text : "")).join(" ")
							: "";
				messages.push({
					role: "custom",
					content: textContent,
					timestamp: Date.now(),
					provider: "custom",
					model: "custom",
					customType: entry.customType ?? "unknown",
				});
			}
		}
		if (entry.id === toEntryId) break;
	}
	return messages;
}

/**
 * Persist a TurnDigest as a custom entry on the current session.
 * Returns the entry id of the newly created entry.
 */
export function appendTurnDigest(sessionManager: ReadonlySessionManager, digest: TurnDigest): string {
	return (sessionManager as unknown as SessionManagerInternal).appendCustomEntry(TURN_DIGEST_CUSTOM_TYPE, digest);
}

/**
 * List all TurnDigest entries from a session's full entry set.
 * Entries are returned in chronological order.
 */
export function listTurnDigests(entries: readonly SessionEntry[]): TurnDigest[] {
	const digests: TurnDigest[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== TURN_DIGEST_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (data && typeof data === "object" && "schemaVersion" in data) {
			digests.push(data as TurnDigest);
		}
	}
	return digests;
}

/**
 * Check whether a TurnDigest already exists for the given source range.
 * Returns the existing digest entry if found, or undefined.
 *
 * Matches on sessionId + fromEntryId + toEntryId. promptGeneration is NOT
 * compared because the same source range ID span in a resumed/compacted
 * session should not produce duplicate digests — the entry IDs are the
 * stable journal identifiers and promptGeneration is an internal counter
 * that resets on session load.
 */
export function findExistingDigest(
	entries: readonly SessionEntry[],
	source: TurnDigestSource,
): SessionEntry | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== TURN_DIGEST_CUSTOM_TYPE) continue;
		const data = entry.data as TurnDigest | undefined;
		if (!data || typeof data.source !== "object") continue;
		const existingSource = data.source as TurnDigestSource;
		if (
			existingSource.fromEntryId === source.fromEntryId &&
			existingSource.toEntryId === source.toEntryId &&
			existingSource.sessionId === source.sessionId
		) {
			return entry;
		}
	}
	return undefined;
}

/**
 * Check whether a TurnDigest already exists for the given source range.
 * Returns true if a duplicate would be created.
 */
export function hasExistingDigest(entries: readonly SessionEntry[], source: TurnDigestSource): boolean {
	return findExistingDigest(entries, source) !== undefined;
}
