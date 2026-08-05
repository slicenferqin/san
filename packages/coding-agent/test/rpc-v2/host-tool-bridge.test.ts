import { describe, expect, test } from "bun:test";
import {
	type HostRequestError,
	isHostRequestError,
	RpcV2HostToolBridge,
} from "../../src/modes/rpc-v2/host-tool-bridge";

type OutFrame = {
	jsonrpc?: string;
	id?: string;
	method?: string;
	params?: Record<string, unknown>;
};

function createBridge(options?: {
	sessionId?: string;
	runId?: string;
	maxPayloadBytes?: number;
	getCapabilityRevision?: () => number | undefined;
}): {
	bridge: RpcV2HostToolBridge;
	frames: OutFrame[];
} {
	const frames: OutFrame[] = [];
	const bridge = new RpcV2HostToolBridge(
		frame => {
			frames.push(frame as OutFrame);
		},
		() => ({
			...(options?.sessionId ? { sessionId: options.sessionId } : {}),
			...(options?.runId ? { runId: options.runId } : {}),
		}),
		{
			...(options?.maxPayloadBytes !== undefined ? { maxPayloadBytes: options.maxPayloadBytes } : {}),
			...(options?.getCapabilityRevision ? { getCapabilityRevision: options.getCapabilityRevision } : {}),
		},
	);
	return { bridge, frames };
}

function lastRequest(frames: OutFrame[]): OutFrame {
	const request = frames.find(frame => typeof frame.id === "string" && typeof frame.method === "string");
	if (!request) throw new Error("expected host request frame");
	return request;
}

function takeRequest(frames: OutFrame[]): OutFrame {
	const index = frames.findIndex(frame => typeof frame.id === "string" && typeof frame.method === "string");
	if (index < 0) throw new Error("expected host request frame");
	const [request] = frames.splice(index, 1);
	if (!request) throw new Error("expected host request frame");
	return request;
}

