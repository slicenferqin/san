/**
 * Stable ContextCheckpoint builder for cache-aware ContextPacket layout.
 *
 * M4 intentionally keeps checkpoint synthesis deterministic. It folds older
 * TurnDigest entries into a stable custom entry so later ContextPackets can put
 * that low-churn layer before the append-only recent digest tail.
 */

import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { polishContextSteadyText } from "./text";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_CHECKPOINT_SCHEMA_VERSION,
	type ContextCheckpoint,
	type ContextCheckpointSummaryItem,
	TURN_DIGEST_CUSTOM_TYPE,
	type TurnDigest,
} from "./types";

interface DigestEntryRef {
	entryId: string;
	digest: TurnDigest;
}

export interface ContextCheckpointSettings {
	enabled: boolean;
	checkpointEveryTurns: number;
	checkpointMaxTokens: number;
}

export interface BuiltContextCheckpoint {
	checkpoint: ContextCheckpoint;
}

function clampNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function clampString(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function estimateCheckpointTokens(checkpoint: Omit<ContextCheckpoint, "tokenEstimate">): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: JSON.stringify(checkpoint.summary) }],
		timestamp: Date.now(),
	});
}

function digestRefs(entries: readonly SessionEntry[]): DigestEntryRef[] {
	const refs: DigestEntryRef[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== TURN_DIGEST_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		if (!("schemaVersion" in data) || !("turnId" in data) || !("source" in data)) continue;
		refs.push({ entryId: entry.id, digest: data as TurnDigest });
	}
	return refs;
}

export function collectContextCheckpoints(
	entries: readonly SessionEntry[],
): Array<{ entryId: string; checkpoint: ContextCheckpoint }> {
	const checkpoints: Array<{ entryId: string; checkpoint: ContextCheckpoint }> = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTEXT_CHECKPOINT_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		if (!("schemaVersion" in data) || !("entryRefs" in data) || !("checkpointId" in data)) continue;
		checkpoints.push({ entryId: entry.id, checkpoint: data as ContextCheckpoint });
	}
	return checkpoints;
}

export function latestContextCheckpoint(
	entries: readonly SessionEntry[],
): { entryId: string; checkpoint: ContextCheckpoint } | null {
	return collectContextCheckpoints(entries).at(-1) ?? null;
}

function coveredDigestEntryIds(entries: readonly SessionEntry[]): Set<string> {
	const covered = new Set<string>();
	for (const { checkpoint } of collectContextCheckpoints(entries)) {
		for (const entryRef of checkpoint.entryRefs) {
			covered.add(entryRef);
		}
	}
	return covered;
}

function summaryItem(text: string, entryId: string): ContextCheckpointSummaryItem {
	const polished = polishContextSteadyText(text);
	return { text: clampString(polished || text.trim(), 180), entryRefs: [entryId] };
}

function cloneSummaryItem<T extends ContextCheckpointSummaryItem>(item: T): T {
	return { ...item, entryRefs: [...item.entryRefs] };
}

function mergeSummaryItems<T extends ContextCheckpointSummaryItem>(
	stableItems: readonly T[],
	newItems: readonly T[],
	maxItems: number,
): T[] {
	const appendedItems = newItems.slice(-maxItems).map(cloneSummaryItem);
	const stablePrefixLength = Math.max(0, maxItems - appendedItems.length);
	return dedupeSummaryItems([...stableItems.slice(0, stablePrefixLength).map(cloneSummaryItem), ...appendedItems]);
}

function summaryItemKey(item: ContextCheckpointSummaryItem): string {
	const action = "action" in item && typeof item.action === "string" ? item.action : "";
	return `${item.text.toLowerCase()}|${action}`;
}

function dedupeSummaryItems<T extends ContextCheckpointSummaryItem>(items: readonly T[]): T[] {
	const byKey = new Map<string, T>();
	for (const item of items) {
		const key = summaryItemKey(item);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, cloneSummaryItem(item));
			continue;
		}
		byKey.set(key, { ...existing, entryRefs: uniqueEntryRefs([...existing.entryRefs, ...item.entryRefs]) } as T);
	}
	return [...byKey.values()];
}

function uniqueEntryRefs(entryRefs: readonly string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const entryRef of entryRefs) {
		if (seen.has(entryRef)) continue;
		seen.add(entryRef);
		unique.push(entryRef);
	}
	return unique;
}

