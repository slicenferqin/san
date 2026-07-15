import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { runEvalAgentExecution } from "../../src/eval/agent-bridge";
import * as taskDiscovery from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import {
	EvalWorkflowAgentBridge,
	WorkflowAgentBridgeError,
	type WorkflowEvalAgentInvoker,
} from "../../src/workflows/agent-bridge";
import type { WorkflowAgentRequest } from "../../src/workflows/types";

const usage: Usage = {
	input: 10,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 14,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeSession(activeTools: readonly string[] = ["read", "grep", "yield"]): ToolSession {
	const active = new Set(activeTools);
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "workflow-bridge-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		isToolActive: name => active.has(name),
	};
}

function request(overrides: Partial<WorkflowAgentRequest> = {}): WorkflowAgentRequest {
	return {
		callId: "call-1",
		nodeId: "node-1",
		inputHash: "input-1",
		phase: "inspect",
		scopeKey: process.cwd(),
		prompt: "Inspect the repository",
		allowedTools: ["read", "yield"],
		writeMode: "read_only",
		remainingTokenBudget: 1_000,
		signal: new AbortController().signal,
		...overrides,
	};
}

describe("EvalWorkflowAgentBridge", () => {
	it("passes only the approved request boundary and maps a structured result", async () => {
		let capturedArgs: unknown;
		let capturedOptions: Parameters<WorkflowEvalAgentInvoker>[1] | undefined;
		const invokeAgent: WorkflowEvalAgentInvoker = async (args, options) => {
			capturedArgs = args;
			capturedOptions = options;
			return {
				result: {
					text: '{"ok":true}',
					details: { agent: "reviewer", id: "Workflow-review", structured: true },
				},
				usage,
				durationMs: 42,
				allowedTools: ["read", "yield"],
			};
		};
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
			invokeAgent,
		});

		const result = await bridge.run(request({ schema: { type: "object" } }));

		expect(result).toEqual({
			agentId: "Workflow-review",
			value: { ok: true },
			text: '{"ok":true}',
			usage,
			durationMs: 42,
			patchPath: undefined,
			branchName: undefined,
			changesApplied: undefined,
		});
		expect(capturedArgs).toMatchObject({
			prompt: "Inspect the repository",
			schema: { type: "object" },
		});
		expect(capturedOptions?.toolPolicy).toEqual({
			allowedTools: ["read", "yield"],
			pathScope: process.cwd(),
			requireSessionActivation: true,
			hardTokenLimit: 1_000,
		});
	});

	it("keeps plain-text nodes unstructured", async () => {
		let receivedSchema = true;
		const invokeAgent: WorkflowEvalAgentInvoker = async args => {
			receivedSchema = Object.hasOwn(args as object, "schema");
			return {
				result: { text: "plain result", details: { agent: "task", id: "plain", structured: false } },
				durationMs: 3,
			};
		};
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "read_only", tools: ["read", "yield"] },
			invokeAgent,
		});

		const result = await bridge.run(request());

		expect(receivedSchema).toBe(false);
		expect(result.value).toBe("plain result");
	});

	it("rejects a request whose execution scope differs from the approved scope", async () => {
		const invokeAgent = vi.fn<WorkflowEvalAgentInvoker>();
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "read_only", tools: ["read", "yield"] },
			invokeAgent,
		});

		await expect(bridge.run(request({ scopeKey: `${process.cwd()}-other` }))).rejects.toThrow(
			"does not match the approved execution scope",
		);
		expect(invokeAgent).not.toHaveBeenCalled();
	});

	it("rejects capability widening before invoking a subagent", async () => {
		const invokeAgent = vi.fn<WorkflowEvalAgentInvoker>(async () => {
			throw new Error("must not run");
		});
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "read_only", tools: ["read", "yield"] },
			invokeAgent,
		});

		await expect(bridge.run(request({ allowedTools: ["read", "bash", "yield"] }))).rejects.toThrow(
			"outside the approved manifest: bash",
		);
		expect(invokeAgent).not.toHaveBeenCalled();
	});

	it("keeps isolated writes behind the separate delivery gate", async () => {
		const invokeAgent = vi.fn<WorkflowEvalAgentInvoker>(async () => {
			throw new Error("must not run");
		});
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(["edit", "yield"]),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "isolated_write", tools: ["edit", "yield"] },
			invokeAgent,
		});

		await expect(
			bridge.run(request({ allowedTools: ["edit", "yield"], writeMode: "isolated_write" })),
		).rejects.toThrow("unavailable until the separate delivery gate is enabled");
		expect(invokeAgent).not.toHaveBeenCalled();
	});

	it("forces enabled isolated writes into patch-only review metadata without applying them", async () => {
		let capturedArgs: unknown;
		const baseline = {
			root: {
				repoRoot: process.cwd(),
				headCommit: "abc",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const invokeAgent: WorkflowEvalAgentInvoker = async args => {
			capturedArgs = args;
			return {
				result: {
					text: "ready",
					details: {
						agent: "writer",
						id: "writer-1",
						structured: false,
						isolated: true,
						patchPath: `${process.cwd()}/artifacts/writer.patch`,
						changesApplied: null,
					},
				},
				durationMs: 2,
				isolation: { context: { repoRoot: process.cwd(), baseline }, artifactsDir: `${process.cwd()}/artifacts` },
			};
		};
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(["edit", "yield"]),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "isolated_write", tools: ["edit", "yield"] },
			allowIsolatedWrite: true,
			invokeAgent,
		});

		const result = await bridge.run(request({ allowedTools: ["edit", "yield"], writeMode: "isolated_write" }));

		expect(capturedArgs).toMatchObject({ isolated: true, apply: false, merge: false });
		expect(result.changesApplied).toBeNull();
		expect(result.writeArtifact).toMatchObject({
			repoRoot: process.cwd(),
			scopeKey: process.cwd(),
			patchPath: `${process.cwd()}/artifacts/writer.patch`,
			nestedPatches: [],
		});
	});

	it("rejects invalid structured output instead of committing an unchecked value", async () => {
		const invokeAgent: WorkflowEvalAgentInvoker = async () => ({
			result: { text: "not-json", details: { agent: "task", id: "bad-json", structured: true } },
			durationMs: 1,
		});
		const bridge = new EvalWorkflowAgentBridge({
			session: makeSession(),
			approvedScopeKey: process.cwd(),
			approvedPermissions: { writeMode: "read_only", tools: ["read", "yield"] },
			invokeAgent,
		});

		await expect(bridge.run(request({ schema: { type: "object" } }))).rejects.toBeInstanceOf(
			WorkflowAgentBridgeError,
		);
	});
});

describe("programmatic Eval agent policy", () => {
	afterEach(() => vi.restoreAllMocks());

	it("intersects manifest, live session and agent tools before strict execution", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Run the task.",
			source: "bundled",
			tools: ["read", "grep", "bash", "yield"],
			spawns: "*",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockImplementation(async options => singleResult(options, { output: "done", usage }));

		const execution = await runEvalAgentExecution(
			{ prompt: "Inspect" },
			{
				session: makeSession(["read", "yield"]),
				toolPolicy: {
					allowedTools: ["read", "grep", "bash", "yield"],
					pathScope: process.cwd(),
					requireSessionActivation: true,
					hardTokenLimit: 1_000,
				},
			},
		);

		const options = runSpy.mock.calls[0]?.[0];
		if (!options) throw new Error("runSubprocess was not called");
		expect(execution.allowedTools).toEqual(["read", "yield"]);
		expect(options.agent.tools).toEqual(["read", "yield"]);
		expect(options.agent.spawns).toBeUndefined();
		expect(options.strictToolNames).toBe(true);
		expect(options.toolPathScope).toBe(process.cwd());
		expect(options.hardTokenLimit).toBe(1_000);
		expect(execution.usage).toEqual(usage);
	});
});

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}
