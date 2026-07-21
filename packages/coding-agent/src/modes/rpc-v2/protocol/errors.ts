/**
 * San RPC v2 error codes and factory helpers.
 *
 * Numeric codes follow JSON-RPC 2.0 reserved ranges for standard errors
 * and use -320xx for San-specific domain errors.
 */
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { FieldError, RpcErrorBody, RpcErrorCategory, RpcErrorData } from "./envelope";

// ============================================================================
// JSON-RPC 2.0 standard codes
// ============================================================================

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ============================================================================
// San domain codes
// ============================================================================

export const NOT_INITIALIZED = -32001;
export const VERSION_INCOMPATIBLE = -32002;
export const CAPABILITY_UNAVAILABLE = -32010;
export const SESSION_NOT_FOUND = -32020;
export const SESSION_LOCKED = -32021;
export const SESSION_STATE_CONFLICT = -32022;
export const SESSION_CORRUPT = -32023;
export const RUN_NOT_FOUND = -32030;
export const RUN_STATE_CONFLICT = -32031;
export const QUEUE_ITEM_NOT_FOUND = -32032;
export const APPROVAL_NOT_PENDING = -32040;
export const APPROVAL_SCOPE_NOT_ALLOWED = -32041;
export const PROVIDER_AUTH_REQUIRED = -32050;
export const MODEL_UNAVAILABLE = -32051;
export const RATE_LIMITED = -32052;
export const HOST_CAPABILITY_UNAVAILABLE = -32060;
export const HOST_TOOL_FAILED = -32061;
export const RESOURCE_NOT_FOUND = -32062;
export const RESOURCE_INVALID = -32063;
export const INTEGRATION_UNAVAILABLE = -32064;
export const PAYLOAD_TOO_LARGE = -32070;
export const IDEMPOTENCY_CONFLICT = -32080;

// ============================================================================
// Reason strings (stable machine codes)
// ============================================================================

export type SanErrorReason =
	| "PARSE_ERROR"
	| "INVALID_REQUEST"
	| "METHOD_NOT_FOUND"
	| "INVALID_PARAMS"
	| "INTERNAL_ERROR"
	| "NOT_INITIALIZED"
	| "VERSION_INCOMPATIBLE"
	| "CAPABILITY_UNAVAILABLE"
	| "SESSION_NOT_FOUND"
	| "SESSION_LOCKED"
	| "SESSION_STATE_CONFLICT"
	| "SESSION_CORRUPT"
	| "RUN_NOT_FOUND"
	| "RUN_STATE_CONFLICT"
	| "QUEUE_ITEM_NOT_FOUND"
	| "APPROVAL_NOT_PENDING"
	| "APPROVAL_SCOPE_NOT_ALLOWED"
	| "PROVIDER_AUTH_REQUIRED"
	| "MODEL_UNAVAILABLE"
	| "RATE_LIMITED"
	| "HOST_CAPABILITY_UNAVAILABLE"
	| "HOST_TOOL_FAILED"
	| "RESOURCE_NOT_FOUND"
	| "RESOURCE_INVALID"
	| "INTEGRATION_UNAVAILABLE"
	| "PAYLOAD_TOO_LARGE"
	| "IDEMPOTENCY_CONFLICT";

// ============================================================================
// Factory
// ============================================================================

export interface SanErrorOptions {
	reason: SanErrorReason;
	category: RpcErrorCategory;
	message: string;
	retryable?: boolean;
	retryAfterMs?: number;
	sessionId?: string;
	runId?: string;
	fieldErrors?: FieldError[];
	suggestedActions?: string[];
	details?: Record<string, unknown>;
}

const REASON_TO_CODE: Record<SanErrorReason, number> = {
	PARSE_ERROR,
	INVALID_REQUEST,
	METHOD_NOT_FOUND,
	INVALID_PARAMS,
	INTERNAL_ERROR,
	NOT_INITIALIZED,
	VERSION_INCOMPATIBLE,
	CAPABILITY_UNAVAILABLE,
	SESSION_NOT_FOUND,
	SESSION_LOCKED,
	SESSION_STATE_CONFLICT,
	SESSION_CORRUPT,
	RUN_NOT_FOUND,
	RUN_STATE_CONFLICT,
	QUEUE_ITEM_NOT_FOUND,
	APPROVAL_NOT_PENDING,
	APPROVAL_SCOPE_NOT_ALLOWED,
	PROVIDER_AUTH_REQUIRED,
	MODEL_UNAVAILABLE,
	RATE_LIMITED,
	HOST_CAPABILITY_UNAVAILABLE,
	HOST_TOOL_FAILED,
	RESOURCE_NOT_FOUND,
	RESOURCE_INVALID,
	INTEGRATION_UNAVAILABLE,
	PAYLOAD_TOO_LARGE,
	IDEMPOTENCY_CONFLICT,
};

/** Create a structured RPC error body from San domain parameters. */
export function createRpcError(options: SanErrorOptions): RpcErrorBody {
	const data: RpcErrorData = {
		reason: options.reason,
		category: options.category,
		retryable: options.retryable ?? false,
		correlationId: Snowflake.next() as string,
		...(options.retryAfterMs !== undefined && { retryAfterMs: options.retryAfterMs }),
		...(options.sessionId !== undefined && { sessionId: options.sessionId }),
		...(options.runId !== undefined && { runId: options.runId }),
		...(options.fieldErrors !== undefined && { fieldErrors: options.fieldErrors }),
		...(options.suggestedActions !== undefined && { suggestedActions: options.suggestedActions }),
		...(options.details !== undefined && { details: options.details }),
	};
	return {
		code: REASON_TO_CODE[options.reason],
		message: options.message,
		data,
	};
}

/** Shorthand for common protocol errors. */
export function methodNotFound(method: string): RpcErrorBody {
	return createRpcError({
		reason: "METHOD_NOT_FOUND",
		category: "protocol",
		message: `Method not found: ${method}`,
	});
}

export function invalidParams(message: string, fieldErrors?: FieldError[]): RpcErrorBody {
	return createRpcError({
		reason: "INVALID_PARAMS",
		category: "validation",
		message,
		fieldErrors,
	});
}

export function notInitialized(): RpcErrorBody {
	return createRpcError({
		reason: "NOT_INITIALIZED",
		category: "protocol",
		message: "Server not initialized. Send initialize first.",
		suggestedActions: ["initialize"],
	});
}

export function internalError(message: string): RpcErrorBody {
	return createRpcError({
		reason: "INTERNAL_ERROR",
		category: "internal",
		message,
	});
}
