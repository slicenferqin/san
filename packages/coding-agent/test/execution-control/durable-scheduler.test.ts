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

	test("requires typed external evidence and no runnable node before needs_user", () => {
		const hostLedger = ledger();
		const scheduler = new DurableScheduler({ ledger: hostLedger, runnableNodeIds: ["node:ready"] });
		const rejected = scheduler.applySupervisorDecision({
			...decision(scheduler, "needs_user"),
			externalBlocker: { kind: "external", dependencyId: "dependency:approval", evidenceRef: "fake" },
		});
		expect(rejected.applied).toBe(false);
		expect(rejected.reason).toContain("typed external blocker");

		hostLedger.append({
			recordId: "evidence:external",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:external",
				kind: "external",
				receiptRef: "receipt:external",
			},
		});
		scheduler.setRunnableNodes([]);
		const accepted = scheduler.applySupervisorDecision({
			...decision(scheduler, "needs_user"),
			decisionId: "decision:needs-user",
			evidenceRefs: ["evidence:external"],
			externalBlocker: {
				kind: "external",
				dependencyId: "dependency:approval",
				evidenceRef: "evidence:external",
			},
		});
		expect(accepted.applied).toBe(true);
		expect(hostLedger.state).toBe("needs_user");
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
