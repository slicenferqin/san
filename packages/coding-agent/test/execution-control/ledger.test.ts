import { describe, expect, test } from "bun:test";
import type {
	AcceptanceGate,
	AcceptanceVerifier,
	EvidenceRef,
	ImmutableObjectiveContract,
	SupervisorExternalBlocker,
	TaskContractSnapshot,
} from "../../src/execution-control";
import {
	compactExecutionScopeJournal,
	ExecutionLedger,
	ExecutionScopePersistence,
	ExecutionScopeRegistry,
	isTerminalExecutionState,
	parseExecutionScopeJournalRecord,
	readExecutionScopeJournal,
	rebuildExecutionScopeLedger,
	StaleExecutionRevisionError,
	TASK_CONTRACT_SCHEMA_VERSION,
	TerminalExecutionStateError,
} from "../../src/execution-control";
import type { CustomEntry, SessionEntry } from "../../src/session/session-entries";

const NOW = "2026-08-05T00:00:00.000Z";

function contract(revision = 1): ImmutableObjectiveContract {
	return {
		ref: {
			contractId: "contract-root",
			revision,
			contractHash: `sha256-contract-${revision}`,
			clauseRefs: ["clause:deliver"],
		},
		authoritativeUserTurnId: "turn-1",
		source: "authoritative_user",
	};
}

function makeLedger(): ExecutionLedger {
	return new ExecutionLedger({
		scopeId: "scope:session-1:turn-1",
		rootSessionId: "session-1",
		logicalTurnId: "turn-1",
		objectiveContract: contract(),
		now: () => NOW,
	});
}

function gate(
	status: AcceptanceGate["status"] = "unknown",
	verifier: AcceptanceVerifier = { kind: "command", checkId: "check:focused-tests", expectedExitCode: 0 },
	gateId = "gate:deliver",
	evidenceRefs: readonly EvidenceRef[] = [],
): AcceptanceGate {
	return {
		gateId,
		contractRef: contract().ref,
		contractRevision: 1,
		objectiveClauseRefs: ["clause:deliver"],
		verifier,
		status,
		evidenceRefs,
	};
}

function evidence(gateId = "gate:deliver", contractRevision = 1): EvidenceRef {
	return {
		evidenceId: `evidence:${gateId}:${contractRevision}`,
		kind: "command",
		receiptRef: "host-receipt-1",
		gateId,
		contractRevision,
	};
}

function taskContract(contractId = "contract:task-1"): TaskContractSnapshot {
	return {
		contractId,
		scopeId: "scope:session-1:turn-1",
		workKey: "work:task-1",
		strategyKey: "strategy:task-1",
		taskId: "task-1",
		schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
		status: "running",
		heartbeatAt: 1_783_000_000_000,
		cursor: 0,
		revision: 1,
		createdAt: 1_782_000_000_000,
		updatedAt: 1_783_000_000_000,
		jobId: "job-1",
	};
}

class MemorySession {
	readonly entries: SessionEntry[] = [];
	#nextId = 0;

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.#nextId++}`;
		const entry: CustomEntry = {
			type: "custom",
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: NOW,
			customType,
			data,
		};
		this.entries.push(entry);
		return id;
	}

	getEntries(): readonly SessionEntry[] {
		return [...this.entries];
	}
}

