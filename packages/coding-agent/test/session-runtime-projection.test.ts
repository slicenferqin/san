/**
 * Resume runtime projection: the compact branch a resumed session rehydrates from must rebuild the
 * SAME runtime state as the full branch. These tests compare observable state — session context
 * settings/authority/todo/pending calls, and materialized execution-scope ledgers plus the
 * task/provider/scope registries — never internal list counts.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@san/agent";
import { CONTEXT_CONTINUATION_MESSAGE_TYPE } from "@san/coding-agent/context-steady/types";
import { createExecutionRuntime } from "@san/coding-agent/execution-control/execution-runtime";
import {
	readExecutionScopeJournal,
	rebuildExecutionScopeLedger,
	serializeExecutionScopeRecord,
	serializeExecutionScopeSnapshot,
} from "@san/coding-agent/execution-control/persistence";
import type { ProviderHealthSnapshot } from "@san/coding-agent/execution-control/provider-health";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import { TASK_CONTRACT_SCHEMA_VERSION, TaskContractRegistry } from "@san/coding-agent/execution-control/task-contract";
import {
	EXECUTION_SCOPE_CUSTOM_TYPE,
	type ExecutionLedgerRecord,
	type ExecutionScopeSnapshot,
} from "@san/coding-agent/execution-control/types";
import type { WatchdogDecision, WatchdogInput } from "@san/coding-agent/execution-control/watchdog";
import { collectPendingToolCalls } from "@san/coding-agent/session/exit-diagnostics";
import { buildSessionContextFromBranch } from "@san/coding-agent/session/session-context";
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "@san/coding-agent/session/session-entries";
import { selectResumeRuntimeEntries } from "@san/coding-agent/session/session-runtime-projection";

let sequence = 0;
function nextId(prefix: string): string {
	return `${prefix}-${++sequence}`;
}

function custom(customType: string, data?: unknown): CustomEntry {
	const id = nextId("custom");
	return { type: "custom", id, parentId: null, timestamp: `2026-01-01T00:00:${sequence % 60}Z`, customType, data };
}

function message(role: AgentMessage["role"], extra: Record<string, unknown> = {}): SessionMessageEntry {
	const id = nextId("message");
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: `2026-01-01T00:01:${sequence % 60}Z`,
		message: { role, content: `${role} ${id}`, timestamp: Date.now(), ...extra } as unknown as AgentMessage,
	};
}

/** Chain entries the way a journal does, so `parentId` walks stay meaningful. */
function chain(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({
		...entry,
		parentId: index === 0 ? null : (entries[index - 1]?.id ?? null),
	})) as SessionEntry[];
}

// ---------------------------------------------------------------------------
// Execution-scope journal fixtures
// ---------------------------------------------------------------------------

const CONTRACT = {
	source: "authoritative_user" as const,
	authoritativeUserTurnId: "turn-1",
	ref: { contractId: "contract-1", revision: 1, contractHash: "hash-1", clauseRefs: ["clause-1"] },
};

function scopeEvent(_scopeId: string, record: ExecutionLedgerRecord): CustomEntry {
	return custom(EXECUTION_SCOPE_CUSTOM_TYPE, serializeExecutionScopeRecord(record));
}

type LedgerFactory = (snapshot: ExecutionScopeSnapshot) => CustomEntry;

const snapshotEntry: LedgerFactory = snapshot =>
	custom(EXECUTION_SCOPE_CUSTOM_TYPE, serializeExecutionScopeSnapshot(snapshot));

function baseSnapshot(scopeId: string, revision: number): ExecutionScopeSnapshot {
	return {
		schemaVersion: 1,
		scopeId,
		rootSessionId: "root-1",
		logicalTurnId: "turn-1",
		revision,
		state: "running",
		objectiveContract: CONTRACT,
		gates: [],
		evidenceRefs: [],
		assignments: [],
		taskContracts: [],
		strategies: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: 0,
			durationMs: 0,
			providerRequests: 0,
			assignmentCount: 0,
		},
		providerHealth: [],
		supervisorDecisions: [],
		requests: [],
		progress: [],
		recordIds: [],
		updatedAt: "2026-01-01T00:00:00Z",
	} as unknown as ExecutionScopeSnapshot;
}

function startedRecord(scopeId: string, recordId = `start:${scopeId}`, revision = 1): ExecutionLedgerRecord {
	return {
		recordId,
		type: "scope_started",
		scopeId,
		rootSessionId: "root-1",
		logicalTurnId: "turn-1",
		revision,
		objectiveContract: CONTRACT,
		occurredAt: "2026-01-01T00:00:00Z",
	} as unknown as ExecutionLedgerRecord;
}

