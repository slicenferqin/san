/**
 * San RPC v2 Event Adapter.
 *
 * Converts internal AgentSessionEvent objects into v2 SessionEvent envelopes.
 * This is the bridge between the existing San event system and the v2 protocol.
 *
 * Internal events do not carry stable IDs for messages/turns, so the adapter
 * generates and tracks them as events flow through.
 */
import type { AgentSessionEvent } from "../../session/agent-session";
import type {
	ContextMaintenanceCompletedData,
	MessageCompletedData,
	ModelRouteChangedData,
	ModelRouteResolvedData,
	SessionEvent,
	SessionNoticeData,
	ToolCompletedData,
	ToolStartedData,
} from "./dto/events";
import type { ActiveStreamSnapshot } from "./dto/session";
import type { EventSequencer } from "./event-sequencer";
import type { MessageId, RunId, ToolCallId, TurnId } from "./protocol/ids";
import { newMessageId, newRunId, newTurnId } from "./protocol/ids";
import { sanitizeRpcText } from "./redaction";

/**
 * Tracks the current run/turn/message context so the adapter can tag events
 * with stable IDs. The RPC v2 mode updates runId when a new run starts.
 */
export class AdapterContext {
	currentRunId: RunId | undefined;
	currentTurnId: TurnId | undefined;
	currentOperationId: string | undefined;
	currentRunTerminalStatus: "completed" | "failed" | "aborted" | "interrupted" | undefined;
	/** Error detail for the terminal `run.failed` event; set alongside currentRunTerminalStatus. */
	currentRunErrorMessage: string | undefined;
	/** Mirrors StreamPolicy.thinkingDeltas; kept in sync by SessionManager.configureStream. */
	emitThinkingDeltas = false;
	#currentMessageId: MessageId | undefined;
	#activeMessage: Extract<ActiveStreamSnapshot, { kind: "message" }> | undefined;
	#activeTools = new Map<string, Extract<ActiveStreamSnapshot, { kind: "tool" }>>();

	/** Called on turn_start to allocate a fresh turnId. */
	allocateTurn(): TurnId {
		this.currentTurnId = newTurnId();
		return this.currentTurnId;
	}