describe("ExecutionLedger", () => {
	test("assigns monotonic revisions and enforces CAS", () => {
		const ledger = makeLedger();
		const first = ledger.append({
			recordId: "evt-1",
			type: "progress_observed",
			observation: {
				observationId: "obs-1",
				progressClass: "activity",
				fingerprint: "fp-1",
				revision: 0,
			},
		});
		const second = ledger.append(
			{ recordId: "evt-2", type: "usage_recorded", delta: { inputTokens: 3 } },
			{ expectedRevision: 1 },
		);

		expect(first.revision).toBe(1);
		expect(second.revision).toBe(2);
		expect(ledger.revision).toBe(2);
		expect(() =>
			ledger.append({ recordId: "evt-stale", type: "state_changed", state: "diagnosing" }, { expectedRevision: 0 }),
		).toThrow(StaleExecutionRevisionError);
	});

	test("notifies append subscribers and supports unsubscribe", () => {
		const ledger = makeLedger();
		const revisions: number[] = [];
		const unsubscribe = ledger.subscribe(record => revisions.push(record.revision));
		ledger.append({ recordId: "evt-subscribed", type: "usage_recorded", delta: { providerRequests: 1 } });
		unsubscribe();
		ledger.append({ recordId: "evt-unsubscribed", type: "usage_recorded", delta: { providerRequests: 1 } });

		expect(revisions).toEqual([1]);
	});

	test("surfaces subscriber failures after the append remains authoritative", () => {
		const failures: Array<{ error: unknown; recordId: string; revision: number }> = [];
		const ledger = new ExecutionLedger({
			scopeId: "scope:session-1:turn-1",
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
			now: () => NOW,
			onSubscriberError: (error, record, snapshot) =>
				failures.push({ error, recordId: record.recordId, revision: snapshot.revision }),
		});
		ledger.subscribe(() => {
			throw new Error("subscriber failed");
		});

		ledger.append({ recordId: "evt-subscriber-failure", type: "usage_recorded", delta: { providerRequests: 1 } });

		expect(ledger.revision).toBe(1);
		expect(ledger.snapshot().usage.providerRequests).toBe(1);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.recordId).toBe("evt-subscriber-failure");
		expect(failures[0]?.revision).toBe(1);
		expect(failures[0]?.error).toBeInstanceOf(Error);
	});

	test("replays a record identity idempotently without advancing revision", () => {
		const ledger = makeLedger();
		const result = ledger.append({ recordId: "evt-idempotent", type: "usage_recorded", delta: { outputTokens: 4 } });
		const duplicate = ledger.append(
			{ recordId: "evt-idempotent", type: "usage_recorded", delta: { outputTokens: 4 } },
			{ expectedRevision: 0 },
		);
		const persistedDuplicate = ledger.appendPersisted(result.record);

		expect(duplicate.duplicate).toBe(true);
		expect(persistedDuplicate.duplicate).toBe(true);
		expect(ledger.revision).toBe(1);
		expect(ledger.snapshot().usage.outputTokens).toBe(4);
	});

	test("allows completion when required gates pass while optional gates remain", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-optional-gate",
			type: "acceptance_gate_recorded",
			gate: { ...gate("unknown", undefined, "gate:optional"), required: false },
		});
		ledger.append({
			recordId: "evt-record-evidence",
			type: "evidence_recorded",
			evidence: evidence(),
		});
		ledger.append({
			recordId: "evt-required-gate",
			type: "acceptance_gate_recorded",
			gate: gate("pass", undefined, undefined, [evidence()]),
		});

		ledger.append({ recordId: "evt-optional-complete", type: "state_changed", state: "completed" });
		expect(ledger.state).toBe("completed");
	});

	test("rejects same-revision assignment, strategy, and provider fact rewrites", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-assignment-original",
			type: "assignment_recorded",
			assignment: {
				assignmentId: "assignment:one",
				scopeId: ledger.scopeId,
				workKey: "work:one",
				strategyKey: "strategy:one",
				strategyRevision: 1,
				objectiveClauseRefs: ["clause:deliver"],
				status: "pending",
			},
		});
		expect(() =>
			ledger.append({
				recordId: "evt-assignment-rewritten",
				type: "assignment_recorded",
				assignment: {
					assignmentId: "assignment:one",
					scopeId: ledger.scopeId,
					workKey: "work:changed",
					strategyKey: "strategy:one",
					strategyRevision: 1,
					objectiveClauseRefs: ["clause:deliver"],
					status: "running",
				},
			}),
		).toThrow("identity cannot change");

		ledger.append({
			recordId: "evt-strategy-original",
			type: "strategy_recorded",
			strategy: {
				strategyId: "strategy:one",
				scopeId: ledger.scopeId,
				strategyKey: "strategy:one",
				revision: 1,
				hypothesisRef: "hypothesis:one",
				expectedEvidenceRefs: ["evidence:one"],
				status: "proposed",
			},
		});
		expect(() =>
			ledger.append({
				recordId: "evt-strategy-rewritten",
				type: "strategy_recorded",
				strategy: {
					strategyId: "strategy:one",
					scopeId: ledger.scopeId,
					strategyKey: "strategy:one",
					revision: 1,
					hypothesisRef: "hypothesis:changed",
					expectedEvidenceRefs: ["evidence:one"],
					status: "active",
				},
			}),
		).toThrow("identity cannot change");

		ledger.append({
			recordId: "evt-health-original",
			type: "provider_health_recorded",
			health: {
				providerKey: "provider:one",
				endpoint: "https://provider.test",
				normalizedUrl: "https://provider.test",
				state: "open",
				healthRevision: 1,
				generation: 1,
			},
		});
		expect(() =>
			ledger.append({
				recordId: "evt-health-rewritten",
				type: "provider_health_recorded",
				health: {
					providerKey: "provider:one",
					endpoint: "https://provider.test",
					normalizedUrl: "https://provider.test",
					state: "closed",
					healthRevision: 1,
					generation: 1,
				},
			}),
		).toThrow("cannot change");
	});

	test("keeps immutable snapshots and usage telemetry cannot terminate a scope", () => {
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-usage", type: "usage_recorded", delta: { totalTokens: 100, cost: 2.5 } });
		const snapshot = ledger.snapshot();
		ledger.append({ recordId: "evt-record-evidence", type: "evidence_recorded", evidence: evidence() });
		ledger.append({
			recordId: "evt-pass-gate",
			type: "acceptance_gate_recorded",
			gate: gate("pass", undefined, undefined, [evidence()]),
		});
		ledger.append({ recordId: "evt-complete", type: "state_changed", state: "completed" });
		ledger.append({ recordId: "evt-after-terminal-usage", type: "usage_recorded", delta: { totalTokens: 5 } });

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.usage)).toBe(true);
		expect(snapshot.state).toBe("running");
		expect(ledger.state).toBe("completed");
		expect(ledger.snapshot().usage.totalTokens).toBe(105);
	});

	test("retains scope state while recording an interrupted request start", () => {
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-diagnosing", type: "state_changed", state: "diagnosing" });
		ledger.append({
			recordId: "evt-request-restarted",
			type: "request_started",
			requestId: "request-1",
			interrupted: true,
		});

		expect(ledger.state).toBe("diagnosing");
		expect(ledger.snapshot().requests).toEqual([
			{ requestId: "request-1", status: "started", startedAt: NOW, interrupted: true },
		]);
	});

	test("does not reverse a terminal state", () => {
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-record-evidence", type: "evidence_recorded", evidence: evidence() });
		ledger.append({
			recordId: "evt-pass-gate",
			type: "acceptance_gate_recorded",
			gate: gate("pass", undefined, undefined, [evidence()]),
		});
		ledger.append({ recordId: "evt-complete", type: "state_changed", state: "completed" });

		expect(() => ledger.append({ recordId: "evt-recover", type: "state_changed", state: "recovering" })).toThrow(
			TerminalExecutionStateError,
		);
		expect(ledger.state).toBe("completed");
	});

	test("requires an explicit passing gate for completion", () => {
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-blocked-gate", type: "acceptance_gate_recorded", gate: gate("blocked") });

		expect(() =>
			ledger.append({ recordId: "evt-invalid-complete", type: "state_changed", state: "completed" }),
		).toThrow(/acceptance gate is not passed/);
		expect(ledger.state).toBe("running");
	});
	test("rejects completion without a required acceptance gate", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-optional-only",
			type: "acceptance_gate_recorded",
			gate: { ...gate("pass"), required: false },
		});

		expect(() => ledger.append({ recordId: "evt-bare-complete", type: "state_changed", state: "completed" })).toThrow(
			/required acceptance gate/,
		);
		expect(ledger.state).toBe("running");
	});
	test("rejects completion when a required pass gate lacks recorded host evidence", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-pass-without-evidence",
			type: "acceptance_gate_recorded",
			gate: gate("pass"),
		});

		expect(() =>
			ledger.append({ recordId: "evt-complete-without-evidence", type: "state_changed", state: "completed" }),
		).toThrow(/recorded host evidence/);
		expect(ledger.state).toBe("running");
	});

	test("keeps acceptance gate identity immutable across status updates", () => {
		const ledger = makeLedger();
		const original: AcceptanceGate = {
			...gate(),
			assignmentId: "assignment:deliver",
			freshnessRevision: 1,
			required: true,
		};
		ledger.append({ recordId: "evt-gate-original", type: "acceptance_gate_recorded", gate: original });

		const changedIdentities: readonly AcceptanceGate[] = [
			{ ...original, verifier: { kind: "external", dependencyId: "dependency:approval" } },
			{ ...original, assignmentId: "assignment:other" },
			{ ...original, freshnessRevision: 2 },
			{ ...original, required: false },
		];
		for (const [index, changed] of changedIdentities.entries()) {
			expect(() =>
				ledger.append({
					recordId: `evt-gate-identity-change-${index}`,
					type: "acceptance_gate_recorded",
					gate: changed,
				}),
			).toThrow(/identity cannot change/);
		}

		ledger.append({
			recordId: "evt-gate-blocked",
			type: "acceptance_gate_recorded",
			gate: { ...original, status: "blocked" },
		});
		expect(ledger.snapshot().gates).toEqual([{ ...original, status: "blocked" }]);
	});

	test("rejects completion when recorded evidence is bound to a different gate", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-other-gate",
			type: "acceptance_gate_recorded",
			gate: gate("unknown", undefined, "gate:other"),
		});
		// 同 evidenceId 的证据记录在别 gate 名下：gate:deliver 不能借它通过。
		ledger.append({
			recordId: "evt-borrowed-evidence",
			type: "evidence_recorded",
			evidence: { ...evidence("gate:other"), evidenceId: "evidence:shared" },
		});
		ledger.append({
			recordId: "evt-pass-borrowed",
			type: "acceptance_gate_recorded",
			gate: gate("pass", undefined, undefined, [{ ...evidence(), evidenceId: "evidence:shared" }]),
		});

		expect(() =>
			ledger.append({ recordId: "evt-complete-borrowed", type: "state_changed", state: "completed" }),
		).toThrow(/recorded host evidence/);
		expect(ledger.state).toBe("running");
	});

	test("rejects a gate whose evidence misses assignment or freshness binding", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-unbound-evidence",
			type: "evidence_recorded",
			evidence: evidence(),
		});

		expect(() =>
			ledger.append({
				recordId: "evt-pass-bound",
				type: "acceptance_gate_recorded",
				gate: {
					...gate("pass", undefined, undefined, [evidence()]),
					assignmentId: "assignment:one",
					freshnessRevision: 2,
				},
			}),
		).toThrow(/different assignment/);
		expect(ledger.state).toBe("running");
	});

	test("rejects task contract revision/cursor rollbacks and same-revision rewrites", () => {
		const ledger = makeLedger();
		const original = taskContract();
		ledger.append({ recordId: "evt-task-original", type: "task_contract_recorded", contract: original });
		// 同 revision 同值：幂等 no-op，不重复物化。
		ledger.append({ recordId: "evt-task-same", type: "task_contract_recorded", contract: original });
		expect(ledger.snapshot().taskContracts).toEqual([original]);
		// revision 回退。
		expect(() =>
			ledger.append({
				recordId: "evt-task-stale-revision",
				type: "task_contract_recorded",
				contract: { ...original, revision: 0 },
			}),
		).toThrow(/revision is stale/);
		// 同 revision 改值。
		expect(() =>
			ledger.append({
				recordId: "evt-task-rewritten",
				type: "task_contract_recorded",
				contract: { ...original, status: "completed" },
			}),
		).toThrow(/cannot change at the same revision/);
		// cursor 回退：revision 前进但 cursor 后退仍拒绝。
		ledger.append({
			recordId: "evt-task-cursor-advance",
			type: "task_contract_recorded",
			contract: { ...original, revision: 2, cursor: 1, status: "completed" },
		});
		expect(() =>
			ledger.append({
				recordId: "evt-task-stale-cursor",
				type: "task_contract_recorded",
				contract: { ...original, revision: 3, cursor: 0 },
			}),
		).toThrow(/cursor is stale/);
		// removed 墓碑：存在条目时身份不可变；墓碑先于移除发生。
		expect(() =>
			ledger.append({
				recordId: "evt-task-removed-mismatch",
				type: "task_contract_recorded",
				contract: { ...original, workKey: "work:other" },
				removed: true,
			}),
		).toThrow(/identity cannot change/);
		// removed 墓碑：移除现条目、对未知条目幂等。
		ledger.append({
			recordId: "evt-task-removed",
			type: "task_contract_recorded",
			contract: { ...original, revision: 3, cursor: 1 },
			removed: true,
		});
		expect(ledger.snapshot().taskContracts).toEqual([]);
		ledger.append({
			recordId: "evt-task-removed-again",
			type: "task_contract_recorded",
			contract: { ...original, revision: 3, cursor: 1 },
			removed: true,
		});
		expect(ledger.snapshot().taskContracts).toEqual([]);
		// 移除后重新准入：revision 从 0 重新开始。
		ledger.append({
			recordId: "evt-task-readmitted",
			type: "task_contract_recorded",
			contract: { ...original, revision: 0 },
		});
		expect(ledger.snapshot().taskContracts).toEqual([{ ...original, revision: 0 }]);
	});

	test("replays snapshots and journal events to the same materialized state", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-gate", type: "acceptance_gate_recorded", gate: gate() });
		ledger.append({
			recordId: "evt-evidence",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence-1",
				kind: "command",
				receiptRef: "host-receipt-1",
				gateId: "gate:deliver",
				contractRevision: 1,
			},
		});
		ledger.append({
			recordId: "evt-gate-pass",
			type: "acceptance_gate_recorded",
			gate: gate("pass", undefined, undefined, [
				{
					evidenceId: "evidence-1",
					kind: "command",
					receiptRef: "host-receipt-1",
					gateId: "gate:deliver",
					contractRevision: 1,
				},
			]),
		});
		ledger.append({ recordId: "evt-complete", type: "state_changed", state: "completed" });
		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot(), "snapshot-final");
		expect(compactExecutionScopeJournal(persistence.read(ledger.scopeId), ledger.snapshot())).toHaveLength(1);

		const replayed = persistence.replay(ledger.scopeId);
		expect(replayed).toBeDefined();
		expect(replayed?.snapshot()).toEqual(ledger.snapshot());
		expect(replayed?.entries()).toEqual([]);
	});
	test("recovers the immutable objective contract from event-only journals", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-only-usage", type: "usage_recorded", delta: { inputTokens: 2 } });
		for (const record of ledger.entries()) persistence.append(record);

		const replayed = persistence.replay(ledger.scopeId);
		expect(replayed?.snapshot()).toEqual(ledger.snapshot());
	});
});

