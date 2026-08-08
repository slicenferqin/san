/**
 * 任务工具 + 子代理 executor 的执行作用域接线：
 *
 * 1. TaskTool 对每次准入/派生都按「显式 `contract.scopeId` → 会话固定/活动作用域」
 *    解析，并把同一个 runtime 与精确的 `executionScopeId` 传入 ExecutorOptions —
 *    在 parent → child → grandchild 全链路逐字节一致。
 * 2. 兄弟任务保持独立 contract；一个兄弟失败不会污染另一个。
 * 3. 重复的 scope/workKey/strategyKey 准入经由 registry + runtime watchdog 路径
 *    复用/拒绝，且绝不增加 spawn 计数。
 * 4. 子任务 completed/failed/aborted 结果映射到 TaskContractRegistry 状态并
 *    产生宿主观测。
 * 5. 任务工具从不调用 runtime 所有权操作（startScope/syncBranch/finishScope/dispose）。
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import type {
	ExecutionRuntime,
	RecordHostObservationInput,
} from "@san/coding-agent/execution-control/execution-runtime";
import { createExecutionRuntime } from "@san/coding-agent/execution-control/execution-runtime";
import type { HostObservation } from "@san/coding-agent/execution-control/progress-classifier";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import {
	createTaskContractRegistry,
	type TaskContractRegistry,
} from "@san/coding-agent/execution-control/task-contract";
import type { WatchdogAction, WatchdogDecision, WatchdogInput } from "@san/coding-agent/execution-control/watchdog";
import type { LoadExtensionsResult } from "@san/coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@san/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@san/coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@san/coding-agent/sdk";
import * as sdkModule from "@san/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@san/coding-agent/session/agent-session";
import type { CustomEntry, SessionEntry } from "@san/coding-agent/session/session-entries";
import { TaskTool } from "@san/coding-agent/task";
import * as discoveryModule from "@san/coding-agent/task/discovery";
import * as executorModule from "@san/coding-agent/task/executor";
import { runSubprocess } from "@san/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@san/coding-agent/task/types";
import type { ToolSession } from "@san/coding-agent/tools";
import { EventBus } from "@san/coding-agent/utils/event-bus";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

interface FakeScheduler {
	enforce: Mock<(input: WatchdogInput) => WatchdogDecision>;
}

interface FakeRuntime {
	startScope: Mock<(request: unknown) => unknown>;
	activeScopeId: Mock<() => string | undefined>;
	getScope: Mock<(scopeId: string) => unknown>;
	schedulerFor: Mock<(scopeId: string) => FakeScheduler>;
	recordHostObservation: Mock<(input: RecordHostObservationInput) => unknown>;
	recordProviderSnapshot: Mock<(snapshot: unknown) => unknown>;
	syncBranch: Mock<(entries: unknown) => void>;
	finishScope: Mock<(scopeId: string, outcome: unknown) => unknown>;
	dispose: Mock<() => void>;
}

function createFakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
	return {
		startScope: vi.fn(),
		activeScopeId: vi.fn(() => undefined),
		getScope: vi.fn(),
		schedulerFor: vi.fn(() => createFakeScheduler("none")),
		recordHostObservation: vi.fn(),
		recordProviderSnapshot: vi.fn(),
		syncBranch: vi.fn(),
		finishScope: vi.fn(),
		dispose: vi.fn(),
		...overrides,
	};
}

function createFakeScheduler(action: WatchdogAction): FakeScheduler {
	return {
		enforce: vi.fn(
			() =>
				({
					action,
					enforced: action !== "none",
					duplicate: action === "reuse_duplicate" || action === "reject_duplicate",
				}) as unknown as WatchdogDecision,
		),
	};
}

/** 从 fake runtime 提取 observation 类收尾记录（scopeId + workKey + cursor）。 */
function recordedObservations(runtime: FakeRuntime): Array<{ scopeId: string; workKey: string; cursor: string }> {
	return runtime.recordHostObservation.mock.calls
		.map(call => call[0] as Extract<RecordHostObservationInput, { observation: HostObservation }>)
		.map(input => ({
			scopeId: input.scopeId,
			workKey: input.observation.workKey ?? "",
			cursor: input.observation.cursor ?? "",
		}));
}

function createSession(options: {
	settings?: Record<string, unknown>;
	executionRuntime?: FakeRuntime;
	getExecutionScopeId?: () => string | undefined;
	taskContractRegistry?: TaskContractRegistry;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		executionRuntime: options.executionRuntime as unknown as ExecutionRuntime,
		getExecutionScopeId: options.getExecutionScopeId,
		taskContractRegistry: options.taskContractRegistry,
	} as unknown as ToolSession;
}

