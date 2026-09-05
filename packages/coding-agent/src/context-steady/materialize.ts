import type { AgentMessage } from "@san/agent";
import { estimateTokens } from "@san/agent/compaction";
import { prompt } from "@san/utils";
import agedOutputStubTemplate from "../prompts/context-steady/aged-output-stub.md" with { type: "text" };
import contextPlanTemplate from "../prompts/context-steady/context-plan.md" with { type: "text" };
import contextRecallTemplate from "../prompts/context-steady/context-recall.md" with { type: "text" };
import emergencyStubTemplate from "../prompts/context-steady/emergency-stub.md" with { type: "text" };
import offloadedImageTemplate from "../prompts/context-steady/offloaded-image.md" with { type: "text" };
import supersededEditStubTemplate from "../prompts/context-steady/superseded-edit-stub.md" with { type: "text" };
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { validateContextPlanCoverage } from "./coverage";
import { projectDigestTier } from "./decay";
import type { BuiltContextPlan, ContextPlanMaterial, ContextPlanToolStubMaterial } from "./plan-types";
import { CONTEXT_PLAN_MESSAGE_TYPE } from "./plan-types";
import { CONTEXT_PACKET_MESSAGE_TYPE, CONTEXT_RECALL_MESSAGE_TYPE, type ContextPacketRecallLayer } from "./types";

const DIGEST_PRUNABLE_CUSTOM_MESSAGE_TYPES: Record<string, true> = { "image-attachment-description": true };

function contentKey(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function timestampKey(timestamp: unknown): string {
	if (typeof timestamp === "number") return new Date(timestamp).toISOString();
	if (typeof timestamp === "string") return new Date(timestamp).toISOString();
	return "";
}

/**
 * Per-message shape tokens for the sequence as it ships to the provider.
 *
 * Deliberately shape-only: role, content extent, and stub kind. A stub
 * collapses an 8K tool result to one line, so the extent shift is the signal;
 * hashing full content would re-serialize the whole transcript on every
 * provider call for no extra discrimination.
 */
export function contextWireSequenceTokens(messages: readonly AgentMessage[]): string[] {
	const tokens: string[] = [];
	for (const message of messages) {
		let extent = 0;
		if (message.role === "fileMention") {
			// No `content` field at all — the wire payload lives in `files`, so
			// measuring `content` would score every re-read of a mention as 0.
			for (const file of message.files) extent += file.path.length + file.content.length + (file.image ? 1 : 0);
		} else if ("content" in message) {
			const content = message.content;
			if (typeof content === "string") extent = content.length;
			else if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
						extent += part.text.length;
					} else {
						// Images and other non-text parts carry no cheap length; count
						// them as presence so an added or dropped part still moves the token.
						extent += 1;
					}
				}
			}
		}
		let stubKind: unknown = "";
		if ("details" in message && message.details && typeof message.details === "object") {
			const details = message.details;
			if ("stubKind" in details) stubKind = details.stubKind ?? "";
		}
		tokens.push(`${message.role}:${extent}:${String(stubKind)}`);
	}
	return tokens;
}

/**
 * Whether `current` still begins with the whole of `previous`.
 *
 * Provider prompt caches match on a byte prefix, so appending to the tail is
 * free and only a rewrite of an already-sent message voids the cache. Equality
 * is the wrong test — every turn appends, so comparing whole-sequence hashes
 * would flag every single request as churned. Retention is the property that
 * actually predicts a cold prefill.
 *
 * The plan's `renderedContent` cannot substitute for this: `materialViews`
 * surfaces only checkpoints, digests, and recalls, so a tool-output stub
 * swapped in by `substituteToolStub` rewrites earlier wire bytes while leaving
 * the rendered plan — and any fingerprint built from it — byte-identical.
 */
export function wireSequencePrefixRetained(previous: readonly string[], current: readonly string[]): boolean {
	if (previous.length > current.length) return false;
	for (let index = 0; index < previous.length; index++) {
		if (previous[index] !== current[index]) return false;
	}
	return true;
}

