/**
 * JSON-RPC 2.0 envelope types for San RPC v2.
 *
 * The transport is stdio NDJSON (one JSON object per line, UTF-8).
 * These types define the wire shape of every frame exchanged between
 * the Desktop client and the San RPC process.
 */

/** Opaque request/response correlation identifier. */
export type RpcId = string;

/** Client → Server request. */
export interface ClientRequest<P = unknown> {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params: P;
}

/** Server → Client successful result. */
export interface ServerResult<R = unknown> {
	jsonrpc: "2.0";
	id: RpcId;
	result: R;
}

/** Server → Client error response. */
export interface ServerErrorResponse {
	jsonrpc: "2.0";
	id: RpcId | null;
	error: RpcErrorBody;
}

/** Bidirectional notification (no id, no response expected). */
export interface Notification<P = unknown> {
	jsonrpc: "2.0";
	method: string;
	params: P;
}

/** Server → Client request (e.g. host tool invocation). */
export interface ServerRequest<P = unknown> {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params: P;
}

/** Client → Server result for a server-initiated request. */
export interface ClientResult<R = unknown> {
	jsonrpc: "2.0";
	id: RpcId;
	result: R;
}

/** Client → Server error for a server-initiated request. */
export interface ClientErrorResponse {
	jsonrpc: "2.0";
	id: RpcId | null;
	error: RpcErrorBody;
}

/** Error body embedded in error responses. */
export interface RpcErrorBody {
	code: number;
	message: string;
	data?: RpcErrorData;
}

/** Structured error data carried in `RpcErrorBody.data`. */
export interface RpcErrorData {
	/** Stable machine-readable reason (e.g. SESSION_LOCKED). */
	reason: string;
	category: RpcErrorCategory;
	retryable: boolean;
	retryAfterMs?: number;
	correlationId: string;
	sessionId?: string;
	runId?: string;
	fieldErrors?: FieldError[];
	suggestedActions?: string[];
	details?: Record<string, unknown>;
}

export type RpcErrorCategory =
	| "protocol"
	| "validation"
	| "auth"
	| "conflict"
	| "not_found"
	| "rate_limit"
	| "io"
	| "internal";

export interface FieldError {
	path: string;
	reason: string;
	message: string;
}

/** Any frame that can appear on the wire. */
export type WireFrame =
	| ClientRequest
	| ServerResult
	| ServerErrorResponse
	| Notification
	| ServerRequest
	| ClientResult
	| ClientErrorResponse;

// ============================================================================
// Type guards
// ============================================================================

export function isClientRequest(frame: unknown): frame is ClientRequest {
	if (typeof frame !== "object" || frame === null) return false;
	const obj = frame as Record<string, unknown>;
	return obj.jsonrpc === "2.0" && typeof obj.id === "string" && typeof obj.method === "string" && "params" in obj;
}

export function isNotification(frame: unknown): frame is Notification {
	if (typeof frame !== "object" || frame === null) return false;
	const obj = frame as Record<string, unknown>;
	return obj.jsonrpc === "2.0" && typeof obj.method === "string" && !("id" in obj);
}

export function isClientResult(frame: unknown): frame is ClientResult {
	if (typeof frame !== "object" || frame === null) return false;
	const obj = frame as Record<string, unknown>;
	return obj.jsonrpc === "2.0" && typeof obj.id === "string" && "result" in obj && !("method" in obj);
}

export function isClientErrorResponse(frame: unknown): frame is ClientErrorResponse {
	if (typeof frame !== "object" || frame === null) return false;
	const obj = frame as Record<string, unknown>;
	return obj.jsonrpc === "2.0" && "id" in obj && "error" in obj && !("method" in obj);
}
