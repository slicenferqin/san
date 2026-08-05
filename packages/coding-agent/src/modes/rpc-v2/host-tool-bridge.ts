/** San RPC v2 Host Tool 与 Host URI 双向桥接。 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@san/agent";
import type { Static, TSchema } from "@san/ai";
import { Snowflake } from "@san/utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "../theme/theme";
import { DEFAULT_LIMITS } from "./protocol/capabilities";
import type { FieldError, RpcErrorBody, RpcErrorCategory, RpcErrorData, RpcId } from "./protocol/envelope";

/** 默认 Host 调用截止时间（毫秒）。 */
export const DEFAULT_HOST_DEADLINE_MS = 30_000;

/**
 * Host 请求参数/URI 内容的字节上限。
 * 使用 initialize 默认 maxInlineTextBytes，避免把大载荷塞进单帧。
 */
export const HOST_MAX_INLINE_PAYLOAD_BYTES = DEFAULT_LIMITS.maxInlineTextBytes;

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

/** 普通 Agent Host Tool 与独立 host-action 共用的强身份。 */
export interface HostRequestIdentity {
	sessionId: string;
	runId: string;
	toolCallId: string;
}

/** invoke / invokeHostAction 的可复用选项。 */
export interface HostInvokeOptions {
	deadlineMs?: number;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	/** 调用时绑定的 capability revision；仅透传给 Host，不在 bridge 内猜测可用性。 */
	capabilityRevision?: number;
}

/** 独立 host-action（如 worktree setup）必须显式提供身份，不得回落到 Agent 上下文。 */
export interface HostActionInvokeOptions extends HostInvokeOptions {
	identity: HostRequestIdentity;
}

/** URI 读/写选项。 */
export interface HostUriInvokeOptions {
	deadlineMs?: number;
	signal?: AbortSignal;
	/** write 时的替换内容；受 HOST_MAX_INLINE_PAYLOAD_BYTES 约束。 */
	content?: string;
	sessionId?: string;
	runId?: string;
	/** 调用时绑定的 capability revision；显式优先，否则走 bridge provider。 */
	capabilityRevision?: number;
}

interface PendingHostRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
}

type OutputFn = (frame: object) => void;
type ContextProvider = () => { sessionId?: string; runId?: string };
/** 当前 Host capability revision；无 provider 时保持 optional，不得猜测常量。 */
type CapabilityRevisionProvider = () => number | undefined;

/** bridge 构造可选项；revision provider 仅在 mode 注入后默认绑定普通 Host 请求。 */
export interface RpcV2HostToolBridgeOptions {
	maxPayloadBytes?: number;
	/** 返回当前 capability revision；undefined 表示本帧不发 wire 字段。 */
	getCapabilityRevision?: CapabilityRevisionProvider;
}

/**
 * 保留 Host/RPC 结构化错误字段的失败类型。
 * 调用方可用 `isHostRequestError` 分支，不得只解析 message 文本。
 */
export class HostRequestError extends Error {
	readonly code: number;
	readonly reason: string;
	readonly category: RpcErrorCategory | string;
	readonly retryable: boolean;
	readonly correlationId: string;
	readonly sessionId?: string;
	readonly runId?: string;
	readonly details?: Record<string, unknown>;
	readonly fieldErrors?: RpcErrorData["fieldErrors"];
	readonly suggestedActions?: string[];
	readonly data?: RpcErrorData;
	readonly rpcError?: RpcErrorBody;

	constructor(message: string, init?: Partial<HostRequestErrorInit> & { cause?: unknown }) {
		super(message, init?.cause !== undefined ? { cause: init.cause } : undefined);
		this.name = "HostRequestError";
		this.code = init?.code ?? -32061;
		this.reason = init?.reason ?? "HOST_TOOL_FAILED";
		this.category = init?.category ?? "io";
		this.retryable = init?.retryable ?? false;
		this.correlationId = init?.correlationId ?? (Snowflake.next() as string);
		if (init?.sessionId !== undefined) this.sessionId = init.sessionId;
		if (init?.runId !== undefined) this.runId = init.runId;
		if (init?.details !== undefined) this.details = init.details;
		if (init?.fieldErrors !== undefined) this.fieldErrors = init.fieldErrors;
		if (init?.suggestedActions !== undefined) this.suggestedActions = init.suggestedActions;
		if (init?.data !== undefined) this.data = init.data;
		if (init?.rpcError !== undefined) this.rpcError = init.rpcError;
	}
}

