/**
 * AgentSession ⇄ ExecutionRuntime 接线聚焦测试。
 *
 * 覆盖宿主持有的生命周期契约：
 * - 真实宿主用户 turn 的首次 provider 派发之前，scope 已创建（绝不推迟到派发之后）。
 * - 每个真实顶层用户 turn 各自 mint 独立 authoritative scope，用户消息 entry id
 *   作为 host evidence ref 写入 objective contract。
 * - 两个并发 root 会话各自持有独立 runtime/scope，证据互不可见（无全局 active scope）。
 * - `completed` 仅凭经 host verifier 验证的 required evidence gates 迁移；无 gate
 *   或 gate 未满足时 scope 保持运行，正常完成也不会迁移。
 * - 用户 abort 以 aborted_by_user 终结 scope；abort 之后迟到的 provider 响应不能
 *   复活或重复终结已终态 scope。
 * - 真实分支切换调用 runtime.syncBranch；切换之后到达的旧分支 provider terminal
 *   对新分支零写入。
 * - read-only 会话与固定 scope 子会话零 scope 写入（不 mint / 不 finish / 不 sync）。
 * - runtime 所有权：创建它的 root 会话在 dispose 时释放（幂等）；采纳的子会话
 *   绝不 dispose 共享 runtime。
 *
 * 前半部分使用匹配冻结 ExecutionRuntime 契约的结构化 test double；后半部分驱动
 * 真实 runtime + ProviderHealthRegistry，钉死晚到 terminal 的路由保证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@san/agent";
import { AssistantMessageEventStream } from "@san/ai/utils/event-stream";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";
import {
	createExecutionRuntime,
	EXECUTION_SCOPE_CUSTOM_TYPE,
	type ExecutionRuntime,
	ProviderHealthRegistry,
	providerHealthKeyFromModel,
	TaskContractRegistry,
} from "../../src/execution-control";
import type { SessionEntry } from "../../src/session/session-entries";
import { createAssistantMessage } from "../helpers/agent-session-setup";

// ---------------------------------------------------------------------------
// 冻结 ExecutionRuntime 契约的结构化 test double
// ---------------------------------------------------------------------------

interface FakeGate {
	required?: boolean;
	status: "pass" | "fail";
	evidenceRefs: string[];
}

interface FakeSnapshot {
	readonly revision: number;
	readonly state: string;
	readonly gates: readonly FakeGate[];
}

interface FakeLedger {
	readonly revision: number;
}

interface FakeScopeHandle {
	scopeId: string;
	rootSessionId: string;
	logicalTurnId: string;
	objectiveContract: unknown;
	ledger: FakeLedger;
	snapshot(): FakeSnapshot;
}

class FakeExecutionRuntime {
	readonly calls: string[] = [];
	startScopeCalls: Array<{ rootSessionId?: string; logicalTurnId?: string; objectiveContract?: unknown }> = [];
	finishScopeCalls: Array<{ scopeId: string; outcome: { expectedRevision?: number; state?: string } }> = [];
	syncBranchCalls = 0;
	disposeCalls = 0;
	revision = 0;
	activeScopeIdValue: string | undefined;
	/** 快照里的 evidence gates；会话的 `completed` 迁移据此裁决。 */
	gates: FakeGate[] = [];

	constructor(
		readonly rootSessionId: string,
		readonly scopeId: string = `scope-${Snowflake.next()}`,
	) {}

	startScope(request: {
		rootSessionId?: string;
		logicalTurnId?: string;
		objectiveContract?: unknown;
	}): FakeScopeHandle {
		this.calls.push("startScope");
		this.startScopeCalls.push(request);
		this.activeScopeIdValue = this.scopeId;
		this.revision += 1;
		return this.#handle(request);
	}

	activeScopeId(): string | undefined {
		return this.activeScopeIdValue;
	}

	getScope(scopeId: string): FakeScopeHandle | undefined {
		if (scopeId !== this.scopeId) return undefined;
		this.calls.push("getScope");
		return this.#handle();
	}

	#handle(request: { logicalTurnId?: string; objectiveContract?: unknown } = {}): FakeScopeHandle {
		return {
			scopeId: this.scopeId,
			rootSessionId: this.rootSessionId,
			logicalTurnId: request.logicalTurnId ?? "",
			objectiveContract: request.objectiveContract,
			ledger: { revision: this.revision },
			snapshot: () => ({ revision: this.revision, state: "running", gates: [...this.gates] }),
		};
	}

	recordHostObservation(_observation: unknown): void {
		this.calls.push("recordHostObservation");
	}

	recordProviderSnapshot(_snapshot: unknown): void {
		this.calls.push("recordProviderSnapshot");
	}

	syncBranch(_entries?: unknown): void {
		this.calls.push("syncBranch");
		this.syncBranchCalls += 1;
	}

	finishScope(scopeId: string, outcome: { expectedRevision?: number; state?: string }) {
		this.calls.push("finishScope");
		this.finishScopeCalls.push({ scopeId, outcome });
		if (this.activeScopeIdValue !== undefined && scopeId === this.activeScopeIdValue) {
			this.activeScopeIdValue = undefined;
		}
		return { accepted: true, duplicate: false, revision: this.revision };
	}

	dispose(): void {
		this.calls.push("dispose");
		this.disposeCalls += 1;
	}
}

