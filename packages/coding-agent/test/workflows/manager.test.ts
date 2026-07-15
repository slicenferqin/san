import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	type AdHocWorkflowDraft,
	type DiscoveredWorkflowSource,
	type ManagedWorkflow,
	parseManagedWorkflow,
	rebuildWorkflowLedger,
	type WorkflowAgentBridge,
	type WorkflowAgentRequest,
	type WorkflowAgentResult,
	WorkflowManager,
	WorkflowManagerConflictError,
	WorkflowStore,
	workflowSourceHash,
	workflowValueHash,
} from "@oh-my-pi/pi-coding-agent/workflows";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;
let store: WorkflowStore | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@san-workflow-manager-");
	store = new WorkflowStore(tempDir.join("workflows.sqlite"));
});

afterEach(async () => {
	store?.close();
	store = null;
	if (tempDir) await tempDir.remove().catch(() => {});
	tempDir = null;
});

function requiredStore(): WorkflowStore {
	if (!store) throw new Error("Workflow test store is not initialized.");
	return store;
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function agentResult(request: WorkflowAgentRequest, value = request.prompt): WorkflowAgentResult {
	return {
		agentId: `agent-${request.nodeId}`,
		value,
		text: typeof value === "string" ? value : JSON.stringify(value),
		usage: usage(12),
		durationMs: 2,
	};
}

function managedSource(body = 'phase("inspect"); return await agent("audit release");'): string {
	return `export const meta = {
	name: "release-audit",
	description: "Audit a release",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["branch"],
		properties: { branch: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 1000, durationMs: 60000 },
};
${body}`;
}

function managedWorkflow(body?: string): ManagedWorkflow {
	const sourceText = managedSource(body);
	const source: DiscoveredWorkflowSource = {
		name: "release-audit",
		path: "/repo/.san/workflows/release-audit.js",
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		provider: "san",
		level: "project",
		scopeKey: "/repo",
		directoryDepth: 0,
	};
	return parseManagedWorkflow(source);
}

function adHocSource(name = "audit-routes", body = 'return await agent("audit routes");'): string {
	return `export const meta = {
	name: ${JSON.stringify(name)},
	description: "Audit routes once",
	version: "1",
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 1000, durationMs: 60000 },
};
${body}`;
}

function adHocDraft(overrides: Partial<AdHocWorkflowDraft> & { sourceText?: string } = {}): AdHocWorkflowDraft {
	const sourceText = overrides.sourceText ?? adHocSource(overrides.name);
	const permissions = { writeMode: "read_only" as const, tools: ["grep", "read", "yield"] };
	const limits = { concurrency: 2, agentLimit: 8, tokenLimit: 1000, durationMs: 60_000 };
	return {
		kind: "ad_hoc",
		draftId: "draft-1",
		taskRef: "task-1",
		name: "audit-routes",
		description: "Audit routes once",
		humanSummary: "Inspect the current task routes once.",
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		argsHash: workflowValueHash(null),
		argsSchemaHash: workflowValueHash(null),
		permissions,
		permissionManifestHash: workflowValueHash(permissions),
		limits,
		scopeKey: "/repo",
		createdAt: "2026-07-11T00:00:00.000Z",
		expiresAt: "2026-07-11T02:00:00.000Z",
		status: "draft",
		...overrides,
	};
}

interface ManagerHarness {
	manager: WorkflowManager;
	session: SessionManager;
	contexts: Array<{ workflowKind: "managed" | "ad_hoc"; scopeKey: string }>;
}

function managerHarness(bridge: WorkflowAgentBridge): ManagerHarness {
	const session = SessionManager.inMemory("/repo");
	const contexts: ManagerHarness["contexts"] = [];
	let id = 0;
	let tick = 0;
	const manager = new WorkflowManager({
		store: requiredStore(),
		sessionManager: session,
		bridgeFactory: context => {
			contexts.push({ workflowKind: context.workflowKind, scopeKey: context.scopeKey });
			return bridge;
		},
		now: () => new Date(Date.parse("2026-07-11T00:10:00.000Z") + tick++),
		idFactory: kind => `${kind}-${++id}`,
	});
	return { manager, session, contexts };
}

describe("WorkflowManager Managed runs", () => {
	it("starts only an explicitly requested exact approved version and delivers its result once", async () => {
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return agentResult(request, "release-ok");
			},
		};
		const { manager, session, contexts } = managerHarness(bridge);
		const workflow = managedWorkflow();

		expect(() =>
			manager.startManaged({ name: "release-audit", version: "1", scopeKey: "/repo", args: { branch: "main" } }),
		).toThrow(WorkflowManagerConflictError);
		expect(calls).toBe(0);

		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		expect(calls).toBe(0);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		const completed = await handle.completion;

		expect(completed).toMatchObject({
			status: "completed",
			workflowKind: "managed",
			workflowVersion: "1",
			result: "release-ok",
			budget: { agentsStarted: 1, agentsCompleted: 1, tokensUsed: 12 },
		});
		expect(contexts).toEqual([{ workflowKind: "managed", scopeKey: "/repo" }]);
		expect(manager.deliverResult(handle.runId)).toBe("release-ok");
		expect(() => manager.deliverResult(handle.runId)).toThrow("already delivered");

		const ledger = rebuildWorkflowLedger(session.getEntries());
		const run = ledger.runs.get(handle.runId);
		expect(run?.events.map(entry => entry.data.type)).toEqual([
			"run_approved",
			"run_started",
			"phase_started",
			"node_scheduled",
			"agent_started",
			"agent_completed",
			"node_committed",
			"run_completed",
			"result_delivery_prepared",
			"result_delivered",
		]);
		expect(run).toMatchObject({
			status: "completed",
			deliveryState: "delivered",
			invalidSequenceEventIds: [],
			invalidTransitionEventIds: [],
			duplicateDeliveryEventIds: [],
		});
	});

	it("validates Managed arguments before creating a bridge, run or agent", () => {
		let calls = 0;
		const { manager, session, contexts } = managerHarness({
			run: async request => {
				calls++;
				return agentResult(request);
			},
		});
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);

		expect(() =>
			manager.startManaged({ name: "release-audit", version: "1", scopeKey: "/repo", args: { wrong: true } }),
		).toThrow("args.branch is required");
		expect(calls).toBe(0);
		expect(contexts).toEqual([]);
		expect(rebuildWorkflowLedger(session.getEntries()).runs.size).toBe(0);
	});

	it("replays a prepared result delivery until the consumer acknowledges output", async () => {
		const { manager, session } = managerHarness({
			run: async request => agentResult(request, "durable-result"),
		});
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await handle.completion;
		const prepared = manager.prepareResultDelivery(handle.runId);
		expect(manager.getRun(handle.runId)?.deliveryState).toBe("delivering");

		let id = 0;
		const restored = new WorkflowManager({
			store: requiredStore(),
			sessionManager: session,
			bridgeFactory: () => ({ run: async request => agentResult(request, "unexpected") }),
			idFactory: kind => `delivery-${kind}-${++id}`,
		});
		const replayed = restored.prepareResultDelivery(handle.runId);
		expect(replayed).toEqual(prepared);
		restored.acknowledgeResultDelivery(handle.runId, replayed.deliveryId);
		expect(restored.getRun(handle.runId)?.deliveryState).toBe("delivered");
	});

	it("fails without committing provider usage above the hard token allocation", async () => {
		const { manager } = managerHarness({
			run: async request => ({ ...agentResult(request), usage: usage(request.remainingTokenBudget + 1) }),
		});
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);

		const failed = await manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		}).completion;

		expect(failed).toMatchObject({
			status: "failed",
			budget: { agentsStarted: 1, agentsCompleted: 0, tokensUsed: 1_001 },
		});
		expect(failed.error).toContain("token allocation");
	});
});