/** 内存 session-manager：只收集当前分支的 custom entries，供真实 runtime 回放。 */
class MemorySession {
	readonly entries: SessionEntry[] = [];
	#nextId = 0;

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.#nextId++}`;
		const entry: CustomEntry = {
			type: "custom",
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: "2026-08-07T00:00:00.000Z",
			customType,
			data,
		};
		this.entries.push(entry);
		return id;
	}

	getEntries(): readonly SessionEntry[] {
		return [...this.entries];
	}
}

const ROOT_SESSION_ID = "root-session";
const NOW_ISO = "2026-08-07T00:00:00.000Z";

/** 构造一个已 startScope 的真实 ExecutionRuntime，scopeId 取自 runtime 分配结果。 */
function createRealRuntime(): {
	runtime: ExecutionRuntime;
	taskRegistry: TaskContractRegistry;
	scopeId: string;
} {
	const session = new MemorySession();
	const taskRegistry = createTaskContractRegistry({ rootSessionId: ROOT_SESSION_ID, now: () => 0 });
	const runtime = createExecutionRuntime({
		rootSessionId: ROOT_SESSION_ID,
		branchEntries: session.getEntries(),
		sessionManager: session,
		taskRegistry,
		providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
		now: () => NOW_ISO,
	});
	runtime.startScope({
		rootSessionId: ROOT_SESSION_ID,
		logicalTurnId: "turn-1",
		objectiveContract: {
			ref: {
				contractId: "contract-root",
				revision: 1,
				contractHash: "sha256-test",
				clauseRefs: ["clause:deliver"],
			},
			authoritativeUserTurnId: "turn-1",
			source: "authoritative_user",
		},
	});
	return { runtime, taskRegistry, scopeId: runtime.activeScopeId() ?? "scope:missing" };
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-scope-pass-through",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-scope",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("task execution-scope wiring", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("propagates the exact scope id and the same runtime through parent → child → grandchild", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runtime = createFakeRuntime();
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const captured: Array<{ executionScopeId?: string; executionRuntime?: unknown }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured.push({ executionScopeId: options.executionScopeId, executionRuntime: options.executionRuntime });
			return makeResult(options.id ?? "?");
		});

		// 根会话：固定/活动作用域来自会话访问器。
		const rootTool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:root",
				executionRuntime: runtime,
				taskContractRegistry: registry,
			}),
		);
		await rootTool.execute("tc-root", {
			agent: "task",
			name: "Child",
			task: "work at level 1",
		} as TaskParams);

		// 子会话：经由 ExecutorOptions 收到精确 scope id 与同一 runtime。
		const childOptions = captured[0]!;
		expect(childOptions.executionScopeId).toBe("scope:root");
		expect(childOptions.executionRuntime).toBe(runtime);
		const childTool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => childOptions.executionScopeId,
				executionRuntime: childOptions.executionRuntime as unknown as FakeRuntime,
				taskContractRegistry: registry,
			}),
		);
		await childTool.execute("tc-child", {
			agent: "task",
			name: "Grandchild",
			task: "work at level 2",
		} as TaskParams);

		// 孙会话：同样的固定作用域、同样的 runtime。
		const grandchildOptions = captured[1]!;
		expect(grandchildOptions.executionScopeId).toBe(childOptions.executionScopeId);
		expect(grandchildOptions.executionRuntime).toBe(runtime);
		const grandchildTool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => grandchildOptions.executionScopeId,
				executionRuntime: grandchildOptions.executionRuntime as unknown as FakeRuntime,
				taskContractRegistry: registry,
			}),
		);
		await grandchildTool.execute("tc-grandchild", {
			agent: "task",
			name: "GreatGrandchild",
			task: "work at level 3",
		} as TaskParams);

		// 三个层级的作用域逐字节一致，runtime 为同一对象。
		expect(captured.map(entry => entry.executionScopeId)).toEqual(["scope:root", "scope:root", "scope:root"]);
		expect(captured.map(entry => entry.executionRuntime)).toEqual([runtime, runtime, runtime]);
		// registry 中每个 contract 都携带根作用域。
		const contracts = registry.list();
		expect(contracts).toHaveLength(3);
		expect(contracts.every(contract => contract.scopeId === "scope:root")).toBe(true);
		// 子会话不会获得所有权操作。
		expect(runtime.startScope).not.toHaveBeenCalled();
		expect(runtime.syncBranch).not.toHaveBeenCalled();
		expect(runtime.finishScope).not.toHaveBeenCalled();
		expect(runtime.dispose).not.toHaveBeenCalled();
		// 每次收尾都在根作用域下产生一条宿主观测。
		const observationScopes = runtime.recordHostObservation.mock.calls.map(call => call[0].scopeId);
		expect(observationScopes).toEqual(["scope:root", "scope:root", "scope:root"]);
	});

	it("uses the explicit contract scope id over the session scope", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const tool = await TaskTool.create(
			createSession({ getExecutionScopeId: () => "scope:fixed", taskContractRegistry: registry }),
		);

		await tool.execute("tc-explicit", {
			agent: "task",
			name: "Explicit",
			task: "explicit scope work",
			contract: { workKey: "explicit-work", scopeId: "scope:explicit" },
		} as TaskParams);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0]?.executionScopeId).toBe("scope:explicit");
		const contract = registry.get({
			scopeId: "scope:explicit",
			workKey: "explicit-work",
			strategyKey: "strategy:task",
		});
		expect(contract?.scopeId).toBe("scope:explicit");
		expect(contract?.workKey).toBe("explicit-work");
	});

	it("runs batch spawns under the session scope", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:batch",
				taskContractRegistry: registry,
				settings: { "task.batch": true },
			}),
		);

		const result = await tool.execute("tc-batch", {
			context: "shared",
			tasks: [
				{ name: "Alpha", agent: "task", task: "alpha work", contract: { workKey: "alpha" } },
				{ name: "Beta", agent: "task", task: "beta work", contract: { workKey: "beta" } },
			],
		} as TaskParams);

		expect(runSpy).toHaveBeenCalledTimes(2);
		const contracts = registry.list("scope:batch");
		expect(contracts).toHaveLength(2);
		const alpha = contracts.find(contract => contract.workKey === "alpha")!;
		const beta = contracts.find(contract => contract.workKey === "beta")!;
		expect(alpha.contractId).not.toBe(beta.contractId);
		expect(alpha.scopeId).toBe("scope:batch");
		expect(beta.scopeId).toBe("scope:batch");
		expect(result.details?.results).toHaveLength(2);
	});

	it("isolates a failed sibling from its sibling's completion status", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			options.assignment === "alpha work"
				? makeResult(options.id ?? "?", { exitCode: 1, error: "boom", output: "", stderr: "boom" })
				: makeResult(options.id ?? "?"),
		);
		const runtime = createFakeRuntime();
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:iso",
				executionRuntime: runtime,
				taskContractRegistry: registry,
				settings: { "task.batch": true },
			}),
		);

		await tool.execute("tc-iso", {
			context: "shared",
			tasks: [
				{ name: "Alpha", agent: "task", task: "alpha work", contract: { workKey: "alpha" } },
				{ name: "Beta", agent: "task", task: "beta work", contract: { workKey: "beta" } },
			],
		} as TaskParams);

		const contracts = registry.list("scope:iso");
		expect(contracts).toHaveLength(2);
		expect(contracts.find(contract => contract.workKey === "alpha")?.status).toBe("failed");
		expect(contracts.find(contract => contract.workKey === "beta")?.status).toBe("completed");
		// 宿主观测如实反映每个兄弟自己的结果——一个兄弟的失败不会污染另一个的观测。
		const observations = recordedObservations(runtime);
		expect(observations).toContainEqual({ scopeId: "scope:iso", workKey: "beta", cursor: "completed" });
	});

	it("reuses a duplicate identity without a second spawn", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const runtime = createFakeRuntime();
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:dup",
				executionRuntime: runtime,
				taskContractRegistry: registry,
			}),
		);
		const params = {
			agent: "task",
			task: "duplicate work",
			contract: { workKey: "same-work", strategyKey: "same-strategy" },
		} as TaskParams;

		await tool.execute("tc-dup-1", params);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runtime.schedulerFor).toHaveBeenCalledTimes(1);

		const result = await tool.execute("tc-dup-2", params);
		expect(runSpy).toHaveBeenCalledTimes(1); // 不产生第二次 spawn
		expect(getFirstText(result)).toContain("Reused task contract");
		// 重复准入仍然产生稳定的 runtime 决策——且未发生的运行不会产生第二条收尾观测。
		expect(runtime.schedulerFor).toHaveBeenCalledTimes(2);
		expect(runtime.recordHostObservation).toHaveBeenCalledTimes(1);
		const contracts = registry.list("scope:dup");
		expect(contracts).toHaveLength(1);
		expect(contracts[0]!.status).toBe("completed");
		expect(contracts[0]!.scopeId).toBe("scope:dup");
	});

	it("settles a cancelled contract exactly once when acquire aborts before start", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runtime = createFakeRuntime();
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:abort",
				executionRuntime: runtime,
				taskContractRegistry: registry,
			}),
		);

		// 调用方在 spawn 开始前就 abort：acquire 立即抛错，不得产生任何网络调用。
		const controller = new AbortController();
		controller.abort();
		await expect(
			tool.execute(
				"tc-abort",
				{
					agent: "task",
					task: "aborted work",
					contract: { workKey: "aborted" },
				} as TaskParams,
				controller.signal,
			),
		).rejects.toThrow();
		expect(runSpy).not.toHaveBeenCalled();

		// acquire 中止同样是一次终态：registry cancelled + 宿主观测恰好一条。
		const contract = registry.get({
			scopeId: "scope:abort",
			workKey: "aborted",
			strategyKey: "strategy:task",
		});
		expect(contract?.status).toBe("cancelled");
		expect(runtime.recordHostObservation).toHaveBeenCalledTimes(1);
		const cancelled = runtime.recordHostObservation.mock.calls[0]?.[0] as Extract<
			RecordHostObservationInput,
			{ observation: HostObservation }
		>;
		expect(cancelled.scopeId).toBe("scope:abort");
		expect(cancelled.observation).toMatchObject({
			workKey: "aborted",
			type: "process_heartbeat",
			live: false,
			cursor: "cancelled",
		});
		expect("failureSignature" in cancelled.observation).toBe(false);
	});

	it("maps completed/failed/aborted child results to registry status and host observations", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.assignment === "failing work") {
				return makeResult(options.id ?? "?", { exitCode: 1, error: "boom", output: "", stderr: "boom" });
			}
			if (options.assignment === "aborting work") {
				return makeResult(options.id ?? "?", { aborted: true, abortReason: "user" });
			}
			return makeResult(options.id ?? "?");
		});
		const runtime = createFakeRuntime();
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:map",
				executionRuntime: runtime,
				taskContractRegistry: registry,
			}),
		);

		await tool.execute("tc-map-1", {
			agent: "task",
			name: "Ok",
			task: "ok work",
			contract: { workKey: "ok" },
		} as TaskParams);
		await tool.execute("tc-map-2", {
			agent: "task",
			name: "Fail",
			task: "failing work",
			contract: { workKey: "fail" },
		} as TaskParams);
		await tool.execute("tc-map-3", {
			agent: "task",
			name: "Abort",
			task: "aborting work",
			contract: { workKey: "abort" },
		} as TaskParams);

		const byWorkKey = new Map(registry.list().map(contract => [contract.workKey, contract.status]));
		expect(byWorkKey.get("ok")).toBe("completed");
		expect(byWorkKey.get("fail")).toBe("failed");
		expect(byWorkKey.get("abort")).toBe("cancelled");

		const observations = recordedObservations(runtime);
		expect(observations).toContainEqual({ scopeId: "scope:map", workKey: "fail", cursor: "failed" });
		expect(observations).toContainEqual({ scopeId: "scope:map", workKey: "abort", cursor: "cancelled" });

		// 每个终态恰好一条宿主观测。
		expect(runtime.recordHostObservation).toHaveBeenCalledTimes(3);
		// failed 携带稳定 failureSignature；cancelled 不伪造 failure；completed 是 evidence 观察。
		const rawObservations = runtime.recordHostObservation.mock.calls.map(
			call => call[0] as Extract<RecordHostObservationInput, { observation: HostObservation }>,
		);
		const observationWith = (workKey: string) =>
			rawObservations.find(call => call.observation.workKey === workKey)!.observation;
		const failed = observationWith("fail");
		expect(failed.type).toBe("failure");
		if (!("failureSignature" in failed)) throw new Error("expected failure observation");
		expect(typeof failed.failureSignature).toBe("string");
		expect(failed.cursor).toBe("failed");
		const cancelled = observationWith("abort");
		expect(cancelled.type).toBe("process_heartbeat");
		if (!("live" in cancelled)) throw new Error("expected process_heartbeat observation");
		expect(cancelled.live).toBe(false);
		expect("failureSignature" in cancelled).toBe(false);
		expect(cancelled.cursor).toBe("cancelled");
		const completed = observationWith("ok");
		expect(completed.type).toBe("evidence");
		if (!("evidenceId" in completed) || !("receiptRef" in completed))
			throw new Error("expected evidence observation");
		expect(completed.evidenceId).toBe(completed.receiptRef);
		expect(completed.cursor).toBe("completed");
	});

	it("regression: with the real runtime the first spawn is admitted (spawn=1) and a same-identity second call still spawns once", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const { runtime, taskRegistry, scopeId } = createRealRuntime();
		const handle = runtime.getScope(scopeId)!;
		// 工具自身不得创建/切换/释放 scope 或 runtime。
		const startScopeSpy = vi.spyOn(runtime, "startScope");
		const syncBranchSpy = vi.spyOn(runtime, "syncBranch");
		const finishScopeSpy = vi.spyOn(runtime, "finishScope");
		const disposeSpy = vi.spyOn(runtime, "dispose");
		const tool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => scopeId,
				executionRuntime: runtime as unknown as FakeRuntime,
				taskContractRegistry: taskRegistry,
			}),
		);
		const params = {
			agent: "task",
			task: "first work",
			contract: { workKey: "first" },
		} as TaskParams;

		// 首个 identity：scheduler 在 admit 之前初始化，seed 不含刚 admit 的
		// contract——绝不能把第一次 spawn 误判为 duplicate。
		const first = await tool.execute("tc-real-1", params);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(getFirstText(first)).not.toContain("Reused task contract");
		const admitted = taskRegistry.list(scopeId);
		expect(admitted).toHaveLength(1);
		expect(admitted[0]!.status).toBe("completed");
		// settle 恰好一次：ledger 里恰好一条 progress 观测，cursor=completed。
		const firstProgress = handle.snapshot().progress;
		expect(firstProgress).toHaveLength(1);
		expect(firstProgress[0]!.cursor).toBe("completed");

		// 同 identity 第二次：总 spawn 数保持 1，contract 复用且不新增收尾观测。
		const second = await tool.execute("tc-real-2", params);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(getFirstText(second)).toContain("Reused task contract");
		expect(handle.snapshot().progress).toHaveLength(1);
		expect(taskRegistry.list(scopeId)).toHaveLength(1);

		// 工具从未触碰 runtime 所有权操作。
		expect(startScopeSpy).not.toHaveBeenCalled();
		expect(syncBranchSpy).not.toHaveBeenCalled();
		expect(finishScopeSpy).not.toHaveBeenCalled();
		expect(disposeSpy).not.toHaveBeenCalled();
	});

	it("reuses a watchdog duplicate decision without spawning", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const registry = createTaskContractRegistry({ rootSessionId: "root-session" });

		// reuse_duplicate：宿主已有完全相同的 assignment 在执行。
		const reuseScheduler = createFakeScheduler("reuse_duplicate");
		const reuseRuntime = createFakeRuntime({ schedulerFor: vi.fn(() => reuseScheduler) });
		const reuseTool = await TaskTool.create(
			createSession({
				getExecutionScopeId: () => "scope:enforce",
				executionRuntime: reuseRuntime,
				taskContractRegistry: registry,
			}),
		);
		const reuseResult = await reuseTool.execute("tc-reuse", {
			agent: "task",
			task: "enforced work",
			contract: { workKey: "enforced" },
		} as TaskParams);

		expect(runSpy).not.toHaveBeenCalled();
		expect(getFirstText(reuseResult)).toContain("Reused task contract");
		expect(reuseRuntime.schedulerFor).toHaveBeenCalledWith("scope:enforce");
		expect(reuseScheduler.enforce).toHaveBeenCalledTimes(1);
		const enforcedInput = reuseScheduler.enforce.mock.calls[0]?.[0];
		expect(enforcedInput.observation).toMatchObject({
			workKey: "enforced",
			strategyKey: "strategy:task",
			assignmentId: expect.stringMatching(/^contract:/),
			requestKind: "assignment",
			duplicateCandidate: true,
		});
	});

	it("passes the runtime and exact scope id into every child createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const runtime = createFakeRuntime();

		const result = await runSubprocess({
			...baseOptions,
			executionRuntime: runtime as unknown as ExecutionRuntime,
			executionScopeId: "scope:child",
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.executionRuntime).toBe(runtime as unknown as ExecutionRuntime);
		expect(forwarded?.executionScopeId).toBe("scope:child");
	});

	it("forwards undefined runtime wiring when the parent has none", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.executionRuntime).toBeUndefined();
		expect(forwarded?.executionScopeId).toBeUndefined();
	});
});