interface HostRequestErrorInit {
	code: number;
	reason: string;
	category: RpcErrorCategory | string;
	retryable: boolean;
	correlationId: string;
	sessionId?: string;
	runId?: string;
	details?: Record<string, unknown>;
	fieldErrors?: RpcErrorData["fieldErrors"];
	suggestedActions?: string[];
	data?: RpcErrorData;
	rpcError?: RpcErrorBody;
	cause?: unknown;
}

export function isHostRequestError(error: unknown): error is HostRequestError {
	return error instanceof HostRequestError;
}

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
		if (!isAgentToolResult(result)) {
			throw new HostRequestError(`Host tool "${this.#definition.name}" returned an invalid result`, {
				reason: "HOST_TOOL_FAILED",
				category: "io",
				code: -32061,
				details: { toolName: this.#definition.name, cause: "invalid_result_shape" },
			});
		}
		if (result.isError) {
			const message = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text)
				.join("\n")
				.trim();
			throw new HostRequestError(message || `Host tool "${this.#definition.name}" failed`, {
				reason: "HOST_TOOL_FAILED",
				category: "io",
				code: -32061,
				details: { toolName: this.#definition.name, isError: true },
			});
		}
		return result;
	}
}

export class RpcV2HostToolBridge {
	readonly #output: OutputFn;
	readonly #contextProvider: ContextProvider;
	readonly #getCapabilityRevision: CapabilityRevisionProvider | undefined;
	#pending = new Map<string, PendingHostRequest>();
	#tools: HostToolDefinition[] = [];
	#agentTools: AgentTool[] = [];
	#uriSchemes: HostUriSchemeDefinition[] = [];
	#closedError: HostRequestError | undefined;
	/** 参数/内容字节上限；可由测试或 mode 注入，默认取协议 maxInlineTextBytes。 */
	readonly #maxPayloadBytes: number;

	constructor(output: OutputFn, contextProvider: ContextProvider = () => ({}), options?: RpcV2HostToolBridgeOptions) {
		this.#output = output;
		this.#contextProvider = contextProvider;
		this.#getCapabilityRevision = options?.getCapabilityRevision;
		this.#maxPayloadBytes = options?.maxPayloadBytes ?? HOST_MAX_INLINE_PAYLOAD_BYTES;
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

	get maxPayloadBytes(): number {
		return this.#maxPayloadBytes;
	}

	supportsUriScheme(scheme: string, access: "read" | "write" = "read"): boolean {
		const registered = this.#uriSchemes.find(item => item.scheme.toLowerCase() === scheme.toLowerCase());
		return Boolean(registered && (access === "read" || registered.writable === true));
	}

	/**
	 * Agent Tool 路径：强制从 contextProvider + toolCallId 取 active Session/Run/ToolCall。
	 * 不得用于 worktree setup 等 pre-session / 独立 host-action。
	 */
	invoke(
		toolName: string,
		args: Record<string, unknown>,
		options: HostInvokeOptions & { toolCallId: string },
	): Promise<unknown> {
		const context = this.#contextProvider();
		if (!context.sessionId || !context.runId || !options.toolCallId) {
			return Promise.reject(
				new HostRequestError(`Host tool "${toolName}" requires an active Session, Run, and ToolCall`, {
					reason: "HOST_CAPABILITY_UNAVAILABLE",
					category: "conflict",
					code: -32060,
					details: {
						toolName,
						hasSessionId: Boolean(context.sessionId),
						hasRunId: Boolean(context.runId),
						hasToolCallId: Boolean(options.toolCallId),
					},
				}),
			);
		}
		return this.#invokeTool(
			toolName,
			args,
			{
				sessionId: context.sessionId,
				runId: context.runId,
				toolCallId: options.toolCallId,
			},
			options,
		);
	}

