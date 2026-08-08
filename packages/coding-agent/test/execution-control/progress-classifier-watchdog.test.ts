import { describe, expect, test } from "bun:test";
import { ExecutionLedger } from "../../src/execution-control/execution-ledger";
import {
	classifyHostObservation,
	ProgressClassifier,
	stableFailureFingerprint,
	stablePollFingerprint,
	stableStrategyFingerprint,
	stableWorkFingerprint,
} from "../../src/execution-control/progress-classifier";
import { Watchdog } from "../../src/execution-control/watchdog";

const NOW = "2026-08-05T00:00:00.000Z";

function makeLedger(): ExecutionLedger {
	return new ExecutionLedger({
		scopeId: "scope:test",
		rootSessionId: "session:test",
		logicalTurnId: "turn:test",
		now: () => NOW,
	});
}

function repeatedFailure(workKey = "work:compile") {
	return {
		type: "failure" as const,
		workKey,
		strategyKey: "strategy:repair",
		hypothesisRef: "hypothesis:one",
		expectedEvidenceRefs: ["evidence:test"],
		independenceKey: "independent:a",
		signature: "check failed: unchanged output",
		cursor: "cursor:1",
		goalRevision: 1,
		authoritativeInputRevision: 1,
	};
}

describe("ProgressClassifier", () => {
	test("treats a legal 45-minute live heartbeat as legitimate waiting", () => {
		const result = classifyHostObservation({
			type: "process_heartbeat",
			processId: "job:research",
			live: true,
		});

		expect(result.classification).toBe("legitimate_waiting");
		expect(result.legitimateWaiting).toBe(true);
		expect(result.progress).toBe(false);
	});

	test("counts research artifact coverage/schema growth once per key", () => {
		const classifier = new ProgressClassifier();
		const first = classifier.classify({
			type: "evidence",
			evidenceKind: "research_artifact",
			schemaKey: "schema:alpha",
			coverageKeys: ["coverage:one"],
		});
		const repeat = classifier.classify({
			type: "evidence",
			evidenceKind: "research_artifact",
			schemaKey: "schema:alpha",
			coverageKeys: ["coverage:one"],
		});
		const growth = classifier.classify({
			type: "evidence",
			evidenceKind: "research_artifact",
			schemaKey: "schema:alpha",
			coverageKeys: ["coverage:one", "coverage:two"],
		});

		expect(first.classification).toBe("progress");
		expect(repeat.classification).toBe("activity");
		expect(growth.classification).toBe("progress");
		expect(growth.newCoverageKeys).toEqual(["coverage:two"]);
	});

	test("does not promote repeated reads or unchanged gates to progress", () => {
		const classifier = new ProgressClassifier();
		const gate = classifier.classify({
			type: "gate_transition",
			gateId: "gate:check",
			from: "unknown",
			to: "unknown",
		});
		const read = classifier.classify({ type: "read", filename: "src/index.ts", newFilename: true });
		const readAgain = classifier.classify({ type: "read", filename: "src/index.ts" });

		expect(gate.classification).toBe("activity");
		expect(read.classification).toBe("activity");
		expect(readAgain.classification).toBe("activity");
	});

	test("keeps rename labels out of identity while preserving independent hypotheses", () => {
		const workV2 = stableWorkFingerprint({ workKey: "Implement parser V2", displayName: "Parser Final" });
		const workV3 = stableWorkFingerprint({ workKey: "Implement parser V3", displayName: "Parser Repair" });
		const strategyV2 = stableStrategyFingerprint({
			workKey: "Implement parser V2",
			strategyKey: "strategy:parser V2",
			hypothesisRef: "hypothesis:one",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:a",
		});
		const strategyV3 = stableStrategyFingerprint({
			workKey: "Implement parser V3",
			strategyKey: "strategy:parser V3",
			hypothesisRef: "hypothesis:one",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:a",
		});
		const independent = stableStrategyFingerprint({
			workKey: "Implement parser Final",
			strategyKey: "strategy:parser Repair",
			hypothesisRef: "hypothesis:two",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:b",
		});

		expect(workV2).toBe(workV3);
		expect(strategyV2).toBe(strategyV3);
		expect(independent).not.toBe(strategyV3);
		expect(stableFailureFingerprint("failure Repair V2")).toBe(stableFailureFingerprint("failure Final V3"));
		expect(stablePollFingerprint({ workKey: "parser V2", strategyKey: "strategy V2", cursor: "c1" })).toBe(
			stablePollFingerprint({ workKey: "parser V3", strategyKey: "strategy Final", cursor: "c1" }),
		);
	});

	test("classifies verification pass-to-fail as regression", () => {
		const result = classifyHostObservation({
			type: "verification_regression",
			gateId: "gate:tests",
			from: "pass",
			to: "fail",
		});

		expect(result.classification).toBe("regression");
		expect(result.regression).toBe(true);
	});
});