describe("ExecutionScopeRegistry", () => {
	test("retains a scope for steering/compaction/handoff and cuts over on a new user turn", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		const first = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const steered = registry.resolve({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			kind: "steering",
			objectiveContract: contract(99),
		});
		const compacted = registry.resolve({ rootSessionId: "session-1", logicalTurnId: "turn-1", kind: "compaction" });
		const handedOff = registry.resolve({
			rootSessionId: "session-1",
			kind: "handoff",
			continuationOfScopeId: first.scopeId,
		});
		const next = registry.resolve({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			kind: "authoritative_user",
			objectiveContract: {
				...contract(),
				authoritativeUserTurnId: "turn-2",
				ref: { ...contract().ref, contractId: "contract-next", contractHash: "sha256-next" },
			},
		});

		expect(steered?.scopeId).toBe(first.scopeId);
		expect(compacted?.scopeId).toBe(first.scopeId);
		expect(handedOff?.scopeId).toBe(first.scopeId);
		expect(steered?.objectiveContract).toEqual(first.objectiveContract);
		expect(next?.scopeId).not.toBe(first.scopeId);
		expect(registry.current("session-1")?.scopeId).toBe(next?.scopeId);
		expect(
			registry.resolve({ rootSessionId: "session-unknown", logicalTurnId: "turn-x", kind: "model_summary" }),
		).toBeUndefined();
	});

	test("idempotently reuses an authoritative turn and rejects contract conflicts", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		const first = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const repeated = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const next = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			objectiveContract: { ...contract(), authoritativeUserTurnId: "turn-2" },
		});
		const repeatedPrevious = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});

		expect(repeated).toBe(first);
		expect(repeatedPrevious).toBe(first);
		expect(next.scopeId).toBe("scope:session-1:turn-2");
		expect(registry.list("session-1")).toHaveLength(2);
		// 重入旧轮次后 current 必须重新指回该轮次的作用域，而非停留在最新轮次。
		expect(registry.current("session-1")?.scopeId).toBe(first.scopeId);
		expect(() =>
			registry.startAuthoritativeTurn({
				rootSessionId: "session-1",
				logicalTurnId: "turn-1",
				objectiveContract: contract(2),
			}),
		).toThrow(/different immutable objective contract/);
		expect(registry.list("session-1")).toHaveLength(2);
	});

	test("reset replaces old-branch scopes and restores supplied references", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		const oldFirst = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const oldSecond = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			objectiveContract: { ...contract(), authoritativeUserTurnId: "turn-2" },
		});

		const branch = new ExecutionScopeRegistry({ now: () => NOW });
		const fresh = branch.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-10",
			objectiveContract: { ...contract(), authoritativeUserTurnId: "turn-10" },
		});
		const freshNext = branch.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-11",
			objectiveContract: { ...contract(), authoritativeUserTurnId: "turn-11" },
		});
		const otherRoot = branch.startAuthoritativeTurn({
			rootSessionId: "session-2",
			logicalTurnId: "turn-1",
			objectiveContract: { ...contract(2), authoritativeUserTurnId: "turn-1" },
		});
		registry.reset([fresh, freshNext, otherRoot]);

		expect(registry.get(oldFirst.scopeId)).toBeUndefined();
		expect(registry.get(oldSecond.scopeId)).toBeUndefined();
		expect(registry.getForTurn("session-1", "turn-1")).toBeUndefined();
		expect(
			registry.resolve({ rootSessionId: "session-1", logicalTurnId: "turn-1", kind: "steering" }),
		).toBeUndefined();
		expect(registry.list("session-1").map(reference => reference.scopeId)).toEqual([
			fresh.scopeId,
			freshNext.scopeId,
		]);
		expect(registry.current("session-1")?.scopeId).toBe(freshNext.scopeId);
		expect(registry.current("session-2")?.scopeId).toBe(otherRoot.scopeId);
	});

	test("reset with no references clears every scope and current pointer", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		registry.reset();

		expect(registry.list()).toHaveLength(0);
		expect(registry.current("session-1")).toBeUndefined();
		expect(registry.getForTurn("session-1", "turn-1")).toBeUndefined();
		expect(registry.resolve({ rootSessionId: "session-1", kind: "handoff" })).toBeUndefined();
	});
});

