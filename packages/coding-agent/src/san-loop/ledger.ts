import type { SessionEntry } from "../session/session-entries";
import type { SanLoopTransition } from "./orchestrator";
import {
	normalizeSanLoopMode,
	SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
	SAN_LOOP_EVENT_CUSTOM_TYPE,
	SAN_LOOP_REVIEW_CUSTOM_TYPE,
	SAN_LOOP_RUN_CUSTOM_TYPE,
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopEntryRef,
	type SanLoopEvent,
	type SanLoopLedger,
	type SanLoopMode,
	type SanLoopReviewReport,
	type SanLoopRoleContextPacketDebug,
	type SanLoopRunSnapshot,
	type SanLoopStatus,
} from "./types";

interface AppendCustomEntrySessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries?: () => readonly SessionEntry[];
	getSessionId?: () => string;
}

export interface CreateSanLoopRunOptions {
	sessionId: string;
	objective: string;
	mode?: SanLoopMode;
	runId?: string;
	createdAt?: string;
	maxRetries?: number;
	contextPlanRefs?: string[];
	contextPacketRefs?: string[];
	initialRemainingTurns?: number;
}

export interface UpdateSanLoopRunOptions {
	status?: SanLoopStatus;
	updatedAt?: string;
	contextPlanRefs?: string[];
	contextPacketRefs?: string[];
	retryCount?: number;
	finalVerdict?: SanLoopRunSnapshot["finalVerdict"];
	plan?: SanLoopRunSnapshot["plan"];
	assignments?: SanLoopRunSnapshot["assignments"];
	workerResults?: SanLoopRunSnapshot["workerResults"];
	reviewReports?: SanLoopRunSnapshot["reviewReports"];
	decisions?: SanLoopRunSnapshot["decisions"];
	budget?: SanLoopRunSnapshot["budget"];
}

export interface RecordSanLoopRunResult {
	run: SanLoopRunSnapshot;
	runEntryId: string;
	event: SanLoopEvent;
	eventEntryId: string;
}

export interface RecordSanLoopTransitionResult {
	run: SanLoopRunSnapshot;
	runEntryId: string;
	event: SanLoopEvent;
	eventEntryId: string;
}

