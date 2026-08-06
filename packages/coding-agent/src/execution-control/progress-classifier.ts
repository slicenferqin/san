import type { AcceptanceGateStatus, ExecutionLedgerEvent, ProgressClass, ProgressObservation } from "./types";

/** The normalized host signals understood by the progress classifier. */
export type HostObservationType =
	| "mutation"
	| "write"
	| "gate_transition"
	| "gate"
	| "evidence"
	| "artifact"
	| "research_artifact"
	| "coverage_growth"
	| "dependency_change"
	| "dependency"
	| "blocker_change"
	| "blocker"
	| "read"
	| "activity"
	| "failure"
	| "failure_signature"
	| "verification_regression"
	| "verification"
	| "process_heartbeat"
	| "job_heartbeat"
	| "heartbeat"
	| "provider_retry_at"
	| "provider_retry"
	| "external_event_subscription"
	| "external_subscription";

export interface WorkFingerprintInput {
	readonly workKey?: string;
	readonly workId?: string;
	readonly key?: string;
	readonly displayName?: string;
}

export interface StrategyFingerprintInput extends WorkFingerprintInput {
	readonly strategyKey?: string;
	readonly strategyId?: string;
	readonly hypothesisRef?: string;
	readonly expectedEvidenceRefs?: readonly string[];
	readonly independenceKey?: string;
}

export interface PollFingerprintInput {
	readonly workKey?: string;
	readonly workId?: string;
	readonly displayName?: string;
	readonly strategyKey?: string;
	readonly strategyId?: string;
	readonly hypothesisRef?: string;
	readonly expectedEvidenceRefs?: readonly string[];
	readonly independenceKey?: string;
	readonly strategyFingerprint?: string;
	readonly failureFingerprint?: string;
	readonly failureSignature?: string;
	readonly cursor?: string;
}

export interface HostObservationBase {
	/** `type` is canonical; `observationType` and `kind` are accepted aliases. */
	readonly type?: HostObservationType;
	readonly observationType?: HostObservationType;
	readonly kind?: HostObservationType;
	readonly observationId?: string;
	readonly workKey?: string;
	readonly workId?: string;
	readonly displayName?: string;
	readonly strategyKey?: string;
	readonly strategyId?: string;
	readonly hypothesisRef?: string;
	readonly expectedEvidenceRefs?: readonly string[];
	readonly independenceKey?: string;
	readonly work?: WorkFingerprintInput;
	readonly strategy?: StrategyFingerprintInput;
	readonly cursor?: string;
	readonly goalRevision?: number;
	readonly authoritativeInputRevision?: number;
	readonly ledgerRevision?: number;
	/** Assignment/dispatch observations are eligible for duplicate reuse checks. */
	readonly assignmentId?: string;
	readonly requestKind?: "assignment" | "poll";
	readonly duplicateCandidate?: boolean;
}

export interface MutationObservation extends HostObservationBase {
	readonly type?: "mutation" | "write";
	readonly observationType?: "mutation" | "write";
	readonly kind?: "mutation" | "write";
	readonly filename?: string;
	readonly path?: string;
	readonly operation?: string;
	readonly contentFingerprint?: string;
	readonly changed?: boolean;
}

export interface GateTransitionObservation extends HostObservationBase {
	readonly type?: "gate_transition" | "gate";
	readonly observationType?: "gate_transition" | "gate";
	readonly kind?: "gate_transition" | "gate";
	readonly gateId: string;
	readonly from?: AcceptanceGateStatus;
	readonly previousStatus?: AcceptanceGateStatus;
	readonly to?: AcceptanceGateStatus;
	readonly status?: AcceptanceGateStatus;
	readonly contractRevision?: number;
}

export interface EvidenceObservation extends HostObservationBase {
	readonly type?: "evidence" | "artifact" | "research_artifact" | "coverage_growth";
	readonly observationType?: "evidence" | "artifact" | "research_artifact" | "coverage_growth";
	readonly kind?: HostObservationType | "artifact" | "research_artifact";
	readonly evidenceId?: string;
	readonly evidenceKind?: string;
	readonly gateId?: string;
	readonly receiptRef?: string;
	readonly artifactKind?: string;
	readonly schemaId?: string;
	readonly schemaKey?: string;
	readonly coverageKey?: string;
	readonly coverageKeys?: readonly string[];
	readonly coverage?: readonly string[];
	readonly newCoverageKeys?: readonly string[];
}