function stateRecord(scopeId: string, recordId: string, state: string, revision = 2): ExecutionLedgerRecord {
	return {
		recordId,
		type: "state_changed",
		scopeId,
		rootSessionId: "root-1",
		logicalTurnId: "turn-1",
		revision,
		state,
		occurredAt: "2026-01-01T00:00:01Z",
	} as unknown as ExecutionLedgerRecord;
}
function taskContractRecord(scopeId: string, workKey: string, recordId: string, revision = 3): ExecutionLedgerRecord {
	return {
		recordId,
		type: "task_contract_recorded",
		scopeId,
		rootSessionId: "root-1",
		logicalTurnId: "turn-1",
		revision,
		contract: {
			contractId: `contract-${recordId}`,
			scopeId,
			workKey,
			strategyKey: "strategy",
			taskId: `task-${recordId}`,
			schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
			status: "queued",
			heartbeatAt: 0,
			cursor: 1,
			revision: 1,
			createdAt: 0,
			updatedAt: 0,
		},
		occurredAt: "2026-01-01T00:00:02Z",
	} as unknown as ExecutionLedgerRecord;
}

function progressRecord(scopeId: string, recordId: string, revision = 5): ExecutionLedgerRecord {
	return {
		recordId,
		type: "progress_observed",
		scopeId,
		rootSessionId: "root-1",
		logicalTurnId: "turn-1",
		revision,
		observation: {
			observationId: `obs-${recordId}`,
			progressClass: "progress",
			fingerprint: "fp-1",
			revision: 1,
		},
		occurredAt: "2026-01-01T00:00:03Z",
	} as unknown as ExecutionLedgerRecord;
}

/** Something the parsers must reject: a snapshot whose coveredRevision disagrees with its revision. */
function corruptSnapshotEntry(scopeId: string): CustomEntry {
	const record = serializeExecutionScopeSnapshot(baseSnapshot(scopeId, 4));
	return custom(EXECUTION_SCOPE_CUSTOM_TYPE, { ...record, coveredRevision: 99 });
}

function ledgerFingerprint(entries: readonly SessionEntry[], scopeId: string): string {
	const ledger = rebuildExecutionScopeLedger(entries, { scopeId });
	return JSON.stringify(ledger ? ledger.getSnapshot() : null);
}

function registryFingerprint(entries: readonly SessionEntry[], scopeId: string): string {
	const runtime = createExecutionRuntime({
		rootSessionId: "root-1",
		branchEntries: entries,
		sessionManager: { appendCustomEntry: () => nextId("appended") },
		taskRegistry: new TaskContractRegistry({ rootSessionId: "root-1" }),
		providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
		now: () => "2026-01-01T00:00:00Z",
	});
	try {
		const scope = runtime.getScope(scopeId);
		return JSON.stringify({
			active: runtime.activeScopeId() ?? null,
			snapshot: scope ? scope.snapshot() : null,
			contracts: runtime.taskRegistry.list(scopeId),
		});
	} finally {
		runtime.dispose();
	}
}

