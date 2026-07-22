/**
 * San RPC v2 identity generation.
 *
 * All IDs are opaque strings with a type prefix for debuggability.
 * Internally backed by Snowflake (time-sortable, unique per process).
 */
import { Snowflake } from "@oh-my-pi/pi-utils";

/** Prefixed ID brands for type safety at boundaries. */
export type RuntimeId = string & { readonly __brand: "RuntimeId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type LeaseId = string & { readonly __brand: "LeaseId" };
export type RunId = string & { readonly __brand: "RunId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
export type EventId = string & { readonly __brand: "EventId" };
export type OperationId = string & { readonly __brand: "OperationId" };
export type ApprovalId = string & { readonly __brand: "ApprovalId" };
export type InteractionId = string & { readonly __brand: "InteractionId" };
export type QueueItemId = string & { readonly __brand: "QueueItemId" };
export type EvidenceId = string & { readonly __brand: "EvidenceId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
export type ResourceId = string & { readonly __brand: "ResourceId" };
export type UploadId = string & { readonly __brand: "UploadId" };
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };
export type MaintenanceId = string & { readonly __brand: "MaintenanceId" };
export type RetryId = string & { readonly __brand: "RetryId" };
export type LoginId = string & { readonly __brand: "LoginId" };
export type IntegrationId = string & { readonly __brand: "IntegrationId" };

function generate(prefix: string): string {
	return `${prefix}_${Snowflake.next()}`;
}

export function newRuntimeId(): RuntimeId {
	return generate("rt") as RuntimeId;
}

export function newLeaseId(): LeaseId {
	return generate("lease") as LeaseId;
}

export function newRunId(): RunId {
	return generate("run") as RunId;
}

export function newTurnId(): TurnId {
	return generate("turn") as TurnId;
}

export function newMessageId(): MessageId {
	return generate("msg") as MessageId;
}

export function newEventId(): EventId {
	return generate("evt") as EventId;
}

export function newOperationId(): OperationId {
	return generate("op") as OperationId;
}

export function newApprovalId(): ApprovalId {
	return generate("apr") as ApprovalId;
}

export function newInteractionId(): InteractionId {
	return generate("int") as InteractionId;
}

export function newQueueItemId(): QueueItemId {
	return generate("qi") as QueueItemId;
}

export function newEvidenceId(): EvidenceId {
	return generate("evd") as EvidenceId;
}

export function newArtifactId(): ArtifactId {
	return generate("art") as ArtifactId;
}

export function newResourceId(): ResourceId {
	return generate("res") as ResourceId;
}

export function newUploadId(): UploadId {
	return generate("upl") as UploadId;
}

export function newSubscriptionId(): SubscriptionId {
	return generate("sub") as SubscriptionId;
}

export function newMaintenanceId(): MaintenanceId {
	return generate("mnt") as MaintenanceId;
}

export function newRetryId(): RetryId {
	return generate("rty") as RetryId;
}

export function newLoginId(): LoginId {
	return generate("lgn") as LoginId;
}

/**
 * Per-Session monotonic sequence allocator.
 * Sequence is 1-based and only comparable within the same Session.
 */
export class SequenceAllocator {
	#current: number;

	constructor(startAt = 0) {
		this.#current = startAt;
	}

	next(): number {
		return ++this.#current;
	}

	get current(): number {
		return this.#current;
	}

	/** Advance to at least the given value (used during recovery). */
	advanceTo(value: number): void {
		if (value > this.#current) {
			this.#current = value;
		}
	}
}
