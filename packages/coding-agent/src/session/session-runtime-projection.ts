import { type ParsedExecutionScopeJournalRecord, readExecutionScopeJournal } from "../execution-control/persistence";
import type { SessionEntry } from "./session-entries";

/** Marker written before a tool call executes; a later assistant turn clears it in the pending-call reducer. */
const TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start";

/**
 * Drop the execution-scope journal records a covering snapshot already materialized.
 * `rebuildExecutionScopeLedger` treats the newest snapshot (`coveredRevision` maximal, first wins
 * on ties) as a complete baseline and replays only events strictly newer than it; replaying an
 * older or superseded snapshot is impossible, because `latestSnapshot` ignores it. Deleting
 * exactly those records therefore leaves the rebuilt ledger, the registry baselines
 * (`scopeReferencesFromJournal` / `taskContractsFromJournal` / `providerHealthFromJournal`) and
 * `scopeIdFromJournal`'s active-scope resolution unchanged.
 *
 * Deliberately conservative, matching the reducer's own fail-closed edges: a scope with no
 * snapshot keeps every event (nothing would fold them), the PARSER decides what a record even is,
 * so unparsable entries are never named for removal, and snapshots stay visible to
 * `scopeIdFromJournal`'s last-snapshot fallback.
 */
function compactExecutionScopeEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	const journal = readExecutionScopeJournal(entries);
	if (journal.length === 0) return [...entries];
	const scopeIdOf = (record: ParsedExecutionScopeJournalRecord): string =>
		record.journalType === "event" ? record.record.scopeId : record.snapshot.scopeId;
	/** The reducer's `latestSnapshot`: only snapshots raise this — an event revision never covers itself. */
	const latestSnapshotCoveredRevision = new Map<string, number>();
	/** The reducer's `reduce` keeps the FIRST snapshot at a revision, so later ones are unreachable. */
	const firstSnapshotAtRevision = new Map<string, string>();
	for (const record of journal) {
		if (record.journalType !== "snapshot" || !record.entryId) continue;
		const scopeId = record.snapshot.scopeId;
		const covered = latestSnapshotCoveredRevision.get(scopeId);
		if (covered === undefined || record.coveredRevision > covered)
			latestSnapshotCoveredRevision.set(scopeId, record.coveredRevision);
		const key = `${scopeId}\u0000${record.coveredRevision}`;
		if (!firstSnapshotAtRevision.has(key)) firstSnapshotAtRevision.set(key, record.entryId);
	}
	const dropped = new Set<string>();
	for (const record of journal) {
		if (!record.entryId) continue;
		const covered = latestSnapshotCoveredRevision.get(scopeIdOf(record));
		if (covered === undefined) continue;
		if (record.journalType === "snapshot") {
			if (
				record.coveredRevision < covered ||
				firstSnapshotAtRevision.get(`${record.snapshot.scopeId}\u0000${record.coveredRevision}`) !== record.entryId
			)
				dropped.add(record.entryId);
			continue;
		}
		if (record.record.revision <= covered) dropped.add(record.entryId);
	}
	if (dropped.size === 0) return [...entries];
	return entries.filter(entry => !dropped.has(entry.id));
}

/**
 * The runtime branch a resumed session rehydrates from: an ordered subset of the branch's own
 * entries, in journal order, keeping their original ids and parents.
 *
 * Two independent reductions, both of which must leave the rebuilt runtime state untouched:
 *
 * 1. Compaction boundary. The newest compaction's `firstKeptEntryId` splits the branch; the
 *    pre-boundary region is archived history its summary already replaces. Only messages and
 *    `tool_execution_start` markers drop there — settings/state entries, unrelated customs and
 *    the compaction anchor itself survive, and the retained region passes through untouched.
 *    Without a compaction boundary (including the checkpoint-only case) nothing drops: a
 *    context checkpoint carries no message-level replacement guarantee, so the projection
 *    stays conservative and the rebuilt context matches the full branch exactly.
 * 2. Execution-scope journal records already folded into a covering snapshot, which no reducer
 *    path can replay (see {@link compactExecutionScopeEntries}).
 *
 * Returns ORIGINAL entries — never synthetic or reparented records — so callers may keep using
 * `parentId` to walk ancestry, and the journal itself is untouched: exact history, rewrite and
 * fork hydrate the full branch from disk instead of this projection.
 */
export function selectResumeRuntimeEntries(branch: readonly SessionEntry[]): SessionEntry[] {
	const entries = [...branch];
	const compaction = entries.findLast(entry => entry.type === "compaction");
	const boundary = compaction ? entries.findIndex(entry => entry.id === compaction.firstKeptEntryId) : -1;
	if (boundary < 0) {
		// No compaction boundary: checkpoint coverage stays conservative — only the
		// execution-scope journal compacts; every message and marker survives so the
		// rebuilt context and pending-call replay match the full branch exactly.
		return compactExecutionScopeEntries(entries);
	}
	// Compaction mode: `buildSessionContextFromBranch` already excludes pre-boundary
	// messages, so the projection drops them (and their execution-start markers — a
	// kept marker whose declaring assistant was archived would resurrect a pending
	// call). Everything else stays: settings/state entries, unrelated customs, the
	// compaction anchor itself, and the whole retained region from the boundary on.
	const retained = entries.filter((entry, index) => {
		if (index >= boundary) return true;
		if (entry.type === "message") return false;
		if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE) return false;
		return true;
	});
	return compactExecutionScopeEntries(retained);
}
