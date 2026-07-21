/**
 * San RPC v2 Host Tool Bridge.
 *
 * Implements bidirectional host tool invocation using JSON-RPC server requests.
 * San sends `host.tool.invoke` as a server request; Desktop responds with
 * a standard JSON-RPC result or error.
 */
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { RpcId } from "./protocol/envelope";

interface PendingHostRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

type OutputFn = (frame: object) => void;

export class RpcV2HostToolBridge {
	#output: OutputFn;
	#pending = new Map<string, PendingHostRequest>();
	#tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
	#uriSchemes: Array<{ scheme: string; description?: string; writable?: boolean }> = [];

	constructor(output: OutputFn) {
		this.#output = output;
	}

	setTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): string[] {
		this.#tools = tools;
		return tools.map(t => t.name);
	}

	setUriSchemes(schemes: Array<{ scheme: string; description?: string; writable?: boolean }>): string[] {
		this.#uriSchemes = schemes;
		return schemes.map(s => s.scheme);
	}

	get registeredTools(): string[] {
		return this.#tools.map(t => t.name);
	}

	get registeredSchemes(): string[] {
		return this.#uriSchemes.map(s => s.scheme);
	}

	/** Invoke a host tool via JSON-RPC server request. */
	invoke(
		toolName: string,
		args: Record<string, unknown>,
		options?: { deadlineMs?: number; toolCallId?: string },
	): Promise<unknown> {
		const requestId = `host_req_${Snowflake.next()}` as RpcId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		const deadlineMs = options?.deadlineMs ?? 30_000;
		const timer = setTimeout(() => {
			const pending = this.#pending.get(requestId);
			if (pending) {
				this.#pending.delete(requestId);
				pending.reject(new Error(`Host tool "${toolName}" timed out after ${deadlineMs}ms`));
			}
		}, deadlineMs);

		this.#pending.set(requestId, { resolve, reject, timer });

		this.#output({
			jsonrpc: "2.0",
			id: requestId,
			method: "host.tool.invoke",
			params: {
				toolName,
				arguments: args,
				deadlineMs,
				...(options?.toolCallId && { toolCallId: options.toolCallId }),
			},
		});

		return promise;
	}

	/** Invoke a host URI read/write via JSON-RPC server request. */
	invokeUri(operation: "read" | "write", url: string, content?: string): Promise<unknown> {
		const requestId = `host_uri_${Snowflake.next()}` as RpcId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		const timer = setTimeout(() => {
			const pending = this.#pending.get(requestId);
			if (pending) {
				this.#pending.delete(requestId);
				pending.reject(new Error(`Host URI ${operation} timed out for ${url}`));
			}
		}, 30_000);

		this.#pending.set(requestId, { resolve, reject, timer });

		this.#output({
			jsonrpc: "2.0",
			id: requestId,
			method: "host.uri.invoke",
			params: { operation, url, ...(content !== undefined && { content }) },
		});

		return promise;
	}

	/** Handle a client result for a pending host request. */
	handleResult(id: string, result: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(result);
		return true;
	}

	/** Handle a client error for a pending host request. */
	handleError(id: string, error: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#pending.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.reject(
			new Error(
				typeof error === "object" && error !== null && "message" in error
					? String((error as { message: unknown }).message)
					: String(error),
			),
		);
		return true;
	}

	/** Cancel a pending host request. */
	cancel(targetRequestId: string, reason: string): void {
		this.#output({
			jsonrpc: "2.0",
			method: "host.tool.cancel",
			params: { targetId: targetRequestId, reason },
		});
	}

	/** Reject all pending requests (disconnect cleanup). */
	close(message: string): void {
		for (const [, pending] of this.#pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.#pending.clear();
	}
}
