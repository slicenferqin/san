import type { AgentMessage } from "@san/agent";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { EventBus } from "../../utils/event-bus";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "../rpc/rpc-subagents";
import type { RpcSubagentFrame, RpcSubagentSnapshot, RpcSubagentSubscriptionLevel } from "../rpc/rpc-types";
import type { SubagentSnapshot } from "./dto/integration";
import type { ToolCallId } from "./protocol/ids";
import { sanitizeRpcError } from "./redaction";

type SessionEventOutput = (
	type:
		| "subagent.started"
		| "subagent.progress"
		| "subagent.completed"
		| "subagent.failed"
		| "subagent.aborted"
		| "subagent.event",
	data: Record<string, unknown>,
	durability: "durable" | "transient",
) => void;

/** v1 registry 的安全 v2 投影与控制层。 */
export class RpcV2SubagentController {
	#registry: RpcSubagentRegistry | undefined;
	#output: SessionEventOutput | undefined;
	#tasks = new Set<Promise<void>>();

	bind(eventBus: EventBus | undefined, output: SessionEventOutput): void {
		this.#registry?.dispose();
		this.#registry = undefined;
		this.#output = output;
		if (!eventBus) return;
		this.#registry = new RpcSubagentRegistry(eventBus, frame => this.#handleFrame(frame));
		this.#registry.setSubscriptionLevel("progress");
	}

	configure(level: RpcSubagentSubscriptionLevel): void {
		this.#registry?.setSubscriptionLevel(level);
	}

	list(): SubagentSnapshot[] {
		return (this.#registry?.getSubagents() ?? []).map(projectSnapshot);
	}

	async messages(params: { subagentId: string; cursor?: string; limit?: number }): Promise<{
		messages: Record<string, unknown>[];
		nextCursor: string | null;
		reset: boolean;
	}> {
		const registry = this.#requireRegistry();
		const sessionFile = registry.resolveSessionFile({ subagentId: params.subagentId });
		const transcript = await readRpcSubagentTranscript(sessionFile, 0);
		const offset = decodeCursor(params.cursor);
		const limit = params.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Subagent message limit must be from 1 to 100");
		const page = transcript.messages.slice(offset, offset + limit).map(projectMessage);
		const nextOffset = offset + page.length;
		return {
			messages: page,
			nextCursor: nextOffset < transcript.messages.length ? encodeCursor(nextOffset) : null,
			reset: offset > transcript.messages.length,
		};
	}

	send(subagentId: string, message: string): { accepted: true; subagentId: string } {
		if (!message.trim()) throw new Error("Subagent message must be non-empty");
		assertControllableSubagent(subagentId);
		const task = (async () => {
			try {
				const session = await AgentLifecycleManager.global().ensureLive(subagentId);
				await session.prompt(message.trim(), { streamingBehavior: "steer" });
			} catch (error: unknown) {
				this.#output?.(
					"subagent.failed",
					{ subagentId, reason: sanitizeRpcError(error, { maxChars: 500 }), source: "rpc-v2.subagent.send" },
					"durable",
				);
			}
		})();
		this.#track(task);
		return { accepted: true, subagentId };
	}

	async abort(subagentId: string, reason?: string): Promise<{ accepted: true; subagentId: string }> {
		const ref = assertControllableSubagent(subagentId);
		if (ref.session) await ref.session.abort({ reason: reason?.trim() || USER_INTERRUPT_LABEL });
		this.#output?.("subagent.aborted", { subagentId, reason: reason?.trim() || "client_abort" }, "durable");
		return { accepted: true, subagentId };
	}

