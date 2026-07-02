/**
 * ContextPacket builder for Context Steady State.
 *
 * Reads stable checkpoints plus the append-only TurnDigest ledger, then renders
 * a hidden context message for the next real user turn and a debug payload.
 */

import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { prompt } from "@oh-my-pi/pi-utils";
import packetTemplate from "../prompts/context-steady/context-packet.md" with { type: "text" };
import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { latestContextCheckpoint } from "./checkpoint";
import { isCheckpointRelevantToPrompt, isContinuationPrompt, isDigestRelevantToPrompt } from "./relevance";
import { polishContextSteadyText } from "./text";
import {
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	type ContextCheckpoint,
	type ContextCheckpointSummaryItem,
	type ContextPacket,
	type ContextPacketRecallLayer,
	type ContextPacketSettings,
	type ContextPacketTrimDecision,
	type ContextRecallItem,
	TURN_DIGEST_CUSTOM_TYPE,
	type TurnDigest,
} from "./types";

interface DigestEntryRef {
	entryId: string;
	digest: TurnDigest;
}

export interface BuiltContextPacket {
	packet: ContextPacket;
	content: string;
}

interface PacketDigestView {
	index: number;
	userIntent: string;
	actionsTaken: string[];
	decisions: string[];
	filesTouched: Array<{ path: string; action: string }>;
	risks: string[];
	nextSteps: string[];
}

interface PacketCheckpointView {
	userIntents: string[];
	decisions: string[];
	filesTouched: Array<{ path: string; action: string }>;
	risks: string[];
	nextSteps: string[];
}

interface PacketRecallView {
	query: string;
	items: Array<{
		content: string;
		source?: string;
		timestamp?: string;
		score?: string;
	}>;
}

interface AppendCustomEntrySessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
}

function clampCount(value: number): number {
	if (!Number.isFinite(value)) return 3;
	return Math.max(0, Math.floor(value));
}

function clampNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function clampReserveRatio(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function resolvePacketBudget(settings: ContextPacketSettings): ContextPacket["budget"] {
	const configuredPacketMaxTokens = clampNonNegativeInteger(settings.maxTokens);
	const qualityWindowTokens = clampNonNegativeInteger(settings.qualityWindowTokens);
	const reserveRatio = clampReserveRatio(settings.reserveRatio);
	const reservedTokens = qualityWindowTokens > 0 ? Math.floor(qualityWindowTokens * reserveRatio) : 0;
	const qualityPacketBudget = qualityWindowTokens > 0 ? Math.max(0, qualityWindowTokens - reservedTokens) : 0;
	const packetTokenBudget =
		qualityWindowTokens > 0 ? Math.min(configuredPacketMaxTokens, qualityPacketBudget) : configuredPacketMaxTokens;

	return {
		qualityWindowTokens,
		reserveRatio,
		reservedTokens,
		packetTokenBudget,
		configuredPacketMaxTokens,
	};
}

function clampString(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function clampNarrative(value: string, maxLength: number): string {
	const polished = polishContextSteadyText(value);
	return clampString(polished || value.trim(), maxLength);
}

function clampStringArray(values: readonly string[], maxItems: number, maxLength: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (result.length >= maxItems) break;
		const clamped = clampNarrative(value, maxLength);
		if (!clamped) continue;
		const key = clamped.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(clamped);
	}
	return result;
}

function digestView(index: number, digest: TurnDigest): PacketDigestView {
	return {
		index,
		userIntent: clampNarrative(digest.userIntent, 240),
		actionsTaken: clampStringArray(digest.actionsTaken, 5, 180),
		decisions: clampStringArray(digest.decisions, 5, 180),
		filesTouched: digest.filesTouched.slice(0, 8).map(file => ({
			path: clampString(file.path, 240),
			action: file.action,
		})),
		risks: clampStringArray(digest.risks, 4, 180),
		nextSteps: clampStringArray(digest.nextSteps, 4, 180),
	};
}

function checkpointView(checkpoint: ContextCheckpoint): PacketCheckpointView {
	return {
		userIntents: checkpoint.summary.userIntents.map(item => clampNarrative(item.text, 220)),
		decisions: checkpoint.summary.decisions.map(item => clampNarrative(item.text, 180)),
		filesTouched: checkpoint.summary.filesTouched.map(item => ({
			path: clampString(item.text, 240),
			action: item.action,
		})),
		risks: checkpoint.summary.risks.map(item => clampNarrative(item.text, 180)),
		nextSteps: checkpoint.summary.nextSteps.map(item => clampNarrative(item.text, 180)),
	};
}

function recallItemRef(item: ContextRecallItem, index: number): string {
	const id = item.id?.trim();
	return id && id.length > 0 ? id : `recall:${index + 1}`;
}

function recallView(recall: ContextPacketRecallLayer): PacketRecallView {
	return {
		query: clampString(recall.query, 300),
		items: recall.items.map(item => ({
			content: clampString(item.content, 320),
			source: item.source ? clampString(item.source, 120) : undefined,
			timestamp: item.timestamp ? clampString(item.timestamp, 40) : undefined,
			score: typeof item.score === "number" ? item.score.toFixed(3) : undefined,
		})),
	};
}

function renderRecallLayerContent(recall: ContextPacketRecallLayer): string {
	return prompt.render(packetTemplate, { recall: recallView(recall), digests: [] });
}

function renderPacketContent(
	digests: readonly DigestEntryRef[],
	checkpoint?: ContextCheckpoint,
	recall?: ContextPacketRecallLayer,
): string {
	const views = digests.map((entry, index) => digestView(index + 1, entry.digest));
	return prompt.render(packetTemplate, {
		checkpoint: checkpoint ? checkpointView(checkpoint) : undefined,
		digests: views,
		recall: recall && recall.items.length > 0 ? recallView(recall) : undefined,
	});
}

function renderDigestLedgerContent(digests: readonly DigestEntryRef[]): string {
	const views = digests.map((entry, index) => digestView(index + 1, entry.digest));
	return prompt.render(packetTemplate, { digests: views });
}

function estimatePacketTokens(content: string): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
	});
}

function selectedWithinBudget(
	digests: readonly DigestEntryRef[],
	maxTokens: number,
): {
	selected: DigestEntryRef[];
	tokenEstimate: number;
	tokenTrimmed: number;
} {
	if (maxTokens <= 0) {
		return {
			selected: [],
			tokenEstimate: 0,
			tokenTrimmed: digests.length,
		};
	}

	let selected = [...digests];
	let content = renderDigestLedgerContent(selected);
	let tokenEstimate = estimatePacketTokens(content);
	let tokenTrimmed = 0;
	while (selected.length > 0 && tokenEstimate > maxTokens) {
		selected = selected.slice(1);
		tokenTrimmed++;
		content = renderDigestLedgerContent(selected);
		tokenEstimate = estimatePacketTokens(content);
	}
	return { selected, tokenEstimate, tokenTrimmed };
}

function selectedRecallWithinBudget(recall: ContextPacketRecallLayer | undefined): {
	selected: ContextPacketRecallLayer | undefined;
	tokenEstimate: number;
	tokenTrimmed: number;
} {
	if (!recall || recall.items.length === 0) {
		return {
			selected: undefined,
			tokenEstimate: 0,
			tokenTrimmed: 0,
		};
	}
	const maxTokens = clampNonNegativeInteger(recall.tokenBudget);
	if (maxTokens <= 0) {
		return {
			selected: undefined,
			tokenEstimate: 0,
			tokenTrimmed: recall.items.length,
		};
	}

	let selectedItems = [...recall.items];
	let selected: ContextPacketRecallLayer = { ...recall, items: selectedItems };
	let content = renderRecallLayerContent(selected);
	let tokenEstimate = estimatePacketTokens(content);
	let tokenTrimmed = 0;
	while (selectedItems.length > 0 && tokenEstimate > maxTokens) {
		selectedItems = selectedItems.slice(0, -1);
		tokenTrimmed++;
		selected = { ...recall, items: selectedItems };
		content = renderRecallLayerContent(selected);
		tokenEstimate = estimatePacketTokens(content);
	}
	if (selectedItems.length === 0) {
		return {
			selected: undefined,
			tokenEstimate: 0,
			tokenTrimmed: recall.items.length,
		};
	}
	return { selected, tokenEstimate, tokenTrimmed };
}