describe("WorkflowManager Ad-hoc runs", () => {
	it("records expiry in the session ledger before deleting one-time draft content", () => {
		const { manager, session } = managerHarness({ run: async request => agentResult(request) });
		const draft = manager.saveAdHocDraft(adHocDraft({ expiresAt: "2026-07-11T00:09:00.000Z" }));

		expect(manager.cleanupExpiredAdHocDrafts(draft.taskRef, draft.scopeKey)).toBe(1);
		expect(requiredStore().getAdHocDraft(draft.draftId)).toBeUndefined();
		const lifecycle = rebuildWorkflowLedger(session.getEntries()).events.find(
			entry => entry.data.type === "draft_expired",
		);
		expect(lifecycle?.data.payload).toMatchObject({
			draftId: draft.draftId,
			taskRef: draft.taskRef,
			sourceHash: draft.sourceHash,
		});
	});

	it("binds approval to one draft, task and scope, then atomically consumes it for one run", async () => {
		let calls = 0;
		const { manager, session } = managerHarness({
			run: async request => {
				calls++;
				return agentResult(request, "routes-ok");
			},
		});
		const first = manager.saveAdHocDraft(adHocDraft());
		const second = manager.saveAdHocDraft(
			adHocDraft({
				draftId: "draft-2",
				taskRef: "task-2",
				createdAt: "2026-07-11T00:01:00.000Z",
				expiresAt: "2026-07-11T02:01:00.000Z",
			}),
		);
		const approval = manager.approveAdHocDraft(first);

		expect(() =>
			manager.startAdHoc({
				draftId: second.draftId,
				approvalId: approval.approvalId,
				taskRef: second.taskRef,
				scopeKey: second.scopeKey,
			}),
		).toThrow("no valid approval");
		expect(() =>
			manager.startAdHoc({
				draftId: first.draftId,
				approvalId: approval.approvalId,
				taskRef: "another-task",
				scopeKey: first.scopeKey,
			}),
		).toThrow("different task");
		expect(calls).toBe(0);

		const handle = manager.startAdHoc({
			draftId: first.draftId,
			approvalId: approval.approvalId,
			taskRef: first.taskRef,
			scopeKey: first.scopeKey,
		});
		expect((await handle.completion).status).toBe("completed");
		expect(calls).toBe(1);
		expect(requiredStore().getAdHocDraft(first.draftId)).toBeUndefined();
		expect(requiredStore().getApproval(approval.approvalId)).toBeUndefined();
		expect(() =>
			manager.startAdHoc({
				draftId: first.draftId,
				approvalId: approval.approvalId,
				taskRef: first.taskRef,
				scopeKey: first.scopeKey,
			}),
		).toThrow("does not exist");
		expect(calls).toBe(1);

		const run = rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId);
		expect(run?.status).toBe("completed");
		expect(run?.invalidTransitionEventIds).toEqual([]);
	});

	it("rejects an unsafe approved draft before consuming approval or starting an agent", () => {
		let calls = 0;
		const { manager, session, contexts } = managerHarness({
			run: async request => {
				calls++;
				return agentResult(request);
			},
		});
		const unsafe = manager.saveAdHocDraft(
			adHocDraft({ sourceText: adHocSource("audit-routes", "return process.env;") }),
		);
		expect(() => manager.approveAdHocDraft(unsafe)).toThrow("source is unsafe");
		// Simulate an unsafe approval persisted by an older or lower-level caller;
		// the run boundary must still fail closed before consuming it.
		const approval = requiredStore().approveAdHocDraft(unsafe, new Date("2026-07-11T00:10:00.000Z"));

		expect(() =>
			manager.startAdHoc({
				draftId: unsafe.draftId,
				approvalId: approval.approvalId,
				taskRef: unsafe.taskRef,
				scopeKey: unsafe.scopeKey,
			}),
		).toThrow("source is unsafe");
		expect(calls).toBe(0);
		expect(contexts).toEqual([]);
		expect(requiredStore().findAdHocApproval(unsafe, new Date("2026-07-11T00:20:00.000Z"))).toBeDefined();
		expect(requiredStore().getAdHocDraft(unsafe.draftId)?.status).toBe("approved");
		expect(rebuildWorkflowLedger(session.getEntries()).runs.size).toBe(0);
	});
});