describe("RpcV2HostToolBridge M3 host boundary", () => {
	test("agent invoke requires active session/run/toolCallId and emits host.tool.invoke identity", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const pending = bridge.invoke(
			"desktop.action.start.v1",
			{ actionId: "test", actionRevision: 1, environmentId: "env_1", idempotencyKey: "k1" },
			{ toolCallId: "tool_1", capabilityRevision: 7 },
		);

		const request = lastRequest(frames);
		expect(request.method).toBe("host.tool.invoke");
		expect(request.params).toMatchObject({
			sessionId: "ses_1",
			runId: "run_1",
			toolCallId: "tool_1",
			toolName: "desktop.action.start.v1",
			capabilityRevision: 7,
			deadlineMs: 30_000,
		});

		bridge.handleProgress(request.id!, "starting");
		bridge.handleResult(request.id!, {
			content: [{ type: "text", text: "ok" }],
			details: { processId: "proc_1" },
		});
		await expect(pending).resolves.toEqual({
			content: [{ type: "text", text: "ok" }],
			details: { processId: "proc_1" },
		});
	});

	test("agent invoke rejects missing active identity without dispatch", async () => {
		const { bridge, frames } = createBridge({});
		await expect(
			bridge.invoke("desktop.action.start.v1", { actionId: "x" }, { toolCallId: "tool_1" }),
		).rejects.toMatchObject({
			name: "HostRequestError",
			reason: "HOST_CAPABILITY_UNAVAILABLE",
			code: -32060,
		});
		expect(frames).toHaveLength(0);
	});

	test("invokeHostAction uses explicit identity and never falls back to agent context", async () => {
		const { bridge, frames } = createBridge({
			sessionId: "ses_agent_context",
			runId: "run_agent_context",
		});
		const pending = bridge.invokeHostAction(
			"desktop.action.start.v1",
			{ actionId: "setup", actionRevision: 2, environmentId: "env_setup", idempotencyKey: "setup-1" },
			{
				identity: {
					sessionId: "ses_setup",
					runId: "run_setup",
					toolCallId: "host_action_setup_1",
				},
				capabilityRevision: 9,
			},
		);

		const request = lastRequest(frames);
		expect(request.method).toBe("host.tool.invoke");
		expect(request.params).toMatchObject({
			sessionId: "ses_setup",
			runId: "run_setup",
			toolCallId: "host_action_setup_1",
			toolName: "desktop.action.start.v1",
			capabilityRevision: 9,
		});
		expect(request.params?.sessionId).not.toBe("ses_agent_context");
		expect(request.params?.runId).not.toBe("run_agent_context");

		bridge.handleResult(request.id!, { content: [{ type: "text", text: "started" }] });
		await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "started" }] });
	});

	test("invokeHostAction rejects incomplete identity without dispatch", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		await expect(
			bridge.invokeHostAction(
				"desktop.action.start.v1",
				{ actionId: "x" },
				{
					// @ts-expect-error intentional incomplete identity
					identity: { sessionId: "ses_only" },
				},
			),
		).rejects.toMatchObject({
			name: "HostRequestError",
			reason: "INVALID_PARAMS",
			code: -32602,
		});
		expect(frames).toHaveLength(0);
	});

	test("handleError preserves structured RPC error data", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const pending = bridge.invoke("desktop.action.stop.v1", { processId: "p1" }, { toolCallId: "tool_stop" });
		const request = lastRequest(frames);

		bridge.handleError(request.id!, {
			code: -32060,
			message: "Action handler not ready",
			data: {
				reason: "HOST_CAPABILITY_UNAVAILABLE",
				category: "conflict",
				retryable: false,
				correlationId: "corr_host_1",
				sessionId: "ses_1",
				runId: "run_1",
				details: { toolName: "desktop.action.stop.v1", currentRevision: 3 },
			},
		});

		try {
			await pending;
			throw new Error("expected rejection");
		} catch (error: unknown) {
			expect(isHostRequestError(error)).toBe(true);
			const hostError = error as HostRequestError;
			expect(hostError.code).toBe(-32060);
			expect(hostError.reason).toBe("HOST_CAPABILITY_UNAVAILABLE");
			expect(hostError.category).toBe("conflict");
			expect(hostError.correlationId).toBe("corr_host_1");
			expect(hostError.sessionId).toBe("ses_1");
			expect(hostError.runId).toBe("run_1");
			expect(hostError.details).toEqual({
				toolName: "desktop.action.stop.v1",
				currentRevision: 3,
			});
			expect(hostError.data?.reason).toBe("HOST_CAPABILITY_UNAVAILABLE");
		}
	});

	test("handleError keeps top-level fields but drops malformed RpcErrorData", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const pending = bridge.invoke("desktop.action.stop.v1", { processId: "p1" }, { toolCallId: "tool_malformed" });
		const request = lastRequest(frames);

		bridge.handleError(request.id!, {
			code: -32061,
			message: "Host tool failed with partial data",
			data: {
				// 缺少 category / retryable / correlationId，不得 as RpcErrorData
				reason: "HOST_TOOL_FAILED",
				details: { toolName: "desktop.action.stop.v1" },
			},
		});

		try {
			await pending;
			throw new Error("expected rejection");
		} catch (error: unknown) {
			expect(isHostRequestError(error)).toBe(true);
			const hostError = error as HostRequestError;
			expect(hostError.code).toBe(-32061);
			expect(hostError.reason).toBe("HOST_TOOL_FAILED");
			expect(hostError.message).toBe("Host tool failed with partial data");
			expect(hostError.data).toBeUndefined();
			expect(hostError.details).toEqual({ toolName: "desktop.action.stop.v1" });
			expect(hostError.rpcError).toEqual({
				code: -32061,
				message: "Host tool failed with partial data",
			});
			expect(hostError.rpcError).not.toHaveProperty("data");
		}
	});

	test("abort and timeout both emit host.tool.cancel before rejecting", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const controller = new AbortController();
		const pending = bridge.invoke(
			"desktop.action.start.v1",
			{ actionId: "long" },
			{ toolCallId: "tool_abort", signal: controller.signal, deadlineMs: 30_000 },
		);
		const request = lastRequest(frames);
		controller.abort();

		await expect(pending).rejects.toMatchObject({
			name: "HostRequestError",
			details: expect.objectContaining({ cancelReason: "agent_abort" }),
		});
		expect(frames.some(frame => frame.method === "host.tool.cancel")).toBe(true);
		const cancel = frames.find(frame => frame.method === "host.tool.cancel");
		expect(cancel?.params).toEqual({ targetId: request.id, reason: "agent_abort" });

		const timeout = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const timed = timeout.bridge.invoke(
			"desktop.action.result.v1",
			{ processId: "p2" },
			{ toolCallId: "tool_timeout", deadlineMs: 20 },
		);
		const timeoutRequest = lastRequest(timeout.frames);
		await expect(timed).rejects.toMatchObject({
			name: "HostRequestError",
			retryable: true,
			details: expect.objectContaining({ cancelReason: "deadline_exceeded", deadlineMs: 20 }),
		});
		const timeoutCancel = timeout.frames.find(frame => frame.method === "host.tool.cancel");
		expect(timeoutCancel?.params).toEqual({
			targetId: timeoutRequest.id,
			reason: "deadline_exceeded",
		});
	});

	test("bounds tool arguments and uri content payloads", async () => {
		const { bridge, frames } = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			maxPayloadBytes: 32,
		});

		await expect(
			bridge.invoke("desktop.action.start.v1", { blob: "x".repeat(64) }, { toolCallId: "tool_big" }),
		).rejects.toMatchObject({
			name: "HostRequestError",
			reason: "PAYLOAD_TOO_LARGE",
			code: -32070,
		});
		expect(frames).toHaveLength(0);

		await expect(bridge.invokeUri("write", "desktop-change://v1/ref", "y".repeat(64))).rejects.toMatchObject({
			name: "HostRequestError",
			reason: "PAYLOAD_TOO_LARGE",
			code: -32070,
		});
		expect(frames).toHaveLength(0);

		const ok = bridge.invokeUri("read", "desktop-change://v1/ref");
		const uriRequest = lastRequest(frames);
		expect(uriRequest.method).toBe("host.uri.invoke");
		expect(uriRequest.params).toMatchObject({
			sessionId: "ses_1",
			runId: "run_1",
			operation: "read",
			url: "desktop-change://v1/ref",
		});
		bridge.handleResult(uriRequest.id!, { data: "abc", encoding: "utf-8" });
		await expect(ok).resolves.toEqual({ data: "abc", encoding: "utf-8" });
	});

	test("adapter execute preserves structured host tool failure", async () => {
		const { bridge, frames } = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const [tool] = bridge.setTools([
			{
				name: "desktop.action.start.v1",
				description: "start action",
				parameters: { type: "object", properties: {} },
			},
		]);
		const pending = tool!.execute("tool_adapter", { actionId: "a1" });
		const request = lastRequest(frames);
		bridge.handleResult(request.id!, {
			content: [{ type: "text", text: "ProcessHost unavailable" }],
			isError: true,
		});
		await expect(pending).rejects.toMatchObject({
			name: "HostRequestError",
			reason: "HOST_TOOL_FAILED",
			message: "ProcessHost unavailable",
		});
	});

	test("adapter execute without explicit revision binds provider revision", async () => {
		const { bridge, frames } = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			getCapabilityRevision: () => 11,
		});
		const [tool] = bridge.setTools([
			{
				name: "desktop.action.start.v1",
				description: "start action",
				parameters: { type: "object", properties: {} },
			},
		]);
		const pending = tool!.execute("tool_adapter_rev", { actionId: "a1" });
		const request = lastRequest(frames);
		expect(request.method).toBe("host.tool.invoke");
		expect(request.params).toMatchObject({
			toolCallId: "tool_adapter_rev",
			toolName: "desktop.action.start.v1",
			capabilityRevision: 11,
		});
		bridge.handleResult(request.id!, { content: [{ type: "text", text: "ok" }] });
		await expect(pending).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
	});

	test("invokeUri without explicit revision binds provider revision", async () => {
		const { bridge, frames } = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			getCapabilityRevision: () => 13,
		});
		const pending = bridge.invokeUri("read", "desktop-change://v1/ref");
		const request = lastRequest(frames);
		expect(request.method).toBe("host.uri.invoke");
		expect(request.params).toMatchObject({
			sessionId: "ses_1",
			runId: "run_1",
			operation: "read",
			url: "desktop-change://v1/ref",
			capabilityRevision: 13,
		});
		bridge.handleResult(request.id!, { data: "payload", encoding: "utf-8" });
		await expect(pending).resolves.toEqual({ data: "payload", encoding: "utf-8" });
	});

	test("explicit invoke capabilityRevision overrides provider", async () => {
		const { bridge, frames } = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			getCapabilityRevision: () => 4,
		});
		const pending = bridge.invoke(
			"desktop.action.start.v1",
			{ actionId: "override" },
			{ toolCallId: "tool_override", capabilityRevision: 99 },
		);
		const request = lastRequest(frames);
		expect(request.params).toMatchObject({
			toolCallId: "tool_override",
			capabilityRevision: 99,
		});
		expect(request.params?.capabilityRevision).not.toBe(4);
		bridge.handleResult(request.id!, { content: [{ type: "text", text: "overridden" }] });
		await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "overridden" }] });
	});

	test("provider revision changes affect subsequent tool and uri requests", async () => {
		let revision = 1;
		const { bridge, frames } = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			getCapabilityRevision: () => revision,
		});

		const firstTool = bridge.invoke("desktop.action.start.v1", { actionId: "r1" }, { toolCallId: "tool_r1" });
		const firstToolRequest = takeRequest(frames);
		expect(firstToolRequest.params?.capabilityRevision).toBe(1);
		bridge.handleResult(firstToolRequest.id!, { content: [{ type: "text", text: "r1" }] });
		await firstTool;

		revision = 2;
		const firstUri = bridge.invokeUri("read", "desktop-change://v1/after-bump");
		const firstUriRequest = takeRequest(frames);
		expect(firstUriRequest.method).toBe("host.uri.invoke");
		expect(firstUriRequest.params?.capabilityRevision).toBe(2);
		bridge.handleResult(firstUriRequest.id!, { data: "after", encoding: "utf-8" });
		await firstUri;

		revision = 5;
		const secondTool = bridge.invoke("desktop.action.stop.v1", { processId: "p1" }, { toolCallId: "tool_r5" });
		const secondToolRequest = takeRequest(frames);
		expect(secondToolRequest.params?.capabilityRevision).toBe(5);
		bridge.handleResult(secondToolRequest.id!, { content: [{ type: "text", text: "r5" }] });
		await secondTool;
	});

	test("omits capabilityRevision when provider is absent or returns non-finite", async () => {
		const noProvider = createBridge({ sessionId: "ses_1", runId: "run_1" });
		const pendingNoProvider = noProvider.bridge.invoke(
			"desktop.action.start.v1",
			{ actionId: "none" },
			{ toolCallId: "tool_none" },
		);
		const noProviderRequest = lastRequest(noProvider.frames);
		expect(noProviderRequest.params).not.toHaveProperty("capabilityRevision");
		noProvider.bridge.handleResult(noProviderRequest.id!, { content: [{ type: "text", text: "none" }] });
		await pendingNoProvider;

		const invalid = createBridge({
			sessionId: "ses_1",
			runId: "run_1",
			getCapabilityRevision: () => Number.NaN,
		});
		const pendingInvalid = invalid.bridge.invokeUri("read", "desktop-change://v1/invalid");
		const invalidRequest = lastRequest(invalid.frames);
		expect(invalidRequest.params).not.toHaveProperty("capabilityRevision");
		invalid.bridge.handleResult(invalidRequest.id!, { data: "x", encoding: "utf-8" });
		await pendingInvalid;
	});
});