function checkpointSummary(refs: readonly DigestEntryRef[]): ContextCheckpoint["summary"] {
	const userIntents: ContextCheckpointSummaryItem[] = [];
	const decisions: ContextCheckpointSummaryItem[] = [];
	const filesTouched: ContextCheckpoint["summary"]["filesTouched"] = [];
	const risks: ContextCheckpointSummaryItem[] = [];
	const nextSteps: ContextCheckpointSummaryItem[] = [];
	const seenFiles = new Set<string>();

	for (const ref of refs) {
		userIntents.push(summaryItem(ref.digest.userIntent, ref.entryId));
		for (const decision of ref.digest.decisions.slice(0, 3)) {
			decisions.push(summaryItem(decision, ref.entryId));
		}
		for (const file of ref.digest.filesTouched.slice(0, 5)) {
			const key = `${file.path}:${file.action}`;
			if (seenFiles.has(key)) continue;
			seenFiles.add(key);
			filesTouched.push({ ...summaryItem(file.path, ref.entryId), action: file.action });
		}
		for (const risk of ref.digest.risks.slice(0, 2)) {
			risks.push(summaryItem(risk, ref.entryId));
		}
		for (const nextStep of ref.digest.nextSteps.slice(0, 2)) {
			nextSteps.push(summaryItem(nextStep, ref.entryId));
		}
	}

	return {
		userIntents: dedupeSummaryItems(userIntents).slice(0, 20),
		decisions: dedupeSummaryItems(decisions).slice(0, 20),
		filesTouched: dedupeSummaryItems(filesTouched).slice(0, 30),
		risks: dedupeSummaryItems(risks).slice(0, 12),
		nextSteps: dedupeSummaryItems(nextSteps).slice(0, 12),
	};
}

function mergeCheckpointSummary(
	stableSummary: ContextCheckpoint["summary"] | undefined,
	appendedSummary: ContextCheckpoint["summary"],
): ContextCheckpoint["summary"] {
	if (!stableSummary) return appendedSummary;

	return {
		userIntents: mergeSummaryItems(stableSummary.userIntents, appendedSummary.userIntents, 20),
		decisions: mergeSummaryItems(stableSummary.decisions, appendedSummary.decisions, 20),
		filesTouched: mergeSummaryItems(stableSummary.filesTouched, appendedSummary.filesTouched, 30),
		risks: mergeSummaryItems(stableSummary.risks, appendedSummary.risks, 12),
		nextSteps: mergeSummaryItems(stableSummary.nextSteps, appendedSummary.nextSteps, 12),
	};
}

export function buildContextCheckpoint(
	entries: readonly SessionEntry[],
	sessionId: string,
	settings: ContextCheckpointSettings,
): BuiltContextCheckpoint | null {
	if (!settings.enabled) return null;

	const checkpointEveryTurns = clampNonNegativeInteger(settings.checkpointEveryTurns);
	if (checkpointEveryTurns === 0) return null;

	const checkpointMaxTokens = clampNonNegativeInteger(settings.checkpointMaxTokens);
	if (checkpointMaxTokens === 0) return null;

	const covered = coveredDigestEntryIds(entries);
	const candidates = digestRefs(entries).filter(ref => !covered.has(ref.entryId));
	// Residual digest tails smaller than checkpointEveryTurns intentionally stay
	// unfolded; the ContextPacket recent-digest tail carries those fresh turns.
	if (candidates.length < checkpointEveryTurns) return null;

	const previousCheckpoint = latestContextCheckpoint(entries);
	const selected = candidates.slice(0, checkpointEveryTurns);
	const appendedEntryRefs = selected.map(ref => ref.entryId);
	const entryRefs = uniqueEntryRefs([...(previousCheckpoint?.checkpoint.entryRefs ?? []), ...appendedEntryRefs]);
	const base: Omit<ContextCheckpoint, "tokenEstimate"> = {
		schemaVersion: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
		checkpointId: `ckpt_${crypto.randomUUID().slice(-12)}`,
		sessionId,
		createdAt: new Date().toISOString(),
		entryRefs,
		fromDigestEntryId: entryRefs[0]!,
		toDigestEntryId: appendedEntryRefs.at(-1)!,
		digestCount: entryRefs.length,
		summary: mergeCheckpointSummary(previousCheckpoint?.checkpoint.summary, checkpointSummary(selected)),
		tokenBudget: checkpointMaxTokens,
		stability: "stable" as const,
		cachePriority: "high" as const,
	};
	let checkpoint: ContextCheckpoint = {
		...base,
		tokenEstimate: estimateCheckpointTokens(base),
	};

	while (checkpoint.tokenEstimate > checkpointMaxTokens && checkpoint.summary.nextSteps.length > 0) {
		checkpoint = {
			...checkpoint,
			summary: {
				...checkpoint.summary,
				nextSteps: checkpoint.summary.nextSteps.slice(0, -1),
			},
		};
		checkpoint = { ...checkpoint, tokenEstimate: estimateCheckpointTokens(checkpoint) };
	}

	while (checkpoint.tokenEstimate > checkpointMaxTokens && checkpoint.summary.risks.length > 0) {
		checkpoint = {
			...checkpoint,
			summary: {
				...checkpoint.summary,
				risks: checkpoint.summary.risks.slice(0, -1),
			},
		};
		checkpoint = { ...checkpoint, tokenEstimate: estimateCheckpointTokens(checkpoint) };
	}

	return { checkpoint };
}

export function appendContextCheckpoint(sessionManager: ReadonlySessionManager, checkpoint: ContextCheckpoint): string {
	return sessionManager.appendCustomEntry(CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint);
}
