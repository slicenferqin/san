import { describe, expect, test } from "bun:test";
import {
	DurableScheduler,
	type DurableSupervisorDecision,
	supervisorDecisionBasis,
} from "../../src/execution-control/durable-scheduler";
import { verifyAcceptanceGates } from "../../src/execution-control/evidence-gates";
import { ExecutionLedger } from "../../src/execution-control/execution-ledger";
import type { AcceptanceGate, EvidenceReceipt, ImmutableObjectiveContract } from "../../src/execution-control/types";

const NOW = "2026-08-05T00:00:00.000Z";
const CONTRACT: ImmutableObjectiveContract = {
	ref: {
		contractId: "contract:scheduler",
		revision: 1,
		contractHash: "sha256:scheduler",
		clauseRefs: ["clause:deliver"],
	},
	authoritativeUserTurnId: "turn:scheduler",
	source: "authoritative_user",
};

function ledger(): ExecutionLedger {
	return new ExecutionLedger({
		scopeId: "scope:scheduler",
		rootSessionId: "session:scheduler",
		logicalTurnId: "turn:scheduler",
		objectiveContract: CONTRACT,
		now: () => NOW,
	});
}

function decision(scheduler: DurableScheduler, action: DurableSupervisorDecision["action"]): DurableSupervisorDecision {
	const basis = supervisorDecisionBasis(scheduler.ledger);
	return {
		decisionId: `decision:${action}`,
		scopeId: scheduler.ledger.scopeId,
		basisRevision: basis.revision,
		basisHash: basis.hash,
		action,
		evidenceRefs: [],
		invalidatedHypothesisRefs: [],
		confidence: "high",
		createdAt: NOW,
	};
}

function commandGate(): AcceptanceGate {
	return {
		gateId: "gate:tests",
		contractRef: CONTRACT.ref,
		contractRevision: CONTRACT.ref.revision,
		objectiveClauseRefs: [...CONTRACT.ref.clauseRefs],
		verifier: { kind: "command", checkId: "check:tests", expectedExitCode: 0 },
		status: "unknown",
		evidenceRefs: [
			{
				evidenceId: "receipt:tests",
				kind: "command",
				receiptRef: "receipt:tests",
				receiptId: "receipt:tests",
				gateId: "gate:tests",
				contractRevision: 1,
				assignmentId: "assignment:one",
				freshnessRevision: 1,
			},
		],
		assignmentId: "assignment:one",
		freshnessRevision: 1,
	};
}

function commandReceipt(): EvidenceReceipt {
	return {
		receiptId: "receipt:tests",
		kind: "command",
		source: "host",
		scopeId: "scope:scheduler",
		gateId: "gate:tests",
		contractRevision: 1,
		contractHash: CONTRACT.ref.contractHash,
		assignmentId: "assignment:one",
		freshnessRevision: 1,
		outcome: "pass",
		timestamp: NOW,
		checkId: "check:tests",
		exitCode: 0,
	};
}

