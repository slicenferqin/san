import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessageEntry, SessionEntry } from "../session/session-entries";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	type ContextCheckpoint,
	type ContextPacket,
	type TurnDigest,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function contentKey(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function customMessageEntryKey(entry: CustomMessageEntry): string {
	return `${entry.customType}\0${entry.timestamp}\0${contentKey(entry.content)}`;
}

function customMessageKey(message: AgentMessage): string | undefined {
	if (message.role !== "custom") return undefined;
	return `${message.customType}\0${new Date(message.timestamp).toISOString()}\0${contentKey(message.content)}`;
}

function packetIdFromMessage(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== CONTEXT_PACKET_MESSAGE_TYPE) return undefined;
	const details = message.details;
	if (!isRecord(details)) return undefined;
	const packetId = details.packetId;
	return typeof packetId === "string" && packetId.length > 0 ? packetId : undefined;
}

function isContextPacket(value: unknown): value is ContextPacket {
	return isRecord(value) && typeof value.packetId === "string" && Array.isArray(value.digestRefs);
}

function isContextCheckpoint(value: unknown): value is ContextCheckpoint {
	return isRecord(value) && typeof value.checkpointId === "string" && Array.isArray(value.entryRefs);
}

function isTurnDigest(value: unknown): value is TurnDigest {
	return isRecord(value) && typeof value.turnId === "string" && isRecord(value.source);
}

function latestPacket(branchEntries: readonly SessionEntry[], packetId: string | undefined): ContextPacket | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type !== "custom" || entry.customType !== CONTEXT_PACKET_CUSTOM_TYPE) continue;
		if (!isContextPacket(entry.data)) continue;
		if (packetId && entry.data.packetId !== packetId) continue;
		return entry.data;
	}
	return undefined;
}

function checkpointDigestRefs(branchEntries: readonly SessionEntry[], checkpointRef: string | undefined): string[] {
	if (!checkpointRef) return [];
	for (const entry of branchEntries) {
		if (entry.id !== checkpointRef) continue;
		if (entry.type !== "custom" || entry.customType !== CONTEXT_CHECKPOINT_CUSTOM_TYPE) return [];
		return isContextCheckpoint(entry.data) ? entry.data.entryRefs : [];
	}
	return [];
}

function digestCoveredEntryIds(
	branchEntries: readonly SessionEntry[],
	digestEntryRefs: ReadonlySet<string>,
): Set<string> {
	const covered = new Set<string>();
	const branchEntryIds = new Set(branchEntries.map(entry => entry.id));
	for (const entry of branchEntries) {
		if (!digestEntryRefs.has(entry.id)) continue;
		if (entry.type !== "custom" || !isTurnDigest(entry.data)) continue;
		const digest = entry.data;
		const toolEvidenceEntryIds = new Set(
			digest.toolEvidence
				.flatMap(evidence => evidence.entryIds ?? [])
				.filter(entryId => branchEntryIds.has(entryId)),
		);
		const fromIndex = branchEntries.findIndex(candidate => candidate.id === digest.source.fromEntryId);
		const toIndex = branchEntries.findIndex(candidate => candidate.id === digest.source.toEntryId);
		if (fromIndex >= 0 && toIndex >= 0) {
			const start = Math.min(fromIndex, toIndex);
			const end = Math.max(fromIndex, toIndex);
			for (let index = start; index <= end; index++) {
				const coveredEntry = branchEntries[index]!;
				if (coveredEntry.type === "message") {
					covered.add(coveredEntry.id);
				} else if (
					coveredEntry.type === "custom_message" &&
					toolEvidenceEntryIds.has(coveredEntry.id) &&
					coveredEntry.customType !== CONTEXT_PACKET_MESSAGE_TYPE
				) {
					covered.add(coveredEntry.id);
				}
			}
		} else {
			for (const entryId of toolEvidenceEntryIds) {
				covered.add(entryId);
			}
		}
	}
	return covered;
}

export function buildContextSteadyPrunedMessages(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
): AgentMessage[] {
	const packetMessage = messages.findLast(
		message => message.role === "custom" && message.customType === CONTEXT_PACKET_MESSAGE_TYPE,
	);
	if (!packetMessage) return [...messages];

	const packet = latestPacket(branchEntries, packetIdFromMessage(packetMessage));
	if (!packet) return [...messages];

	const digestRefs = new Set([...checkpointDigestRefs(branchEntries, packet.checkpointRef), ...packet.digestRefs]);
	if (digestRefs.size === 0) return [...messages];

	const coveredEntryIds = digestCoveredEntryIds(branchEntries, digestRefs);
	if (coveredEntryIds.size === 0) return [...messages];

	const coveredMessageRefs = new WeakSet<AgentMessage>();
	const coveredCustomMessageKeys = new Set<string>();
	for (const entry of branchEntries) {
		if (!coveredEntryIds.has(entry.id)) continue;
		if (entry.type === "message") {
			coveredMessageRefs.add(entry.message);
		} else if (entry.type === "custom_message" && entry.customType !== CONTEXT_PACKET_MESSAGE_TYPE) {
			coveredCustomMessageKeys.add(customMessageEntryKey(entry));
		}
	}

	let pruned: AgentMessage[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const key = customMessageKey(message);
		const shouldPrune = coveredMessageRefs.has(message) || (key !== undefined && coveredCustomMessageKeys.has(key));
		if (!shouldPrune) {
			if (pruned) pruned.push(message);
			continue;
		}
		if (!pruned) pruned = messages.slice(0, index);
	}

	return pruned ?? [...messages];
}

export function estimateContextSteadyPrunedTokens(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
	estimate: (message: AgentMessage) => number,
): number {
	return buildContextSteadyPrunedMessages(messages, branchEntries).reduce(
		(sum, message) => sum + estimate(message),
		0,
	);
}
