import { type ExecutionLedger, isTerminalExecutionState, StaleExecutionRevisionError } from "./execution-ledger";
import { type HostObservation, stableValueFingerprint } from "./progress-classifier";
import type { ProgressClass, SupervisorAction, SupervisorDecisionRef, SupervisorExternalBlocker } from "./types";
import { Watchdog, type WatchdogDecision, type WatchdogInput } from "./watchdog";

/** A typed external dependency that is the only basis for a needs_user action. */
export type TypedExternalBlocker = SupervisorExternalBlocker;

/** A semantic supervisor proposal. Host policy, not the supervisor, applies it. */
export interface DurableSupervisorDecision extends SupervisorDecisionRef {
	readonly externalBlocker?: SupervisorExternalBlocker;
}

export type SchedulerWindowKind = "diagnostic" | "grace";

export interface DurableSchedulerOptions {
	readonly ledger: ExecutionLedger;
	readonly watchdog?: Watchdog;
	readonly now?: () => number;
	readonly graceMs?: number;
	readonly diagnosticMs?: number;
	readonly progressLeaseMs?: number;
	readonly runnableNodeIds?: readonly string[];
}

export interface DispatchAdmission {
	readonly admitted: boolean;
	readonly assignmentId: string;
	readonly inFlight: boolean;
	readonly currentRevision: number;
	readonly reason?:
		| "empty_assignment"
		| "diagnostic_window"
		| "grace_window"
		| "needs_user"
		| "already_in_flight"
		| "terminal_scope"
		| "already_terminal";
}

export interface AssignmentLeaseRenewal {
	readonly progressClass: ProgressClass;
	readonly authoritativeRevision: number;
	readonly authoritativeEvidenceRefs: readonly string[];
	readonly cursor?: string;
}

export interface LeaseRenewalResult {
	readonly renewed: boolean;
	readonly assignmentId: string;
	readonly expiresAt?: number;
	readonly reason?:
		| "unknown_assignment"
		| "not_progress"
		| "missing_authoritative_evidence"
		| "stale_authoritative_revision"
		| "repeated_cursor";
}

export interface SupervisorDecisionResult {
	readonly applied: boolean;
	readonly stale: boolean;
	readonly action: SupervisorAction;
	readonly currentRevision: number;
	readonly decisionRevision?: number;
	readonly reason?: string;
}

export interface SchedulerWindow {
	readonly kind: SchedulerWindowKind;
	readonly openedAt: number;
	readonly until: number;
	readonly basisRevision: number;
	readonly basisHash: string;
}

interface AssignmentLeaseState {
	readonly assignmentId: string;
	readonly issuedAt: number;
	expiresAt: number;
	authoritativeRevision: number;
	authoritativeEvidenceRefs: string[];
	lastCursor?: string;
}

interface MutableSchedulerWindow extends SchedulerWindow {}

const SUPERVISOR_ACTIONS: readonly SupervisorAction[] = [
	"continue",
	"replan",
	"reassign",
	"switch_route",
	"park",
	"needs_user",
	"abstain",
];

function isSupervisorAction(value: string): value is SupervisorAction {
	return SUPERVISOR_ACTIONS.includes(value as SupervisorAction);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}

function basisHash(ledger: ExecutionLedger): string {
	const snapshot = ledger.snapshot();
	return stableValueFingerprint({
		scopeId: snapshot.scopeId,
		revision: snapshot.revision,
		state: snapshot.state,
		objectiveContract: snapshot.objectiveContract?.ref,
		gates: snapshot.gates,
		evidenceRefs: snapshot.evidenceRefs,
		assignments: snapshot.assignments,
		strategies: snapshot.strategies,
		providerHealth: snapshot.providerHealth,
		progress: snapshot.progress,
	});
}

function nowMs(): number {
	return Date.now();
}

function dispatchReason(window: SchedulerWindow): DispatchAdmission["reason"] {
	return window.kind === "diagnostic" ? "diagnostic_window" : "grace_window";
}

/**
 * Host-owned policy boundary for supervisor decisions and assignment dispatch.
 * Semantic supervisors only produce DurableSupervisorDecision values; this class
 * performs the CAS, durable ledger append, dispatch admission, and lease rules.
 */
export class DurableScheduler {
	readonly #ledger: ExecutionLedger;
	readonly #watchdog: Watchdog;
	readonly #now: () => number;
	readonly #graceMs: number;
	readonly #diagnosticMs: number;
	readonly #progressLeaseMs: number;
	readonly #inFlight = new Map<string, number>();
	readonly #leases = new Map<string, AssignmentLeaseState>();
	#runnableNodeIds: readonly string[];
	#runnableNodesSpecified = false;
	#window?: MutableSchedulerWindow;

