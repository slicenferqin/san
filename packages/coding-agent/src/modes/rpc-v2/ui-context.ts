/**
 * San RPC v2 UI Context.
 *
 * Implements ExtensionUIContext to bridge the internal approval/interaction
 * system to structured v2 protocol events. When a tool requires approval,
 * instead of a generic "select" extension_ui_request, we emit a structured
 * approval.requested event and wait for approval.decide from the client.
 */
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import type { ApprovalRequest, ApprovalScope } from "./dto/approval";
import type { InteractionRequest } from "./dto/interaction";
import type { ApprovalId, InteractionId } from "./protocol/ids";
import { newApprovalId, newInteractionId } from "./protocol/ids";

// ============================================================================
// Pending request tracking
// ============================================================================

interface PendingApproval {
	approvalId: ApprovalId;
	resolve: (decision: { allowed: boolean; scope: ApprovalScope }) => void;
	reject: (error: Error) => void;
}

interface PendingInteraction {
	interactionId: InteractionId;
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
}

// ============================================================================
// Output types
// ============================================================================

type V2OutputFn = (frame: object) => void;

// ============================================================================
// RPC v2 UI Context
// ============================================================================

export class RpcV2UIContext implements ExtensionUIContext {
	#output: V2OutputFn;
	#pendingApprovals = new Map<string, PendingApproval>();
	#pendingInteractions = new Map<string, PendingInteraction>();
	#sessionId: string;
	#closedError: Error | undefined;

	constructor(options: { output: V2OutputFn; sessionId: string }) {
		this.#output = options.output;
		this.#sessionId = options.sessionId;
	}

