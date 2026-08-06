import { ExecutionLedger } from "./execution-ledger";
import {
	type ClassifiedProgress,
	type HostObservation,
	ProgressClassifier,
	type StrategyFingerprintInput,
	stableFailureFingerprint,
	stablePollFingerprint,
	stableStrategyFingerprint,
	stableValueFingerprint,
	stableWorkFingerprint,
} from "./progress-classifier";

export type WatchdogMode = "observe" | "enforce";
export type WatchdogAction =
	| "none"
	| "reuse_duplicate"
	| "reject_duplicate"
	| "suppress_unchanged_poll"
	| "repair_state_drift"
	| "diagnose"
	| "stale_diagnosis";

export interface WatchdogInput {
	readonly observation?: HostObservation;
	readonly goalRevision?: number;
	readonly authoritativeInputRevision?: number;
	/** Revision of the host cursor/state that produced this observation. */
	readonly stateRevision?: number;
	readonly cursorRevision?: number;
	readonly ledgerRevision?: number;
	readonly now?: string;
}

export interface DiagnosisSnapshot {
	readonly scopeId: string;
	readonly basisRevision: number;
	readonly basisHash: string;
	readonly strategyFingerprint: string;
	readonly workFingerprint: string;
	readonly failureFingerprint?: string;
	readonly cursor?: string;
	readonly evidenceRefs: readonly string[];
	readonly gateIds: readonly string[];
	readonly assignmentIds: readonly string[];
	readonly createdAt: string;
}

export interface WatchdogLease {
	readonly strategyFingerprint: string;
	readonly workFingerprint: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly basisRevision: number;
}

export interface WatchdogDecision {
	readonly mode: WatchdogMode;
	readonly action: WatchdogAction;
	readonly enforced: boolean;
	readonly stale: boolean;
	readonly duplicate: boolean;
	readonly suspicious: boolean;
	readonly repeatCount: number;
	readonly strategyFingerprint: string;
	readonly workFingerprint: string;
	readonly failureFingerprint?: string;
	readonly cursor?: string;
	readonly classification: ClassifiedProgress;
	readonly lease: WatchdogLease;
	readonly diagnosis?: DiagnosisSnapshot;
	readonly currentRevision: number;
	readonly reason: string;
	/** Event-driven wait is the only poll suppression target. */
	readonly waitFor?: "external_event";
}

export interface WatchdogOptions {
	readonly ledger: ExecutionLedger;
	readonly mode?: WatchdogMode;
	readonly now?: () => string;
	/** Lease duration is advisory; expiry alone never terminates work. */
	readonly progressLeaseMs?: number;
	readonly repeatThreshold?: number;
	readonly maxDiagnosisEvidenceRefs?: number;
	readonly maxDiagnosisAssignments?: number;
}

type WatchdogOptionValues = Omit<WatchdogOptions, "ledger">;

interface ObservationEnvelope {
	readonly observation: HostObservation;
	readonly goalRevision: number;
	readonly authoritativeInputRevision: number;
	readonly stateRevision?: number;
	readonly now?: string;
}

interface StrategyTracker {
	readonly strategyFingerprint: string;
	readonly workFingerprint: string;
	lastPollFingerprint: string;
	lastFailureFingerprint?: string;
	lastCursor?: string;
	lastGoalRevision: number;
	lastAuthoritativeInputRevision: number;
	repeatCount: number;
	lease?: WatchdogLease;
}

function isWatchdogOptions(value: ExecutionLedger | WatchdogOptions): value is WatchdogOptions {
	return !(value instanceof ExecutionLedger);
}

function unwrapInput(input: HostObservation | WatchdogInput, now: () => string): ObservationEnvelope {
	if ("observation" in input && input.observation !== undefined) {
		const observation = input.observation;
		return {
			observation,
			goalRevision: input.goalRevision ?? observation.goalRevision ?? 0,
			authoritativeInputRevision: input.authoritativeInputRevision ?? observation.authoritativeInputRevision ?? 0,
			stateRevision:
				input.stateRevision ?? input.cursorRevision ?? input.ledgerRevision ?? observation.ledgerRevision,
			now: input.now ?? now(),
		};
	}
	const observation = input as HostObservation;
	return {
		observation,
		goalRevision: observation.goalRevision ?? 0,
		authoritativeInputRevision: observation.authoritativeInputRevision ?? 0,
		stateRevision: observation.ledgerRevision,
		now: now(),
	};
}

