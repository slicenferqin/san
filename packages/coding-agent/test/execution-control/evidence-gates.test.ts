import { describe, expect, test } from "bun:test";
import type {
	AcceptanceGate,
	AcceptanceVerifier,
	EvidenceReceipt,
	EvidenceRef,
	ImmutableObjectiveContract,
} from "../../src/execution-control";
import {
	createApiEvidenceReceipt,
	createArtifactEvidenceReceipt,
	createBrowserEvidenceReceipt,
	createCommandEvidenceReceipt,
	createExternalEvidenceReceipt,
	createReviewEvidenceReceipt,
	verifyAcceptanceGates,
} from "../../src/execution-control";

const CONTRACT: ImmutableObjectiveContract = {
	ref: {
		contractId: "contract-1",
		revision: 1,
		contractHash: "sha256:contract-1",
		clauseRefs: ["clause:deliver"],
	},
	authoritativeUserTurnId: "turn-1",
	source: "authoritative_user",
};
const CONTEXT = {
	scopeId: "scope-1",
	contractRevision: 1,
	contractHash: CONTRACT.ref.contractHash,
	freshnessRevision: 7,
	assignmentIds: ["assignment-1"],
};

type GateOptions = {
	gateId?: string;
	assignmentId?: string;
	freshnessRevision?: number;
	receiptId?: string;
};

function receiptRef(
	gateId: string,
	kind: EvidenceRef["kind"],
	receiptId: string,
	options: GateOptions = {},
): EvidenceRef {
	return {
		evidenceId: receiptId,
		kind,
		receiptRef: receiptId,
		receiptId,
		gateId,
		contractRevision: CONTRACT.ref.revision,
		assignmentId: options.assignmentId ?? "assignment-1",
		freshnessRevision: options.freshnessRevision ?? CONTEXT.freshnessRevision,
	};
}

function gate(verifier: AcceptanceVerifier, options: GateOptions = {}): AcceptanceGate {
	const gateId = options.gateId ?? `gate-${verifier.kind}`;
	const receiptId = options.receiptId ?? `receipt-${verifier.kind}`;
	return {
		gateId,
		contractRef: CONTRACT.ref,
		contractRevision: CONTRACT.ref.revision,
		objectiveClauseRefs: [...CONTRACT.ref.clauseRefs],
		verifier,
		status: "unknown",
		evidenceRefs: [receiptRef(gateId, verifier.kind, receiptId, options)],
		assignmentId: options.assignmentId ?? "assignment-1",
		freshnessRevision: options.freshnessRevision ?? CONTEXT.freshnessRevision,
	};
}

function baseReceipt(receiptId: string, gateId: string, kind: EvidenceReceipt["kind"]): EvidenceReceipt {
	return {
		receiptId,
		kind,
		source: "host",
		scopeId: CONTEXT.scopeId,
		gateId,
		contractRevision: CONTEXT.contractRevision,
		contractHash: CONTEXT.contractHash,
		assignmentId: "assignment-1",
		freshnessRevision: CONTEXT.freshnessRevision,
		outcome: "pass",
		timestamp: "2026-08-05T00:00:00.000Z",
	} as EvidenceReceipt;
}

function verify(
	gates: readonly AcceptanceGate[],
	receipts: readonly EvidenceReceipt[],
	evidenceRefs?: readonly string[],
) {
	return verifyAcceptanceGates({ ...CONTEXT, gates, receipts, evidenceRefs });
}

