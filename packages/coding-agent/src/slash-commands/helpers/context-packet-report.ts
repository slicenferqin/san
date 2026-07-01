import {
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	type ContextPacket,
	type ContextPacketLayer,
	type ContextPacketTrimDecision,
} from "../../context-steady/types";
import type { SessionEntry } from "../../session/session-entries";

const DEFAULT_PACKET_REPORT_COUNT = 1;
const MAX_PACKET_REPORT_COUNT = 20;

interface PacketEntryRef {
	entryId: string;
	packet: ContextPacket;
}

interface InjectedPacketMessageRef {
	entryId: string;
	packetId?: string;
}

export interface ContextPacketReportOptions {
	count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isContextPacket(value: unknown): value is ContextPacket {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === 1 &&
		typeof value.packetId === "string" &&
		typeof value.sessionId === "string" &&
		Array.isArray(value.layers) &&
		Array.isArray(value.digestRefs) &&
		Array.isArray(value.trimDecisions) &&
		value.injectedMessageCustomType === CONTEXT_PACKET_MESSAGE_TYPE
	);
}

function clampReportCount(count: number | undefined): number {
	if (count === undefined || !Number.isFinite(count)) return DEFAULT_PACKET_REPORT_COUNT;
	return Math.min(MAX_PACKET_REPORT_COUNT, Math.max(1, Math.floor(count)));
}

export function parseContextPacketReportCount(input: string): number | { error: string } {
	const trimmed = input.trim();
	if (!trimmed) return DEFAULT_PACKET_REPORT_COUNT;
	const count = Number(trimmed);
	if (!Number.isInteger(count) || count < 1 || count > MAX_PACKET_REPORT_COUNT) {
		return { error: `Usage: /context packet [1-${MAX_PACKET_REPORT_COUNT}]` };
	}
	return count;
}

function findContextPacketEntries(entries: readonly SessionEntry[]): PacketEntryRef[] {
	const packets: PacketEntryRef[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTEXT_PACKET_CUSTOM_TYPE) continue;
		if (!isContextPacket(entry.data)) continue;
		packets.push({ entryId: entry.id, packet: entry.data });
	}
	return packets;
}

function readPacketIdFromDetails(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const packetId = details.packetId;
	return typeof packetId === "string" && packetId.length > 0 ? packetId : undefined;
}

function findInjectedPacketMessages(entries: readonly SessionEntry[]): Map<string, InjectedPacketMessageRef> {
	const refs = new Map<string, InjectedPacketMessageRef>();
	for (const entry of entries) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== CONTEXT_PACKET_MESSAGE_TYPE) continue;
		const packetId = readPacketIdFromDetails(entry.details);
		if (!packetId) continue;
		refs.set(packetId, { entryId: entry.id, packetId });
	}
	return refs;
}

function formatNumber(value: number): string {
	return value.toLocaleString();
}

function formatRefs(refs: readonly string[]): string {
	return refs.length > 0 ? refs.join(", ") : "none";
}

function formatLayer(layer: ContextPacketLayer): string {
	return [
		`- ${layer.name}: ${formatNumber(layer.tokenEstimate)}/${formatNumber(layer.tokenBudget)} tokens`,
		`refs=${formatRefs(layer.entryRefs)}`,
		`trimmed=${layer.trimmed}`,
		`stability=${layer.stability}`,
		`cache=${layer.cachePriority}`,
	].join("; ");
}

function formatTrimDecision(decision: ContextPacketTrimDecision): string {
	return `- ${decision.layer}: ${decision.reason}, omitted=${decision.omitted}`;
}

function formatBudget(packet: ContextPacket): string[] {
	return [
		"Budget:",
		`- qualityWindowTokens=${formatNumber(packet.budget.qualityWindowTokens)}`,
		`- reserveRatio=${packet.budget.reserveRatio}`,
		`- reservedTokens=${formatNumber(packet.budget.reservedTokens)}`,
		`- packetTokenBudget=${formatNumber(packet.budget.packetTokenBudget)}`,
		`- configuredPacketMaxTokens=${formatNumber(packet.budget.configuredPacketMaxTokens)}`,
	];
}

function formatPacket(entry: PacketEntryRef, injectedMessages: ReadonlyMap<string, InjectedPacketMessageRef>): string {
	const injected = entry.packet.injectedMessageId
		? { entryId: entry.packet.injectedMessageId }
		: injectedMessages.get(entry.packet.packetId);
	const lines = [
		`## ContextPacket ${entry.packet.packetId}`,
		`Debug entry: ${entry.entryId}`,
		`Injected message: ${injected?.entryId ?? "not found"}`,
		`Created: ${entry.packet.createdAt}`,
		`Prompt: ${entry.packet.currentPromptPreview}`,
		`Packet tokens: ${formatNumber(entry.packet.tokenEstimate)}/${formatNumber(entry.packet.tokenBudget)}`,
		`Digest refs: ${formatRefs(entry.packet.digestRefs)}`,
		`Checkpoint ref: ${entry.packet.checkpointRef ?? "none"}`,
	];
	lines.push(...formatBudget(entry.packet));
	if (entry.packet.recallQuery || entry.packet.recallRefs.length > 0) {
		lines.push(`Recall query: ${entry.packet.recallQuery ?? "none"}`);
		lines.push(`Recall refs: ${formatRefs(entry.packet.recallRefs)}`);
	}
	lines.push("Layers:");
	for (const layer of entry.packet.layers) {
		lines.push(formatLayer(layer));
	}
	lines.push("Trim decisions:");
	if (entry.packet.trimDecisions.length === 0) {
		lines.push("- none");
	} else {
		for (const decision of entry.packet.trimDecisions) {
			lines.push(formatTrimDecision(decision));
		}
	}
	return lines.join("\n");
}

export function buildContextPacketReportText(
	entries: readonly SessionEntry[],
	options: ContextPacketReportOptions = {},
): string {
	const count = clampReportCount(options.count);
	const packets = findContextPacketEntries(entries);
	if (packets.length === 0) {
		return "No San ContextPacket debug entries found.";
	}
	const injectedMessages = findInjectedPacketMessages(entries);
	const selected = packets.slice(-count).reverse();
	const heading = `San ContextPacket debug view (${selected.length}/${packets.length} shown)`;
	return [heading, ...selected.map(packet => formatPacket(packet, injectedMessages))].join("\n\n");
}
