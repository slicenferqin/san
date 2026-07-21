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
import type { SessionEvent } from "./dto/events";
import type { ActiveStreamSnapshot } from "./dto/session";
import type { EventSequencer } from "./event-sequencer";
import type { MessageId, RunId, TurnId } from "./protocol/ids";
import { newMessageId, newTurnId } from "./protocol/ids";

/**
 * Tracks the current run/turn/message context so the adapter can tag events
 * with stable IDs. The RPC v2 mode updates runId when a new run starts.
 */
export class AdapterContext {
	currentRunId: RunId | undefined;
	currentTurnId: TurnId | undefined;
	currentOperationId: string | undefined;
	currentRunTerminalStatus: "completed" | "failed" | "aborted" | "interrupted" | undefined;
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
): SessionEvent | undefined {
	const runId = ctx.currentRunId;
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
			return sequencer.emit(
				eventType,
				{ runId, status, finishedAt: new Date().toISOString() },
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
			const messageId = ctx.allocateMessage(role);
			return sequencer.emit("message.started", { messageId, role }, { durability: "durable", runId, turnId });
		}

		case "message_update": {
			const messageId = ctx.currentMessageId;
			if (!messageId) return undefined;
			// Extract text delta from the assistant message event
			const delta =
				"assistantMessageEvent" in event && event.assistantMessageEvent
					? extractTextDelta(event.assistantMessageEvent)
					: "";
			if (!delta) return undefined;
			ctx.appendMessageDelta(delta);
			return sequencer.emit("message.delta", { messageId, delta }, { durability: "transient", runId, turnId });
		}

		case "message_end": {
			const messageId = ctx.currentMessageId;
			if (!messageId) return undefined;
			const role = "role" in event.message ? event.message.role : "assistant";
			const visibleText = truncateUtf8(extractVisibleText(event.message), MAX_ACTIVE_TEXT_BYTES);
			const completed = sequencer.emit(
				"message.completed",
				{
					messageId,
					role,
					content: visibleText.value,
					contentLength: estimateContentLength(event.message),
					truncated: visibleText.truncated,
				},
				{ durability: "durable", runId, turnId },
			);
			ctx.clearMessage();
			return completed;
		}

		// =================================================================
		// Tool lifecycle
		// =================================================================
		case "tool_execution_start":
			ctx.startTool(event.toolCallId, event.toolName);
			return sequencer.emit(
				"tool.started",
				{ toolCallId: event.toolCallId, toolName: event.toolName, intent: event.intent },
				{ durability: "durable", runId, turnId },
			);

		case "tool_execution_update":
			return sequencer.emit(
				"tool.progress",
				{ toolCallId: event.toolCallId, toolName: event.toolName },
				{ durability: "transient", runId, turnId },
			);

		case "tool_execution_end": {
			ctx.finishTool(event.toolCallId);
			return sequencer.emit(
				"tool.completed",
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					outcome: event.isError ? ("error" as const) : ("success" as const),
					summary: event.isError ? `${event.toolName} failed` : `${event.toolName} completed`,
				},
				{ durability: "durable", runId, turnId },
			);
		}

		// =================================================================
		// Context maintenance (compaction)
		// =================================================================
		case "auto_compaction_start":
			return sequencer.emit(
				"context.maintenance.started",
				{ kind: event.action, reason: event.reason },
				{ durability: "durable", runId },
			);

		case "auto_compaction_end":
			return sequencer.emit(
				"context.maintenance.completed",
				{
					kind: event.action,
					aborted: event.aborted,
					skipped: event.skipped,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				{ durability: "durable", runId },
			);

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
					errorMessage: event.errorMessage,
				},
				{ durability: "durable", runId },
			);

		case "auto_retry_end":
			return sequencer.emit(
				"retry.completed",
				{ success: event.success, attempt: event.attempt, finalError: event.finalError },
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
		case "notice":
			return sequencer.emit(
				"session.notice",
				{ level: event.level, code: "notice", message: event.message, source: event.source },
				{ durability: event.level === "info" ? "transient" : "durable", runId },
			);

		// =================================================================
		// 未知事件必须进入可诊断的协议事件，不能静默丢弃。
		// =================================================================
		default:
			return sequencer.emit(
				"session.notice",
				{
					level: "warning",
					code: "UNKNOWN_INTERNAL_EVENT",
					message: `Unknown AgentSessionEvent: ${event.type}`,
					source: "rpc-v2.event-adapter",
					details: { eventType: event.type },
				},
				{ durability: "durable", runId },
			);
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
