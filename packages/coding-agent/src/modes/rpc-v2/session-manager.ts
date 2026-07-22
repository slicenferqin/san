/**
 * RPC v2 Session 事实层。
 *
 * 负责 Session index、单写 lease、事件身份/顺序、原子 sync、replay、
 * crash recovery 和当前现场投影。Router 不直接触碰 AgentSession 的隐含
 * 状态，所有写操作都必须经过本类的 sessionId/lease/revision 校验。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { collectContextCheckpoints } from "../../context-steady/checkpoint";
import { listTurnDigests } from "../../context-steady/session";
import type { ContextCheckpoint } from "../../context-steady/types";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { CompactMode } from "../../session/compact-modes";
import { listAllSessions, type SessionInfo } from "../../session/session-listing";
import type { EventBus } from "../../utils/event-bus";
import {
	abandonRecoveryLease,
	acquireLease,
	detectRecovery,
	executeRecovery,
	type LeaseRecord,
	leasePath,
	recoveryPathForSession,
	removeLeaseRecord,
	updateLeaseHeartbeat,
} from "./crash-recovery";
import type { ApprovalRequest } from "./dto/approval";
import type { CheckpointSummary, ContinuitySnapshot, MaintenanceSnapshot } from "./dto/context";
import type { SessionEvent } from "./dto/events";
import type { SessionRuntimeSettings, SubagentSnapshot } from "./dto/integration";
import type { InteractionRequest } from "./dto/interaction";
import type { InputResourceRef } from "./dto/resources";
import type { ContentPart, QueueItem, RunSnapshot } from "./dto/run";
import type { RecoveryDescriptor, SessionSnapshot, SessionSummary, StreamPolicy } from "./dto/session";
import { AdapterContext, adaptSessionEvent } from "./event-adapter";
import { EventSequencer } from "./event-sequencer";
import { EvidenceLedger, generateToolEvidence } from "./evidence-generator";
import { IdempotencyStore } from "./idempotency";
import { failRpc } from "./protocol/errors";
import type { LeaseId, OperationId, RunId, RuntimeId, SessionId, SubscriptionId } from "./protocol/ids";
import {
	newLeaseId,
	newMaintenanceId,
	newMessageId,
	newOperationId,
	newQueueItemId,
	newRunId,
	newSubscriptionId,
} from "./protocol/ids";
import { isRunTerminal, type RunStatus } from "./protocol/lifecycle";
import { sanitizeRpcError, sanitizeRpcText } from "./redaction";
import {
	type RpcRuntimeSettingsPatch,
	type RpcRuntimeSettingsScope,
	RpcV2RuntimeSettingsStore,
	type StoredRpcRuntimeSettings,
} from "./runtime-settings-store";
import { type PersistedRpcState, RpcV2StateStore, rpcV2StatePaths } from "./state-store";

export interface RpcV2SessionHandle {
	session: AgentSession;
	eventBus?: EventBus;
	mcpManager?: MCPManager;
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	dispose?: () => Promise<void>;
}

export interface RpcV2SessionFactory {
	create(params: { cwd: string; title?: string; parentSessionPath?: string }): Promise<RpcV2SessionHandle>;
	open(params: {
		sessionFile: string;
		access: "read_write" | "read_only";
		recovering?: boolean;
	}): Promise<RpcV2SessionHandle>;
	getAvailableModels(): readonly Model[];
	getAllModels(): readonly Model[];
	hasProviderAuth(providerId: string): boolean;
	hasModelAuth(providerId: string, modelId: string): boolean;
	loginProvider(
		providerId: string,
		callbacks: {
			onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => void;
			onProgress: (message: string) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			signal: AbortSignal;
		},
	): Promise<void>;
	refreshModels(): Promise<void>;
}

export interface RpcV2RuntimeCatalog {
	getAvailableModels(): readonly Model[];
	getAllModels(): readonly Model[];
	hasProviderAuth(providerId: string): boolean;
	hasModelAuth(providerId: string, modelId: string): boolean;
	loginProvider(
		providerId: string,
		callbacks: {
			onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => void;
			onProgress: (message: string) => void;
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
			signal: AbortSignal;
		},
	): Promise<void>;
	refreshModels(): Promise<void>;
}

interface ActiveLease {
	leaseId: LeaseId;
	sessionId: SessionId;
	access: "read_write" | "read_only";
	acquiredAt: string;
	held: boolean;
}

interface PreparedLease {
	lease: ActiveLease;
	recovery?: RecoveryDescriptor;
}

interface ActiveSession {
	handle: RpcV2SessionHandle;
	session: AgentSession;
	sessionId: SessionId;
	sessionFile?: string;
	lease?: ActiveLease;
	store: RpcV2StateStore;
	state: PersistedRpcState;
	events: SessionEvent[];
	sequencer: EventSequencer;
	adapter: AdapterContext;
	unsubscribe: () => void;
	subscriptionId?: SubscriptionId;
	syncPending: boolean;
	syncAsOfSequence?: number;
	syncBuffer: SessionEvent[];
	synced: boolean;
	stream: StreamPolicy;
	eventTail: Promise<void>;
	fatalError?: Error;
	activeRun?: RunSnapshot;
	lastRun?: RunSnapshot;
	activeResourceIds: Set<string>;
	pendingResourceReleases: Set<string>;
	maintenance?: ContextMaintenance;
	queue: QueueItem[];
	queueContent: Map<string, ContentPart[]>;
	pendingApprovals: ApprovalRequest[];
	pendingInteractions: InteractionRequest[];
	evidence: EvidenceLedger;
	idempotency: IdempotencyStore;
	globalRuntimeSettings: StoredRpcRuntimeSettings;
	workspaceRuntimeSettings: StoredRpcRuntimeSettings;
	backgroundTasks: Set<Promise<void>>;
}

interface ContextMaintenance {
	maintenanceId: string;
	kind: "context_full" | "snapcompact";
	state: "running" | "completed" | "failed" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	reason?: string;
	task?: Promise<void>;
}

type OutputFn = (
	frame: object,
	options?: { durability?: "durable" | "transient"; coalesceKey?: string },
) => Promise<void> | void;
type SessionBinder = (active: ActiveSession) => Promise<void> | void;
export interface ResolvedRunContent {
	text: string;
	images: ImageContent[];
	resourceIds: string[];
}
export interface SessionMutationReceipt {
	key: string;
	params: unknown;
}
interface PersistedSessionMutationReceipt extends SessionMutationReceipt {
	result: unknown | ((revision: number) => unknown);
}
type ContentResolver = (params: {
	session: AgentSession;
	sessionId: SessionId;
	content: readonly ContentPart[];
}) => Promise<ResolvedRunContent>;

const DEFAULT_RETENTION = 100_000;

export class RpcV2SessionManager {
	readonly #runtimeId: string;
	readonly #factory?: RpcV2SessionFactory;
	readonly #initialHandle?: RpcV2SessionHandle;
	readonly #retention: number;
	readonly #runtimeSettings = new RpcV2RuntimeSettingsStore();
	#active?: ActiveSession;
	#output: OutputFn = () => undefined;
	#binder?: SessionBinder;
	#contentResolver?: ContentResolver;
	#resourceReleaseHandler?: (resourceIds: readonly string[], sessionId: SessionId) => Promise<void>;
	#subagentSnapshotProvider: () => SubagentSnapshot[] = () => [];
	#commandCatalogRevisionProvider?: (session: AgentSession) => Promise<number>;

	constructor(options: {
		runtimeId: string;
		initialHandle?: RpcV2SessionHandle;
		factory?: RpcV2SessionFactory;
		retention?: number;
	}) {
		this.#runtimeId = options.runtimeId;
		this.#initialHandle = options.initialHandle;
		this.#factory = options.factory;
		this.#retention = options.retention ?? DEFAULT_RETENTION;
	}

	setOutput(output: OutputFn): void {
		this.#output = output;
	}

	async setSessionBinder(binder: SessionBinder): Promise<void> {
		this.#binder = binder;
		if (this.#active) await binder(this.#active);
	}

	setContentResolver(resolver: ContentResolver): void {
		this.#contentResolver = resolver;
	}

	setResourceReleaseHandler(handler: (resourceIds: readonly string[], sessionId: SessionId) => Promise<void>): void {
		this.#resourceReleaseHandler = handler;
	}

	setSubagentSnapshotProvider(provider: () => SubagentSnapshot[]): void {
		this.#subagentSnapshotProvider = provider;
	}

	setCommandCatalogRevisionProvider(provider: (session: AgentSession) => Promise<number>): void {
		this.#commandCatalogRevisionProvider = provider;
	}

	get currentSession(): AgentSession | undefined {
		return this.#active?.session;
	}

	get currentHandle(): RpcV2SessionHandle | undefined {
		return this.#active?.handle;
	}

	get currentSessionId(): SessionId | undefined {
		return this.#active?.sessionId;
	}

	get currentLease(): ActiveLease | undefined {
		return this.#active?.lease;
	}

	get currentRevision(): number {
		return this.#active?.state.revision ?? 0;
	}

	get currentLastSequence(): number {
		return this.#active?.sequencer.currentSequence ?? 0;
	}

	get currentSubscriptionId(): SubscriptionId | undefined {
		return this.#active?.subscriptionId;
	}

	get currentAdapter(): AdapterContext | undefined {
		return this.#active?.adapter;
	}

	get currentEvidence(): EvidenceLedger | undefined {
		return this.#active?.evidence;
	}

	get currentMaintenance(): Readonly<ContextMaintenance> | undefined {
		return this.#active?.maintenance;
	}

	get runtimeCatalog(): RpcV2RuntimeCatalog | undefined {
		return this.#factory;
	}

	checkIdempotency(key: string, params: unknown): { cached: true; result: unknown } | { cached: false } {
		return this.assertSession().idempotency.check(key, params);
	}

	async recordIdempotency(key: string, params: unknown, result: unknown): Promise<void> {
		const active = this.assertSession();
		active.idempotency.record(key, params, result);
		await this.#persistState(active);
	}

	async replaceResources(resources: readonly InputResourceRef[]): Promise<void> {
		const active = this.assertSession();
		active.state.resources = resources.map(resource => ({ ...structuredClone(resource) }));
		await this.#persistState(active);
	}

	async deferResourceRelease(active: ActiveSession, resourceId: string): Promise<boolean> {
		if (!active.activeRun || !active.activeResourceIds.has(resourceId)) return false;
		active.pendingResourceReleases.add(resourceId);
		await this.#persistState(active);
		return true;
	}

	async replaceArtifacts(artifacts: readonly Record<string, unknown>[]): Promise<void> {
		const active = this.assertSession();
		active.state.artifacts = artifacts.map(artifact => structuredClone(artifact));
		await this.#persistState(active);
	}

	getSettings(active = this.assertSession()): SessionRuntimeSettings {
		return buildSettings(
			active.session,
			active.state,
			active.globalRuntimeSettings,
			active.workspaceRuntimeSettings,
			"session",
		);
	}

	async getScopedSettings(scope: RpcRuntimeSettingsScope, cwd?: string): Promise<SessionRuntimeSettings> {
		const globalSettings = await this.#runtimeSettings.load("global");
		const workspaceSettings =
			scope === "workspace"
				? await this.#runtimeSettings.load("workspace", cwd)
				: { schemaVersion: 1 as const, revision: 0 };
		return buildSettings(undefined, undefined, globalSettings, workspaceSettings, scope);
	}

	async updateScopedSettings(
		scope: RpcRuntimeSettingsScope,
		cwd: string | undefined,
		patch: RpcRuntimeSettingsPatch,
		expectedRevision?: number,
	): Promise<SessionRuntimeSettings> {
		const updated = await this.#runtimeSettings.update(scope, cwd, patch, expectedRevision);
		const active = this.#active;
		if (active) {
			const activeCwd = path.resolve(active.session.sessionManager.getCwd());
			const affectsActive = scope === "global" || (cwd !== undefined && activeCwd === path.resolve(cwd));
			if (affectsActive) {
				if (scope === "global") active.globalRuntimeSettings = updated;
				else active.workspaceRuntimeSettings = updated;
				applyRuntimeSettingsOverrides(
					active.session,
					active.state,
					active.globalRuntimeSettings,
					active.workspaceRuntimeSettings,
				);
				active.state.revision++;
				await this.#persistState(active);
				await this.emitCustom(active, "session.notice", {
					level: "info",
					code: "SETTINGS_CHANGED",
					message: `${scope === "global" ? "Global" : "Workspace"} runtime settings changed`,
				});
			}
		}
		const globalSettings = scope === "global" ? updated : await this.#runtimeSettings.load("global");
		const workspaceSettings = scope === "workspace" ? updated : { schemaVersion: 1 as const, revision: 0 };
		return buildSettings(undefined, undefined, globalSettings, workspaceSettings, scope);
	}

	async updateSettings(active: ActiveSession, patch: RpcRuntimeSettingsPatch): Promise<SessionRuntimeSettings> {
		if (patch.executionProfile !== undefined) active.state.settings.executionProfile = patch.executionProfile;
		if (patch.autoRetry?.enabled !== undefined) active.state.settings.autoRetryEnabled = patch.autoRetry.enabled;
		if (patch.contextMaintenance?.mode !== undefined)
			active.state.settings.contextMaintenanceMode = patch.contextMaintenance.mode;
		applyRuntimeSettingsOverrides(
			active.session,
			active.state,
			active.globalRuntimeSettings,
			active.workspaceRuntimeSettings,
		);
		active.state.revision++;
		await this.#persistState(active);
		await this.emitCustom(active, "session.notice", {
			level: "info",
			code: "SETTINGS_CHANGED",
			message: "Session runtime settings changed",
		});
		return buildSettings(
			active.session,
			active.state,
			active.globalRuntimeSettings,
			active.workspaceRuntimeSettings,
			"session",
		);
	}

	async configureStream(policy: StreamPolicy): Promise<StreamPolicy> {
		const active = this.#active;
		if (active) {
			active.stream = { ...active.stream, ...policy };
			await this.#persistState(active);
			return { ...active.stream };
		}
		return { ...policy };
	}

	enqueueExternalEvent(
		type: SessionEvent["type"],
		data: Record<string, unknown>,
		durability: "durable" | "transient",
	): void {
		const active = this.#active;
		if (!active) return;
		const task = this.emitCustom(active, type, data, {
			durability,
			runId: active.activeRun?.runId,
		});
		void task.catch(error => {
			active.fatalError = error instanceof Error ? error : new Error(String(error));
		});
	}

	async startContextMaintenance(
		active: ActiveSession,
		params: { instructions?: string; mode?: CompactMode },
	): Promise<{ maintenanceId: string; state: "running"; startedAt: string }> {
		if (active.maintenance?.state === "running") {
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Context maintenance is already running: ${active.maintenance.maintenanceId}`,
				sessionId: active.sessionId,
				details: { maintenanceId: active.maintenance.maintenanceId },
			});
		}
		const maintenance: ContextMaintenance = {
			maintenanceId: newMaintenanceId(),
			kind: params.mode === "snapcompact" ? "snapcompact" : "context_full",
			state: "running",
			startedAt: new Date().toISOString(),
		};
		active.maintenance = maintenance;
		await this.emitCustom(
			active,
			"context.maintenance.started",
			{
				maintenanceId: maintenance.maintenanceId,
				kind: maintenance.kind,
				state: maintenance.state,
				startedAt: maintenance.startedAt,
			},
			{ runId: active.activeRun?.runId },
		);
		const task = this.#runContextMaintenance(active, maintenance, params);
		maintenance.task = task;
		this.#trackBackgroundTask(active, task);
		return { maintenanceId: maintenance.maintenanceId, state: "running", startedAt: maintenance.startedAt };
	}

	async cancelContextMaintenance(
		active: ActiveSession,
		maintenanceId: string,
	): Promise<{ accepted: boolean; maintenanceId: string; state: string }> {
		const maintenance = active.maintenance;
		if (!maintenance || maintenance.maintenanceId !== maintenanceId) {
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Context maintenance not found: ${maintenanceId}`,
				sessionId: active.sessionId,
			});
		}
		if (maintenance.state !== "running") return { accepted: false, maintenanceId, state: maintenance.state };
		maintenance.reason = "client_cancelled";
		active.session.abortCompaction();
		return { accepted: true, maintenanceId, state: "cancelling" };
	}

	get pendingApprovals(): readonly ApprovalRequest[] {
		return this.#active?.pendingApprovals ?? [];
	}

	get pendingInteractions(): readonly InteractionRequest[] {
		return this.#active?.pendingInteractions ?? [];
	}

	/** 列出全局 Session index，分页 cursor 是 opaque 的 offset 编码。 */
	async listSessions(
		params: {
			query?: string;
			cwd?: string;
			statuses?: string[];
			sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<{ sessions: SessionSummary[]; nextCursor: string | null; indexRevision: number }> {
		let all = await listAllSessions();
		if (params.cwd) all = all.filter(item => path.resolve(item.cwd) === path.resolve(params.cwd as string));
		if (params.query) {
			const query = params.query.toLowerCase();
			all = all.filter(item =>
				`${item.title ?? ""}\n${item.firstMessage}\n${item.cwd}`.toLowerCase().includes(query),
			);
		}
		if (params.statuses && params.statuses.length > 0)
			all = all.filter(item => params.statuses?.includes(item.status ?? "unknown"));
		const sort = params.sort ?? "updated_desc";
		all.sort((left, right) => {
			const leftValue = sort.startsWith("created") ? left.created.getTime() : left.modified.getTime();
			const rightValue = sort.startsWith("created") ? right.created.getTime() : right.modified.getTime();
			const timeOrder = sort.endsWith("asc") ? leftValue - rightValue : rightValue - leftValue;
			return timeOrder || left.id.localeCompare(right.id);
		});
		const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
		const offset = decodeCursor(params.cursor);
		const page = all.slice(offset, offset + limit);
		return {
			sessions: await Promise.all(page.map(item => this.#summaryFromInfo(item))),
			nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : null,
			indexRevision: sessionIndexRevision(all),
		};
	}

	async getSession(sessionId: string): Promise<SessionSummary> {
		const info = await this.#findSessionInfo(sessionId);
		if (!info)
			failRpc({
				reason: "SESSION_NOT_FOUND",
				category: "not_found",
				message: `Session not found: ${sessionId}`,
				sessionId,
			});
		return await this.#summaryFromInfo(info);
	}

	async create(params: {
		cwd: string;
		title?: string;
		parentSessionId?: string;
		executionProfileId?: string;
	}): Promise<{ sessionId: SessionId; leaseId: LeaseId; summary: SessionSummary; recovery?: unknown }> {
		if (this.#active)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "A Session is already open in this Runtime",
				sessionId: this.#active.sessionId,
			});
		if (!this.#factory) {
			if (!this.#initialHandle)
				failRpc({
					reason: "CAPABILITY_UNAVAILABLE",
					category: "internal",
					message: "RPC v2 Session factory is not installed",
				});
			const session = this.#initialHandle.session;
			if (session.sessionManager.getCwd() !== params.cwd)
				failRpc({
					reason: "CAPABILITY_UNAVAILABLE",
					category: "internal",
					message: "Session factory is required for a different cwd",
				});
			await session.newSession();
			if (params.title) await session.setSessionName(params.title, "user");
		}
		let parentSessionPath: string | undefined;
		if (params.parentSessionId) {
			const parent = await this.#findSessionInfo(params.parentSessionId);
			if (!parent)
				failRpc({
					reason: "SESSION_NOT_FOUND",
					category: "not_found",
					message: `Parent Session not found: ${params.parentSessionId}`,
					sessionId: params.parentSessionId,
				});
			parentSessionPath = parent.path;
		}
		const handle = this.#factory
			? await this.#factory.create({ cwd: params.cwd, title: params.title, parentSessionPath })
			: (this.#initialHandle as RpcV2SessionHandle);
		if (params.title && this.#factory) await handle.session.setSessionName(params.title, "user");
		await handle.session.sessionManager.ensureOnDisk();
		const active = await this.#attach(handle, "read_write", false);
		if (params.executionProfileId) {
			active.state.settings.executionProfile = params.executionProfileId;
			active.session.settings.set(
				"san.executionLoop.defaultMode",
				params.executionProfileId as "solo" | "team" | "council",
			);
			await this.#persistState(active);
		}
		return {
			sessionId: active.sessionId,
			leaseId: active.lease?.leaseId as LeaseId,
			summary: this.#summaryFromActive(active),
		};
	}

	async open(params: {
		sessionId: string;
		access: "read_write" | "read_only";
		stealExpiredLease?: boolean;
	}): Promise<{ sessionId: SessionId; leaseId: LeaseId; summary: SessionSummary; recovery?: unknown }> {
		if (this.#active)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "A Session is already open in this Runtime",
				sessionId: this.#active.sessionId,
			});
		const info = await this.#findSessionInfo(params.sessionId);
		if (!info)
			failRpc({
				reason: "SESSION_NOT_FOUND",
				category: "not_found",
				message: `Session not found: ${params.sessionId}`,
				sessionId: params.sessionId,
			});
		const prepared =
			params.access === "read_write"
				? await this.#prepareWriteLease(params.sessionId as SessionId, info.path, params.stealExpiredLease === true)
				: undefined;
		let handle: RpcV2SessionHandle | undefined;
		try {
			if (this.#factory) {
				handle = await this.#factory.open({
					sessionFile: info.path,
					access: params.access,
					recovering: Boolean(prepared?.recovery),
				});
			} else if (this.#initialHandle?.session.sessionId === params.sessionId) {
				handle = this.#initialHandle;
			} else {
				failRpc({
					reason: "CAPABILITY_UNAVAILABLE",
					category: "internal",
					message: "Session factory is required to open this Session",
					sessionId: params.sessionId,
				});
			}
			const active = await this.#attach(handle, params.access, params.stealExpiredLease === true, prepared);
			return {
				sessionId: active.sessionId,
				leaseId: active.lease?.leaseId as LeaseId,
				summary: this.#summaryFromActive(active),
				...(active.state.snapshot?.recovery ? { recovery: active.state.snapshot.recovery } : {}),
			};
		} catch (error: unknown) {
			this.#clearFailedAttach(handle);
			try {
				await handle?.dispose?.();
			} finally {
				await this.#releasePreparedLease(info.path, prepared);
			}
			throw error;
		}
	}

	#clearFailedAttach(handle: RpcV2SessionHandle | undefined): void {
		const active = this.#active;
		if (!active || active.handle !== handle) return;
		active.unsubscribe();
		this.#active = undefined;
	}

	async replayCreatedSession(
		sessionId: string,
	): Promise<{ sessionId: SessionId; leaseId: LeaseId; summary: SessionSummary; recovery?: unknown }> {
		if (!this.#active) return await this.open({ sessionId, access: "read_write" });
		if (this.#active.sessionId !== sessionId) {
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Idempotent Session create belongs to ${sessionId}, but ${this.#active.sessionId} is open`,
				sessionId: this.#active.sessionId,
			});
		}
		return {
			sessionId: this.#active.sessionId,
			leaseId: this.#active.lease?.leaseId as LeaseId,
			summary: this.#summaryFromActive(this.#active),
			...(this.#active.state.snapshot?.recovery ? { recovery: this.#active.state.snapshot.recovery } : {}),
		};
	}

	async sync(params: {
		sessionId: string;
		leaseId: string;
		afterSequence?: number | null;
		stream?: StreamPolicy;
	}): Promise<{ result: Record<string, unknown>; subscriptionId: SubscriptionId }> {
		const active = this.assertLease(params.sessionId, params.leaseId, false);
		return await this.#enqueueWork(active, async () => {
			active.stream = params.stream ?? {};
			active.syncPending = true;
			active.synced = true;
			active.syncBuffer = [];
			active.subscriptionId = newSubscriptionId();
			const asOfSequence = active.sequencer.currentSequence;
			active.syncAsOfSequence = asOfSequence;
			const after = params.afterSequence ?? null;
			const firstRetained = active.events[0]?.sequence ?? asOfSequence + 1;
			const canReplay = after !== null && after >= firstRetained - 1 && after <= asOfSequence;
			const base = {
				mode: canReplay ? "replay" : "snapshot",
				subscriptionId: active.subscriptionId,
				asOfSequence,
				...(canReplay
					? { events: active.events.filter(event => event.sequence > after && event.sequence <= asOfSequence) }
					: { snapshot: await this.#buildSnapshot(active, asOfSequence) }),
			};
			await this.#persistState(active);
			return { result: base, subscriptionId: active.subscriptionId as SubscriptionId };
		});
	}

	/** 在 sync response 已排队后调用，释放临界区内缓冲的事件。 */
	async finishSync(subscriptionId: string): Promise<void> {
		const active = this.#active;
		if (!active || active.subscriptionId !== subscriptionId) return;
		await this.#enqueueWork(active, async () => {
			if (active.subscriptionId !== subscriptionId) return;
			const buffered = active.syncBuffer
				.filter(event => event.sequence > (active.syncAsOfSequence ?? 0))
				.sort((left, right) => left.sequence - right.sequence);
			active.syncPending = false;
			active.syncAsOfSequence = undefined;
			active.syncBuffer = [];
			for (const event of buffered) await this.#publishEvent(event);
		});
	}

	async unsync(subscriptionId: string): Promise<{ unsynced: boolean }> {
		const active = this.#active;
		if (!active || active.subscriptionId !== subscriptionId) return { unsynced: false };
		return await this.#enqueueWork(active, async () => {
			if (active.subscriptionId !== subscriptionId) return { unsynced: false };
			active.synced = false;
			active.syncPending = false;
			active.syncAsOfSequence = undefined;
			active.syncBuffer = [];
			active.subscriptionId = undefined;
			return { unsynced: true };
		});
	}

	async listEvents(params: {
		sessionId: string;
		afterSequence?: number;
		beforeSequence?: number;
		cursor?: string;
		limit?: number;
		types?: string[];
	}): Promise<{ events: SessionEvent[]; nextCursor: string | null; firstSequence: number; lastSequence: number }> {
		const active = this.assertSession(params.sessionId);
		await active.eventTail;
		const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
		let events = active.events;
		const afterSequence = params.afterSequence;
		const beforeSequence = params.beforeSequence;
		if (afterSequence !== undefined) events = events.filter(event => event.sequence > afterSequence);
		if (beforeSequence !== undefined) events = events.filter(event => event.sequence < beforeSequence);
		if (params.types && params.types.length > 0) events = events.filter(event => params.types?.includes(event.type));
		const offset = decodeCursor(params.cursor);
		const page = events.slice(offset, offset + limit);
		return {
			events: page,
			nextCursor: offset + limit < events.length ? encodeCursor(offset + limit) : null,
			firstSequence: active.events[0]?.sequence ?? 0,
			lastSequence: active.sequencer.currentSequence,
		};
	}

	assertSession(sessionId?: string): ActiveSession {
		const active = this.#active;
		if (!active)
			failRpc({
				reason: "SESSION_NOT_FOUND",
				category: "not_found",
				message: "No Session is open in this Runtime",
				...(sessionId ? { sessionId } : {}),
			});
		if (sessionId && active.sessionId !== sessionId)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Session ${sessionId} is not the active Session`,
				sessionId,
			});
		if (active.fatalError) throw active.fatalError;
		return active;
	}

	assertLease(sessionId: string, leaseId: string, write: boolean): ActiveSession {
		const active = this.assertSession(sessionId);
		if (!active.lease || active.lease.leaseId !== leaseId)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Lease does not belong to the active Session",
				sessionId,
				details: { expectedLeaseId: active.lease?.leaseId },
			});
		if (write && active.lease.access !== "read_write")
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Session is read_only",
				sessionId,
			});
		if (write && active.state.snapshot?.lifecycle === "recovering")
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Session recovery must be resolved before mutations",
				sessionId,
				suggestedActions: ["session.recover"],
			});
		return active;
	}

	assertRevision(active: ActiveSession, expectedRevision: number | undefined): void {
		if (expectedRevision !== undefined && expectedRevision !== active.state.revision)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Revision conflict: expected ${expectedRevision}, current ${active.state.revision}`,
				sessionId: active.sessionId,
				details: { currentRevision: active.state.revision },
				suggestedActions: ["session.sync"],
			});
	}

	async emitCustom<T>(
		active: ActiveSession,
		type: SessionEvent["type"],
		data: T,
		options?: {
			durability?: "durable" | "transient";
			runId?: RunId;
			turnId?: string;
			operationId?: string;
			receipt?: PersistedSessionMutationReceipt;
		},
	): Promise<SessionEvent<T>> {
		return await this.#enqueueWork(active, async () => {
			const event = active.sequencer.emit(type, data, {
				durability: options?.durability,
				runId: options?.runId,
				turnId: options?.turnId as never,
				causation: options?.operationId ? { operationId: options.operationId as never } : undefined,
			});
			await this.#persistAndPublish(active, event, options?.receipt);
			return event;
		});
	}

	async acceptRun(
		active: ActiveSession,
		operationId?: OperationId,
		resourceIds: readonly string[] = [],
		receipt?: SessionMutationReceipt,
	): Promise<{ runId: RunId; operationId: OperationId; userMessageId: string; acceptedAt: string }> {
		if (active.activeRun && !isTerminalRun(active.activeRun.status))
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: "Session already has an active Run",
				sessionId: active.sessionId,
				runId: active.activeRun.runId,
			});
		const runId = newRunId();
		const opId = operationId ?? newOperationId();
		const acceptedAt = new Date().toISOString();
		const userMessageId = newMessageId();
		active.activeRun = { runId, status: "accepted", userMessageId };
		active.activeResourceIds = new Set(resourceIds);
		active.adapter.currentRunId = runId;
		active.adapter.currentOperationId = opId;
		active.adapter.currentRunTerminalStatus = undefined;
		const response = { runId, operationId: opId, acceptedAt };
		await this.emitCustom(active, "run.accepted", response, {
			runId,
			operationId: opId,
			...(receipt ? { receipt: { ...receipt, result: response } } : {}),
		});
		await this.#persistState(active);
		return { runId, operationId: opId, userMessageId, acceptedAt };
	}

	async startRun(
		active: ActiveSession,
		resolved: ResolvedRunContent,
		operationId?: OperationId,
		receipt?: SessionMutationReceipt,
	): Promise<{ runId: RunId; operationId: OperationId; userMessageId: string; acceptedAt: string }> {
		const accepted = await this.acceptRun(active, operationId, resolved.resourceIds, receipt);
		this.#launchPrompt(active, accepted.runId, resolved);
		return accepted;
	}

	async steerRun(
		active: ActiveSession,
		runId: string,
		resolved: ResolvedRunContent,
	): Promise<{ accepted: true; runId: RunId }> {
		if (!active.activeRun || active.activeRun.runId !== runId || isTerminalRun(active.activeRun.status)) {
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: `Run ${runId} is not the active Run`,
				sessionId: active.sessionId,
				runId,
				details: { activeRunId: active.activeRun?.runId },
			});
		}
		await active.session.steer(resolved.text, resolved.images);
		for (const resourceId of resolved.resourceIds) active.activeResourceIds.add(resourceId);
		await this.#persistState(active);
		return { accepted: true, runId: active.activeRun.runId };
	}

	async replaceRun(
		active: ActiveSession,
		expectedRunId: string,
		resolved: ResolvedRunContent,
		operationId?: OperationId,
	): Promise<{
		runId: RunId;
		operationId: OperationId;
		userMessageId: string;
		acceptedAt: string;
		replacedRunId: RunId;
	}> {
		if (!active.activeRun || active.activeRun.runId !== expectedRunId || isTerminalRun(active.activeRun.status)) {
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: `Run ${expectedRunId} is not the active Run`,
				sessionId: active.sessionId,
				runId: expectedRunId,
				details: { activeRunId: active.activeRun?.runId },
			});
		}
		const replacedRunId = active.activeRun.runId;
		await active.session.abort({ reason: "user" });
		await active.eventTail;
		if (active.activeRun?.runId === replacedRunId) await this.markRunStatus(active, "aborted", "replaced");
		const accepted = await this.startRun(active, resolved, operationId);
		return { ...accepted, replacedRunId };
	}

	async abortRun(
		active: ActiveSession,
		runId: string,
		reason: "user" | "close" | "shutdown",
	): Promise<{ accepted: true; runId: RunId }> {
		if (!active.activeRun || active.activeRun.runId !== runId || isTerminalRun(active.activeRun.status)) {
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: `Run ${runId} is not the active Run`,
				sessionId: active.sessionId,
				runId,
				details: { activeRunId: active.activeRun?.runId },
			});
		}
		await active.session.abort({ reason });
		return { accepted: true, runId: active.activeRun?.runId ?? (runId as RunId) };
	}

	async promoteQueueIfIdle(active: ActiveSession): Promise<void> {
		await this.#promoteNextQueue(active);
	}

	async addQueueItem(active: ActiveSession, content: ContentPart[], operationId?: OperationId): Promise<QueueItem> {
		const opId = operationId ?? newOperationId();
		const item: QueueItem = {
			queueItemId: newQueueItemId(),
			sessionId: active.sessionId,
			createdAt: new Date().toISOString(),
			position: active.queue.length,
			status: "queued",
			contentPreview: content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n")
				.slice(0, 500),
			imageCount: content.filter(part => part.type === "image").length,
			sourceOperationId: opId,
		};
		active.queue.push(item);
		active.queueContent.set(item.queueItemId, structuredClone(content));
		await this.emitCustom(active, "queue.item.added", { item }, { operationId: opId });
		await this.#persistState(active);
		return item;
	}

	async cancelQueueItem(
		active: ActiveSession,
		queueItemId: string,
		expectedStatus?: string,
		operationId?: string,
		receipt?: SessionMutationReceipt,
	): Promise<{ item: QueueItem; revision: number }> {
		const item = active.queue.find(candidate => candidate.queueItemId === queueItemId);
		if (!item)
			failRpc({
				reason: "QUEUE_ITEM_NOT_FOUND",
				category: "not_found",
				message: `Queue item not found: ${queueItemId}`,
				sessionId: active.sessionId,
			});
		if (expectedStatus && item.status !== expectedStatus)
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: `Queue item status is ${item.status}`,
				sessionId: active.sessionId,
				details: { currentStatus: item.status },
			});
		if (item.status !== "queued")
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: "Promoted queue item cannot be cancelled",
				sessionId: active.sessionId,
			});
		item.status = "cancelled";
		await this.emitCustom(
			active,
			"queue.item.cancelled",
			{ item },
			{
				operationId,
				...(receipt
					? {
							receipt: {
								...receipt,
								result: (revision: number) => ({ item: structuredClone(item), revision }),
							},
						}
					: {}),
			},
		);
		await this.#persistState(active);
		return { item, revision: active.state.revision };
	}

	async rename(
		active: ActiveSession,
		name: string,
		operationId?: string,
	): Promise<{ summary: SessionSummary; revision: number }> {
		const title = name.trim();
		if (!title)
			failRpc({
				reason: "INVALID_PARAMS",
				category: "validation",
				message: "Session title cannot be empty",
				sessionId: active.sessionId,
			});
		await active.session.setSessionName(title, "user");
		await this.emitCustom(active, "session.title.changed", { title }, { operationId });
		return { summary: this.#summaryFromActive(active), revision: active.state.revision };
	}

	async branch(
		active: ActiveSession,
		entryId: string,
		title?: string,
	): Promise<{
		sessionId: SessionId;
		leaseId: LeaseId;
		summary: SessionSummary;
		sourceSessionId: SessionId;
	}> {
		if (active.activeRun || active.session.isStreaming) {
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: "Cannot branch while a Run is active",
				sessionId: active.sessionId,
				runId: active.activeRun?.runId,
			});
		}
		const sourceSessionId = active.sessionId;
		const result = await active.session.branch(entryId);
		if (result.cancelled)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Session branch was cancelled by an extension",
				sessionId: sourceSessionId,
			});
		if (title?.trim()) await active.session.setSessionName(title.trim(), "user");
		const next = await this.#rebindSwitchedSession(active);
		return {
			sessionId: next.sessionId,
			leaseId: next.lease?.leaseId as LeaseId,
			summary: this.#summaryFromActive(next),
			sourceSessionId,
		};
	}

	async handoff(
		active: ActiveSession,
		instructions?: string,
	): Promise<{
		sessionId: SessionId;
		leaseId: LeaseId;
		summary: SessionSummary;
		document: string;
		savedPath?: string;
		sourceSessionId: SessionId;
	}> {
		if (active.activeRun || active.session.isStreaming) {
			failRpc({
				reason: "RUN_STATE_CONFLICT",
				category: "conflict",
				message: "Cannot hand off while a Run is active",
				sessionId: active.sessionId,
				runId: active.activeRun?.runId,
			});
		}
		const sourceSessionId = active.sessionId;
		const result = await active.session.handoff(instructions);
		if (!result)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Session handoff did not produce a document",
				sessionId: sourceSessionId,
			});
		const next = await this.#rebindSwitchedSession(active);
		return {
			sessionId: next.sessionId,
			leaseId: next.lease?.leaseId as LeaseId,
			summary: this.#summaryFromActive(next),
			document: result.document,
			...(result.savedPath ? { savedPath: result.savedPath } : {}),
			sourceSessionId,
		};
	}

	async registerApproval(active: ActiveSession, approval: ApprovalRequest): Promise<void> {
		active.pendingApprovals = [
			...active.pendingApprovals.filter(item => item.approvalId !== approval.approvalId),
			approval,
		];
		await this.emitCustom(
			active,
			"approval.requested",
			{ approval },
			{ durability: "durable", runId: approval.runId },
		);
		if (active.activeRun?.runId === approval.runId && active.activeRun.status !== "waiting_approval") {
			await this.markRunStatus(active, "waiting_approval", `Waiting for Approval ${approval.approvalId}`);
		}
	}

	async resolveApproval(
		active: ActiveSession,
		approvalId: string,
		decision: "allow" | "deny",
		scope: string,
		persistedRule: boolean,
		receipt?: PersistedSessionMutationReceipt,
	): Promise<ApprovalRequest> {
		const approval = active.pendingApprovals.find(item => item.approvalId === approvalId);
		if (approval?.status !== "pending")
			failRpc({
				reason: "APPROVAL_NOT_PENDING",
				category: "conflict",
				message: `Approval is not pending: ${approvalId}`,
				sessionId: active.sessionId,
			});
		approval.status = decision === "allow" ? "allowed" : "denied";
		active.pendingApprovals = active.pendingApprovals.filter(item => item.approvalId !== approvalId);
		await this.emitCustom(
			active,
			"approval.resolved",
			{ approvalId: approval.approvalId, decision, scope, persistedRule },
			{ runId: approval.runId, ...(receipt ? { receipt } : {}) },
		);
		if (
			active.activeRun?.runId === approval.runId &&
			active.pendingApprovals.every(item => item.runId !== approval.runId)
		) {
			await this.markRunStatus(active, "running", `Approval ${approvalId} resolved`);
		}
		return approval;
	}

	async registerInteraction(active: ActiveSession, interaction: InteractionRequest): Promise<void> {
		active.pendingInteractions = [
			...active.pendingInteractions.filter(item => item.interactionId !== interaction.interactionId),
			interaction,
		];
		await this.emitCustom(
			active,
			"interaction.requested",
			{ interaction },
			{ durability: "durable", runId: interaction.runId },
		);
	}

	async resolveInteraction(
		active: ActiveSession,
		interactionId: string,
		response: unknown,
	): Promise<InteractionRequest> {
		const interaction = active.pendingInteractions.find(item => item.interactionId === interactionId);
		if (interaction?.status !== "pending")
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Interaction is not pending: ${interactionId}`,
				sessionId: active.sessionId,
			});
		interaction.status = "answered";
		active.pendingInteractions = active.pendingInteractions.filter(item => item.interactionId !== interactionId);
		await this.emitCustom(active, "interaction.answered", { interactionId, response }, { runId: interaction.runId });
		return interaction;
	}

	async cancelInteraction(active: ActiveSession, interactionId: string, reason: string): Promise<InteractionRequest> {
		const interaction = active.pendingInteractions.find(item => item.interactionId === interactionId);
		if (interaction?.status !== "pending")
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Interaction is not pending: ${interactionId}`,
				sessionId: active.sessionId,
			});
		interaction.status = "cancelled";
		active.pendingInteractions = active.pendingInteractions.filter(item => item.interactionId !== interactionId);
		await this.emitCustom(active, "interaction.cancelled", { interactionId, reason }, { runId: interaction.runId });
		return interaction;
	}

	async markRunStatus(active: ActiveSession, status: RunStatus, reason?: string): Promise<void> {
		if (!active.activeRun) return;
		const previous = active.activeRun.status;
		active.activeRun = {
			...active.activeRun,
			status,
			...(reason ? { reason } : {}),
			...(isTerminalRun(status) ? { finishedAt: new Date().toISOString() } : {}),
		};
		active.adapter.currentRunTerminalStatus = isRunTerminal(status) ? status : undefined;
		if (isTerminalRun(status)) {
			active.lastRun = active.activeRun;
			if (status === "completed" || status === "failed" || status === "aborted" || status === "interrupted") {
				await this.emitCustom(
					active,
					status === "completed"
						? "run.completed"
						: status === "failed"
							? "run.failed"
							: status === "aborted"
								? "run.aborted"
								: "run.interrupted",
					active.activeRun,
					{ runId: active.activeRun.runId },
				);
			}
			active.activeRun = undefined;
			active.activeResourceIds.clear();
		} else if (previous !== status) {
			await this.emitCustom(
				active,
				"run.state.changed",
				{ runId: active.activeRun.runId, previousStatus: previous, status, reason },
				{ runId: active.activeRun.runId },
			);
		}
		await this.#persistState(active);
		if (isTerminalRun(status)) await this.#flushDeferredResourceReleases(active);
	}

	async recover(
		active: ActiveSession,
		strategy: "continue" | "mark_aborted" | "read_only",
	): Promise<{ recovered: boolean; lastStableSequence: number }> {
		if (!active.sessionFile) return { recovered: true, lastStableSequence: active.sequencer.currentSequence };
		let result: { recovered: boolean; lastStableSequence: number };
		try {
			result = await executeRecovery(
				active.sessionId,
				strategy,
				this.#runtimeId as RuntimeId,
				active.sessionFile,
				active.lease?.leaseId,
			);
		} catch (error: unknown) {
			if (error instanceof Error && error.message === "SESSION_LOCKED") {
				failRpc({
					reason: "SESSION_LOCKED",
					category: "conflict",
					message: `Session recovery lease changed: ${active.sessionId}`,
					sessionId: active.sessionId,
					retryable: true,
				});
			}
			throw error;
		}
		if (strategy === "read_only") {
			active.lease = active.lease ? { ...active.lease, access: "read_only", held: false } : undefined;
		} else if (active.lease) {
			active.lease = { ...active.lease, held: true };
			active.session.enableSessionWrites();
			active.session.repairInterruptedTurnAfterRecovery();
		}
		if (strategy === "mark_aborted" && active.lastRun?.status === "interrupted") {
			active.lastRun = {
				...active.lastRun,
				status: "aborted",
				finishedAt: new Date().toISOString(),
				reason: "recovery_mark_aborted",
			};
		}
		if (active.state.snapshot)
			active.state.snapshot = {
				...active.state.snapshot,
				lifecycle: strategy === "read_only" ? "read_only" : "ready",
				recovery: undefined,
			};
		await this.#binder?.(active);
		if (strategy === "read_only") return result;
		active.state.revision++;
		await this.#persistState(active);
		await this.emitCustom(
			active,
			"session.recovered",
			{ strategy, lastStableSequence: result.lastStableSequence },
			{ durability: "durable" },
		);
		return result;
	}

	async close(options?: { abortRunning?: boolean }): Promise<void> {
		const active = this.#active;
		if (!active) return;
		if (active.lease?.access === "read_only" || active.state.snapshot?.lifecycle === "recovering") {
			active.unsubscribe();
			if (active.sessionFile && active.lease?.held) {
				await abandonRecoveryLease(active.sessionFile, active.lease.leaseId, this.#runtimeId, active.sessionId);
			}
			await active.handle.dispose?.();
			this.#active = undefined;
			return;
		}
		if (active.activeRun && !isTerminalRun(active.activeRun.status)) {
			if (!options?.abortRunning)
				failRpc({
					reason: "RUN_STATE_CONFLICT",
					category: "conflict",
					message: "Cannot close while a Run is active",
					sessionId: active.sessionId,
					runId: active.activeRun.runId,
				});
			await active.session.abort({ reason: "shutdown" });
		}
		if (this.#active !== active) return;
		if (active.backgroundTasks.size > 0) await Promise.allSettled(active.backgroundTasks);
		if (this.#active !== active) return;
		await active.eventTail;
		if (this.#active !== active) return;
		if (active.activeRun) await this.markRunStatus(active, "aborted", "session_closed");
		if (this.#active !== active) return;
		if (active.lease?.access === "read_write") {
			await this.#flushDeferredResourceReleases(active);
			if (this.#active !== active) return;
			await active.session.sessionManager.flush();
			if (this.#active !== active) return;
		}
		active.unsubscribe();
		try {
			await active.handle.dispose?.();
		} finally {
			if (active.sessionFile && active.lease?.access === "read_write" && active.lease.held) {
				await removeLeaseRecord(active.sessionFile, active.lease.leaseId, this.#runtimeId);
			}
			if (this.#active === active) this.#active = undefined;
		}
	}

	async deleteSession(
		sessionId: string,
		mode: "trash" | "permanent" = "trash",
		expectedRevision?: number,
	): Promise<{ deleted: boolean; mode: string; indexRevision: number }> {
		const info = await this.#findSessionInfo(sessionId);
		if (!info)
			failRpc({
				reason: "SESSION_NOT_FOUND",
				category: "not_found",
				message: `Session not found: ${sessionId}`,
				sessionId,
			});
		if (this.#active?.sessionId === sessionId)
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: "Close the active Session before deleting it",
				sessionId,
			});
		const sidecar = new RpcV2StateStore(info.path, sessionId);
		const loaded = await sidecar.load();
		if (expectedRevision !== undefined && loaded.state.revision !== expectedRevision) {
			failRpc({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: `Revision conflict: expected ${expectedRevision}, current ${loaded.state.revision}`,
				sessionId,
				details: { currentRevision: loaded.state.revision },
			});
		}
		try {
			const lease = JSON.parse(await Bun.file(leasePath(info.path)).text()) as LeaseRecord;
			try {
				process.kill(lease.pid, 0);
				failRpc({
					reason: "SESSION_LOCKED",
					category: "conflict",
					message: `Session has an active lease: ${sessionId}`,
					sessionId,
					retryable: true,
				});
			} catch (error: unknown) {
				if (error instanceof Error && error.message.includes("active lease")) throw error;
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes("active lease")) throw error;
			if (!String(error).includes("ENOENT")) {
				// A malformed lease is not safe to delete silently.
				if (!(error as NodeJS.ErrnoException).code) throw error;
			}
		}
		const paths = rpcV2StatePaths(info.path);
		const artifacts = info.path.endsWith(".jsonl") ? info.path.slice(0, -6) : `${info.path}.artifacts`;
		const resources = `${info.path}.rpc-v2.resources`;
		const related = [
			info.path,
			paths.state,
			paths.events,
			leasePath(info.path),
			recoveryPathForSession(info.path),
			artifacts,
			resources,
		];
		if (mode === "permanent") {
			await Promise.all(related.map(target => fs.rm(target, { recursive: true, force: true })));
		} else {
			const trashDir = path.join(path.dirname(info.path), ".trash");
			const targetDir = path.join(trashDir, `${path.basename(info.path)}.${Date.now()}.${newOperationId()}`);
			await fs.mkdir(targetDir, { recursive: true });
			for (const target of related) {
				try {
					await fs.rename(target, path.join(targetDir, path.basename(target)));
				} catch (error: unknown) {
					if (!String(error).includes("ENOENT")) throw error;
				}
			}
		}
		return { deleted: true, mode, indexRevision: Date.now() };
	}

	async shutdown(options?: { force?: boolean; timeoutMs?: number }): Promise<void> {
		if (options?.force) {
			await this.#forceShutdown();
			return;
		}
		const graceful = this.close({ abortRunning: true });
		if (options?.timeoutMs === undefined) {
			await graceful;
			return;
		}
		let gracefulError: unknown;
		const settled = graceful.then(
			() => true,
			error => {
				gracefulError = error;
				return true;
			},
		);
		const completed = await Promise.race([settled, Bun.sleep(options.timeoutMs).then(() => false)]);
		if (completed) {
			if (gracefulError !== undefined) throw gracefulError;
			return;
		}
		await this.#forceShutdown();
	}

	async #forceShutdown(): Promise<void> {
		const active = this.#active;
		if (!active) return;
		active.session.beginDispose();
		active.session.disableSessionWrites();
		active.session.abortRetry();
		active.session.abortCompaction();
		active.session.abortHandoff();
		active.session.abortBash();
		active.session.abortEval();
		active.session.agent.abort("shutdown");
		const disconnectMcp = active.handle.mcpManager?.disconnectAll();
		if (disconnectMcp) {
			void disconnectMcp.catch(error => {
				logger.warn("RPC v2 force shutdown failed to disconnect MCP", { error: String(error) });
			});
		}
		active.unsubscribe();
		this.#active = undefined;
		if (active.sessionFile && active.lease?.access === "read_write" && active.lease.held) {
			if (active.state.snapshot?.lifecycle === "recovering") {
				await abandonRecoveryLease(active.sessionFile, active.lease.leaseId, this.#runtimeId, active.sessionId);
			} else {
				await removeLeaseRecord(active.sessionFile, active.lease.leaseId, this.#runtimeId);
			}
		}
	}

	/** 给 UI/Router 使用的当前 Session 快照。 */
	async buildCurrentSnapshot(): Promise<SessionSnapshot> {
		const active = this.assertSession();
		return await this.#buildSnapshot(active, active.sequencer.currentSequence);
	}

	buildCurrentContinuitySnapshot(): ContinuitySnapshot {
		return this.#buildContinuitySnapshot(this.assertSession());
	}

	// -----------------------------------------------------------------------
	// Attach / event persistence
	// -----------------------------------------------------------------------

	async #attach(
		handle: RpcV2SessionHandle,
		access: "read_write" | "read_only",
		stealExpiredLease: boolean,
		prepared?: PreparedLease,
	): Promise<ActiveSession> {
		const session = handle.session;
		const sessionId = session.sessionId as SessionId;
		const sessionFile = session.sessionFile;
		if (prepared && prepared.lease.sessionId !== sessionId) {
			throw new Error(`Opened Session ${sessionId} does not match leased Session ${prepared.lease.sessionId}`);
		}
		const store = new RpcV2StateStore(sessionFile, sessionId);
		const loaded = await store.load();
		const cwd = session.sessionManager.getCwd();
		const [globalRuntimeSettings, workspaceRuntimeSettings] = await Promise.all([
			this.#runtimeSettings.load("global"),
			this.#runtimeSettings.load("workspace", cwd),
		]);
		applyRuntimeSettingsOverrides(session, loaded.state, globalRuntimeSettings, workspaceRuntimeSettings);
		const lastSequence = Math.max(loaded.state.lastSequence, loaded.events.at(-1)?.sequence ?? 0);
		const eventSequencer = new EventSequencer(sessionId, lastSequence);
		const adapter = new AdapterContext();
		const evidence = new EvidenceLedger(loaded.state.evidence);
		const idempotency = new IdempotencyStore();
		idempotency.load(loaded.state.receipts);
		const active: ActiveSession = {
			handle,
			session,
			sessionId,
			sessionFile,
			store,
			state: loaded.state,
			events: loaded.events.slice(-this.#retention),
			sequencer: eventSequencer,
			adapter,
			unsubscribe: () => undefined,
			syncPending: false,
			syncBuffer: [],
			synced: false,
			stream: {},
			eventTail: Promise.resolve(),
			queue: reviveQueue(loaded.state.queue, sessionId),
			queueContent: reviveQueueContent(loaded.state.queue),
			pendingApprovals: reviveApprovals(loaded.state.pendingApprovals, sessionId),
			pendingInteractions: reviveInteractions(loaded.state.pendingInteractions, sessionId),
			evidence,
			idempotency,
			globalRuntimeSettings,
			workspaceRuntimeSettings,
			backgroundTasks: new Set(),
			activeRun: reviveRun(loaded.state.activeRun, session.sessionManager.getCwd()),
			lastRun: reviveRun(loaded.state.lastRun, session.sessionManager.getCwd()),
			activeResourceIds: new Set(loaded.state.activeResourceIds),
			pendingResourceReleases: new Set(loaded.state.pendingResourceReleases),
			maintenance: reviveMaintenance(loaded.state.maintenance, session.sessionManager.getCwd()),
		};
		if (prepared) {
			active.lease = prepared.lease;
			if (prepared.recovery) this.#applyRecoveryDescriptor(active, prepared.recovery);
		} else if (access === "read_write") {
			let recovery: RecoveryDescriptor | undefined;
			try {
				recovery = sessionFile ? await detectRecovery(sessionId, this.#runtimeId as never, sessionFile) : undefined;
			} catch (error: unknown) {
				if (error instanceof Error && error.message === "SESSION_LOCKED") {
					failRpc({
						reason: "SESSION_LOCKED",
						category: "conflict",
						message: `Session is locked by another Runtime: ${sessionId}`,
						sessionId,
						retryable: true,
					});
				}
				throw error;
			}
			const leaseId = newLeaseId();
			if (sessionFile && (!recovery || stealExpiredLease)) {
				await acquireLease(
					sessionFile,
					{
						leaseId,
						runtimeId: this.#runtimeId,
						pid: process.pid,
						sessionId,
						acquiredAt: new Date().toISOString(),
						lastHeartbeat: new Date().toISOString(),
						lastStableSequence: lastSequence,
					},
					Boolean(recovery && stealExpiredLease),
				);
			}
			active.lease = {
				leaseId,
				sessionId,
				access,
				acquiredAt: new Date().toISOString(),
				held: !sessionFile || !recovery || stealExpiredLease,
			};
			if (recovery) this.#applyRecoveryDescriptor(active, recovery);
		} else {
			active.lease = { leaseId: newLeaseId(), sessionId, access, acquiredAt: new Date().toISOString(), held: false };
		}
		const listener = (event: AgentSessionEvent): void => {
			const work = this.#enqueueWork(active, () => this.#handleAgentEvent(active, event));
			if (event.type === "agent_end") {
				void work
					.then(() => this.#promoteNextQueue(active))
					.catch(error => {
						active.fatalError = error instanceof Error ? error : new Error(String(error));
					});
			}
		};
		active.unsubscribe = session.subscribe(listener);
		this.#active = active;
		await this.#binder?.(active);
		if (active.lease?.access === "read_write" && active.lease.held && !active.state.snapshot?.recovery) {
			await this.#persistState(active);
			if (!active.activeRun) await this.#flushDeferredResourceReleases(active);
		}
		return active;
	}

	async #prepareWriteLease(
		sessionId: SessionId,
		sessionFile: string,
		stealExpiredLease: boolean,
	): Promise<PreparedLease> {
		let recovery: RecoveryDescriptor | undefined;
		try {
			recovery = await detectRecovery(sessionId, this.#runtimeId as RuntimeId, sessionFile);
		} catch (error: unknown) {
			if (error instanceof Error && error.message === "SESSION_LOCKED") {
				failRpc({
					reason: "SESSION_LOCKED",
					category: "conflict",
					message: `Session is locked by another Runtime: ${sessionId}`,
					sessionId,
					retryable: true,
				});
			}
			throw error;
		}
		const leaseId = newLeaseId();
		const acquiredAt = new Date().toISOString();
		const held = !recovery || stealExpiredLease;
		if (held) {
			const loaded = await new RpcV2StateStore(sessionFile, sessionId).load();
			const lastSequence = Math.max(
				loaded.state.lastSequence,
				loaded.events.at(-1)?.sequence ?? 0,
				recovery?.lastStableSequence ?? 0,
			);
			try {
				await acquireLease(
					sessionFile,
					{
						leaseId,
						runtimeId: this.#runtimeId,
						pid: process.pid,
						sessionId,
						acquiredAt,
						lastHeartbeat: acquiredAt,
						lastStableSequence: lastSequence,
					},
					Boolean(recovery && stealExpiredLease),
				);
			} catch (error: unknown) {
				if (error instanceof Error && error.message === "SESSION_LOCKED") {
					failRpc({
						reason: "SESSION_LOCKED",
						category: "conflict",
						message: `Session is locked by another Runtime: ${sessionId}`,
						sessionId,
						retryable: true,
					});
				}
				throw error;
			}
		}
		return {
			lease: { leaseId, sessionId, access: "read_write", acquiredAt, held },
			...(recovery ? { recovery } : {}),
		};
	}

	#applyRecoveryDescriptor(active: ActiveSession, recovery: RecoveryDescriptor): void {
		if (active.activeRun && !isTerminalRun(active.activeRun.status)) {
			const interruptedRun = {
				...active.activeRun,
				status: "interrupted" as const,
				finishedAt: new Date().toISOString(),
				reason: "runtime_crash",
			};
			active.lastRun = interruptedRun;
			active.activeRun = undefined;
			active.activeResourceIds.clear();
			recovery.interruptedRunId = interruptedRun.runId;
		}
		active.state.snapshot = { ...(active.state.snapshot ?? {}), lifecycle: "recovering", recovery };
	}

	async #releasePreparedLease(sessionFile: string, prepared?: PreparedLease): Promise<void> {
		if (!prepared?.lease.held) return;
		if (prepared.recovery) {
			await abandonRecoveryLease(sessionFile, prepared.lease.leaseId, this.#runtimeId, prepared.lease.sessionId);
		} else {
			await removeLeaseRecord(sessionFile, prepared.lease.leaseId, this.#runtimeId);
		}
	}

	async #rebindSwitchedSession(previous: ActiveSession): Promise<ActiveSession> {
		await previous.eventTail;
		previous.unsubscribe();
		if (previous.sessionFile && previous.lease?.access === "read_write" && previous.lease.held)
			await removeLeaseRecord(previous.sessionFile, previous.lease.leaseId, this.#runtimeId);
		this.#active = undefined;
		return await this.#attach(previous.handle, "read_write", false);
	}

	async #handleAgentEvent(active: ActiveSession, event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start" && active.activeRun) {
			active.activeRun = {
				...active.activeRun,
				status: "running",
				startedAt: active.activeRun.startedAt ?? new Date().toISOString(),
			};
		}
		if (event.type === "agent_end" && active.activeRun) {
			const message = event.messages.at(-1);
			const stopReason = message && "stopReason" in message ? message.stopReason : undefined;
			const status = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
			active.adapter.currentRunTerminalStatus = status;
			active.lastRun = { ...active.activeRun, status, finishedAt: new Date().toISOString() };
			active.activeRun = undefined;
			active.activeResourceIds.clear();
		}
		const adapted = adaptSessionEvent(event, active.sequencer, active.adapter);
		if (!adapted) return;
		if (event.type === "tool_execution_end") {
			const evidence = generateToolEvidence(
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError === true,
					result: event.result,
				},
				{
					sessionId: active.sessionId,
					runId: active.adapter.currentRunId,
					turnId: active.adapter.currentTurnId,
					eventId: adapted.eventId,
					sequence: adapted.sequence,
				},
			);
			active.evidence.append(evidence);
			const evidenceEvent = active.sequencer.emit(
				"evidence.recorded",
				{ evidenceId: evidence.evidenceId, kind: evidence.kind, verdict: evidence.verdict, title: evidence.title },
				{ runId: active.adapter.currentRunId, durability: "durable" },
			);
			await this.#persistAndPublish(active, adapted);
			await this.#persistAndPublish(active, evidenceEvent);
		} else {
			await this.#persistAndPublish(active, adapted);
		}
		if (event.type === "agent_end") {
			active.adapter.currentRunId = undefined;
			active.adapter.currentTurnId = undefined;
			active.adapter.currentRunTerminalStatus = undefined;
		}
		await this.#persistState(active);
		if (event.type === "agent_end") await this.#flushDeferredResourceReleases(active);
	}

	async #promoteNextQueue(active: ActiveSession): Promise<void> {
		if (active.activeRun || this.#active !== active) return;
		const item = active.queue.find(candidate => candidate.status === "queued");
		if (!item) return;
		const content = active.queueContent.get(item.queueItemId) ?? [];
		if (!this.#contentResolver) {
			throw new Error("RPC v2 queue content resolver is not installed");
		}
		const resolved = await this.#contentResolver({ session: active.session, sessionId: active.sessionId, content });
		const accepted = await this.acceptRun(active, item.sourceOperationId, resolved.resourceIds);
		item.status = "promoted";
		item.promotedRunId = accepted.runId;
		await this.emitCustom(
			active,
			"queue.item.promoted",
			{ queueItemId: item.queueItemId, runId: accepted.runId },
			{ runId: accepted.runId, operationId: accepted.operationId },
		);
		this.#launchPrompt(active, accepted.runId, resolved);
	}

	#launchPrompt(active: ActiveSession, runId: RunId, resolved: ResolvedRunContent): void {
		const task = (async () => {
			try {
				const forwarded = await active.session.prompt(resolved.text, { images: resolved.images });
				if (!forwarded && active.activeRun?.runId === runId) await this.markRunStatus(active, "completed");
			} catch (error: unknown) {
				if (active.activeRun?.runId === runId) {
					await this.markRunStatus(
						active,
						"failed",
						sanitizeRpcError(error, { cwd: active.session.sessionManager.getCwd() }),
					);
				}
			}
		})();
		this.#trackBackgroundTask(active, task);
	}

	#trackBackgroundTask(active: ActiveSession, task: Promise<void>): void {
		active.backgroundTasks.add(task);
		void task
			.finally(() => active.backgroundTasks.delete(task))
			.catch(error => {
				active.fatalError = error instanceof Error ? error : new Error(String(error));
			});
	}

	async #runContextMaintenance(
		active: ActiveSession,
		maintenance: ContextMaintenance,
		params: { instructions?: string; mode?: CompactMode },
	): Promise<void> {
		try {
			await active.session.compact(params.instructions, params.mode ? { mode: params.mode } : undefined);
			maintenance.state = "completed";
		} catch (error: unknown) {
			if (maintenance.reason === "client_cancelled") {
				maintenance.state = "cancelled";
			} else {
				maintenance.state = "failed";
				maintenance.reason = sanitizeRpcError(error, { cwd: active.session.sessionManager.getCwd() });
			}
		}
		maintenance.finishedAt = new Date().toISOString();
		await this.emitCustom(
			active,
			"context.maintenance.completed",
			{
				maintenanceId: maintenance.maintenanceId,
				kind: maintenance.kind,
				state: maintenance.state,
				startedAt: maintenance.startedAt,
				finishedAt: maintenance.finishedAt,
				...(maintenance.reason ? { reason: maintenance.reason } : {}),
			},
			{ runId: active.activeRun?.runId },
		);
	}

	async #persistAndPublish(
		active: ActiveSession,
		event: SessionEvent,
		receipt?: PersistedSessionMutationReceipt,
	): Promise<void> {
		if (!this.#canPersist(active)) {
			active.events.push(event);
			if (active.synced) {
				if (active.syncPending) active.syncBuffer.push(event);
				else await this.#publishEvent(event);
			}
			return;
		}
		if (event.durability === "durable") active.state.revision++;
		active.state.lastSequence = event.sequence;
		if (receipt) {
			const result = typeof receipt.result === "function" ? receipt.result(active.state.revision) : receipt.result;
			active.idempotency.record(receipt.key, receipt.params, result);
			await this.#persistState(active);
		}
		await active.store.appendEvent(event);
		active.events.push(event);
		if (active.events.length > this.#retention) {
			active.events = active.events.slice(-this.#retention);
			await active.store.replaceEvents(active.events);
		}
		if (!receipt) await this.#persistState(active);
		if (active.sessionFile && active.lease?.access === "read_write" && active.lease.held) {
			await updateLeaseHeartbeat(active.sessionFile, active.lease.leaseId, this.#runtimeId, event.sequence);
		}
		if (active.synced) {
			if (active.syncPending) {
				active.syncBuffer.push(event);
				return;
			}
			await this.#publishEvent(event);
		}
	}

	async #publishEvent(event: SessionEvent): Promise<void> {
		await this.#output(
			{ jsonrpc: "2.0", method: "session.event", params: event },
			{
				durability: event.durability,
				coalesceKey: `${event.type}:${event.runId ?? ""}:${event.turnId ?? ""}`,
			},
		);
	}

	#enqueueWork<T>(active: ActiveSession, task: () => Promise<T>): Promise<T> {
		if (active.fatalError) return Promise.reject(active.fatalError);
		const work = active.eventTail.then(task);
		active.eventTail = work.then(
			() => undefined,
			error => {
				active.fatalError = error instanceof Error ? error : new Error(String(error));
			},
		);
		return work;
	}

	async #persistState(active: ActiveSession): Promise<void> {
		if (!this.#canPersist(active)) return;
		active.state.updatedAt = new Date().toISOString();
		active.state.queue = active.queue.map(item => ({
			...item,
			content: active.queueContent.get(item.queueItemId) ?? [],
		}));
		active.state.pendingApprovals = active.pendingApprovals.map(item => ({ ...item }));
		active.state.pendingInteractions = active.pendingInteractions.map(item => ({ ...item }));
		active.state.activeRun = active.activeRun ? { ...active.activeRun } : undefined;
		active.state.lastRun = active.lastRun ? { ...active.lastRun } : undefined;
		active.state.activeResourceIds = [...active.activeResourceIds];
		active.state.pendingResourceReleases = [...active.pendingResourceReleases];
		active.state.maintenance = active.maintenance ? { ...active.maintenance, task: undefined } : undefined;
		active.state.receipts = active.idempotency.entries();
		active.state.evidence = active.evidence.entries();
		await active.store.saveState(active.state);
	}

	#canPersist(active: ActiveSession): boolean {
		return (
			this.#active === active &&
			active.lease?.access === "read_write" &&
			active.lease.held &&
			active.state.snapshot?.lifecycle !== "recovering"
		);
	}

	async #flushDeferredResourceReleases(active: ActiveSession): Promise<void> {
		if (active.activeRun || active.pendingResourceReleases.size === 0 || !this.#resourceReleaseHandler) return;
		const resourceIds = [...active.pendingResourceReleases];
		await this.#resourceReleaseHandler(resourceIds, active.sessionId);
		for (const resourceId of resourceIds) active.pendingResourceReleases.delete(resourceId);
		await this.#persistState(active);
	}

	async #buildSnapshot(active: ActiveSession, asOfSequence: number): Promise<SessionSnapshot> {
		const session = active.session;
		const goalState = session.getGoalModeState();
		const planState = session.getPlanModeState();
		const summary = this.#summaryFromActive(active);
		const commandCatalogRevision = (await this.#commandCatalogRevisionProvider?.(session)) ?? 0;
		return {
			schemaVersion: 1,
			session: summary,
			runtimeId: this.#runtimeId as RuntimeId,
			leaseId: active.lease?.leaseId as LeaseId,
			revision: active.state.revision,
			asOfSequence,
			lifecycle: active.state.snapshot?.lifecycle ?? (active.lease?.access === "read_only" ? "read_only" : "ready"),
			...(active.state.snapshot?.recovery ? { recovery: active.state.snapshot.recovery } : {}),
			...(active.activeRun ? { activeRun: active.activeRun } : {}),
			...(active.lastRun ? { lastRun: active.lastRun } : {}),
			queue: active.queue,
			pendingApprovals: active.pendingApprovals,
			pendingInteractions: active.pendingInteractions,
			todoPhases: session.getTodoPhases().map(phase => ({
				name: phase.name,
				status: phase.tasks.some(task => task.status === "in_progress")
					? "in_progress"
					: phase.tasks.length > 0 && phase.tasks.every(task => task.status === "completed")
						? "completed"
						: "pending",
			})),
			...(goalState?.enabled
				? {
						goal: {
							text: goalState.goal.objective,
							budget: { maxTokens: goalState.goal.tokenBudget },
							progress: goalState.goal.status,
						},
					}
				: {}),
			...(planState ? { planMode: planState } : {}),
			...(session.model
				? {
						model: {
							provider: session.model.provider,
							modelId: session.model.id,
							displayName: session.model.name,
							...(typeof session.model.contextWindow === "number"
								? { contextWindow: session.model.contextWindow }
								: {}),
						},
					}
				: {}),
			thinking: { configured: session.configuredThinkingLevel(), effective: session.thinkingLevel },
			settings: buildSettings(
				session,
				active.state,
				active.globalRuntimeSettings,
				active.workspaceRuntimeSettings,
				"session",
			),
			context: this.#buildContinuitySnapshot(active),
			subagents: this.#subagentSnapshotProvider(),
			evidence: active.evidence.summary,
			commandCatalogRevision,
			...(active.adapter.activeStreams.length > 0 ? { activeStreams: active.adapter.activeStreams } : {}),
		};
	}

	#buildContinuitySnapshot(active: ActiveSession): ContinuitySnapshot {
		const usage = active.session.getContextUsage();
		const entries = active.session.sessionManager.getEntries();
		const digests = listTurnDigests(entries);
		const checkpoints = collectContextCheckpoints(entries);
		const latestCheckpoint = checkpoints.at(-1)?.checkpoint;
		const maintenance = active.maintenance;
		return {
			schemaVersion: 1,
			status:
				maintenance?.state === "running" ? "building" : maintenance?.state === "failed" ? "degraded" : "stable",
			...(maintenance?.state === "failed" && maintenance.reason ? { statusReason: maintenance.reason } : {}),
			usage: {
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? null,
				percent: usage?.percent ?? null,
			},
			...(maintenance ? { maintenance: projectMaintenance(maintenance) } : {}),
			...(latestCheckpoint ? { activeCheckpoint: projectCheckpoint(latestCheckpoint) } : {}),
			recentDigestRefs: digests
				.slice(-10)
				.reverse()
				.map(digest => ({
					turnId: digest.turnId,
					createdAt: digest.createdAt,
					fallback: digest.fallback,
				})),
			counters: {
				digests: digests.length,
				checkpoints: checkpoints.length,
				evidence: active.evidence.summary.total,
				retries: 0,
			},
		};
	}

	#summaryFromActive(active: ActiveSession): SessionSummary {
		const session = active.session;
		const file = active.sessionFile;
		const header = session.sessionManager.getHeader();
		const entries = session.sessionManager.getEntries();
		const latestEntry = entries.at(-1);
		const latestCheckpoint = collectContextCheckpoints(entries).at(-1)?.checkpoint;
		return {
			schemaVersion: 1,
			sessionId: active.sessionId,
			title: session.sessionName,
			cwd: session.sessionManager.getCwd(),
			createdAt: header?.timestamp ?? active.state.updatedAt,
			updatedAt: latestEntry?.timestamp ?? active.state.updatedAt,
			persistedStatus:
				active.lastRun?.status === "interrupted" ? "interrupted" : active.activeRun ? "pending" : "complete",
			access: active.lease?.access ?? "closed",
			attention: [
				...(active.pendingApprovals.length > 0 ? ["approval" as const] : []),
				...(active.pendingInteractions.length > 0 ? ["input" as const] : []),
				...(active.lastRun?.status === "interrupted" ? ["recovery" as const] : []),
			],
			messageCount: session.messages.length,
			sizeBytes: file ? safeFileSize(file) : 0,
			lastSequence: active.sequencer.currentSequence,
			...(active.activeRun
				? { latestRun: pickRun(active.activeRun) }
				: active.lastRun
					? { latestRun: pickRun(active.lastRun) }
					: {}),
			evidenceCount: active.evidence.summary.total,
			...(latestCheckpoint
				? { checkpoint: { checkpointId: latestCheckpoint.checkpointId, createdAt: latestCheckpoint.createdAt } }
				: {}),
		};
	}

	async #summaryFromInfo(info: SessionInfo): Promise<SessionSummary> {
		const loaded = await new RpcV2StateStore(info.path, info.id).load();
		const activeRun = reviveRun(loaded.state.activeRun, info.cwd);
		const lastRun = reviveRun(loaded.state.lastRun, info.cwd);
		const latestRun = activeRun ?? lastRun;
		return {
			schemaVersion: 1,
			sessionId: info.id as SessionId,
			title: info.title,
			cwd: info.cwd,
			createdAt: info.created.toISOString(),
			updatedAt: info.modified.toISOString(),
			persistedStatus: info.status ?? "unknown",
			attention: [
				...(loaded.state.pendingApprovals.length > 0 ? ["approval" as const] : []),
				...(loaded.state.pendingInteractions.length > 0 ? ["input" as const] : []),
				...(info.status === "interrupted" || lastRun?.status === "interrupted" ? ["recovery" as const] : []),
				...(info.status === "error" || lastRun?.status === "failed" ? ["failure" as const] : []),
			],
			messageCount: info.messageCount,
			sizeBytes: info.size,
			lastSequence: Math.max(loaded.state.lastSequence, loaded.events.at(-1)?.sequence ?? 0),
			...(latestRun ? { latestRun: pickRun(latestRun) } : {}),
			evidenceCount: loaded.state.evidence.length,
		};
	}

	async #findSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
		const all = await listAllSessions();
		return all.find(item => item.id === sessionId);
	}
}

