import { describe, expect, test } from "bun:test";
import type { AgentTool, AgentToolContext } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import type { ExtensionToolApprovalRequest, ExtensionUIContext } from "@san/coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@san/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@san/coding-agent/extensibility/extensions/wrapper";
import { Type } from "@san/coding-agent/extensibility/typebox";
import {
	dispatchRpcControlFrame,
	handleRpcSetClientCapabilities,
	type RpcInputFrameDeps,
} from "@san/coding-agent/modes/rpc/rpc-mode";
import { createRpcToolApprovalMethod, RpcToolApprovalBridge } from "@san/coding-agent/modes/rpc/rpc-tool-approval";
import type {
	RpcClientCapabilities,
	RpcResponse,
	RpcToolApprovalRequestFrame,
} from "@san/coding-agent/modes/rpc/rpc-types";

const flushMicrotasks = async () => {
	await Bun.sleep(0);
};

function makeBridge() {
	const frames: RpcToolApprovalRequestFrame[] = [];
	const bridge = new RpcToolApprovalBridge(frame => {
		frames.push(frame);
	});
	return { frames, bridge };
}

function makeRequest(overrides: Partial<ExtensionToolApprovalRequest> = {}): ExtensionToolApprovalRequest {
	return {
		sessionId: "sess-1",
		toolCallId: "toolu_1",
		toolName: "bash",
		tier: "exec",
		requestOverride: false,
		arguments: { command: "rm -rf /tmp/scratch" },
		prompt: "Allow tool: bash",
		...overrides,
	};
}

function makeControlFrameDeps(bridge: RpcToolApprovalBridge): RpcInputFrameDeps {
	return {
		handleCommand: async () => {
			throw new Error("control frames must not reach the command queue");
		},
		output: () => {},
		errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
		pendingExtensionRequests: new Map(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
		onToolApprovalResponse: frame => bridge.handleResponse(frame),
	};
}

describe("set_client_capabilities", () => {
	test("responds with the standard success envelope and applies the declaration", () => {
		const capabilities: RpcClientCapabilities = {};
		const response = handleRpcSetClientCapabilities(capabilities, {
			id: "cap-1",
			type: "set_client_capabilities",
			capabilities: { toolApproval: true },
		});

		expect(response).toEqual({
			id: "cap-1",
			type: "response",
			command: "set_client_capabilities",
			success: true,
		} as RpcResponse);
		expect(capabilities.toolApproval).toBe(true);
	});

	test("replace semantics: omitting a capability withdraws it", () => {
		const capabilities: RpcClientCapabilities = { toolApproval: true };
		handleRpcSetClientCapabilities(capabilities, {
			id: "cap-2",
			type: "set_client_capabilities",
			capabilities: {},
		});
		expect(capabilities.toolApproval).toBe(false);
	});

	test("requestToolApproval stays falsy until the capability is declared", () => {
		const { bridge } = makeBridge();
		const capabilities: RpcClientCapabilities = {};

		expect(createRpcToolApprovalMethod(capabilities, bridge)).toBeUndefined();

		handleRpcSetClientCapabilities(capabilities, {
			type: "set_client_capabilities",
			capabilities: { toolApproval: true },
		});
		expect(typeof createRpcToolApprovalMethod(capabilities, bridge)).toBe("function");
	});
});

describe("tool_approval_request frames", () => {
	test("emits the approval request verbatim plus frame type and correlation id", async () => {
		const { frames, bridge } = makeBridge();
		const request = makeRequest({ reason: "Dangerous command", cwd: "/work/dir" });

		const decision = bridge.request(request);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			type: "tool_approval_request",
			id: expect.any(String),
			...request,
		});

		bridge.handleResponse({
			type: "tool_approval_response",
			id: frames[0].id,
			allowed: true,
			scope: "session",
		});
		await expect(decision).resolves.toEqual({ allowed: true, scope: "session" });
	});

	test("tool_approval_response pairs by id through the stdin control-frame dispatch", async () => {
		const { frames, bridge } = makeBridge();
		const deps = makeControlFrameDeps(bridge);

		const first = bridge.request(makeRequest({ toolCallId: "toolu_first" }));
		const second = bridge.request(makeRequest({ toolCallId: "toolu_second" }));
		expect(frames).toHaveLength(2);

		// An unknown id settles nothing.
		expect(dispatchRpcControlFrame({ type: "tool_approval_response", id: "missing", allowed: true }, deps)).toBe(
			true,
		);

		// Settle the second request first to prove pairing is by id, not order.
		expect(
			dispatchRpcControlFrame(
				{
					type: "tool_approval_response",
					id: frames[1].id,
					allowed: false,
					comment: "not today",
					scope: "bogus",
				},
				deps,
			),
		).toBe(true);
		// Invalid scope values are dropped instead of leaking into the decision.
		await expect(second).resolves.toEqual({ allowed: false, comment: "not today" });

		expect(
			dispatchRpcControlFrame(
				{ type: "tool_approval_response", id: frames[0].id, allowed: true, scope: "workspace", persistRule: true },
				deps,
			),
		).toBe(true);
		await expect(first).resolves.toEqual({ allowed: true, scope: "workspace", persistRule: true });
	});

	test("abort settles as a denial with a cancelled comment", async () => {
		const { frames, bridge } = makeBridge();

		const preAborted = new AbortController();
		preAborted.abort();
		await expect(bridge.request(makeRequest(), { signal: preAborted.signal })).resolves.toEqual({
			allowed: false,
			comment: "cancelled",
		});
		expect(frames).toHaveLength(0);

		const controller = new AbortController();
		const decision = bridge.request(makeRequest(), { signal: controller.signal });
		expect(frames).toHaveLength(1);
		controller.abort();
		await expect(decision).resolves.toEqual({ allowed: false, comment: "cancelled" });

		// A late client response no longer matches a pending approval.
		expect(bridge.handleResponse({ type: "tool_approval_response", id: frames[0].id, allowed: true })).toBe(false);
	});

	test("timeout settles as a denial with a timed_out comment and fires onTimeout", async () => {
		const { frames, bridge } = makeBridge();
		let timedOut = false;

		const decision = bridge.request(makeRequest(), {
			timeout: 5,
			onTimeout: () => {
				timedOut = true;
			},
		});
		expect(frames).toHaveLength(1);
		await expect(decision).resolves.toEqual({ allowed: false, comment: "timed_out" });
		expect(timedOut).toBe(true);
	});

	test("close rejects active and future requests so EOF draining cannot hang", async () => {
		const { frames, bridge } = makeBridge();
		const message = "RPC client disconnected before tool approval completed";

		const active = bridge.request(makeRequest());
		bridge.close(message);
		await expect(active).rejects.toThrow(message);

		await expect(bridge.request(makeRequest())).rejects.toThrow(message);
		expect(frames).toHaveLength(1);
	});
});