/** 仅在 AgentSession 构造边界把结构化 test double 适配为冻结的 runtime 契约。 */
function asExecutionRuntime(runtime: FakeExecutionRuntime | undefined): ExecutionRuntime | undefined {
	return runtime as unknown as ExecutionRuntime | undefined;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const originalSchedulerWait = scheduler.wait.bind(scheduler);
function collapseSchedulerSettleDelays(): void {
	vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
}

/** 提取分支 journal 里 execution-scope 自定义记录的 record.type 序列。 */
function executionScopeRecordTypes(entries: readonly SessionEntry[]): string[] {
	const types: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== EXECUTION_SCOPE_CUSTOM_TYPE) continue;
		const data =
			typeof entry.data === "string"
				? (JSON.parse(entry.data) as { record?: { type?: string } })
				: (entry.data as { record?: { type?: string } });
		types.push(data.record?.type ?? "unknown");
	}
	return types;
}

describe("AgentSession execution-runtime wiring", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		collapseSchedulerSettleDelays();
		tempDir = path.join(os.tmpdir(), `pi-session-runtime-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
	});

	interface CreateSessionOptions {
		runtime?: FakeExecutionRuntime;
		ownedRuntime?: FakeExecutionRuntime;
		fixedScopeId?: string;
		sessionAccess?: "read_write" | "read_only";
		streamFn?: (callIndex: number, abortSignal: AbortSignal | undefined, stream: AssistantMessageEventStream) => void;
	}

	async function createSession(options: CreateSessionOptions = {}): Promise<FakeExecutionRuntime | undefined> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;
		let callIndex = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: (_model, _context, streamOptions) => {
				abortSignal = streamOptions?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (abortSignal) {
						abortSignal.addEventListener(
							"abort",
							() => {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							},
							{ once: true },
						);
					}
					options.streamFn?.(callIndex, abortSignal, stream);
					callIndex += 1;
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			executionRuntime: asExecutionRuntime(options.runtime),
			ownedExecutionRuntime: asExecutionRuntime(options.ownedRuntime),
			executionScopeId: options.fixedScopeId,
			sessionAccess: options.sessionAccess,
		});

		// 必须订阅才能启用 session journal 持久化（与 branching 套件同约定）：
		// 用户 entry id 是接线必须捕获的 host evidence ref，因此 journal 在这些
		// 测试里必须实时可用。
		session.subscribe(() => {});

		return options.runtime;
	}

	// 以 1ms tick 轮询异步条件。AgentSession 测试套件普遍使用该模式（见
	// agent-session-concurrent.test.ts）：agent 的事件流与后提示续跑是真实异步
	// 机制，fake timers 无法确定性驱动；tick 只在条件未满足时自旋，健康运行
	// 约等 1ms 而非整个超时。
	async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(1);
		}
		throw new Error("Timed out waiting for condition");
	}

	// ------------------------------------------------------------------
	// 只读访问器（已落地的接线）
	// ------------------------------------------------------------------

	it("exposes the shared runtime and fixed scope through read-only accessors", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		await createSession({ runtime, ownedRuntime: runtime, fixedScopeId: "fixed-scope-1" });

		expect(session.getExecutionRuntime()).toBe(asExecutionRuntime(runtime));
		expect(session.getExecutionScopeId()).toBe("fixed-scope-1");
		// 固定 scope 优先于 runtime 的 active scope，作为会话身份。
		runtime.activeScopeIdValue = "active-scope-x";
		expect(session.getActiveExecutionScopeId()).toBe("fixed-scope-1");
	});

	it("active scope id falls back to the runtime's active scope when no fixed scope is set", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		await createSession({ runtime });
		runtime.activeScopeIdValue = "active-scope-x";

		expect(session.getExecutionScopeId()).toBeUndefined();
		expect(session.getActiveExecutionScopeId()).toBe("active-scope-x");
	});

	// ------------------------------------------------------------------
	// 所有权 / dispose（已落地的接线）
	// ------------------------------------------------------------------

	it("root session dispose releases the owned runtime exactly once", async () => {
		const owned = new FakeExecutionRuntime("root-session");
		await createSession({ runtime: owned, ownedRuntime: owned });

		await session.dispose();

		expect(owned.disposeCalls).toBe(1);
		// 再次 dispose 安全（拥有方视角幂等）。
		await session.dispose();
		expect(owned.disposeCalls).toBe(1);
	});

	it("adopted child session never disposes the shared runtime", async () => {
		const shared = new FakeExecutionRuntime("parent-root", "parent-scope");
		await createSession({ runtime: shared, ownedRuntime: undefined, fixedScopeId: "parent-scope" });

		await session.dispose();

		expect(shared.disposeCalls).toBe(0);
		expect(session.getActiveExecutionScopeId()).toBe("parent-scope");
	});

	// ------------------------------------------------------------------
	// 首次 provider 派发之前的 scope 创建
	// ------------------------------------------------------------------

	it("creates the root scope before the first provider dispatch and records the user evidence ref", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		let dispatchSawScope = false;
		let dispatchScopeId: string | undefined;

		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				dispatchSawScope = runtime.startScopeCalls.length === 1 && runtime.activeScopeIdValue !== undefined;
				dispatchScopeId = runtime.activeScopeIdValue;
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Hello!") });
			},
		});

		const promptPromise = session.prompt("Hello");
		await promptPromise;
		await session.waitForIdle();

		// provider stream 被调用之前 scope 已存在。
		expect(dispatchSawScope).toBe(true);
		expect(dispatchScopeId).toBe(runtime.scopeId);
		expect(runtime.startScopeCalls).toHaveLength(1);
		expect(runtime.startScopeCalls[0]?.rootSessionId).toBe("root-session");
		// scope 以 authoritative 用户 turn 作为 objective contract 来源。
		const objectiveContract = runtime.startScopeCalls[0]?.objectiveContract as
			| { source?: string; authoritativeUserTurnId?: string }
			| undefined;
		expect(objectiveContract?.source).toBe("authoritative_user");
		expect(objectiveContract?.authoritativeUserTurnId).toBeTruthy();
		// 用户消息 entry id 即 host evidence ref（已持久化进 journal）。
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);
		expect(objectiveContract?.authoritativeUserTurnId).toBe(userMessages[0]?.entryId);
		expect(session.getActiveExecutionScopeId()).toBe(runtime.scopeId);
	});

	it("each real top-level user turn mints its own authoritative scope", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		let streamCount = 0;

		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				streamCount += 1;
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			},
		});

		await session.prompt("First");
		await session.waitForIdle();
		expect(runtime.startScopeCalls).toHaveLength(1);

		// 第二个真实用户 turn 是独立 authoritative turn：即使上一 scope 仍
		// active（evidence gate 未满足），也 mint 新 scope，绝不复用。
		await session.prompt("Second");
		await session.waitForIdle();

		expect(runtime.startScopeCalls).toHaveLength(2);
		expect(streamCount).toBe(2);
		const firstTurnId = runtime.startScopeCalls[0]?.logicalTurnId;
		const secondTurnId = runtime.startScopeCalls[1]?.logicalTurnId;
		expect(firstTurnId).toBeTruthy();
		expect(secondTurnId).toBeTruthy();
		expect(secondTurnId).not.toBe(firstTurnId);
	});

	// ------------------------------------------------------------------
	// 并发 root 隔离
	// ------------------------------------------------------------------

	it("two concurrent root sessions never share evidence or scope identity", async () => {
		const runtimeA = new FakeExecutionRuntime("root-a");
		const runtimeB = new FakeExecutionRuntime("root-b");
		let sessionA: AgentSession | undefined;
		let sessionB: AgentSession | undefined;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		async function buildSession(runtime: FakeExecutionRuntime): Promise<AgentSession> {
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: (_m, _c, _o) => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					});
					return stream;
				},
			});
			const s = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				executionRuntime: asExecutionRuntime(runtime),
				ownedExecutionRuntime: asExecutionRuntime(runtime),
			});
			s.subscribe(() => {});
			return s;
		}

		try {
			sessionA = await buildSession(runtimeA);
			sessionB = await buildSession(runtimeB);

			await Promise.all([sessionA.prompt("A's task"), sessionB.prompt("B's task")]);
			await Promise.all([sessionA.waitForIdle(), sessionB.waitForIdle()]);

			// 每个 root 只 mint 自己的 scope；身份绝不串用。
			expect(runtimeA.startScopeCalls).toHaveLength(1);
			expect(runtimeB.startScopeCalls).toHaveLength(1);
			expect(runtimeA.scopeId).not.toBe(runtimeB.scopeId);
			expect(runtimeA.startScopeCalls[0]?.logicalTurnId).not.toBe(runtimeB.startScopeCalls[0]?.logicalTurnId);
			expect(sessionA.getActiveExecutionScopeId()).toBe(runtimeA.scopeId);
			expect(sessionB.getActiveExecutionScopeId()).toBe(runtimeB.scopeId);
		} finally {
			await sessionA?.dispose();
			await sessionB?.dispose();
		}
	});

	// ------------------------------------------------------------------
	// completed 迁移的 evidence gate
	// ------------------------------------------------------------------

	it("does not finish the scope when no required evidence gates exist", async () => {
		const runtime = new FakeExecutionRuntime("root-session");

		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			},
		});

		await session.prompt("Hello");
		await session.waitForIdle();

		// assistant 文本不是 evidence：缺 gate 不是用户错误，scope 保持运行。
		expect(runtime.finishScopeCalls).toHaveLength(0);
		expect(runtime.activeScopeIdValue).toBe(runtime.scopeId);
	});

	it("does not finish the scope while a required gate is unsatisfied", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		runtime.gates = [{ required: true, status: "fail", evidenceRefs: [] }];

		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			},
		});

		await session.prompt("Hello");
		await session.waitForIdle();

		expect(runtime.finishScopeCalls).toHaveLength(0);
		expect(runtime.activeScopeIdValue).toBe(runtime.scopeId);
	});

	it("finishes the scope with completed once every required gate passes with evidence", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		runtime.gates = [{ required: true, status: "pass", evidenceRefs: ["host:verifier:1"] }];

		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			},
		});

		await session.prompt("Hello");
		await session.waitForIdle();

		expect(runtime.finishScopeCalls).toHaveLength(1);
		expect(runtime.finishScopeCalls[0]?.scopeId).toBe(runtime.scopeId);
		expect(runtime.finishScopeCalls[0]?.outcome?.state).toBe("completed");
		expect(runtime.finishScopeCalls[0]?.outcome?.expectedRevision).toBeTypeOf("number");
	});

	// ------------------------------------------------------------------
	// Abort 终态 CAS
	// ------------------------------------------------------------------

	it("user abort finishes the scope terminally; a late provider response cannot revive it", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		let firstStream: AssistantMessageEventStream | undefined;
		let lateDelivery: (() => void) | undefined;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_m, _c, options) => {
				const stream = new AssistantMessageEventStream();
				options?.signal?.addEventListener(
					"abort",
					() => {
						stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
					},
					{ once: true },
				);
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// 慢 provider：turn 保持打开直到测试解析它。
					lateDelivery = () => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Late success") });
					};
				});
				firstStream = stream;
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			executionRuntime: asExecutionRuntime(runtime),
			ownedExecutionRuntime: asExecutionRuntime(runtime),
		});
		session.subscribe(() => {});

		const promptPromise = session.prompt("Do the thing");
		await waitFor(() => runtime.startScopeCalls.length === 1 && firstStream !== undefined);

		// 宿主 abort 执行。
		await session.abort();
		await promptPromise.catch(() => {});
		await session.waitForIdle();

		// scope 恰好终结一次，终态为 abort。
		expect(runtime.finishScopeCalls).toHaveLength(1);
		expect(runtime.finishScopeCalls[0]?.scopeId).toBe(runtime.scopeId);
		expect(runtime.finishScopeCalls[0]?.outcome?.state).toBe("aborted_by_user");
		expect(runtime.finishScopeCalls[0]?.outcome?.expectedRevision).toBeTypeOf("number");

		// abort 之后迟到的 provider 响应不得再 mint 新 scope 或重复终结。
		lateDelivery?.();
		await waitFor(() => !session.isStreaming);
		expect(runtime.finishScopeCalls).toHaveLength(1);
		expect(runtime.startScopeCalls).toHaveLength(1);
	});

	it("internal manual-compaction abort preserves the active execution scope", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		let streamStarted = false;
		await createSession({
			runtime,
			streamFn: () => {
				streamStarted = true;
			},
		});

		const promptPromise = session.prompt("Compact while working");
		await waitFor(() => streamStarted && runtime.activeScopeIdValue !== undefined);

		await session.abort({ goalReason: "internal", preserveCompaction: true });
		await promptPromise.catch(() => {});
		await session.waitForIdle();

		expect(runtime.startScopeCalls).toHaveLength(1);
		expect(runtime.finishScopeCalls).toHaveLength(0);
		expect(runtime.activeScopeIdValue).toBe(runtime.scopeId);
	});

	// ------------------------------------------------------------------
	// 分支同步
	// ------------------------------------------------------------------

	it("calls runtime.syncBranch after a real branch switch", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		let doneFirst = false;
		await createSession({
			runtime,
			streamFn: (_callIndex, _abortSignal, stream) => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage(doneFirst ? "Second" : "First"),
				});
				doneFirst = true;
			},
		});

		await session.prompt("First");
		await session.waitForIdle();
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);
		expect(runtime.syncBranchCalls).toBe(0);

		// 真实分支切换：历史回退到第一条用户消息。
		const result = await session.branch(userMessages[0]!.entryId);
		expect(result.cancelled).toBe(false);
		expect(runtime.syncBranchCalls).toBe(1);
	});

	it("read-only session paths never call runtime.syncBranch", async () => {
		const runtime = new FakeExecutionRuntime("root-session");
		await createSession({ runtime, sessionAccess: "read_only" });

		// 只读历史展示触碰 journal，但 execution control 必须零写入：
		// 不 sync、不 mint scope、不记录观察。
		const messages = session.getUserMessagesForBranching();
		expect(messages).toBeDefined();
		expect(runtime.syncBranchCalls).toBe(0);
		expect(runtime.startScopeCalls).toHaveLength(0);
		expect(runtime.calls).not.toContain("recordHostObservation");
	});

	// ------------------------------------------------------------------
	// 固定 scope 子会话
	// ------------------------------------------------------------------

	it("fixed-scope child sessions never mint, finish, or sync scopes", async () => {
		const runtime = new FakeExecutionRuntime("root-session", "parent-scope");
		await createSession({
			runtime,
			fixedScopeId: "parent-scope",
			streamFn: (_callIndex, _abortSignal, stream) => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			},
		});

		await session.prompt("Child work");
		await session.waitForIdle();

		expect(runtime.startScopeCalls).toHaveLength(0);
		expect(runtime.finishScopeCalls).toHaveLength(0);
		expect(runtime.syncBranchCalls).toBe(0);
		expect(runtime.calls).not.toContain("recordHostObservation");
		expect(session.getActiveExecutionScopeId()).toBe("parent-scope");
	});

	// ------------------------------------------------------------------
	// 真实 runtime + ProviderHealthRegistry 路由
	// ------------------------------------------------------------------

	describe("real runtime and provider registry routing", () => {
		it("a late old-branch provider terminal writes zero records into the new branch", async () => {
			const sessionManager = SessionManager.inMemory();
			const providerRegistry = new ProviderHealthRegistry();
			const taskRegistry = new TaskContractRegistry({ rootSessionId: sessionManager.getSessionId() });
			const runtime = createExecutionRuntime({
				rootSessionId: sessionManager.getSessionId(),
				branchEntries: sessionManager.getBranch(),
				sessionManager,
				taskRegistry,
				providerRegistry,
			});
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const key = providerHealthKeyFromModel(model);

			const heldStreams: AssistantMessageEventStream[] = [];
			let callIndex = 0;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				// 模拟 SDK 的 providerHealthStreamFn：每个 provider 派发先以
				// 唯一 requestId 向 runtime 登记（任何网络工作之前），再经
				// ProviderHealthRegistry 派发并透传 requestId。
				streamFn: (streamModel, _context, streamOptions) => {
					const requestId = Snowflake.next();
					const scopeId = runtime.activeScopeId();
					if (scopeId !== undefined) runtime.registerProviderDispatch(scopeId, requestId);
					return providerRegistry.dispatchStream(
						{
							key: providerHealthKeyFromModel(streamModel),
							sessionId: sessionManager.getSessionId(),
							signal: streamOptions?.signal,
							requestId,
						},
						() => {
							const stream = new AssistantMessageEventStream();
							callIndex += 1;
							queueMicrotask(() => {
								stream.push({ type: "start", partial: createAssistantMessage("") });
								if (callIndex === 1) {
									stream.push({
										type: "done",
										reason: "stop",
										message: createAssistantMessage("First"),
									});
								} else {
									heldStreams.push(stream);
								}
							});
							return stream;
						},
					);
				},
			});

			const settings = Settings.isolated();
			const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
			authStorages.push(authStorage);
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,
				executionRuntime: runtime,
				ownedExecutionRuntime: runtime,
			});
			session.subscribe(() => {});

			// turn 1：正常 terminal 经 registry 路由进 scope 1 的 ledger，
			// 并随订阅持久化进当前分支 journal（正控制）。
			await session.prompt("First task");
			await session.waitForIdle();
			expect(executionScopeRecordTypes(sessionManager.getBranch())).toContain("provider_health_recorded");
			expect(providerRegistry.getSnapshot(key).state).toBe("closed");

			// turn 2：新 authoritative turn 的 scope 2；stream 保持打开。
			const secondPrompt = session.prompt("Second task");
			await waitFor(() => heldStreams.length === 1 && runtime.activeScopeId() !== undefined);

			// 真实分支切换：rewind 到第一条用户消息并重同步 runtime；requestId
			// 注册随分支拆除清空，新分支 journal 不含任何 execution-scope 记录。
			const userMessages = session.getUserMessagesForBranching();
			const result = await session.branch(userMessages[0]!.entryId);
			expect(result.cancelled).toBe(false);
			expect(runtime.activeScopeId()).toBeUndefined();

			// 旧分支请求的 terminal 迟到：事件确实到达 registry（健康状态已
			// 闭环），但捕获关系已拆除，不得猜测进新分支——journal 零写入。
			heldStreams[0]!.push({ type: "done", reason: "stop", message: createAssistantMessage("Late") });
			// 等真实信号而非固定延时：secondPrompt 解析意味着镜像 done 已流过
			// registry（terminal 发布在镜像之前同步完成），waitForIdle 再兜底
			// 会话侧后提示任务。
			await secondPrompt.catch(() => {});
			await session.waitForIdle();
			expect(executionScopeRecordTypes(sessionManager.getBranch())).toHaveLength(0);
			expect(providerRegistry.getSnapshot(key).state).toBe("closed");
		});
	});
});