describe("WorkflowManager live controls", () => {
	it("stops one active Agent by stable node id without cancelling sibling work", async () => {
		const bothStarted = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const nodePrompts = new Map<string, string>();
		let started = 0;
		const { manager } = managerHarness({
			run: async request => {
				nodePrompts.set(request.nodeId, request.prompt);
				started++;
				if (started === 2) bothStarted.resolve();
				const gate = request.prompt === "keep" ? releaseSibling.promise : Promise.withResolvers<void>().promise;
				const aborted = Promise.withResolvers<void>();
				const onAbort = () => aborted.reject(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([gate, aborted.promise]);
					return agentResult(request, "kept");
				} finally {
					request.signal.removeEventListener("abort", onAbort);
				}
			},
		});
		const workflow = managedWorkflow('return await parallel([() => agent("stop"), () => agent("keep")]);');
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await bothStarted.promise;
		const run = manager.getRun(handle.runId);
		const stopped = run?.nodes.find(node => node.status === "running");
		if (!stopped) throw new Error("Expected an active Workflow node");
		const sibling = run?.nodes.find(node => node.status === "running" && node.nodeId !== stopped.nodeId);
		if (!sibling) throw new Error("Expected a second active Workflow node");

		const nodeToCancel = run?.nodes.find(
			node => node.status === "running" && nodePrompts.get(node.nodeId) === "stop",
		);
		if (!nodeToCancel) throw new Error("Expected the selected active Workflow node");
		expect(manager.cancelNode(handle.runId, nodeToCancel.nodeId)).toBe(true);
		releaseSibling.resolve();
		const settled = await handle.completion;

		expect(settled.status).toBe("cancelled");
		expect(settled.nodes.some(node => node.status === "completed")).toBe(true);
		expect(manager.cancelNode(handle.runId, nodeToCancel.nodeId)).toBe(false);
	});

	it("cancels all live runs before an owning session switch", async () => {
		const started = Promise.withResolvers<void>();
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				started.resolve();
				const aborted = Promise.withResolvers<WorkflowAgentResult>();
				const onAbort = () => aborted.reject(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				try {
					return await aborted.promise;
				} finally {
					request.signal.removeEventListener("abort", onAbort);
				}
			},
		};
		const { manager, session } = managerHarness(bridge);
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await started.promise;

		expect(manager.cancelLiveRuns()).toBe(1);
		expect((await handle.completion).status).toBe("cancelled");
		expect(manager.cancelLiveRuns()).toBe(0);
		expect(rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId)?.status).toBe("cancelled");
	});

	it("resumes a durable checkpoint after its owning session runtime is rebuilt", async () => {
		const secondStarted = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const firstBridge: WorkflowAgentBridge = {
			run: async request => {
				prompts.push(request.prompt);
				if (request.prompt === "first") return agentResult(request);
				secondStarted.resolve();
				const aborted = Promise.withResolvers<WorkflowAgentResult>();
				const onAbort = () => aborted.reject(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				try {
					return await aborted.promise;
				} finally {
					request.signal.removeEventListener("abort", onAbort);
				}
			},
		};
		const { manager, session } = managerHarness(firstBridge);
		const workflow = managedWorkflow(
			'const first = await agent("first"); const second = await agent("second"); return [first, second];',
		);
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await secondStarted.promise;

		expect(manager.suspendLiveRuns()).toBe(1);
		expect((await handle.completion).status).toBe("paused");

		let id = 0;
		const restored = new WorkflowManager({
			store: requiredStore(),
			sessionManager: session,
			bridgeFactory: () => ({
				run: async request => {
					prompts.push(request.prompt);
					return agentResult(request);
				},
			}),
			idFactory: kind => `restored-${kind}-${++id}`,
		});
		expect(restored.getRun(handle.runId)?.status).toBe("paused");
		expect(restored.resume(handle.runId)).toBe(true);
		const completed = await restored.completion(handle.runId);

		expect(completed).toMatchObject({
			status: "completed",
			result: ["first", "second"],
			budget: { agentsStarted: 3, agentsCompleted: 2, tokensUsed: 24 },
		});
		expect(prompts).toEqual(["first", "second", "second"]);
	});

	it("pauses before the next node and resumes without repeating the completed node", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const { manager, session } = managerHarness({
			run: async request => {
				prompts.push(request.prompt);
				if (request.prompt === "first") {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return agentResult(request);
			},
		});
		const workflow = managedWorkflow(
			'const first = await agent("first"); const second = await agent("second"); return [first, second];',
		);
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await firstStarted.promise;

		expect(manager.pause(handle.runId)).toBe(true);
		releaseFirst.resolve();
		await Bun.sleep(10);
		expect(prompts).toEqual(["first"]);
		expect(manager.getRun(handle.runId)?.status).toBe("paused");
		expect(manager.resume(handle.runId)).toBe(true);
		const completed = await handle.completion;

		expect(completed.status).toBe("completed");
		expect(prompts).toEqual(["first", "second"]);
		expect(completed.nodes.map(node => node.callId)).toHaveLength(2);
		const run = rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId);
		expect(run?.events.map(entry => entry.data.type)).toContain("run_paused");
		expect(run?.events.map(entry => entry.data.type)).toContain("run_resumed");
		expect(run?.invalidTransitionEventIds).toEqual([]);
	});

	it("cancels an active run without reporting it as completed", async () => {
		const started = Promise.withResolvers<void>();
		const { manager, session } = managerHarness({
			run: async request => {
				started.resolve();
				const aborted = Promise.withResolvers<void>();
				request.signal.addEventListener("abort", () => aborted.reject(request.signal.reason), { once: true });
				await aborted.promise;
				return agentResult(request, "unexpected");
			},
		});
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await started.promise;

		expect(manager.cancel(handle.runId)).toBe(true);
		const cancelled = await handle.completion;

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.result).toBeUndefined();
		expect(() => manager.deliverResult(handle.runId)).toThrow("no completed result");
		const run = rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId);
		expect(run?.status).toBe("cancelled");
		expect(run?.events.map(entry => entry.data.type)).not.toContain("run_completed");
		expect(run?.invalidTransitionEventIds).toEqual([]);
	});

	it("records a host safety stop as blocked instead of failed or completed", async () => {
		const started = Promise.withResolvers<void>();
		const { manager, session } = managerHarness({
			run: async request => {
				started.resolve();
				const aborted = Promise.withResolvers<void>();
				request.signal.addEventListener("abort", () => aborted.reject(request.signal.reason), { once: true });
				await aborted.promise;
				return agentResult(request, "unexpected");
			},
		});
		const workflow = managedWorkflow();
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({
			name: "release-audit",
			version: "1",
			scopeKey: "/repo",
			args: { branch: "main" },
		});
		await started.promise;

		expect(manager.block(handle.runId, "approved scope became unsafe")).toBe(true);
		const blocked = await handle.completion;

		expect(blocked).toMatchObject({
			status: "blocked",
			error: "approved scope became unsafe",
			nodes: [{ status: "blocked", error: "approved scope became unsafe" }],
		});
		const run = rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId);
		expect(run?.status).toBe("blocked");
		expect(run?.events.map(entry => entry.data.type)).not.toContain("run_failed");
		expect(run?.invalidTransitionEventIds).toEqual([]);
	});
});
