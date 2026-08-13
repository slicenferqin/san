import { describe, expect, it } from "bun:test";
import { compileSkillGates, skillEvidenceCheckId, skillGateId } from "../src/execution-control/skill-gate-compiler";
import type { ObjectiveContractRef, SkillEvidenceSpec } from "../src/execution-control/types";

const CONTRACT_REF: ObjectiveContractRef = {
	contractId: "contract-test",
	revision: 3,
	contractHash: "sha256-contract-test",
	clauseRefs: ["clause:a", "clause:b"],
};

function compile(evidence: SkillEvidenceSpec[], skillName = "fix-bug") {
	return compileSkillGates({
		skill: { name: skillName, evidence },
		contractRef: CONTRACT_REF,
		contractRevision: CONTRACT_REF.revision,
		contractHash: CONTRACT_REF.contractHash,
	});
}

function spec(overrides: Partial<SkillEvidenceSpec> & Pick<SkillEvidenceSpec, "id">): SkillEvidenceSpec {
	return {
		phase: "before-done",
		kind: "command",
		expect: "pass",
		description: `evidence ${overrides.id}`,
		...overrides,
	};
}

describe("compileSkillGates", () => {
	it("returns an empty array for an empty evidence chain", () => {
		expect(compile([])).toEqual([]);
	});

	it("binds contract identity and clause refs onto every gate", () => {
		const [gate] = compile([spec({ id: "verify" })]);
		expect(gate.contractRef).toBe(CONTRACT_REF);
		expect(gate.contractRevision).toBe(3);
		expect(gate.contractHash).toBe("sha256-contract-test");
		expect(gate.objectiveClauseRefs).toEqual(["clause:a", "clause:b"]);
		expect(gate.status).toBe("unknown");
		expect(gate.evidenceRefs).toEqual([]);
	});

	it("derives stable, dedupe-friendly gate ids from skill and spec ids", () => {
		const first = compile([spec({ id: "verify" })]);
		const second = compile([spec({ id: "verify" })]);
		expect(first[0].gateId).toBe("gate:skill:fix-bug:verify");
		expect(first[0].gateId).toBe(second[0].gateId);
		expect(skillGateId("fix-bug", "verify")).toBe("gate:skill:fix-bug:verify");
	});

	it("marks before-done specs as required hard gates and before-fix specs as soft gates", () => {
		const gates = compile([
			spec({ id: "repro", phase: "before-fix", expect: "fail" }),
			spec({ id: "verify", phase: "before-done", expect: "pass" }),
		]);
		expect(gates.map(gate => gate.required)).toEqual([false, true]);
	});

	it("maps command specs to command verifiers with expect encoded as the exit code", () => {
		const [failing, passing] = compile([
			spec({ id: "repro", kind: "command", expect: "fail", phase: "before-fix" }),
			spec({ id: "verify", kind: "command", expect: "pass" }),
		]);
		expect(failing.verifier).toEqual({
			kind: "command",
			checkId: skillEvidenceCheckId("fix-bug", "repro"),
			expectedExitCode: 1,
		});
		expect(passing.verifier).toEqual({
			kind: "command",
			checkId: skillEvidenceCheckId("fix-bug", "verify"),
			expectedExitCode: 0,
		});
	});

	it("maps browser specs to browser verifiers with expect encoded in the assertion id", () => {
		const [gate] = compile([spec({ id: "core-path", kind: "browser", expect: "pass" })], "build-web");
		expect(gate.verifier).toEqual({
			kind: "browser",
			scenarioId: "skill-check:build-web:core-path",
			assertionIds: ["skill-check:build-web:core-path:expect-pass"],
		});
	});

	it("maps api specs to api verifiers with expect encoded in the assertion id", () => {
		const [gate] = compile([spec({ id: "endpoint", kind: "api", expect: "fail" })]);
		expect(gate.verifier).toEqual({
			kind: "api",
			requestId: "skill-check:fix-bug:endpoint",
			assertionIds: ["skill-check:fix-bug:endpoint:expect-fail"],
		});
	});

	it("maps artifact specs to artifact verifiers with expect encoded in the schema id", () => {
		const [gate] = compile([spec({ id: "handover", kind: "artifact", expect: "pass" })]);
		expect(gate.verifier).toEqual({
			kind: "artifact",
			artifactKind: "skill-check:fix-bug:handover",
			schemaId: "skill-evidence:expect-pass",
		});
	});

	it("maps review specs to review verifiers with expect encoded in the rubric id", () => {
		const [gate] = compile([spec({ id: "signoff", kind: "review", expect: "pass" })]);
		expect(gate.verifier).toEqual({
			kind: "review",
			rubricId: "skill-check:fix-bug:signoff:expect-pass",
			requiredEvidenceKinds: [],
		});
	});

	it("maps external specs to external verifiers with expect encoded in the dependency id", () => {
		const [gate] = compile([spec({ id: "upstream", kind: "external", expect: "fail" })]);
		expect(gate.verifier).toEqual({
			kind: "external",
			dependencyId: "skill-check:fix-bug:upstream:expect-fail",
		});
	});

	it("makes sameAs specs share the referenced spec's verifier identity so a substituted command cannot satisfy the re-check", () => {
		const [repro, verify, regression] = compile([
			spec({ id: "repro", phase: "before-fix", expect: "fail" }),
			spec({ id: "verify", expect: "pass", sameAs: "repro" }),
			spec({ id: "regression", expect: "pass" }),
		]);
		expect(verify.verifier).toEqual({
			kind: "command",
			checkId: skillEvidenceCheckId("fix-bug", "repro"),
			expectedExitCode: 0,
		});
		// Same identity as the referenced spec, different expected outcome.
		expect((verify.verifier as { checkId: string }).checkId).toBe((repro.verifier as { checkId: string }).checkId);
		// An unrelated spec keeps its own identity.
		expect((regression.verifier as { checkId: string }).checkId).toBe(skillEvidenceCheckId("fix-bug", "regression"));
	});

	it("resolves transitive sameAs chains to the chain root", () => {
		const gates = compile([
			spec({ id: "a", phase: "before-fix", expect: "fail" }),
			spec({ id: "b", expect: "pass", sameAs: "a" }),
			spec({ id: "c", expect: "pass", sameAs: "b" }),
		]);
		const checkIds = gates.map(gate => (gate.verifier as { checkId: string }).checkId);
		expect(checkIds).toEqual([
			skillEvidenceCheckId("fix-bug", "a"),
			skillEvidenceCheckId("fix-bug", "a"),
			skillEvidenceCheckId("fix-bug", "a"),
		]);
	});

	it("terminates on mutually referencing sameAs cycles with a deterministic identity", () => {
		const gates = compile([
			spec({ id: "x", expect: "pass", sameAs: "y" }),
			spec({ id: "y", expect: "pass", sameAs: "x" }),
		]);
		const [x, y] = gates.map(gate => (gate.verifier as { checkId: string }).checkId);
		// Each walk stops at the first revisited node: x resolves to y, y resolves to x.
		expect(x).toBe(skillEvidenceCheckId("fix-bug", "y"));
		expect(y).toBe(skillEvidenceCheckId("fix-bug", "x"));
	});

	it("ignores a sameAs reference to an id missing from the chain (defensive against upstream validation gaps)", () => {
		const [gate] = compile([spec({ id: "verify", expect: "pass", sameAs: "ghost" })]);
		expect((gate.verifier as { checkId: string }).checkId).toBe(skillEvidenceCheckId("fix-bug", "verify"));
	});
});
