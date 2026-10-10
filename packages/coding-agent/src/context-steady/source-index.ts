import type { AgentMessage } from "@san/agent";
import type { SessionEntry } from "../session/session-entries";
import { collectContextCheckpoints } from "./checkpoint";
import type {
	ContextPlanArtifactRef,
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

function sourceEntryRefsForDigest(
	entries: readonly SessionEntry[],
	entryPositions: ReadonlyMap<string, number>,
	digest: TurnDigest,
): string[] {
	const fromIndex = entryPositions.get(digest.source.fromEntryId);
	const toIndex = entryPositions.get(digest.source.toEntryId);
	if (fromIndex === undefined || toIndex === undefined || fromIndex > toIndex) {
		return digest.toolEvidence
			.flatMap(evidence => evidence.entryIds ?? [])
			.filter(entryId => entryPositions.has(entryId));
	}
	return entries.slice(fromIndex, toIndex + 1).map(entry => entry.id);
}

function collectDigestSources(
	entries: readonly SessionEntry[],
	entryPositions: ReadonlyMap<string, number>,
): ContextPlanDigestSource[] {
	return collectDigestRefs(entries).map(ref => ({
		entryId: ref.entryId,
		digest: ref.digest,
		sourceEntryRefs: sourceEntryRefsForDigest(entries, entryPositions, ref.digest),
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

/**
 * 最新一批尚未被消费的工具结果(含发起调用的 assistant entry)。
 *
 * 从历史尾部向前扫:先连续收集已完成的 toolResult(平行调用会形成一段连续
 * 结果),直到遇到发起这些调用的 assistant 消息并一并收集,然后停在第一条
 * 更早的其它消息上 —— 那条消息就是消费了上一批结果、又引出这一批的边界。
 * 尚未返回的调用(只有 assistant toolCall、没有对应结果)也会被收集:它们的
 * 结果即将落地,不能刚进上下文就被降级。
 */
export function collectLatestBatchEntryRefs(entries: readonly SessionEntry[]): string[] {
	const collected: string[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role === "toolResult") {
			collected.unshift(entry.id);
			continue;
		}
		if (role === "assistant") {
			collected.unshift(entry.id);
			break;
		}
		break;
	}
	return collected;
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

/** toolResult 的原文文本(注入消息含图片块,只取文本部分),用于降级前捕获。 */
export function toolResultFullText(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	return contentText(message.content);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

/** `artifact://<id>` 只接受纯数字 id(见 internal-urls/artifact-protocol.ts)。 */
const ARTIFACT_URL_RE = /^artifact:\/\/(\d+)/;

/**
 * 从历史里直接可见的 `artifact://` 引用。降级 stub 的恢复入口优先复用这些
 * 引用(逐字节原文已存在),只有**都没有**时才需要宿主新落盘一份。
 *
 * 两个来源:
 * - assistant toolCall 参数:模型自己按 `Read artifact://7` 打开的引用;
 * - toolResult.details.meta.truncation.artifactId:输出只是**显示截断**、
 *   原文早已保存时记下的 id。
 */
function collectArtifactRefs(entries: readonly SessionEntry[]): ContextPlanArtifactRef[] {
	const refs: ContextPlanArtifactRef[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const toolCallId = textToolCallId(block);
				if (!toolCallId || !isRecord(block) || !isRecord(block.arguments)) continue;
				for (const value of Object.values(block.arguments)) {
					if (typeof value !== "string") continue;
					const match = ARTIFACT_URL_RE.exec(value);
					if (!match || seen.has(match[1])) continue;
					seen.add(match[1]);
					refs.push({ artifactId: match[1], entryId: entry.id, toolCallId, origin: "assistant_tool_call" });
				}
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const details = message.details;
		const meta = isRecord(details) && isRecord(details.meta) ? details.meta : undefined;
		const truncation = meta && isRecord(meta.truncation) ? meta.truncation : undefined;
		const artifactId =
			truncation && typeof truncation.artifactId === "string" ? truncation.artifactId.trim() : undefined;
		if (!artifactId) continue;
		// dedup 键必须带 origin:同一条原文可能先被模型当参数读过(assistant
		// toolCall),之后才以 result_metadata 形式标记;只按 artifactId 去重会
		// 丢掉 result 自己的引用,使可复用的恢复入口查不到。
		const seenKey = `result_metadata\0${artifactId}`;
		if (seen.has(seenKey)) continue;
		seen.add(seenKey);
		refs.push({ artifactId, entryId: entry.id, toolCallId: message.toolCallId, origin: "result_metadata" });
	}
	return refs;
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
	// 检查点可能引用数万条历史，逐条扫描整个分支会产生平方级开销。
	const entryPositions = new Map<string, number>();
	for (const [index, entry] of entries.entries()) {
		const id = entry.id;
		if (!entryPositions.has(id)) entryPositions.set(id, index);
	}
	const exactEntries = collectExactEntries(entries);
	const turnBundles = collectTurnBundles(entries);
	const toolPairs = collectToolPairs(entries);
	const fileEvidence = collectFileEvidence(entries);
	const attachments = collectAttachments(entries);
	const digests = collectDigestSources(entries, entryPositions);
	const digestByEntryId = new Map(digests.map(digest => [digest.entryId, digest]));
	const checkpoints: ContextPlanCheckpointSource[] = collectContextCheckpoints(entries).map(ref => {
		const coveredDigestEntryRefs = ref.checkpoint.entryRefs.filter(entryRef => digestByEntryId.has(entryRef));
		const authoritativeSourceRefs =
			ref.checkpoint.coveredSourceEntryRefs && ref.checkpoint.coveredSourceEntryRefs.length > 0
				? ref.checkpoint.coveredSourceEntryRefs.filter(entryRef => entryPositions.has(entryRef))
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
		artifactRefs: collectArtifactRefs(entries),
		entryIds: entries.map(entry => entry.id),
	};
}

export function isContextPlanLegacyPacketEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === CONTEXT_PACKET_CUSTOM_TYPE;
}