	/**
	 * 独立 host-action 入口（worktree setup 等）。
	 * 身份必须由调用方显式传入；不回落 Agent 上下文，也不放松字段要求。
	 */
	invokeHostAction(
		toolName: string,
		args: Record<string, unknown>,
		options: HostActionInvokeOptions,
	): Promise<unknown> {
		const identity = options.identity;
		if (
			!isNonEmptyString(identity?.sessionId) ||
			!isNonEmptyString(identity?.runId) ||
			!isNonEmptyString(identity?.toolCallId)
		) {
			return Promise.reject(
				new HostRequestError(`Host action "${toolName}" requires explicit sessionId, runId, and toolCallId`, {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [
						...(!isNonEmptyString(identity?.sessionId)
							? [{ path: "identity.sessionId", reason: "required", message: "sessionId is required" }]
							: []),
						...(!isNonEmptyString(identity?.runId)
							? [{ path: "identity.runId", reason: "required", message: "runId is required" }]
							: []),
						...(!isNonEmptyString(identity?.toolCallId)
							? [{ path: "identity.toolCallId", reason: "required", message: "toolCallId is required" }]
							: []),
					],
					details: { toolName },
				}),
			);
		}
		return this.#invokeTool(
			toolName,
			args,
			{
				sessionId: identity.sessionId.trim(),
				runId: identity.runId.trim(),
				toolCallId: identity.toolCallId.trim(),
			},
			options,
		);
	}

	invokeUri(
		operation: "read" | "write",
		url: string,
		contentOrOptions?: string | HostUriInvokeOptions,
	): Promise<unknown> {
		const options: HostUriInvokeOptions =
			typeof contentOrOptions === "string" ? { content: contentOrOptions } : (contentOrOptions ?? {});
		const context = this.#contextProvider();
		const sessionId = options.sessionId ?? context.sessionId;
		const runId = options.runId ?? context.runId;

		if (!isNonEmptyString(url)) {
			return Promise.reject(
				new HostRequestError("host.uri.invoke requires a non-empty url", {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [{ path: "url", reason: "required", message: "url is required" }],
				}),
			);
		}
		if (utf8ByteLength(url) > this.#maxPayloadBytes) {
			return Promise.reject(
				new HostRequestError(`host.uri url exceeds ${this.#maxPayloadBytes} bytes`, {
					reason: "PAYLOAD_TOO_LARGE",
					category: "validation",
					code: -32070,
					fieldErrors: [{ path: "url", reason: "too_large", message: "Use a shorter host URI" }],
					details: { maxPayloadBytes: this.#maxPayloadBytes, actualBytes: utf8ByteLength(url) },
				}),
			);
		}
		if (operation === "write" && options.content === undefined) {
			return Promise.reject(
				new HostRequestError("host.uri.invoke write requires content", {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [{ path: "content", reason: "required", message: "content is required for write" }],
				}),
			);
		}
		if (options.content !== undefined) {
			const contentBytes = utf8ByteLength(options.content);
			if (contentBytes > this.#maxPayloadBytes) {
				return Promise.reject(
					new HostRequestError(`host.uri content exceeds ${this.#maxPayloadBytes} bytes`, {
						reason: "PAYLOAD_TOO_LARGE",
						category: "validation",
						code: -32070,
						fieldErrors: [
							{ path: "content", reason: "too_large", message: "Use an Artifact or chunked transfer" },
						],
						details: { maxPayloadBytes: this.#maxPayloadBytes, actualBytes: contentBytes },
					}),
				);
			}
		}

		const deadlineMs = normalizeDeadlineMs(options.deadlineMs);
		const capabilityRevision = this.#resolveCapabilityRevision(options.capabilityRevision);
		return this.#request(
			"host.uri.invoke",
			{
				...(sessionId ? { sessionId } : {}),
				...(runId ? { runId } : {}),
				operation,
				url,
				...(options.content !== undefined ? { content: options.content } : {}),
				deadlineMs,
				...(capabilityRevision !== undefined ? { capabilityRevision } : {}),
			},
			"host_uri",
			deadlineMs,
			options.signal,
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
		pending.reject(toHostRequestError(error));
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
		if (!this.#closedError) {
			this.#closedError = new HostRequestError(message, {
				reason: "HOST_TOOL_FAILED",
				category: "io",
				code: -32061,
				details: { closed: true },
			});
		}
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const item of pending) item.reject(this.#closedError);
	}

	#invokeTool(
		toolName: string,
		args: Record<string, unknown>,
		identity: HostRequestIdentity,
		options: HostInvokeOptions,
	): Promise<unknown> {
		if (!isNonEmptyString(toolName)) {
			return Promise.reject(
				new HostRequestError("host.tool.invoke requires a non-empty toolName", {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [{ path: "toolName", reason: "required", message: "toolName is required" }],
				}),
			);
		}
		if (!isRecord(args)) {
			return Promise.reject(
				new HostRequestError(`Host tool "${toolName}" arguments must be an object`, {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [{ path: "arguments", reason: "invalid_type", message: "Expected an object" }],
					details: { toolName },
				}),
			);
		}

		let argumentsJson: string;
		try {
			argumentsJson = JSON.stringify(args);
		} catch (error: unknown) {
			return Promise.reject(
				new HostRequestError(`Host tool "${toolName}" arguments are not JSON-serializable`, {
					reason: "INVALID_PARAMS",
					category: "validation",
					code: -32602,
					fieldErrors: [{ path: "arguments", reason: "invalid", message: "Arguments must be JSON-serializable" }],
					details: { toolName },
					cause: error,
				}),
			);
		}
		const argsBytes = utf8ByteLength(argumentsJson);
		if (argsBytes > this.#maxPayloadBytes) {
			return Promise.reject(
				new HostRequestError(`Host tool "${toolName}" arguments exceed ${this.#maxPayloadBytes} bytes`, {
					reason: "PAYLOAD_TOO_LARGE",
					category: "validation",
					code: -32070,
					fieldErrors: [
						{
							path: "arguments",
							reason: "too_large",
							message: "Reduce arguments or use a host URI/Artifact",
						},
					],
					details: { toolName, maxPayloadBytes: this.#maxPayloadBytes, actualBytes: argsBytes },
				}),
			);
		}

		const deadlineMs = normalizeDeadlineMs(options.deadlineMs);
		// 显式 options.capabilityRevision 优先；否则取注入的 current revision provider。
		const capabilityRevision = this.#resolveCapabilityRevision(options.capabilityRevision);
		return this.#request(
			"host.tool.invoke",
			{
				sessionId: identity.sessionId,
				runId: identity.runId,
				toolCallId: identity.toolCallId,
				toolName,
				arguments: args,
				deadlineMs,
				...(capabilityRevision !== undefined ? { capabilityRevision } : {}),
			},
			"host_req",
			deadlineMs,
			options.signal,
			options.onUpdate,
		);
	}

	/**
	 * 解析本帧要绑定的 capability revision。
	 * 显式值优先；无显式时才问 provider。仅 finite number 写入 wire，避免 NaN/Infinity。
	 */
	#resolveCapabilityRevision(explicit?: number): number | undefined {
		const candidate = explicit !== undefined ? explicit : this.#getCapabilityRevision?.();
		return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
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
		if (signal?.aborted) {
			return Promise.reject(
				new HostRequestError(`${method} was aborted before dispatch`, {
					reason: "HOST_TOOL_FAILED",
					category: "io",
					code: -32061,
					details: { method, abortedBeforeDispatch: true },
				}),
			);
		}

		const requestId = `${prefix}_${Snowflake.next()}` as RpcId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

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
			// 超时与 abort 都必须先通知 Host 取消，再拒绝本地 promise。
			this.cancel(requestId, "agent_abort");
			settleReject(
				new HostRequestError(`${method} was aborted`, {
					reason: "HOST_TOOL_FAILED",
					category: "io",
					code: -32061,
					details: { method, requestId, cancelReason: "agent_abort" },
				}),
			);
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
		timer = setTimeout(() => {
			// 超时 ≠ 静默失败：必须发 host.tool.cancel，让 Desktop 收口 in-flight 操作。
			this.cancel(requestId, "deadline_exceeded");
			settleReject(
				new HostRequestError(`${method} timed out after ${deadlineMs}ms`, {
					reason: "HOST_TOOL_FAILED",
					category: "io",
					code: -32061,
					retryable: true,
					details: { method, requestId, deadlineMs, cancelReason: "deadline_exceeded" },
				}),
			);
		}, deadlineMs);
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

