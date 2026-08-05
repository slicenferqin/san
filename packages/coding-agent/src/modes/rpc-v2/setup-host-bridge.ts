/**
 * Worktree setup → Desktop ProcessHost 桥接。
 *
 * 经 San 侧 host_action 审批后，用 RpcV2HostToolBridge.invokeHostAction
 * 调用冻结的 desktop.action.start.v1 / stop.v1；不经过 Agent tool_execute 路径。
 */
import { Snowflake } from "@san/utils";
import type { RpcV2HostToolBridge } from "./host-tool-bridge";
import { isHostRequestError } from "./host-tool-bridge";
import type { HostActionApprovalDecision, RpcV2UIContext } from "./ui-context";
import { WorktreeError } from "./worktree-lifecycle";

/** 冻结的 Desktop Action host tool 名。 */
export const DESKTOP_ACTION_START_TOOL = "desktop.action.start.v1";
export const DESKTOP_ACTION_STOP_TOOL = "desktop.action.stop.v1";

/** setupHost 注入到 WorktreeLifecycleService（或 mode 侧拦截）的契约。 */
export interface WorktreeSetupHost {
	readonly ready: boolean;
	start(input: WorktreeSetupHostStartInput): Promise<WorktreeSetupHostStartResult>;
	cancel(input: WorktreeSetupHostCancelInput): Promise<WorktreeSetupHostCancelResult>;
}

export interface WorktreeSetupHostStartInput {
	worktreeId: string;
	environmentId: string;
	/**
	 * ManagedWorktree 冻结 pathRef（san-worktree-path://v1/...）。
	 * 这是 Desktop environment cwd 权威源；禁止用 displayPath 代替。
	 */
	pathRef?: string;
	/** 仅审批/诊断展示；不作为 spawn cwd 权威源。 */
	displayPath?: string;
	/** Desktop action 身份。 */
	setupActionId: string;
	actionRevision?: number;
	operationId: string;
	idempotencyKey: string;
	/** 可选 abort；取消审批或请求中止时触发。 */
	signal?: AbortSignal;
}

export interface WorktreeSetupHostStartResult {
	processId?: string;
	processRevision?: number;
	status: string;
	requestId?: string;
	approvalId?: string;
}

export interface WorktreeSetupHostCancelInput {
	worktreeId: string;
	operationId?: string;
	processId?: string;
	/** stop 需要的 revision；缺省 0。 */
	expectedRevision?: number;
	idempotencyKey: string;
	signal?: AbortSignal;
}

export interface WorktreeSetupHostCancelResult {
	cancelled: boolean;
	status: string;
}

export interface SetupHostBridgeOptions {
	hostToolBridge: RpcV2HostToolBridge;
	/** 当前 Session UI context（审批入口）；无 Session 时返回 undefined。 */
	getUIContext: () => RpcV2UIContext | undefined;
	/** 显式身份：session/run 必须可追踪；缺省拒绝。 */
	resolveIdentity: () => { sessionId?: string; runId?: string } | undefined;
	/** host.tool.invoke 时透传的 capability revision。 */
	getCapabilityRevision?: () => number | undefined;
	/** 是否已完成 durable recovery（ensureLoaded）。 */
	isRecoveryReady: () => boolean;
	/** 默认 action revision。 */
	defaultActionRevision?: number;
}

interface BoundSetupProcess {
	worktreeId: string;
	processId: string;
	processRevision: number;
	operationId: string;
	toolCallId: string;
	environmentId: string;
	actionId: string;
}

/**
 * 真实 setupHost：审批 → invokeHostAction(start/stop)。
 * ready 仅当 start+stop 工具已注册且 recovery 就绪。
 */