	/** Reject all pending requests (called on disconnect). */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		for (const [, pending] of this.#pendingApprovals) pending.reject(this.#closedError);
		for (const [, pending] of this.#pendingInteractions) pending.reject(this.#closedError);
		this.#pendingApprovals.clear();
		this.#pendingInteractions.clear();
	}

	/** Resolve a pending approval from approval.decide method. */
	resolveApproval(approvalId: string, decision: { allowed: boolean; scope: ApprovalScope }): boolean {
		const pending = this.#pendingApprovals.get(approvalId);
		if (!pending) return false;
		this.#pendingApprovals.delete(approvalId);
		pending.resolve(decision);
		return true;
	}

	/** Resolve a pending interaction from interaction.respond method. */
	resolveInteraction(interactionId: string, response: unknown): boolean {
		const pending = this.#pendingInteractions.get(interactionId);
		if (!pending) return false;
		this.#pendingInteractions.delete(interactionId);
		pending.resolve(response);
		return true;
	}

	get pendingApprovalCount(): number {
		return this.#pendingApprovals.size;
	}

	get pendingInteractionCount(): number {
		return this.#pendingInteractions.size;
	}

	// =======================================================================
	// ExtensionUIContext implementation
	// =======================================================================

	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

		// Detect approval prompts (they have "Approve"/"Deny" options)
		const labels = options.map(o => (typeof o === "string" ? o : (o.label ?? String(o))));
		const isApproval = labels.includes("Approve") && labels.includes("Deny");

		if (isApproval) {
			return this.#handleApproval(title, dialogOptions);
		}

		// Generic select → interaction
		return this.#handleInteraction(
			{
				kind: "select",
				options: labels.map((label, i) => ({ id: String(i), label })),
				multiple: false,
			},
			title,
			dialogOptions,
		).then(result => {
			if (typeof result === "object" && result !== null && "optionIds" in result) {
				const ids = (result as { optionIds: string[] }).optionIds;
				return ids.length > 0 ? labels[Number.parseInt(ids[0], 10)] : undefined;
			}
			return undefined;
		});
	}

	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (dialogOptions?.signal?.aborted) return Promise.resolve(false);

		return this.#handleInteraction(
			{ kind: "confirm", confirmLabel: "Confirm", cancelLabel: "Cancel", severity: "normal" },
			title,
			dialogOptions,
			message,
		).then(result => {
			if (typeof result === "object" && result !== null && "value" in result) {
				return (result as { value: boolean }).value;
			}
			return false;
		});
	}

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

		return this.#handleInteraction({ kind: "input", placeholder, sensitive: false }, title, dialogOptions).then(
			result => {
				if (typeof result === "object" && result !== null && "value" in result) {
					return (result as { value: string }).value;
				}
				return undefined;
			},
		);
	}

	editor(title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

		return this.#handleInteraction({ kind: "editor", initialValue: prefill ?? "" }, title, dialogOptions).then(
			result => {
				if (typeof result === "object" && result !== null && "value" in result) {
					return (result as { value: string }).value;
				}
				return undefined;
			},
		);
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.#output({
			jsonrpc: "2.0",
			method: "ui.notify",
			params: { level: type ?? "info", message, source: "extension" },
		});
	}

	setStatus(_key: string, _text: string | undefined): void {
		// Presentation-only; no v2 equivalent yet
	}

	setWidget(_key: string, _content: unknown, _options?: ExtensionWidgetOptions): void {
		// Presentation-only
	}

	setTitle(_title: string): void {
		// Presentation-only
	}

	setEditorText(_text: string): void {
		// Not supported in v2 headless
	}

	pasteToEditor(_text: string): void {
		// Not supported
	}

	getEditorText(): string {
		return "";
	}

	onTerminalInput(): () => void {
		return () => {};
	}

	setWorkingMessage(_message?: string): void {}
	setFooter(_factory: unknown): void {}
	setHeader(_factory: unknown): void {}
	addAutocompleteProvider(): void {}
	setEditorComponent(): void {}
	getToolsExpanded(): boolean {
		return false;
	}
	setToolsExpanded(_expanded: boolean): void {}

	async custom(): Promise<never> {
		return undefined as never;
	}

	get theme(): Theme {
		return {} as Theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Not supported in RPC v2" });
	}

	// =======================================================================
	// Internal: Approval flow
	// =======================================================================

	#handleApproval(title: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const approvalId = newApprovalId();
		const { promise, resolve, reject } = Promise.withResolvers<{ allowed: boolean; scope: ApprovalScope }>();

		this.#pendingApprovals.set(approvalId, { approvalId, resolve, reject });

		// Abort handling
		const onAbort = () => {
			const pending = this.#pendingApprovals.get(approvalId);
			if (pending) {
				this.#pendingApprovals.delete(approvalId);
				pending.resolve({ allowed: false, scope: "once" });
			}
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

		// Emit structured approval.requested event
		const approval: ApprovalRequest = {
			schemaVersion: 1,
			approvalId,
			sessionId: this.#sessionId as never,
			runId: "" as never,
			requestAction: "tool_execute",
			createdAt: new Date().toISOString(),
			status: "pending",
			title: "Tool Approval",
			summary: title,
			risk: { tier: "write", level: "medium", irreversible: false, reasons: [] },
			targets: [],
			policySnapshot: { source: "session", effectiveDecision: "ask", canPersistRule: false },
			allowedDecisions: ["allow", "deny"],
			allowedScopes: ["once", "session"],
			fingerprint: approvalId,
			invalidation: [],
		};

		this.#output({
			jsonrpc: "2.0",
			method: "session.event",
			params: {
				schemaVersion: 1,
				eventId: `evt_${approvalId}`,
				sessionId: this.#sessionId,
				sequence: 0,
				timestamp: new Date().toISOString(),
				type: "approval.requested",
				durability: "durable",
				data: { approval },
			},
		});

		return promise.then(decision => {
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			// Emit approval.resolved
			this.#output({
				jsonrpc: "2.0",
				method: "session.event",
				params: {
					schemaVersion: 1,
					eventId: `evt_${approvalId}_resolved`,
					sessionId: this.#sessionId,
					sequence: 0,
					timestamp: new Date().toISOString(),
					type: "approval.resolved",
					durability: "durable",
					data: { approvalId, decision: decision.allowed ? "allow" : "deny", scope: decision.scope },
				},
			});
			return decision.allowed ? "Approve" : "Deny";
		});
	}

	// =======================================================================
	// Internal: Interaction flow
	// =======================================================================

	#handleInteraction(
		request: InteractionRequest["request"],
		title: string,
		dialogOptions?: ExtensionUIDialogOptions,
		prompt?: string,
	): Promise<unknown> {
		const interactionId = newInteractionId();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		this.#pendingInteractions.set(interactionId, { interactionId, resolve, reject });

		const onAbort = () => {
			const pending = this.#pendingInteractions.get(interactionId);
			if (pending) {
				this.#pendingInteractions.delete(interactionId);
				pending.resolve(undefined);
			}
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

		const interaction: InteractionRequest = {
			schemaVersion: 1,
			interactionId,
			sessionId: this.#sessionId as never,
			createdAt: new Date().toISOString(),
			status: "pending",
			source: { kind: "san", label: "San" },
			title,
			prompt,
			request,
		};

		this.#output({
			jsonrpc: "2.0",
			method: "session.event",
			params: {
				schemaVersion: 1,
				eventId: `evt_${interactionId}`,
				sessionId: this.#sessionId,
				sequence: 0,
				timestamp: new Date().toISOString(),
				type: "interaction.requested",
				durability: "durable",
				data: { interaction },
			},
		});

		return promise.finally(() => {
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
		});
	}
}