function strategyInput(observation: HostObservation): StrategyFingerprintInput {
	return {
		workKey: observation.workKey ?? observation.work?.workKey ?? observation.work?.key,
		workId: observation.workId ?? observation.work?.workId,
		displayName: observation.displayName ?? observation.work?.displayName,
		strategyKey: observation.strategyKey ?? observation.strategy?.strategyKey,
		strategyId: observation.strategyId ?? observation.strategy?.strategyId,
		hypothesisRef: observation.hypothesisRef ?? observation.strategy?.hypothesisRef,
		expectedEvidenceRefs: observation.expectedEvidenceRefs ?? observation.strategy?.expectedEvidenceRefs,
		independenceKey: observation.independenceKey ?? observation.strategy?.independenceKey,
	};
}

function hashNow(now: string, deltaMs: number): string {
	const timestamp = Date.parse(now);
	if (Number.isNaN(timestamp)) return now;
	return new Date(timestamp + Math.max(0, deltaMs)).toISOString();
}

function cursorNumber(cursor: string | undefined): number | undefined {
	if (cursor === undefined) return undefined;
	const match = /(?:^|[^0-9])(\d+)$/.exec(cursor);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) ? value : undefined;
}

/** Deterministic, host-only watchdog. It never writes terminal state to the ledger. */
export class Watchdog {
	readonly #ledger: ExecutionLedger;
	readonly #mode: WatchdogMode;
	readonly #now: () => string;
	readonly #progressLeaseMs: number;
	readonly #repeatThreshold: number;
	readonly #maxDiagnosisEvidenceRefs: number;
	readonly #maxDiagnosisAssignments: number;
	readonly #classifier: ProgressClassifier;
	readonly #trackers = new Map<string, StrategyTracker>();
	readonly #assignmentStrategies = new Map<string, string>();
	#lastLedgerRevision: number;
	#suspicion?: DiagnosisSnapshot;
	#unsubscribe: (() => void) | undefined;

