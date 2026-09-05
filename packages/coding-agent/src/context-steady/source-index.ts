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
import { collectDigestRefs, isAuthoritativeUserEntry } from "./session";
import { CONTEXT_PACKET_CUSTOM_TYPE, type TurnDigest } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
	return collectDigestRefs(entries).map(ref => ({
		entryId: ref.entryId,
		digest: ref.digest,
		sourceEntryRefs: sourceEntryRefsForDigest(entries, ref.digest),
	}));
}

function textToolCallId(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall") return undefined;
	return typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
}

function textToolName(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall") return undefined;
	return typeof block.name === "string" && block.name.length > 0 ? block.name : undefined;
}

/** 文件修改类内置工具:同一路径的后续完整 mutation 使旧输出失去信息量。 */
const MUTATION_TOOL_NAMES: Record<string, true> = { edit: true, write: true, ast_edit: true };

function mutationPath(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) return undefined;
	for (const key of ["path", "file_path", "filePath"]) {
		const value = block.arguments[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function readArgument(block: unknown, key: "path" | "selector"): string | undefined {
	if (!isRecord(block) || block.type !== "toolCall" || textToolName(block) !== "read") return undefined;
	if (!isRecord(block.arguments)) return undefined;
	const value = block.arguments[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readContentSnapshot(content: unknown): string | undefined {
	const serialized = JSON.stringify(content);
	return serialized === undefined ? undefined : String(Bun.hash(serialized));
}

function assistantToolCalls(entry: SessionEntry): Array<{
	id: string;
	name?: string;
	path?: string;
	readPath?: string;
	readSelector?: string;
}> {
	if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content))
		return [];
	const calls: Array<{ id: string; name?: string; path?: string; readPath?: string; readSelector?: string }> = [];
	for (const block of entry.message.content) {
		const id = textToolCallId(block);
		if (!id) continue;
		const name = textToolName(block);
		const path = name && MUTATION_TOOL_NAMES[name] ? mutationPath(block) : undefined;
		const readPath = readArgument(block, "path");
		const readSelector = readArgument(block, "selector");
		calls.push({
			id,
			...(name ? { name } : {}),
			...(path ? { path } : {}),
			...(readPath ? { readPath } : {}),
			...(readSelector ? { readSelector } : {}),
		});
	}
	return calls;
}

function collectToolPairs(entries: readonly SessionEntry[]): ContextPlanToolPairSource[] {
	const pending = new Map<
		string,
		{ name?: string; path?: string; readPath?: string; readSelector?: string; assistantEntryId: string }
	>();
	const pairs: ContextPlanToolPairSource[] = [];
	for (const entry of entries) {
		for (const call of assistantToolCalls(entry)) {
			pending.set(call.id, {
				name: call.name,
				path: call.path,
				readPath: call.readPath,
				readSelector: call.readSelector,
				assistantEntryId: entry.id,
			});
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const toolCallId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : undefined;
		if (!toolCallId) continue;
		const match = pending.get(toolCallId);
		const toolName = typeof entry.message.toolName === "string" ? entry.message.toolName : match?.name;
		const snapshot = toolName === "read" && match?.readPath ? readContentSnapshot(entry.message.content) : undefined;
		const readIdentity =
			snapshot !== undefined && match?.readPath
				? { path: match.readPath, selector: match.readSelector ?? "", snapshot }
				: undefined;
		pairs.push({
			kind: "tool_pair",
			entryIds: match ? [match.assistantEntryId, entry.id] : [entry.id],
			toolCallId,
			...(toolName ? { toolName } : {}),
			...(match ? { assistantEntryId: match.assistantEntryId } : {}),
			...(match?.path ? { path: match.path } : {}),
			...(readIdentity ? { readIdentity } : {}),
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
			...(match.path ? { path: match.path } : {}),
			assistantEntryId: match.assistantEntryId,
			complete: false,
		});
	}
	markSupersededMutations(pairs);
	return pairs;
}



/**
 * 标记 superseded mutation:同一路径存在**更晚的完整** mutation pair 时,
 * 较早的完整 pair 记 `supersededByToolCallId`。最后一次 mutation、未闭合
 * pair(结果未落地)与非 mutation 工具永不标记。
 */
function markSupersededMutations(pairs: ContextPlanToolPairSource[]): void {
	const latestByPath = new Map<string, string>();
	for (const pair of pairs) {
		if (!pair.path || !pair.complete || pair.resultEntryId === undefined) continue;
		latestByPath.set(pair.path, pair.toolCallId);
	}
	for (const pair of pairs) {
		if (!pair.path || !pair.complete || pair.resultEntryId === undefined) continue;
		const latest = latestByPath.get(pair.path);
		if (latest !== undefined && latest !== pair.toolCallId) pair.supersededByToolCallId = latest;
	}
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
		if (isAuthoritativeUserEntry(entry)) {
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