describe("selectResumeRuntimeEntries: execution-scope journal", () => {
	it("keeps whole scopes without a covering snapshot", () => {
		const entries = chain([
			scopeEvent("scope-a", startedRecord("scope-a")),
			scopeEvent("scope-a", stateRecord("scope-a", "state-a", "running")),
			scopeEvent("scope-a", taskContractRecord("scope-a", "work-a", "task-a")),
		]);
		expect(selectResumeRuntimeEntries(entries)).toEqual(entries);
	});

	it("preserves the materialized ledger for a single covered scope", () => {
		const scopeId = "scope-a";
		const full = chain([
			scopeEvent(scopeId, startedRecord(scopeId)),
			scopeEvent(scopeId, stateRecord(scopeId, "state-1", "running")),
			scopeEvent(scopeId, taskContractRecord(scopeId, "work-a", "task-1")),
			snapshotEntry(baseSnapshot(scopeId, 4)),
			scopeEvent(scopeId, progressRecord(scopeId, "progress-1")),
		]);
		const projected = selectResumeRuntimeEntries(full);
		expect(projected.length).toBeLessThan(full.length);
		expect(ledgerFingerprint(projected, scopeId)).toBe(ledgerFingerprint(full, scopeId));
		expect(registryFingerprint(projected, scopeId)).toBe(registryFingerprint(full, scopeId));
	});

	it("keeps the newest snapshot per scope and drops older/duplicate ones", () => {
		const scopeId = "scope-a";
		const full = chain([
			scopeEvent(scopeId, startedRecord(scopeId)),
			snapshotEntry(baseSnapshot(scopeId, 2)),
			scopeEvent(scopeId, stateRecord(scopeId, "state-1", "running")),
			snapshotEntry(baseSnapshot(scopeId, 6)),
			snapshotEntry(baseSnapshot(scopeId, 6)),
			scopeEvent(scopeId, progressRecord(scopeId, "progress-1", 7)),
			snapshotEntry(baseSnapshot(scopeId, 3)),
		]);
		const projected = selectResumeRuntimeEntries(full);
		const projectedJournal = readExecutionScopeJournal(projected).filter(
			record => record.journalType === "snapshot" && record.snapshot.scopeId === scopeId,
		);
		expect(projectedJournal).toHaveLength(1);
		expect((projectedJournal[0] as { coveredRevision: number }).coveredRevision).toBe(6);
		expect(ledgerFingerprint(projected, scopeId)).toBe(ledgerFingerprint(full, scopeId));
		expect(registryFingerprint(projected, scopeId)).toBe(registryFingerprint(full, scopeId));
	});

	it("keeps events after coveredRevision and independent scopes intact", () => {
		const coveredScope = "scope-a";
		const untouchedScope = "scope-b";
		const full = chain([
			scopeEvent(coveredScope, startedRecord(coveredScope)),
			scopeEvent(coveredScope, stateRecord(coveredScope, "state-1", "running")),
			snapshotEntry(baseSnapshot(coveredScope, 2)),
			scopeEvent(coveredScope, progressRecord(coveredScope, "progress-after", 3)),
			scopeEvent(untouchedScope, startedRecord(untouchedScope)),
			scopeEvent(untouchedScope, taskContractRecord(untouchedScope, "work-b", "task-b", 2)),
		]);
		const projected = selectResumeRuntimeEntries(full);
		const keptRecordIds = readExecutionScopeJournal(projected)
			.filter(record => record.journalType === "event")
			.map(record => (record as { record: { recordId: string } }).record.recordId);
		expect(keptRecordIds).toContain("progress-after");
		expect(keptRecordIds).not.toContain("state-1");
		expect(keptRecordIds).toContain("task-b");
		for (const scopeId of [coveredScope, untouchedScope]) {
			expect(ledgerFingerprint(projected, scopeId)).toBe(ledgerFingerprint(full, scopeId));
			expect(registryFingerprint(projected, scopeId)).toBe(registryFingerprint(full, scopeId));
		}
	});

	it("keeps unparsable records exactly where the parser sees them", () => {
		const scopeId = "scope-a";
		const corrupt = corruptSnapshotEntry(scopeId);
		const full = chain([
			scopeEvent(scopeId, startedRecord(scopeId)),
			scopeEvent(scopeId, stateRecord(scopeId, "state-1", "running")),
			snapshotEntry(baseSnapshot(scopeId, 2)),
			corrupt,
		]);
		const projected = selectResumeRuntimeEntries(full);
		// The corrupt snapshot never reached the reducer, so the projection must not
		// treat its entry id as removable — but the valid snapshot still covers state-1.
		expect(projected.some(entry => entry.id === corrupt.id)).toBe(true);
		expect(ledgerFingerprint(projected, scopeId)).toBe(ledgerFingerprint(full, scopeId));
	});

	it("preserves a late snapshot's active-scope resolution", () => {
		const full = chain([snapshotEntry(baseSnapshot("scope-a", 2)), snapshotEntry(baseSnapshot("scope-b", 1))]);
		const projected = selectResumeRuntimeEntries(full);
		expect(registryFingerprint(projected, "scope-b").startsWith('{"active":"scope-b"')).toBe(true);
		expect(registryFingerprint(projected, "scope-b")).toBe(registryFingerprint(full, "scope-b"));
	});
});

// ---------------------------------------------------------------------------
// Branch boundary: compaction and context checkpoint
// ---------------------------------------------------------------------------

function compactionEntry(firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id: nextId("compaction"),
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 1000,
	} as SessionEntry;
}

function checkpointEntry(coveredIds: readonly string[]): CustomEntry {
	return custom("san.context_checkpoint", {
		schemaVersion: 2,
		checkpointId: "checkpoint-1",
		entryRefs: [...coveredIds],
		coveredSourceEntryRefs: [...coveredIds],
	});
}

