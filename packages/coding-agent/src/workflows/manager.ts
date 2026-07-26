import { Snowflake } from "@san/utils";
import type { ReadonlySessionManager } from "../session/session-manager";
import type { WorktreeBaseline } from "../task/worktree";
import {
	applyWorkflowWriteArtifact,
	blockWorkflowWriteArtifact,
	captureWorkflowWriteArtifact,
	rejectWorkflowWriteArtifact,
	reviewWorkflowWriteArtifact,
	type WorkflowWriteArtifactRecord,
	WorkflowWriteDeliveryError,
	type WorkflowWriteReview,
	workflowBaselineHash,
} from "./delivery";
import { workflowValueHash } from "./fingerprint";
import { appendWorkflowEvent } from "./ledger";
import { WorkflowRuntimeControl } from "./runtime/control";
import { RestrictedWorkflowRuntime, WorkflowRuntimeError, type WorkflowRuntimeHooks } from "./runtime/interpreter";
import { assertWorkflowArgs, isWorkflowJsonValue } from "./schema";
import { type ParsedWorkflowSource, parseWorkflowSource } from "./source-parser";
import type {
	ManagedWorkflowVersionRecord,
	WorkflowCompletedCallCheckpoint,
	WorkflowRunCheckpoint,
	WorkflowStore,
} from "./store";
import type {
	AdHocWorkflowDraft,
	ManagedWorkflow,
	WorkflowAgentBridge,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowApprovalRecord,
	WorkflowEvent,
	WorkflowEventType,
	WorkflowJsonValue,
	WorkflowNode,
	WorkflowPermissionManifest,
	WorkflowRun,
	WorkflowRunStatus,
	WorkflowWriteArtifact,
} from "./types";

export class WorkflowManagerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowManagerError";
	}
}

export class WorkflowManagerConflictError extends WorkflowManagerError {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowManagerConflictError";
	}
}

export interface WorkflowBridgeContext {
	runId: string;
	workflowKind: WorkflowRun["workflowKind"];
	workflowName: string;
	sourceHash: string;
	scopeKey: string;
	permissions: WorkflowPermissionManifest;
}

export type WorkflowBridgeFactory = (context: WorkflowBridgeContext) => WorkflowAgentBridge;

export interface WorkflowManagerOptions {
	store: WorkflowStore;
	sessionManager: ReadonlySessionManager;
	bridgeFactory: WorkflowBridgeFactory;
	now?: () => Date;
	idFactory?: (kind: "event" | "run") => string;
	writeReviewTokenFactory?: () => string;
}

export interface StartManagedWorkflowRequest {
	name: string;
	version: string;
	scopeKey: string;
	args?: WorkflowJsonValue;
	signal?: AbortSignal;
}

export interface StartAdHocWorkflowRequest {
	draftId: string;
	approvalId: string;
	/** The current task identity. It must still equal the identity shown during approval. */
	taskRef: string;
	/** The current execution scope. It must still equal the scope shown during approval. */
	scopeKey: string;
	signal?: AbortSignal;
}

export interface WorkflowRunHandle {
	runId: string;
	/** Resolves to the terminal run snapshot; normal Workflow failures are represented by its status and error. */
	completion: Promise<WorkflowRun>;
}

export interface WorkflowWriteReviewHandle extends WorkflowWriteReview {
	runId: string;
}

export interface WorkflowWriteDecision {
	runId: string;
	artifact: WorkflowWriteArtifact;
}

export interface WorkflowResultDelivery {
	deliveryId: string;
	result: WorkflowJsonValue;
}

interface WorkflowExecution {
	run: WorkflowRun;
	sessionId: string;
	sequence: number;
	sourceText: string;
	args?: WorkflowJsonValue;
	permissions: WorkflowPermissionManifest;
	completedCalls: Map<string, WorkflowCompletedCallCheckpoint>;
	control: WorkflowRuntimeControl;
	runtime?: RestrictedWorkflowRuntime;
	completion?: Promise<WorkflowRun>;
	detached?: boolean;
	writeRecords: Map<string, WorkflowWriteArtifactRecord>;
	writeBaseline?: WorktreeBaseline;
	expectedWriteBaseline?: WorktreeBaseline;
	writeRepoRoot?: string;
}

interface StartExecutionOptions {
	runId: string;
	workflowKind: WorkflowRun["workflowKind"];
	workflowName: string;
	workflowVersion?: string;
	sourceText: string;
	sourceHash: string;
	args?: WorkflowJsonValue;
	argsHash: string;
	approval: WorkflowApprovalRecord;
	scopeKey: string;
	permissions: WorkflowPermissionManifest;
	limits: WorkflowRun["budget"]["limits"];
	bridge: WorkflowAgentBridge;
	signal?: AbortSignal;
	startedAt: Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cloneRun(run: WorkflowRun): WorkflowRun {
	return structuredClone(run);
}

function terminal(status: WorkflowRunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function eventPayload(values: Record<string, WorkflowJsonValue | undefined>): Record<string, WorkflowJsonValue> {
	const payload: Record<string, WorkflowJsonValue> = Object.create(null) as Record<string, WorkflowJsonValue>;
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) payload[key] = value;
	}
	return payload;
}