	constructor(options: WatchdogOptions);
	constructor(ledger: ExecutionLedger, options?: WatchdogOptionValues);
	constructor(first: ExecutionLedger | WatchdogOptions, optionValues: WatchdogOptionValues = {}) {
		const options = isWatchdogOptions(first) ? first : { ...optionValues, ledger: first };
		this.#ledger = options.ledger;
		this.#mode = options.mode ?? "observe";
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#progressLeaseMs = Math.max(1, options.progressLeaseMs ?? 5 * 60 * 1000);
		this.#repeatThreshold = Math.max(2, Math.floor(options.repeatThreshold ?? 3));
		this.#maxDiagnosisEvidenceRefs = Math.max(1, Math.floor(options.maxDiagnosisEvidenceRefs ?? 16));
		this.#maxDiagnosisAssignments = Math.max(1, Math.floor(options.maxDiagnosisAssignments ?? 16));
		this.#classifier = new ProgressClassifier({ now: this.#now });
		this.#lastLedgerRevision = this.#ledger.revision;
		this.#unsubscribe = this.#ledger.subscribe((_record, snapshot) => {
			if (snapshot.revision <= this.#lastLedgerRevision) return;
			this.#lastLedgerRevision = snapshot.revision;
			for (const tracker of this.#trackers.values()) tracker.repeatCount = 0;
			if (this.#suspicion && snapshot.revision > this.#suspicion.basisRevision) this.#suspicion = undefined;
		});
	}

	get mode(): WatchdogMode {
		return this.#mode;
	}

	get classifier(): ProgressClassifier {
		return this.#classifier;
	}

	get currentDiagnosis(): DiagnosisSnapshot | undefined {
		return this.#suspicion;
	}

	getLease(strategyFingerprint: string): WatchdogLease | undefined {
		return this.#trackers.get(strategyFingerprint)?.lease;
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/** Observe a host signal. Observe mode only reports the reversible action. */
	observe(input: HostObservation | WatchdogInput): WatchdogDecision {
		return this.#evaluate(input, this.#mode === "enforce");
	}
	/** Explicitly apply only the reversible action represented by this observation/decision. */
	enforce(input: HostObservation | WatchdogInput | WatchdogDecision): WatchdogDecision {
		if (this.#isDecision(input)) {
			if (
				input.diagnosis &&
				(!this.#isDiagnosisCurrent(input.diagnosis) ||
					this.#suspicion === undefined ||
					this.#suspicion.basisHash !== input.diagnosis.basisHash)
			) {
				return {
					...input,
					action: "stale_diagnosis",
					enforced: false,
					stale: true,
					reason: "diagnosis basis is stale after a fresh ledger revision or progress observation",
				};
			}
			return { ...input, enforced: input.action !== "none" };
		}
		return this.#evaluate(input, true);
	}

	#evaluate(input: HostObservation | WatchdogInput, apply: boolean): WatchdogDecision {
		const envelope = unwrapInput(input, this.#now);
		const priorLedgerRevision = this.#lastLedgerRevision;
		const currentRevision = this.#ledger.revision;
		if (currentRevision > this.#lastLedgerRevision) {
			this.#lastLedgerRevision = currentRevision;
			for (const tracker of this.#trackers.values()) tracker.repeatCount = 0;
			if (this.#suspicion && currentRevision > this.#suspicion.basisRevision) this.#suspicion = undefined;
		}
		const classification = this.#classifier.classify(envelope.observation);
		const strategy = strategyInput(envelope.observation);
		const strategyFingerprint = classification.strategyFingerprint;
		const workFingerprint = classification.workFingerprint;
		const previous = this.#trackers.get(strategyFingerprint);
		const pollFingerprint = stablePollFingerprint({
			...strategy,
			strategyFingerprint,
			failureFingerprint: classification.failureFingerprint,
			cursor: classification.cursor,
		});
		const goalMoved = previous !== undefined && previous.lastGoalRevision !== envelope.goalRevision;
		const authoritativeMoved =
			previous !== undefined && previous.lastAuthoritativeInputRevision !== envelope.authoritativeInputRevision;
		const progressClearsSuspicion =
			classification.progress || classification.regression || classification.legitimateWaiting;
		const ledgerMoved = currentRevision > priorLedgerRevision;
		let repeatCount = 1;
		if (
			previous &&
			previous.lastPollFingerprint === pollFingerprint &&
			!goalMoved &&
			!authoritativeMoved &&
			!progressClearsSuspicion
		)
			repeatCount = previous.repeatCount + 1;
		if (goalMoved || authoritativeMoved || progressClearsSuspicion || ledgerMoved) {
			repeatCount = 1;
			this.#suspicion = undefined;
		}
		const previousCursor = cursorNumber(previous?.lastCursor);
		const currentCursor = cursorNumber(classification.cursor);
		const staleCursor = previousCursor !== undefined && currentCursor !== undefined && currentCursor < previousCursor;
		const lease: WatchdogLease = {
			strategyFingerprint,
			workFingerprint,
			issuedAt: envelope.now ?? this.#now(),
			expiresAt: hashNow(envelope.now ?? this.#now(), this.#progressLeaseMs),
			basisRevision: currentRevision,
		};
		const tracker: StrategyTracker = previous ?? {
			strategyFingerprint,
			workFingerprint,
			lastPollFingerprint: pollFingerprint,
			lastGoalRevision: envelope.goalRevision,
			lastAuthoritativeInputRevision: envelope.authoritativeInputRevision,
			repeatCount: 0,
		};
		tracker.lastPollFingerprint = pollFingerprint;
		tracker.lastFailureFingerprint = classification.failureFingerprint;
		tracker.lastCursor = classification.cursor;
		tracker.lastGoalRevision = envelope.goalRevision;
		tracker.lastAuthoritativeInputRevision = envelope.authoritativeInputRevision;
		tracker.repeatCount = repeatCount;
		if (classification.progress) tracker.lease = lease;
		this.#trackers.set(strategyFingerprint, tracker);

		let action: WatchdogAction = "none";
		let reason = classification.reason;
		let duplicate = false;
		let diagnosis = this.#suspicion;
		const duplicateCandidate =
			envelope.observation.duplicateCandidate === true ||
			envelope.observation.requestKind === "assignment" ||
			envelope.observation.assignmentId !== undefined;
		if (duplicateCandidate) {
			const priorAssignment = this.#assignmentStrategies.get(strategyFingerprint);
			if (priorAssignment !== undefined) {
				duplicate = true;
				action = "reuse_duplicate";
				reason = "exact work/strategy identity already assigned; reuse existing assignment";
			} else {
				this.#assignmentStrategies.set(
					strategyFingerprint,
					envelope.observation.assignmentId ?? strategyFingerprint,
				);
			}
		}

		const observedStateRevision = envelope.stateRevision;
		if (
			!duplicate &&
			(staleCursor || (observedStateRevision !== undefined && observedStateRevision !== currentRevision))
		) {
			action = "repair_state_drift";
			reason = staleCursor
				? "observation cursor moved backwards"
				: "observation cursor/state revision differs from the authoritative ledger";
		}

		const repeatedTuple =
			previous !== undefined &&
			previous.lastPollFingerprint === pollFingerprint &&
			!goalMoved &&
			!authoritativeMoved;
		const noLegitimateWaiting = !classification.legitimateWaiting;
		const multiSignalStall =
			repeatedTuple &&
			repeatCount >= this.#repeatThreshold &&
			noLegitimateWaiting &&
			!classification.progress &&
			!classification.regression &&
			!goalMoved &&
			!authoritativeMoved;
		if (multiSignalStall) {
			diagnosis = this.#buildDiagnosis(classification, envelope.now ?? this.#now());
			this.#suspicion = diagnosis;
			if (action === "none") {
				action = "suppress_unchanged_poll";
				reason = "repeated strategy/failure/cursor with no goal or authoritative input movement; wait for an event";
			}
		}
		const stale = diagnosis !== undefined && !this.#isDiagnosisCurrent(diagnosis);
		if (stale) {
			action = "stale_diagnosis";
			reason = "diagnosis basis is stale after a fresh ledger revision";
			this.#suspicion = undefined;
		}
		const enforced = apply && action !== "none" && action !== "stale_diagnosis";
		return {
			mode: this.#mode,
			action,
			enforced,
			stale,
			duplicate,
			suspicious: multiSignalStall,
			repeatCount,
			strategyFingerprint,
			workFingerprint,
			failureFingerprint: classification.failureFingerprint,
			cursor: classification.cursor,
			classification,
			lease,
			diagnosis,
			currentRevision,
			reason,
			waitFor: action === "suppress_unchanged_poll" ? "external_event" : undefined,
		};
	}

	#buildDiagnosis(classification: ClassifiedProgress, createdAt: string): DiagnosisSnapshot {
		const snapshot = this.#ledger.getSnapshot();
		const evidenceRefs = snapshot.evidenceRefs
			.map(evidence => evidence.evidenceId)
			.slice(-this.#maxDiagnosisEvidenceRefs);
		const gateIds = snapshot.gates.map(gate => gate.gateId).slice(-this.#maxDiagnosisEvidenceRefs);
		const assignmentIds = snapshot.assignments
			.map(assignment => assignment.assignmentId)
			.slice(-this.#maxDiagnosisAssignments);
		const basisHash = stableValueFingerprint({
			scopeId: snapshot.scopeId,
			revision: snapshot.revision,
			state: snapshot.state,
			gates: gateIds,
			evidenceRefs,
			assignments: assignmentIds,
			strategyFingerprint: classification.strategyFingerprint,
			workFingerprint: classification.workFingerprint,
			failureFingerprint: classification.failureFingerprint,
			cursor: classification.cursor,
		});
		return {
			scopeId: snapshot.scopeId,
			basisRevision: snapshot.revision,
			basisHash,
			strategyFingerprint: classification.strategyFingerprint,
			workFingerprint: classification.workFingerprint,
			failureFingerprint: classification.failureFingerprint,
			cursor: classification.cursor,
			evidenceRefs,
			gateIds,
			assignmentIds,
			createdAt,
		};
	}

	#isDiagnosisCurrent(diagnosis: DiagnosisSnapshot): boolean {
		if (diagnosis.scopeId !== this.#ledger.scopeId || diagnosis.basisRevision !== this.#ledger.revision) return false;
		const snapshot = this.#ledger.getSnapshot();
		const evidenceRefs = snapshot.evidenceRefs
			.map(evidence => evidence.evidenceId)
			.slice(-this.#maxDiagnosisEvidenceRefs);
		const gateIds = snapshot.gates.map(gate => gate.gateId).slice(-this.#maxDiagnosisEvidenceRefs);
		const assignmentIds = snapshot.assignments
			.map(assignment => assignment.assignmentId)
			.slice(-this.#maxDiagnosisAssignments);
		const basisHash = stableValueFingerprint({
			scopeId: snapshot.scopeId,
			revision: snapshot.revision,
			state: snapshot.state,
			gates: gateIds,
			evidenceRefs,
			assignments: assignmentIds,
			strategyFingerprint: diagnosis.strategyFingerprint,
			workFingerprint: diagnosis.workFingerprint,
			failureFingerprint: diagnosis.failureFingerprint,
			cursor: diagnosis.cursor,
		});
		return basisHash === diagnosis.basisHash;
	}

	#isDecision(value: HostObservation | WatchdogInput | WatchdogDecision): value is WatchdogDecision {
		return "classification" in value && "action" in value && "repeatCount" in value;
	}
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
	return new Watchdog(options);
}

export function watchdogObservation(input: HostObservation | WatchdogInput, watchdog: Watchdog): WatchdogDecision {
	return watchdog.observe(input);
}

export { stableFailureFingerprint, stablePollFingerprint, stableStrategyFingerprint, stableWorkFingerprint };
