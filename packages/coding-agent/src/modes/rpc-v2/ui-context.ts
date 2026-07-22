/**
 * San RPC v2 UI Context.
 *
 * Implements ExtensionUIContext to bridge the internal approval/interaction
 * system to structured v2 protocol events. When a tool requires approval,
 * instead of a generic "select" extension_ui_request, we emit a structured
 * approval.requested event and wait for approval.decide from the client.
 */
import type {
	ExtensionToolApprovalDecision,
	ExtensionToolApprovalRequest,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import type { ApprovalPolicyResolution } from "./approval-rules";
import { generateFingerprint } from "./approval-rules";
import type { ApprovalPolicySnapshot, ApprovalRequest, ApprovalScope, ApprovalTarget, JsonValue } from "./dto/approval";
import type { InteractionRequest } from "./dto/interaction";
import type { ApprovalId, InteractionId, RunId, SessionId, ToolCallId } from "./protocol/ids";
import { newApprovalId, newInteractionId, newRunId } from "./protocol/ids";
import { sanitizeRpcText } from "./redaction";

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
	#runId: () => RunId | undefined;
	#registerApproval?: (approval: ApprovalRequest) => Promise<void>;
	#resolveRegisteredApproval?: (approvalId: string, decision: "allow" | "deny", scope: ApprovalScope) => Promise<void>;
	#resolveApprovalPolicy?: (params: {
		fingerprint: string;
		tier: "read" | "write" | "exec";
		requestOverride: boolean;
		canPersistRule: boolean;
	}) => ApprovalPolicyResolution | Promise<ApprovalPolicyResolution>;
	#registerInteraction?: (interaction: InteractionRequest) => Promise<void>;
	#sequence = 0;
	#closedError: Error | undefined;

	constructor(options: {
		output: V2OutputFn;
		sessionId: string;
		runId?: () => RunId | undefined;
		registerApproval?: (approval: ApprovalRequest) => Promise<void>;
		resolveRegisteredApproval?: (
			approvalId: string,
			decision: "allow" | "deny",
			scope: ApprovalScope,
		) => Promise<void>;
		resolveApprovalPolicy?: (params: {
			fingerprint: string;
			tier: "read" | "write" | "exec";
			requestOverride: boolean;
			canPersistRule: boolean;
		}) => ApprovalPolicyResolution | Promise<ApprovalPolicyResolution>;
		registerInteraction?: (interaction: InteractionRequest) => Promise<void>;
	}) {
		this.#output = options.output;
		this.#sessionId = options.sessionId;
		this.#runId = options.runId ?? (() => undefined);
		this.#registerApproval = options.registerApproval;
		this.#resolveRegisteredApproval = options.resolveRegisteredApproval;
		this.#resolveApprovalPolicy = options.resolveApprovalPolicy;
		this.#registerInteraction = options.registerInteraction;
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

	/** 取消一个仍由当前进程等待的 Interaction。 */
	cancelInteraction(interactionId: string): boolean {
		const pending = this.#pendingInteractions.get(interactionId);
		if (!pending) return false;
		this.#pendingInteractions.delete(interactionId);
		pending.resolve(undefined);
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

		const labels = options.map(o => (typeof o === "string" ? o : (o.label ?? String(o))));

		// 所有普通选择都通过 typed Interaction；审批走 requestToolApproval。
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

	requestToolApproval(
		request: ExtensionToolApprovalRequest,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionToolApprovalDecision> {
		if (this.#closedError) return Promise.reject(this.#closedError);
		if (dialogOptions?.signal?.aborted) return Promise.resolve({ allowed: false, scope: "once" });
		return this.#handleApproval(request, dialogOptions);
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

	async #handleApproval(
		request: ExtensionToolApprovalRequest,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionToolApprovalDecision> {
		const approvalId = newApprovalId();
		const redactedArguments = redactJsonValue(request.arguments);
		const irreversible = request.tier === "exec";
		const canPersistRule = !request.requestOverride && !irreversible && redactedArguments.redactedPaths.length === 0;
		const allowedScopes: ApprovalScope[] = canPersistRule ? ["once", "session", "workspace", "global"] : ["once"];
		const fingerprint = generateFingerprint({
			requestAction: "tool_execute",
			toolName: request.toolName,
			operationKind: request.tier,
			targetCanonical: stableSerializeJson(redactedArguments.value),
			riskTier: request.tier,
			workspaceRoot: request.cwd,
		});
		const policyResolution = await this.#resolveApprovalPolicy?.({
			fingerprint,
			tier: request.tier,
			requestOverride: request.requestOverride,
			canPersistRule,
		});
		const policySnapshot: ApprovalPolicySnapshot = policyResolution?.snapshot ?? {
			source: request.requestOverride ? "request_override" : "session",
			effectiveDecision: "ask",
			canPersistRule,
			...(!canPersistRule ? { rationale: "This request is restricted to a one-time decision" } : {}),
		};
		const approval: ApprovalRequest = {
			schemaVersion: 1,
			approvalId,
			sessionId: this.#sessionId as SessionId,
			runId: this.#runId() ?? newRunId(),
			toolCallId: request.toolCallId as ToolCallId,
			requestAction: "tool_execute",
			createdAt: new Date().toISOString(),
			status: "pending",
			title: `Approve ${request.toolName}`,
			summary: sanitizeApprovalText(request.prompt),
			risk: {
				tier: request.tier,
				level: request.tier === "exec" ? "high" : request.tier === "write" ? "medium" : "low",
				irreversible,
				reasons: request.reason ? [sanitizeApprovalText(request.reason)] : [],
			},
			tool: {
				name: request.toolName,
				label: request.toolName,
				operationKind: request.tier,
				arguments: redactedArguments,
				argumentsSummary: `${request.toolName} (${request.tier})`,
				cwd: request.cwd,
			},
			targets: extractApprovalTargets(redactedArguments.value, request.cwd),
			policySnapshot,
			allowedDecisions: ["allow", "deny"],
			allowedScopes,
			fingerprint,
			invalidation: [],
		};

		if (policySnapshot.effectiveDecision !== "ask") {
			const decision = policySnapshot.effectiveDecision;
			const scope = policyResolution?.scope ?? "once";
			await this.#emitApprovalRequested(approval);
			await this.#emitApprovalResolved(approval, decision, scope);
			return { allowed: decision === "allow", scope };
		}

		const { promise, resolve, reject } = Promise.withResolvers<{ allowed: boolean; scope: ApprovalScope }>();
		this.#pendingApprovals.set(approvalId, { approvalId, resolve, reject });

		const onAbort = () => {
			const pending = this.#pendingApprovals.get(approvalId);
			if (pending) {
				this.#pendingApprovals.delete(approvalId);
				pending.resolve({ allowed: false, scope: "once" });
			}
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await this.#emitApprovalRequested(approval);
		} catch (error: unknown) {
			this.#pendingApprovals.delete(approvalId);
			reject(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}

		return promise.then(decision => {
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			// 注册到 Session 事实层时，resolved 事件由 SessionManager 统一发出。
			if (!this.#registerApproval)
				this.#output({
					jsonrpc: "2.0",
					method: "session.event",
					params: {
						schemaVersion: 1,
						eventId: `evt_${approvalId}_resolved`,
						sessionId: this.#sessionId,
						sequence: ++this.#sequence,
						timestamp: new Date().toISOString(),
						type: "approval.resolved",
						durability: "durable",
						data: { approvalId, decision: decision.allowed ? "allow" : "deny", scope: decision.scope },
					},
				});
			return decision;
		});
	}

	async #emitApprovalRequested(approval: ApprovalRequest): Promise<void> {
		if (this.#registerApproval) {
			await this.#registerApproval(approval);
			return;
		}
		this.#output({
			jsonrpc: "2.0",
			method: "session.event",
			params: {
				schemaVersion: 1,
				eventId: `evt_${approval.approvalId}`,
				sessionId: this.#sessionId,
				sequence: ++this.#sequence,
				timestamp: new Date().toISOString(),
				type: "approval.requested",
				durability: "durable",
				data: { approval },
			},
		});
	}

	async #emitApprovalResolved(
		approval: ApprovalRequest,
		decision: "allow" | "deny",
		scope: ApprovalScope,
	): Promise<void> {
		if (this.#resolveRegisteredApproval) {
			await this.#resolveRegisteredApproval(approval.approvalId, decision, scope);
			return;
		}
		if (this.#registerApproval) {
			throw new Error("RPC v2 approval resolver is not configured");
		}
		this.#output({
			jsonrpc: "2.0",
			method: "session.event",
			params: {
				schemaVersion: 1,
				eventId: `evt_${approval.approvalId}_resolved`,
				sessionId: this.#sessionId,
				sequence: ++this.#sequence,
				timestamp: new Date().toISOString(),
				type: "approval.resolved",
				durability: "durable",
				data: { approvalId: approval.approvalId, decision, scope, persistedRule: false },
			},
		});
	}

	// =======================================================================
	// Internal: Interaction flow
	// =======================================================================

	async #handleInteraction(
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

		if (this.#registerInteraction) {
			try {
				await this.#registerInteraction(interaction);
			} catch (error: unknown) {
				this.#pendingInteractions.delete(interactionId);
				reject(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		} else
			this.#output({
				jsonrpc: "2.0",
				method: "session.event",
				params: {
					schemaVersion: 1,
					eventId: `evt_${interactionId}`,
					sessionId: this.#sessionId,
					sequence: ++this.#sequence,
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

const SECRET_FIELD =
	/(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)/iu;

function redactJsonValue(value: Record<string, unknown>): { value: JsonValue; redactedPaths: string[] } {
	const redactedPaths: string[] = [];
	const visit = (item: unknown, path: string): JsonValue => {
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "string") {
			const sanitized = sanitizeRpcText(item, { maxChars: 10_000, redactPaths: false, trim: false });
			if (sanitized !== item) redactedPaths.push(path || "value");
			return sanitized;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new Error(`${path || "tool arguments"} contains a non-finite number`);
			return item;
		}
		if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}[${index}]`));
		if (typeof item === "object") {
			const result: { [key: string]: JsonValue } = {};
			for (const [key, child] of Object.entries(item)) {
				if (child === undefined) continue;
				const childPath = path ? `${path}.${key}` : key;
				if (SECRET_FIELD.test(key)) {
					result[key] = "[REDACTED]";
					redactedPaths.push(childPath);
				} else {
					result[key] = visit(child, childPath);
				}
			}
			return result;
		}
		throw new Error(`${path || "tool arguments"} contains unsupported ${typeof item} value`);
	};
	return { value: visit(value, ""), redactedPaths };
}

function sanitizeApprovalText(value: string): string {
	return sanitizeRpcText(value, { maxChars: 2_000, redactPaths: false });
}

function stableSerializeJson(value: JsonValue): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(stableSerializeJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableSerializeJson(value[key]!)}`)
		.join(",")}}`;
}

function extractApprovalTargets(value: JsonValue, cwd?: string): ApprovalTarget[] {
	if (value === null || Array.isArray(value) || typeof value !== "object") return [];
	const targets: ApprovalTarget[] = [];
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string" || item === "[REDACTED]") continue;
		if (/^(?:command|cmd)$/iu.test(key)) {
			targets.push({ kind: "command", display: sanitizeApprovalText(item), canonical: item });
		} else if (/(?:url|uri)$/iu.test(key)) {
			targets.push({ kind: "url", display: sanitizeApprovalText(item), canonical: item });
		} else if (/(?:resourceId|resource)$/iu.test(key)) {
			targets.push({ kind: "resource", display: sanitizeApprovalText(item), canonical: item });
		} else if (/(?:path|file|directory|cwd|destination|source)$/iu.test(key)) {
			const canonical = cwd && !item.startsWith("/") ? `${cwd.replace(/\/$/u, "")}/${item}` : item;
			targets.push({ kind: "path", display: sanitizeApprovalText(item), canonical });
		}
		if (targets.length >= 16) break;
	}
	return targets;
}