describe("typed acceptance evidence gates", () => {
	test("accepts a matching host command and rejects unrelated bash success", () => {
		const matchingGate = gate({ kind: "command", checkId: "check:test", expectedExitCode: 0 });
		const matching = createCommandEvidenceReceipt({
			...baseReceipt("receipt-command", matchingGate.gateId, "command"),
			checkId: "check:test",
			exitCode: 0,
		});
		expect(verify([matchingGate], [matching]).passed).toBe(true);

		const unrelated = createCommandEvidenceReceipt({
			...matching,
			receiptId: "receipt-unrelated",
			checkId: "check:unrelated",
		});
		expect(verify([matchingGate], [unrelated]).passed).toBe(false);
		expect(verify([{ ...matchingGate, objectiveClauseRefs: ["clause:outside"] }], [matching]).passed).toBe(false);
	});

	test("rejects unknown refs, wrong scope, assignment, contract revision, and stale freshness", () => {
		const commandGate = gate({ kind: "command", checkId: "check:test", expectedExitCode: 0 });
		const matching = createCommandEvidenceReceipt({
			...baseReceipt("receipt-command", commandGate.gateId, "command"),
			checkId: "check:test",
			exitCode: 0,
		});
		expect(verify([commandGate], [matching], ["fabricated-ref"]).passed).toBe(false);
		expect(verify([commandGate], [{ ...matching, scopeId: "scope-other" }]).passed).toBe(false);
		expect(verify([commandGate], [{ ...matching, assignmentId: "assignment-other" }]).passed).toBe(false);
		expect(verify([commandGate], [{ ...matching, contractRevision: 2 }]).passed).toBe(false);
		expect(verify([commandGate], [{ ...matching, freshnessRevision: 6 }]).passed).toBe(false);
	});

	test("rejects failed assertions, outcomes, and model-fabricated receipts", () => {
		const browserGate = gate({ kind: "browser", scenarioId: "scenario:smoke", assertionIds: ["assertion:ready"] });
		const browser = createBrowserEvidenceReceipt({
			...baseReceipt("receipt-browser", browserGate.gateId, "browser"),
			scenarioId: "scenario:smoke",
			assertionIds: ["assertion:ready"],
			assertionResults: [{ assertionId: "assertion:ready", passed: false }],
		});
		expect(verify([browserGate], [browser]).passed).toBe(false);
		expect(verify([browserGate], [{ ...browser, outcome: "fail", assertionResults: undefined }]).passed).toBe(false);
		expect(verify([browserGate], [{ ...browser, source: "model" } as unknown as EvidenceReceipt]).passed).toBe(false);
	});

	test("passes matching browser, API, artifact, review, and external host verifiers", () => {
		const browserGate = gate({ kind: "browser", scenarioId: "scenario:smoke", assertionIds: ["assertion:ready"] });
		const browser = createBrowserEvidenceReceipt({
			...baseReceipt("receipt-browser", browserGate.gateId, "browser"),
			scenarioId: "scenario:smoke",
			assertionIds: ["assertion:ready"],
			assertionResults: [{ assertionId: "assertion:ready", passed: true }],
		});
		const apiGate = gate({
			kind: "api",
			requestId: "request:health",
			assertionIds: ["assertion:status"],
		});
		const api = createApiEvidenceReceipt({
			...baseReceipt("receipt-api", apiGate.gateId, "api"),
			requestId: "request:health",
			assertionIds: ["assertion:status"],
			assertionResults: [{ assertionId: "assertion:status", passed: true }],
		});
		const artifactGate = gate({
			kind: "artifact",
			artifactKind: "report",
			schemaId: "schema:v1",
		});
		const artifact = createArtifactEvidenceReceipt({
			...baseReceipt("receipt-artifact", artifactGate.gateId, "artifact"),
			artifactKind: "report",
			schemaId: "schema:v1",
		});
		const reviewGate = gate({
			kind: "review",
			rubricId: "rubric:release",
			requiredEvidenceKinds: ["artifact"],
		});
		const review = createReviewEvidenceReceipt({
			...baseReceipt("receipt-review", reviewGate.gateId, "review"),
			rubricId: "rubric:release",
			requiredEvidenceKinds: ["artifact"],
			evidenceRefs: [artifact.receiptId],
		});
		const externalGate = gate({
			kind: "external",
			dependencyId: "dependency:approval",
		});
		const external = createExternalEvidenceReceipt({
			...baseReceipt("receipt-external", externalGate.gateId, "external"),
			dependencyId: "dependency:approval",
		});
		const result = verify(
			[browserGate, apiGate, artifactGate, reviewGate, externalGate],
			[browser, api, artifact, review, external],
		);
		expect(result.passed).toBe(true);
		expect(result.verdicts).toHaveLength(5);
		expect(
			verify(
				[browserGate, apiGate, artifactGate, reviewGate, externalGate],
				[browser, api, { ...artifact, freshnessRevision: CONTEXT.freshnessRevision - 1 }, review, external],
			).passed,
		).toBe(false);
	});

	test("requires every required gate; partial gates cannot pass", () => {
		const firstGate = gate(
			{ kind: "command", checkId: "check:first", expectedExitCode: 0 },
			{ gateId: "gate:first", receiptId: "receipt:first" },
		);
		const secondGate = gate(
			{ kind: "command", checkId: "check:second", expectedExitCode: 0 },
			{ gateId: "gate:second", receiptId: "receipt:second" },
		);
		const first = createCommandEvidenceReceipt({
			...baseReceipt("receipt:first", firstGate.gateId, "command"),
			checkId: "check:first",
			exitCode: 0,
		});
		expect(verify([firstGate, secondGate], [first]).passed).toBe(false);
	});
});