describe("Watchdog", () => {
	test("reuses exact renamed assignments and keeps a different hypothesis parallel", () => {
		const watchdog = new Watchdog({ ledger: makeLedger(), mode: "enforce" });
		const first = watchdog.enforce({
			type: "mutation",
			filename: "src/parser.ts",
			requestKind: "assignment",
			assignmentId: "assignment:one",
			workKey: "parser V2",
			strategyKey: "strategy V2",
			hypothesisRef: "hypothesis:one",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:a",
		});
		const duplicate = watchdog.enforce({
			type: "mutation",
			filename: "src/parser.ts",
			requestKind: "assignment",
			assignmentId: "assignment:two",
			workKey: "parser V3",
			strategyKey: "strategy Final",
			hypothesisRef: "hypothesis:one",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:a",
		});
		const independent = watchdog.enforce({
			type: "mutation",
			filename: "src/parser.ts",
			requestKind: "assignment",
			assignmentId: "assignment:three",
			workKey: "parser Repair",
			strategyKey: "strategy Repair",
			hypothesisRef: "hypothesis:two",
			expectedEvidenceRefs: ["evidence:syntax"],
			independenceKey: "branch:b",
		});

		expect(first.action).toBe("none");
		expect(duplicate.action).toBe("reuse_duplicate");
		expect(duplicate.duplicate).toBe(true);
		expect(independent.action).toBe("none");
	});

	test("repairs a stale cursor without terminating the root scope", () => {
		const ledger = makeLedger();
		ledger.append({
			recordId: "progress:one",
			type: "progress_observed",
			observation: {
				observationId: "obs:one",
				progressClass: "activity",
				fingerprint: "fp:one",
				revision: 0,
			},
		});
		const watchdog = new Watchdog({ ledger, mode: "enforce" });
		const decision = watchdog.enforce({
			observation: { type: "read", filename: "src/index.ts", cursor: "cursor:old" },
			stateRevision: 0,
		});

		expect(decision.action).toBe("repair_state_drift");
		expect(ledger.state).toBe("running");
	});

	test("repairs a cursor that moves backwards even without a revision field", () => {
		const watchdog = new Watchdog({ ledger: makeLedger(), mode: "enforce" });
		watchdog.observe({ type: "read", workKey: "work:cursor", strategyKey: "strategy:cursor", cursor: "cursor:12" });
		const decision = watchdog.enforce({
			type: "read",
			workKey: "work:cursor",
			strategyKey: "strategy:cursor",
			cursor: "cursor:11",
		});

		expect(decision.cursor).toBe("cursor:11");
		expect(decision.action).toBe("repair_state_drift");
		expect(decision.reason).toContain("moved backwards");
	});
	test("requires repeated strategy/failure/cursor signals before diagnosis", () => {
		const watchdog = new Watchdog({ ledger: makeLedger(), mode: "enforce", repeatThreshold: 3 });
		const first = watchdog.observe(repeatedFailure());
		const second = watchdog.observe(repeatedFailure());
		const third = watchdog.observe(repeatedFailure());

		expect(first.suspicious).toBe(false);
		expect(second.suspicious).toBe(false);
		expect(third.suspicious).toBe(true);
		expect(third.action).toBe("suppress_unchanged_poll");
		expect(third.waitFor).toBe("external_event");
		expect(third.diagnosis?.basisRevision).toBe(0);
	});

	test("fresh ledger evidence clears suspicion and invalidates a frozen diagnosis", () => {
		const ledger = makeLedger();
		const watchdog = new Watchdog({ ledger, mode: "enforce", repeatThreshold: 3 });
		watchdog.observe(repeatedFailure());
		watchdog.observe(repeatedFailure());
		const diagnosis = watchdog.observe(repeatedFailure());
		if (!diagnosis.diagnosis) throw new Error("expected diagnosis snapshot");

		ledger.append({
			recordId: "evidence:new",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:new",
				kind: "artifact",
				receiptRef: "receipt:new",
			},
		});
		const stale = watchdog.enforce(diagnosis);
		const afterFreshRevision = watchdog.observe(repeatedFailure());

		expect(stale.action).toBe("stale_diagnosis");
		expect(stale.stale).toBe(true);
		expect(afterFreshRevision.suspicious).toBe(false);
		expect(afterFreshRevision.repeatCount).toBe(1);
	});

	test("runtime progress echoes of the same observation do not reset the repeat window; new evidence does", () => {
		const ledger = makeLedger();
		const watchdog = new Watchdog({ ledger, mode: "enforce", repeatThreshold: 3 });
		const observation = repeatedFailure();
		const classified = watchdog.classifier.classify(observation);
		const echo = (recordId: string, observationId: string) =>
			ledger.append({
				recordId,
				type: "progress_observed",
				observation: {
					observationId,
					progressClass: classified.progressClass === "legitimate_waiting" ? "activity" : classified.progressClass,
					fingerprint: classified.fingerprint,
					revision: 0,
				},
			});

		const first = watchdog.observe(observation);
		echo("progress:echo:1", "obs:1");
		const second = watchdog.observe(observation);
		echo("progress:echo:2", "obs:2");
		const third = watchdog.observe(observation);

		expect(first.repeatCount).toBe(1);
		expect(second.repeatCount).toBe(2);
		expect(third.repeatCount).toBe(3);
		expect(third.suspicious).toBe(true);
		expect(third.action).toBe("suppress_unchanged_poll");
		expect(third.waitFor).toBe("external_event");
		expect(third.diagnosis?.basisRevision).toBe(2);

		// 同一观察的进一步回显不会破坏抑制窗口与诊断。
		echo("progress:echo:3", "obs:3");
		const stillSuppressed = watchdog.observe(observation);
		expect(stillSuppressed.repeatCount).toBe(4);
		expect(stillSuppressed.suspicious).toBe(true);
		expect(stillSuppressed.action).toBe("suppress_unchanged_poll");
		expect(stillSuppressed.stale).toBe(false);

		// 真正的新宿主证据会重置重复窗口。
		ledger.append({
			recordId: "evidence:new",
			type: "evidence_recorded",
			evidence: {
				evidenceId: "evidence:new",
				kind: "artifact",
				receiptRef: "receipt:new",
			},
		});
		const reset = watchdog.observe(observation);
		expect(reset.suspicious).toBe(false);
		expect(reset.repeatCount).toBe(1);
	});

	test("heartbeat clears a suspected stall and huge telemetry never becomes terminal", () => {
		const ledger = makeLedger();
		const watchdog = new Watchdog({ ledger, mode: "enforce", repeatThreshold: 2 });
		watchdog.observe(repeatedFailure());
		const suspected = watchdog.observe(repeatedFailure());
		const heartbeat = watchdog.observe({ type: "process_heartbeat", jobId: "job:long", live: true });
		ledger.append({
			recordId: "usage:huge",
			type: "usage_recorded",
			delta: {
				inputTokens: 9_000_000_000,
				outputTokens: 9_000_000_000,
				totalTokens: 18_000_000_000,
				durationMs: 99_999_999_999,
				assignmentCount: 99_999,
			},
		});

		expect(suspected.suspicious).toBe(true);
		expect(heartbeat.classification.classification).toBe("legitimate_waiting");
		expect(ledger.state).toBe("running");
	});
	test("fresh progress invalidates a frozen diagnosis before ledger append", () => {
		const ledger = makeLedger();
		const watchdog = new Watchdog({ ledger, mode: "enforce", repeatThreshold: 2 });
		watchdog.observe(repeatedFailure());
		const diagnosis = watchdog.observe(repeatedFailure());
		if (!diagnosis.diagnosis) throw new Error("expected diagnosis snapshot");

		const evidence = watchdog.observe({
			type: "evidence",
			evidenceId: "evidence:progress",
			receiptRef: "receipt:progress",
		});
		const stale = watchdog.enforce(diagnosis);

		expect(evidence.classification.classification).toBe("progress");
		expect(stale.action).toBe("stale_diagnosis");
		expect(stale.stale).toBe(true);
	});
});
