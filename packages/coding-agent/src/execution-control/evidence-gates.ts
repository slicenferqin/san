import type {
	AcceptanceGate,
	AcceptanceVerifier,
	ApiEvidenceReceipt,
	ArtifactEvidenceReceipt,
	BrowserAssertionResult,
	BrowserEvidenceReceipt,
	CommandEvidenceReceipt,
	EvidenceReceipt,
	EvidenceRef,
	EvidenceVerifierKind,
	ExternalEvidenceReceipt,
	ReviewEvidenceReceipt,
} from "./types";

export interface EvidenceGateVerificationInput {
	readonly scopeId: string;
	readonly contractRevision: number;
	readonly contractHash: string;
	readonly freshnessRevision: number;
	readonly gates: readonly AcceptanceGate[];
	readonly receipts: readonly EvidenceReceipt[];
	/** Host-known refs reported by a supervisor; text claims are not accepted. */
	readonly evidenceRefs?: readonly string[];
	/** Current assignment batch. Receipts for another assignment are stale. */
	readonly assignmentIds?: readonly string[];
}

export interface GateEvidenceVerdict {
	readonly gateId: string;
	readonly status: "pass" | "fail";
	readonly reason: string;
	readonly evidenceRefs: readonly string[];
}

export interface EvidenceGateVerificationResult {
	readonly passed: boolean;
	readonly allRequiredGatesPassing: boolean;
	readonly verdicts: readonly GateEvidenceVerdict[];
	readonly evidenceRefs: readonly string[];
	readonly reasons: readonly string[];
}

export type AcceptanceGateVerificationResult = EvidenceGateVerificationResult;

interface MutableGateVerdict {
	gateId: string;
	status: "pass" | "fail";
	reason: string;
	evidenceRefs: string[];
}

function isPassingOutcome(outcome: EvidenceReceipt["outcome"]): boolean {
	return outcome === "pass" || outcome === "passed";
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}

function requiredKindsMatch(
	actual: readonly EvidenceVerifierKind[],
	expected: readonly EvidenceVerifierKind[],
): boolean {
	if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
	const actualSet = new Set(actual);
	return expected.every(kind => actualSet.has(kind));
}

function assertionResults(
	receipt: BrowserEvidenceReceipt | ApiEvidenceReceipt,
): readonly BrowserAssertionResult[] | undefined {
	return receipt.assertionResults ?? receipt.assertions;
}

function verifyAssertions(
	receipt: BrowserEvidenceReceipt | ApiEvidenceReceipt,
	assertionIds: readonly string[],
): string | undefined {
	if (!Array.isArray(assertionIds)) return "verifier is missing assertion identifiers";
	if (!Array.isArray(receipt.assertionIds)) return "receipt is missing assertion identifiers";
	if (!assertionIds.every(assertionId => receipt.assertionIds.includes(assertionId))) {
		return "receipt does not cover every required assertion";
	}
	const results = assertionResults(receipt);
	if (!Array.isArray(results)) return "receipt is missing assertion results";
	const resultById = new Map(results.map(result => [result.assertionId, result]));
	for (const assertionId of assertionIds) {
		const result = resultById.get(assertionId);
		if (!result?.passed) return `assertion ${assertionId} failed`;
	}
	return undefined;
}

function nestedReceiptMatchesContext(
	receipt: EvidenceReceipt,
	input: EvidenceGateVerificationInput,
	gate: AcceptanceGate,
): boolean {
	if (receipt.source !== "host" || !isPassingOutcome(receipt.outcome)) return false;
	if (receipt.scopeId !== input.scopeId) return false;
	if (receipt.contractRevision !== input.contractRevision || receipt.contractHash !== input.contractHash) return false;
	if (receipt.freshnessRevision !== input.freshnessRevision) return false;
	if (gate.assignmentId !== undefined && receipt.assignmentId !== gate.assignmentId) return false;
	if (input.assignmentIds && input.assignmentIds.length > 0) {
		if (!receipt.assignmentId || !input.assignmentIds.includes(receipt.assignmentId)) return false;
	}
	return true;
}

