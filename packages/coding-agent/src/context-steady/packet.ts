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
import {
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	type ContextCheckpoint,
	type ContextPacket,
	type ContextPacketSettings,
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

function clampStringArray(values: readonly string[], maxItems: number, maxLength: number): string[] {
	return values.slice(0, maxItems).map(value => clampString(value, maxLength));
}

function digestView(index: number, digest: TurnDigest): PacketDigestView {
	return {
		index,
		userIntent: clampString(digest.userIntent, 240),
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
		userIntents: checkpoint.summary.userIntents.map(item => clampString(item.text, 220)),
		decisions: checkpoint.summary.decisions.map(item => clampString(item.text, 180)),
		filesTouched: checkpoint.summary.filesTouched.map(item => ({
			path: clampString(item.text, 240),
			action: item.action,
		})),
		risks: checkpoint.summary.risks.map(item => clampString(item.text, 180)),
		nextSteps: checkpoint.summary.nextSteps.map(item => clampString(item.text, 180)),
	};
}

function renderPacketContent(digests: readonly DigestEntryRef[], checkpoint?: ContextCheckpoint): string {
	const views = digests.map((entry, index) => digestView(index + 1, entry.digest));
	return prompt.render(packetTemplate, {
		checkpoint: checkpoint ? checkpointView(checkpoint) : undefined,
		digests: views,
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
): BuiltContextPacket | null {
	if (!settings.enabled) return null;

	const recentCount = clampCount(settings.recentDigests);
	if (recentCount === 0) return null;

	const allDigests = collectDigestRefs(entries);
	if (allDigests.length === 0) return null;

	const checkpointRef = latestContextCheckpoint(entries);
	const checkpointCovered = checkpointRef ? new Set(checkpointRef.checkpoint.entryRefs) : new Set<string>();
	const uncoveredDigests = allDigests.filter(entry => !checkpointCovered.has(entry.entryId));
	const checkpointCoveredTrimmed = allDigests.length - uncoveredDigests.length;
	const recentTrimmed = Math.max(0, uncoveredDigests.length - recentCount);
	const recentDigests = uncoveredDigests.slice(-recentCount);
	const budget = resolvePacketBudget(settings);
	const budgeted = selectedWithinBudget(recentDigests, budget.packetTokenBudget);
	if (budgeted.selected.length === 0 && !checkpointRef) return null;

	const content = renderPacketContent(budgeted.selected, checkpointRef?.checkpoint);
	const packetTokenEstimate = estimatePacketTokens(content);
	const totalPacketTokenBudget = budget.packetTokenBudget + (checkpointRef?.checkpoint.tokenBudget ?? 0);
	const digestRefs = budgeted.selected.map(entry => entry.entryId);
	const trimDecisions: ContextPacket["trimDecisions"] = [];
	if (checkpointCoveredTrimmed > 0) {
		trimDecisions.push({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: checkpointCoveredTrimmed,
		});
	}
	if (recentTrimmed > 0) {
		trimDecisions.push({ layer: "turn_digest_ledger", reason: "recent_limit", omitted: recentTrimmed });
	}
	if (budgeted.tokenTrimmed > 0) {
		trimDecisions.push({ layer: "turn_digest_ledger", reason: "token_budget", omitted: budgeted.tokenTrimmed });
	}

	const packet: ContextPacket = {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: `ctx_${crypto.randomUUID().slice(-12)}`,
		sessionId,
		createdAt: new Date().toISOString(),
		currentPromptPreview: clampString(currentPrompt, 240),
		layers: [
			...(checkpointRef
				? [
						{
							name: "stable_checkpoint" as const,
							entryRefs: [checkpointRef.entryId],
							tokenEstimate: checkpointRef.checkpoint.tokenEstimate,
							tokenBudget: checkpointRef.checkpoint.tokenBudget,
							trimmed: 0,
							stability: "stable" as const,
							cachePriority: "high" as const,
						},
					]
				: []),
			{
				name: "turn_digest_ledger",
				entryRefs: digestRefs,
				tokenEstimate: budgeted.tokenEstimate,
				tokenBudget: budget.packetTokenBudget,
				trimmed: recentTrimmed + budgeted.tokenTrimmed,
				stability: "append-only",
				cachePriority: "medium",
			},
		],
		checkpointRef: checkpointRef?.entryId,
		digestRefs,
		tokenEstimate: packetTokenEstimate,
		tokenBudget: totalPacketTokenBudget,
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