describe("approval wrapper integration", () => {
	const toolParameters = Type.Object({ command: Type.String() });

	function makeHarness() {
		const { frames, bridge } = makeBridge();
		const capabilities: RpcClientCapabilities = {};
		const selectTitles: string[] = [];
		const uiContext = {
			select: async (title: string) => {
				selectTitles.push(title);
				return "Approve";
			},
			get requestToolApproval() {
				return createRpcToolApprovalMethod(capabilities, bridge);
			},
		} as unknown as ExtensionUIContext;
		const runner = {
			hasHandlers: () => false,
			hasUI: () => true,
			getUIContext: () => uiContext,
		} as unknown as ExtensionRunner;

		const executions: string[] = [];
		const tool: AgentTool = {
			name: "danger_probe",
			label: "Danger Probe",
			description: "Exec-tier probe for approval routing",
			parameters: toolParameters,
			strict: true,
			execute: async toolCallId => {
				executions.push(toolCallId);
				return { content: [{ type: "text", text: "ran" }] };
			},
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);
		const context = {
			settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
			sessionManager: { getSessionId: () => "sess-1", getCwd: () => "/work/dir" },
		} as unknown as AgentToolContext;

		return { frames, bridge, capabilities, selectTitles, executions, wrapper, context };
	}

	test("without the capability the wrapper keeps the legacy select fallback and emits no approval frames", async () => {
		const { frames, selectTitles, executions, wrapper, context } = makeHarness();

		const result = await wrapper.execute("toolu_legacy", { command: "echo hi" }, undefined, undefined, context);

		expect(frames).toHaveLength(0);
		expect(selectTitles).toHaveLength(1);
		expect(selectTitles[0]).toContain("Allow tool: danger_probe");
		expect(executions).toEqual(["toolu_legacy"]);
		expect(result.content).toEqual([{ type: "text", text: "ran" }]);
	});

	test("with the capability the wrapper emits a structured frame and honors the client decision", async () => {
		const { frames, bridge, capabilities, selectTitles, executions, wrapper, context } = makeHarness();
		handleRpcSetClientCapabilities(capabilities, {
			type: "set_client_capabilities",
			capabilities: { toolApproval: true },
		});

		const execution = wrapper.execute("toolu_struct", { command: "echo hi" }, undefined, undefined, context);
		await flushMicrotasks();

		expect(selectTitles).toHaveLength(0);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "tool_approval_request",
			sessionId: "sess-1",
			toolCallId: "toolu_struct",
			toolName: "danger_probe",
			tier: "exec",
			requestOverride: false,
			arguments: { command: "echo hi" },
			cwd: "/work/dir",
		});
		expect(frames[0].prompt).toContain("Allow tool: danger_probe");
		expect(frames[0].reason).toBeUndefined();

		bridge.handleResponse({ type: "tool_approval_response", id: frames[0].id, allowed: true, scope: "once" });
		const result = await execution;
		expect(executions).toEqual(["toolu_struct"]);
		expect(result.content).toEqual([{ type: "text", text: "ran" }]);
	});

	test("a denying client decision blocks execution", async () => {
		const { frames, bridge, capabilities, executions, wrapper, context } = makeHarness();
		handleRpcSetClientCapabilities(capabilities, {
			type: "set_client_capabilities",
			capabilities: { toolApproval: true },
		});

		const execution = wrapper.execute("toolu_denied", { command: "echo hi" }, undefined, undefined, context);
		await flushMicrotasks();
		expect(frames).toHaveLength(1);

		bridge.handleResponse({
			type: "tool_approval_response",
			id: frames[0].id,
			allowed: false,
			comment: "not on my watch",
		});
		await expect(execution).rejects.toThrow("Tool call denied by user: danger_probe");
		expect(executions).toEqual([]);
	});
});