function verifierIdentityMatches(
	verifier: AcceptanceVerifier,
	receipt: EvidenceReceipt,
	receipts: ReadonlyMap<string, EvidenceReceipt>,
	input: EvidenceGateVerificationInput,
	gate: AcceptanceGate,
): string | undefined {
	if (receipt.kind !== verifier.kind)
		return `receipt kind ${receipt.kind} does not match verifier kind ${verifier.kind}`;
	switch (verifier.kind) {
		case "command": {
			const command = receipt as CommandEvidenceReceipt;
			if (command.checkId !== verifier.checkId)
				return `receipt check ${command.checkId} does not match ${verifier.checkId}`;
			if (command.exitCode !== verifier.expectedExitCode) {
				return `command exit ${command.exitCode} does not match expected ${verifier.expectedExitCode}`;
			}
			return undefined;
		}
		case "browser": {
			const browser = receipt as BrowserEvidenceReceipt;
			if (browser.scenarioId !== verifier.scenarioId) {
				return `receipt scenario ${browser.scenarioId} does not match ${verifier.scenarioId}`;
			}
			return verifyAssertions(browser, verifier.assertionIds);
		}
		case "api": {
			const api = receipt as ApiEvidenceReceipt;
			if (api.requestId !== verifier.requestId) {
				return `receipt request ${api.requestId} does not match ${verifier.requestId}`;
			}
			return verifyAssertions(api, verifier.assertionIds);
		}
		case "artifact": {
			const artifact = receipt as ArtifactEvidenceReceipt;
			if (artifact.artifactKind !== verifier.artifactKind) {
				return `receipt artifact kind ${artifact.artifactKind} does not match ${verifier.artifactKind}`;
			}
			if (artifact.schemaId !== verifier.schemaId)
				return `receipt schema ${artifact.schemaId} does not match ${verifier.schemaId}`;
			return undefined;
		}
		case "review": {
			const review = receipt as ReviewEvidenceReceipt;
			if (review.rubricId !== verifier.rubricId)
				return `receipt rubric ${review.rubricId} does not match ${verifier.rubricId}`;
			if (!requiredKindsMatch(review.requiredEvidenceKinds, verifier.requiredEvidenceKinds)) {
				return "review receipt omits a required evidence kind";
			}
			const refs = Array.isArray(review.evidenceRefs) ? review.evidenceRefs : [];
			for (const kind of verifier.requiredEvidenceKinds) {
				const matching = refs
					.map(ref => receipts.get(ref))
					.find(candidate => candidate?.kind === kind && nestedReceiptMatchesContext(candidate, input, gate));
				if (!matching) return `review receipt lacks passing current ${kind} evidence`;
			}
			return undefined;
		}
		case "external": {
			const external = receipt as ExternalEvidenceReceipt;
			if (external.dependencyId !== verifier.dependencyId) {
				return `receipt dependency ${external.dependencyId} does not match ${verifier.dependencyId}`;
			}
			return undefined;
		}
	}
}

function receiptIdForRef(ref: EvidenceRef): string {
	return ref.receiptId ?? ref.receiptRef;
}

function checkReceipt(
	gate: AcceptanceGate,
	ref: EvidenceRef,
	receipt: EvidenceReceipt | undefined,
	input: EvidenceGateVerificationInput,
	receipts: ReadonlyMap<string, EvidenceReceipt>,
): string | undefined {
	if (!receipt) return `unknown receipt ref ${receiptIdForRef(ref)}`;
	if (ref.kind !== gate.verifier.kind || receipt.kind !== gate.verifier.kind)
		return "receipt kind does not match gate verifier";
	if (ref.gateId !== gate.gateId || receipt.gateId !== gate.gateId) return "receipt is bound to a different gate";
	const expectedHash = gate.contractHash ?? gate.contractRef.contractHash;
	if (gate.contractRevision !== input.contractRevision || gate.contractRevision !== gate.contractRef.revision) {
		return "gate contract revision is not current";
	}
	if (gate.freshnessRevision === undefined || gate.freshnessRevision !== input.freshnessRevision) {
		return "typed acceptance gate must bind a current freshness revision";
	}
	if (expectedHash !== input.contractHash) return "gate contract hash is not current";
	if (
		gate.objectiveClauseRefs.length === 0 ||
		!gate.objectiveClauseRefs.every(clause => gate.contractRef.clauseRefs.includes(clause))
	) {
		return "gate asserts an objective clause outside the immutable contract";
	}
	if (receipt.contractRevision !== input.contractRevision || receipt.contractHash !== input.contractHash) {
		return "receipt is bound to a different immutable contract";
	}
	if (ref.contractRevision !== input.contractRevision || receipt.freshnessRevision !== input.freshnessRevision) {
		return "receipt is stale for the current freshness revision";
	}
	if (ref.freshnessRevision !== input.freshnessRevision)
		return "evidence ref is stale for the current freshness revision";
	if (gate.assignmentId === undefined || ref.assignmentId === undefined || receipt.assignmentId === undefined) {
		return "typed acceptance gate must bind an assignment";
	}
	if (gate.assignmentId !== receipt.assignmentId) return "receipt belongs to a different assignment";
	if (gate.assignmentId !== ref.assignmentId) return "evidence ref belongs to a different assignment";
	if (receipt.scopeId !== input.scopeId) return "receipt belongs to a different execution scope";
	if (input.assignmentIds && input.assignmentIds.length > 0) {
		if (!input.assignmentIds.includes(receipt.assignmentId)) return "receipt is outside the current assignment batch";
		if (ref.assignmentId !== receipt.assignmentId) return "evidence ref assignment binding is missing or wrong";
	}
	if (receipt.source !== "host") return "model-created receipts cannot satisfy a host evidence gate";
	if (!isPassingOutcome(receipt.outcome)) return "host receipt outcome is not passing";
	return verifierIdentityMatches(gate.verifier, receipt, receipts, input, gate);
}