/**
 * Host-owned application layer for the two v0.4 Workflow products.
 *
 * The manager is intentionally triggerless: callers must explicitly publish,
 * approve and start a Managed version, or explicitly approve and start one
 * Ad-hoc draft. It never scans prompts, schedules background runs or promotes a
 * successful draft into a Managed version.
 */
export class WorkflowManager {
	#store: WorkflowStore;
	#sessionManager: ReadonlySessionManager;
	#bridgeFactory: WorkflowBridgeFactory;
	#now: () => Date;
	#idFactory: (kind: "event" | "run") => string;
	#writeReviewTokenFactory: () => string;
	#runs = new Map<string, WorkflowExecution>();

	constructor(options: WorkflowManagerOptions) {
		this.#store = options.store;
		this.#sessionManager = options.sessionManager;
		this.#bridgeFactory = options.bridgeFactory;
		this.#now = options.now ?? (() => new Date());
		this.#idFactory = options.idFactory ?? (kind => `workflow-${kind}-${Snowflake.next()}`);
		this.#writeReviewTokenFactory =
			options.writeReviewTokenFactory ?? (() => `workflow-write-${crypto.randomUUID()}`);
		this.#restoreCheckpoints();
	}

	publishManagedVersion(workflow: ManagedWorkflow): ManagedWorkflowVersionRecord {
		const existing = this.#store.getManagedVersion(
			workflow.meta.name,
			workflow.meta.version,
			workflow.source.scopeKey,
		);
		const published = this.#store.publishManagedVersion(workflow, this.#now());
		if (!existing) {
			this.#appendLifecycleEvent("version_published", {
				name: workflow.meta.name,
				version: workflow.meta.version,
				sourceHash: workflow.sourceHash,
				scopeKey: workflow.source.scopeKey,
			});
		}
		return published;
	}

	approveManagedVersion(workflow: ManagedWorkflow): WorkflowApprovalRecord {
		return this.#store.approveManagedVersion(workflow, this.#now());
	}

	revokeManagedVersion(workflow: ManagedWorkflow): boolean {
		const revoked = this.#store.revokeManagedVersion(workflow, this.#now());
		if (revoked) {
			this.#appendLifecycleEvent("version_revoked", {
				name: workflow.meta.name,
				version: workflow.meta.version,
				sourceHash: workflow.sourceHash,
				scopeKey: workflow.source.scopeKey,
			});
		}
		return revoked;
	}

	saveAdHocDraft(draft: AdHocWorkflowDraft): AdHocWorkflowDraft {
		const existing = this.#store.getAdHocDraft(draft.draftId);
		const saved = this.#store.saveAdHocDraft(draft);
		if (!existing) {
			this.#appendLifecycleEvent("draft_created", {
				draftId: saved.draftId,
				taskRef: saved.taskRef,
				name: saved.name,
				sourceHash: saved.sourceHash,
				scopeKey: saved.scopeKey,
				expiresAt: saved.expiresAt,
			});
		}
		return saved;
	}

	approveAdHocDraft(draft: AdHocWorkflowDraft): WorkflowApprovalRecord {
		this.cleanupExpiredAdHocDrafts(draft.taskRef, draft.scopeKey);
		this.#assertAdHocSource(draft);
		this.#assertArgs(draft.args, draft.argsSchema);
		return this.#store.approveAdHocDraft(draft, this.#now());
	}

	rejectAdHocDraft(draftId: string, replacementDraftId?: string): AdHocWorkflowDraft {
		const before = this.#store.getAdHocDraft(draftId);
		if (before) this.cleanupExpiredAdHocDrafts(before.taskRef, before.scopeKey);
		const rejected = this.#store.rejectAdHocDraftAndDelete(draftId, this.#now());
		if (before?.status !== "rejected") {
			this.#appendLifecycleEvent("draft_rejected", {
				draftId: rejected.draftId,
				taskRef: rejected.taskRef,
				name: rejected.name,
				sourceHash: rejected.sourceHash,
				...(replacementDraftId ? { replacementDraftId } : {}),
			});
		}
		return rejected;
	}

	startManaged(request: StartManagedWorkflowRequest): WorkflowRunHandle {
		const startedAt = this.#validNow();
		const version = this.#store.getManagedVersion(request.name, request.version, request.scopeKey);
		if (!version || version.revokedAt) {
			throw new WorkflowManagerConflictError(
				`Managed Workflow ${request.name}@${request.version} is not an active published version in this scope.`,
			);
		}
		const workflow = version.workflow;
		this.#assertSourceSafe(workflow.sourceText);
		this.#assertArgs(request.args, workflow.meta.argsSchema);
		const approval = this.#store.findManagedApproval(workflow, startedAt);
		if (!approval) {
			throw new WorkflowManagerConflictError(
				`Managed Workflow ${request.name}@${request.version} has no valid approval for its exact boundaries.`,
			);
		}
		const runId = this.#uniqueRunId();
		const bridge = this.#bridgeFactory({
			runId,
			workflowKind: "managed",
			workflowName: workflow.meta.name,
			sourceHash: workflow.sourceHash,
			scopeKey: workflow.source.scopeKey,
			permissions: structuredClone(workflow.meta.permissions),
		});
		return this.#startExecution({
			runId,
			workflowKind: "managed",
			workflowName: workflow.meta.name,
			workflowVersion: workflow.meta.version,
			sourceText: workflow.sourceText,
			sourceHash: workflow.sourceHash,
			args: request.args,
			argsHash: workflowValueHash(request.args ?? null),
			approval,
			scopeKey: workflow.source.scopeKey,
			permissions: workflow.meta.permissions,
			limits: workflow.meta.limits,
			bridge,
			signal: request.signal,
			startedAt,
		});
	}

	startAdHoc(request: StartAdHocWorkflowRequest): WorkflowRunHandle {
		const startedAt = this.#validNow();
		this.cleanupExpiredAdHocDrafts(request.taskRef, request.scopeKey);
		const draft = this.#store.getAdHocDraft(request.draftId);
		if (!draft) throw new WorkflowManagerConflictError(`Ad-hoc Workflow draft ${request.draftId} does not exist.`);
		if (draft.taskRef !== request.taskRef) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow approval belongs to a different task.");
		}
		if (draft.scopeKey !== request.scopeKey) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow approval belongs to a different execution scope.");
		}
		this.#assertAdHocSource(draft);
		this.#assertArgs(draft.args, draft.argsSchema);
		const approval = this.#store.findAdHocApproval(draft, startedAt);
		if (!approval || approval.approvalId !== request.approvalId) {
			throw new WorkflowManagerConflictError(
				"Ad-hoc Workflow has no valid approval for this exact draft, task, arguments and expiry.",
			);
		}
		const runId = this.#uniqueRunId();
		const bridge = this.#bridgeFactory({
			runId,
			workflowKind: "ad_hoc",
			workflowName: draft.name,
			sourceHash: draft.sourceHash,
			scopeKey: draft.scopeKey,
			permissions: structuredClone(draft.permissions),
		});
		const consumed = this.#store.consumeAdHocApprovalAndDeleteDraft(draft, approval.approvalId, startedAt);
		return this.#startExecution({
			runId,
			workflowKind: "ad_hoc",
			workflowName: draft.name,
			sourceText: draft.sourceText,
			sourceHash: draft.sourceHash,
			args: draft.args,
			argsHash: draft.argsHash,
			approval: consumed,
			scopeKey: draft.scopeKey,
			permissions: draft.permissions,
			limits: draft.limits,
			bridge,
			signal: request.signal,
			startedAt,
		});
	}

	getRun(runId: string): WorkflowRun | undefined {
		const execution = this.#runs.get(runId);
		return execution ? cloneRun(execution.run) : undefined;
	}

	listRuns(): WorkflowRun[] {
		return [...this.#runs.values()].map(execution => cloneRun(execution.run));
	}

	cleanupExpiredAdHocDrafts(taskRef: string, scopeKey: string): number {
		const now = this.#validNow();
		const expired = this.#store
			.listAdHocDrafts({ taskRef, scopeKey, limit: 500 })
			.filter(
				draft =>
					(draft.status === "draft" || draft.status === "approved") &&
					Date.parse(draft.expiresAt) <= now.getTime(),
			);
		for (const draft of expired) {
			const changed = this.#store.expireAdHocDraftAndDelete(draft.draftId, now);
			if (!changed) continue;
			this.#appendLifecycleEvent("draft_expired", {
				draftId: changed.draftId,
				taskRef: changed.taskRef,
				name: changed.name,
				sourceHash: changed.sourceHash,
				argsHash: changed.argsHash,
				scopeKey: changed.scopeKey,
			});
		}
		return expired.length;
	}

	/** Cancel every live run before its owning AgentSession changes identity. */
	cancelLiveRuns(reason = "Workflow cancelled because its owning session changed"): number {
		let cancelled = 0;
		for (const execution of this.#runs.values()) {
			if (
				execution.run.status !== "approved" &&
				execution.run.status !== "running" &&
				execution.run.status !== "paused"
			)
				continue;
			if (this.cancel(execution.run.runId, reason)) cancelled++;
		}
		return cancelled;
	}

	/** 会话身份变化后，将活动任务持久化为可恢复状态且不再写入旧会话。 */
	suspendLiveRuns(reason = "Workflow suspended because its owning session changed"): number {
		let suspended = 0;
		for (const execution of this.#runs.values()) {
			if (
				execution.run.status !== "approved" &&
				execution.run.status !== "running" &&
				execution.run.status !== "paused"
			)
				continue;
			execution.detached = true;
			execution.run.status = "paused";
			execution.run.error = reason;
			execution.run.updatedAt = this.#validNow().toISOString();
			this.#refreshElapsed(execution.run);
			this.#saveCheckpoint(execution);
			execution.control.cancel(new Error(reason));
			suspended++;
		}
		return suspended;
	}

	async waitForLiveRunsToSettle(): Promise<void> {
		await Promise.allSettled(
			[...this.#runs.values()].flatMap(execution => (execution.completion ? [execution.completion] : [])),
		);
	}

	completion(runId: string): Promise<WorkflowRun> {
		const execution = this.#requiredExecution(runId);
		if (!execution.completion) throw new WorkflowManagerError(`Workflow run ${runId} did not initialize.`);
		return execution.completion;
	}

	pause(runId: string): boolean {
		const execution = this.#runs.get(runId);
		if (execution?.run.status !== "running" || !execution.control.pause()) return false;
		execution.run.status = "paused";
		this.#appendRunEvent(execution, "run_paused", {});
		return true;
	}

	resume(runId: string): boolean {
		const execution = this.#runs.get(runId);
		if (execution?.run.status !== "paused" || !execution.control.resume()) return false;
		execution.run.status = "running";
		delete execution.run.error;
		this.#appendRunEvent(execution, "run_resumed", {});
		return true;
	}

	cancelNode(runId: string, nodeId: string, reason = "Workflow Agent cancelled by user"): boolean {
		const execution = this.#runs.get(runId);
		if (execution?.run.status !== "running" || !execution.runtime) return false;
		const node = execution.run.nodes.find(candidate => candidate.nodeId === nodeId);
		if (node?.status !== "running") return false;
		return execution.runtime.cancelNode(nodeId, reason);
	}

	cancel(runId: string, reason = "Workflow cancelled by user"): boolean {
		const execution = this.#runs.get(runId);
		if (!execution || terminal(execution.run.status) || !execution.control.cancel(new Error(reason))) return false;
		execution.run.status = "cancelled";
		execution.run.error = reason;
		this.#markOpenNodes(execution.run, "cancelled", reason);
		this.#appendRunEvent(execution, "run_cancelled", { reason });
		return true;
	}

	block(runId: string, reason: string): boolean {
		const execution = this.#runs.get(runId);
		if (!execution || terminal(execution.run.status) || !execution.control.cancel(new Error(reason))) return false;
		execution.run.status = "blocked";
		execution.run.error = reason;
		this.#markOpenNodes(execution.run, "blocked", reason);
		this.#appendRunEvent(execution, "run_blocked", { reason });
		return true;
	}

	prepareResultDelivery(runId: string): WorkflowResultDelivery {
		const execution = this.#requiredExecution(runId);
		if (execution.run.status !== "completed" || execution.run.result === undefined) {
			throw new WorkflowManagerConflictError(`Workflow run ${runId} has no completed result to deliver.`);
		}
		if (execution.run.deliveryState === "delivered") {
			throw new WorkflowManagerConflictError(`Workflow run ${runId} result was already delivered.`);
		}
		if (execution.run.deliveryState === "blocked") {
			throw new WorkflowManagerConflictError(`Workflow run ${runId} result delivery is blocked.`);
		}
		const unresolved = execution.run.writeArtifacts.filter(
			artifact => artifact.status !== "applied" && artifact.status !== "rejected",
		);
		if (unresolved.length > 0) {
			throw new WorkflowManagerConflictError(
				`Workflow run ${runId} has ${unresolved.length} unresolved isolated write artifact(s).`,
			);
		}
		const result = structuredClone(execution.run.result);
		const deliveryId =
			execution.run.deliveryId ??
			`workflow-delivery-${workflowValueHash({ runId, resultHash: workflowValueHash(result) }).slice(0, 32)}`;
		if (execution.run.deliveryState === "pending") {
			execution.run.deliveryState = "delivering";
			execution.run.deliveryId = deliveryId;
			this.#appendRunEvent(execution, "result_delivery_prepared", {
				deliveryId,
				resultHash: workflowValueHash(result),
			});
		}
		return { deliveryId, result };
	}

	acknowledgeResultDelivery(runId: string, deliveryId: string): void {
		const execution = this.#requiredExecution(runId);
		if (execution.run.deliveryState === "delivered") {
			if (execution.run.deliveryId === deliveryId) return;
			throw new WorkflowManagerConflictError(`Workflow run ${runId} result was already delivered.`);
		}
		if (execution.run.deliveryState !== "delivering" || execution.run.deliveryId !== deliveryId) {
			throw new WorkflowManagerConflictError(`Workflow run ${runId} has no matching prepared delivery.`);
		}
		execution.run.deliveryState = "delivered";
		this.#appendRunEvent(execution, "result_delivered", {
			deliveryId,
			resultHash: workflowValueHash(execution.run.result ?? null),
		});
	}

	/** 同步消费者在方法成功返回时确认交付。 */
	deliverResult(runId: string): WorkflowJsonValue {
		const delivery = this.prepareResultDelivery(runId);
		this.acknowledgeResultDelivery(runId, delivery.deliveryId);
		return delivery.result;
	}

	async reviewWriteArtifact(artifactId: string): Promise<WorkflowWriteReviewHandle> {
		const { execution, record } = this.#findWriteRecord(artifactId);
		this.#requiredCompletedExecution(execution.run.runId);
		try {
			const review = await reviewWorkflowWriteArtifact(
				record,
				this.#validNow().toISOString(),
				this.#writeReviewTokenFactory,
			);
			this.#syncWriteArtifact(execution, record.metadata);
			this.#appendRunEvent(execution, "write_reviewed", {
				artifactId,
				patchHash: review.patchHash,
				baselineHash: review.baselineHash,
				byteLength: review.byteLength,
			});
			return { ...review, runId: execution.run.runId };
		} catch (error) {
			this.#blockWriteDelivery(execution, record, error);
			throw error;
		}
	}

	async applyWriteArtifact(reviewToken: string): Promise<WorkflowWriteDecision> {
		const found = [...this.#runs.values()]
			.flatMap(execution => [...execution.writeRecords.values()].map(record => ({ execution, record })))
			.find(candidate => candidate.record.reviewToken === reviewToken);
		if (!found) throw new WorkflowManagerConflictError("Workflow patch review token is invalid or stale.");
		const { execution, record } = found;
		const runId = execution.run.runId;
		const artifactId = record.metadata.artifactId;
		this.#requiredCompletedExecution(runId);
		if (!execution.expectedWriteBaseline) {
			throw new WorkflowManagerError(`Workflow run ${runId} has no captured write baseline.`);
		}
		try {
			const result = await applyWorkflowWriteArtifact({
				record,
				reviewToken,
				expectedBaseline: execution.expectedWriteBaseline,
				appliedAt: this.#validNow().toISOString(),
				onApplyStarted: () => {
					record.metadata.status = "applying";
					this.#syncWriteArtifact(execution, record.metadata);
					this.#appendRunEvent(execution, "write_apply_started", {
						artifactId,
						patchHash: record.metadata.patchHash,
					});
				},
			});
			execution.expectedWriteBaseline = structuredClone(result.nextBaseline);
			this.#syncWriteArtifact(execution, result.artifact);
			this.#appendRunEvent(execution, "write_applied", {
				artifactId,
				patchHash: result.artifact.patchHash,
				hadChanges: result.hadChanges,
			});
			return { runId, artifact: structuredClone(result.artifact) };
		} catch (error) {
			this.#blockWriteDelivery(execution, record, error);
			throw error;
		}
	}

	rejectWriteArtifact(artifactId: string): WorkflowWriteDecision {
		const { execution, record } = this.#findWriteRecord(artifactId);
		const runId = execution.run.runId;
		this.#requiredCompletedExecution(runId);
		const rejected = rejectWorkflowWriteArtifact(record, this.#validNow().toISOString());
		this.#syncWriteArtifact(execution, rejected);
		this.#appendRunEvent(execution, "write_rejected", { artifactId, patchHash: rejected.patchHash });
		return { runId, artifact: rejected };
	}

	#startExecution(options: StartExecutionOptions): WorkflowRunHandle {
		const startedAt = options.startedAt.toISOString();
		const run: WorkflowRun = {
			runId: options.runId,
			workflowKind: options.workflowKind,
			workflowName: options.workflowName,
			...(options.workflowVersion ? { workflowVersion: options.workflowVersion } : {}),
			sourceHash: options.sourceHash,
			argsHash: options.argsHash,
			approvalRef: options.approval.approvalId,
			scopeKey: options.scopeKey,
			status: "approved",
			budget: {
				agentsStarted: 0,
				agentsCompleted: 0,
				tokensUsed: 0,
				startedAt,
				elapsedMs: 0,
				limits: structuredClone(options.limits),
			},
			deliveryState: "pending",
			currentPhase: "workflow",
			nodes: [],
			writeArtifacts: [],
			createdAt: startedAt,
			updatedAt: startedAt,
		};
		const control = new WorkflowRuntimeControl();
		const execution: WorkflowExecution = {
			run,
			sessionId: this.#sessionManager.getSessionId(),
			sequence: 0,
			sourceText: options.sourceText,
			...(options.args === undefined ? {} : { args: structuredClone(options.args) }),
			permissions: structuredClone(options.permissions),
			completedCalls: new Map(),
			control,
			writeRecords: new Map(),
		};
		const hooks = this.#runtimeHooks(execution);
		const runtime = new RestrictedWorkflowRuntime({
			sourceText: options.sourceText,
			sourceHash: options.sourceHash,
			scopeKey: options.scopeKey,
			args: options.args,
			bridge: options.bridge,
			permissions: structuredClone(options.permissions),
			limits: structuredClone(options.limits),
			control,
			signal: options.signal,
			hooks,
			now: () => this.#now().getTime(),
		});
		execution.runtime = runtime;
		this.#runs.set(run.runId, execution);
		this.#appendRunEvent(execution, "run_approved", {
			approvalRef: options.approval.approvalId,
			approvalBoundary: options.approval.keyHash,
			argsHash: options.argsHash,
			sourceHash: options.sourceHash,
		});
		run.status = "running";
		this.#appendRunEvent(execution, "run_started", {});
		const completion = this.#execute(execution);
		execution.completion = completion;
		return { runId: run.runId, completion };
	}

	#runtimeHooks(execution: WorkflowExecution): WorkflowRuntimeHooks {
		return {
			onPhase: (title: string) => {
				if (execution.detached) return;
				execution.run.currentPhase = title;
				this.#appendRunEvent(execution, "phase_started", { phase: title });
			},
			onAgentScheduled: (request: WorkflowAgentRequest) => {
				if (execution.detached) return;
				let node = execution.run.nodes.find(candidate => candidate.callId === request.callId);
				if (node) {
					node.attempt++;
					node.phase = request.phase;
					node.status = "scheduled";
					delete node.error;
				} else {
					node = {
						nodeId: request.nodeId,
						callId: request.callId,
						phase: request.phase,
						attempt: 1,
						inputHash: request.inputHash,
						status: "scheduled",
					};
					execution.run.nodes.push(node);
				}
				execution.run.budget.agentsStarted++;
				this.#appendRunEvent(execution, "node_scheduled", {
					nodeId: node.nodeId,
					callId: node.callId,
					phase: node.phase,
					inputHash: node.inputHash,
				});
			},
			onAgentStarted: (request: WorkflowAgentRequest) => {
				if (execution.detached) return;
				const node = this.#requiredNode(execution.run, request.callId);
				node.status = "running";
				node.startedAt = this.#validNow().toISOString();
				this.#appendRunEvent(execution, "agent_started", {
					nodeId: node.nodeId,
					callId: node.callId,
					phase: node.phase,
				});
			},
			onAgentResult: async (request: WorkflowAgentRequest, result: WorkflowAgentResult) => {
				if (execution.detached) return;
				if (request.writeMode === "isolated_write" && !result.writeArtifact) {
					throw new WorkflowManagerError("Isolated Workflow agent returned no write artifact for review.");
				}
				if (!result.writeArtifact) return;
				if (request.writeMode !== "isolated_write" || result.writeArtifact.scopeKey !== execution.run.scopeKey) {
					throw new WorkflowManagerError(
						"Workflow agent returned a write artifact outside the approved write mode or scope.",
					);
				}
				const baselineHash = workflowBaselineHash(result.writeArtifact.baseline);
				if (execution.writeBaseline) {
					if (
						baselineHash !== workflowBaselineHash(execution.writeBaseline) ||
						result.writeArtifact.repoRoot !== execution.writeRepoRoot
					) {
						throw new WorkflowManagerConflictError(
							"The working tree changed while isolated Workflow agents were producing patches.",
						);
					}
				} else {
					execution.writeBaseline = structuredClone(result.writeArtifact.baseline);
					execution.expectedWriteBaseline = structuredClone(result.writeArtifact.baseline);
					execution.writeRepoRoot = result.writeArtifact.repoRoot;
				}
				const artifactId = `workflow-artifact-${workflowValueHash({ runId: execution.run.runId, callId: request.callId }).slice(0, 32)}`;
				const record = await captureWorkflowWriteArtifact({
					artifactId,
					nodeId: request.nodeId,
					callId: request.callId,
					agentRef: result.agentId,
					candidate: result.writeArtifact,
					capturedAt: this.#validNow().toISOString(),
				});
				execution.writeRecords.set(artifactId, record);
				execution.run.writeArtifacts.push(structuredClone(record.metadata));
				this.#appendRunEvent(execution, "write_captured", {
					artifactId,
					nodeId: request.nodeId,
					callId: request.callId,
					patchHash: record.metadata.patchHash,
					baselineHash: record.metadata.baselineHash,
					byteLength: record.metadata.byteLength,
					hasNestedChanges: record.metadata.hasNestedChanges,
				});
			},
			onTokensUsed: (tokensUsed: number) => {
				if (execution.detached) return;
				execution.run.budget.tokensUsed = tokensUsed;
			},
			onAgentCompleted: (request: WorkflowAgentRequest, result: WorkflowAgentResult) => {
				if (execution.detached) return;
				const node = this.#requiredNode(execution.run, request.callId);
				node.status = "completed";
				node.agentRef = result.agentId;
				node.resultRef =
					[...execution.writeRecords.values()].find(record => record.metadata.callId === request.callId)?.metadata
						.artifactId ?? result.agentId;
				node.usage = result.usage;
				node.committedAt = this.#validNow().toISOString();
				execution.run.budget.agentsCompleted++;
				execution.completedCalls.set(request.callId, {
					callId: request.callId,
					inputHash: request.inputHash,
					result: structuredClone(result),
				});
				this.#appendRunEvent(execution, "agent_completed", {
					nodeId: node.nodeId,
					callId: node.callId,
					agentRef: result.agentId,
					tokensUsed: result.usage?.totalTokens ?? 0,
					durationMs: result.durationMs,
				});
				this.#appendRunEvent(execution, "node_committed", {
					nodeId: node.nodeId,
					callId: node.callId,
					resultHash: workflowValueHash(result.value),
				});
			},
			onAgentFailed: (request: WorkflowAgentRequest, error: unknown) => {
				if (execution.detached) return;
				const node = this.#requiredNode(execution.run, request.callId);
				node.status =
					execution.run.status === "cancelled"
						? "cancelled"
						: error instanceof WorkflowRuntimeError && error.code === "cancelled"
							? "cancelled"
							: execution.run.status === "blocked"
								? "blocked"
								: "failed";
				node.error = errorMessage(error);
				const writeRecord = [...execution.writeRecords.values()].find(
					record => record.metadata.callId === request.callId,
				);
				if (writeRecord && writeRecord.metadata.status !== "blocked") {
					const blocked = blockWorkflowWriteArtifact(writeRecord, "blocked", node.error);
					this.#syncWriteArtifact(execution, blocked);
					this.#appendRunEvent(execution, "write_blocked", {
						artifactId: blocked.artifactId,
						reason: node.error,
					});
				}
				this.#appendRunEvent(execution, "agent_failed", {
					nodeId: node.nodeId,
					callId: node.callId,
					reason: node.error,
				});
			},
		};
	}

	async #execute(execution: WorkflowExecution): Promise<WorkflowRun> {
		try {
			if (!execution.runtime)
				throw new WorkflowManagerError(`Workflow run ${execution.run.runId} did not initialize.`);
			const result = await execution.runtime.execute();
			if (execution.detached) {
				this.#saveCheckpoint(execution);
				return cloneRun(execution.run);
			}
			if (terminal(execution.run.status)) return cloneRun(execution.run);
			execution.run.result = result.value;
			execution.run.budget = structuredClone(result.budget);
			execution.run.status = "completed";
			this.#appendRunEvent(execution, "run_completed", {
				resultHash: workflowValueHash(result.value),
			});
		} catch (error) {
			this.#refreshElapsed(execution.run);
			if (execution.detached) {
				this.#saveCheckpoint(execution);
				return cloneRun(execution.run);
			}
			if (terminal(execution.run.status)) return cloneRun(execution.run);
			const message = errorMessage(error);
			execution.run.error = message;
			if (error instanceof WorkflowRuntimeError && error.code === "cancelled") {
				execution.run.status = "cancelled";
				this.#markOpenNodes(execution.run, "cancelled", message);
				this.#appendRunEvent(execution, "run_cancelled", { reason: message });
			} else {
				execution.run.status = "failed";
				this.#markOpenNodes(execution.run, "failed", message);
				this.#appendRunEvent(execution, "run_failed", {
					reason: message,
					...(error instanceof WorkflowRuntimeError ? { code: error.code } : {}),
				});
			}
		}
		return cloneRun(execution.run);
	}

	#appendLifecycleEvent(type: WorkflowEventType, payload: Record<string, WorkflowJsonValue>): void {
		appendWorkflowEvent(this.#sessionManager, {
			eventId: this.#idFactory("event"),
			sequence: 0,
			type,
			timestamp: this.#validNow().toISOString(),
			payload: eventPayload(payload),
		});
	}

	#appendRunEvent(
		execution: WorkflowExecution,
		type: WorkflowEventType,
		payload: Record<string, WorkflowJsonValue | undefined>,
	): void {
		const timestamp = this.#validNow().toISOString();
		const event: WorkflowEvent = {
			eventId: this.#idFactory("event"),
			runId: execution.run.runId,
			sequence: execution.sequence,
			type,
			timestamp,
			payload: eventPayload(payload),
		};
		execution.sequence++;
		execution.run.updatedAt = timestamp;
		this.#refreshElapsed(execution.run);
		this.#saveCheckpoint(execution);
		appendWorkflowEvent(this.#sessionManager, event);
	}

	#saveCheckpoint(execution: WorkflowExecution): void {
		const checkpoint: WorkflowRunCheckpoint = {
			sessionId: execution.sessionId,
			run: cloneRun(execution.run),
			sequence: execution.sequence,
			sourceText: execution.sourceText,
			...(execution.args === undefined ? {} : { args: structuredClone(execution.args) }),
			permissions: structuredClone(execution.permissions),
			completedCalls: [...execution.completedCalls.values()].map(call => structuredClone(call)),
			writeRecords: [...execution.writeRecords.values()].map(record => structuredClone(record)),
			...(execution.writeBaseline ? { writeBaseline: structuredClone(execution.writeBaseline) } : {}),
			...(execution.expectedWriteBaseline
				? { expectedWriteBaseline: structuredClone(execution.expectedWriteBaseline) }
				: {}),
			...(execution.writeRepoRoot ? { writeRepoRoot: execution.writeRepoRoot } : {}),
		};
		this.#store.saveRunCheckpoint(checkpoint);
	}

	#restoreCheckpoints(): void {
		const sessionId = this.#sessionManager.getSessionId();
		for (const checkpoint of this.#store.listRunCheckpoints(sessionId)) {
			const control = new WorkflowRuntimeControl();
			const execution: WorkflowExecution = {
				run: cloneRun(checkpoint.run),
				sessionId,
				sequence: checkpoint.sequence,
				sourceText: checkpoint.sourceText,
				...(checkpoint.args === undefined ? {} : { args: structuredClone(checkpoint.args) }),
				permissions: structuredClone(checkpoint.permissions),
				completedCalls: new Map(checkpoint.completedCalls.map(call => [call.callId, structuredClone(call)])),
				control,
				writeRecords: new Map(
					checkpoint.writeRecords.map(record => [record.metadata.artifactId, structuredClone(record)]),
				),
				...(checkpoint.writeBaseline ? { writeBaseline: structuredClone(checkpoint.writeBaseline) } : {}),
				...(checkpoint.expectedWriteBaseline
					? { expectedWriteBaseline: structuredClone(checkpoint.expectedWriteBaseline) }
					: {}),
				...(checkpoint.writeRepoRoot ? { writeRepoRoot: checkpoint.writeRepoRoot } : {}),
			};
			this.#runs.set(execution.run.runId, execution);
			if (terminal(execution.run.status)) {
				execution.completion = Promise.resolve(cloneRun(execution.run));
				continue;
			}
			const bridge = this.#bridgeFactory({
				runId: execution.run.runId,
				workflowKind: execution.run.workflowKind,
				workflowName: execution.run.workflowName,
				sourceHash: execution.run.sourceHash,
				scopeKey: execution.run.scopeKey,
				permissions: structuredClone(execution.permissions),
			});
			const hooks = this.#runtimeHooks(execution);
			execution.runtime = new RestrictedWorkflowRuntime({
				sourceText: execution.sourceText,
				sourceHash: execution.run.sourceHash,
				scopeKey: execution.run.scopeKey,
				args: execution.args,
				bridge,
				permissions: structuredClone(execution.permissions),
				limits: structuredClone(execution.run.budget.limits),
				control,
				hooks,
				completedCalls: new Map(checkpoint.completedCalls.map(call => [call.callId, structuredClone(call.result)])),
				initialAgentsStarted: execution.run.budget.agentsStarted,
				initialAgentsCompleted: execution.run.budget.agentsCompleted,
				initialTokensUsed: execution.run.budget.tokensUsed,
				initialStartedAt: Date.parse(execution.run.budget.startedAt),
				now: () => this.#now().getTime(),
			});
			if (execution.run.status === "paused") control.pause();
			else execution.run.status = "running";
			execution.completion = this.#execute(execution);
		}
	}

	#assertSourceSafe(sourceText: string): ParsedWorkflowSource {
		const parsed = parseWorkflowSource(sourceText);
		if (parsed.violations.length > 0) {
			throw new WorkflowManagerConflictError(`Workflow source is unsafe: ${parsed.violations.join("; ")}`);
		}
		return parsed;
	}

	#assertAdHocSource(draft: AdHocWorkflowDraft): void {
		const parsed = this.#assertSourceSafe(draft.sourceText);
		if (parsed.meta.name !== draft.name || parsed.meta.description !== draft.description) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow metadata does not match the approved script.");
		}
		if (workflowValueHash(parsed.meta.argsSchema ?? null) !== draft.argsSchemaHash) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow argument schema does not match the approved script.");
		}
		if (workflowValueHash(parsed.meta.permissions) !== draft.permissionManifestHash) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow permissions do not match the approved script.");
		}
		if (workflowValueHash(parsed.meta.limits) !== workflowValueHash(draft.limits)) {
			throw new WorkflowManagerConflictError("Ad-hoc Workflow limits do not match the approved script.");
		}
	}

	#assertArgs(args: WorkflowJsonValue | undefined, schema: ManagedWorkflow["meta"]["argsSchema"]): void {
		if (args !== undefined && !isWorkflowJsonValue(args)) {
			throw new WorkflowManagerConflictError("Workflow arguments must be JSON-compatible.");
		}
		assertWorkflowArgs(args ?? null, schema);
	}

	#uniqueRunId(): string {
		const runId = this.#idFactory("run");
		if (this.#runs.has(runId)) throw new WorkflowManagerError(`Workflow run id ${runId} already exists.`);
		return runId;
	}

	#requiredCompletedExecution(runId: string): WorkflowExecution {
		const execution = this.#requiredExecution(runId);
		if (execution.run.status !== "completed") {
			throw new WorkflowManagerConflictError(
				`Workflow run ${runId} write artifacts cannot be changed from status ${execution.run.status}.`,
			);
		}
		return execution;
	}

	#findWriteRecord(artifactId: string): { execution: WorkflowExecution; record: WorkflowWriteArtifactRecord } {
		for (const execution of this.#runs.values()) {
			const record = execution.writeRecords.get(artifactId);
			if (record) return { execution, record };
		}
		throw new WorkflowManagerConflictError(`Workflow write artifact ${artifactId} does not exist in this session.`);
	}

	#syncWriteArtifact(execution: WorkflowExecution, artifact: WorkflowWriteArtifact): void {
		const index = execution.run.writeArtifacts.findIndex(candidate => candidate.artifactId === artifact.artifactId);
		if (index < 0)
			throw new WorkflowManagerError(`Workflow write artifact ${artifact.artifactId} is not registered.`);
		execution.run.writeArtifacts[index] = structuredClone(artifact);
	}

	#blockWriteDelivery(execution: WorkflowExecution, record: WorkflowWriteArtifactRecord, error: unknown): void {
		if (
			error instanceof WorkflowWriteDeliveryError &&
			(error.code === "invalid_review" || error.code === "invalid_state")
		) {
			return;
		}
		const reason = error instanceof WorkflowWriteDeliveryError ? error.message : "Workflow write delivery failed.";
		const status =
			record.metadata.status === "applying" ||
			(error instanceof WorkflowWriteDeliveryError && error.code === "unknown_side_effect")
				? "unknown"
				: "blocked";
		const blocked = blockWorkflowWriteArtifact(record, status, reason);
		this.#syncWriteArtifact(execution, blocked);
		this.#appendRunEvent(execution, status === "unknown" ? "write_unknown" : "write_blocked", {
			artifactId: blocked.artifactId,
			reason,
		});
		execution.run.deliveryState = "blocked";
		execution.run.status = "blocked";
		execution.run.error = reason;
		this.#appendRunEvent(execution, "run_blocked", { reason });
	}

	#requiredExecution(runId: string): WorkflowExecution {
		const execution = this.#runs.get(runId);
		if (!execution) throw new WorkflowManagerConflictError(`Workflow run ${runId} does not exist in this session.`);
		return execution;
	}

	#requiredNode(run: WorkflowRun, callId: string): WorkflowNode {
		const node = run.nodes.find(candidate => candidate.callId === callId);
		if (!node) throw new WorkflowManagerError(`Workflow node ${callId} was not scheduled.`);
		return node;
	}

	#markOpenNodes(run: WorkflowRun, status: "blocked" | "cancelled" | "failed", reason: string): void {
		for (const node of run.nodes) {
			if (node.status !== "scheduled" && node.status !== "running" && node.status !== "pending") continue;
			node.status = status;
			node.error = reason;
		}
	}

	#refreshElapsed(run: WorkflowRun): void {
		run.budget.elapsedMs = Math.max(0, this.#validNow().getTime() - Date.parse(run.budget.startedAt));
	}

	#validNow(): Date {
		const now = this.#now();
		if (!Number.isFinite(now.getTime()))
			throw new WorkflowManagerError("Workflow manager clock returned an invalid time.");
		return now;
	}
}
