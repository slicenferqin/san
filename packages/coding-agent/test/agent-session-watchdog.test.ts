import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AfterToolCallContext, Agent, type AgentToolCall } from "@san/agent";
import type { AssistantMessage } from "@san/ai";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { createExecutionRuntime, type ExecutionRuntime } from "@san/coding-agent/execution-control/execution-runtime";
import { toolCompletionObservation } from "@san/coding-agent/execution-control/host-observation-adapter";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import { TaskContractRegistry } from "@san/coding-agent/execution-control/task-contract";
import type { ImmutableObjectiveContract } from "@san/coding-agent/execution-control/types";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

const WATCHDOG_MARKER = "[Host progress watchdog";

const CONTRACT: ImmutableObjectiveContract = {
	ref: {
		contractId: "contract:watchdog-test",
		revision: 1,
		contractHash: "sha256:watchdog-test",
		clauseRefs: ["clause:watchdog-test"],
	},
	authoritativeUserTurnId: "turn:watchdog-test",
	source: "authoritative_user",
};

function afterToolCallContext(
	toolName: string,
	args: Record<string, unknown>,
	result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
	isError = false,
): AfterToolCallContext {
	return {
		assistantMessage: { role: "assistant", content: [], timestamp: Date.now() } as unknown as AssistantMessage,
		toolCall: { type: "toolCall", id: `call-${Snowflake.next()}`, name: toolName, arguments: args } as AgentToolCall,
		args,
		result: { content: result.content, details: result.details },
		isError,
		context: {} as AfterToolCallContext["context"],
	};
}

function failingBash(command: string): AfterToolCallContext {
	return afterToolCallContext(
		"bash",
		{ command },
		{ content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
		true,
	);
}

function reminderText(result: ReturnType<NonNullable<Agent["afterToolCall"]>> | undefined): string {
	// The session's afterToolCall hook is synchronous; a promise here would be a contract change.
	if (!result || result instanceof Promise || !result.content) return "";
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("AgentSession host watchdog loop", () => {
	let session: AgentSession;
	let runtime: ExecutionRuntime;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	async function createSession(options: { settings?: Settings; startScope?: boolean } = {}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const rootSessionId = sessionManager.getSessionId() || "watchdog-test-session";
		runtime = createExecutionRuntime({
			rootSessionId,
			branchEntries: sessionManager.getBranch(),
			sessionManager,
			taskRegistry: new TaskContractRegistry({ rootSessionId }),
			providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
			now: () => new Date().toISOString(),
		});
		if (options.startScope !== false) {
			runtime.startScope({
				rootSessionId,
				logicalTurnId: `turn-${Snowflake.next()}`,
				objectiveContract: CONTRACT,
			});
		}
		session = new AgentSession({
			agent,
			sessionManager,
			settings: options.settings ?? Settings.isolated(),
			modelRegistry,
			executionRuntime: runtime,
		});
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-watchdog-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("folds exactly one redirect reminder when the same failing command repeats past the threshold", async () => {
		await createSession();
		const command = "bun test flaky.test.ts";
		const reminders: string[] = [];
		// Default repeat threshold is 3; run enough repeats to cross it and then
		// keep going to prove the reminder never fires twice for one strategy.
		for (let attempt = 0; attempt < 6; attempt++) {
			const folded = session.agent.afterToolCall?.(failingBash(command));
			const text = reminderText(folded);
			if (text.includes(WATCHDOG_MARKER)) reminders.push(text);
		}
		expect(reminders).toHaveLength(1);
		// The reminder must preserve the original tool output after the notice.
		expect(reminders[0]).toContain("1 fail");
	});

	it("does not remind while distinct actions keep making progress", async () => {
		await createSession();
		for (let attempt = 0; attempt < 6; attempt++) {
			const folded = session.agent.afterToolCall?.(
				afterToolCallContext(
					"bash",
					{ command: `echo step-${attempt}` },
					{ content: [{ type: "text", text: `step-${attempt}` }] },
				),
			);
			expect(reminderText(folded)).not.toContain(WATCHDOG_MARKER);
		}
	});

	it("stays inert when san.sessionWatchdog.enabled is off", async () => {
		await createSession({ settings: Settings.isolated({ "san.sessionWatchdog.enabled": false }) });
		for (let attempt = 0; attempt < 6; attempt++) {
			const folded = session.agent.afterToolCall?.(failingBash("bun test flaky.test.ts"));
			expect(reminderText(folded)).not.toContain(WATCHDOG_MARKER);
		}
		const scopeId = runtime.activeScopeId();
		expect(scopeId).toBeDefined();
		// No host observations were recorded either: the ledger holds no progress facts.
		if (scopeId !== undefined) {
			expect(runtime.getScope(scopeId)?.snapshot().progress ?? []).toHaveLength(0);
		}
	});

	it("stays inert without an active execution scope", async () => {
		await createSession({ startScope: false });
		for (let attempt = 0; attempt < 6; attempt++) {
			const folded = session.agent.afterToolCall?.(failingBash("bun test flaky.test.ts"));
			expect(reminderText(folded)).not.toContain(WATCHDOG_MARKER);
		}
	});

	it("records host observations onto the active scope ledger", async () => {
		await createSession();
		session.agent.afterToolCall?.(failingBash("bun test flaky.test.ts"));
		const scopeId = runtime.activeScopeId();
		expect(scopeId).toBeDefined();
		if (scopeId === undefined) return;
		const progress = runtime.getScope(scopeId)?.snapshot().progress ?? [];
		expect(progress.length).toBeGreaterThan(0);
	});
});

describe("toolCompletionObservation edge cases", () => {
	it("ignores timed-out and cancelled bash calls (no completed host fact)", () => {
		expect(
			toolCompletionObservation({
				toolName: "bash",
				args: { command: "sleep 999" },
				isError: true,
				details: { timedOut: true },
				workKey: "w",
			}),
		).toBeUndefined();
		expect(
			toolCompletionObservation({
				toolName: "bash",
				args: { command: "make build" },
				isError: true,
				details: {},
				workKey: "w",
			}),
		).toBeUndefined();
	});

	it("derives a stable failure signature for the same failing command", () => {
		const observe = () =>
			toolCompletionObservation({
				toolName: "bash",
				args: { command: "bun test x.test.ts" },
				isError: true,
				details: { exitCode: 1 },
				workKey: "w",
			});
		const first = observe();
		const second = observe();
		expect(first?.type).toBe("failure");
		const signatureOf = (observation: ReturnType<typeof observe>): string | undefined =>
			observation && "failureSignature" in observation ? observation.failureSignature : undefined;
		expect(signatureOf(first)).toBeDefined();
		expect(signatureOf(second)).toBe(signatureOf(first));
	});
});
