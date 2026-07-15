import type { CustomEntry, SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { isWorkflowEvent } from "./schema";
import type { WorkflowDeliveryState, WorkflowEvent, WorkflowRunStatus, WorkflowWriteArtifactStatus } from "./types";

export const WORKFLOW_EVENT_CUSTOM_TYPE = "san.workflow_event";

export interface WorkflowLedgerEntry {
	entryId: string;
	parentId: string | null;
	timestamp: string;
	data: WorkflowEvent;
}

export interface WorkflowRunReadModel {
	runId: string;
	status: WorkflowRunStatus;
	deliveryState: WorkflowDeliveryState;
	events: WorkflowLedgerEntry[];
	duplicateDeliveryEventIds: string[];
	invalidTransitionEventIds: string[];
	invalidSequenceEventIds: string[];
	writeArtifacts: Map<string, { status: WorkflowWriteArtifactStatus; eventIds: string[] }>;
	unknownWriteArtifactIds: string[];
}

export interface WorkflowLedgerSnapshot {
	events: WorkflowLedgerEntry[];
	runs: Map<string, WorkflowRunReadModel>;
	invalidEntryIds: string[];
	duplicateEventIds: string[];
}

export function appendWorkflowEvent(sessionManager: ReadonlySessionManager, event: WorkflowEvent): string {
	if (!isWorkflowEvent(event)) throw new Error("Refusing to append an invalid Workflow event.");
	return sessionManager.appendCustomEntry(WORKFLOW_EVENT_CUSTOM_TYPE, event);
}

function ledgerEntry(entry: CustomEntry, data: WorkflowEvent): WorkflowLedgerEntry {
	return { entryId: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, data };
}

function nextStatusForEvent(type: WorkflowEvent["type"], current: WorkflowRunStatus): WorkflowRunStatus | undefined {
	switch (type) {
		case "run_started":
			return current === "approved" ? "running" : undefined;
		case "run_resumed":
			return current === "paused" ? "running" : undefined;
		case "run_paused":
			return current === "running" ? "paused" : undefined;
		case "run_cancelled":
			return current === "approved" || current === "running" || current === "paused" ? "cancelled" : undefined;
		case "run_blocked":
			return current === "approved" || current === "running" || current === "paused" || current === "completed"
				? "blocked"
				: undefined;
		case "run_completed":
			return current === "running" || current === "paused" ? "completed" : undefined;
		case "run_failed":
			return current === "approved" || current === "running" || current === "paused" ? "failed" : undefined;
		case "agent_failed":
			return current;
		default:
			return current;
	}
}

function nextWriteStatus(
	type: WorkflowEvent["type"],
	current: WorkflowWriteArtifactStatus | undefined,
): WorkflowWriteArtifactStatus | undefined {
	switch (type) {
		case "write_captured":
			return current === undefined ? "pending" : undefined;
		case "write_reviewed":
			return current === "pending" || current === "reviewed" ? "reviewed" : undefined;
		case "write_apply_started":
			return current === "reviewed" ? "applying" : undefined;
		case "write_applied":
			return current === "applying" ? "applied" : undefined;
		case "write_rejected":
			return current === "pending" || current === "reviewed" ? "rejected" : undefined;
		case "write_blocked":
			return current === "pending" || current === "reviewed" || current === "applying" ? "blocked" : undefined;
		case "write_unknown":
			return current === "applying" ? "unknown" : undefined;
		default:
			return current;
	}
}

export function rebuildWorkflowLedger(entries: readonly SessionEntry[]): WorkflowLedgerSnapshot {
	const events: WorkflowLedgerEntry[] = [];
	const runs = new Map<string, WorkflowRunReadModel>();
	const invalidEntryIds: string[] = [];
	const duplicateEventIds: string[] = [];
	const seenEventIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKFLOW_EVENT_CUSTOM_TYPE) continue;
		if (!isWorkflowEvent(entry.data)) {
			invalidEntryIds.push(entry.id);
			continue;
		}
		if (seenEventIds.has(entry.data.eventId)) {
			duplicateEventIds.push(entry.data.eventId);
			continue;
		}
		seenEventIds.add(entry.data.eventId);
		const item = ledgerEntry(entry, entry.data);
		events.push(item);
		const runId = entry.data.runId;
		if (!runId) continue;
		let run = runs.get(runId);
		if (!run) {
			run = {
				runId,
				status: "approved",
				deliveryState: "pending",
				events: [],
				duplicateDeliveryEventIds: [],
				invalidTransitionEventIds: [],
				invalidSequenceEventIds: [],
				writeArtifacts: new Map(),
				unknownWriteArtifactIds: [],
			};
			runs.set(runId, run);
		}
		const previousSequence = run.events.at(-1)?.data.sequence;
		if (previousSequence !== undefined && entry.data.sequence !== previousSequence + 1) {
			run.invalidSequenceEventIds.push(entry.data.eventId);
		}
		run.events.push(item);
		const nextStatus = nextStatusForEvent(entry.data.type, run.status);
		if (nextStatus === undefined) run.invalidTransitionEventIds.push(entry.data.eventId);
		else run.status = nextStatus;
		if (entry.data.type.startsWith("write_")) {
			const artifactId = entry.data.payload.artifactId;
			if (typeof artifactId !== "string" || !artifactId) {
				run.invalidTransitionEventIds.push(entry.data.eventId);
			} else {
				const write = run.writeArtifacts.get(artifactId);
				const nextWrite = nextWriteStatus(entry.data.type, write?.status);
				if (nextWrite === undefined) run.invalidTransitionEventIds.push(entry.data.eventId);
				else {
					run.writeArtifacts.set(artifactId, {
						status: nextWrite,
						eventIds: [...(write?.eventIds ?? []), entry.data.eventId],
					});
				}
			}
		}
		if (entry.data.type === "result_delivery_prepared") {
			if (run.status !== "completed" || run.deliveryState !== "pending") {
				run.deliveryState = "blocked";
				run.invalidTransitionEventIds.push(entry.data.eventId);
			} else {
				run.deliveryState = "delivering";
			}
		}
		if (entry.data.type === "result_delivered") {
			if (run.deliveryState === "delivered") run.duplicateDeliveryEventIds.push(entry.data.eventId);
			const unresolvedWrites = [...run.writeArtifacts.values()].some(
				write => write.status !== "applied" && write.status !== "rejected",
			);
			if (run.status !== "completed" || unresolvedWrites) {
				run.deliveryState = "blocked";
				run.invalidTransitionEventIds.push(entry.data.eventId);
			} else if (run.deliveryState === "pending" || run.deliveryState === "delivering") {
				run.deliveryState = "delivered";
			} else if (run.deliveryState !== "blocked") {
				run.invalidTransitionEventIds.push(entry.data.eventId);
			}
		}
	}
	for (const run of runs.values()) {
		for (const [artifactId, write] of run.writeArtifacts) {
			if (write.status !== "applying") continue;
			write.status = "unknown";
			run.unknownWriteArtifactIds.push(artifactId);
		}
	}
	return { events, runs, invalidEntryIds, duplicateEventIds };
}