export class DesktopActionSetupHost implements WorktreeSetupHost {
	readonly #bridge: RpcV2HostToolBridge;
	readonly #getUIContext: () => RpcV2UIContext | undefined;
	readonly #resolveIdentity: () => { sessionId?: string; runId?: string } | undefined;
	readonly #getCapabilityRevision?: () => number | undefined;
	readonly #isRecoveryReady: () => boolean;
	readonly #defaultActionRevision: number;
	/** worktreeId → 绑定进程（cancel 目标）。 */
	readonly #bound = new Map<string, BoundSetupProcess>();

	constructor(options: SetupHostBridgeOptions) {
		this.#bridge = options.hostToolBridge;
		this.#getUIContext = options.getUIContext;
		this.#resolveIdentity = options.resolveIdentity;
		this.#getCapabilityRevision = options.getCapabilityRevision;
		this.#isRecoveryReady = options.isRecoveryReady;
		this.#defaultActionRevision = options.defaultActionRevision ?? 1;
	}

	get ready(): boolean {
		return this.#isRecoveryReady() && this.#hasRequiredTools();
	}

	/** 供 capability 判定：工具是否齐全（不要求 recovery）。 */
	hasRequiredTools(): boolean {
		return this.#hasRequiredTools();
	}

	async start(input: WorktreeSetupHostStartInput): Promise<WorktreeSetupHostStartResult> {
		this.#assertReady(input.worktreeId, "setup.start");
		const actionId = input.setupActionId?.trim();
		if (!actionId) {
			throw new WorktreeError("INVALID_PARAMS", "setupActionId is required for setup.start", {
				feature: "setup",
				worktreeId: input.worktreeId,
			});
		}
		const actionRevision = input.actionRevision ?? this.#defaultActionRevision;
		const identity = this.#requireIdentity(input.worktreeId);
		const toolCallId = `host_action_setup_${Snowflake.next()}`;
		// setup action 非交互：显式 closed，禁止省略造成 Host 侧语义漂移
		const stdinMode = "closed" as const;
		const pathRef =
			typeof input.pathRef === "string" && input.pathRef.trim().length > 0 ? input.pathRef.trim() : undefined;
		// pathRef 进入 host arguments + 审批指纹；displayPath 仅展示，永不作为 spawn 权威。
		const args: Record<string, unknown> = {
			actionId,
			actionRevision,
			environmentId: input.environmentId,
			idempotencyKey: input.idempotencyKey,
			stdinMode,
			...(pathRef ? { pathRef } : {}),
		};
		const fingerprintTarget: Record<string, unknown> = {
			worktreeId: input.worktreeId,
			environmentId: input.environmentId,
			actionId,
			actionRevision,
			...(pathRef ? { pathRef } : {}),
		};

		const decision = await this.#approve({
			toolCallId,
			toolName: DESKTOP_ACTION_START_TOOL,
			label: "Worktree setup",
			prompt: `Start worktree setup action "${actionId}" for ${input.worktreeId}`,
			reason: "Executes a configured Desktop ProcessHost action in the worktree environment",
			arguments: args,
			fingerprintTarget,
			cwd: input.displayPath,
			runId: identity.runId,
			signal: input.signal,
		});

		if (!decision.allowed) {
			throw new WorktreeError("PRECONDITION_FAILED", "setup.start was denied by approval", {
				feature: "setup",
				worktreeId: input.worktreeId,
				approvalId: decision.approvalId,
				decision: "deny",
			});
		}

		let result: unknown;
		try {
			result = await this.#bridge.invokeHostAction(DESKTOP_ACTION_START_TOOL, args, {
				identity: {
					sessionId: identity.sessionId,
					runId: identity.runId,
					toolCallId,
				},
				signal: input.signal,
				...(this.#getCapabilityRevision ? { capabilityRevision: this.#getCapabilityRevision() } : {}),
			});
		} catch (error: unknown) {
			throw this.#mapHostError(error, input.worktreeId, "setup.start");
		}

		const processId = readProcessId(result);
		const processRevision = readProcessRevision(result) ?? 0;
		if (processId) {
			this.#bound.set(input.worktreeId, {
				worktreeId: input.worktreeId,
				processId,
				processRevision,
				operationId: input.operationId,
				toolCallId,
				environmentId: input.environmentId,
				actionId,
			});
		}

		return {
			...(processId ? { processId } : {}),
			...(processRevision !== undefined ? { processRevision } : {}),
			status: processId ? "started" : "accepted",
			requestId: toolCallId,
			approvalId: decision.approvalId,
		};
	}

	async cancel(input: WorktreeSetupHostCancelInput): Promise<WorktreeSetupHostCancelResult> {
		this.#assertReady(input.worktreeId, "setup.cancel");
		const bound = this.#bound.get(input.worktreeId);
		const processId = input.processId ?? bound?.processId;
		if (!processId) {
			throw new WorktreeError("PRECONDITION_FAILED", "setup.cancel requires a bound processId for this worktree", {
				feature: "setup",
				worktreeId: input.worktreeId,
				available: true,
			});
		}
		const expectedRevision = input.expectedRevision ?? bound?.processRevision ?? 0;
		const identity = this.#requireIdentity(input.worktreeId);
		const toolCallId = `host_action_setup_cancel_${Snowflake.next()}`;
		const args = {
			processId,
			expectedRevision,
			idempotencyKey: input.idempotencyKey,
		};
		const fingerprintTarget = {
			worktreeId: input.worktreeId,
			processId,
			expectedRevision,
			operationId: input.operationId ?? bound?.operationId ?? null,
		};

		const decision = await this.#approve({
			toolCallId,
			toolName: DESKTOP_ACTION_STOP_TOOL,
			label: "Cancel worktree setup",
			prompt: `Stop setup process ${processId} for ${input.worktreeId}`,
			reason: "Stops the Desktop ProcessHost process tree bound to this setup",
			arguments: args,
			fingerprintTarget,
			runId: identity.runId,
			signal: input.signal,
		});

		if (!decision.allowed) {
			throw new WorktreeError("PRECONDITION_FAILED", "setup.cancel was denied by approval", {
				feature: "setup",
				worktreeId: input.worktreeId,
				approvalId: decision.approvalId,
				decision: "deny",
				processId,
			});
		}

		try {
			await this.#bridge.invokeHostAction(DESKTOP_ACTION_STOP_TOOL, args, {
				identity: {
					sessionId: identity.sessionId,
					runId: identity.runId,
					toolCallId,
				},
				signal: input.signal,
				...(this.#getCapabilityRevision ? { capabilityRevision: this.#getCapabilityRevision() } : {}),
			});
		} catch (error: unknown) {
			throw this.#mapHostError(error, input.worktreeId, "setup.cancel");
		}

		this.#bound.delete(input.worktreeId);
		return { cancelled: true, status: "cancelled" };
	}

	/** 测试/诊断：当前绑定的 process。 */
	getBoundProcess(worktreeId: string): BoundSetupProcess | undefined {
		const bound = this.#bound.get(worktreeId);
		return bound ? { ...bound } : undefined;
	}

	#hasRequiredTools(): boolean {
		const tools = new Set(this.#bridge.registeredTools);
		return tools.has(DESKTOP_ACTION_START_TOOL) && tools.has(DESKTOP_ACTION_STOP_TOOL);
	}

	#assertReady(worktreeId: string, op: string): void {
		if (!this.#isRecoveryReady()) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", `${op} requires worktree recovery to be ready`, {
				feature: "setup",
				available: false,
				worktreeId,
				reason: "recovery_not_ready",
			});
		}
		if (!this.#hasRequiredTools()) {
			throw new WorktreeError(
				"CAPABILITY_UNAVAILABLE",
				`${op} requires registered ${DESKTOP_ACTION_START_TOOL} and ${DESKTOP_ACTION_STOP_TOOL}`,
				{
					feature: "setup",
					available: false,
					worktreeId,
					requiredTools: [DESKTOP_ACTION_START_TOOL, DESKTOP_ACTION_STOP_TOOL],
					registeredTools: this.#bridge.registeredTools,
				},
			);
		}
	}

	#requireIdentity(worktreeId: string): { sessionId: string; runId: string } {
		const identity = this.#resolveIdentity();
		if (!identity?.sessionId || !identity.runId) {
			throw new WorktreeError(
				"CAPABILITY_UNAVAILABLE",
				"setup host-action requires an active Session and Run identity",
				{
					feature: "setup",
					available: false,
					worktreeId,
					hasSessionId: Boolean(identity?.sessionId),
					hasRunId: Boolean(identity?.runId),
				},
			);
		}
		return { sessionId: identity.sessionId, runId: identity.runId };
	}

	async #approve(params: {
		toolCallId: string;
		toolName: string;
		label: string;
		prompt: string;
		reason: string;
		arguments: Record<string, unknown>;
		fingerprintTarget: Record<string, unknown>;
		cwd?: string;
		runId: string;
		signal?: AbortSignal;
	}): Promise<HostActionApprovalDecision> {
		const ui = this.#getUIContext();
		if (!ui) {
			throw new WorktreeError(
				"CAPABILITY_UNAVAILABLE",
				"setup host-action approval requires an active Session UI context",
				{ feature: "setup", available: false, toolName: params.toolName },
			);
		}
		return ui.requestHostActionApproval(
			{
				toolCallId: params.toolCallId,
				toolName: params.toolName,
				label: params.label,
				prompt: params.prompt,
				reason: params.reason,
				arguments: params.arguments,
				fingerprintTarget: params.fingerprintTarget,
				cwd: params.cwd,
				runId: params.runId,
			},
			params.signal ? { signal: params.signal } : undefined,
		);
	}

	#mapHostError(error: unknown, worktreeId: string, op: string): WorktreeError {
		if (error instanceof WorktreeError) return error;
		if (isHostRequestError(error)) {
			const reason = error.reason;
			const details = error.details;
			const dispatchedWithoutTerminalResult =
				reason === "OUTCOME_UNKNOWN" ||
				(reason === "HOST_TOOL_FAILED" &&
					details?.abortedBeforeDispatch !== true &&
					(details?.closed === true || typeof details?.requestId === "string"));
			if (dispatchedWithoutTerminalResult) {
				return new WorktreeError("OUTCOME_UNKNOWN", error.message, {
					feature: "setup",
					worktreeId,
					op,
					hostReason: reason,
					hostCategory: error.category,
					hostRetryable: error.retryable,
					correlationId: error.correlationId,
					...(details ?? {}),
				});
			}
			if (reason === "HOST_CAPABILITY_UNAVAILABLE" || reason === "CAPABILITY_UNAVAILABLE") {
				return new WorktreeError("CAPABILITY_UNAVAILABLE", error.message, {
					feature: "setup",
					available: false,
					worktreeId,
					op,
					hostReason: reason,
					...(error.details ?? {}),
				});
			}
			return new WorktreeError("INTERNAL", error.message, {
				feature: "setup",
				worktreeId,
				op,
				hostReason: reason,
				...(error.details ?? {}),
			});
		}
		const message = error instanceof Error ? error.message : String(error);
		return new WorktreeError("INTERNAL", `${op} host invoke failed: ${message}`, {
			feature: "setup",
			worktreeId,
			op,
		});
	}
}

function readProcessId(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const details = isRecord(result.details) ? result.details : undefined;
	if (typeof details?.processId === "string" && details.processId.length > 0) return details.processId;
	if (typeof result.processId === "string" && result.processId.length > 0) return result.processId;
	// AgentToolResult text 不解析为业务状态；仅 structured details。
	return undefined;
}

function readProcessRevision(result: unknown): number | undefined {
	if (!isRecord(result)) return undefined;
	const details = isRecord(result.details) ? result.details : undefined;
	const rev = details?.revision ?? details?.processRevision ?? result.revision;
	return typeof rev === "number" && Number.isSafeInteger(rev) ? rev : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