function isTerminalRun(status: RunSnapshot["status"]): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "interrupted";
}

function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
		return Number.isSafeInteger(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

function pickRun(run: RunSnapshot): Pick<RunSnapshot, "runId" | "status" | "startedAt" | "finishedAt"> {
	return { runId: run.runId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt };
}

function safeFileSize(file: string): number {
	try {
		return Bun.file(file).size;
	} catch {
		return 0;
	}
}

function reviveQueue(values: Array<Record<string, unknown>>, sessionId: SessionId): QueueItem[] {
	return values
		.map(value => (isRecord(value.item) ? value.item : value))
		.filter(value => typeof value.queueItemId === "string")
		.map(value => ({
			queueItemId: value.queueItemId as QueueItem["queueItemId"],
			sessionId,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
			position: typeof value.position === "number" ? value.position : 0,
			status: value.status === "cancelled" || value.status === "promoted" ? value.status : "queued",
			contentPreview: typeof value.contentPreview === "string" ? value.contentPreview : "",
			imageCount: typeof value.imageCount === "number" ? value.imageCount : 0,
			...(typeof value.promotedRunId === "string" ? { promotedRunId: value.promotedRunId as RunId } : {}),
			sourceOperationId:
				typeof value.sourceOperationId === "string" ? (value.sourceOperationId as OperationId) : newOperationId(),
		}));
}

function reviveQueueContent(values: Array<Record<string, unknown>>): Map<string, ContentPart[]> {
	const content = new Map<string, ContentPart[]>();
	for (const value of values) {
		const item = isRecord(value.item) ? value.item : value;
		if (typeof item.queueItemId !== "string" || !Array.isArray(value.content)) continue;
		content.set(item.queueItemId, value.content.filter(isContentPart));
	}
	return content;
}

function reviveRun(value: Record<string, unknown> | undefined, cwd: string): RunSnapshot | undefined {
	if (
		!value ||
		typeof value.runId !== "string" ||
		typeof value.userMessageId !== "string" ||
		!isRunStatus(value.status)
	) {
		return undefined;
	}
	return {
		runId: value.runId as RunId,
		userMessageId: value.userMessageId as RunSnapshot["userMessageId"],
		status: value.status,
		...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
		...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
		...(typeof value.currentTurnId === "string"
			? { currentTurnId: value.currentTurnId as RunSnapshot["currentTurnId"] }
			: {}),
		...(typeof value.reason === "string" ? { reason: sanitizeRpcText(value.reason, { cwd }) } : {}),
	};
}

function reviveMaintenance(value: Record<string, unknown> | undefined, cwd: string): ContextMaintenance | undefined {
	if (!value || typeof value.maintenanceId !== "string" || typeof value.startedAt !== "string") return undefined;
	const kind = value.kind === "snapcompact" ? "snapcompact" : "context_full";
	const restoredState = value.state === "running" ? "cancelled" : value.state;
	if (restoredState !== "completed" && restoredState !== "failed" && restoredState !== "cancelled") return undefined;
	return {
		maintenanceId: value.maintenanceId,
		kind,
		state: restoredState,
		startedAt: value.startedAt,
		...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
		...(typeof value.reason === "string"
			? { reason: sanitizeRpcText(value.reason, { cwd }) }
			: value.state === "running"
				? { reason: "runtime_restarted" }
				: {}),
	};
}

function isRunStatus(value: unknown): value is RunStatus {
	return (
		typeof value === "string" &&
		[
			"accepted",
			"running",
			"waiting_approval",
			"waiting_input",
			"retry_wait",
			"compacting",
			"completed",
			"failed",
			"aborted",
			"interrupted",
		].includes(value)
	);
}

function isContentPart(value: unknown): value is ContentPart {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "image") return isRecord(value.resource);
	return (
		value.type === "resource" &&
		isRecord(value.resource) &&
		(value.purpose === "input" || value.purpose === "reference")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviveApprovals(values: Array<Record<string, unknown>>, sessionId: SessionId): ApprovalRequest[] {
	return values.filter(
		value => value.sessionId === sessionId && typeof value.approvalId === "string" && value.status === "pending",
	) as unknown as ApprovalRequest[];
}

function reviveInteractions(values: Array<Record<string, unknown>>, sessionId: SessionId): InteractionRequest[] {
	return values.filter(
		value => value.sessionId === sessionId && typeof value.interactionId === "string" && value.status === "pending",
	) as unknown as InteractionRequest[];
}

type RuntimeSettingsViewScope = RpcRuntimeSettingsScope | "session";
type RuntimeSettingSource = "builtin" | "global" | "workspace" | "session";

interface ResolvedRuntimeSetting<T> {
	configured?: T;
	effective: T;
	source: RuntimeSettingSource;
}

function resolveRuntimeSetting<T>(
	scope: RuntimeSettingsViewScope,
	baseValue: T,
	baseSource: RuntimeSettingSource,
	globalValue: T | undefined,
	workspaceValue: T | undefined,
	sessionValue: T | undefined,
): ResolvedRuntimeSetting<T> {
	let effective = baseValue;
	let source = baseSource;
	if (globalValue !== undefined) {
		effective = globalValue;
		source = "global";
	}
	if (scope !== "global" && workspaceValue !== undefined) {
		effective = workspaceValue;
		source = "workspace";
	}
	if (scope === "session" && sessionValue !== undefined) {
		effective = sessionValue;
		source = "session";
	}
	const configured = scope === "global" ? globalValue : scope === "workspace" ? workspaceValue : sessionValue;
	return { ...(configured !== undefined ? { configured } : {}), effective, source };
}

function buildSettings(
	session: AgentSession | undefined,
	state: PersistedRpcState | undefined,
	globalSettings: StoredRpcRuntimeSettings,
	workspaceSettings: StoredRpcRuntimeSettings,
	scope: RuntimeSettingsViewScope,
): SessionRuntimeSettings {
	const sessionProfile =
		typeof state?.settings.executionProfile === "string" ? state.settings.executionProfile : undefined;
	const sessionAutoRetry =
		typeof state?.settings.autoRetryEnabled === "boolean" ? state.settings.autoRetryEnabled : undefined;
	const rawSessionContextMode = state?.settings.contextMaintenanceMode;
	const sessionContextMode =
		rawSessionContextMode === "automatic" ||
		rawSessionContextMode === "manual" ||
		rawSessionContextMode === "disabled"
			? rawSessionContextMode
			: undefined;
	const profile = resolveRuntimeSetting(
		scope,
		session?.settings.get("san.executionLoop.defaultMode") ?? "team",
		session?.settings.getSettingSource("san.executionLoop.defaultMode") ?? "builtin",
		globalSettings.executionProfile,
		workspaceSettings.executionProfile,
		sessionProfile,
	);
	const autoRetry = resolveRuntimeSetting(
		scope,
		session?.autoRetryEnabled ?? true,
		session?.settings.getSettingSource("retry.enabled") ?? "builtin",
		globalSettings.autoRetryEnabled,
		workspaceSettings.autoRetryEnabled,
		sessionAutoRetry,
	);
	const contextMaintenance = resolveRuntimeSetting<"automatic" | "manual" | "disabled">(
		scope,
		session?.autoCompactionEnabled === false ? ("disabled" as const) : ("automatic" as const),
		session?.settings.getSettingSource("compaction.enabled") ?? "builtin",
		globalSettings.contextMaintenanceMode,
		workspaceSettings.contextMaintenanceMode,
		sessionContextMode,
	);
	const autoRetryConfig = {
		enabled: autoRetry.effective,
		maxAttempts: 3,
		baseDelayMs: 1000,
		maxDelayMs: 30_000,
		cancellable: true,
	};
	return {
		schemaVersion: 1,
		revision:
			scope === "session"
				? (state?.revision ?? 0)
				: scope === "workspace"
					? workspaceSettings.revision
					: globalSettings.revision,
		executionProfile: { ...profile, mutable: true, restartRequired: false },
		autoRetry: {
			...(autoRetry.configured !== undefined
				? { configured: { ...autoRetryConfig, enabled: autoRetry.configured } }
				: {}),
			effective: autoRetryConfig,
			source: autoRetry.source,
			mutable: true,
			restartRequired: false,
		},
		contextMaintenance: {
			...(contextMaintenance.configured !== undefined
				? { configured: { mode: contextMaintenance.configured } }
				: {}),
			effective: { mode: contextMaintenance.effective },
			source: contextMaintenance.source,
			mutable: true,
			restartRequired: false,
		},
	};
}

function applyRuntimeSettingsOverrides(
	session: AgentSession,
	state: PersistedRpcState,
	globalSettings: StoredRpcRuntimeSettings,
	workspaceSettings: StoredRpcRuntimeSettings,
): void {
	const executionProfile =
		typeof state.settings.executionProfile === "string"
			? state.settings.executionProfile
			: (workspaceSettings.executionProfile ?? globalSettings.executionProfile);
	if (executionProfile !== undefined) {
		session.settings.override("san.executionLoop.defaultMode", executionProfile as "solo" | "team" | "council");
	}
	const autoRetryEnabled =
		typeof state.settings.autoRetryEnabled === "boolean"
			? state.settings.autoRetryEnabled
			: (workspaceSettings.autoRetryEnabled ?? globalSettings.autoRetryEnabled);
	if (autoRetryEnabled !== undefined) session.settings.override("retry.enabled", autoRetryEnabled);
	const rawSessionMode = state.settings.contextMaintenanceMode;
	const contextMaintenanceMode =
		rawSessionMode === "automatic" || rawSessionMode === "manual" || rawSessionMode === "disabled"
			? rawSessionMode
			: (workspaceSettings.contextMaintenanceMode ?? globalSettings.contextMaintenanceMode);
	if (contextMaintenanceMode !== undefined) {
		session.settings.override("compaction.enabled", contextMaintenanceMode === "automatic");
		if (contextMaintenanceMode === "automatic" && session.settings.get("compaction.strategy") === "off") {
			session.settings.override("compaction.strategy", "context-full");
		}
	}
}

function projectMaintenance(maintenance: ContextMaintenance): MaintenanceSnapshot {
	return {
		maintenanceId: maintenance.maintenanceId,
		kind: maintenance.kind,
		state: maintenance.state,
		startedAt: maintenance.startedAt,
	};
}

function projectCheckpoint(checkpoint: ContextCheckpoint): CheckpointSummary {
	return {
		checkpointId: checkpoint.checkpointId,
		createdAt: checkpoint.createdAt,
		digestCount: checkpoint.digestCount,
		summary: structuredClone(checkpoint.summary),
		sourceRefs: [...(checkpoint.coveredSourceEntryRefs ?? checkpoint.entryRefs)],
		tokenEstimate: checkpoint.tokenEstimate,
		tokenBudget: checkpoint.tokenBudget,
		stability: checkpoint.stability,
	};
}

function sessionIndexRevision(sessions: readonly SessionInfo[]): number {
	const source = sessions
		.map(session => `${session.id}:${session.modified.getTime()}:${session.size}:${session.status ?? "unknown"}`)
		.sort()
		.join("\n");
	const digest = new Bun.CryptoHasher("sha256").update(source).digest("hex");
	return Number.parseInt(digest.slice(0, 8), 16);
}
