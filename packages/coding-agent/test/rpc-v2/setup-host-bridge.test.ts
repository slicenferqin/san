/**
 * Focused tests: worktree setup host-action bridge + host_action approval.
 */
import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "../../src/modes/rpc-v2/dto/approval";
import { RpcV2HostToolBridge } from "../../src/modes/rpc-v2/host-tool-bridge";
import type { RunId } from "../../src/modes/rpc-v2/protocol/ids";
import {
	DESKTOP_ACTION_START_TOOL,
	DESKTOP_ACTION_STOP_TOOL,
	DesktopActionSetupHost,
} from "../../src/modes/rpc-v2/setup-host-bridge";
import { RpcV2UIContext } from "../../src/modes/rpc-v2/ui-context";
import { WorktreeError } from "../../src/modes/rpc-v2/worktree-lifecycle";

type OutFrame = {
	jsonrpc?: string;
	id?: string;
	method?: string;
	params?: Record<string, unknown>;
};

function createHarness(options?: { registerTools?: boolean; recoveryReady?: boolean }) {
	const frames: OutFrame[] = [];
	const approvals: ApprovalRequest[] = [];
	const bridge = new RpcV2HostToolBridge(
		frame => {
			frames.push(frame as OutFrame);
		},
		() => ({ sessionId: "ses_agent", runId: "run_agent" }),
		{ maxPayloadBytes: 64 * 1024 },
	);
	if (options?.registerTools !== false) {
		bridge.setTools([
			{
				name: DESKTOP_ACTION_START_TOOL,
				description: "start",
				parameters: {
					type: "object",
					properties: {
						actionId: { type: "string" },
						actionRevision: { type: "integer" },
						environmentId: { type: "string" },
						idempotencyKey: { type: "string" },
						stdinMode: { type: "string", enum: ["closed", "interactive"] },
						pathRef: { type: "string" },
					},
					required: ["actionId", "actionRevision", "environmentId", "idempotencyKey"],
					additionalProperties: false,
				},
			},
			{
				name: DESKTOP_ACTION_STOP_TOOL,
				description: "stop",
				parameters: {
					type: "object",
					properties: {
						processId: { type: "string" },
						expectedRevision: { type: "integer" },
						idempotencyKey: { type: "string" },
					},
					required: ["processId", "expectedRevision", "idempotencyKey"],
					additionalProperties: false,
				},
			},
		]);
	}

	const ui = new RpcV2UIContext({
		output: frame => {
			frames.push(frame as OutFrame);
		},
		sessionId: "ses_setup",
		runId: () => "run_setup" as RunId,
		// 同步登记，便于测试在微任务边界观察 pending 审批
		registerApproval: approval => {
			approvals.push(approval);
			return Promise.resolve();
		},
		resolveRegisteredApproval: async () => undefined,
	});

	const setupHost = new DesktopActionSetupHost({
		hostToolBridge: bridge,
		getUIContext: () => ui,
		resolveIdentity: () => ({ sessionId: "ses_setup", runId: "run_setup" }),
		getCapabilityRevision: () => 3,
		isRecoveryReady: () => options?.recoveryReady !== false,
	});

	return { bridge, frames, approvals, ui, setupHost };
}

function hostInvokeFrames(frames: OutFrame[]): OutFrame[] {
	return frames.filter(frame => frame.method === "host.tool.invoke" && typeof frame.id === "string");
}