function cloneSummaryItem<T extends ContextCheckpointSummaryItem>(item: T): T {
	return { ...item, entryRefs: [...item.entryRefs] };
}

function cloneCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
	return {
		...checkpoint,
		entryRefs: [...checkpoint.entryRefs],
		summary: {
			userIntents: checkpoint.summary.userIntents.map(cloneSummaryItem),
			decisions: checkpoint.summary.decisions.map(cloneSummaryItem),
			filesTouched: checkpoint.summary.filesTouched.map(cloneSummaryItem),
			risks: checkpoint.summary.risks.map(cloneSummaryItem),
			nextSteps: checkpoint.summary.nextSteps.map(cloneSummaryItem),
		},
	};
}

function trimCheckpointTail(checkpoint: ContextCheckpoint): {
	checkpoint: ContextCheckpoint;
	trimmed: number;
} {
	if (checkpoint.summary.nextSteps.length > 0) {
		return {
			checkpoint: {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					nextSteps: checkpoint.summary.nextSteps.slice(0, -1),
				},
			},
			trimmed: 1,
		};
	}
	if (checkpoint.summary.risks.length > 0) {
		return {
			checkpoint: {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					risks: checkpoint.summary.risks.slice(0, -1),
				},
			},
			trimmed: 1,
		};
	}
	if (checkpoint.summary.decisions.length > 0) {
		return {
			checkpoint: {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					decisions: checkpoint.summary.decisions.slice(0, -1),
				},
			},
			trimmed: 1,
		};
	}
	if (checkpoint.summary.filesTouched.length > 0) {
		return {
			checkpoint: {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					filesTouched: checkpoint.summary.filesTouched.slice(0, -1),
				},
			},
			trimmed: 1,
		};
	}
	if (checkpoint.summary.userIntents.length > 1) {
		return {
			checkpoint: {
				...checkpoint,
				summary: {
					...checkpoint.summary,
					userIntents: checkpoint.summary.userIntents.slice(0, -1),
				},
			},
			trimmed: 1,
		};
	}
	return { checkpoint, trimmed: 0 };
}

function checkpointTokenEstimate(checkpoint: ContextCheckpoint | undefined): number {
	if (!checkpoint) return 0;
	return estimatePacketTokens(renderPacketContent([], checkpoint));
}

function appendTrimDecision(
	trimDecisions: ContextPacket["trimDecisions"],
	layer: ContextPacketTrimDecision["layer"],
	reason: ContextPacketTrimDecision["reason"],
	omitted: number,
): void {
	if (omitted <= 0) return;
	const lastDecision = trimDecisions.at(-1);
	if (lastDecision?.layer === layer && lastDecision.reason === reason) {
		trimDecisions[trimDecisions.length - 1] = {
			...lastDecision,
			omitted: lastDecision.omitted + omitted,
		};
		return;
	}
	trimDecisions.push({ layer, reason, omitted });
}

