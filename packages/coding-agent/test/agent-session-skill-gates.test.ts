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
import type { SkillEvidenceSpec } from "@san/coding-agent/execution-control/types";
import type { Skill } from "@san/coding-agent/extensibility/skills";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SKILL_CONTRACT_ECHO_MESSAGE_TYPE, SKILL_PROMPT_MESSAGE_TYPE } from "@san/coding-agent/session/messages";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

const FIX_BUG_EVIDENCE: SkillEvidenceSpec[] = [
	{
		id: "repro",
		phase: "before-fix",
		kind: "command",
		expect: "fail",
		description: "minimal failing command",
	},
	{
		id: "verify",
		phase: "before-done",
		kind: "command",
		expect: "pass",
		sameAs: "repro",
		description: "same command flips to passing",
	},
];

function testSkill(overrides: Partial<Skill> = {}): Skill {
	return {
		name: "fix-bug",
		description: "Fix a reported bug.",
		filePath: "/nonexistent/fix-bug/SKILL.md",
		baseDir: "/nonexistent/fix-bug",
		source: "test",
		evidence: FIX_BUG_EVIDENCE,
		...overrides,
	};
}

function skillPromptMessage(name: string, args = "the parser crashes on empty input") {
	return {
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: `Skill body for ${name}`,
		display: true as const,
		details: { name, path: `/nonexistent/${name}/SKILL.md`, args, lineCount: 1 },
		attribution: "user" as const,
	};
}

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

