import type { AgentMessage } from "@san/agent";
import { estimateTokens } from "@san/agent/compaction";
import { prompt } from "@san/utils";
import contextPlanTemplate from "../prompts/context-steady/context-plan.md" with { type: "text" };
import emergencyStubTemplate from "../prompts/context-steady/emergency-stub.md" with { type: "text" };
import supersededEditStubTemplate from "../prompts/context-steady/superseded-edit-stub.md" with { type: "text" };
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { validateContextPlanCoverage } from "./coverage";
import { projectDigestTier } from "./decay";
import type { BuiltContextPlan, ContextPlanMaterial, ContextPlanToolStubMaterial } from "./plan-types";
import { CONTEXT_PLAN_MESSAGE_TYPE } from "./plan-types";
import { CONTEXT_PACKET_MESSAGE_TYPE } from "./types";

const DIGEST_PRUNABLE_CUSTOM_MESSAGE_TYPES: Record<string, true> = { "image-attachment-description": true };

function contentKey(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function timestampKey(timestamp: unknown): string {
	if (typeof timestamp === "number") return new Date(timestamp).toISOString();
	if (typeof timestamp === "string") return new Date(timestamp).toISOString();
	return "";
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
	for (const material of materials) {
		if ("checkpoint" in material) {
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
	return { checkpoints, digests, recalls };
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
			!(message.role === "custom" && message.customType === CONTEXT_PLAN_MESSAGE_TYPE),
	);
}

function isToolStubMaterial(material: ContextPlanMaterial): material is ContextPlanToolStubMaterial {
	return "toolCallId" in material && "resultEntryId" in material;
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
	const template = stub.stubKind === "emergency" ? emergencyStubTemplate : supersededEditStubTemplate;
	const text = prompt.render(template, { path: stub.path }).trim();
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
): AgentMessage[] {
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
	const insertAt = Math.max(
		0,
		substituted.findLastIndex(message => message.role === "user"),
	);
	return [...substituted.slice(0, insertAt), plan.message, ...substituted.slice(insertAt)];
}

export function estimateContextPlanProjectedTokens(
	messages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
	plan: BuiltContextPlan | null,
	estimate: (message: AgentMessage) => number = estimateTokens,
): number {
	const projected = plan
		? materializeContextPlanMessages(messages, branchEntries, plan)
		: stripPriorDerivedPlanMessages(messages);
	return projected.reduce((sum, message) => sum + estimateProjectedMessage(message, estimate), 0);
}

function estimateProjectedMessage(message: AgentMessage, estimate: (message: AgentMessage) => number): number {
	if (message.role === "custom" && message.customType === CONTEXT_PLAN_MESSAGE_TYPE) {
		return estimate({ role: "user", content: message.content, attribution: "agent", timestamp: message.timestamp });
	}
	return estimate(message);
}