/** 推进微任务直到条件成立（无 wall-clock sleep）。 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function waitForApprovals(approvals: ApprovalRequest[], minCount: number): Promise<void> {
	await waitUntil(() => approvals.length >= minCount, `approvals>=${minCount}`);
}

async function waitForHostInvoke(frames: OutFrame[], minCount = 1): Promise<OutFrame[]> {
	await waitUntil(() => hostInvokeFrames(frames).length >= minCount, `host.tool.invoke>=${minCount}`);
	return hostInvokeFrames(frames);
}

describe("setup host-action bridge", () => {
	test("host_action approval uses requestAction host_action, exec, once-only, stable fingerprint", async () => {
		const { ui, approvals } = createHarness();
		const pending = ui.requestHostActionApproval({
			toolCallId: "host_action_1",
			toolName: DESKTOP_ACTION_START_TOOL,
			prompt: "Start setup",
			arguments: {
				actionId: "bootstrap",
				actionRevision: 2,
				environmentId: "env_1",
				idempotencyKey: "k1",
			},
			fingerprintTarget: {
				worktreeId: "wt_1",
				environmentId: "env_1",
				actionId: "bootstrap",
				actionRevision: 2,
			},
		});

		await waitForApprovals(approvals, 1);
		const approval = approvals[0]!;
		expect(approval.requestAction).toBe("host_action");
		expect(approval.risk.tier).toBe("exec");
		expect(approval.risk.level).toBe("high");
		expect(approval.allowedScopes).toEqual(["once"]);
		expect(approval.policySnapshot.canPersistRule).toBe(false);
		expect(approval.fingerprint.startsWith("sha256:")).toBe(true);
		expect(approval.tool?.name).toBe(DESKTOP_ACTION_START_TOOL);

		const pendingSame = ui.requestHostActionApproval({
			toolCallId: "host_action_2",
			toolName: DESKTOP_ACTION_START_TOOL,
			prompt: "Start setup again",
			arguments: {
				actionId: "bootstrap",
				actionRevision: 2,
				environmentId: "env_1",
				idempotencyKey: "k-other",
			},
			fingerprintTarget: {
				worktreeId: "wt_1",
				environmentId: "env_1",
				actionId: "bootstrap",
				actionRevision: 2,
			},
		});
		await waitForApprovals(approvals, 2);
		expect(approvals[1]!.fingerprint).toBe(approval.fingerprint);

		ui.resolveApproval(approval.approvalId, { allowed: true, scope: "once" });
		ui.resolveApproval(approvals[1]!.approvalId, { allowed: true, scope: "once" });
		const first = await pending;
		const second = await pendingSame;
		expect(first.allowed).toBe(true);
		expect(first.scope).toBe("once");
		expect(first.fingerprint).toBe(approval.fingerprint);
		expect(second.fingerprint).toBe(approval.fingerprint);
	});

	test("denied setup never invokes Desktop host.tool.invoke", async () => {
		const { setupHost, frames, approvals, ui } = createHarness();
		const startPromise = setupHost.start({
			worktreeId: "wt_deny",
			environmentId: "env_1",
			setupActionId: "bootstrap",
			actionRevision: 1,
			operationId: "op_1",
			idempotencyKey: "deny-1",
		});

		await waitForApprovals(approvals, 1);
		expect(approvals[0]!.requestAction).toBe("host_action");
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: false, scope: "once" });

		let err: unknown;
		try {
			await startPromise;
		} catch (error) {
			err = error;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect(hostInvokeFrames(frames)).toHaveLength(0);
	});

	test("allowed setup invokes desktop.action.start.v1 once with explicit identity", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const pathRef = "san-worktree-path://v1/env_allow/2f746d702f6d616e616765642f776f726b74726565732f77745f616c6c6f77";
		const startPromise = setupHost.start({
			worktreeId: "wt_allow",
			environmentId: "env_allow",
			setupActionId: "bootstrap",
			actionRevision: 4,
			operationId: "op_allow",
			idempotencyKey: "allow-1",
			pathRef,
			displayPath: "/tmp/wt",
		});

		await waitForApprovals(approvals, 1);
		expect(approvals[0]!.tool?.arguments.value).toMatchObject({
			actionId: "bootstrap",
			actionRevision: 4,
			environmentId: "env_allow",
			idempotencyKey: "allow-1",
			stdinMode: "closed",
			pathRef,
		});
		// displayPath 仅审批展示，不得进入 host arguments。
		expect(approvals[0]!.tool?.arguments.value).not.toHaveProperty("displayPath");
		expect(approvals[0]!.tool?.arguments.value).not.toHaveProperty("cwd");
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "session" });

		const invokes = await waitForHostInvoke(frames, 1);
		expect(invokes).toHaveLength(1);
		expect(invokes[0]!.params).toMatchObject({
			sessionId: "ses_setup",
			runId: "run_setup",
			toolName: DESKTOP_ACTION_START_TOOL,
			capabilityRevision: 3,
			arguments: {
				actionId: "bootstrap",
				actionRevision: 4,
				environmentId: "env_allow",
				idempotencyKey: "allow-1",
				stdinMode: "closed",
				pathRef,
			},
		});
		expect(invokes[0]!.params?.sessionId).not.toBe("ses_agent");
		expect(typeof invokes[0]!.params?.toolCallId).toBe("string");
		const invokeArgs = invokes[0]!.params?.arguments as Record<string, unknown>;
		expect(invokeArgs).not.toHaveProperty("displayPath");
		expect(invokeArgs).not.toHaveProperty("cwd");

		bridge.handleResult(invokes[0]!.id!, {
			content: [{ type: "text", text: "started" }],
			details: { processId: "proc_allow", revision: 7 },
		});
		const result = await startPromise;
		expect(result.processId).toBe("proc_allow");
		expect(result.processRevision).toBe(7);
		expect(result.status).toBe("started");
		expect(setupHost.getBoundProcess("wt_allow")?.processId).toBe("proc_allow");
		expect(hostInvokeFrames(frames)).toHaveLength(1);
	});

	test("setup pathRef is bound into approval fingerprint and host arguments", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const pathRefA = "san-worktree-path://v1/env_fp/2f746d702f6d616e616765642f776f726b74726565732f77745f61";
		const pathRefB = "san-worktree-path://v1/env_fp/2f746d702f6d616e616765642f776f726b74726565732f77745f62";

		const firstPromise = setupHost.start({
			worktreeId: "wt_fp",
			environmentId: "env_fp",
			setupActionId: "bootstrap",
			actionRevision: 1,
			operationId: "op_fp_1",
			idempotencyKey: "fp-1",
			pathRef: pathRefA,
			displayPath: "/forged/display/a",
		});
		await waitForApprovals(approvals, 1);
		const fingerprintA = approvals[0]!.fingerprint;
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "once" });
		const firstInvokes = await waitForHostInvoke(frames, 1);
		expect(firstInvokes[0]!.params?.arguments).toMatchObject({ pathRef: pathRefA });
		bridge.handleResult(firstInvokes[0]!.id!, {
			content: [{ type: "text", text: "ok" }],
			details: { processId: "proc_fp_a", revision: 1 },
		});
		await firstPromise;

		const secondPromise = setupHost.start({
			worktreeId: "wt_fp",
			environmentId: "env_fp",
			setupActionId: "bootstrap",
			actionRevision: 1,
			operationId: "op_fp_2",
			idempotencyKey: "fp-2",
			pathRef: pathRefB,
			displayPath: "/forged/display/a",
		});
		await waitForApprovals(approvals, 2);
		// 同 action/identity 但 pathRef 不同 → 指纹必须变化，防止 displayPath 伪装。
		expect(approvals[1]!.fingerprint).not.toBe(fingerprintA);
		expect(approvals[1]!.tool?.arguments.value).toMatchObject({ pathRef: pathRefB });
		ui.resolveApproval(approvals[1]!.approvalId, { allowed: false, scope: "once" });
		await expect(secondPromise).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("setup without pathRef omits field and never sends displayPath as cwd authority", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const startPromise = setupHost.start({
			worktreeId: "wt_nopath",
			environmentId: "env_nopath",
			setupActionId: "bootstrap",
			actionRevision: 1,
			operationId: "op_nopath",
			idempotencyKey: "nopath-1",
			displayPath: "/should/not/become/cwd",
		});
		await waitForApprovals(approvals, 1);
		expect(approvals[0]!.tool?.arguments.value).not.toHaveProperty("pathRef");
		expect(approvals[0]!.tool?.arguments.value).not.toHaveProperty("displayPath");
		expect(approvals[0]!.tool?.arguments.value).not.toHaveProperty("cwd");
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "once" });
		const invokes = await waitForHostInvoke(frames, 1);
		const args = invokes[0]!.params?.arguments as Record<string, unknown>;
		expect(args).not.toHaveProperty("pathRef");
		expect(args).not.toHaveProperty("displayPath");
		expect(args).not.toHaveProperty("cwd");
		bridge.handleResult(invokes[0]!.id!, {
			content: [{ type: "text", text: "ok" }],
			details: { processId: "proc_nopath", revision: 1 },
		});
		await startPromise;
	});

	test("cancel targets the bound process via desktop.action.stop.v1", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const startPromise = setupHost.start({
			worktreeId: "wt_cancel",
			environmentId: "env_c",
			setupActionId: "bootstrap",
			operationId: "op_c",
			idempotencyKey: "start-c",
		});
		await waitForApprovals(approvals, 1);
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "once" });
		const startInvokes = await waitForHostInvoke(frames, 1);
		bridge.handleResult(startInvokes[0]!.id!, {
			content: [{ type: "text", text: "ok" }],
			details: { processId: "proc_bound", revision: 2 },
		});
		await startPromise;

		const cancelPromise = setupHost.cancel({
			worktreeId: "wt_cancel",
			idempotencyKey: "cancel-c",
		});
		await waitForApprovals(approvals, 2);
		expect(approvals[1]!.tool?.name).toBe(DESKTOP_ACTION_STOP_TOOL);
		ui.resolveApproval(approvals[1]!.approvalId, { allowed: true, scope: "once" });

		const allInvokes = await waitForHostInvoke(frames, 2);
		const stopInvoke = allInvokes.find(frame => frame.params?.toolName === DESKTOP_ACTION_STOP_TOOL);
		expect(stopInvoke).toBeDefined();
		expect(stopInvoke!.params?.arguments).toEqual({
			processId: "proc_bound",
			expectedRevision: 2,
			idempotencyKey: "cancel-c",
		});
		bridge.handleResult(stopInvoke!.id!, { content: [{ type: "text", text: "stopped" }] });
		const cancelResult = await cancelPromise;
		expect(cancelResult.cancelled).toBe(true);
		expect(setupHost.getBoundProcess("wt_cancel")).toBeUndefined();
	});

	test("absent desktop action tools stay CAPABILITY_UNAVAILABLE without invoke", async () => {
		const { setupHost, frames } = createHarness({ registerTools: false });
		expect(setupHost.ready).toBe(false);
		expect(setupHost.hasRequiredTools()).toBe(false);

		let err: unknown;
		try {
			await setupHost.start({
				worktreeId: "wt_missing",
				environmentId: "env_x",
				setupActionId: "bootstrap",
				operationId: "op_x",
				idempotencyKey: "x1",
			});
		} catch (error) {
			err = error;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CAPABILITY_UNAVAILABLE");
		expect((err as WorktreeError).details?.feature).toBe("setup");
		expect((err as WorktreeError).details?.available).toBe(false);
		expect(hostInvokeFrames(frames)).toHaveLength(0);
	});

	test("recovery not ready keeps setup unavailable", async () => {
		const { setupHost, frames } = createHarness({ recoveryReady: false });
		expect(setupHost.hasRequiredTools()).toBe(true);
		expect(setupHost.ready).toBe(false);
		await expect(
			setupHost.start({
				worktreeId: "wt_nr",
				environmentId: "env",
				setupActionId: "a",
				operationId: "op",
				idempotencyKey: "k",
			}),
		).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
		expect(hostInvokeFrames(frames)).toHaveLength(0);
	});

	test("host OUTCOME_UNKNOWN remains a Worktree unknown outcome", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const startPromise = setupHost.start({
			worktreeId: "wt_unknown",
			environmentId: "env_unknown",
			setupActionId: "bootstrap",
			operationId: "op_unknown",
			idempotencyKey: "start-unknown",
		});
		await waitForApprovals(approvals, 1);
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "once" });
		const invokes = await waitForHostInvoke(frames);
		bridge.handleError(invokes[0]!.id!, {
			code: -32004,
			message: "host outcome is unknown",
			data: {
				reason: "OUTCOME_UNKNOWN",
				category: "conflict",
				retryable: false,
				correlationId: "corr_unknown",
			},
		});

		await expect(startPromise).rejects.toMatchObject({
			code: "OUTCOME_UNKNOWN",
			details: {
				hostReason: "OUTCOME_UNKNOWN",
				correlationId: "corr_unknown",
			},
		});
	});

	test("transport close after host dispatch remains outcome_unknown", async () => {
		const { setupHost, frames, approvals, ui, bridge } = createHarness();
		const startPromise = setupHost.start({
			worktreeId: "wt_closed",
			environmentId: "env_closed",
			setupActionId: "bootstrap",
			operationId: "op_closed",
			idempotencyKey: "start-closed",
		});
		await waitForApprovals(approvals, 1);
		ui.resolveApproval(approvals[0]!.approvalId, { allowed: true, scope: "once" });
		await waitForHostInvoke(frames);
		bridge.close("desktop transport closed");

		await expect(startPromise).rejects.toMatchObject({
			code: "OUTCOME_UNKNOWN",
			details: {
				hostReason: "HOST_TOOL_FAILED",
				closed: true,
			},
		});
	});
});
