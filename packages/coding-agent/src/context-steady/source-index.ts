import type { SessionEntry } from "../session/session-entries";
import { collectContextCheckpoints } from "./checkpoint";
import type {
	ContextPlanAttachmentSource,
	ContextPlanCheckpointSource,
	ContextPlanDigestSource,
	ContextPlanExactSource,
	ContextPlanFileEvidenceSource,
	ContextPlanToolPairSource,
	ContextPlanTurnBundleSource,
	ContextSourceIndex,
} from "./plan-types";
import { CONTEXT_PACKET_CUSTOM_TYPE, TURN_DIGEST_CUSTOM_TYPE, type TurnDigest } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTurnDigest(value: unknown): value is TurnDigest {
	return typeof value === "object" && value !== null && "turnId" in value && "source" in value;
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

function collectDigestSources(entries: readonly SessionEntry[]): ContextPlanDigestSource[] {
	const digests: ContextPlanDigestSource[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TURN_DIGEST_CUSTOM_TYPE) continue;
		if (!isTurnDigest(entry.data)) continue;
		digests.push({
			entryId: entry.id,
			digest: entry.data,
			sourceEntryRefs: sourceEntryRefsForDigest(entries, entry.data),
		});
	}
	return digests;
}

function textToolCallId(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall") return undefined;
	return typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
}

function textToolName(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall") return undefined;
	return typeof block.name === "string" && block.name.length > 0 ? block.name : undefined;
}

function assistantToolCalls(entry: SessionEntry): Array<{ id: string; name?: string }> {
	if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content))
		return [];
	const calls: Array<{ id: string; name?: string }> = [];
	for (const block of entry.message.content) {
		const id = textToolCallId(block);
		if (!id) continue;
		const name = textToolName(block);
		calls.push(name ? { id, name } : { id });
	}
	return calls;
}

function collectExactEntries(entries: readonly SessionEntry[]): ContextPlanExactSource[] {
	return entries
		.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
		.map(entry => ({ kind: "exact", entryId: entry.id, message: entry.message }));
}

function collectTurnBundles(entries: readonly SessionEntry[]): ContextPlanTurnBundleSource[] {
	const bundles: ContextPlanTurnBundleSource[] = [];
	let current: { entryIds: string[]; userEntryId?: string } | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		if (entry.type === "message" && entry.message.role === "user") {
			if (current && current.entryIds.length > 0) bundles.push({ kind: "turn_bundle", ...current });
			current = { entryIds: [entry.id], userEntryId: entry.id };
			continue;
		}
		if (!current) current = { entryIds: [] };
		current.entryIds.push(entry.id);
	}
	if (current && current.entryIds.length > 0) bundles.push({ kind: "turn_bundle", ...current });
	return bundles;
}

function collectToolPairs(entries: readonly SessionEntry[]): ContextPlanToolPairSource[] {
	const pending = new Map<string, { name?: string; assistantEntryId: string }>();
	const pairs: ContextPlanToolPairSource[] = [];
	for (const entry of entries) {
		for (const call of assistantToolCalls(entry)) {
			pending.set(call.id, { name: call.name, assistantEntryId: entry.id });
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const toolCallId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : undefined;
		if (!toolCallId) continue;
		const match = pending.get(toolCallId);
		const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName : match?.name;
		pairs.push({
			kind: "tool_pair",
			entryIds: match ? [match.assistantEntryId, entry.id] : [entry.id],
			toolCallId,
			...(toolName ? { toolName } : {}),
			...(match ? { assistantEntryId: match.assistantEntryId } : {}),
			resultEntryId: entry.id,
			complete: match !== undefined,
		});
		pending.delete(toolCallId);
	}
	for (const [toolCallId, match] of pending) {
		pairs.push({
			kind: "tool_pair",
			entryIds: [match.assistantEntryId],
			toolCallId,
			...(match.name ? { toolName: match.name } : {}),
			assistantEntryId: match.assistantEntryId,
			complete: false,
		});
	}
	return pairs;
}

function collectFileEvidence(entries: readonly SessionEntry[]): ContextPlanFileEvidenceSource[] {
	const sources: ContextPlanFileEvidenceSource[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "fileMention") continue;
		const files = Array.isArray(entry.message.files) ? entry.message.files : [];
		const paths = files
			.map(file => (isRecord(file) && typeof file.path === "string" ? file.path : undefined))
			.filter((path): path is string => path !== undefined && path.length > 0);
		if (paths.length > 0) sources.push({ kind: "file_evidence", entryId: entry.id, paths });
	}
	return sources;
}

function collectAttachments(entries: readonly SessionEntry[]): ContextPlanAttachmentSource[] {
	const attachments: ContextPlanAttachmentSource[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === "image-attachment-description") {
			attachments.push({ kind: "attachment", entryId: entry.id, customType: entry.customType });
		}
	}
	return attachments;
}

export function buildContextSourceIndex(entries: readonly SessionEntry[]): ContextSourceIndex {
	const exactEntries = collectExactEntries(entries);
	const turnBundles = collectTurnBundles(entries);
	const toolPairs = collectToolPairs(entries);
	const fileEvidence = collectFileEvidence(entries);
	const attachments = collectAttachments(entries);
	const digests = collectDigestSources(entries);
	const digestByEntryId = new Map(digests.map(digest => [digest.entryId, digest]));
	const checkpoints: ContextPlanCheckpointSource[] = collectContextCheckpoints(entries).map(ref => {
		const coveredDigestEntryRefs = ref.checkpoint.entryRefs.filter(entryRef => digestByEntryId.has(entryRef));
		const authoritativeSourceRefs =
			ref.checkpoint.coveredSourceEntryRefs && ref.checkpoint.coveredSourceEntryRefs.length > 0
				? ref.checkpoint.coveredSourceEntryRefs.filter(entryRef => entries.some(entry => entry.id === entryRef))
				: coveredDigestEntryRefs.flatMap(entryRef => {
						const digestSource = digestByEntryId.get(entryRef);
						// Fallback digests cannot authorize raw omission via checkpoint expansion.
						if (!digestSource || digestSource.digest.fallback === true) return [];
						return digestSource.sourceEntryRefs;
					});
		// Even when a v2 checkpoint lists coveredSourceEntryRefs, drop any span that only
		// a fallback digest could have contributed (legacy or buggy writers).
		const fallbackSourceRefs = new Set(
			coveredDigestEntryRefs.flatMap(entryRef => {
				const digestSource = digestByEntryId.get(entryRef);
				return digestSource?.digest.fallback === true ? digestSource.sourceEntryRefs : [];
			}),
		);
		const coveredSourceEntryRefs = authoritativeSourceRefs.filter(entryRef => !fallbackSourceRefs.has(entryRef));
		return { entryId: ref.entryId, checkpoint: ref.checkpoint, coveredDigestEntryRefs, coveredSourceEntryRefs };
	});
	return {
		exactEntries,
		turnBundles,
		toolPairs,
		fileEvidence,
		attachments,
		digests,
		checkpoints,
		entryIds: entries.map(entry => entry.id),
	};
}

export function isContextPlanLegacyPacketEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === CONTEXT_PACKET_CUSTOM_TYPE;
}