describe("DurableScheduler host policy", () => {
	test("rejects a supervisor decision whose basis is stale after new progress", () => {
		const hostLedger = ledger();
		const scheduler = new DurableScheduler({ ledger: hostLedger });
		const stale = decision(scheduler, "continue");
		hostLedger.append({
			recordId: "progress:one",
			type: "progress_observed",
			observation: {
				observationId: "observation:one",
				progressClass: "progress",
				fingerprint: "fingerprint:one",
				revision: 1,
			},
		});

		const result = scheduler.applySupervisorDecision(stale);

		expect(result.applied).toBe(false);
		expect(result.stale).toBe(true);
		expect(hostLedger.snapshot().supervisorDecisions).toHaveLength(0);
	});

	test("blocks new dispatch in grace/diagnostic windows but lets in-flight work settle", async () => {
		let now = 100;
		const scheduler = new DurableScheduler({ ledger: ledger(), now: () => now, diagnosticMs: 100 });
		const running = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const settled = scheduler.executeAssignment("assignment:in-flight", () => {
			started.resolve();
			return running.promise;
		});
		await started.promise;
		scheduler.openDiagnosticWindow();

		expect(scheduler.admitDispatch("assignment:new")).toMatchObject({
			admitted: false,
			reason: "diagnostic_window",
		});
		expect(scheduler.admitDispatch("assignment:in-flight")).toMatchObject({ admitted: true, inFlight: true });
		let duplicateRan = false;
		await expect(
			scheduler.executeAssignment("assignment:in-flight", async () => {
				duplicateRan = true;
				return "duplicate";
			}),
		).rejects.toThrow("already_in_flight");
		expect(duplicateRan).toBe(false);

		running.resolve("completed");
		expect(await settled).toBe("completed");
		now = 250;
		expect(scheduler.admitDispatch("assignment:new").admitted).toBe(true);
	});

	test("renews only on progress with new authoritative evidence and revision", () => {
		let now = 100;
		const hostLedger = ledger();
		const scheduler = new DurableScheduler({ ledger: hostLedger, now: () => now });
		scheduler.startAssignment("assignment:one");

		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "activity",
				authoritativeRevision: 1,
				authoritativeEvidenceRefs: [],
			}),
		).toMatchObject({ renewed: false, reason: "not_progress" });

		hostLedger.append({
			recordId: "evidence:one",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:one",
				kind: "artifact",
				receiptRef: "receipt:one",
				assignmentId: "assignment:one",
				contractRevision: 1,
				freshnessRevision: 1,
			},
		});
		now = 200;
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "progress",
				authoritativeRevision: 1,
				authoritativeEvidenceRefs: ["evidence:one"],
				cursor: "cursor:one",
			}),
		).toMatchObject({ renewed: true, assignmentId: "assignment:one" });
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "progress",
				authoritativeRevision: 2,
				authoritativeEvidenceRefs: ["evidence:one"],
				cursor: "cursor:two",
			}),
		).toMatchObject({ renewed: false, reason: "missing_authoritative_evidence" });
		now = 300;
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "progress",
				authoritativeRevision: 1,
				authoritativeEvidenceRefs: ["evidence:one"],
				cursor: "cursor:two",
			}),
		).toMatchObject({ renewed: false, reason: "stale_authoritative_revision" });
		hostLedger.append({
			recordId: "evidence:two",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:two",
				kind: "artifact",
				receiptRef: "receipt:two",
				contractRevision: 1,
				assignmentId: "assignment:one",
				freshnessRevision: 2,
			},
		});
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "progress",
				authoritativeRevision: 2,
				authoritativeEvidenceRefs: ["evidence:one", "evidence:two"],
				cursor: "cursor:one",
			}),
		).toMatchObject({ renewed: false, reason: "repeated_cursor" });
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "activity",
				authoritativeRevision: 2,
				authoritativeEvidenceRefs: ["evidence:one"],
			}),
		).toMatchObject({ renewed: false, reason: "not_progress" });
		expect(
			scheduler.renewAssignment("assignment:one", {
				progressClass: "progress",
				authoritativeRevision: 2,
				authoritativeEvidenceRefs: ["forged:evidence"],
			}),
		).toMatchObject({ renewed: false, reason: "missing_authoritative_evidence" });
	});

	test("needs_user requires gate-bound external evidence with matching dependency and no runnable node", () => {
		const hostLedger = ledger();
		const scheduler = new DurableScheduler({ ledger: hostLedger, runnableNodeIds: ["node:ready"] });

		// 记录 external acceptance gate 与绑定该 gate 的 external evidence。
		hostLedger.append({
			recordId: "gate:approval",
			type: "acceptance_gate_recorded",
			gate: {
				gateId: "gate:approval",
				contractRef: CONTRACT.ref,
				contractRevision: CONTRACT.ref.revision,
				objectiveClauseRefs: [...CONTRACT.ref.clauseRefs],
				verifier: { kind: "external", dependencyId: "dependency:approval" },
				status: "blocked",
				evidenceRefs: [
					{
						evidenceId: "evidence:approval",
						kind: "external",
						receiptRef: "receipt:approval",
						gateId: "gate:approval",
						contractRevision: CONTRACT.ref.revision,
						freshnessRevision: 2,
					},
				],
				freshnessRevision: 2,
			},
		});
		hostLedger.append({
			recordId: "evidence:approval",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:approval",
				kind: "external",
				receiptRef: "receipt:approval",
				gateId: "gate:approval",
				contractRevision: CONTRACT.ref.revision,
				freshnessRevision: 2,
			},
		});

		const needsUser = (decisionId: string, evidenceRef: string, dependencyId: string) =>
			scheduler.applySupervisorDecision({
				...decision(scheduler, "needs_user"),
				decisionId,
				evidenceRefs: [evidenceRef],
				externalBlocker: { kind: "external", dependencyId, evidenceRef },
			});

		// 仍有 runnable node 时拒绝，即使 gate 与 evidence 完全匹配。
		expect(needsUser("decision:needs-user-runnable", "evidence:approval", "dependency:approval").applied).toBe(false);
		scheduler.setRunnableNodes([]);

		// 匹配的 external gate + evidence：可 needs_user。
		const accepted = needsUser("decision:needs-user-accepted", "evidence:approval", "dependency:approval");
		expect(accepted.applied).toBe(true);
		expect(hostLedger.state).toBe("needs_user");

		// 伪造 evidence ref：未记录于 ledger。
		expect(
			scheduler.applySupervisorDecision({
				...decision(scheduler, "needs_user"),
				decisionId: "decision:needs-user-fake",
				evidenceRefs: ["fake"],
				externalBlocker: { kind: "external", dependencyId: "dependency:approval", evidenceRef: "fake" },
			}).applied,
		).toBe(false);

		// evidence 已记录但未出现在决策引用中：拒绝。
		expect(
			scheduler.applySupervisorDecision({
				...decision(scheduler, "needs_user"),
				decisionId: "decision:needs-user-no-ref",
				evidenceRefs: [],
				externalBlocker: {
					kind: "external",
					dependencyId: "dependency:approval",
					evidenceRef: "evidence:approval",
				},
			}).applied,
		).toBe(false);

		// 无 gate：external evidence 未绑定任何 acceptance gate。
		hostLedger.append({
			recordId: "evidence:unbound",
			type: "evidence_recorded",
			evidence: { evidenceId: "evidence:unbound", kind: "external", receiptRef: "receipt:unbound" },
		});
		expect(needsUser("decision:needs-user-unbound", "evidence:unbound", "dependency:approval").applied).toBe(false);

		// 错 gate ref：evidence 绑定的 gate 不存在。
		hostLedger.append({
			recordId: "evidence:missing-gate",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:missing-gate",
				kind: "external",
				receiptRef: "receipt:missing-gate",
				gateId: "gate:missing",
				contractRevision: CONTRACT.ref.revision,
				freshnessRevision: 3,
			},
		});
		expect(
			needsUser("decision:needs-user-missing-gate", "evidence:missing-gate", "dependency:approval").applied,
		).toBe(false);

		// 错 gate ref：evidence 声称绑定 gate:approval，但该 gate 的 evidenceRefs 并不包含它。
		hostLedger.append({
			recordId: "evidence:orphan",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:orphan",
				kind: "external",
				receiptRef: "receipt:orphan",
				gateId: "gate:approval",
				contractRevision: CONTRACT.ref.revision,
				freshnessRevision: 3,
			},
		});
		expect(needsUser("decision:needs-user-orphan", "evidence:orphan", "dependency:approval").applied).toBe(false);

		// 错 dependency：gate verifier 的 dependencyId 与 blocker 不一致。
		hostLedger.append({
			recordId: "gate:other-dep",
			type: "acceptance_gate_recorded",
			gate: {
				gateId: "gate:other-dep",
				contractRef: CONTRACT.ref,
				contractRevision: CONTRACT.ref.revision,
				objectiveClauseRefs: [...CONTRACT.ref.clauseRefs],
				verifier: { kind: "external", dependencyId: "dependency:other" },
				status: "blocked",
				evidenceRefs: [
					{
						evidenceId: "evidence:other-dep",
						kind: "external",
						receiptRef: "receipt:other-dep",
						gateId: "gate:other-dep",
						contractRevision: CONTRACT.ref.revision,
						freshnessRevision: 3,
					},
				],
				freshnessRevision: 3,
			},
		});
		hostLedger.append({
			recordId: "evidence:other-dep",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:other-dep",
				kind: "external",
				receiptRef: "receipt:other-dep",
				gateId: "gate:other-dep",
				contractRevision: CONTRACT.ref.revision,
				freshnessRevision: 3,
			},
		});
		expect(needsUser("decision:needs-user-other-dep", "evidence:other-dep", "dependency:approval").applied).toBe(
			false,
		);
	});

	test("does not let generic evidence text satisfy a typed command gate", () => {
		const gate = commandGate();
		const result = verifyAcceptanceGates({
			scopeId: "scope:scheduler",
			contractRevision: 1,
			contractHash: CONTRACT.ref.contractHash,
			freshnessRevision: 1,
			gates: [gate],
			receipts: [],
			evidenceRefs: ["filesystem:changed", "evidenceResults:passed"],
		});
		expect(result.passed).toBe(false);
		expect(result.reasons.join(" ")).toContain("unknown receipt ref");
		expect(
			verifyAcceptanceGates({
				scopeId: "scope:scheduler",
				contractRevision: 1,
				contractHash: CONTRACT.ref.contractHash,
				freshnessRevision: 1,
				gates: [gate],
				receipts: [commandReceipt()],
				evidenceRefs: ["receipt:tests"],
			}).passed,
		).toBe(true);
		expect(
			verifyAcceptanceGates({
				scopeId: "scope:scheduler",
				contractRevision: 1,
				contractHash: CONTRACT.ref.contractHash,
				freshnessRevision: 1,
				gates: [{ ...gate, freshnessRevision: undefined }],
				receipts: [commandReceipt()],
				evidenceRefs: ["receipt:tests"],
			}).passed,
		).toBe(false);
	});
});
