/** Publishes the durable projection of an interactive Session for RPC v2 readers. */
import { logger } from "@san/utils";
import type { AgentSessionEvent } from "../../session/agent-session";
import {
	acquireLease,
	DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
	detectRecovery,
	executeRecovery,
	type LeaseHeartbeatHandle,
	type LeaseRecord,
	removeLeaseRecord,
	startLeaseHeartbeat,
	updateLeaseHeartbeat,
} from "./crash-recovery";
import type { SessionEvent } from "./dto/events";
import type { RecoveryDescriptor } from "./dto/session";
import { AdapterContext, adaptSessionEvent } from "./event-adapter";
import { EventSequencer } from "./event-sequencer";
import { generateToolEvidence } from "./evidence-generator";
import {
	type LeaseId,
	newLeaseId,
	newMessageId,
	newRunId,
	newRuntimeId,
	type RunId,
	type RuntimeId,
	type SessionId,
} from "./protocol/ids";
import { extractTodoPhases } from "./session-manager";
import { type PersistedRpcState, RpcV2StateStore } from "./state-store";

interface SessionIdentityChange {
	previousSessionId: string;
	sessionId: string;
}

export interface InteractiveEventSource {
	readonly sessionManager: {
		getSessionFile(): string | undefined;
		getSessionId(): string;
		flush(): Promise<void>;
		onSessionIdentityChanged(callback: (change: SessionIdentityChange) => void): () => void;
	};
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface InteractiveSessionPublisherOptions {
	runtimeId?: RuntimeId;
	heartbeatIntervalMs?: number;
	flushIntervalMs?: number;
	recoverAfterLeaseTakeover?: () => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const ACTIVATION_RETRY_INTERVAL_MS = 100;

/**
 * Keeps the interactive runtime's durable event projection and ownership lease
 * independent from the user-facing agent loop. Filesystem failures degrade the
 * projection but never reject an AgentSession event callback.
 */
export class InteractiveSessionPublisher {
	readonly #source: InteractiveEventSource;
	readonly #runtimeId: RuntimeId;
	readonly #heartbeatIntervalMs: number;
	readonly #flushIntervalMs: number;
	readonly #recoverAfterLeaseTakeover: (() => void) | undefined;
	#queue: Promise<void> = Promise.resolve();
	#rawEvents: AgentSessionEvent[] = [];
	#pendingEvents: SessionEvent[] = [];
	#adapter = new AdapterContext();
	#store: RpcV2StateStore | undefined;
	#state: PersistedRpcState | undefined;
	#sequencer: EventSequencer | undefined;
	#sessionFile: string | undefined;
	#sessionId: SessionId | undefined;
	#leaseId: LeaseId | undefined;
	#heartbeat: LeaseHeartbeatHandle | undefined;
	#unsubscribe: (() => void) | undefined;
	#unsubscribeIdentity: (() => void) | undefined;
	#flushTimer: NodeJS.Timeout | undefined;
	#activationTimer: NodeJS.Timeout | undefined;
	#activating = false;
	#stopping = false;
	#ownershipLost = false;
	#stopCall: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#degraded = false;

	constructor(source: InteractiveEventSource, options: InteractiveSessionPublisherOptions = {}) {
		this.#source = source;
		this.#runtimeId = options.runtimeId ?? newRuntimeId();
		this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS;
		this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.#recoverAfterLeaseTakeover = options.recoverAfterLeaseTakeover;
	}

	get runtimeId(): RuntimeId {
		return this.#runtimeId;
	}

	get sessionFile(): string | undefined {
		return this.#sessionFile;
	}

	get leaseId(): LeaseId | undefined {
		return this.#leaseId;
	}

	get eventStreamDegraded(): boolean {
		return this.#degraded;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#unsubscribe = this.#source.subscribe(event => {
			if (this.#ownershipLost) return;
			this.#rawEvents.push(event);
			void this.#enqueue(() => this.#drain()).catch(error => this.#handleAsyncError(error));
		});
		this.#unsubscribeIdentity = this.#source.sessionManager.onSessionIdentityChanged(change => {
			void this.#enqueue(() => this.#switchSession(change)).catch(error => this.#handleAsyncError(error));
		});
		try {
			await this.#enqueue(() => this.#drain());
		} catch (error) {
			if (isSessionLocked(error)) {
				await this.stop();
				throw error;
			}
			this.#markDegraded(error);
		}
	}

	stop(): Promise<void> {
		this.#stopCall ??= this.#doStop();
		return this.#stopCall;
	}

	async #doStop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopping = true;
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		if (this.#activationTimer) {
			clearTimeout(this.#activationTimer);
			this.#activationTimer = undefined;
		}
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#unsubscribeIdentity?.();
		this.#unsubscribeIdentity = undefined;
		await this.#queue.catch(error => this.#handleAsyncError(error));
		await this.#deactivate();
		this.#stopped = true;
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const work = this.#queue.then(task, task);
		this.#queue = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	}

	async #drain(): Promise<void> {
		if (this.#stopped || this.#ownershipLost) return;
		await this.#activateIfPossible();
		const sequencer = this.#sequencer;
		if (!sequencer) {
			if (this.#rawEvents.length > 0) this.#scheduleActivationRetry();
			return;
		}
		while (this.#rawEvents.length > 0 && !this.#stopped && !this.#ownershipLost) {
			const event = this.#rawEvents.shift()!;
			if (event.type === "agent_end") {
				const message = event.messages.at(-1);
				const stopReason = message && "stopReason" in message ? message.stopReason : undefined;
				this.#adapter.currentRunTerminalStatus =
					stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
				this.#adapter.currentRunErrorMessage =
					this.#adapter.currentRunTerminalStatus === "failed" &&
					message &&
					"errorMessage" in message &&
					typeof message.errorMessage === "string"
						? message.errorMessage
						: undefined;
			}
			const adapted = adaptSessionEvent(event, sequencer, this.#adapter, { durableOnly: true });
			if (adapted?.durability === "durable") {
				this.#pendingEvents.push(adapted);
				this.#applyStateProjection(event, adapted);
				if (event.type === "tool_execution_end") {
					const evidence = generateToolEvidence(
						{
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							isError: event.isError === true,
							result: event.result,
						},
						{
							sessionId: adapted.sessionId,
							runId: this.#adapter.currentRunId,
							turnId: this.#adapter.currentTurnId,
							eventId: adapted.eventId,
							sequence: adapted.sequence,
						},
					);
					this.#state?.evidence.push(evidence);
					this.#pendingEvents.push(
						sequencer.emit(
							"evidence.recorded",
							{
								evidenceId: evidence.evidenceId,
								kind: evidence.kind,
								verdict: evidence.verdict,
								title: evidence.title,
							},
							{ runId: this.#adapter.currentRunId, durability: "durable" },
						),
					);
					if (event.toolName === "todo" && event.isError !== true) {
						const phases = extractTodoPhases(event.result);
						if (phases) {
							this.#pendingEvents.push(
								sequencer.emit(
									"todo.changed",
									{ phases },
									{
										runId: this.#adapter.currentRunId,
										turnId: this.#adapter.currentTurnId,
										durability: "durable",
									},
								),
							);
						}
					}
				}
			}
			if (event.type === "agent_end") {
				this.#adapter.currentRunId = undefined;
				this.#adapter.currentTurnId = undefined;
				this.#adapter.currentRunTerminalStatus = undefined;
				this.#adapter.currentRunErrorMessage = undefined;
			}
			if (event.type === "turn_end" || event.type === "agent_end") await this.#flushPending();
			else this.#scheduleFlush();
		}
	}
	#applyStateProjection(event: AgentSessionEvent, adapted: SessionEvent): void {
		const state = this.#state;
		if (!state) return;
		if (event.type === "agent_start") {
			const previous = state.activeRun;
			state.activeRun = {
				...(previous ?? {}),
				runId: adapted.runId ?? newRunId(),
				userMessageId: stringField(previous, "userMessageId") ?? newMessageId(),
				status: "running",
				startedAt: stringField(previous, "startedAt") ?? adapted.timestamp,
			};
			return;
		}
		if (event.type === "turn_start" && adapted.turnId) {
			const previous = state.activeRun;
			state.activeRun = {
				...(previous ?? {}),
				runId: stringField(previous, "runId") ?? adapted.runId ?? newRunId(),
				userMessageId: stringField(previous, "userMessageId") ?? newMessageId(),
				status: previous?.status ?? "running",
				startedAt: stringField(previous, "startedAt") ?? adapted.timestamp,
				currentTurnId: adapted.turnId,
			};
			return;
		}
		if (event.type === "turn_end" && state.activeRun) {
			state.activeRun = { ...state.activeRun, currentTurnId: undefined };
			return;
		}
		if (event.type !== "agent_end") return;
		const activeRun = state.activeRun;
		const runId = (stringField(activeRun, "runId") ?? adapted.runId ?? newRunId()) as RunId;
		state.lastRun = {
			...(activeRun ?? {}),
			runId,
			userMessageId: stringField(activeRun, "userMessageId") ?? newMessageId(),
			status: this.#adapter.currentRunTerminalStatus ?? "completed",
			finishedAt: stringField(adapted.data, "finishedAt") ?? adapted.timestamp,
		};
		state.activeRun = undefined;
		if (state.snapshot) state.snapshot = { ...state.snapshot, lifecycle: "ready", recovery: undefined };
	}

	#applyRecoveryProjection(recovery: RecoveryDescriptor): void {
		const state = this.#state;
		if (!state) return;
		const activeRun = state.activeRun;
		const terminal =
			activeRun?.status === "completed" ||
			activeRun?.status === "failed" ||
			activeRun?.status === "aborted" ||
			activeRun?.status === "interrupted";
		if (activeRun && typeof activeRun.runId === "string" && !terminal) {
			state.lastRun = {
				...activeRun,
				status: "interrupted",
				finishedAt: new Date().toISOString(),
				reason: "runtime_crash",
			};
			state.activeRun = undefined;
			recovery.interruptedRunId ??= activeRun.runId as RunId;
		}
		if (state.snapshot) state.snapshot = { ...state.snapshot, lifecycle: "ready", recovery: undefined };
	}

	async #activateIfPossible(): Promise<void> {
		const sessionFile = this.#source.sessionManager.getSessionFile();
		if (!sessionFile || this.#sessionFile === sessionFile || this.#ownershipLost) return;
		if (this.#activating) return;
		this.#activating = true;
		let leaseAcquired = false;
		let acquiredLeaseId: LeaseId | undefined;
		try {
			try {
				await this.#source.sessionManager.flush();
			} catch (error) {
				this.#markDegraded(error);
			}
			if (!(await Bun.file(sessionFile).exists())) return;
			if (this.#sessionFile) await this.#deactivate();
			const sessionId = this.#source.sessionManager.getSessionId() as SessionId;
			const store = new RpcV2StateStore(sessionFile, sessionId);
			const loaded = await store.load();
			const recovery = await detectRecovery(sessionId, this.#runtimeId, sessionFile);
			const lastSequence = Math.max(
				loaded.state.lastSequence,
				loaded.events.at(-1)?.sequence ?? 0,
				recovery?.lastStableSequence ?? 0,
			);
			const leaseId = newLeaseId();
			acquiredLeaseId = leaseId;
			const acquiredAt = new Date().toISOString();
			const record: LeaseRecord = {
				leaseId,
				runtimeId: this.#runtimeId,
				pid: process.pid,
				sessionId,
				acquiredAt,
				lastHeartbeat: acquiredAt,
				lastStableSequence: lastSequence,
				heartbeatIntervalMs: this.#heartbeatIntervalMs,
				eventStreamDegraded: this.#degraded,
			};
			await acquireLease(sessionFile, record, recovery !== undefined);
			leaseAcquired = true;
			this.#sessionFile = sessionFile;
			this.#sessionId = sessionId;
			this.#leaseId = leaseId;
			this.#store = store;
			this.#state = loaded.state;
			this.#sequencer = new EventSequencer(sessionId, lastSequence);
			this.#adapter = new AdapterContext();
			if (recovery) {
				this.#applyRecoveryProjection(recovery);
				await executeRecovery(sessionId, "continue", this.#runtimeId, sessionFile, leaseId);
				this.#recoverAfterLeaseTakeover?.();
				this.#pendingEvents.unshift(
					this.#sequencer.emit(
						"session.recovered",
						{ strategy: "continue", lastStableSequence: recovery.lastStableSequence },
						{ durability: "durable" },
					),
				);
			}
			this.#heartbeat = startLeaseHeartbeat({
				sessionFile,
				leaseId,
				runtimeId: this.#runtimeId,
				intervalMs: this.#heartbeatIntervalMs,
				getSequence: () => this.#state?.lastSequence ?? lastSequence,
				getEventStreamDegraded: () => this.#degraded,
				onError: error => this.#handleHeartbeatError(error),
			});
			if (this.#pendingEvents.length > 0) await this.#flushPending();
		} catch (error) {
			await this.#heartbeat?.stop().catch(() => undefined);
			this.#heartbeat = undefined;
			if (leaseAcquired && acquiredLeaseId) {
				await removeLeaseRecord(sessionFile, acquiredLeaseId, this.#runtimeId).catch(() => false);
			}
			if (this.#sessionFile === sessionFile) {
				this.#store = undefined;
				this.#state = undefined;
				this.#sequencer = undefined;
				this.#sessionFile = undefined;
				this.#sessionId = undefined;
				this.#leaseId = undefined;
			}
			throw error;
		} finally {
			this.#activating = false;
		}
	}

	async #switchSession(change: SessionIdentityChange): Promise<void> {
		if (this.#sessionId && this.#sessionId !== change.previousSessionId) return;
		await this.#deactivate();
		this.#ownershipLost = false;
		this.#degraded = false;
		this.#adapter = new AdapterContext();
		await this.#drain();
	}

	async #deactivate(): Promise<void> {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		if (this.#activationTimer) {
			clearTimeout(this.#activationTimer);
			this.#activationTimer = undefined;
		}
		await this.#flushPending();
		const heartbeat = this.#heartbeat;
		this.#heartbeat = undefined;
		await heartbeat?.stop().catch(error => {
			logger.warn("Failed to stop interactive session heartbeat", { error: String(error) });
		});
		const sessionFile = this.#sessionFile;
		const leaseId = this.#leaseId;
		if (sessionFile && leaseId) {
			try {
				await removeLeaseRecord(sessionFile, leaseId, this.#runtimeId);
			} catch (error) {
				logger.warn("Failed to release interactive session lease", {
					sessionId: this.#sessionId,
					sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.#pendingEvents = [];
		this.#store = undefined;
		this.#state = undefined;
		this.#sequencer = undefined;
		this.#sessionFile = undefined;
		this.#sessionId = undefined;
		this.#leaseId = undefined;
	}

	#scheduleFlush(): void {
		if (
			this.#flushTimer ||
			this.#pendingEvents.length === 0 ||
			this.#stopped ||
			this.#stopping ||
			this.#ownershipLost
		)
			return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			void this.#enqueue(() => this.#flushPending()).catch(error => this.#handleAsyncError(error));
		}, this.#flushIntervalMs);
	}

	#scheduleActivationRetry(): void {
		if (this.#activationTimer || this.#stopped || this.#stopping || this.#ownershipLost) return;
		this.#activationTimer = setTimeout(() => {
			this.#activationTimer = undefined;
			void this.#enqueue(() => this.#drain()).catch(error => this.#handleAsyncError(error));
		}, ACTIVATION_RETRY_INTERVAL_MS);
	}

	async #flushPending(): Promise<void> {
		if (
			this.#pendingEvents.length === 0 ||
			!this.#store ||
			!this.#state ||
			!this.#sessionFile ||
			!this.#leaseId ||
			this.#ownershipLost
		)
			return;
		const batch = [...this.#pendingEvents];
		try {
			const previousSequence = this.#state.lastSequence;
			await this.#store.appendEvents(batch);
			this.#state.lastSequence = Math.max(previousSequence, batch.at(-1)?.sequence ?? previousSequence);
			this.#state.revision += batch.filter(event => event.sequence > previousSequence).length;
			await this.#store.saveState(this.#state);
			this.#pendingEvents.splice(0, batch.length);
			await this.#touchLease(false);
			this.#degraded = false;
		} catch (error) {
			this.#markDegraded(error);
		}
	}

	async #touchLease(eventStreamDegraded: boolean): Promise<void> {
		if (!this.#sessionFile || !this.#leaseId || this.#ownershipLost) return;
		await updateLeaseHeartbeat(
			this.#sessionFile,
			this.#leaseId,
			this.#runtimeId,
			this.#state?.lastSequence ?? this.#sequencer?.currentSequence ?? 0,
			eventStreamDegraded,
		);
	}

	async #dropOwnership(): Promise<void> {
		if (!this.#ownershipLost) return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#unsubscribeIdentity?.();
		this.#unsubscribeIdentity = undefined;
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		if (this.#activationTimer) {
			clearTimeout(this.#activationTimer);
			this.#activationTimer = undefined;
		}
		const heartbeat = this.#heartbeat;
		this.#heartbeat = undefined;
		await heartbeat?.stop().catch(() => undefined);
		const sessionFile = this.#sessionFile;
		const leaseId = this.#leaseId;
		if (sessionFile && leaseId) await removeLeaseRecord(sessionFile, leaseId, this.#runtimeId).catch(() => false);
		this.#rawEvents = [];
		this.#pendingEvents = [];
		this.#store = undefined;
		this.#state = undefined;
		this.#sequencer = undefined;
		this.#sessionFile = undefined;
		this.#sessionId = undefined;
		this.#leaseId = undefined;
	}

	#markDegraded(error: unknown): void {
		if (isSessionLocked(error)) {
			if (this.#ownershipLost) return;
			this.#ownershipLost = true;
			logger.warn("Interactive session lease was lost", {
				sessionId: this.#sessionId,
				sessionFile: this.#sessionFile,
			});
			void this.#enqueue(() => this.#dropOwnership()).catch(() => undefined);
			return;
		}
		const first = !this.#degraded;
		this.#degraded = true;
		if (first) {
			logger.warn("Interactive RPC event stream degraded", {
				sessionId: this.#sessionId,
				sessionFile: this.#sessionFile,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		void this.#touchLease(true).catch(() => undefined);
	}

	#handleHeartbeatError(error: unknown): void {
		this.#markDegraded(error);
	}

	#handleAsyncError(error: unknown): void {
		if (this.#stopped || this.#ownershipLost) return;
		if (isSessionLocked(error)) {
			logger.warn("Interactive session could not acquire its lease", {
				sessionId: this.#source.sessionManager.getSessionId(),
				sessionFile: this.#source.sessionManager.getSessionFile(),
			});
			return;
		}
		this.#markDegraded(error);
	}
}

function stringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function isSessionLocked(error: unknown): boolean {
	return error instanceof Error && error.message === "SESSION_LOCKED";
}