	async close(): Promise<void> {
		this.#registry?.dispose();
		this.#registry = undefined;
		await Promise.all([...this.#tasks]);
		this.#output = undefined;
	}

	#requireRegistry(): RpcSubagentRegistry {
		if (!this.#registry) throw new Error("Subagent EventBus is unavailable for the active Session");
		return this.#registry;
	}

	#handleFrame(frame: RpcSubagentFrame): void {
		if (!this.#output) return;
		if (frame.type === "subagent_lifecycle") {
			const type =
				frame.payload.status === "started"
					? "subagent.started"
					: frame.payload.status === "completed"
						? "subagent.completed"
						: frame.payload.status === "failed"
							? "subagent.failed"
							: "subagent.aborted";
			this.#output(
				type,
				{
					subagentId: frame.payload.id,
					index: frame.payload.index,
					agent: frame.payload.agent,
					agentSource: frame.payload.agentSource,
					status: frame.payload.status === "started" ? "running" : frame.payload.status,
					...(frame.payload.description ? { description: frame.payload.description } : {}),
					...(frame.payload.parentToolCallId ? { parentToolCallId: frame.payload.parentToolCallId } : {}),
				},
				"durable",
			);
			return;
		}
		if (frame.type === "subagent_progress") {
			const progress = frame.payload.progress;
			this.#output(
				"subagent.progress",
				{
					subagentId: progress.id,
					status: progress.status,
					progress: {
						...(progress.currentTool ? { currentTool: progress.currentTool } : {}),
						toolCount: progress.toolCount,
						tokens: progress.tokens,
						cost: progress.cost,
						durationMs: progress.durationMs,
						...(progress.retryState
							? {
									retryState: {
										attempt: progress.retryState.attempt,
										delayMs: progress.retryState.delayMs,
										error: sanitizeRpcError(progress.retryState.errorMessage, { maxChars: 500 }),
									},
								}
							: {}),
					},
				},
				"transient",
			);
			return;
		}
		this.#output(
			"subagent.event",
			{
				subagentId: frame.payload.id,
				eventType: frame.payload.event.type,
			},
			"transient",
		);
	}

	#track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task
			.finally(() => this.#tasks.delete(task))
			.catch(error => {
				this.#output?.(
					"subagent.failed",
					{ reason: sanitizeRpcError(error, { maxChars: 500 }), source: "rpc-v2.subagent.task" },
					"durable",
				);
			});
	}
}

function projectSnapshot(snapshot: RpcSubagentSnapshot): SubagentSnapshot {
	return {
		subagentId: snapshot.id,
		index: snapshot.index,
		agent: snapshot.agent,
		agentSource: snapshot.agentSource,
		...(snapshot.description ? { description: snapshot.description } : {}),
		status: snapshot.status,
		...(snapshot.task ? { task: snapshot.task } : {}),
		...(snapshot.assignment ? { assignment: snapshot.assignment } : {}),
		...(snapshot.parentToolCallId ? { parentToolCallId: snapshot.parentToolCallId as ToolCallId } : {}),
		lastUpdate: new Date(snapshot.lastUpdate).toISOString(),
		...(snapshot.progress
			? {
					progress: {
						...(snapshot.progress.currentTool ? { currentTool: snapshot.progress.currentTool } : {}),
						toolCount: snapshot.progress.toolCount,
						tokens: snapshot.progress.tokens,
						cost: snapshot.progress.cost,
						durationMs: snapshot.progress.durationMs,
					},
				}
			: {}),
	};
}

function projectMessage(message: AgentMessage): Record<string, unknown> {
	const role = "role" in message && typeof message.role === "string" ? message.role : "unknown";
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
	return {
		role,
		timestamp: new Date(timestamp).toISOString(),
		content: extractVisibleText(message),
	};
}

function extractVisibleText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const text: string[] = [];
	for (const part of message.content) {
		if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") text.push(part.text);
	}
	return text.join("\n");
}

function assertControllableSubagent(subagentId: string) {
	const ref = AgentRegistry.global().get(subagentId);
	if (ref?.kind !== "sub" || ref.status === "aborted") throw new Error(`Subagent is not controllable: ${subagentId}`);
	return ref;
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			!isRecord(value) ||
			typeof value.offset !== "number" ||
			!Number.isSafeInteger(value.offset) ||
			value.offset < 0
		) {
			throw new Error("invalid offset");
		}
		return value.offset;
	} catch (error: unknown) {
		throw new Error(`Invalid opaque subagent cursor: ${String(error)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
