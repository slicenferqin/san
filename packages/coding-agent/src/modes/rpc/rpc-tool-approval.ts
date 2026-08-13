/**
 * Structured tool-approval frames for RPC mode.
 *
 * Once the client has declared the `toolApproval` capability
 * (`set_client_capabilities`), tool approvals are emitted as structured
 * `tool_approval_request` frames on stdout and settled by
 * `tool_approval_response` frames on stdin instead of degrading to the
 * generic `extension_ui_request` select dialog.
 */
import { isRecord, Snowflake } from "@san/utils";
import type {
	ExtensionToolApprovalDecision,
	ExtensionToolApprovalRequest,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../../extensibility/extensions";
import type { RpcClientCapabilities, RpcToolApprovalRequestFrame, RpcToolApprovalResponse } from "./rpc-types";

type RpcToolApprovalOutput = (frame: RpcToolApprovalRequestFrame) => void;

type PendingToolApproval = {
	settle: (decision: ExtensionToolApprovalDecision) => void;
	reject: (error: Error) => void;
};

/**
 * Structural guard for a well-formed tool approval response frame. Mirrors
 * the extension UI response guard in rpc-mode: `type`, string `id`, and the
 * required `allowed` boolean; optional fields are normalized at the read site.
 */
export function isRpcToolApprovalResponse(value: unknown): value is RpcToolApprovalResponse {
	if (!isRecord(value)) return false;
	return value.type === "tool_approval_response" && typeof value.id === "string" && typeof value.allowed === "boolean";
}

function normalizeApprovalScope(value: unknown): ExtensionToolApprovalDecision["scope"] {
	return value === "once" || value === "session" || value === "workspace" || value === "global" ? value : undefined;
}

/** Map a wire response onto the decision shape the approval wrapper consumes. */
function parseToolApprovalDecision(frame: RpcToolApprovalResponse): ExtensionToolApprovalDecision {
	const scope = normalizeApprovalScope(frame.scope);
	return {
		allowed: frame.allowed,
		...(scope ? { scope } : {}),
		...(typeof frame.persistRule === "boolean" ? { persistRule: frame.persistRule } : {}),
		...(typeof frame.comment === "string" ? { comment: frame.comment } : {}),
	};
}

/**
 * Build the `requestToolApproval` implementation for the RPC UI context.
 * Stays `undefined` until the client declares the `toolApproval` capability so
 * the approval wrapper's truthiness check keeps routing undeclared clients to
 * the legacy select dialog (byte-identical to the pre-capability protocol).
 */
export function createRpcToolApprovalMethod(
	capabilities: RpcClientCapabilities,
	bridge: RpcToolApprovalBridge,
): ExtensionUIContext["requestToolApproval"] {
	if (capabilities.toolApproval !== true) return undefined;
	return (request, dialogOptions) => bridge.request(request, dialogOptions);
}

/**
 * Correlates `tool_approval_request` frames with their
 * `tool_approval_response` settlements. Abort and timeout settle locally as
 * denials (`comment: "cancelled"` / `"timed_out"`); client disconnect rejects
 * active and future requests so pending approvals cannot hang EOF draining.
 */
export class RpcToolApprovalBridge {
	#output: RpcToolApprovalOutput;
	#pending = new Map<string, PendingToolApproval>();
	#closedError: Error | undefined;

	constructor(output: RpcToolApprovalOutput) {
		this.#output = output;
	}

	/** Settle the pending approval matching the response frame's `id`. */
	handleResponse(frame: RpcToolApprovalResponse): boolean {
		const pending = this.#pending.get(frame.id);
		if (!pending) return false;
		pending.settle(parseToolApprovalDecision(frame));
		return true;
	}

	request(
		request: ExtensionToolApprovalRequest,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionToolApprovalDecision> {
		if (dialogOptions?.signal?.aborted) {
			return Promise.resolve({ allowed: false, comment: "cancelled" });
		}
		if (this.#closedError) return Promise.reject(this.#closedError);

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<ExtensionToolApprovalDecision>();
		let timeoutId: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const settle = (decision: ExtensionToolApprovalDecision) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(decision);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			settle({ allowed: false, comment: "cancelled" });
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

		if (dialogOptions?.timeout !== undefined) {
			timeoutId = setTimeout(() => {
				dialogOptions.onTimeout?.();
				settle({ allowed: false, comment: "timed_out" });
			}, dialogOptions.timeout);
		}

		this.#pending.set(id, { settle, reject: fail });
		this.#output({ ...request, type: "tool_approval_request", id });
		return promise;
	}

	/** Reject active and future approval requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const entry of pending) {
			entry.reject(this.#closedError);
		}
	}
}