function assistantWithCalls(callIds: readonly string[]): SessionMessageEntry {
	return message("assistant", {
		content: callIds.map(id => ({ type: "toolCall", id, name: "read", arguments: {} })),
	}) as SessionMessageEntry;
}

function toolResult(toolCallId: string): SessionMessageEntry {
	return message("toolResult", { toolCallId }) as SessionMessageEntry;
}

describe("selectResumeRuntimeEntries: branch boundary", () => {
	it("drops archived history but keeps the latest user turn and pending markers", () => {
		const archivedUser = message("user");
		const archivedAssistant = assistantWithCalls(["call-done"]);
		const archivedResult = toolResult("call-done");
		const latestUser = message("user");
		const pendingMarker = custom("tool_execution_start", {
			toolCallId: "call-pending",
			toolName: "read",
			startedAt: "2026-01-01T00:02:00Z",
		});
		const tailUser = message("user");
		const full = chain([archivedUser, archivedAssistant, archivedResult, latestUser, pendingMarker, tailUser]);
		const withCompaction = chain([...full.slice(0, 3), compactionEntry(latestUser.id), ...full.slice(3)]);
		const projected = selectResumeRuntimeEntries(withCompaction);

		const projectedIds = new Set(projected.map(entry => entry.id));
		expect(projectedIds.has(archivedAssistant.id)).toBe(false);
		expect(projectedIds.has(archivedResult.id)).toBe(false);
		expect(projectedIds.has(latestUser.id)).toBe(true);
		expect(projectedIds.has(pendingMarker.id)).toBe(true);

		expect(collectPendingToolCalls(projected).map(call => call.toolCallId)).toEqual(
			collectPendingToolCalls(withCompaction).map(call => call.toolCallId),
		);
		expect(buildSessionContextFromBranch(projected).messages).toEqual(
			buildSessionContextFromBranch(withCompaction).messages,
		);
	});

	it("does not resurrect a completed call when the latest assistant keeps one pending call", () => {
		const archivedAssistant = assistantWithCalls(["call-completed"]);
		const completedResult = toolResult("call-completed");
		const latestUser = message("user");
		const latestAssistant = assistantWithCalls(["call-pending"]);
		const pendingMarker = custom("tool_execution_start", {
			toolCallId: "call-pending",
			toolName: "read",
			startedAt: "2026-01-01T00:03:00Z",
		});
		const full = chain([archivedAssistant, completedResult, latestUser, latestAssistant, pendingMarker]);
		const withCompaction = chain([compactionEntry(archivedAssistant.id), ...full.slice(0)]);
		const projected = selectResumeRuntimeEntries(withCompaction);

		const pending = collectPendingToolCalls(projected);
		expect(pending.map(call => call.toolCallId)).toEqual(["call-pending"]);
		expect(pending.map(call => call.toolCallId)).toEqual(
			collectPendingToolCalls(withCompaction).map(call => call.toolCallId),
		);
	});

	it("keeps the latest continuation authority and its source turn after compaction", () => {
		const sourceUser = message("user");
		const authority = {
			type: "custom_message",
			id: nextId("authority"),
			parentId: null,
			timestamp: "2026-01-01T00:00:05Z",
			customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
			content: "authoritative task",
		} as unknown as SessionEntry;
		const latestUser = message("user");
		const full = chain([sourceUser, authority, latestUser]);
		const withCompaction = chain([compactionEntry(sourceUser.id), ...full.slice(0)]);

		const fullContext = buildSessionContextFromBranch(withCompaction);
		const projectedContext = buildSessionContextFromBranch(selectResumeRuntimeEntries(withCompaction));
		expect(projectedContext.messages).toEqual(fullContext.messages);
		expect(projectedContext.thinkingLevel).toBe(fullContext.thinkingLevel);
	});

	it("uses checkpoint coverage when no compaction exists and leaves short branches alone", () => {
		const first = message("user");
		const second = message("assistant");
		const third = message("user");
		const short = chain([first, second]);
		expect(selectResumeRuntimeEntries(short)).toEqual(short);
		expect(selectResumeRuntimeEntries([])).toEqual([]);

		const checkpointed = chain([first, second, third, checkpointEntry([first.id, second.id])]);
		const projected = selectResumeRuntimeEntries(checkpointed);
		expect(projected.map(entry => entry.id)).toContain(third.id);
		expect(projected.map(entry => entry.id)).toContain(checkpointed[3]!.id);
		expect(buildSessionContextFromBranch(projected).messages).toEqual(
			buildSessionContextFromBranch(checkpointed).messages,
		);
	});

	it("preserves unrelated custom streams, order, and original parents", () => {
		const settingsEntries = chain([
			{
				type: "thinking_level_change",
				id: nextId("thinking"),
				parentId: null,
				timestamp: "t",
				thinkingLevel: "high",
			},
			{ type: "model_change", id: nextId("model"), parentId: null, timestamp: "t", model: "m", role: "default" },
			{ type: "mode_change", id: nextId("mode"), parentId: null, timestamp: "t", mode: "plan" },
			custom("san.work_note", { note: "keep me" }),
			custom("san.brain.plan", { plan: "keep me" }),
		]);
		const first = message("user");
		const tail = message("assistant");
		const withCompaction = chain([...settingsEntries, compactionEntry(first.id), first, tail]);
		const projected = selectResumeRuntimeEntries(withCompaction);

		const projectedById = new Map(projected.map(entry => [entry.id, entry]));
		for (const entry of settingsEntries) {
			expect(projectedById.get(entry.id)).toEqual(entry);
		}
		expect(projected.map(entry => entry.id)).toEqual(
			withCompaction.map(entry => entry.id).filter(id => projectedById.has(id)),
		);
		for (let index = 1; index < projected.length; index++) {
			expect(projected[index]!.parentId).toBe(projected[index - 1]!.id);
		}
	});
});