/** 将 Client error response / 任意失败值规范为 HostRequestError，保留 data 字段。 */
function toHostRequestError(error: unknown): HostRequestError {
	if (error instanceof HostRequestError) return error;

	if (isRecord(error)) {
		const message = typeof error.message === "string" && error.message.trim() ? error.message : "Host request failed";
		const rawData = isRecord(error.data) ? error.data : undefined;
		const data = parseRpcErrorData(rawData);
		const code = typeof error.code === "number" ? error.code : -32061;
		const reason =
			data?.reason ||
			(typeof rawData?.reason === "string" && rawData.reason) ||
			(typeof error.reason === "string" && error.reason) ||
			"HOST_TOOL_FAILED";
		const category =
			data?.category ||
			(typeof rawData?.category === "string" && rawData.category) ||
			(typeof error.category === "string" && error.category) ||
			"io";
		const retryable =
			data?.retryable ||
			(typeof rawData?.retryable === "boolean" && rawData.retryable) ||
			(typeof error.retryable === "boolean" && error.retryable) ||
			false;
		const correlationId =
			data?.correlationId ||
			(typeof rawData?.correlationId === "string" && rawData.correlationId) ||
			(typeof error.correlationId === "string" && error.correlationId) ||
			(Snowflake.next() as string);

		const init: Partial<HostRequestErrorInit> & { cause?: unknown } = {
			code,
			reason,
			category,
			retryable,
			correlationId,
			cause: error,
		};
		if (data?.sessionId !== undefined) init.sessionId = data.sessionId;
		else if (typeof rawData?.sessionId === "string") init.sessionId = rawData.sessionId;
		else if (typeof error.sessionId === "string") init.sessionId = error.sessionId;
		if (data?.runId !== undefined) init.runId = data.runId;
		else if (typeof rawData?.runId === "string") init.runId = rawData.runId;
		else if (typeof error.runId === "string") init.runId = error.runId;
		if (data?.details !== undefined) init.details = data.details;
		else if (isRecord(rawData?.details)) init.details = rawData.details;
		else if (isRecord(error.details)) init.details = error.details;
		else if (rawData && !data) init.details = { raw: rawData };
		if (data?.fieldErrors !== undefined) init.fieldErrors = data.fieldErrors;
		else if (rawData && Array.isArray(rawData.fieldErrors)) {
			const fieldErrors = parseFieldErrors(rawData.fieldErrors);
			if (fieldErrors) init.fieldErrors = fieldErrors;
		}
		if (data?.suggestedActions !== undefined) init.suggestedActions = data.suggestedActions;
		else if (rawData && isStringArray(rawData.suggestedActions)) {
			init.suggestedActions = rawData.suggestedActions;
		}
		// 仅在通过运行时解析后写入 data；畸形 data 视为 absent/raw，不做类型断言。
		if (data) init.data = data;
		if (typeof error.code === "number" || data) {
			init.rpcError = {
				code,
				message,
				...(data ? { data } : {}),
			};
		}
		return new HostRequestError(message, init);
	}

	if (error instanceof Error) {
		return new HostRequestError(error.message || "Host request failed", {
			reason: "HOST_TOOL_FAILED",
			category: "io",
			code: -32061,
			cause: error,
		});
	}

	return new HostRequestError("Host request failed", {
		reason: "HOST_TOOL_FAILED",
		category: "io",
		code: -32061,
		details: { raw: error },
	});
}