	constructor(options: DurableSchedulerOptions) {
		this.#ledger = options.ledger;
		this.#now = options.now ?? nowMs;
		this.#graceMs = Math.max(1, Math.floor(options.graceMs ?? 30_000));
		this.#diagnosticMs = Math.max(1, Math.floor(options.diagnosticMs ?? 60_000));
		this.#progressLeaseMs = Math.max(1, Math.floor(options.progressLeaseMs ?? 5 * 60_000));
		if (options.runnableNodeIds !== undefined) this.#runnableNodesSpecified = true;
		this.#runnableNodeIds = unique(options.runnableNodeIds ?? []);
		this.#watchdog =
			options.watchdog ??
			new Watchdog({
				ledger: this.#ledger,
				mode: "enforce",
				progressLeaseMs: this.#progressLeaseMs,
			});
	}

	get ledger(): ExecutionLedger {
		return this.#ledger;
	}

	get watchdog(): Watchdog {
		return this.#watchdog;
	}

	get currentBasis(): { readonly revision: number; readonly hash: string } {
		const diagnosis = this.#watchdog.currentDiagnosis;
		if (diagnosis && diagnosis.basisRevision === this.#ledger.revision) {
			return { revision: diagnosis.basisRevision, hash: diagnosis.basisHash };
		}
		return { revision: this.#ledger.revision, hash: basisHash(this.#ledger) };
	}

	get currentWindow(): SchedulerWindow | undefined {
		this.#expireWindow();
		return this.#window;
	}

	get inFlightAssignmentIds(): readonly string[] {
		return [...this.#inFlight.keys()];
	}

	setRunnableNodes(nodeIds: readonly string[]): void {
		this.#runnableNodeIds = unique(nodeIds);
		this.#runnableNodesSpecified = true;
	}

	/** Observe through the deterministic watchdog and turn a diagnosis into a host grace window. */
	observe(input: HostObservation | WatchdogInput): WatchdogDecision {
		const decision = this.#watchdog.observe(input);
		if (decision.action === "suppress_unchanged_poll" || decision.action === "diagnose") {
			this.openDiagnosticWindow();
		}
		return decision;
	}

	/** Enforce a watchdog observation while preserving its stale-diagnosis CAS rule. */
	enforce(input: HostObservation | WatchdogInput | WatchdogDecision): WatchdogDecision {
		const decision = this.#watchdog.enforce(input);
		if (decision.action === "suppress_unchanged_poll" || decision.action === "diagnose") {
			this.openDiagnosticWindow();
		}
		return decision;
	}

	openDiagnosticWindow(durationMs = this.#diagnosticMs): SchedulerWindow {
		return this.#openWindow("diagnostic", durationMs);
	}

	openGraceWindow(durationMs = this.#graceMs): SchedulerWindow {
		return this.#openWindow("grace", durationMs);
	}

	closeWindow(): void {
		this.#window = undefined;
	}

	admitDispatch(assignmentId: string): DispatchAdmission {
		this.#expireWindow();
		const currentRevision = this.#ledger.revision;
		if (!assignmentId) {
			return { admitted: false, assignmentId, inFlight: false, currentRevision, reason: "empty_assignment" };
		}
		if (this.#inFlight.has(assignmentId)) {
			return { admitted: true, assignmentId, inFlight: true, currentRevision };
		}
		if (this.#ledger.state === "needs_user") {
			return { admitted: false, assignmentId, inFlight: false, currentRevision, reason: "needs_user" };
		}
		if (isTerminalExecutionState(this.#ledger.state)) {
			return { admitted: false, assignmentId, inFlight: false, currentRevision, reason: "terminal_scope" };
		}
		const priorLease = this.#leases.get(assignmentId);
		if (priorLease && priorLease.expiresAt > this.#now()) {
			return { admitted: false, assignmentId, inFlight: false, currentRevision, reason: "already_terminal" };
		}
		if (this.#window) {
			return {
				admitted: false,
				assignmentId,
				inFlight: false,
				currentRevision,
				reason: dispatchReason(this.#window),
			};
		}
		return { admitted: true, assignmentId, inFlight: false, currentRevision };
	}

	startAssignment(assignmentId: string): DispatchAdmission {
		const admission = this.admitDispatch(assignmentId);
		if (admission.admitted && !admission.inFlight) {
			const now = this.#now();
			this.#inFlight.set(assignmentId, now);
			this.#leases.set(assignmentId, {
				assignmentId,
				issuedAt: now,
				expiresAt: now + this.#progressLeaseMs,
				authoritativeRevision: this.#ledger.revision,
				authoritativeEvidenceRefs: [],
			});
		}
		return admission;
	}

	finishAssignment(assignmentId: string): void {
		this.#inFlight.delete(assignmentId);
		this.#leases.delete(assignmentId);
	}

	async executeAssignment<T>(assignmentId: string, operation: () => Promise<T>): Promise<T> {
		const admission = this.startAssignment(assignmentId);
		if (!admission.admitted || admission.inFlight) {
			throw new DispatchGateError(
				admission.inFlight ? { ...admission, admitted: false, reason: "already_in_flight" } : admission,
			);
		}
		try {
			return await operation();
		} finally {
			this.finishAssignment(assignmentId);
		}
	}

	renewAssignment(assignmentId: string, input: AssignmentLeaseRenewal): LeaseRenewalResult {
		const lease = this.#leases.get(assignmentId);
		if (!lease) return { renewed: false, assignmentId, reason: "unknown_assignment" };
		if (input.progressClass !== "progress") return { renewed: false, assignmentId, reason: "not_progress" };
		const refs = unique(input.authoritativeEvidenceRefs);
		const snapshot = this.#ledger.snapshot();
		const snapshotRefs = new Map(snapshot.evidenceRefs.map(ref => [ref.evidenceId, ref]));
		const contractRevision = snapshot.objectiveContract?.ref.revision;
		if (
			refs.length === 0 ||
			refs.some(refId => {
				const ref = snapshotRefs.get(refId);
				return (
					!ref ||
					ref.assignmentId !== assignmentId ||
					ref.freshnessRevision === undefined ||
					(contractRevision !== undefined && ref.contractRevision !== contractRevision)
				);
			})
		) {
			return { renewed: false, assignmentId, reason: "missing_authoritative_evidence" };
		}
		if (input.authoritativeRevision <= lease.authoritativeRevision) {
			return { renewed: false, assignmentId, reason: "stale_authoritative_revision" };
		}
		if (input.cursor !== undefined && input.cursor === lease.lastCursor) {
			return { renewed: false, assignmentId, reason: "repeated_cursor" };
		}
		if (refs.every(ref => lease.authoritativeEvidenceRefs.includes(ref))) {
			return { renewed: false, assignmentId, reason: "missing_authoritative_evidence" };
		}
		lease.authoritativeEvidenceRefs = unique([...lease.authoritativeEvidenceRefs, ...refs]);
		lease.authoritativeRevision = input.authoritativeRevision;
		lease.lastCursor = input.cursor;
		lease.expiresAt = this.#now() + this.#progressLeaseMs;
		return {
			renewed: true,
			assignmentId,
			expiresAt: lease.expiresAt,
		};
	}

	applySupervisorDecision(decision: DurableSupervisorDecision): SupervisorDecisionResult {
		const current = this.currentBasis;
		if (!isSupervisorAction(decision.action)) {
			return {
				applied: false,
				stale: false,
				action: "abstain",
				currentRevision: current.revision,
				reason: "supervisor action is not host-policy permitted",
			};
		}
		if (
			decision.scopeId !== this.#ledger.scopeId ||
			decision.basisRevision !== current.revision ||
			decision.basisHash !== current.hash
		) {
			return {
				applied: false,
				stale: true,
				action: decision.action,
				currentRevision: current.revision,
				reason: "supervisor decision basis is stale",
			};
		}
		if (decision.action === "needs_user" && !this.#validNeedsUserDecision(decision)) {
			return {
				applied: false,
				stale: false,
				action: decision.action,
				currentRevision: current.revision,
				reason: "needs_user requires a typed external blocker and no runnable node",
			};
		}
		const persistedDecision: SupervisorDecisionRef = {
			decisionId: decision.decisionId,
			scopeId: decision.scopeId,
			basisRevision: decision.basisRevision,
			basisHash: decision.basisHash,
			action: decision.action,
			evidenceRefs: [...decision.evidenceRefs],
			invalidatedHypothesisRefs: [...decision.invalidatedHypothesisRefs],
			confidence: decision.confidence,
			createdAt: decision.createdAt,
			...(decision.externalBlocker === undefined ? {} : { externalBlocker: { ...decision.externalBlocker } }),
		};
		try {
			const recorded = this.#ledger.append(
				{
					recordId: `supervisor:${decision.decisionId}`,
					type: "supervisor_decision_recorded",
					decision: persistedDecision,
				},
				{ expectedRevision: decision.basisRevision },
			);
			if (decision.action === "needs_user") {
				this.#ledger.append(
					{ recordId: `supervisor:${decision.decisionId}:needs-user`, type: "state_changed", state: "needs_user" },
					{ expectedRevision: recorded.revision },
				);
			} else if (decision.action === "park") {
				this.openGraceWindow();
			} else if (decision.action === "continue") {
				this.closeWindow();
			}
			return {
				applied: true,
				stale: false,
				action: decision.action,
				currentRevision: this.#ledger.revision,
				decisionRevision: recorded.revision,
			};
		} catch (error) {
			if (error instanceof StaleExecutionRevisionError) {
				return {
					applied: false,
					stale: true,
					action: decision.action,
					currentRevision: this.#ledger.revision,
					reason: "supervisor decision CAS failed",
				};
			}
			throw error;
		}
	}

