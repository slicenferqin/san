/**
 * Stable ContextCheckpoint builder for cache-aware ContextPacket layout.
 *
 * M4 intentionally keeps checkpoint synthesis deterministic. It folds older
 * TurnDigest entries into a stable custom entry so later ContextPackets can put
 * that low-churn layer before the append-only recent digest tail.
 */

import { estimateTokens } from "@san/agent/compaction";
import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { collectDigestRefs } from "./session";
import { polishContextSteadyText } from "./text";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_CHECKPOINT_SCHEMA_VERSION,
	type ContextCheckpoint,
	type ContextCheckpointSummaryItem,
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
	epochId?: string;
	rebaseReason?: ContextCheckpoint["rebaseReason"];
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

function sourceEntryRefsForDigest(entries: readonly SessionEntry[], digest: TurnDigest): string[] {
	const fromIndex = entries.findIndex(entry => entry.id === digest.source.fromEntryId);
	const toIndex = entries.findIndex(entry => entry.id === digest.source.toEntryId);
	if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
		return digest.toolEvidence
			.flatMap(evidence => evidence.entryIds ?? [])
			.filter(entryId => entries.some(entry => entry.id === entryId));
	}
	return entries.slice(fromIndex, toIndex + 1).map(entry => entry.id);
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
	const digestRefs = collectDigestRefs(entries);
	const candidates = digestRefs.filter(ref => !covered.has(ref.entryId));
	// Residual digest tails smaller than checkpointEveryTurns intentionally stay
	// unfolded; the ContextPacket recent-digest tail carries those fresh turns.
	if (candidates.length < checkpointEveryTurns) return null;

	const previousCheckpoint = latestContextCheckpoint(entries);
	const selected = candidates.slice(0, checkpointEveryTurns);
	const digestsByEntryId = new Map(digestRefs.map(ref => [ref.entryId, ref.digest]));
	const appendedEntryRefs = selected.map(ref => ref.entryId);
	const entryRefs = uniqueEntryRefs([...(previousCheckpoint?.checkpoint.entryRefs ?? []), ...appendedEntryRefs]);
	const previousCoveredSourceEntryRefs =
		previousCheckpoint?.checkpoint.coveredSourceEntryRefs ??
		previousCheckpoint?.checkpoint.entryRefs.flatMap(entryRef => {
			const digest = digestsByEntryId.get(entryRef);
			// Fallback digests never authorize raw coverage, even when folded.
			if (!digest || digest.fallback === true) return [];
			return sourceEntryRefsForDigest(entries, digest);
		}) ??
		[];
	const coveredSourceEntryRefs = uniqueEntryRefs([
		...previousCoveredSourceEntryRefs,
		...selected.flatMap(ref => (ref.digest.fallback === true ? [] : sourceEntryRefsForDigest(entries, ref.digest))),
	]);
	const base: Omit<ContextCheckpoint, "tokenEstimate"> = {
		schemaVersion: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
		checkpointId: `ckpt_${crypto.randomUUID().slice(-12)}`,
		sessionId,
		epochId: settings.epochId ?? `epoch_${sessionId}`,
		createdAt: new Date().toISOString(),
		entryRefs,
		coveredSourceEntryRefs,
		...(previousCheckpoint ? { previousCheckpointEntryId: previousCheckpoint.entryId } : {}),
		rebaseReason: settings.rebaseReason ?? "checkpoint",
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

	// Trim lowest-priority summary fields first until the checkpoint fits maxTokens.
	// Order: nextSteps → risks → filesTouched → decisions → userIntents (keep at least 1 intent).
	const trimOrder: Array<keyof ContextCheckpoint["summary"]> = [
		"nextSteps",
		"risks",
		"filesTouched",
		"decisions",
		"userIntents",
	];
	for (const field of trimOrder) {
		while (
			checkpoint.tokenEstimate > checkpointMaxTokens &&
			checkpoint.summary[field].length > (field === "userIntents" ? 1 : 0)
		) {
			checkpoint = {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					[field]: checkpoint.summary[field].slice(0, -1),
				},
			};
			checkpoint = { ...checkpoint, tokenEstimate: estimateCheckpointTokens(checkpoint) };
		}
	}

	// Extreme budgets: clamp remaining narrative text so tokenEstimate never exceeds max.
	if (checkpoint.tokenEstimate > checkpointMaxTokens) {
		const clampItems = <T extends ContextCheckpointSummaryItem>(items: readonly T[], maxLen: number): T[] =>
			items.map(item => ({ ...item, text: clampString(item.text, maxLen) }));
		let maxLen = 120;
		while (checkpoint.tokenEstimate > checkpointMaxTokens && maxLen >= 8) {
			checkpoint = {
				...checkpoint,
				summary: {
					userIntents: clampItems(checkpoint.summary.userIntents, maxLen),
					decisions: clampItems(checkpoint.summary.decisions, maxLen),
					filesTouched: clampItems(checkpoint.summary.filesTouched, maxLen),
					risks: clampItems(checkpoint.summary.risks, maxLen),
					nextSteps: clampItems(checkpoint.summary.nextSteps, maxLen),
				},
			};
			checkpoint = { ...checkpoint, tokenEstimate: estimateCheckpointTokens(checkpoint) };
			maxLen = Math.floor(maxLen / 2);
		}
	}

	// Fail-closed: if even a single minimal intent cannot fit, do not emit a checkpoint
	// that would claim coverage authority while exceeding its budget.
	if (checkpoint.tokenEstimate > checkpointMaxTokens) return null;

	return { checkpoint };
}

export function appendContextCheckpoint(sessionManager: ReadonlySessionManager, checkpoint: ContextCheckpoint): string {
	return sessionManager.appendCustomEntry(CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint);
}