describe("execution-scope journal tolerance", () => {
	test("ignores unknown and incomplete legacy records while rebuilding valid facts", () => {
		const session = new MemorySession();
		session.appendCustomEntry("other.extension", { prompt: "must not be read" });
		session.appendCustomEntry("san.execution_scope", { schemaVersion: 999, journalType: "event" });
		session.appendCustomEntry("san.execution_scope", { recordId: "incomplete", type: "state_changed" });

		expect(readExecutionScopeJournal(session.getEntries())).toHaveLength(0);
		expect(rebuildExecutionScopeLedger(session.getEntries())).toBeUndefined();
	});

	test("writes only bounded facts and replays them", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		const record = ledger.append({ recordId: "evt-safe", type: "usage_recorded", delta: { inputTokens: 2 } }).record;
		persistence.append(record);
		const rebuilt = rebuildExecutionScopeLedger(session.getEntries());

		expect(rebuilt?.snapshot().usage.inputTokens).toBe(2);
		const stored = session.getEntries()[0];
		expect(stored?.type).toBe("custom");
		expect(JSON.stringify(stored)).not.toContain("prompt");
		expect(JSON.stringify(stored)).not.toContain("toolOutput");
	});
	test("redacts provider credentials from journal records", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		const record = ledger.append({
			recordId: "evt-health",
			type: "provider_health_recorded",
			health: {
				providerKey: "provider-a",
				endpoint: "custom endpoint?access_token=endpoint-secret&route=primary",
				normalizedUrl: "https://user:secret@example.test/api?authorization=normalized-secret",
				state: "open",
				healthRevision: 1,
				generation: 1,
			},
		}).record;
		persistence.append(record);

		const stored = JSON.stringify(session.getEntries()[0]);
		expect(stored).not.toContain("secret");
		expect(stored).not.toContain("user:");
	});
	test("round-trips explicit verifier identifiers without inventing strategy independence", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		const verifiers: AcceptanceVerifier[] = [
			{ kind: "command", checkId: "check:tests", expectedExitCode: 0 },
			{ kind: "browser", scenarioId: "scenario:smoke", assertionIds: ["assertion:ready"] },
			{ kind: "api", requestId: "request:health", assertionIds: ["assertion:status"] },
			{ kind: "artifact", artifactKind: "report", schemaId: "schema:v1" },
			{ kind: "review", rubricId: "rubric:release", requiredEvidenceKinds: ["command", "artifact"] },
			{ kind: "external", dependencyId: "dependency:approval" },
		];
		for (const [index, verifier] of verifiers.entries()) {
			ledger.append({
				recordId: `evt-gate-${index}`,
				type: "acceptance_gate_recorded",
				gate: gate("unknown", verifier, `gate:${index}`),
			});
		}
		ledger.append({
			recordId: "evt-serial-strategy",
			type: "strategy_recorded",
			strategy: {
				strategyId: "strategy:serial",
				scopeId: ledger.scopeId,
				strategyKey: "strategy:serial",
				revision: 1,
				hypothesisRef: "hypothesis:serial",
				expectedEvidenceRefs: [],
				status: "proposed",
			},
		});
		for (const record of ledger.entries()) persistence.append(record);

		const rebuilt = persistence.replay(ledger.scopeId);
		expect(rebuilt?.snapshot().gates.map(item => item.verifier)).toEqual(verifiers);
		expect(rebuilt?.snapshot().strategies[0]?.independenceKey).toBeUndefined();
		const serialized = JSON.stringify(session.getEntries());
		expect(serialized).toContain("checkId");
		expect(serialized).not.toContain('"check"');
	});

	test("rejects an incomplete command verifier without a check identifier", () => {
		const parsed = parseExecutionScopeJournalRecord({
			schemaVersion: 1,
			journalType: "event",
			record: {
				recordId: "evt-incomplete-verifier",
				scopeId: "scope:session-1:turn-1",
				rootSessionId: "session-1",
				logicalTurnId: "turn-1",
				revision: 1,
				occurredAt: NOW,
				type: "acceptance_gate_recorded",
				gate: {
					gateId: "gate:incomplete",
					contractRef: contract().ref,
					contractRevision: 1,
					objectiveClauseRefs: ["clause:deliver"],
					verifier: { kind: "command", expectedExitCode: 0 },
					status: "unknown",
					evidenceRefs: [],
				},
			},
		});

		expect(parsed).toBeUndefined();
	});
	test("round-trips provider health retry, last success, and evidence refs", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-health-fields",
			type: "provider_health_recorded",
			health: {
				providerKey: "provider:one",
				endpoint: "https://provider.test",
				normalizedUrl: "https://provider.test",
				state: "open",
				healthRevision: 2,
				generation: 1,
				retryAt: 1_784_000_000_000,
				lastSuccess: 1_783_000_000_000,
				evidenceRefs: ["evidence:provider-1"],
			},
		});
		for (const record of ledger.entries()) persistence.append(record);

		const rebuilt = persistence.replay(ledger.scopeId);
		expect(rebuilt?.snapshot().providerHealth).toEqual([
			{
				providerKey: "provider:one",
				endpoint: "https://provider.test",
				normalizedUrl: "https://provider.test",
				state: "open",
				healthRevision: 2,
				generation: 1,
				retryAt: 1_784_000_000_000,
				lastSuccess: 1_783_000_000_000,
				evidenceRefs: ["evidence:provider-1"],
			},
		]);
	});
	test("round-trips full task contract snapshots and tombstones through the journal", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		const taskSnapshot = taskContract();
		ledger.append({
			recordId: "evt-task-contract",
			type: "task_contract_recorded",
			contract: taskSnapshot,
		});
		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot(), "snapshot-task-contract");

		const replayed = persistence.replay(ledger.scopeId);
		expect(replayed?.snapshot().taskContracts).toEqual([taskSnapshot]);

		ledger.append({
			recordId: "evt-task-contract-removed",
			type: "task_contract_recorded",
			contract: taskSnapshot,
			removed: true,
		});
		expect(ledger.snapshot().taskContracts).toEqual([]);
		for (const record of ledger.entries()) persistence.append(record);
		const afterRemoval = persistence.replay(ledger.scopeId);
		expect(afterRemoval?.snapshot().taskContracts).toEqual([]);
	});

	test("full snapshots retain strategies and task contracts through compaction and rebuild", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-strategy",
			type: "strategy_recorded",
			strategy: {
				strategyId: "strategy:one",
				scopeId: ledger.scopeId,
				strategyKey: "strategy:one",
				revision: 1,
				hypothesisRef: "hypothesis:one",
				expectedEvidenceRefs: ["evidence:one"],
				status: "active",
			},
		});
		ledger.append({ recordId: "evt-task-contract", type: "task_contract_recorded", contract: taskContract() });
		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot(), "snapshot-full");

		// 压缩为纯 snapshot 后，strategies 与 taskContracts 都不能丢失。
		const compacted = compactExecutionScopeJournal(persistence.read(ledger.scopeId), ledger.snapshot());
		expect(compacted).toHaveLength(1);
		expect(compacted[0]?.journalType).toBe("snapshot");
		const replayed = rebuildExecutionScopeLedger(session.getEntries());
		expect(replayed?.snapshot().strategies).toEqual(ledger.snapshot().strategies);
		expect(replayed?.snapshot().taskContracts).toEqual(ledger.snapshot().taskContracts);
		expect(replayed?.snapshot()).toEqual(ledger.snapshot());
	});
});

