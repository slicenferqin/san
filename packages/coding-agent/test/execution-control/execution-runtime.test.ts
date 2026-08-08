import { describe, expect, test } from "bun:test";
import type { ImmutableObjectiveContract, ProviderHealthSnapshot } from "../../src/execution-control";
import {
	compactExecutionScopeJournal,
	createExecutionRuntime,
	ExecutionLedger,
	ExecutionScopePersistence,
	ProviderHealthRegistry,
	readExecutionScopeJournal,
	rebuildExecutionScopeLedger,
	StaleExecutionRevisionError,
	supervisorDecisionBasis,
	TaskContractRegistry,
} from "../../src/execution-control";
import type { CustomEntry, SessionEntry } from "../../src/session/session-entries";

const NOW = "2026-08-05T00:00:00.000Z";
const SCOPE_ID = "scope:session-1:turn-1";

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

function runtimeFor(session: MemorySession) {
	return createExecutionRuntime({
		rootSessionId: "session-1",
		branchEntries: session.getEntries(),
		sessionManager: session,
		taskRegistry: new TaskContractRegistry({ rootSessionId: "session-1", now: () => 0 }),
		providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
		now: () => NOW,
	});
}

describe("ExecutionRuntime", () => {
	test("rebuilds only the current branch journal and exposes the active scope", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = new ExecutionLedger({
			scopeId: SCOPE_ID,
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
			now: () => NOW,
		});
		ledger.append({ recordId: "evt-usage", type: "usage_recorded", delta: { inputTokens: 2 } });
		for (const record of ledger.entries()) persistence.append(record);
		persistence.appendSnapshot(ledger.snapshot());

		const runtime = runtimeFor(session);
		expect(runtime.activeScopeId()).toBe(SCOPE_ID);
		expect(runtime.getScope(SCOPE_ID)?.snapshot().usage.inputTokens).toBe(2);
		expect(runtime.getScope("scope:unknown")).toBeUndefined();
	});

	test("starts a fresh authoritative scope, persists scope_started, and is idempotent", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);

		const first = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		expect(first.scopeId).toBe(SCOPE_ID);
		expect(runtime.activeScopeId()).toBe(SCOPE_ID);
		expect(first.ledger.revision).toBe(1);
		expect(first.ledger.entries()[0]?.type).toBe("scope_started");

		const repeated = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		expect(repeated.scopeId).toBe(SCOPE_ID);
		expect(first.ledger.revision).toBe(1);
		expect(readExecutionScopeJournal(session.getEntries())).toHaveLength(1);
	});

	test("exposes one scheduler bound to the active scope's ledger", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});

		const scheduler = runtime.schedulerFor(SCOPE_ID);
		expect(scheduler).toBeDefined();
		expect(runtime.schedulerFor(SCOPE_ID)).toBe(scheduler);
		expect(() => runtime.schedulerFor("scope:other")).toThrow(/not materialized/);
	});

	test("records host observations as classified progress in the ledger", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		const handle = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});

		const result = runtime.recordHostObservation({
			scopeId: SCOPE_ID,
			observation: {
				workKey: "work:one",
				strategyKey: "strategy:one",
				assignmentId: "contract:one",
				requestKind: "assignment",
				cursor: "completed",
			},
		});
		expect(result.append.accepted).toBe(true);
		const snapshot = handle.snapshot();
		expect(snapshot.progress).toHaveLength(1);
		expect(["activity", "progress", "regression", "blocker"]).toContain(snapshot.progress[0]?.progressClass);
		expect(() =>
			runtime.recordHostObservation({
				scopeId: "scope:other",
				observation: {
					workKey: "work:one",
					strategyKey: "strategy:one",
					assignmentId: "contract:one",
					requestKind: "assignment",
					cursor: "completed",
				},
			}),
		).toThrow(/not materialized/);
	});

	test("finishScope enforces the host evidence gate, revision CAS, and terminal late-writes", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		const handle = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});

		expect(() => runtime.finishScope(SCOPE_ID, { expectedRevision: 1, state: "completed" })).toThrow(
			/required acceptance gate/,
		);
		expect(() => runtime.finishScope(SCOPE_ID, { expectedRevision: 0, state: "completed" })).toThrow(
			StaleExecutionRevisionError,
		);

		handle.ledger.append({
			recordId: "evt-gate",
			type: "acceptance_gate_recorded",
			gate: {
				gateId: "gate:deliver",
				contractRef: contract().ref,
				contractRevision: 1,
				contractHash: "sha256-contract-1",
				objectiveClauseRefs: ["clause:deliver"],
				verifier: { kind: "command", checkId: "check:runtime", expectedExitCode: 0 },
				status: "unknown",
				evidenceRefs: [],
				assignmentId: "assignment:deliver",
				freshnessRevision: 1,
			},
		});
		// gate 尚未拿到 host evidence：不能 completed。
		expect(() => runtime.finishScope(SCOPE_ID, { expectedRevision: 2, state: "completed" })).toThrow(/not passed/);
		// host 证据经 verifier 校验后 gate 推进为 pass。
		const evidence = runtime.recordHostObservation({
			scopeId: SCOPE_ID,
			receipt: {
				receiptId: "receipt:deliver",
				kind: "command",
				source: "host",
				scopeId: SCOPE_ID,
				gateId: "gate:deliver",
				contractRevision: 1,
				contractHash: "sha256-contract-1",
				assignmentId: "assignment:deliver",
				freshnessRevision: 1,
				outcome: "pass",
				timestamp: NOW,
				checkId: "check:runtime",
				exitCode: 0,
			},
		});
		expect(evidence.append.accepted).toBe(true);
		const completedRevision = handle.ledger.revision;
		runtime.finishScope(SCOPE_ID, { expectedRevision: completedRevision, state: "completed" });
		expect(() =>
			runtime.finishScope(SCOPE_ID, { expectedRevision: completedRevision + 1, state: "aborted_by_user" }),
		).toThrow(/already terminal/);

		const budgetRuntime = runtimeFor(session);
		const budget = budgetRuntime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			objectiveContract: contract(2),
		});
		budgetRuntime.finishScope(budget.scopeId, {
			expectedRevision: budget.ledger.revision,
			state: "budget_exhausted",
		});
		expect(budget.snapshot().state).toBe("budget_exhausted");
	});

	test("enters needs_user only from an immutable verified external blocker receipt", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		const handle = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		handle.ledger.append({
			recordId: "evt-external-gate",
			type: "acceptance_gate_recorded",
			gate: {
				gateId: "gate:approval",
				contractRef: contract().ref,
				contractRevision: 1,
				contractHash: "sha256-contract-1",
				objectiveClauseRefs: ["clause:deliver"],
				verifier: { kind: "external", dependencyId: "dependency:approval" },
				status: "unknown",
				evidenceRefs: [],
				assignmentId: "assignment:approval",
				freshnessRevision: 1,
			},
		});
		const blockerReceipt = {
			receiptId: "receipt:approval-pending",
			kind: "external",
			source: "host",
			scopeId: SCOPE_ID,
			gateId: "gate:approval",
			contractRevision: 1,
			contractHash: "sha256-contract-1",
			assignmentId: "assignment:approval",
			freshnessRevision: 1,
			outcome: "failed",
			timestamp: NOW,
			dependencyId: "dependency:approval",
		} as const;

		expect(() =>
			runtime.recordHostObservation({
				scopeId: SCOPE_ID,
				receipt: { ...blockerReceipt, receiptId: "receipt:wrong-dependency", dependencyId: "dependency:other" },
			}),
		).toThrow(/does not bind/);
		expect(handle.snapshot().evidenceRefs).toHaveLength(0);

		runtime.recordHostObservation({ scopeId: SCOPE_ID, receipt: blockerReceipt });
		const blockedGate = handle.snapshot().gates.find(gate => gate.gateId === "gate:approval");
		expect(blockedGate?.status).toBe("blocked");
		expect(blockedGate?.evidenceRefs.map(ref => ref.evidenceId)).toEqual([blockerReceipt.receiptId]);
		expect(runtime.recordHostObservation({ scopeId: SCOPE_ID, receipt: blockerReceipt }).append.duplicate).toBe(true);
		expect(() =>
			runtime.recordHostObservation({
				scopeId: SCOPE_ID,
				receipt: { ...blockerReceipt, outcome: "pass" },
			}),
		).toThrow(/cannot change after recording/);

		const scheduler = runtime.schedulerFor(SCOPE_ID);
		scheduler.setRunnableNodes([]);
		const basis = supervisorDecisionBasis(handle.ledger);
		const applied = scheduler.applySupervisorDecision({
			decisionId: "decision:approval-pending",
			scopeId: SCOPE_ID,
			basisRevision: basis.revision,
			basisHash: basis.hash,
			action: "needs_user",
			evidenceRefs: [blockerReceipt.receiptId],
			invalidatedHypothesisRefs: [],
			confidence: "high",
			createdAt: NOW,
			externalBlocker: {
				kind: "external",
				dependencyId: blockerReceipt.dependencyId,
				evidenceRef: blockerReceipt.receiptId,
			},
		});

		expect(applied.applied).toBe(true);
		expect(handle.snapshot().state).toBe("needs_user");
	});

	test("records provider health snapshots into the ledger and round-trips them", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const snapshot: ProviderHealthSnapshot = {
			key: { provider: "provider:one", normalizedUrl: "https://provider.test" },
			provider: "provider:one",
			normalizedUrl: "https://provider.test",
			endpoint: "https://provider.test",
			providerKey: "provider:one",
			state: "open",
			healthRevision: 2,
			generation: 1,
			retryAt: 1_784_000_000_000,
			lastSuccess: 1_783_000_000_000,
			evidenceRefs: ["evidence:provider-1"],
		};
		runtime.recordProviderSnapshot(snapshot);

		const replayed = rebuildExecutionScopeLedger(session.getEntries());
		expect(replayed?.snapshot().providerHealth).toEqual([
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

	test("keeps concurrent materialized scopes and provider request ownership isolated", async () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		const first = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		runtime.taskRegistry.admit({ scopeId: first.scopeId, workKey: "work:first", strategyKey: "strategy:first" });
		runtime.registerProviderDispatch(first.scopeId, "request:first");

		const second = runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			objectiveContract: contract(2),
		});
		runtime.taskRegistry.admit({ scopeId: second.scopeId, workKey: "work:second", strategyKey: "strategy:second" });
		runtime.registerProviderDispatch(second.scopeId, "request:second");
		expect(runtime.activeScopeId()).toBe(second.scopeId);
		expect(runtime.schedulerFor(first.scopeId)).not.toBe(runtime.schedulerFor(second.scopeId));

		const providerKey = { provider: "provider:shared", normalizedUrl: "https://provider.test/v1" };
		await runtime.providerRegistry.dispatch({ key: providerKey, requestId: "request:second" }, async () => "second");
		await runtime.providerRegistry.dispatch({ key: providerKey, requestId: "request:first" }, async () => "first");
		runtime.recordHostObservation({
			scopeId: first.scopeId,
			observation: { type: "read", workKey: "work:first", strategyKey: "strategy:first", cursor: "cursor:1" },
		});

		expect(first.snapshot().requests.map(request => [request.requestId, request.status])).toEqual([
			["request:first", "completed"],
		]);
		expect(second.snapshot().requests.map(request => [request.requestId, request.status])).toEqual([
			["request:second", "completed"],
		]);
		expect(first.snapshot().taskContracts.map(task => task.workKey)).toEqual(["work:first"]);
		expect(second.snapshot().taskContracts.map(task => task.workKey)).toEqual(["work:second"]);
		expect(first.snapshot().progress).toHaveLength(1);
		expect(second.snapshot().progress).toHaveLength(0);
	});

	test("syncBranch rebuilds the active ledger from updated branch entries", () => {
		const session = new MemorySession();
		const persistence = new ExecutionScopePersistence(session);
		const ledger = new ExecutionLedger({
			scopeId: SCOPE_ID,
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
			now: () => NOW,
		});
		ledger.append({
			recordId: "scope:session-1:turn-1:started",
			type: "scope_started",
			objectiveContract: contract(),
		});
		ledger.append({ recordId: "evt-usage", type: "usage_recorded", delta: { inputTokens: 2 } });
		for (const record of ledger.entries()) persistence.append(record);

		const runtime = runtimeFor(session);
		expect(runtime.getScope(SCOPE_ID)?.snapshot().revision).toBe(2);

		const externalLedger = rebuildExecutionScopeLedger(session.getEntries());
		const external = externalLedger?.append({
			recordId: "evt-external",
			type: "usage_recorded",
			delta: { outputTokens: 7 },
		});
		expect(external?.accepted).toBe(true);
		persistence.append(external!.record);

		runtime.syncBranch(session.getEntries());
		const snapshot = runtime.getScope(SCOPE_ID)?.snapshot();
		expect(snapshot?.revision).toBe(3);
		expect(snapshot?.usage.outputTokens).toBe(7);
	});

	test("restores active scope from the last journal snapshot when compaction dropped markers", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const handle = runtime.schedulerFor(SCOPE_ID);
		handle.ledger.append({ recordId: "evt-usage", type: "usage_recorded", delta: { inputTokens: 2 } });

		// 压缩 branch journal：scope_started marker 被丢弃，只剩最新快照 + 其后事件。
		const journal = readExecutionScopeJournal(session.getEntries());
		const compacted = compactExecutionScopeJournal(journal, handle.ledger.snapshot());
		expect(compacted.some(entry => entry.journalType === "event")).toBe(false);
		const compactedSession = new MemorySession();
		const compactedPersistence = new ExecutionScopePersistence(compactedSession);
		for (const entry of compacted) {
			if (entry.journalType === "event") {
				compactedPersistence.append(entry.record);
			} else {
				compactedPersistence.appendSnapshot(entry.snapshot, entry.snapshotId);
			}
		}

		// snapshot-only journal 无法靠 marker 恢复 active，回退到最后 snapshot 的 scopeId。
		const restored = runtimeFor(compactedSession);
		expect(restored.activeScopeId()).toBe(SCOPE_ID);
		expect(restored.schedulerFor(SCOPE_ID).ledger.snapshot().state).toBe("running");
		// 快照作为基线，其后事件（usage）必须仍可重放。
		expect(restored.schedulerFor(SCOPE_ID).ledger.snapshot().usage.inputTokens).toBe(2);
	});

	test("dispose is idempotent and rejects all further writes", () => {
		const session = new MemorySession();
		const runtime = runtimeFor(session);
		runtime.startScope({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});

		runtime.dispose();
		runtime.dispose();
		expect(runtime.activeScopeId()).toBeUndefined();
		expect(() =>
			runtime.startScope({
				rootSessionId: "session-1",
				logicalTurnId: "turn-2",
				objectiveContract: contract(2),
			}),
		).toThrow(/disposed/);
		expect(() => runtime.syncBranch(session.getEntries())).toThrow(/disposed/);
		expect(() =>
			runtime.recordProviderSnapshot({
				key: { provider: "provider:one", normalizedUrl: "https://provider.test" },
				provider: "provider:one",
				normalizedUrl: "https://provider.test",
				endpoint: "https://provider.test",
				providerKey: "provider:one",
				state: "open",
				healthRevision: 1,
				generation: 1,
				evidenceRefs: [],
			}),
		).toThrow(/disposed/);
	});
});
