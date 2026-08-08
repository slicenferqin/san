/** Errors emitted by the provider-health circuit. */

import type { ProviderHealthKey, ProviderHealthSnapshot } from "./provider-health";

/**
 * Raised before a provider request is dispatched while its circuit is open.
 *
 * The error intentionally contains only canonical, credential-free route facts.
 * Callers may use `retryAt` to park work without inspecting provider internals.
 */
export class ProviderCircuitOpenError extends Error {
	readonly key: ProviderHealthKey;
	readonly snapshot: ProviderHealthSnapshot;
	readonly retryAt?: number;
	readonly generation: number;
	readonly healthRevision: number;

	constructor(snapshot: ProviderHealthSnapshot) {
		const route = `${snapshot.key.provider}/${snapshot.key.normalizedUrl || "default"}`;
		super(
			`Provider circuit is open for ${route}${snapshot.retryAt === undefined ? "" : ` until ${snapshot.retryAt}.`}`,
		);
		this.name = "ProviderCircuitOpenError";
		this.key = snapshot.key;
		this.snapshot = snapshot;
		this.retryAt = snapshot.retryAt;
		this.generation = snapshot.generation;
		this.healthRevision = snapshot.healthRevision;
	}
}

/** Base class for malformed or otherwise unusable provider-health inputs. */
export class ProviderHealthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderHealthError";
	}
}

/** Raised when a parked assignment cannot be resumed safely. */
export class ProviderAssignmentReplayError extends ProviderHealthError {
	readonly assignmentId: string;

	constructor(assignmentId: string, message: string) {
		super(message);
		this.name = "ProviderAssignmentReplayError";
		this.assignmentId = assignmentId;
	}
}
