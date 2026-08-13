import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { createExecutionRuntime, type ExecutionRuntime } from "@san/coding-agent/execution-control/execution-runtime";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import { TaskContractRegistry } from "@san/coding-agent/execution-control/task-contract";
import type { Skill } from "@san/coding-agent/extensibility/skills";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import {
	CONTRACT_ECHO_MESSAGE_TYPE,
	SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

function evidenceSkill(): Skill {
	return {
		name: "fix-bug",
		description: "Fix a reported bug.",
		filePath: "/nonexistent/fix-bug/SKILL.md",
		baseDir: "/nonexistent/fix-bug",
		source: "test",
		evidence: [
			{ id: "repro", phase: "before-fix", kind: "command", expect: "fail", description: "failing repro" },
			{
				id: "verify",
				phase: "before-done",
				kind: "command",
				expect: "pass",
				sameAs: "repro",
				description: "same command passes",
			},
		],
	};
}

describe("AgentSession general contract echo", () => {
	let session: AgentSession;
	let runtime: ExecutionRuntime;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	async function createSession(
		options: { settings?: Settings; skills?: Skill[]; agentKind?: "main" | "sub" } = {},
	): Promise<void> {
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
		const rootSessionId = sessionManager.getSessionId() || "contract-echo-test-session";
		runtime = createExecutionRuntime({
			rootSessionId,
			branchEntries: sessionManager.getBranch(),
			sessionManager,
			taskRegistry: new TaskContractRegistry({ rootSessionId }),
			providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
			now: () => new Date().toISOString(),
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: options.settings ?? Settings.isolated(),
			modelRegistry,
			executionRuntime: runtime,
			skills: options.skills,
			agentKind: options.agentKind,
		});
	}

	function generalEchoes(): Array<{ content: unknown; details: unknown }> {
		const echoes: Array<{ content: unknown; details: unknown }> = [];
		for (const message of session.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== CONTRACT_ECHO_MESSAGE_TYPE) continue;
			echoes.push({ content: message.content, details: message.details });
		}
		return echoes;
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-contract-echo-test-${Snowflake.next()}`);
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

	it("echoes the working agreement exactly once, on the first authoritative turn", async () => {
		await createSession();
		await session.prompt("重构 parser 模块,保持所有测试通过");
		const echoes = generalEchoes();
		expect(echoes).toHaveLength(1);
		expect(String(echoes[0].content)).toContain("重构 parser 模块");
		// The echo is bound to the minted scope contract, not free-floating text.
		const details = echoes[0].details as { contractId?: string; contractHash?: string };
		expect(details.contractId).toBeDefined();
		expect(details.contractHash).toBeDefined();

		await session.prompt("接着做下一步");
		expect(generalEchoes()).toHaveLength(1);
	});

	it("orders the echo after the user message that minted the scope", async () => {
		await createSession();
		await session.prompt("修复登录超时问题");
		const messages = session.agent.state.messages;
		const userIndex = messages.findIndex(message => message.role === "user");
		const echoIndex = messages.findIndex(
			message => message.role === "custom" && message.customType === CONTRACT_ECHO_MESSAGE_TYPE,
		);
		expect(userIndex).toBeGreaterThanOrEqual(0);
		expect(echoIndex).toBeGreaterThan(userIndex);
	});

	it("never echoes in subagent sessions, even with an owned runtime that mints scopes", async () => {
		// Regression: a taskDepth>0 session created without a fixed parent scope
		// owns its runtime and mints scopes like a root — but its "user" is the
		// orchestrating parent agent, so the working-agreement echo must never
		// enter the provider message stream (it corrupted append-only prefix
		// expectations in the subagent message pipeline).
		await createSession({ agentKind: "sub" });
		await session.prompt("subagent objective");
		expect(generalEchoes()).toHaveLength(0);
	});

	it("stays silent when san.contractEcho.firstTurn is disabled", async () => {
		await createSession({ settings: Settings.isolated({ "san.contractEcho.firstTurn": false }) });
		await session.prompt("重构 parser 模块");
		expect(generalEchoes()).toHaveLength(0);
	});

	it("defers to an existing skill contract echo instead of stacking a second agreement", async () => {
		await createSession({ skills: [evidenceSkill()] });
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill body for fix-bug",
			display: true,
			details: { name: "fix-bug", path: "/nonexistent/fix-bug/SKILL.md", args: "the parser crashes", lineCount: 1 },
			attribution: "user",
		});
		const skillEchoes = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
		);
		expect(skillEchoes).toHaveLength(1);

		await session.prompt("继续修这个 bug");
		expect(generalEchoes()).toHaveLength(0);
	});
});
