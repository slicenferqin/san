import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildWorkflowTokenReport,
	type WorkflowBenchmarkEvidenceManifest,
	type WorkflowBenchmarkMode,
	type WorkflowBenchmarkSample,
} from "../../src/workflows/token-report";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function digestText(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeArtifact(root: string, name: string, value: object): Promise<{ ref: string; hash: string }> {
	const text = JSON.stringify(value);
	const ref = path.join(root, name);
	await Bun.write(ref, text);
	return { ref, hash: digestText(text) };
}

async function evidenceFor(samples: readonly WorkflowBenchmarkSample[]): Promise<string[]> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-workflow-token-evidence-"));
	tempDirs.push(root);
	return Promise.all(
		samples.map(async sample => {
			const providerRequests = Array.from({ length: sample.agentCount }, (_, index) => ({
				agentRef: `${sample.sampleId}-agent-${index + 1}`,
				totalTokens:
					Math.floor(sample.orchestrationTokens / sample.agentCount) +
					(index < sample.orchestrationTokens % sample.agentCount ? 1 : 0),
			}));
			const ledger = await writeArtifact(root, `${sample.sampleId}-ledger.json`, {
				runRef: sample.runRef,
				sourceHash: sample.sourceHash,
				providerRequests,
				...(sample.mode === "managed"
					? {
							approvedTokenLimit: sample.approvedTokenLimit,
							approvalBoundary: sample.approvalBoundary,
							nodeGraph: [{ nodeId: `${sample.sampleId}-node`, inputHash: sample.nodeGraphHash }],
						}
					: {}),
			});
			const session = await writeArtifact(root, `${sample.sampleId}-session.json`, {
				sessionRef: sample.sessionRef,
				model: sample.model,
				settingsHash: sample.settingsHash,
				measuredAt: sample.measuredAt,
				usageBeforeTokens: 100,
				usageAfterTokens: 100 + sample.totalTokens,
				mainContextBeforeTokens: 50,
				mainContextAfterTokens: 50 + sample.mainContextGrowthTokens,
			});
			const result = await writeArtifact(root, `${sample.sampleId}-result.json`, {
				fixtureHash: sample.fixtureHash,
				qualityRubricRef: sample.qualityRubricRef,
				qualityScore: sample.qualityScore,
				firstPass: sample.firstPass,
			});
			const manifest: WorkflowBenchmarkEvidenceManifest = {
				schemaVersion: 1,
				sampleId: sample.sampleId,
				sopId: sample.sopId,
				run: sample.run,
				mode: sample.mode,
				fixtureHash: sample.fixtureHash,
				sourceHash: sample.sourceHash,
				repositoryCommit: sample.repositoryCommit,
				ledgerRef: path.basename(ledger.ref),
				ledgerHash: ledger.hash,
				sessionRef: path.basename(session.ref),
				sessionHash: session.hash,
				resultRef: path.basename(result.ref),
				resultHash: result.hash,
			};
			const evidence = path.join(root, `${sample.sampleId}-evidence.json`);
			await Bun.write(evidence, JSON.stringify(manifest));
			return evidence;
		}),
	);
}

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
	test("passes only after five comparable SOPs meet token, context, quality and budget gates", async () => {
		const samples = ["release", "audit", "triage", "migration", "docs"].flatMap(samplesForSop);

		const report = await buildWorkflowTokenReport(await evidenceFor(samples));

		expect(report.status).toBe("passed");
		expect(report.sopCount).toBe(5);
		expect(report.orchestrationReduction).toBe(0.35);
		expect(report.contextGrowthReduction).toBe(0.55);
		expect(report.gates.every(gate => gate.passed)).toBe(true);
	});

	test("reports insufficient data instead of claiming savings from a small sample", async () => {
		const report = await buildWorkflowTokenReport(await evidenceFor(samplesForSop("release")));

		expect(report.status).toBe("insufficient_data");
		expect(report.gates.find(gate => gate.name === "sample_coverage")).toMatchObject({
			passed: false,
			actual: 1,
			required: 5,
		});
	});

	test("fails rollout when quality regresses or a Managed run exceeds its approved budget", async () => {
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

		const report = await buildWorkflowTokenReport(await evidenceFor(changed));

		expect(report.status).toBe("failed");
		expect(report.gates.find(gate => gate.name === "quality_no_regression")?.passed).toBe(false);
		expect(report.gates.find(gate => gate.name === "managed_within_budget")?.passed).toBe(false);
	});

	test("rejects duplicate or invalid evidence before aggregation", async () => {
		const sample = samplesForSop("release")[0]!;
		await expect(buildWorkflowTokenReport(await evidenceFor([sample, sample]))).rejects.toThrow(
			"Duplicate Workflow benchmark sampleId",
		);
		await expect(buildWorkflowTokenReport(await evidenceFor([{ ...sample, qualityScore: 1.1 }]))).rejects.toThrow(
			"qualityScore must be between 0 and 1",
		);
	});

	test("rejects duplicate run evidence even when sample ids differ", async () => {
		const sample = samplesForSop("release").find(item => item.mode === "managed");
		if (!sample) throw new Error("Expected a Managed sample");
		await expect(
			buildWorkflowTokenReport(await evidenceFor([sample, { ...sample, sampleId: "forged-copy" }])),
		).rejects.toThrow("Duplicate Workflow benchmark run");
	});

	test("rejects unpaired Skill or Managed evidence instead of letting it affect rollout medians", async () => {
		const samples = ["release", "audit", "triage", "migration", "docs"]
			.flatMap(samplesForSop)
			.map(sample => (sample.mode === "managed" ? { ...sample, run: sample.run + 10 } : sample));

		await expect(buildWorkflowTokenReport(await evidenceFor(samples))).rejects.toThrow(
			"must include both Skill and Managed evidence",
		);
	});

	test("rejects mismatched model or fixture provenance inside a comparison pair", async () => {
		const samples = samplesForSop("release").map(sample =>
			sample.mode === "managed" && sample.run === 1 ? { ...sample, model: "different/model" } : sample,
		);

		await expect(buildWorkflowTokenReport(await evidenceFor(samples))).rejects.toThrow("mismatched model");
	});

	test("requires unique execution references and rejects tampered artifacts", async () => {
		const samples = samplesForSop("release");
		const skill = samples.find(sample => sample.mode === "skill" && sample.run === 1);
		const managed = samples.find(sample => sample.mode === "managed" && sample.run === 1);
		if (!skill || !managed) throw new Error("Expected one benchmark pair");

		await expect(
			buildWorkflowTokenReport(
				await evidenceFor(
					samples.map(sample =>
						sample === managed ? { ...sample, sessionRef: skill.sessionRef, runRef: skill.runRef } : sample,
					),
				),
			),
		).rejects.toThrow("Duplicate Workflow benchmark execution reference");

		const [evidence] = await evidenceFor([skill]);
		if (!evidence) throw new Error("Expected benchmark evidence path");
		const manifest = (await Bun.file(evidence).json()) as WorkflowBenchmarkEvidenceManifest;
		await Bun.write(path.resolve(path.dirname(evidence), manifest.resultRef), "{}\n");
		await expect(buildWorkflowTokenReport([evidence])).rejects.toThrow("result hash mismatch");
	});
});