	#openWindow(kind: SchedulerWindowKind, durationMs: number): SchedulerWindow {
		const openedAt = this.#now();
		const current = this.currentBasis;
		const window: MutableSchedulerWindow = {
			kind,
			openedAt,
			until: openedAt + Math.max(1, Math.floor(durationMs)),
			basisRevision: current.revision,
			basisHash: current.hash,
		};
		this.#window = window;
		return window;
	}

	#expireWindow(): void {
		if (this.#window && this.#now() >= this.#window.until) this.#window = undefined;
	}

	#validNeedsUserDecision(decision: DurableSupervisorDecision): boolean {
		const blocker = decision.externalBlocker;
		// 仅接受携带 dependencyId 与 evidenceRef 的 typed external blocker。
		if (blocker?.kind !== "external" || !blocker.dependencyId || !blocker.evidenceRef) return false;
		// evidence 必须同时出现在决策引用与 scope 已记录的 ledger evidence 中。
		if (!decision.evidenceRefs.includes(blocker.evidenceRef)) return false;
		const snapshot = this.#ledger.snapshot();
		const runnableNodes = this.#runnableNodesSpecified
			? this.#runnableNodeIds
			: snapshot.assignments
					.filter(assignment => assignment.status === "pending")
					.map(assignment => assignment.assignmentId);
		// needs_user 不允许仍有可运行节点。
		if (runnableNodes.length > 0) return false;
		// ledger evidence 必须是 external 且绑定到某个 acceptance gate。
		const evidence = snapshot.evidenceRefs.find(ref => ref.evidenceId === blocker.evidenceRef);
		if (evidence?.kind !== "external" || !evidence.gateId) return false;
		// 对应 gate 必须存在且由 external verifier 验证。
		const gate = snapshot.gates.find(candidate => candidate.gateId === evidence.gateId);
		if (gate?.verifier.kind !== "external") return false;
		// gate 的 external verifier dependencyId 必须与 blocker 完全一致。
		if (gate.verifier.dependencyId !== blocker.dependencyId) return false;
		// gate 的 evidenceRefs 必须确实包含该 evidence，未绑定/错绑的 evidence 一律拒绝。
		return gate.evidenceRefs.some(ref => ref.evidenceId === blocker.evidenceRef);
	}
}

export class DispatchGateError extends Error {
	readonly admission: DispatchAdmission;

	constructor(admission: DispatchAdmission) {
		super(
			`Dispatch for ${admission.assignmentId || "assignment"} was denied: ${admission.reason ?? "unknown reason"}.`,
		);
		this.name = "DispatchGateError";
		this.admission = admission;
	}
}

export function supervisorDecisionBasis(ledger: ExecutionLedger): { readonly revision: number; readonly hash: string } {
	return { revision: ledger.revision, hash: basisHash(ledger) };
}

export function progressLeaseFromWatchdog(
	decision: WatchdogDecision,
	authoritativeEvidenceRefs: readonly string[],
): AssignmentLeaseRenewal | undefined {
	if (!decision.classification.progress) return undefined;
	return {
		progressClass: decision.classification.progressClass === "progress" ? "progress" : "activity",
		authoritativeRevision: decision.currentRevision,
		authoritativeEvidenceRefs: [...authoritativeEvidenceRefs],
		cursor: decision.cursor,
	};
}