	/** Called on message_start to allocate a fresh messageId. */
	allocateMessage(role: string): MessageId {
		this.#currentMessageId = newMessageId();
		this.#activeMessage = {
			kind: "message",
			messageId: this.#currentMessageId,
			role,
			content: "",
			truncated: false,
		};
		return this.#currentMessageId;
	}

	get currentMessageId(): MessageId | undefined {
		return this.#currentMessageId;
	}

	clearMessage(): void {
		this.#currentMessageId = undefined;
		this.#activeMessage = undefined;
	}

	appendMessageDelta(delta: string): void {
		if (!this.#activeMessage || !delta) return;
		const combined = `${this.#activeMessage.content}${delta}`;
		const bounded = truncateUtf8(combined, MAX_ACTIVE_TEXT_BYTES);
		this.#activeMessage = { ...this.#activeMessage, content: bounded.value, truncated: bounded.truncated };
	}

	startTool(toolCallId: string, toolName: string): void {
		this.#activeTools.set(toolCallId, { kind: "tool", toolCallId, toolName, status: "running" });
	}

	finishTool(toolCallId: string): void {
		this.#activeTools.delete(toolCallId);
	}

	get activeStreams(): ActiveStreamSnapshot[] {
		return [
			...(this.#activeMessage ? [{ ...this.#activeMessage }] : []),
			...[...this.#activeTools.values()].map(tool => ({ ...tool })),
		];
	}
}

const MAX_ACTIVE_TEXT_BYTES = 131_072;

/**
 * Map an internal AgentSessionEvent to a v2 SessionEvent envelope.
 * Returns undefined for events that have no v2 representation yet
 * (they are silently dropped from the v2 stream but remain in the journal).
 */
export function adaptSessionEvent(
	event: AgentSessionEvent,
	sequencer: EventSequencer,
	ctx: AdapterContext,
	options?: { durableOnly?: boolean },
): SessionEvent | undefined {
	const durableOnly = options?.durableOnly === true;
	// 判别值先落到 string：switch 穷尽 union 后 default 分支里 event 收窄为 never，
	// 诊断通知需要不受收窄影响的原始 type。
	const eventType: string = event.type;
	let runId = ctx.currentRunId;
	if (event.type === "agent_start" && !runId) {
		runId = newRunId();
		ctx.currentRunId = runId;
	}
	const turnId = ctx.currentTurnId;

	switch (event.type) {
		// =================================================================
		// Agent/Run lifecycle
		// =================================================================
		case "agent_start":
			return sequencer.emit(
				"run.started",
				{ runId, ...(turnId ? { turnId } : {}) },
				{ durability: "durable", runId },
			);

		case "agent_end": {
			const status = ctx.currentRunTerminalStatus ?? "completed";
			const eventType =
				status === "completed"
					? "run.completed"
					: status === "failed"
						? "run.failed"
						: status === "aborted"
							? "run.aborted"
							: "run.interrupted";
			const errorMessage = status === "failed" ? ctx.currentRunErrorMessage : undefined;
			return sequencer.emit(
				eventType,
				{
					runId,
					status,
					finishedAt: new Date().toISOString(),
					...(errorMessage ? { message: sanitizeRpcText(errorMessage) } : {}),
				},
				{ durability: "durable", runId },
			);
		}

		// =================================================================
		// Turn lifecycle
		// =================================================================
		case "turn_start": {
			const newTurn = ctx.allocateTurn();
			return sequencer.emit("turn.started", { turnId: newTurn }, { durability: "durable", runId, turnId: newTurn });
		}

		case "turn_end":
			return sequencer.emit("turn.completed", { turnId }, { durability: "durable", runId, turnId });

		// =================================================================
		// Message lifecycle
		// =================================================================
		case "message_start": {
			const role = "role" in event.message ? event.message.role : "assistant";
			// toolResult messages are already covered by tool.started/tool.completed —
			// emitting them as messages double-renders raw tool output in the
			// transcript. Hidden custom messages (display:false — xdev mount notices,
			// plan-mode steers, …) are model-facing context, never UI content.
			// Skipping allocation here makes any later message_update/message_end
			// for the same message a no-op (no currentMessageId).
			if (role === "toolResult") return undefined;
			if (role === "custom" && "display" in event.message && event.message.display === false) return undefined;
			const messageId = ctx.allocateMessage(role);
			return sequencer.emit("message.started", { messageId, role }, { durability: "durable", runId, turnId });
		}

		case "message_update": {
			const messageId = ctx.currentMessageId;
			if (!messageId) return undefined;
			const source =
				"assistantMessageEvent" in event && event.assistantMessageEvent ? event.assistantMessageEvent : undefined;
			if (!source) return undefined;
			const delta = extractTextDelta(source);
			if (delta) {
				ctx.appendMessageDelta(delta);
				return durableOnly
					? undefined
					: sequencer.emit("message.delta", { messageId, delta }, { durability: "transient", runId, turnId });
			}
			// Thinking deltas are opt-in (stream.configure) and never enter the
			// visible message buffer — they stream on a separate channel only.
			if (ctx.emitThinkingDeltas) {
				const thinking = extractThinkingDelta(source);
				if (thinking) {
					return durableOnly
						? undefined
						: sequencer.emit(
								"message.delta",
								{ messageId, delta: thinking, channel: "thinking" },
								{ durability: "transient", runId, turnId },
							);
				}
			}
			return undefined;
		}

		case "message_end": {
			const messageId = ctx.currentMessageId;
			if (!messageId) return undefined;
			const role = "role" in event.message ? event.message.role : "assistant";
			if (role === "toolResult") return undefined;
			if (role === "custom" && "display" in event.message && event.message.display === false) return undefined;
			const visibleText = visibleMessageText(event.message);
			const data = {
				messageId,
				role,
				content: visibleText.value,
				contentLength: estimateContentLength(event.message),
				truncated: visibleText.truncated,
			} satisfies MessageCompletedData;
			const completed = sequencer.emit("message.completed", data, { durability: "durable", runId, turnId });
			ctx.clearMessage();
			return completed;
		}

		// =================================================================
		// Tool lifecycle
		// =================================================================
		case "tool_execution_start": {
			ctx.startTool(event.toolCallId, event.toolName);
			const data = {
				toolCallId: event.toolCallId as ToolCallId,
				toolName: event.toolName,
				intent: sanitizeOptionalText(event.intent),
			} satisfies ToolStartedData;
			return sequencer.emit("tool.started", data, { durability: "durable", runId, turnId });
		}

		case "tool_execution_update":
			return durableOnly
				? undefined
				: sequencer.emit(
						"tool.progress",
						{ toolCallId: event.toolCallId, toolName: event.toolName },
						{ durability: "transient", runId, turnId },
					);

		case "tool_execution_end": {
			ctx.finishTool(event.toolCallId);
			const data = {
				toolCallId: event.toolCallId as ToolCallId,
				toolName: event.toolName,
				outcome: event.isError ? ("error" as const) : ("success" as const),
				summary: event.isError ? `${event.toolName} failed` : `${event.toolName} completed`,
				...extractToolResultDetail(event.result),
			} satisfies ToolCompletedData;
			return sequencer.emit("tool.completed", data, { durability: "durable", runId, turnId });
		}

		// =================================================================
		// Context maintenance (compaction)
		// =================================================================
		case "auto_compaction_start":
			return sequencer.emit(
				"context.maintenance.started",
				{
					maintenanceId: event.maintenanceId,
					kind: event.action,
					reason: event.reason,
					primaryTrigger: event.trigger,
					matchedTriggers: event.matchedTriggers,
				},
				{ durability: "durable", runId },
			);

		case "auto_compaction_end": {
			const data = {
				maintenanceId: event.maintenanceId,
				kind: event.action,
				aborted: event.aborted,
				skipped: event.skipped,
				willRetry: event.willRetry,
				errorMessage: sanitizeOptionalText(event.errorMessage),
				failureStage: event.failureStage,
				failureReason: sanitizeOptionalText(event.failureReason),
			} satisfies ContextMaintenanceCompletedData;
			return sequencer.emit("context.maintenance.completed", data, { durability: "durable", runId });
		}

		// =================================================================
		// Retry
		// =================================================================
		case "auto_retry_start":
			return sequencer.emit(
				"retry.started",
				{
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: sanitizeOptionalText(event.errorMessage),
				},
				{ durability: "durable", runId },
			);

		case "auto_retry_end":
			return sequencer.emit(
				"retry.completed",
				{ success: event.success, attempt: event.attempt, finalError: sanitizeOptionalText(event.finalError) },
				{ durability: "durable", runId },
			);

		case "retry_fallback_applied":
			return sequencer.emit(
				"retry.fallback.applied",
				{ from: event.from, to: event.to, role: event.role },
				{ durability: "durable", runId },
			);

		case "retry_fallback_succeeded":
			return sequencer.emit(
				"retry.fallback.succeeded",
				{ model: event.model, role: event.role },
				{ durability: "durable", runId },
			);

		case "model_route_resolved": {
			const data = {
				logicalModel: sanitizeRpcText(event.logicalModel),
				routeId: sanitizeRpcText(event.routeId),
				model: sanitizeRpcText(event.model),
				reason: event.reason,
			} satisfies ModelRouteResolvedData;
			return sequencer.emit("model.route.resolved", data, { durability: "durable", runId });
		}

		case "model_route_changed": {
			const data = {
				logicalModel: sanitizeRpcText(event.logicalModel),
				fromRoute: sanitizeRpcText(event.fromRoute),
				toRoute: sanitizeRpcText(event.toRoute),
				trigger: event.trigger,
				...(event.cooldownUntil !== undefined && { cooldownUntil: event.cooldownUntil }),
			} satisfies ModelRouteChangedData;
			return sequencer.emit("model.route.changed", data, { durability: "durable", runId });
		}

		// =================================================================
		// Todo / Goal
		// =================================================================
		case "todo_reminder":
			return sequencer.emit(
				"todo.reminder",
				{ todos: event.todos, attempt: event.attempt, maxAttempts: event.maxAttempts },
				{ durability: "durable", runId },
			);

		case "goal_updated":
			return sequencer.emit(
				"goal.changed",
				{ goal: event.goal, state: event.state },
				{ durability: "durable", runId },
			);

		// =================================================================
		// Notice
		// =================================================================
		case "notice": {
			const data = {
				level: event.level,
				code: "notice",
				message: sanitizeRpcText(event.message),
				source: event.source,
			} satisfies SessionNoticeData;
			if (durableOnly && event.level === "info") return undefined;
			return sequencer.emit("session.notice", data, {
				durability: event.level === "info" ? "transient" : "durable",
				runId,
			});
		}

		// =================================================================
		// TUI-only 事件：RPC 客户端（Desktop）没有对应 UI 语义，显式忽略。
		// 真正未知的事件仍走 default 的 UNKNOWN_INTERNAL_EVENT 诊断通知。
		// =================================================================
		case "ttsr_triggered":
		case "todo_auto_clear":
		case "irc_message":
		case "thinking_level_changed":
			return undefined;

		// =================================================================
		// 未知事件必须进入可诊断的协议事件，不能静默丢弃。
		// =================================================================
		default: {
			// switch 已穷尽当前 union，event 在 default 收窄为 never；用收窄前捕获的 eventType。
			const unknownType = eventType;
			return sequencer.emit(
				"session.notice",
				{
					level: "warning",
					code: "UNKNOWN_INTERNAL_EVENT",
					message: `Unknown AgentSessionEvent: ${unknownType}`,
					source: "rpc-v2.event-adapter",
					details: { eventType: unknownType },
				},
				{ durability: "durable", runId },
			);
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function extractTextDelta(assistantMessageEvent: unknown): string {
	if (typeof assistantMessageEvent !== "object" || assistantMessageEvent === null) return "";
	const evt = assistantMessageEvent as Record<string, unknown>;
	if (evt.type === "text_delta" && typeof evt.delta === "string") return evt.delta;
	return "";
}

function extractThinkingDelta(assistantMessageEvent: unknown): string {
	if (typeof assistantMessageEvent !== "object" || assistantMessageEvent === null) return "";
	const evt = assistantMessageEvent as Record<string, unknown>;
	if (evt.type === "thinking_delta" && typeof evt.delta === "string") return evt.delta;
	return "";
}

const MAX_TOOL_PREVIEW_BYTES = 4096;

/**
 * Bounded projection of a tool result's renderer details onto `tool.completed`,
 * so clients can show rich edit/write cards without a follow-up fetch. Lenient
 * by design: unknown/malformed details contribute nothing.
 */
function extractToolResultDetail(result: unknown): { path?: string; preview?: string; previewTruncated?: boolean } {
	if (typeof result !== "object" || result === null || !("details" in result)) return {};
	const details = result.details;
	if (typeof details !== "object" || details === null) return {};
	const pathValue = "path" in details ? details.path : undefined;
	const resolvedPathValue = "resolvedPath" in details ? details.resolvedPath : undefined;
	const rawPath =
		typeof pathValue === "string" && pathValue
			? pathValue
			: typeof resolvedPathValue === "string" && resolvedPathValue
				? resolvedPathValue
				: undefined;
	const path = rawPath ? sanitizeRpcText(rawPath, { maxChars: 2_000 }) : undefined;
	const diffValue = "diff" in details ? details.diff : undefined;
	const rawPreview =
		typeof diffValue === "string" && diffValue ? truncateUtf8(diffValue, MAX_TOOL_PREVIEW_BYTES) : undefined;
	const preview = rawPreview
		? sanitizeRpcText(rawPreview.value, { maxChars: MAX_TOOL_PREVIEW_BYTES, trim: false })
		: undefined;
	const previewTruncated = rawPreview?.truncated ?? false;
	return {
		...(path ? { path } : {}),
		...(preview
			? {
					preview,
					...(previewTruncated ? { previewTruncated: true } : {}),
				}
			: {}),
	};
}

function sanitizeOptionalText(value: string | undefined): string | undefined {
	return typeof value === "string" ? sanitizeRpcText(value) : undefined;
}

/**
 * v2 对外的可见正文投影：只取 text 部分，并套用与 `message.completed`
 * 相同的字节预算。历史消息读取必须复用它，否则同一条消息在事件流和
 * transcript 两条路径上的正文会不一致，客户端无法去重。
 */
export function visibleMessageText(message: unknown): { value: string; truncated: boolean } {
	return truncateUtf8(extractVisibleText(message), MAX_ACTIVE_TEXT_BYTES);
}

function extractVisibleText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
		)
		.map(part => part.text)
		.join("");
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return { value: value.slice(0, low), truncated: true };
}

function estimateContentLength(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content.length;
	if (Array.isArray(msg.content)) {
		let length = 0;
		for (const part of msg.content) {
			if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
				length += part.text.length;
			}
		}
		return length;
	}
	return 0;
}
