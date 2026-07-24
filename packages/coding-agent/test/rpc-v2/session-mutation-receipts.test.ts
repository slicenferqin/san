import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireLease, leasePathForSession } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/crash-recovery";
import type { ApprovalRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/dto/approval";
import type { InputResourceRef } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/dto/resources";
import { newApprovalId, newResourceId, newRunId } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/ids";
import { RpcV2SessionManager } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/session-manager";
import { RpcV2StateStore, rpcV2StatePaths } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/state-store";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionListing from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];
const authStorages: AuthStorage[] = [];

interface ManagedFixture {
	manager: RpcV2SessionManager;
	session: AgentSession;
	sessionId: string;
	directory: string;
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
	return { manager, session: created.session, sessionId: opened.sessionId, directory };
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

	test("keeps deferred queued resources through promotion and releases cancelled content", async () => {
		const { manager, session, sessionId } = await createManagedFixture();
		const released: string[][] = [];
		try {
			const active = manager.assertSession(sessionId);
			const promotedResource: InputResourceRef = {
				resourceId: newResourceId(),
				sessionId: active.sessionId,
				source: "upload",
				mediaType: "text/plain",
				byteLength: 1,
				sha256: "promoted",
				state: "committed",
			};
			const cancelledResource: InputResourceRef = {
				resourceId: newResourceId(),
				sessionId: active.sessionId,
				source: "upload",
				mediaType: "text/plain",
				byteLength: 1,
				sha256: "cancelled",
				state: "committed",
			};
			manager.setResourceReleaseHandler(async resourceIds => {
				released.push([...resourceIds]);
			});
			manager.setContentResolver(async ({ content }) => ({
				text: content.map(part => (part.type === "text" ? part.text : part.resource.resourceId)).join("\n"),
				images: [],
				resourceIds: content.flatMap(part => (part.type === "text" ? [] : [part.resource.resourceId])),
			}));
			vi.spyOn(session, "prompt").mockResolvedValue(true);

			await manager.acceptRun(active);
			const promoted = await manager.addQueueItem(active, [
				{ type: "resource", resource: promotedResource, purpose: "input" },
			]);
			const cancelled = await manager.addQueueItem(active, [
				{ type: "resource", resource: cancelledResource, purpose: "input" },
			]);
			expect(await manager.deferResourceRelease(active, promotedResource.resourceId)).toBe(true);
			expect(await manager.deferResourceRelease(active, cancelledResource.resourceId)).toBe(true);

			await manager.cancelQueueItem(active, cancelled.queueItemId, "queued");
			await manager.markRunStatus(active, "completed");
			expect(released).toEqual([[cancelledResource.resourceId]]);

			await manager.promoteQueueIfIdle(active);
			expect(promoted.status).toBe("promoted");
			expect(released).toEqual([[cancelledResource.resourceId]]);
			await manager.markRunStatus(active, "completed");
			expect(released).toEqual([[cancelledResource.resourceId], [promotedResource.resourceId]]);

			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("RPC Session was not persisted");
			const persisted = await new RpcV2StateStore(sessionFile, sessionId).load();
			const cancelledState = persisted.state.queue.find(item => item.queueItemId === cancelled.queueItemId);
			expect(cancelledState?.content).toEqual([]);
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

	test("persists interrupted Run and resource ownership after read-only recovery", async () => {
		const { manager, session, sessionId, directory } = await createManagedFixture();
		let recoveryManager: RpcV2SessionManager | undefined;
		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("RPC Session was not persisted");
			await manager.shutdown({ force: true });

			const store = new RpcV2StateStore(sessionFile, sessionId);
			const loaded = await store.load();
			const interruptedRunId = newRunId();
			const resourceId = newResourceId();
			loaded.state.activeRun = {
				runId: interruptedRunId,
				userMessageId: "msg_interrupted",
				status: "running",
			};
			loaded.state.lastRun = undefined;
			loaded.state.activeResourceIds = [resourceId];
			loaded.state.pendingResourceReleases = [];
			await store.saveState(loaded.state);
			await acquireLease(sessionFile, {
				leaseId: "lease_stale",
				runtimeId: "runtime_stale",
				pid: 2_147_483_647,
				sessionId,
				acquiredAt: "2026-07-24T00:00:00.000Z",
				lastHeartbeat: "2026-07-24T00:00:00.000Z",
				lastStableSequence: loaded.state.lastSequence,
			});
			vi.spyOn(sessionListing, "listAllSessions").mockResolvedValue([
				{
					path: sessionFile,
					id: sessionId,
					cwd: directory,
					created: new Date("2026-07-24T00:00:00.000Z"),
					modified: new Date("2026-07-24T00:00:00.000Z"),
					messageCount: 0,
					size: Bun.file(sessionFile).size,
					firstMessage: "",
					allMessagesText: "",
				},
			]);

			recoveryManager = new RpcV2SessionManager({
				runtimeId: "runtime_recovery",
				initialHandle: { session },
			});
			const opened = await recoveryManager.open({ sessionId, access: "read_write" });
			expect(opened.recovery).toMatchObject({ required: true, reason: "runtime_crash" });
			await recoveryManager.recover(recoveryManager.assertSession(sessionId), "read_only");

			const recovered = await new RpcV2StateStore(sessionFile, sessionId).load();
			expect(recovered.state.activeRun).toBeUndefined();
			expect(recovered.state.lastRun).toMatchObject({
				runId: interruptedRunId,
				status: "interrupted",
				reason: "runtime_crash",
			});
			expect(recovered.state.activeResourceIds).toEqual([]);
			expect(recovered.state.pendingResourceReleases).toEqual([resourceId]);
			expect(recoveryManager.currentLease).toMatchObject({ access: "read_only", held: false });
		} finally {
			await recoveryManager?.shutdown({ force: true });
			await manager.shutdown({ force: true });
			await session.dispose();
		}
	});
});