function sessionMessageContentKey(message: AgentMessage): unknown {
	if (message.role === "fileMention") return message.files;
	if ("content" in message) return message.content;
	return undefined;
}

function sessionMessageEntryKey(entry: SessionMessageEntry): string {
	const message = entry.message;
	return `${message.role}\0${timestampKey(message.timestamp)}\0${contentKey(sessionMessageContentKey(message))}`;
}

function sessionMessageKey(message: AgentMessage): string | undefined {
	if (
		message.role !== "user" &&
		message.role !== "developer" &&
		message.role !== "assistant" &&
		message.role !== "toolResult" &&
		message.role !== "fileMention"
	) {
		return undefined;
	}
	return `${message.role}\0${timestampKey(message.timestamp)}\0${contentKey(sessionMessageContentKey(message))}`;
}

function customMessageEntryKey(entry: CustomMessageEntry): string {
	return `${entry.customType}\0${entry.timestamp}\0${contentKey(entry.content)}`;
}

function customMessageKey(message: AgentMessage): string | undefined {
	if (message.role !== "custom") return undefined;
	return `${message.customType}\0${timestampKey(message.timestamp)}\0${contentKey(message.content)}`;
}

function clampString(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function clampArray(values: readonly string[], maxItems: number, maxLength: number): string[] {
	return values.slice(0, maxItems).map(value => clampString(value, maxLength));
}

function materialViews(materials: readonly ContextPlanMaterial[]) {
	const checkpoints = [];
	const digests = [];
	const recalls = [];
	let goalAnchor: { objective: string; todoLines: string[]; pendingGates: string[]; nextSteps: string[] } | undefined;
	for (const material of materials) {
		if ("objective" in material) {
			// 目标锚:最多一个,渲染在 plan 头部。
			goalAnchor = {
				objective: material.objective,
				todoLines: material.todoLines,
				pendingGates: material.pendingGates,
				nextSteps: material.nextSteps,
			};
		} else if ("checkpoint" in material) {
			const checkpoint = material.checkpoint;
			checkpoints.push({
				materialId: material.audit.materialId,
				refs: material.audit.entryRefs.join(", "),
				userIntents: clampArray(
					checkpoint.summary.userIntents.map(item => item.text),
					20,
					220,
				),
				decisions: clampArray(
					checkpoint.summary.decisions.map(item => item.text),
					20,
					180,
				),
				filesTouched: checkpoint.summary.filesTouched
					.slice(0, 30)
					.map(file => ({ path: clampString(file.text, 240), action: file.action })),
				risks: clampArray(
					checkpoint.summary.risks.map(item => item.text),
					12,
					180,
				),
				nextSteps: clampArray(
					checkpoint.summary.nextSteps.map(item => item.text),
					12,
					180,
				),
			});
		} else if ("digest" in material) {
			// Decay 选级投影:粒度由 planner 定级;缺省 full(旧 plan 兼容)。
			const view = projectDigestTier(material.digest, material.tier ?? "full");
			digests.push({
				materialId: material.audit.materialId,
				refs: material.audit.entryRefs.join(", "),
				userIntent: view.userIntent,
				actionsTaken: view.actionsTaken,
				decisions: view.decisions,
				filesTouched: view.filesTouched,
				risks: view.risks,
				nextSteps: view.nextSteps,
			});
		} else if ("recall" in material) {
			recalls.push({
				materialId: material.audit.materialId,
				query: clampString(material.recall.query, 300),
				items: material.recall.items.map(item => ({
					content: clampString(item.content, 320),
					source: item.source ? clampString(item.source, 120) : undefined,
					timestamp: item.timestamp ? clampString(item.timestamp, 40) : undefined,
					score: typeof item.score === "number" ? item.score.toFixed(3) : undefined,
				})),
			});
		}
		// tool_stub materials act on payload projection only — never rendered
		// into the plan message.
	}
	return { checkpoints, digests, recalls, goalAnchor };
}

export function renderContextPlanContent(plan: Pick<BuiltContextPlan, "audit" | "materials">): string {
	return prompt.render(contextPlanTemplate, {
		budget: plan.audit.budget,
		qualityGate: plan.audit.qualityGate,
		...materialViews(plan.materials),
	});
}

function coveredMessageRefs(branchEntries: readonly SessionEntry[], coveredEntryIds: ReadonlySet<string>) {
	const refs = new WeakSet<AgentMessage>();
	const messageKeys = new Map<string, number>();
	const customKeys = new Map<string, number>();
	for (const entry of branchEntries) {
		if (!coveredEntryIds.has(entry.id)) continue;
		if (entry.type === "message") {
			refs.add(entry.message);
			const entryKey = sessionMessageEntryKey(entry);
			messageKeys.set(entryKey, (messageKeys.get(entryKey) ?? 0) + 1);
		} else if (entry.type === "custom_message" && entry.customType !== CONTEXT_PACKET_MESSAGE_TYPE) {
			if (DIGEST_PRUNABLE_CUSTOM_MESSAGE_TYPES[entry.customType]) {
				const entryKey = customMessageEntryKey(entry);
				customKeys.set(entryKey, (customKeys.get(entryKey) ?? 0) + 1);
			}
		}
	}
	return { refs, messageKeys, customKeys };
}

function consumeCount(counts: Map<string, number>, key: string | undefined): boolean {
	if (key === undefined) return false;
	const remaining = counts.get(key) ?? 0;
	if (remaining <= 0) return false;
	remaining === 1 ? counts.delete(key) : counts.set(key, remaining - 1);
	return true;
}

function stripPriorDerivedPlanMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message =>
			!(message.role === "custom" && message.customType === CONTEXT_PACKET_MESSAGE_TYPE) &&
			!(message.role === "custom" && message.customType === CONTEXT_PLAN_MESSAGE_TYPE) &&
			!(message.role === "custom" && message.customType === CONTEXT_RECALL_MESSAGE_TYPE),
	);
}

