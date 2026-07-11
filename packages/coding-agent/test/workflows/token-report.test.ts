import { describe, expect, test } from "bun:test";
import {
	buildWorkflowTokenReport,
	type WorkflowBenchmarkMode,
	type WorkflowBenchmarkSample,
} from "../../src/workflows/token-report";

function samplesForSop(sopId: string): WorkflowBenchmarkSample[] {
	const samples: WorkflowBenchmarkSample[] = [];
	for (const mode of ["skill", "managed"] as const satisfies readonly WorkflowBenchmarkMode[]) {
		for (let run = 1; run <= 5; run++) {
			samples.push({
				sampleId: `${sopId}-${mode}-${run}`,
				sopId,
				run,
				mode,
				fixtureHash: `${sopId}-fixture-hash`,
				sourceHash: `${sopId}-${mode}-source-hash`,
				repositoryCommit: "0123456789abcdef",
				model: "test/provider-model",
				settingsHash: "settings-hash",
				sessionRef: `${sopId}-${mode}-${run}-session`,
				runRef: `${sopId}-${mode}-${run}-run`,
				measuredAt: `2026-07-11T00:00:${String(run).padStart(2, "0")}.000Z`,
				evidenceRef: `${sopId}-${mode}-${run}-evidence.json`,
				qualityRubricRef: "workflow-quality-rubric-v1",
				resultArtifactHash: `${sopId}-${mode}-${run}-result-hash`,
				agentCount: mode === "skill" ? 1 : 3,
				orchestrationTokens: mode === "skill" ? 1_000 : 650,
				mainContextGrowthTokens: mode === "skill" ? 2_000 : 900,
				totalTokens: mode === "skill" ? 12_000 : 11_500,
				qualityScore: 0.9,
				firstPass: true,
				...(mode === "managed"
					? {
							approvedTokenLimit: 12_000,
							approvalBoundary: `${sopId}-${run}-approval-boundary`,
							nodeGraphHash: `${sopId}-${run}-node-graph-hash`,
						}
					: {}),
			});
		}
	}
	return samples;
}

describe("Workflow token report", () => {
	test("passes only after five comparable SOPs meet token, context, quality and budget gates", () => {
		const samples = ["release", "audit", "triage", "migration", "docs"].flatMap(samplesForSop);

		const report = buildWorkflowTokenReport(samples);

		expect(report.status).toBe("passed");
		expect(report.sopCount).toBe(5);
		expect(report.orchestrationReduction).toBe(0.35);
		expect(report.contextGrowthReduction).toBe(0.55);
		expect(report.gates.every(gate => gate.passed)).toBe(true);
	});

	test("reports insufficient data instead of claiming savings from a small sample", () => {
		const report = buildWorkflowTokenReport(samplesForSop("release"));

		expect(report.status).toBe("insufficient_data");
		expect(report.gates.find(gate => gate.name === "sample_coverage")).toMatchObject({
			passed: false,
			actual: 1,
			required: 5,
		});
	});

	test("fails rollout when quality regresses or a Managed run exceeds its approved budget", () => {
		const samples = ["release", "audit", "triage", "migration", "docs"].flatMap(samplesForSop);
		const changed = samples.map(sample =>
			sample.mode === "managed"
				? {
						...sample,
						qualityScore: 0.8,
						approvedTokenLimit: sample.sampleId !== "release-managed-1" ? 12_000 : 10_000,
					}
				: sample,
		);

		const report = buildWorkflowTokenReport(changed);

		expect(report.status).toBe("failed");
		expect(report.gates.find(gate => gate.name === "quality_no_regression")?.passed).toBe(false);
		expect(report.gates.find(gate => gate.name === "managed_within_budget")?.passed).toBe(false);
	});

	test("rejects duplicate or invalid evidence before aggregation", () => {
		const sample = samplesForSop("release")[0]!;
		expect(() => buildWorkflowTokenReport([sample, sample])).toThrow("Duplicate Workflow benchmark sampleId");
		expect(() => buildWorkflowTokenReport([{ ...sample, qualityScore: 1.1 }])).toThrow(
			"qualityScore must be between 0 and 1",
		);
	});

	test("rejects duplicate run evidence even when sample ids differ", () => {
		const sample = samplesForSop("release").find(item => item.mode === "managed");
		if (!sample) throw new Error("Expected a Managed sample");
		expect(() => buildWorkflowTokenReport([sample, { ...sample, sampleId: "forged-copy" }])).toThrow(
			"Duplicate Workflow benchmark run",
		);
	});

	test("rejects unpaired Skill or Managed evidence instead of letting it affect rollout medians", () => {
		const samples = ["release", "audit", "triage", "migration", "docs"]
			.flatMap(samplesForSop)
			.map(sample => (sample.mode === "managed" ? { ...sample, run: sample.run + 10 } : sample));

		expect(() => buildWorkflowTokenReport(samples)).toThrow("must include both Skill and Managed evidence");
	});

	test("rejects mismatched model or fixture provenance inside a comparison pair", () => {
		const samples = samplesForSop("release").map(sample =>
			sample.mode === "managed" && sample.run === 1 ? { ...sample, model: "different/model" } : sample,
		);

		expect(() => buildWorkflowTokenReport(samples)).toThrow("mismatched model");
	});

	test("requires unique execution and evidence references", () => {
		const samples = samplesForSop("release");
		const skill = samples.find(sample => sample.mode === "skill" && sample.run === 1);
		const managed = samples.find(sample => sample.mode === "managed" && sample.run === 1);
		if (!skill || !managed) throw new Error("Expected one benchmark pair");

		expect(() =>
			buildWorkflowTokenReport(
				samples.map(sample =>
					sample === managed ? { ...sample, sessionRef: skill.sessionRef, runRef: skill.runRef } : sample,
				),
			),
		).toThrow("Duplicate Workflow benchmark execution reference");
		expect(() =>
			buildWorkflowTokenReport(
				samples.map(sample => (sample === managed ? { ...sample, evidenceRef: skill.evidenceRef } : sample)),
			),
		).toThrow("Duplicate Workflow benchmark evidenceRef");
	});
});
