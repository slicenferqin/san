/** San RPC v2 Host Tool 与 Host URI 双向桥接。 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "../theme/theme";
import type { RpcId } from "./protocol/envelope";

export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
}

interface PendingHostRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
}

type OutputFn = (frame: object) => void;
type ContextProvider = () => { sessionId?: string; runId?: string };

class RpcV2HostToolAdapter<TParams extends TSchema = TSchema> implements AgentTool<TParams, unknown, Theme> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	readonly #bridge: RpcV2HostToolBridge;
	readonly #definition: HostToolDefinition;

	constructor(definition: HostToolDefinition, bridge: RpcV2HostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
	}

	async execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		const result = await this.#bridge.invoke(this.#definition.name, params as Record<string, unknown>, {
			toolCallId,
			signal,
			onUpdate,
		});
		if (!isAgentToolResult(result))
			throw new Error(`Host tool "${this.#definition.name}" returned an invalid result`);
		if (result.isError) {
			const message = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text)
				.join("\n")
				.trim();
			throw new Error(message || `Host tool "${this.#definition.name}" failed`);
		}
		return result;
	}
}

export class RpcV2HostToolBridge {
	readonly #output: OutputFn;
	readonly #contextProvider: ContextProvider;
	#pending = new Map<string, PendingHostRequest>();
	#tools: HostToolDefinition[] = [];
	#agentTools: AgentTool[] = [];
	#uriSchemes: HostUriSchemeDefinition[] = [];
	#closedError: Error | undefined;

	constructor(output: OutputFn, contextProvider: ContextProvider = () => ({})) {
		this.#output = output;
		this.#contextProvider = contextProvider;
	}

	setTools(tools: HostToolDefinition[]): AgentTool[] {
		this.#tools = tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) }));
		this.#agentTools = this.#tools.map(tool => new RpcV2HostToolAdapter(tool, this));
		return [...this.#agentTools];
	}

	setUriSchemes(schemes: HostUriSchemeDefinition[]): string[] {
		this.#uriSchemes = schemes.map(scheme => ({ ...scheme }));
		return schemes.map(scheme => scheme.scheme);
	}

	get registeredTools(): string[] {
		return this.#tools.map(tool => tool.name);
	}

	get agentTools(): AgentTool[] {
		return [...this.#agentTools];
	}

	get registeredSchemes(): string[] {
		return this.#uriSchemes.map(scheme => scheme.scheme);
	}

	supportsUriScheme(scheme: string, access: "read" | "write" = "read"): boolean {
		const registered = this.#uriSchemes.find(item => item.scheme.toLowerCase() === scheme.toLowerCase());
		return Boolean(registered && (access === "read" || registered.writable === true));
	}

	invoke(
		toolName: string,
		args: Record<string, unknown>,
		options?: {
			deadlineMs?: number;
			toolCallId?: string;
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback<unknown>;
		},
	): Promise<unknown> {
		const context = this.#contextProvider();
		if (!context.sessionId || !context.runId || !options?.toolCallId) {
			return Promise.reject(new Error(`Host tool "${toolName}" requires an active Session, Run, and ToolCall`));
		}
		return this.#request(
			"host.tool.invoke",
			{
				sessionId: context.sessionId,
				runId: context.runId,
				toolCallId: options.toolCallId,
				toolName,
				arguments: args,
				deadlineMs: options.deadlineMs ?? 30_000,
			},
			"host_req",
			options.deadlineMs ?? 30_000,
			options.signal,
			options.onUpdate,
		);
	}

	invokeUri(operation: "read" | "write", url: string, content?: string): Promise<unknown> {
		const context = this.#contextProvider();
		return this.#request(
			"host.uri.invoke",
			{
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
				...(context.runId ? { runId: context.runId } : {}),
				operation,
				url,
				...(content !== undefined ? { content } : {}),
			},
			"host_uri",
			30_000,
		);
	}

	handleResult(id: string, result: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		pending.resolve(result);
		return true;
	}

	handleError(id: string, error: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		pending.reject(new Error(readErrorMessage(error)));
		return true;
	}

	handleProgress(id: string, message: string): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		pending.onUpdate?.({ content: [{ type: "text", text: message }] });
		return true;
	}

	cancel(targetRequestId: string, reason: string): void {
		this.#output({ jsonrpc: "2.0", method: "host.tool.cancel", params: { targetId: targetRequestId, reason } });
	}

	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const item of pending) item.reject(this.#closedError);
	}

	#request(
		method: "host.tool.invoke" | "host.uri.invoke",
		params: Record<string, unknown>,
		prefix: string,
		deadlineMs: number,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<unknown> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (signal?.aborted) return Promise.reject(new Error(`${method} was aborted before dispatch`));
		const requestId = `${prefix}_${Snowflake.next()}` as RpcId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(requestId);
		};
		const settleReject = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			this.cancel(requestId, "agent_abort");
			settleReject(new Error(`${method} was aborted`));
		};
		const pending: PendingHostRequest = {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: settleReject,
			...(onUpdate ? { onUpdate } : {}),
		};
		this.#pending.set(requestId, pending);
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => settleReject(new Error(`${method} timed out after ${deadlineMs}ms`)), deadlineMs);
		this.#output({ jsonrpc: "2.0", id: requestId, method, params });
		return promise;
	}
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!isRecord(value) || !Array.isArray(value.content)) return false;
	return value.content.every(item => {
		if (!isRecord(item) || typeof item.type !== "string") return false;
		if (item.type === "text") return typeof item.text === "string";
		return item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string";
	});
}

function readErrorMessage(error: unknown): string {
	if (isRecord(error) && typeof error.message === "string" && error.message.trim()) return error.message;
	return "Host request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
