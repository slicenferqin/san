/**
 * San RPC v2 Session Manager.
 *
 * Wraps the existing session infrastructure to provide v2 protocol operations:
 * session.list, session.create, session.open, session.sync, session.close.
 * Manages write leases and the event subscription lifecycle.
 */

import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { listAllSessions, type SessionInfo } from "../../session/session-listing";
import type { SessionSummary, StreamPolicy, SyncResult } from "./dto/session";
import { AdapterContext, adaptSessionEvent } from "./event-adapter";
import { EventSequencer } from "./event-sequencer";
import type { LeaseId, SessionId, SubscriptionId } from "./protocol/ids";
import { newLeaseId, newSubscriptionId } from "./protocol/ids";
import type { SessionPersistedStatus } from "./protocol/lifecycle";

// ============================================================================
// Lease tracking
// ============================================================================

interface ActiveLease {
	leaseId: LeaseId;
	sessionId: string;
	access: "read_write" | "read_only";
	acquiredAt: number;
}

interface ActiveSubscription {
	subscriptionId: SubscriptionId;
	sessionId: string;
	leaseId: LeaseId;
	sequencer: EventSequencer;
	adapterCtx: AdapterContext;
	unsubscribe: () => void;
}

// ============================================================================
// Session Manager
// ============================================================================

export class RpcV2SessionManager {
	readonly #session: AgentSession;
	#lease: ActiveLease | undefined;
	#subscription: ActiveSubscription | undefined;
	#output: ((frame: object) => void) | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	/** Set the output function for streaming events to the client. */
	setOutput(output: (frame: object) => void): void {
		this.#output = output;
	}

	get currentLease(): ActiveLease | undefined {
		return this.#lease;
	}

	get currentSubscription(): ActiveSubscription | undefined {
		return this.#subscription;
	}

	get adapterContext(): AdapterContext | undefined {
		return this.#subscription?.adapterCtx;
	}

	// =======================================================================
	// session.list
	// =======================================================================

	async listSessions(params: {
		cwd?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> {
		const allSessions = await listAllSessions();
		let filtered = allSessions;

		if (params.cwd) {
			filtered = allSessions.filter(s => s.cwd === params.cwd);
		}

		// Sort by modified time descending (newest first)
		filtered.sort((a, b) => b.modified.getTime() - a.modified.getTime());

		const limit = Math.min(params.limit ?? 50, 100);
		const offset = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
		const page = filtered.slice(offset, offset + limit);
		const nextOffset = offset + limit;

		return {
			sessions: page.map(infoToSummary),
			nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
		};
	}

	// =======================================================================
	// session.create / session.open
	// =======================================================================

	/**
	 * Open the current session with a write lease.
	 * In the current single-session-per-process model, the session is already
	 * active — we just formalize the lease.
	 */
	openCurrentSession(access: "read_write" | "read_only" = "read_write"): {
		leaseId: LeaseId;
		summary: SessionSummary;
	} {
		if (this.#lease && this.#lease.access === "read_write" && access === "read_write") {
			// Already have a write lease
			return { leaseId: this.#lease.leaseId, summary: this.#buildCurrentSummary() };
		}

		const leaseId = newLeaseId();
		this.#lease = {
			leaseId,
			sessionId: this.#session.sessionId,
			access,
			acquiredAt: Date.now(),
		};

		return { leaseId, summary: this.#buildCurrentSummary() };
	}

	// =======================================================================
	// session.sync
	// =======================================================================

	/**
	 * Atomic sync: establishes a subscription and returns either a full
	 * snapshot or a replay of events since the given cursor.
	 *
	 * In this initial implementation, we always return a snapshot since
	 * event history replay requires journal indexing (P3+).
	 */
	sync(params: { leaseId: LeaseId; afterSequence?: number | null; stream?: StreamPolicy }): SyncResult {
		if (!this.#lease || this.#lease.leaseId !== params.leaseId) {
			throw new Error("LEASE_MISMATCH");
		}

		// Tear down existing subscription if any
		this.#teardownSubscription();

		const sessionId = this.#session.sessionId as SessionId;
		const sequencer = new EventSequencer(sessionId);
		const adapterCtx = new AdapterContext();
		const subscriptionId = newSubscriptionId();

		// Subscribe to session events and forward through the adapter
		const unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			const adapted = adaptSessionEvent(event, sequencer, adapterCtx);
			if (adapted && this.#output) {
				this.#output({
					jsonrpc: "2.0",
					method: "session.event",
					params: adapted,
				});
			}
		});

		this.#subscription = {
			subscriptionId,
			sessionId: this.#session.sessionId,
			leaseId: params.leaseId,
			sequencer,
			adapterCtx,
			unsubscribe,
		};

		// Build snapshot
		const snapshot = this.#buildSnapshot(sequencer.currentSequence, params.leaseId);

		return {
			mode: "snapshot",
			subscriptionId,
			asOfSequence: sequencer.currentSequence,
			snapshot,
		};
	}

	// =======================================================================
	// session.close
	// =======================================================================

	close(): void {
		this.#teardownSubscription();
		this.#lease = undefined;
	}

	// =======================================================================
	// Internal helpers
	// =======================================================================

	#teardownSubscription(): void {
		if (this.#subscription) {
			this.#subscription.unsubscribe();
			this.#subscription = undefined;
		}
	}

	#buildCurrentSummary(): SessionSummary {
		const session = this.#session;
		return {
			schemaVersion: 1,
			sessionId: session.sessionId as SessionId,
			title: session.sessionName,
			cwd: session.sessionManager.getCwd(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			persistedStatus: session.isStreaming ? "pending" : "complete",
			access: this.#lease ? (this.#lease.access === "read_write" ? "ready" : "read_only") : "closed",
			attention: [],
			messageCount: session.messages.length,
			sizeBytes: 0,
			lastSequence: this.#subscription?.sequencer.currentSequence ?? 0,
		};
	}

	#buildSnapshot(asOfSequence: number, leaseId: LeaseId): Record<string, unknown> {
		const session = this.#session;
		return {
			schemaVersion: 1,
			session: this.#buildCurrentSummary(),
			runtimeId: "", // filled by caller
			leaseId,
			revision: 1,
			asOfSequence,
			lifecycle: "ready",
			queue: [],
			pendingApprovals: [],
			pendingInteractions: [],
			todoPhases: session.getTodoPhases().map(p => ({
				name: p.name,
				status: p.tasks.some(t => t.status === "in_progress")
					? "in_progress"
					: p.tasks.every(t => t.status === "completed")
						? "completed"
						: "pending",
			})),
			thinking: {
				configured: session.thinkingLevel,
				effective: session.thinkingLevel,
			},
			context: {
				schemaVersion: 1,
				status: "stable",
				usage: { tokens: null, contextWindow: null, percent: null },
				recentDigestRefs: [],
				counters: { digests: 0, checkpoints: 0, evidence: 0, retries: 0 },
			},
			subagents: [],
			evidence: { total: 0, passed: 0, failed: 0, latest: [] },
		};
	}
}

// ============================================================================
// Mapping helpers
// ============================================================================

function infoToSummary(info: SessionInfo): SessionSummary {
	return {
		schemaVersion: 1,
		sessionId: info.id as SessionId,
		title: info.title,
		cwd: info.cwd,
		createdAt: info.created.toISOString(),
		updatedAt: info.modified.toISOString(),
		persistedStatus: (info.status ?? "unknown") as SessionPersistedStatus,
		attention: [],
		messageCount: info.messageCount,
		sizeBytes: info.size,
		lastSequence: 0,
	};
}