const RPC_ERROR_CATEGORIES: Readonly<Record<RpcErrorCategory, true>> = {
	protocol: true,
	validation: true,
	auth: true,
	conflict: true,
	not_found: true,
	rate_limit: true,
	io: true,
	internal: true,
};

function isRpcErrorCategory(value: unknown): value is RpcErrorCategory {
	return typeof value === "string" && value in RPC_ERROR_CATEGORIES;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function parseFieldError(value: unknown): FieldError | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.path !== "string" || typeof value.reason !== "string" || typeof value.message !== "string") {
		return undefined;
	}
	return { path: value.path, reason: value.reason, message: value.message };
}

function parseFieldErrors(value: unknown): FieldError[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const fieldErrors: FieldError[] = [];
	for (const item of value) {
		const parsed = parseFieldError(item);
		if (parsed) fieldErrors.push(parsed);
	}
	return fieldErrors.length > 0 ? fieldErrors : undefined;
}

/**
 * 运行时解析 RpcErrorData。
 * 必填字段齐全且类型正确时返回结构化 data；否则视为畸形，返回 undefined（由调用方按 absent/raw 处理）。
 */
function parseRpcErrorData(value: unknown): RpcErrorData | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.reason !== "string" || !value.reason) return undefined;
	if (!isRpcErrorCategory(value.category)) return undefined;
	if (typeof value.retryable !== "boolean") return undefined;
	if (typeof value.correlationId !== "string" || !value.correlationId) return undefined;

	const data: RpcErrorData = {
		reason: value.reason,
		category: value.category,
		retryable: value.retryable,
		correlationId: value.correlationId,
	};

	if (typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs)) {
		data.retryAfterMs = value.retryAfterMs;
	}
	if (typeof value.sessionId === "string") data.sessionId = value.sessionId;
	if (typeof value.runId === "string") data.runId = value.runId;
	if (isRecord(value.details)) data.details = value.details;
	const fieldErrors = parseFieldErrors(value.fieldErrors);
	if (fieldErrors) data.fieldErrors = fieldErrors;
	if (isStringArray(value.suggestedActions)) data.suggestedActions = value.suggestedActions;

	return data;
}

function normalizeDeadlineMs(deadlineMs: number | undefined): number {
	if (deadlineMs === undefined) return DEFAULT_HOST_DEADLINE_MS;
	if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return DEFAULT_HOST_DEADLINE_MS;
	return Math.floor(deadlineMs);
}

function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