/** Volatile recall rides before the current user prompt — after the frozen prefix. */
function injectVolatileRecall(messages: readonly AgentMessage[], recall: AgentMessage | undefined): AgentMessage[] {
	if (!recall) return [...messages];
	const insertAt = Math.max(
		0,
		messages.findLastIndex(message => message.role === "user"),
	);
	return [...messages.slice(0, insertAt), recall, ...messages.slice(insertAt)];
}

/** Render the per-request volatile recall message (stable-projection mode). */
export function buildContextRecallMessage(recall: ContextPacketRecallLayer): AgentMessage {
	const content = prompt.render(contextRecallTemplate, {
		query: clampString(recall.query, 300),
		items: recall.items.map(item => ({
			content: clampString(item.content, 320),
			source: item.source ? clampString(item.source, 120) : undefined,
			timestamp: item.timestamp ? clampString(item.timestamp, 40) : undefined,
			score: typeof item.score === "number" ? item.score.toFixed(3) : undefined,
		})),
	});
	return {
		role: "custom",
		customType: CONTEXT_RECALL_MESSAGE_TYPE,
		content,
		display: false,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function isToolStubMaterial(material: ContextPlanMaterial): material is ContextPlanToolStubMaterial {
	return "toolCallId" in material && "resultEntryId" in material;
}

/** Role+timestamp identity: survives stub/image substitution, which rewrites content. */
function messageSubstitutionKey(message: AgentMessage): string | undefined {
	if (
		message.role !== "user" &&
		message.role !== "developer" &&
		message.role !== "assistant" &&
		message.role !== "toolResult"
	) {
		return undefined;
	}
	return `${message.role}\0${timestampKey(message.timestamp)}`;
}

function messageCarriesImages(message: AgentMessage): boolean {
	return (
		Array.isArray((message as { content?: unknown }).content) &&
		((message as { content: unknown[] }).content as unknown[]).some(
			block => (block as { type?: unknown } | null)?.type === "image",
		)
	);
}

/** Superseded mutation 的替换映射:消息引用与内容键双通道,与 covered 消息同一匹配机制。 */
function toolStubTargets(branchEntries: readonly SessionEntry[], stubs: readonly ContextPlanToolStubMaterial[]) {
	const byRef = new WeakMap<AgentMessage, ContextPlanToolStubMaterial>();
	const byKey = new Map<string, ContextPlanToolStubMaterial>();
	if (stubs.length === 0) return { byRef, byKey };
	const stubByResultEntryId = new Map(stubs.map(stub => [stub.resultEntryId, stub]));
	for (const entry of branchEntries) {
		if (entry.type !== "message") continue;
		const stub = stubByResultEntryId.get(entry.id);
		if (!stub || entry.message.role !== "toolResult") continue;
		byRef.set(entry.message, stub);
		byKey.set(sessionMessageEntryKey(entry), stub);
	}
	return { byRef, byKey };
}

function substituteToolStub(message: AgentMessage, stub: ContextPlanToolStubMaterial): AgentMessage {
	const template =
		stub.stubKind === "emergency"
			? emergencyStubTemplate
			: stub.stubKind === "aged" || stub.stubKind === "duplicate"
				? agedOutputStubTemplate
				: supersededEditStubTemplate;
	const text = prompt.render(template, { tool: stub.toolName, path: stub.path }).trim();
	return {
		...message,
		content: [{ type: "text", text }],
		// 原 details 可能携带完整 diff;替换为最小降级标记。
		details: {
			superseded: true,
			...(stub.stubKind ? { stubKind: stub.stubKind } : {}),
			...(stub.path ? { path: stub.path } : {}),
		},
	} as AgentMessage;
}

export function materializeContextPlanMessages(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
	plan: BuiltContextPlan,
	volatileRecall?: AgentMessage,
): AgentMessage[] {
	// Net-benefit gate rejected the plan: revoke derived replacement only. The
	// volatile recall channel is independent and still ships.
	if (plan.withdrawn === true) return injectVolatileRecall(stripPriorDerivedPlanMessages(messages), volatileRecall);
	const validation = validateContextPlanCoverage({
		audit: plan.audit,
		materials: plan.materials,
		sourceIndex: plan.sourceIndex,
	});
	const coveredEntryIds = validation.valid ? new Set(validation.coveredEntryRefs) : new Set<string>();
	const { refs, messageKeys, customKeys } = coveredMessageRefs(branchEntries, coveredEntryIds);
	const stubs = plan.materials.filter(isToolStubMaterial);
	const stubTargets = toolStubTargets(branchEntries, stubs);
	const stripped = stripPriorDerivedPlanMessages(messages);
	const projected = stripped.filter(message => {
		const messageKey = sessionMessageKey(message);
		const customKey = customMessageKey(message);
		if (refs.has(message)) {
			consumeCount(messageKeys, messageKey);
			return false;
		}
		return !consumeCount(messageKeys, messageKey) && !consumeCount(customKeys, customKey);
	});
	// 省略(coverage)先行,替换(stub)后行:已被省略的消息不需要 stub。
	const substituted =
		stubs.length === 0
			? projected
			: projected.map(message => {
					const stub =
						stubTargets.byRef.get(message) ??
						(message.role === "toolResult" ? stubTargets.byKey.get(sessionMessageKey(message) ?? "") : undefined);
					return stub ? substituteToolStub(message, stub) : message;
				});
	// Image offload: projection-only content substitution. The current turn
	// (last user message onward) keeps its images verbatim; earlier image
	// blocks become a small re-reference marker. The journal is never touched.
	const offloaded = plan.offloadAgedImages === true ? offloadAgedImages(substituted) : substituted;
	// Stable-projection mode pins the plan at the payload head so the prefix
	// [plan, kept history] survives turns; the legacy mode floats it before the
	// last user message.
	const insertAt =
		plan.projectionMode === "pinned"
			? 0
			: Math.max(
					0,
					offloaded.findLastIndex(message => message.role === "user"),
				);
	const withPlan = [...offloaded.slice(0, insertAt), plan.message, ...offloaded.slice(insertAt)];
	return injectVolatileRecall(withPlan, volatileRecall);
}

function offloadAgedImages(messages: readonly AgentMessage[]): AgentMessage[] {
	const currentTurnStart = Math.max(
		0,
		messages.findLastIndex(message => message.role === "user"),
	);
	const marker = prompt.render(offloadedImageTemplate, {}).trim();
	return messages.map((message, index) => {
		if (index >= currentTurnStart || !messageCarriesImages(message)) return message;
		const content = (message as { content: unknown[] }).content.map(block =>
			(block as { type?: unknown }).type === "image" ? { type: "text", text: marker } : block,
		);
		return { ...message, content } as AgentMessage;
	});
}

export function estimateContextPlanProjectedTokens(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
	plan: BuiltContextPlan | null,
	volatileRecall?: AgentMessage,
	estimate: (message: AgentMessage) => number = estimateTokens,
): number {
	const projected = plan
		? materializeContextPlanMessages(messages, branchEntries, plan, volatileRecall)
		: injectVolatileRecall(stripPriorDerivedPlanMessages(messages), volatileRecall);
	return projected.reduce((sum, message) => sum + estimateProjectedMessage(message, estimate), 0);
}

function estimateProjectedMessage(message: AgentMessage, estimate: (message: AgentMessage) => number): number {
	if (
		message.role === "custom" &&
		(message.customType === CONTEXT_PLAN_MESSAGE_TYPE || message.customType === CONTEXT_RECALL_MESSAGE_TYPE)
	) {
		return estimate({ role: "user", content: message.content, attribution: "agent", timestamp: message.timestamp });
	}
	return estimate(message);
}

// ── End-to-end projection coverage audit ────────────────────────────────────

/** Journal custom_message types that are derived injections, not projectable sources. */
const DERIVED_INJECTION_CUSTOM_TYPES: Record<string, true> = {
	[CONTEXT_PACKET_MESSAGE_TYPE]: true,
	[CONTEXT_PLAN_MESSAGE_TYPE]: true,
	[CONTEXT_RECALL_MESSAGE_TYPE]: true,
};

/**
 * An entry is projectable when it is expected to participate in the provider
 * context: message entries and non-derived custom_message entries. Journal
 * metadata (compaction, labels, mode changes, audit custom entries) never
 * projects and must not be flagged as missing.
 */
type ProjectableSourceEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>;

function isProjectableSourceEntry(entry: SessionEntry): entry is ProjectableSourceEntry {
	if (entry.type === "message") return true;
	return entry.type === "custom_message" && !DERIVED_INJECTION_CUSTOM_TYPES[entry.customType];
}

export interface ProjectionCoverageAudit {
	/** The only failing category: projectable entries with no payload presence, coverage, or stub. */
	missingProjectableRefs: string[];
	coveredRefs: string[];
	stubbedRefs: string[];
	/** Scope entries that correctly never project (journal metadata, derived injections). */
	unmatchedNonProjectableRefs: string[];
	/** Content-key ambiguities where the key channel could not uniquely account for scope entries. */
	duplicateMatches: string[];
	/** Coverage authorizations that failed validation (refs, materials, duplicates). */
	invalidCoverage: string[];
}

/**
 * Reverse-audit the final projection: every projectable scope entry must be
 * present in the payload (original or stub-substituted) or legitimately
 * omitted via validated coverage. There is no third state — an entry in any
 * other state is an orphan and turns silent history loss into a loud signal.
 */
export function auditProjectionCoverage(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
	plan: BuiltContextPlan,
): ProjectionCoverageAudit {
	// A withdrawn plan revokes all derived replacement: everything must be present.
	const withdrawn = plan.withdrawn === true;
	const validation = validateContextPlanCoverage({
		audit: plan.audit,
		materials: plan.materials,
		sourceIndex: plan.sourceIndex,
	});
	const coveredEntryIds = withdrawn || !validation.valid ? new Set<string>() : new Set(validation.coveredEntryRefs);
	const invalidCoverage = validation.issues
		.filter(issue => issue.code !== "material_audit_missing" && issue.code !== "material_audit_mismatch")
		.map(issue => issue.entryRef ?? issue.materialId ?? issue.code);
	const stubEntryIds = withdrawn
		? new Set<string>()
		: new Set(plan.materials.filter(isToolStubMaterial).map(stub => stub.resultEntryId));
	const scopeEntryIds = new Set(plan.sourceIndex.entryIds);

	const payloadRefs = new Set<AgentMessage>(messages);
	const payloadKeys = new Map<string, number>();
	// Substitution channel: stubs and image offload clone the message with new
	// content, so the ref and content-key channels cannot see them. Role+timestamp
	// survives substitution and is millisecond-unique in practice; it is only
	// consulted for entries that are legitimate substitution targets, so a real
	// loss still fails loudly.
	const payloadSubstitutionKeys = new Map<string, number>();
	for (const message of messages) {
		const key = sessionMessageKey(message) ?? customMessageKey(message);
		if (key !== undefined) payloadKeys.set(key, (payloadKeys.get(key) ?? 0) + 1);
		const substitutionKey = messageSubstitutionKey(message);
		if (substitutionKey !== undefined) {
			payloadSubstitutionKeys.set(substitutionKey, (payloadSubstitutionKeys.get(substitutionKey) ?? 0) + 1);
		}
	}
	const consumedKeys = new Map<string, number>();
	const consumePayloadKey = (key: string | undefined): boolean => {
		if (key === undefined) return false;
		const remaining = (payloadKeys.get(key) ?? 0) - (consumedKeys.get(key) ?? 0);
		if (remaining <= 0) return false;
		consumedKeys.set(key, (consumedKeys.get(key) ?? 0) + 1);
		return true;
	};
	const consumedSubstitutionKeys = new Map<string, number>();
	const consumeSubstitutionKey = (key: string | undefined): boolean => {
		if (key === undefined) return false;
		const remaining = (payloadSubstitutionKeys.get(key) ?? 0) - (consumedSubstitutionKeys.get(key) ?? 0);
		if (remaining <= 0) return false;
		consumedSubstitutionKeys.set(key, (consumedSubstitutionKeys.get(key) ?? 0) + 1);
		return true;
	};

	const missingProjectableRefs: string[] = [];
	const coveredRefs: string[] = [];
	const stubbedRefs: string[] = [];
	const unmatchedNonProjectableRefs: string[] = [];
	const duplicateMatches = new Set<string>();

	for (const entry of branchEntries) {
		if (!scopeEntryIds.has(entry.id)) continue;
		if (!isProjectableSourceEntry(entry)) {
			unmatchedNonProjectableRefs.push(entry.id);
			continue;
		}
		if (coveredEntryIds.has(entry.id)) {
			coveredRefs.push(entry.id);
			continue;
		}
		const entryKey = entry.type === "message" ? sessionMessageEntryKey(entry) : customMessageEntryKey(entry);
		const entrySubstitutionKey = entry.type === "message" ? messageSubstitutionKey(entry.message) : undefined;
		// Substitution channel as a last-resort fallback for every message entry:
		// stubs, image offload, and pre-materialize provider transforms (image
		// normalization, obfuscation) all clone or rewrite content, defeating the
		// ref and content-key channels even though the entry is represented.
		const present =
			(entry.type === "message" && payloadRefs.has(entry.message)) ||
			consumePayloadKey(entryKey) ||
			(entry.type === "message" && consumeSubstitutionKey(entrySubstitutionKey));
		if (present) {
			if (stubEntryIds.has(entry.id)) stubbedRefs.push(entry.id);
			continue;
		}
		missingProjectableRefs.push(entry.id);
		// The payload holds this key but this entry could not claim one of its
		// occurrences — identical duplicates made the key channel ambiguous.
		if ((payloadKeys.get(entryKey) ?? 0) > 0) duplicateMatches.add(entryKey);
	}

	return {
		missingProjectableRefs,
		coveredRefs,
		stubbedRefs,
		unmatchedNonProjectableRefs,
		duplicateMatches: [...duplicateMatches],
		invalidCoverage,
	};
}