export interface DependencyChangeObservation extends HostObservationBase {
	readonly type?: "dependency_change" | "dependency";
	readonly observationType?: "dependency_change" | "dependency";
	readonly kind?: "dependency_change" | "dependency";
	readonly dependencyKey?: string;
	readonly dependencyId?: string;
	readonly fromState?: string;
	readonly toState?: string;
	readonly state?: string;
	readonly revision?: number;
	readonly resolved?: boolean;
	readonly blocked?: boolean;
}

export interface BlockerChangeObservation extends HostObservationBase {
	readonly type?: "blocker_change" | "blocker";
	readonly observationType?: "blocker_change" | "blocker";
	readonly kind?: "blocker_change" | "blocker";
	readonly blockerKey?: string;
	readonly blockerId?: string;
	readonly fromState?: string;
	readonly toState?: string;
	readonly state?: string;
	readonly revision?: number;
	readonly resolved?: boolean;
	readonly blocked?: boolean;
}

export interface ReadObservation extends HostObservationBase {
	readonly type?: "read" | "activity";
	readonly observationType?: "read" | "activity";
	readonly kind?: "read" | "activity";
	readonly filename?: string;
	readonly path?: string;
	readonly resourceKey?: string;
	readonly newFilename?: boolean;
}

export interface FailureSignatureObservation extends HostObservationBase {
	readonly type?: "failure" | "failure_signature";
	readonly observationType?: "failure" | "failure_signature";
	readonly kind?: "failure" | "failure_signature";
	readonly signature?: string;
	readonly failureSignature?: string;
	readonly category?: string;
	readonly retryable?: boolean;
	readonly resolved?: boolean;
}

export interface VerificationRegressionObservation extends HostObservationBase {
	readonly type?: "verification_regression" | "verification";
	readonly observationType?: "verification_regression" | "verification";
	readonly kind?: "verification_regression" | "verification";
	readonly gateId: string;
	readonly verificationId?: string;
	readonly from: "pass";
	readonly to: "fail";
	readonly evidenceRefs?: readonly string[];
}

export interface ProcessHeartbeatObservation extends HostObservationBase {
	readonly type?: "process_heartbeat" | "job_heartbeat" | "heartbeat";
	readonly observationType?: "process_heartbeat" | "job_heartbeat" | "heartbeat";
	readonly kind?: "process_heartbeat" | "job_heartbeat" | "heartbeat";
	readonly processId?: string;
	readonly jobId?: string;
	readonly live?: boolean;
}

export interface ProviderRetryAtObservation extends HostObservationBase {
	readonly type?: "provider_retry_at" | "provider_retry";
	readonly observationType?: "provider_retry_at" | "provider_retry";
	readonly kind?: "provider_retry_at" | "provider_retry";
	readonly providerKey?: string;
	readonly retryAt: string;
}

export interface ExternalEventSubscriptionObservation extends HostObservationBase {
	readonly type?: "external_event_subscription" | "external_subscription";
	readonly observationType?: "external_event_subscription" | "external_subscription";
	readonly kind?: "external_event_subscription" | "external_subscription";
	readonly subscriptionKey: string;
	readonly active?: boolean;
	readonly subscribed?: boolean;
}

export type HostObservation =
	| MutationObservation
	| GateTransitionObservation
	| EvidenceObservation
	| DependencyChangeObservation
	| BlockerChangeObservation
	| ReadObservation
	| FailureSignatureObservation
	| VerificationRegressionObservation
	| ProcessHeartbeatObservation
	| ProviderRetryAtObservation
	| ExternalEventSubscriptionObservation;

export type NormalizedHostObservation = HostObservation;
export type ProgressObservationInput = HostObservation;
export type ClassifiedProgressClass = ProgressClass | "legitimate_waiting";

export interface ProgressClassifierOptions {
	readonly now?: () => string;
}