describe("AgentSession skill evidence gates", () => {
	let session: AgentSession;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	async function createSession(options: { skills?: Skill[]; settings?: Settings } = {}): Promise<void> {
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: options.settings ?? Settings.isolated(),
			modelRegistry,
			skills: options.skills ?? [testSkill()],
		});
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-skill-gates-test-${Snowflake.next()}`);
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

	it("activates gates and injects a visible contract echo ahead of the skill prompt", async () => {
		await createSession();
		await session.promptCustomMessage(skillPromptMessage("fix-bug"));

		const state = session.skillGateState;
		expect(state?.hasActiveChains).toBe(true);
		expect(state?.chain("fix-bug")?.gates.map(tracked => tracked.gate.gateId)).toEqual([
			"gate:skill:fix-bug:repro",
			"gate:skill:fix-bug:verify",
		]);

		const messages = session.agent.state.messages;
		const echoIndex = messages.findIndex(
			message => message.role === "custom" && message.customType === SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
		);
		const skillIndex = messages.findIndex(
			message => message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
		);
		expect(echoIndex).toBeGreaterThanOrEqual(0);
		expect(skillIndex).toBeGreaterThan(echoIndex);

		const echo = messages[echoIndex];
		if (echo.role !== "custom") throw new Error("expected custom message");
		expect(echo.display).toBe(true);
		expect(echo.attribution).toBe("agent");
		const text = typeof echo.content === "string" ? echo.content : "";
		// 回显必须携带目标与 before-done 门的人话描述(完成标准);软门与
		// 机制术语(gate id、kind 标签)都不得出现在用户可见文案里。
		expect(text).toContain("the parser crashes on empty input");
		expect(text).toContain("same command flips to passing");
		expect(text).not.toContain("minimal failing command");
		expect(text).not.toContain("[command]");
		expect(state?.chain("fix-bug")?.contractEcho?.text).toBe(text);
	});

	it("re-triggering the same skill does not reset state or duplicate the echo", async () => {
		await createSession();
		await session.promptCustomMessage(skillPromptMessage("fix-bug"));
		session.agent.afterToolCall?.(
			afterToolCallContext(
				"bash",
				{ command: "bun test repro.test.ts" },
				{ content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
				true,
			),
		);
		await session.promptCustomMessage(skillPromptMessage("fix-bug"));

		const echoes = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
		);
		expect(echoes).toHaveLength(1);
		const repro = session.skillGateState?.chain("fix-bug")?.gates.find(tracked => tracked.spec.id === "repro");
		expect(repro?.satisfied).toBe(true);
	});

	it("keeps sessions without evidence skills byte-identical to before: no state, no echo", async () => {
		await createSession({ skills: [testSkill({ evidence: undefined })] });
		await session.promptCustomMessage(skillPromptMessage("fix-bug"));

		expect(session.skillGateState).toBeUndefined();
		const echoes = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
		);
		expect(echoes).toHaveLength(0);
	});

	it("stays inert when skills.evidenceGates is disabled", async () => {
		await createSession({ settings: Settings.isolated({ "skills.evidenceGates": false }) });
		await session.promptCustomMessage(skillPromptMessage("fix-bug"));
		expect(session.skillGateState).toBeUndefined();
	});

	describe("after-tool-call adapter", () => {
		beforeEach(async () => {
			await createSession();
			await session.promptCustomMessage(skillPromptMessage("fix-bug"));
		});

		it("produces a host receipt from a completed failing bash call", () => {
			session.agent.afterToolCall?.(
				afterToolCallContext(
					"bash",
					{ command: "bun test repro.test.ts" },
					{ content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
					true,
				),
			);
			const repro = session.skillGateState?.chain("fix-bug")?.gates.find(tracked => tracked.spec.id === "repro");
			expect(repro?.satisfied).toBe(true);
			expect(repro?.receipts[0]?.exitCode).toBe(1);
			expect(repro?.receipts[0]?.source).toBe("host");
		});

		it("ignores bash calls without a definite exit code (aborted or timed out)", () => {
			session.agent.afterToolCall?.(
				afterToolCallContext(
					"bash",
					{ command: "bun test repro.test.ts" },
					{ content: [{ type: "text", text: "Command aborted" }], details: {} },
					true,
				),
			);
			session.agent.afterToolCall?.(
				afterToolCallContext(
					"bash",
					{ command: "bun test repro.test.ts" },
					{ content: [{ type: "text", text: "timed out" }], details: { exitCode: 137, timedOut: true } },
					true,
				),
			);
			const repro = session.skillGateState?.chain("fix-bug")?.gates.find(tracked => tracked.spec.id === "repro");
			expect(repro?.satisfied).toBe(false);
		});

		it("folds a before-fix reminder into the first file-mutation result only", () => {
			const first = session.agent.afterToolCall?.(
				afterToolCallContext("edit", { path: "src/a.ts" }, { content: [{ type: "text", text: "edited" }] }),
			);
			if (!first || first instanceof Promise) throw new Error("expected synchronous reminder fold");
			const reminderText = first.content?.[0];
			expect(reminderText?.type).toBe("text");
			if (reminderText?.type !== "text") throw new Error("expected text reminder");
			expect(reminderText.text).toContain("repro");
			expect(reminderText.text).toContain("minimal failing command");
			// 原工具输出保留在提醒之后。
			expect(first.content?.[1]).toEqual({ type: "text", text: "edited" });

			const second = session.agent.afterToolCall?.(
				afterToolCallContext("edit", { path: "src/b.ts" }, { content: [{ type: "text", text: "edited" }] }),
			);
			expect(second).toBeUndefined();
		});

		it("does not remind when the before-fix evidence already has a receipt", () => {
			session.agent.afterToolCall?.(
				afterToolCallContext(
					"bash",
					{ command: "bun test repro.test.ts" },
					{ content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
					true,
				),
			);
			const result = session.agent.afterToolCall?.(
				afterToolCallContext("edit", { path: "src/a.ts" }, { content: [{ type: "text", text: "edited" }] }),
			);
			expect(result).toBeUndefined();
		});

		it("does not trigger on non-mutating tools", () => {
			const result = session.agent.afterToolCall?.(
				afterToolCallContext("read", { path: "src/a.ts" }, { content: [{ type: "text", text: "contents" }] }),
			);
			expect(result).toBeUndefined();
			// read 不消耗一次性提醒:随后的 edit 依然收到提醒。
			const edit = session.agent.afterToolCall?.(
				afterToolCallContext("edit", { path: "src/a.ts" }, { content: [{ type: "text", text: "edited" }] }),
			);
			expect(edit).toBeDefined();
		});
	});
});
