/**
 * 契约：`session.messages.list` 从已持久化的会话正文投影历史对话。
 * 事件日志只覆盖当前 Runtime，CLI 创建的会话在 sync 后 events 为空，
 * 客户端只能靠这个方法补齐历史，因此投影必须剔除内部注入消息、
 * 与 `message.completed` 用同一套正文规则，并支持游标分页。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@san/ai";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { RpcV2SessionManager } from "@san/coding-agent/modes/rpc-v2/session-manager";
import { createAgentSession } from "@san/coding-agent/sdk";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeWithRetries } from "@san/utils";

const tempDirectories: string[] = [];
const authStorages: AuthStorage[] = [];

interface MessagesFixture {
	manager: RpcV2SessionManager;
	session: AgentSession;
	sessionId: string;
}

async function createMessagesFixture(): Promise<MessagesFixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-messages-"));
	tempDirectories.push(directory);
	const authStorage = await AuthStorage.create(path.join(directory, "auth.db"));
	authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
	const created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage,
		modelRegistry,
		model: getBundledModel("openai", "gpt-4o-mini"),
		sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	const manager = new RpcV2SessionManager({
		runtimeId: "runtime_messages",
		initialHandle: { session: created.session },
	});
	const opened = await manager.create({ cwd: directory });
	return { manager, session: created.session, sessionId: opened.sessionId };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

afterEach(async () => {
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

describe("RPC v2 session.messages.list", () => {
	test("projects visible user and assistant turns in transcript order", async () => {
		const { manager, session, sessionId } = await createMessagesFixture();
		try {
			session.sessionManager.appendMessage({ role: "user", content: "第一个请求", timestamp: 1_700_000_000_000 });
			session.sessionManager.appendMessage(assistantMessage("第一个回答", 1_700_000_001_000));

			const result = await manager.listMessages({ sessionId });

			expect(result.total).toBe(2);
			expect(result.nextCursor).toBeNull();
			expect(
				result.messages.map(message => ({
					role: message.role,
					timestamp: message.timestamp,
					content: message.content,
				})),
			).toEqual([
				{ role: "user", timestamp: new Date(1_700_000_000_000).toISOString(), content: "第一个请求" },
				{ role: "assistant", timestamp: new Date(1_700_000_001_000).toISOString(), content: "第一个回答" },
			]);
			for (const message of result.messages) expect(message.entryId).toBeString();
		} finally {
			await manager.close({ abortRunning: true });
			await session.dispose();
		}
	});

	test("drops synthetic, steering, tool-result, and empty-text messages", async () => {
		const { manager, session, sessionId } = await createMessagesFixture();
		try {
			session.sessionManager.appendMessage({ role: "user", content: "真实请求", timestamp: 1_700_000_000_000 });
			session.sessionManager.appendMessage({
				role: "user",
				content: "auto-continue",
				timestamp: 1_700_000_000_100,
				synthetic: true,
			});
			session.sessionManager.appendMessage({
				role: "user",
				content: "插话",
				timestamp: 1_700_000_000_200,
				steering: true,
			});
			session.sessionManager.appendMessage({ role: "user", content: [], timestamp: 1_700_000_000_300 });
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "工具输出" }],
				isError: false,
				timestamp: 1_700_000_000_400,
			});

			const result = await manager.listMessages({ sessionId });

			expect(result.messages.map(message => message.content)).toEqual(["真实请求"]);
			expect(result.total).toBe(1);
		} finally {
			await manager.close({ abortRunning: true });
			await session.dispose();
		}
	});

	test("pages through the transcript with an opaque cursor", async () => {
		const { manager, session, sessionId } = await createMessagesFixture();
		try {
			for (let index = 0; index < 5; index++) {
				session.sessionManager.appendMessage({
					role: "user",
					content: `请求 ${index}`,
					timestamp: 1_700_000_000_000 + index,
				});
			}

			const first = await manager.listMessages({ sessionId, limit: 2 });
			expect(first.messages.map(message => message.content)).toEqual(["请求 0", "请求 1"]);
			expect(first.total).toBe(5);
			expect(first.nextCursor).not.toBeNull();

			const second = await manager.listMessages({ sessionId, limit: 2, cursor: first.nextCursor ?? undefined });
			expect(second.messages.map(message => message.content)).toEqual(["请求 2", "请求 3"]);

			const third = await manager.listMessages({ sessionId, limit: 2, cursor: second.nextCursor ?? undefined });
			expect(third.messages.map(message => message.content)).toEqual(["请求 4"]);
			expect(third.nextCursor).toBeNull();
		} finally {
			await manager.close({ abortRunning: true });
			await session.dispose();
		}
	});

	test("rejects a sessionId that is not the active Session", async () => {
		const { manager, session, sessionId } = await createMessagesFixture();
		try {
			await expect(manager.listMessages({ sessionId: `${sessionId}_other` })).rejects.toThrow(
				/is not the active Session/,
			);
		} finally {
			await manager.close({ abortRunning: true });
			await session.dispose();
		}
	});
});