export interface ClassifiedProgress {
	readonly observationId?: string;
	readonly observationType: HostObservationType;
	readonly classification: ClassifiedProgressClass;
	/** Alias for consumers that use the ledger vocabulary. */
	readonly progressClass: ClassifiedProgressClass;
	readonly activity: boolean;
	readonly progress: boolean;
	readonly regression: boolean;
	readonly blocker: boolean;
	readonly legitimateWaiting: boolean;
	readonly fingerprint: string;
	readonly workFingerprint: string;
	readonly strategyFingerprint: string;
	readonly failureFingerprint?: string;
	readonly cursor?: string;
	readonly reason: string;
	readonly newCoverageKeys: readonly string[];
}

export interface ProgressClassifierState {
	readonly gateStatuses: ReadonlyMap<string, AcceptanceGateStatus>;
	readonly evidenceKeys: ReadonlySet<string>;
	readonly researchCoverageKeys: ReadonlySet<string>;
	readonly dependencyRevisions: ReadonlyMap<string, number>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stableSerialize(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

function hashFingerprint(value: unknown): string {
	const text = stableSerialize(value);
	let hash = 2166136261;
	for (const character of text) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return `fp:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Stable hash for bounded diagnosis bases and other host-owned facts. */
export function stableValueFingerprint(value: unknown): string {
	return hashFingerprint(value);
}

/** Normalize labels without letting presentation-only revisions become identity. */
export function normalizeIdentityLabel(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\b(?:v(?:ersion)?\s*\d+|final|repair)\b/g, " ")
		.replace(/[\s._:/-]+/g, " ")
		.trim();
}

function normalizeStableReference(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\b(?:v(?:ersion)?\s*\d+|final|repair)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function firstText(...values: readonly (string | undefined)[]): string {
	for (const value of values) {
		if (value !== undefined && value.trim().length > 0) return value;
	}
	return "unknown";
}

function workIdentity(value: WorkFingerprintInput | string): string {
	if (typeof value === "string") return normalizeIdentityLabel(value);
	return normalizeIdentityLabel(firstText(value.workKey, value.workId, value.key, value.displayName));
}

export function stableWorkFingerprint(value: WorkFingerprintInput | string): string {
	return hashFingerprint({ work: workIdentity(value) });
}

function strategyIdentity(value: StrategyFingerprintInput | string): {
	work: string;
	strategy: string;
	hypothesis: string;
	expectedEvidence: readonly string[];
	independence: string;
} {
	if (typeof value === "string") {
		return {
			work: "unknown",
			strategy: normalizeIdentityLabel(value),
			hypothesis: "unknown",
			expectedEvidence: [],
			independence: "unknown",
		};
	}
	return {
		work: workIdentity(value),
		strategy: normalizeIdentityLabel(firstText(value.strategyKey, value.strategyId)),
		hypothesis: normalizeStableReference(firstText(value.hypothesisRef)),
		expectedEvidence: [...new Set((value.expectedEvidenceRefs ?? []).map(normalizeStableReference))].sort(),
		independence: normalizeStableReference(firstText(value.independenceKey)),
	};
}

export function stableStrategyFingerprint(value: StrategyFingerprintInput | string): string {
	return hashFingerprint({ strategy: strategyIdentity(value) });
}

export interface FailureFingerprintInput {
	readonly signature?: string;
	readonly failureSignature?: string;
	readonly category?: string;
}

export function stableFailureFingerprint(value: FailureFingerprintInput | string): string {
	if (typeof value === "string") return hashFingerprint({ failure: normalizeStableReference(value) });
	return hashFingerprint({
		failure: normalizeStableReference(firstText(value.signature, value.failureSignature)),
		category: normalizeStableReference(firstText(value.category)),
	});
}

export function stablePollFingerprint(value: PollFingerprintInput): string {
	const strategy = value.strategyFingerprint ?? stableStrategyFingerprint(value);
	const failure =
		value.failureFingerprint ?? (value.failureSignature ? stableFailureFingerprint(value.failureSignature) : "none");
	return hashFingerprint({
		work: stableWorkFingerprint(value),
		strategy,
		failure,
		cursor: value.cursor === undefined ? "none" : value.cursor,
	});
}

function resolveObservationType(input: HostObservation): HostObservationType {
	const candidate = input.type ?? input.observationType ?? input.kind;
	if (candidate === "dependency" || candidate === "dependency_change") return "dependency_change";
	if (candidate === "blocker" || candidate === "blocker_change") return "blocker_change";
	if (candidate === "heartbeat" || candidate === "job_heartbeat" || candidate === "process_heartbeat")
		return "process_heartbeat";
	if (candidate === "provider_retry" || candidate === "provider_retry_at") return "provider_retry_at";
	if (candidate === "gate") return "gate_transition";
	if (candidate === "artifact" || candidate === "research_artifact" || candidate === "coverage_growth")
		return "evidence";
	if (candidate === "failure_signature") return "failure";
	if (candidate === "verification") return "verification_regression";
	if (candidate === "activity") return "read";
	if (candidate === "write") return "mutation";
	if (candidate === "external_subscription") return "external_event_subscription";
	return candidate ?? inferObservationType(input);
}

function inferObservationType(input: HostObservation): HostObservationType {
	if ("gateId" in input && ("to" in input || "status" in input)) {
		if (input.from === "pass" && (input.to === "fail" || input.status === "fail")) return "verification_regression";
		return "gate_transition";
	}
	if (
		"coverageKeys" in input ||
		"coverageKey" in input ||
		"schemaKey" in input ||
		"schemaId" in input ||
		"evidenceId" in input ||
		"artifactKind" in input
	)
		return "evidence";
	if ("dependencyKey" in input || "dependencyId" in input) return "dependency_change";
	if ("blockerKey" in input || "blockerId" in input) return "blocker_change";
	if ("processId" in input || "jobId" in input || "live" in input) return "process_heartbeat";
	if ("providerKey" in input && "retryAt" in input) return "provider_retry_at";
	if ("subscriptionKey" in input) return "external_event_subscription";
	if ("signature" in input || "failureSignature" in input) return "failure";
	if ("filename" in input || "path" in input || "resourceKey" in input) return "read";
	return "mutation";
}

function identityParts(input: HostObservation): StrategyFingerprintInput {
	return {
		workKey: input.workKey ?? input.work?.workKey ?? input.work?.key,
		workId: input.workId ?? input.work?.workId,
		displayName: input.displayName ?? input.work?.displayName,
		strategyKey: input.strategyKey ?? input.strategy?.strategyKey,
		strategyId: input.strategyId ?? input.strategy?.strategyId,
		hypothesisRef: input.hypothesisRef ?? input.strategy?.hypothesisRef,
		expectedEvidenceRefs: input.expectedEvidenceRefs ?? input.strategy?.expectedEvidenceRefs,
		independenceKey: input.independenceKey ?? input.strategy?.independenceKey,
	};
}

function isResearchArtifact(input: EvidenceObservation): boolean {
	const explicitKind = firstText(input.evidenceKind, input.artifactKind, input.kind).toLowerCase();
	return input.type === "research_artifact" || input.type === "coverage_growth" || explicitKind.includes("research");
}

function coverageKeys(input: EvidenceObservation): readonly string[] {
	const values = [
		...(input.coverageKeys ?? []),
		...(input.coverage ?? []),
		...(input.newCoverageKeys ?? []),
		...(input.coverageKey ? [input.coverageKey] : []),
		...(input.schemaKey ? [input.schemaKey] : []),
		...(input.schemaId ? [input.schemaId] : []),
	];
	return [
		...new Set(values.map(value => value.normalize("NFKC").trim().toLowerCase()).filter(value => value.length > 0)),
	].sort();
}

function isResolvedState(value: string | undefined, resolved: boolean | undefined): boolean {
	if (resolved === true) return true;
	const normalized = value?.toLowerCase();
	return (
		normalized === "resolved" ||
		normalized === "complete" ||
		normalized === "completed" ||
		normalized === "pass" ||
		normalized === "ready"
	);
}

function isBlockedState(value: string | undefined, blocked: boolean | undefined): boolean {
	if (blocked === true) return true;
	const normalized = value?.toLowerCase();
	return normalized === "blocked" || normalized === "failed" || normalized === "unavailable";
}

function makeProgressObservation(
	result: ClassifiedProgress,
	observationId: string,
	revision: number,
): ProgressObservation {
	return {
		observationId,
		progressClass: result.progressClass === "legitimate_waiting" ? "activity" : result.progressClass,
		fingerprint: result.fingerprint,
		revision,
		strategyKey: result.strategyFingerprint,
		failureFingerprint: result.failureFingerprint,
		cursor: result.cursor,
	};
}

/** Stateful deterministic classifier; state tracks monotonic host facts only. */
export class ProgressClassifier {
	readonly #now: () => string;
	readonly #gateStatuses = new Map<string, AcceptanceGateStatus>();
	readonly #evidenceKeys = new Set<string>();
	readonly #researchCoverageKeys = new Set<string>();
	readonly #dependencyRevisions = new Map<string, number>();

	constructor(options: ProgressClassifierOptions = {}) {
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	getState(): ProgressClassifierState {
		return {
			gateStatuses: new Map(this.#gateStatuses),
			evidenceKeys: new Set(this.#evidenceKeys),
			researchCoverageKeys: new Set(this.#researchCoverageKeys),
			dependencyRevisions: new Map(this.#dependencyRevisions),
		};
	}

	reset(): void {
		this.#gateStatuses.clear();
		this.#evidenceKeys.clear();
		this.#researchCoverageKeys.clear();
		this.#dependencyRevisions.clear();
	}

	classify(input: HostObservation): ClassifiedProgress {
		const observationType = resolveObservationType(input);
		const identity = identityParts(input);
		const workFingerprint = stableWorkFingerprint(identity);
		const strategyFingerprint = stableStrategyFingerprint(identity);
		const failureFingerprint =
			"signature" in input || "failureSignature" in input
				? stableFailureFingerprint({
						signature: input.signature,
						failureSignature: input.failureSignature,
						category: input.category,
					})
				: undefined;
		const fingerprint = stablePollFingerprint({
			...identity,
			strategyFingerprint,
			failureFingerprint,
			cursor: input.cursor,
		});
		const base = {
			observationId: input.observationId,
			observationType,
			fingerprint,
			workFingerprint,
			strategyFingerprint,
			failureFingerprint,
			cursor: input.cursor,
			newCoverageKeys: [] as readonly string[],
		};

		switch (observationType) {
			case "gate_transition": {
				const gate = input as GateTransitionObservation;
				const previous = this.#gateStatuses.get(gate.gateId);
				const to = gate.to ?? gate.status ?? "unknown";
				const from = gate.from ?? gate.previousStatus ?? previous ?? "unknown";
				this.#gateStatuses.set(gate.gateId, to);
				if (from === to) return this.#result(base, "activity", "gate status unchanged");
				if (from === "pass" && to !== "pass") return this.#result(base, "regression", "acceptance gate regressed");
				return this.#result(base, "progress", "acceptance gate advanced");
			}
			case "verification_regression":
				return this.#result(base, "regression", "verification changed from pass to fail");
			case "evidence": {
				const evidence = input as EvidenceObservation;
				const keys = coverageKeys(evidence);
				if (isResearchArtifact(evidence)) {
					const fresh = keys.filter(key => !this.#researchCoverageKeys.has(key));
					for (const key of keys) this.#researchCoverageKeys.add(key);
					if (fresh.length > 0)
						return this.#result({ ...base, newCoverageKeys: fresh }, "progress", "research coverage/schema grew");
					return this.#result(base, "activity", "research artifact repeated without new coverage/schema");
				}
				const key = firstText(
					evidence.evidenceId,
					evidence.receiptRef,
					`${evidence.gateId ?? ""}:${keys.join(",")}`,
				);
				const normalized = normalizeIdentityLabel(key);
				if (this.#evidenceKeys.has(normalized)) return this.#result(base, "activity", "evidence repeated");
				this.#evidenceKeys.add(normalized);
				return this.#result(base, "progress", "new authoritative evidence");
			}
			case "dependency_change":
			case "blocker_change": {
				const dependency = input as DependencyChangeObservation | BlockerChangeObservation;
				const key = firstText(
					"dependencyKey" in dependency ? dependency.dependencyKey : undefined,
					"dependencyId" in dependency ? dependency.dependencyId : undefined,
					"blockerKey" in dependency ? dependency.blockerKey : undefined,
					"blockerId" in dependency ? dependency.blockerId : undefined,
				);
				const previousRevision = this.#dependencyRevisions.get(key);
				const revisionMoved =
					dependency.revision !== undefined &&
					(previousRevision === undefined || dependency.revision > previousRevision);
				if (
					dependency.revision !== undefined &&
					(previousRevision === undefined || dependency.revision > previousRevision)
				) {
					this.#dependencyRevisions.set(key, dependency.revision);
				}
				const state = dependency.toState ?? dependency.state;
				const from = dependency.fromState;
				if (isResolvedState(state, dependency.resolved) && (revisionMoved || from !== state))
					return this.#result(base, "progress", "dependency/blocker resolved or advanced");
				if (isBlockedState(state, dependency.blocked))
					return this.#result(base, "blocker", "dependency/blocker remains unavailable");
				if (revisionMoved || from !== state)
					return this.#result(base, "progress", "dependency revision/state advanced");
				return this.#result(base, "activity", "dependency/blocker unchanged");
			}
			case "failure": {
				const failure = input as FailureSignatureObservation;
				if (failure.resolved === true) return this.#result(base, "progress", "failure resolved");
				return this.#result(base, "blocker", "failure signature observed");
			}
			case "process_heartbeat": {
				const heartbeat = input as ProcessHeartbeatObservation;
				if (heartbeat.live !== false) return this.#result(base, "legitimate_waiting", "live process/job heartbeat");
				return this.#result(base, "blocker", "process/job is no longer live");
			}
			case "provider_retry_at": {
				const retry = input as ProviderRetryAtObservation;
				const retryMs = Date.parse(retry.retryAt);
				const nowMs = Date.parse(this.#now());
				if (!Number.isNaN(retryMs) && (Number.isNaN(nowMs) || retryMs < nowMs))
					return this.#result(base, "blocker", "provider retry time has elapsed");
				return this.#result(base, "legitimate_waiting", "provider retryAt is live");
			}
			case "external_event_subscription": {
				const subscription = input as ExternalEventSubscriptionObservation;
				if (subscription.active !== false && subscription.subscribed !== false)
					return this.#result(base, "legitimate_waiting", "external event subscription is live");
				return this.#result(base, "blocker", "external event subscription is inactive");
			}
			case "mutation":
				return this.#result(base, "activity", "host mutation observed");
			case "read":
				return this.#result(base, "activity", "host read/activity observed");
		}
		return this.#result(base, "activity", "unrecognized host signal");
	}

	observe(input: HostObservation): ClassifiedProgress {
		return this.classify(input);
	}

	toLedgerObservation(
		result: ClassifiedProgress,
		revision: number,
		observationId = result.observationId ?? `progress:${result.fingerprint}`,
	): ProgressObservation {
		return makeProgressObservation(result, observationId, revision);
	}

	toLedgerEvent(
		result: ClassifiedProgress,
		revision: number,
		observationId = result.observationId ?? `progress:${result.fingerprint}`,
	): ExecutionLedgerEvent {
		return {
			type: "progress_observed",
			recordId: `progress-record:${observationId}:${revision}`,
			observation: this.toLedgerObservation(result, revision, observationId),
		};
	}

	#result(
		base: Omit<
			ClassifiedProgress,
			| "classification"
			| "progressClass"
			| "activity"
			| "progress"
			| "regression"
			| "blocker"
			| "legitimateWaiting"
			| "reason"
		>,
		classification: ClassifiedProgressClass,
		reason: string,
	): ClassifiedProgress {
		return {
			...base,
			classification,
			progressClass: classification,
			activity: classification === "activity",
			progress: classification === "progress",
			regression: classification === "regression",
			blocker: classification === "blocker",
			legitimateWaiting: classification === "legitimate_waiting",
			reason,
		};
	}
}

export function classifyHostObservation(
	input: HostObservation,
	options?: ProgressClassifierOptions,
): ClassifiedProgress {
	return new ProgressClassifier(options).classify(input);
}

export function classifyProgress(input: HostObservation, options?: ProgressClassifierOptions): ClassifiedProgress {
	return classifyHostObservation(input, options);
}

export function toLedgerProgressObservation(
	result: ClassifiedProgress,
	revision: number,
	observationId?: string,
): ProgressObservation {
	return makeProgressObservation(
		result,
		observationId ?? result.observationId ?? `progress:${result.fingerprint}`,
		revision,
	);
}