export function collectDigestRefs(entries: readonly SessionEntry[]): DigestEntryRef[] {
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

export function buildContextPacket(
	entries: readonly SessionEntry[],
	sessionId: string,
	currentPrompt: string,
	settings: ContextPacketSettings,
	recall?: ContextPacketRecallLayer,
): BuiltContextPacket | null {
	if (!settings.enabled) return null;

	const recentCount = clampCount(settings.recentDigests);
	const budgetedRecall = selectedRecallWithinBudget(recall);
	const recallLayer = budgetedRecall.selected;
	const recallItems = recallLayer?.items ?? [];

	const allDigests = collectDigestRefs(entries);
	const continuationPrompt = isContinuationPrompt(currentPrompt);
	const relevantDigests = continuationPrompt
		? allDigests
		: allDigests.filter(entry => isDigestRelevantToPrompt(currentPrompt, entry.digest));
	const topicShiftTrimmed = allDigests.length - relevantDigests.length;
	const checkpointCandidate = latestContextCheckpoint(entries);
	const checkpointRef =
		checkpointCandidate &&
		(continuationPrompt || isCheckpointRelevantToPrompt(currentPrompt, checkpointCandidate.checkpoint))
			? checkpointCandidate
			: null;
	const checkpointCovered = checkpointRef ? new Set(checkpointRef.checkpoint.entryRefs) : new Set<string>();
	const uncoveredDigests = relevantDigests.filter(entry => !checkpointCovered.has(entry.entryId));
	const checkpointCoveredTrimmed = relevantDigests.length - uncoveredDigests.length;
	const recentTrimmed = recentCount > 0 ? Math.max(0, uncoveredDigests.length - recentCount) : uncoveredDigests.length;
	const recentDigests = recentCount > 0 ? uncoveredDigests.slice(-recentCount) : [];
	const budget = resolvePacketBudget(settings);
	const packetTotalBudget = budget.packetTokenBudget;
	let selectedDigests = selectedWithinBudget(recentDigests, packetTotalBudget).selected;
	let digestTokenEstimate = estimatePacketTokens(renderDigestLedgerContent(selectedDigests));
	let digestTokenTrimmed = recentDigests.length - selectedDigests.length;
	let selectedCheckpoint = checkpointRef ? cloneCheckpoint(checkpointRef.checkpoint) : undefined;
	let checkpointLayerTrimmed = 0;
	let selectedRecall = recallLayer;
	let selectedRecallItems = [...recallItems];
	let recallTokenEstimate = budgetedRecall.tokenEstimate;
	let recallTokenTrimmed = budgetedRecall.tokenTrimmed;
	const trimDecisions: ContextPacket["trimDecisions"] = [];
	appendTrimDecision(trimDecisions, "turn_digest_ledger", "topic_shift", topicShiftTrimmed);
	appendTrimDecision(trimDecisions, "stable_checkpoint", "topic_shift", checkpointCandidate && !checkpointRef ? 1 : 0);
	appendTrimDecision(trimDecisions, "turn_digest_ledger", "checkpoint_covered", checkpointCoveredTrimmed);
	appendTrimDecision(trimDecisions, "turn_digest_ledger", "recent_limit", recentTrimmed);
	appendTrimDecision(trimDecisions, "turn_digest_ledger", "token_budget", digestTokenTrimmed);
	appendTrimDecision(trimDecisions, "retrieved_context", "token_budget", recallTokenTrimmed);

	let content = renderPacketContent(selectedDigests, selectedCheckpoint, selectedRecall);
	let packetTokenEstimate = estimatePacketTokens(content);
	if (packetTotalBudget <= 0) return null;
	while (packetTokenEstimate > packetTotalBudget && selectedRecallItems.length > 0) {
		selectedRecallItems = selectedRecallItems.slice(0, -1);
		recallTokenTrimmed++;
		selectedRecall = selectedRecallItems.length > 0 ? { ...recallLayer!, items: selectedRecallItems } : undefined;
		recallTokenEstimate = selectedRecall ? estimatePacketTokens(renderRecallLayerContent(selectedRecall)) : 0;
		content = renderPacketContent(selectedDigests, selectedCheckpoint, selectedRecall);
		packetTokenEstimate = estimatePacketTokens(content);
		appendTrimDecision(trimDecisions, "retrieved_context", "packet_total_budget", 1);
	}
	while (packetTokenEstimate > packetTotalBudget && selectedDigests.length > 1) {
		selectedDigests = selectedDigests.slice(1);
		digestTokenTrimmed++;
		digestTokenEstimate = estimatePacketTokens(renderDigestLedgerContent(selectedDigests));
		content = renderPacketContent(selectedDigests, selectedCheckpoint, selectedRecall);
		packetTokenEstimate = estimatePacketTokens(content);
		appendTrimDecision(trimDecisions, "turn_digest_ledger", "packet_total_budget", 1);
	}
	while (packetTokenEstimate > packetTotalBudget && selectedCheckpoint) {
		const trimmed = trimCheckpointTail(selectedCheckpoint);
		if (trimmed.trimmed === 0) break;
		selectedCheckpoint = trimmed.checkpoint;
		checkpointLayerTrimmed += trimmed.trimmed;
		content = renderPacketContent(selectedDigests, selectedCheckpoint, selectedRecall);
		packetTokenEstimate = estimatePacketTokens(content);
		appendTrimDecision(trimDecisions, "stable_checkpoint", "packet_total_budget", trimmed.trimmed);
	}
	if (
		packetTokenEstimate > packetTotalBudget ||
		(selectedDigests.length === 0 && !selectedCheckpoint && selectedRecallItems.length === 0)
	) {
		return null;
	}

	const digestRefs = selectedDigests.map(entry => entry.entryId);
	const recallRefs = selectedRecallItems.map(recallItemRef);
	const checkpointEstimate = checkpointTokenEstimate(selectedCheckpoint);

	const packet: ContextPacket = {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: `ctx_${crypto.randomUUID().slice(-12)}`,
		sessionId,
		createdAt: new Date().toISOString(),
		currentPromptPreview: clampString(currentPrompt, 240),
		layers: [
			...(selectedCheckpoint && checkpointRef
				? [
						{
							name: "stable_checkpoint" as const,
							entryRefs: [checkpointRef.entryId],
							tokenEstimate: checkpointEstimate,
							tokenBudget: checkpointRef.checkpoint.tokenBudget,
							trimmed: checkpointLayerTrimmed,
							stability: "stable" as const,
							cachePriority: "high" as const,
						},
					]
				: []),
			{
				name: "turn_digest_ledger",
				entryRefs: digestRefs,
				tokenEstimate: digestTokenEstimate,
				tokenBudget: budget.packetTokenBudget,
				trimmed: recentTrimmed + digestTokenTrimmed,
				stability: "append-only",
				cachePriority: "medium",
			},
			...(selectedRecall && selectedRecallItems.length > 0
				? [
						{
							name: "retrieved_context" as const,
							entryRefs: recallRefs,
							tokenEstimate: recallTokenEstimate,
							tokenBudget: selectedRecall.tokenBudget,
							trimmed: recallTokenTrimmed,
							stability: "volatile" as const,
							cachePriority: "low" as const,
						},
					]
				: []),
		],
		checkpointRef: selectedCheckpoint ? checkpointRef?.entryId : undefined,
		digestRefs,
		recallQuery: selectedRecall && selectedRecallItems.length > 0 ? selectedRecall.query : undefined,
		recallRefs,
		tokenEstimate: packetTokenEstimate,
		tokenBudget: packetTotalBudget,
		budget,
		trimDecisions,
		injectedMessageCustomType: CONTEXT_PACKET_MESSAGE_TYPE,
	};

	return { packet, content };
}

export function appendContextPacketDebugEntry(
	sessionManager: ReadonlySessionManager,
	customType: string,
	packet: ContextPacket,
): string {
	return (sessionManager as unknown as AppendCustomEntrySessionManager).appendCustomEntry(customType, packet);
}
