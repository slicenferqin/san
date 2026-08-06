import { describe, expect, test } from "bun:test";
import type { AcceptanceGate, AcceptanceVerifier, ImmutableObjectiveContract } from "../../src/execution-control";
import {
	compactExecutionScopeJournal,
	ExecutionLedger,
	ExecutionScopePersistence,
	ExecutionScopeRegistry,
	parseExecutionScopeJournalRecord,
	readExecutionScopeJournal,
	rebuildExecutionScopeLedger,
	StaleExecutionRevisionError,
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
): AcceptanceGate {
	return {
		gateId,
		contractRef: contract().ref,
		contractRevision: 1,
		objectiveClauseRefs: ["clause:deliver"],
		verifier,
		status,
		evidenceRefs: [],
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

	test("allows completion when only optional acceptance gates remain", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "evt-optional-gate",
			type: "acceptance_gate_recorded",
			gate: { ...gate("unknown"), required: false },
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
		ledger.append({ recordId: "evt-gate-pass", type: "acceptance_gate_recorded", gate: gate("pass") });
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
		expect(registry.current("session-1")?.scopeId).toBe(next.scopeId);
		expect(() =>
			registry.startAuthoritativeTurn({
				rootSessionId: "session-1",
				logicalTurnId: "turn-1",
				objectiveContract: contract(2),
			}),
		).toThrow(/different immutable objective contract/);
		expect(registry.list("session-1")).toHaveLength(2);
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
});
