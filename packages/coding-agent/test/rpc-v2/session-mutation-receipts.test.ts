import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { leasePathForSession } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/crash-recovery";
import type { ApprovalRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/dto/approval";
import { newApprovalId, newRunId } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/ids";
import { RpcV2SessionManager } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/session-manager";
import { rpcV2StatePaths } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/state-store";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];
const authStorages: AuthStorage[] = [];

interface ManagedFixture {
	manager: RpcV2SessionManager;
	session: AgentSession;
	sessionId: string;
}

async function createManagedFixture(): Promise<ManagedFixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-receipt-"));
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
		runtimeId: "runtime_receipt",
		initialHandle: { session: created.session },
	});
	const opened = await manager.create({ cwd: directory });
	return { manager, session: created.session, sessionId: opened.sessionId };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

describe("RPC v2 atomic Session mutation receipts", () => {
	test("persists the run.start result with the accepted Run state", async () => {
		const { manager, session, sessionId } = await createManagedFixture();

		try {
			const active = manager.assertSession(sessionId);
			const params = { method: "run.start", params: { content: [{ type: "text", text: "hello" }] } };
			const accepted = await manager.acceptRun(active, undefined, [], { key: "run-key", params });
			const expected = {
				runId: accepted.runId,
				operationId: accepted.operationId,
				acceptedAt: accepted.acceptedAt,
			};

			expect(manager.checkIdempotency("run-key", params)).toEqual({ cached: true, result: expected });
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("RPC Session was not persisted");
			const state = (await Bun.file(rpcV2StatePaths(sessionFile).state).json()) as {
				activeRun?: { runId?: string };
				receipts?: Array<{ key?: string; result?: unknown }>;
			};
			expect(state.activeRun?.runId).toBe(accepted.runId);
			expect(state.receipts?.find(receipt => receipt.key === "run-key")?.result).toEqual(expected);
		} finally {
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});

	test("persists the queue.cancel result with the cancelled item", async () => {
		const { manager, session, sessionId } = await createManagedFixture();
		try {
			const active = manager.assertSession(sessionId);
			const item = await manager.addQueueItem(active, [{ type: "text", text: "queued request" }]);
			const params = { method: "queue.cancel", params: { queueItemId: item.queueItemId } };
			const result = await manager.cancelQueueItem(active, item.queueItemId, "queued", undefined, {
				key: "queue-key",
				params,
			});

			expect(result.item.status).toBe("cancelled");
			expect(manager.checkIdempotency("queue-key", params)).toEqual({ cached: true, result });
		} finally {
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});

	test("persists the approval.decide result with the resolved approval", async () => {
		const { manager, session, sessionId } = await createManagedFixture();
		try {
			const active = manager.assertSession(sessionId);
			const approval: ApprovalRequest = {
				schemaVersion: 1,
				approvalId: newApprovalId(),
				sessionId: active.sessionId,
				runId: newRunId(),
				requestAction: "tool_execute",
				createdAt: new Date().toISOString(),
				status: "pending",
				title: "Approve write",
				summary: "Write a file",
				risk: { tier: "write", level: "medium", irreversible: false, reasons: [] },
				targets: [],
				policySnapshot: { source: "session", effectiveDecision: "ask", canPersistRule: true },
				allowedDecisions: ["allow", "deny"],
				allowedScopes: ["once", "session"],
				fingerprint: "sha256:approval",
				invalidation: [],
			};
			await manager.registerApproval(active, approval);
			const params = { method: "approval.decide", params: { approvalId: approval.approvalId } };
			const result = {
				resolved: true,
				approvalId: approval.approvalId,
				decision: "allow" as const,
				scope: "once" as const,
			};
			await manager.resolveApproval(active, approval.approvalId, "allow", "once", false, {
				key: "approval-key",
				params,
				result,
			});

			expect(manager.pendingApprovals).toEqual([]);
			expect(manager.checkIdempotency("approval-key", params)).toEqual({ cached: true, result });
		} finally {
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});

	test("forces shutdown after the requested graceful timeout", async () => {
		const { manager, session, sessionId } = await createManagedFixture();
		const abortBlocker = Promise.withResolvers<void>();
		try {
			await manager.acceptRun(manager.assertSession(sessionId));
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("RPC Session was not persisted");
			vi.spyOn(session, "abort").mockImplementation(() => abortBlocker.promise);

			await manager.shutdown({ timeoutMs: 0 });

			expect(manager.currentSession).toBeUndefined();
			expect(await Bun.file(leasePathForSession(sessionFile)).exists()).toBe(false);
		} finally {
			abortBlocker.resolve();
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});
});