export interface AbortSanLoopRunResult {
	run: SanLoopRunSnapshot;
	runEntryId: string;
	event: SanLoopEvent;
	eventEntryId: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${Bun.randomUUIDv7()}`;
}

function clampNonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function hasString(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === "string" && value[key].length > 0;
}

function hasArray(value: Record<string, unknown>, key: string): boolean {
	return Array.isArray(value[key]);
}

function isSanLoopMode(value: unknown): value is SanLoopMode {
	return normalizeSanLoopMode(value) !== undefined;
}

function isSanLoopStatus(value: unknown): value is SanLoopStatus {
	return (
		value === "planning" ||
		value === "dispatching" ||
		value === "working" ||
		value === "reviewing" ||
		value === "retrying" ||
		value === "aborting" ||
		value === "blocked" ||
		value === "passed" ||
		value === "failed" ||
		value === "aborted"
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeRunSnapshotMode(run: SanLoopRunSnapshot): SanLoopRunSnapshot {
	const mode = normalizeSanLoopMode(run.mode) ?? "team";
	const record = run as SanLoopRunSnapshot & { contextPlanRefs?: unknown; contextPacketRefs?: unknown };
	const contextPlanRefs = stringArray(record.contextPlanRefs);
	const contextPacketRefs = stringArray(record.contextPacketRefs);
	const revision = Number.isInteger(run.revision) && run.revision >= 0 ? run.revision : 0;
	return { ...run, revision, mode, contextPlanRefs, contextPacketRefs };
}

export function isSanLoopRunSnapshot(value: unknown): value is SanLoopRunSnapshot {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === SAN_LOOP_SCHEMA_VERSION &&
		(value.revision === undefined || (Number.isInteger(value.revision) && (value.revision as number) >= 0)) &&
		hasString(value, "runId") &&
		hasString(value, "sessionId") &&
		hasString(value, "createdAt") &&
		hasString(value, "updatedAt") &&
		hasString(value, "objective") &&
		isSanLoopMode(value.mode) &&
		isSanLoopStatus(value.status) &&
		(hasArray(value, "contextPlanRefs") || hasArray(value, "contextPacketRefs")) &&
		hasArray(value, "assignments") &&
		hasArray(value, "workerResults") &&
		hasArray(value, "reviewReports") &&
		hasArray(value, "decisions") &&
		hasArray(value, "budget") &&
		typeof value.retryCount === "number" &&
		typeof value.maxRetries === "number"
	);
}

export function isSanLoopEvent(value: unknown): value is SanLoopEvent {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === SAN_LOOP_SCHEMA_VERSION &&
		hasString(value, "eventId") &&
		hasString(value, "runId") &&
		hasString(value, "sessionId") &&
		hasString(value, "createdAt") &&
		hasString(value, "type") &&
		hasString(value, "summary") &&
		hasArray(value, "refs")
	);
}

export function isSanLoopReviewReport(value: unknown): value is SanLoopReviewReport {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === SAN_LOOP_SCHEMA_VERSION &&
		hasString(value, "reportId") &&
		hasString(value, "runId") &&
		hasString(value, "createdAt") &&
		hasString(value, "reviewer") &&
		hasString(value, "verdict") &&
		hasArray(value, "defects") &&
		hasArray(value, "testsRun") &&
		hasArray(value, "evidence") &&
		typeof value.retryable === "boolean" &&
		hasArray(value, "requiredNextActions") &&
		hasString(value, "confidence")
	);
}

export function isSanLoopRoleContextPacketDebug(value: unknown): value is SanLoopRoleContextPacketDebug {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === SAN_LOOP_SCHEMA_VERSION &&
		hasString(value, "packetId") &&
		hasString(value, "runId") &&
		hasString(value, "sessionId") &&
		hasString(value, "createdAt") &&
		hasString(value, "role") &&
		hasArray(value, "sourceContextPacketRefs") &&
		hasArray(value, "entryRefs") &&
		typeof value.tokenEstimate === "number" &&
		typeof value.tokenBudget === "number" &&
		typeof value.trimmed === "number"
	);
}

export function createSanLoopRunSnapshot(options: CreateSanLoopRunOptions): SanLoopRunSnapshot {
	const createdAt = options.createdAt ?? nowIso();
	const initialRemainingTurns = clampNonNegativeInteger(options.initialRemainingTurns);
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		revision: 0,
		runId: options.runId ?? newId("loop"),
		sessionId: options.sessionId,
		createdAt,
		updatedAt: createdAt,
		objective: options.objective,
		mode: options.mode ?? "team",
		status: "planning",
		contextPlanRefs: options.contextPlanRefs ? [...options.contextPlanRefs] : [],
		contextPacketRefs: options.contextPacketRefs ? [...options.contextPacketRefs] : [],
		assignments: [],
		workerResults: [],
		reviewReports: [],
		decisions: [],
		budget:
			initialRemainingTurns === undefined
				? []
				: [{ createdAt, state: "planning", remainingTurns: initialRemainingTurns }],
		retryCount: 0,
		maxRetries: options.maxRetries ?? 2,
	};
}

export function updateSanLoopRunSnapshot(
	run: SanLoopRunSnapshot,
	options: UpdateSanLoopRunOptions,
): SanLoopRunSnapshot {
	return {
		...run,
		updatedAt: options.updatedAt ?? nowIso(),
		status: options.status ?? run.status,
		contextPlanRefs: options.contextPlanRefs ? [...options.contextPlanRefs] : [...(run.contextPlanRefs ?? [])],
		contextPacketRefs: options.contextPacketRefs ? [...options.contextPacketRefs] : [...run.contextPacketRefs],
		plan: options.plan ?? run.plan,
		assignments: options.assignments ? [...options.assignments] : [...run.assignments],
		workerResults: options.workerResults ? [...options.workerResults] : [...run.workerResults],
		reviewReports: options.reviewReports ? [...options.reviewReports] : [...run.reviewReports],
		decisions: options.decisions ? [...options.decisions] : [...run.decisions],
		budget: options.budget ? [...options.budget] : [...run.budget],
		retryCount: options.retryCount ?? run.retryCount,
		finalVerdict: options.finalVerdict ?? run.finalVerdict,
	};
}

export function createSanLoopEvent(
	run: SanLoopRunSnapshot,
	type: SanLoopEvent["type"],
	summary: string,
	options: {
		eventId?: string;
		createdAt?: string;
		actor?: SanLoopEvent["actor"];
		refs?: string[];
		data?: Record<string, unknown>;
	} = {},
): SanLoopEvent {
	return {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		eventId: options.eventId ?? newId("loop_evt"),
		runId: run.runId,
		sessionId: run.sessionId,
		createdAt: options.createdAt ?? nowIso(),
		type,
		summary,
		actor: options.actor,
		refs: options.refs ? [...options.refs] : [],
		data: options.data,
	};
}

export function appendSanLoopRunSnapshot(
	sessionManager: AppendCustomEntrySessionManager,
	run: SanLoopRunSnapshot,
): string {
	return sessionManager.appendCustomEntry(SAN_LOOP_RUN_CUSTOM_TYPE, run);
}

export function appendSanLoopEvent(sessionManager: AppendCustomEntrySessionManager, event: SanLoopEvent): string {
	return sessionManager.appendCustomEntry(SAN_LOOP_EVENT_CUSTOM_TYPE, event);
}

export function appendSanLoopReviewReport(
	sessionManager: AppendCustomEntrySessionManager,
	report: SanLoopReviewReport,
): string {
	return sessionManager.appendCustomEntry(SAN_LOOP_REVIEW_CUSTOM_TYPE, report);
}

export function recordSanLoopRunCreated(
	sessionManager: AppendCustomEntrySessionManager,
	options: Omit<CreateSanLoopRunOptions, "sessionId"> & { sessionId?: string },
): RecordSanLoopRunResult {
	const sessionId = options.sessionId ?? sessionManager.getSessionId?.();
	if (!sessionId) throw new Error("Cannot create San loop run without a session id");
	const run = createSanLoopRunSnapshot({ ...options, sessionId });
	const runEntryId = appendSanLoopRunSnapshot(sessionManager, run);
	const event = createSanLoopEvent(run, "run_created", `Started San execution loop: ${run.objective}`, {
		actor: "commander",
		refs: [runEntryId],
	});
	const eventEntryId = appendSanLoopEvent(sessionManager, event);
	return { run, runEntryId, event, eventEntryId };
}

export function recordSanLoopTransition(
	sessionManager: AppendCustomEntrySessionManager,
	transition: SanLoopTransition,
	options: {
		actor?: SanLoopEvent["actor"];
		refs?: string[];
		data?: Record<string, unknown>;
	} = {},
): RecordSanLoopTransitionResult {
	const entries = sessionManager.getEntries?.();
	const latest = entries ? findLatestSanLoopRun(entries, transition.run.runId) : undefined;
	if (latest && latest.data.revision !== transition.run.revision) {
		throw new Error(
			`Cannot record San loop transition ${transition.eventType} for ${transition.run.runId}: expected revision ${transition.run.revision}, current revision is ${latest.data.revision}.`,
		);
	}
	if (latest && isSanLoopTerminalStatus(latest.data.status)) {
		throw new Error(
			`Cannot record San loop transition ${transition.eventType} for ${transition.run.runId}: run is already terminal with status ${latest.data.status}.`,
		);
	}
	const run = { ...transition.run, revision: transition.run.revision + 1 };
	const runEntryId = appendSanLoopRunSnapshot(sessionManager, run);
	const event = createSanLoopEvent(run, transition.eventType, transition.eventSummary, {
		actor: options.actor,
		refs: options.refs ? [runEntryId, ...options.refs] : [runEntryId],
		data: {
			retryExhausted: transition.retryExhausted,
			...options.data,
		},
	});
	const eventEntryId = appendSanLoopEvent(sessionManager, event);
	return { run, runEntryId, event, eventEntryId };
}

export function isSanLoopTerminalStatus(status: SanLoopStatus): boolean {
	return status === "passed" || status === "failed" || status === "blocked" || status === "aborted";
}

export function requestSanLoopAbort(
	sessionManager: AppendCustomEntrySessionManager,
	run: SanLoopRunSnapshot,
	options: { reason?: string; createdAt?: string } = {},
): AbortSanLoopRunResult {
	const aborting = updateSanLoopRunSnapshot(run, {
		status: "aborting",
		updatedAt: options.createdAt,
		finalVerdict: run.finalVerdict,
	});
	const transition: SanLoopTransition = {
		run: aborting,
		eventType: "abort_requested",
		eventSummary: options.reason?.trim() || "Operator requested San execution loop cancellation.",
		retryExhausted: false,
	};
	return recordSanLoopTransition(sessionManager, transition, {
		actor: "commander",
		data: { previousStatus: run.status },
	});
}

export function acknowledgeSanLoopAbort(
	sessionManager: AppendCustomEntrySessionManager,
	run: SanLoopRunSnapshot,
	options: { reason?: string; createdAt?: string } = {},
): AbortSanLoopRunResult {
	if (run.status !== "aborting") {
		throw new Error(`Cannot acknowledge San loop cancellation for ${run.runId}: current status is ${run.status}.`);
	}
	const aborted = updateSanLoopRunSnapshot(run, {
		status: "aborted",
		updatedAt: options.createdAt,
		finalVerdict: run.finalVerdict,
	});
	const transition: SanLoopTransition = {
		run: aborted,
		eventType: "aborted",
		eventSummary: options.reason?.trim() || "Running San agents acknowledged cancellation.",
		retryExhausted: false,
	};
	return recordSanLoopTransition(sessionManager, transition, {
		actor: "commander",
		data: { previousStatus: run.status, cancellationAcknowledged: true },
	});
}

export function abortSanLoopRun(
	sessionManager: AppendCustomEntrySessionManager,
	run: SanLoopRunSnapshot,
	options: { reason?: string; createdAt?: string } = {},
): AbortSanLoopRunResult {
	const entries = sessionManager.getEntries?.();
	const latest = entries ? findLatestSanLoopRun(entries, run.runId) : undefined;
	if (latest && latest.data.revision !== run.revision) {
		throw new Error(
			`Cannot abort San execution loop ${run.runId}: expected revision ${run.revision}, current revision is ${latest.data.revision}.`,
		);
	}
	if (latest && isSanLoopTerminalStatus(latest.data.status)) {
		throw new Error(`Cannot abort San execution loop ${run.runId}: run is already ${latest.data.status}.`);
	}
	const aborted = updateSanLoopRunSnapshot(run, {
		status: "aborted",
		updatedAt: options.createdAt,
		finalVerdict: run.finalVerdict,
	});
	const persisted = { ...aborted, revision: run.revision + 1 };
	const runEntryId = appendSanLoopRunSnapshot(sessionManager, persisted);
	const reason = options.reason?.trim() || "Operator stopped the San execution loop.";
	const event = createSanLoopEvent(persisted, "aborted", reason, {
		createdAt: options.createdAt,
		actor: "commander",
		refs: [runEntryId],
		data: { previousStatus: run.status },
	});
	const eventEntryId = appendSanLoopEvent(sessionManager, event);
	return { run: persisted, runEntryId, event, eventEntryId };
}

export function recoverSanLoopRun(
	sessionManager: AppendCustomEntrySessionManager,
	run: SanLoopRunSnapshot,
	options: { reason?: string; createdAt?: string } = {},
): RecordSanLoopRunResult {
	const entries = sessionManager.getEntries?.();
	const latest = entries ? findLatestSanLoopRun(entries, run.runId) : undefined;
	if (latest && latest.data.revision !== run.revision) {
		throw new Error(
			`Cannot recover San execution loop ${run.runId}: expected revision ${run.revision}, current revision is ${latest.data.revision}.`,
		);
	}
	if (latest && isSanLoopTerminalStatus(latest.data.status)) {
		throw new Error(`Cannot recover San execution loop ${run.runId}: run is already ${latest.data.status}.`);
	}
	const recovered = updateSanLoopRunSnapshot(run, {
		status: "blocked",
		updatedAt: options.createdAt,
		finalVerdict: run.finalVerdict,
	});
	const persisted = { ...recovered, revision: run.revision + 1 };
	const runEntryId = appendSanLoopRunSnapshot(sessionManager, persisted);
	const reason =
		options.reason?.trim() ||
		"Recovered active San execution loop from persisted session without a running child process.";
	const event = createSanLoopEvent(persisted, "recovered", reason, {
		createdAt: options.createdAt,
		actor: "commander",
		refs: [runEntryId],
		data: { previousStatus: run.status },
	});
	const eventEntryId = appendSanLoopEvent(sessionManager, event);
	return { run: persisted, runEntryId, event, eventEntryId };
}

function customEntryRef<T>(entry: SessionEntry, data: T): SanLoopEntryRef<T> {
	return { entryId: entry.id, timestamp: entry.timestamp, data };
}

export function rebuildSanLoopLedger(entries: readonly SessionEntry[]): SanLoopLedger {
	const latestRuns = new Map<string, SanLoopEntryRef<SanLoopRunSnapshot>>();
	const events: SanLoopEntryRef<SanLoopEvent>[] = [];
	const reviews: SanLoopEntryRef<SanLoopReviewReport>[] = [];
	const rolePackets: SanLoopEntryRef<SanLoopRoleContextPacketDebug>[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		switch (entry.customType) {
			case SAN_LOOP_RUN_CUSTOM_TYPE:
				if (isSanLoopRunSnapshot(entry.data)) {
					const run = normalizeRunSnapshotMode(entry.data);
					latestRuns.set(run.runId, customEntryRef(entry, run));
				}
				break;
			case SAN_LOOP_EVENT_CUSTOM_TYPE:
				if (isSanLoopEvent(entry.data)) events.push(customEntryRef(entry, entry.data));
				break;
			case SAN_LOOP_REVIEW_CUSTOM_TYPE:
				if (isSanLoopReviewReport(entry.data)) reviews.push(customEntryRef(entry, entry.data));
				break;
			case SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE:
				if (isSanLoopRoleContextPacketDebug(entry.data)) rolePackets.push(customEntryRef(entry, entry.data));
				break;
		}
	}

	const runs = [...latestRuns.values()].sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt));
	return {
		runs,
		events,
		reviews,
		rolePackets,
		latestRun: runs.at(-1),
	};
}

export function findLatestSanLoopRun(
	entries: readonly SessionEntry[],
	runId?: string,
): SanLoopEntryRef<SanLoopRunSnapshot> | undefined {
	const ledger = rebuildSanLoopLedger(entries);
	if (runId) return ledger.runs.find(run => run.data.runId === runId);
	return ledger.latestRun;
}