describe("execution terminal schema", () => {
	test("treats budget_exhausted as a stable terminal state that round-trips", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-budget", type: "state_changed", state: "budget_exhausted" });
		expect(ledger.state).toBe("budget_exhausted");
		expect(isTerminalExecutionState(ledger.state)).toBe(true);

		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot(), "snapshot-budget");
		const replayed = persistence.replay(ledger.scopeId);

		expect(replayed?.snapshot().state).toBe("budget_exhausted");
		expect(replayed?.snapshot()).toEqual(ledger.snapshot());
	});
	test("treats no_provider_available as a stable terminal state that round-trips", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-no-provider", type: "state_changed", state: "no_provider_available" });
		expect(ledger.state).toBe("no_provider_available");
		expect(isTerminalExecutionState(ledger.state)).toBe(true);

		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot(), "snapshot-no-provider");
		const replayed = persistence.replay(ledger.scopeId);

		expect(replayed?.snapshot().state).toBe("no_provider_available");
		expect(replayed?.snapshot()).toEqual(ledger.snapshot());
	});

	test("reads legacy ledger records without remapping states", () => {
		const budget = parseExecutionScopeJournalRecord({
			recordId: "evt-legacy-budget",
			scopeId: "scope:session-1:turn-1",
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			revision: 1,
			occurredAt: NOW,
			type: "state_changed",
			state: "budget_exhausted",
		});
		expect(budget?.journalType).toBe("event");
		expect(
			budget?.journalType === "event" && budget.record.type === "state_changed" ? budget.record.state : undefined,
		).toBe("budget_exhausted");

		const needsUser = parseExecutionScopeJournalRecord({
			recordId: "evt-legacy-needs-user",
			scopeId: "scope:session-1:turn-1",
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			revision: 1,
			occurredAt: NOW,
			type: "state_changed",
			state: "needs_user",
		});
		expect(
			needsUser?.journalType === "event" && needsUser.record.type === "state_changed"
				? needsUser.record.state
				: undefined,
		).toBe("needs_user");
	});

	test("requires a typed supervisor external blocker to enter needs_user", () => {
		const ledger = makeLedger();
		expect(() =>
			ledger.append({ recordId: "evt-bare-needs-user", type: "state_changed", state: "needs_user" }),
		).toThrow(/typed external blocker/);
		expect(ledger.state).not.toBe("needs_user");

		ledger.append({
			recordId: "evt-decision-untyped",
			type: "supervisor_decision_recorded",
			decision: {
				decisionId: "decision:needs-user-untyped",
				scopeId: ledger.scopeId,
				basisRevision: 0,
				basisHash: "hash",
				action: "needs_user",
				evidenceRefs: [],
				invalidatedHypothesisRefs: [],
				confidence: "high",
				createdAt: NOW,
				externalBlocker: {
					kind: "other",
					dependencyId: "dependency:approval",
					evidenceRef: "evidence:external",
				} as unknown as SupervisorExternalBlocker,
			},
		});
		expect(() =>
			ledger.append({ recordId: "evt-untyped-needs-user", type: "state_changed", state: "needs_user" }),
		).toThrow(/typed external blocker/);
	});

	test("accepts needs_user when the latest supervisor decision carries a typed blocker", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-decision-typed",
			type: "supervisor_decision_recorded",
			decision: {
				decisionId: "decision:needs-user",
				scopeId: ledger.scopeId,
				basisRevision: 0,
				basisHash: "hash",
				action: "needs_user",
				evidenceRefs: ["evidence:external"],
				invalidatedHypothesisRefs: [],
				confidence: "high",
				createdAt: NOW,
				externalBlocker: {
					kind: "external",
					dependencyId: "dependency:approval",
					evidenceRef: "evidence:external",
				},
			},
		});
		ledger.append({ recordId: "evt-typed-needs-user", type: "state_changed", state: "needs_user" });
		expect(ledger.state).toBe("needs_user");
	});

	test("rejects late state writes and stale revisions after budget_exhausted", () => {
		const ledger = makeLedger();
		ledger.append({ recordId: "evt-budget", type: "state_changed", state: "budget_exhausted" });

		expect(() => ledger.append({ recordId: "evt-recover", type: "state_changed", state: "running" })).toThrow(
			TerminalExecutionStateError,
		);
		expect(() =>
			ledger.append(
				{ recordId: "evt-stale", type: "usage_recorded", delta: { totalTokens: 1 } },
				{ expectedRevision: 0 },
			),
		).toThrow(StaleExecutionRevisionError);
		expect(ledger.state).toBe("budget_exhausted");
	});
});