// ---------------------------------------------------------------------------
// Materialized runtime equivalence for a mixed branch
// ---------------------------------------------------------------------------

describe("selectResumeRuntimeEntries: runtime equivalence", () => {
	it("rebuilds identical pending state through the real execution runtime", () => {
		const runtimeDecisions: WatchdogDecision[] = [];
		const scopeId = "scope:root-1:turn-1";
		const full = chain([
			scopeEvent(scopeId, startedRecord(scopeId)),
			scopeEvent(scopeId, stateRecord(scopeId, "state-1", "running")),
			scopeEvent(scopeId, taskContractRecord(scopeId, "work-a", "task-1")),
			snapshotEntry(baseSnapshot(scopeId, 3)),
			scopeEvent(scopeId, progressRecord(scopeId, "progress-1", 4)),
		]);
		const projected = selectResumeRuntimeEntries(full);

		const inspect = (entries: readonly SessionEntry[]) => {
			const runtime = createExecutionRuntime({
				rootSessionId: "root-1",
				branchEntries: entries,
				sessionManager: { appendCustomEntry: () => nextId("appended") },
				taskRegistry: new TaskContractRegistry({ rootSessionId: "root-1", now: () => 0 }),
				providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
				now: () => "2026-01-01T00:00:00Z",
				nowMs: () => 0,
			});
			try {
				const scope = runtime.getScope(scopeId);
				const decision = runtime.schedulerFor(scopeId).watchdog.enforce({
					kind: "repeated_failure",
					attempts: 1,
				} as unknown as WatchdogInput);
				runtimeDecisions.push(decision);
				return JSON.stringify({
					active: runtime.activeScopeId() ?? null,
					handle: scope?.snapshot() ?? null,
					ledger: scope?.ledger.getSnapshot() ?? null,
				});
			} finally {
				runtime.dispose();
			}
		};

		expect(inspect(projected)).toBe(inspect(full));
		expect(runtimeDecisions[0]).toEqual(runtimeDecisions[1]);
	});

	it("matches provider registry state after a projected branch sync", () => {
		const health = {
			providerKey: "provider",
			normalizedUrl: "https://example.test",
			modelKey: "model",
			state: "ready",
			failures: 0,
			updatedAt: 0,
		} as unknown as ProviderHealthSnapshot;
		const snapshot = { ...baseSnapshot("scope-a", 2), providerHealth: [health] } as ExecutionScopeSnapshot;
		const full = chain([snapshotEntry(snapshot)]);
		const projected = selectResumeRuntimeEntries(full);

		const inspect = (entries: readonly SessionEntry[]) => {
			const registry = new ProviderHealthRegistry({ now: () => 0 });
			const runtime = createExecutionRuntime({
				rootSessionId: "root-1",
				branchEntries: entries,
				sessionManager: { appendCustomEntry: () => nextId("appended") },
				taskRegistry: new TaskContractRegistry({ rootSessionId: "root-1" }),
				providerRegistry: registry,
				now: () => "2026-01-01T00:00:00Z",
			});
			try {
				return JSON.stringify(registry.all());
			} finally {
				runtime.dispose();
			}
		};

		expect(inspect(projected)).toBe(inspect(full));
	});
});
