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
	#currentMessageId: MessageId | undefined;

	/** Called on turn_start to allocate a fresh turnId. */
	allocateTurn(): TurnId {
		this.currentTurnId = newTurnId();
		return this.currentTurnId;
	}

	/** Called on message_start to allocate a fresh messageId. */
	allocateMessage(): MessageId {
		this.#currentMessageId = newMessageId();
		return this.#currentMessageId;
	}

	get currentMessageId(): MessageId | undefined {
		return this.#currentMessageId;
	}
}

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
			return sequencer.emit("run.started", { runId, turnId }, { durability: "durable", runId });

		case "agent_end":
			return sequencer.emit(
				"run.completed",
				{ runId, status: "completed" as const, finishedAt: new Date().toISOString() },
				{ durability: "durable", runId },
			);

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
			const messageId = ctx.allocateMessage();
			const role = "role" in event.message ? event.message.role : "assistant";
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
			return sequencer.emit("message.delta", { messageId, delta }, { durability: "transient", runId, turnId });
		}

		case "message_end": {
			const messageId = ctx.currentMessageId;
			if (!messageId) return undefined;
			const role = "role" in event.message ? event.message.role : "assistant";
			return sequencer.emit(
				"message.completed",
				{ messageId, role, contentLength: estimateContentLength(event.message) },
				{ durability: "durable", runId, turnId },
			);
		}

		// =================================================================
		// Tool lifecycle
		// =================================================================
		case "tool_execution_start":
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

		case "tool_execution_end":
			return sequencer.emit(
				"tool.completed",
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					outcome: event.isError ? ("error" as const) : ("success" as const),
				},
				{ durability: "durable", runId, turnId },
			);

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
		// Unmapped events — silently skip for now
		// =================================================================
		default:
			return undefined;
	}
}

// ============================================================================
// Helpers
// ============================================================================

function extractTextDelta(assistantMessageEvent: unknown): string {
	if (typeof assistantMessageEvent !== "object" || assistantMessageEvent === null) return "";
	const evt = assistantMessageEvent as Record<string, unknown>;
	if (evt.type === "text" && typeof evt.text === "string") return evt.text;
	return "";
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