/**
 * Pure host-gate verifier. It only consumes immutable gate descriptors, typed
 * host receipts and references; report text and model claims are intentionally
 * absent from this API.
 */
export function verifyAcceptanceGates(input: EvidenceGateVerificationInput): EvidenceGateVerificationResult {
	const receipts = new Map<string, EvidenceReceipt>();
	const duplicateReceiptIds = new Set<string>();
	for (const receipt of input.receipts) {
		if (receipts.has(receipt.receiptId)) duplicateReceiptIds.add(receipt.receiptId);
		receipts.set(receipt.receiptId, receipt);
	}
	const requestedRefs = input.evidenceRefs ?? [];
	const reasons: string[] = [];
	for (const ref of requestedRefs) {
		if (!receipts.has(ref)) reasons.push(`unknown receipt ref ${ref}`);
	}
	for (const duplicateId of duplicateReceiptIds) reasons.push(`duplicate receipt id ${duplicateId}`);

	const verdicts: MutableGateVerdict[] = [];
	for (const gate of input.gates) {
		if (gate.required === false) continue;
		const refs = gate.evidenceRefs;
		const gateReasons: string[] = [];
		if (refs.length === 0) gateReasons.push("gate has no host evidence refs");
		const passingRefs: string[] = [];
		for (const ref of refs) {
			const reason = checkReceipt(gate, ref, receipts.get(receiptIdForRef(ref)), input, receipts);
			if (reason) gateReasons.push(`${receiptIdForRef(ref)}: ${reason}`);
			else passingRefs.push(receiptIdForRef(ref));
		}
		const verdict: MutableGateVerdict = {
			gateId: gate.gateId,
			status: gateReasons.length === 0 ? "pass" : "fail",
			reason: gateReasons.length === 0 ? "all required host evidence checks passed" : gateReasons.join("; "),
			evidenceRefs: passingRefs,
		};
		verdicts.push(verdict);
		if (gateReasons.length > 0) reasons.push(`gate ${gate.gateId}: ${verdict.reason}`);
	}
	const passed = reasons.length === 0 && verdicts.every(verdict => verdict.status === "pass");
	return {
		passed,
		allRequiredGatesPassing: passed,
		verdicts,
		evidenceRefs: unique(verdicts.flatMap(verdict => verdict.evidenceRefs)),
		reasons: unique(reasons),
	};
}

export const verifyEvidenceGates = verifyAcceptanceGates;

/** Build a bounded command receipt from a host observation without retaining command text/output. */
export function createCommandEvidenceReceipt(
	input: Omit<CommandEvidenceReceipt, "source" | "kind">,
): CommandEvidenceReceipt {
	return { ...input, source: "host", kind: "command" };
}

export function createBrowserEvidenceReceipt(
	input: Omit<BrowserEvidenceReceipt, "source" | "kind">,
): BrowserEvidenceReceipt {
	return { ...input, source: "host", kind: "browser" };
}

export function createApiEvidenceReceipt(input: Omit<ApiEvidenceReceipt, "source" | "kind">): ApiEvidenceReceipt {
	return { ...input, source: "host", kind: "api" };
}

export function createArtifactEvidenceReceipt(
	input: Omit<ArtifactEvidenceReceipt, "source" | "kind">,
): ArtifactEvidenceReceipt {
	return { ...input, source: "host", kind: "artifact" };
}

export function createReviewEvidenceReceipt(
	input: Omit<ReviewEvidenceReceipt, "source" | "kind">,
): ReviewEvidenceReceipt {
	return { ...input, source: "host", kind: "review" };
}

export function createExternalEvidenceReceipt(
	input: Omit<ExternalEvidenceReceipt, "source" | "kind">,
): ExternalEvidenceReceipt {
	return { ...input, source: "host", kind: "external" };
}

/** Stable non-secret identity for a legacy command observation. */
export function legacyCommandCheckId(command: string): string {
	let hash = 2166136261;
	for (const character of command.trim()) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return `legacy-command:${(hash >>> 0).toString(16)}`;
}

export function isConcreteLegacyCommand(command: string): boolean {
	const normalized = command.trim().toLowerCase();
	return (
		/(^|\s)(test|check|build|compile|typecheck|lint|verify)(\s|$)/.test(normalized) ||
		/\b(bun|npm|pnpm|yarn)\s+test\b/.test(normalized)
	);
}
