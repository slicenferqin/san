/**
 * Resume × execution-scope terminal-state regression.
 *
 * Journal replay can restore a scope that is already terminal (e.g.
 * aborted_by_user from a previous process), while the session's in-memory
 * one-shot finish guard starts empty. A late finish attempt must be an
 * idempotent no-op — not a TerminalExecutionStateError that breaks
 * newSession/abort on --continue'd sessions (observed live: RPC new_session
 * failing instantly with "late finish events are rejected").
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import {
	createExecutionRuntime,
	type ExecutionRuntime,
} from "@san/coding-agent/execution-control/execution-runtime";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import { TaskContractRegistry } from "@san/coding-agent/execution-control/task-contract";
import type { ImmutableObjectiveContract } from "@san/coding-agent/execution-control/types";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

const CONTRACT: ImmutableObjectiveContract = {
	ref: {
		contractId: "contract:resume-terminal-test",
		revision: 1,
		contractHash: "sha256:resume-terminal-test",
		clauseRefs: ["clause:resume-terminal-test"],
	},
	authoritativeUserTurnId: "turn:resume-terminal-test",
	source: "authoritative_user",
};

describe("AgentSession resume with terminal execution scope", () => {
	let session: AgentSession;
	let runtime: ExecutionRuntime;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-resume-terminal-${Snowflake.next()}`);
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

	it("treats a late finish against a replay-restored terminal scope as an idempotent no-op", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const sessionManager = SessionManager.inMemory();
		const rootSessionId = sessionManager.getSessionId() || "resume-terminal-session";
		runtime = createExecutionRuntime({
			rootSessionId,
			branchEntries: sessionManager.getBranch(),
			sessionManager,
			taskRegistry: new TaskContractRegistry({ rootSessionId }),
			providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
			now: () => new Date().toISOString(),
		});
		// Simulate the post-replay state: the active scope is already terminal
		// (a previous process aborted it), but this session's in-memory
		// one-shot guard has never seen it.
		const { scopeId } = runtime.startScope({
			rootSessionId,
			logicalTurnId: "turn:aborted-previously",
			objectiveContract: CONTRACT,
		});
		const revision = runtime.getScope(scopeId)?.snapshot().revision;
		if (revision === undefined) throw new Error("scope must exist");
		runtime.finishScope(scopeId, { expectedRevision: revision, state: "aborted_by_user" });

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			executionRuntime: runtime,
		});

		// Before the fix this rejected with TerminalExecutionStateError
		// ("late finish events are rejected") out of newSession's internal
		// abort → finish path.
		const switched = await session.newSession();
		expect(switched).toBe(true);

		// The scope stays exactly as replay restored it: terminal, aborted.
		expect(runtime.getScope(scopeId)?.snapshot().state).toBe("aborted_by_user");
	});
});
