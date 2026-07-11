export type WorkflowBenchmarkMode = "skill" | "managed";

export interface WorkflowBenchmarkSample {
	sampleId: string;
	sopId: string;
	run: number;
	mode: WorkflowBenchmarkMode;
	/** Hash of the shared task fixture used by both sides of this pair. */
	fixtureHash: string;
	/** Hash of the Skill or Managed source actually executed. */
	sourceHash: string;
	repositoryCommit: string;
	model: string;
	settingsHash: string;
	sessionRef: string;
	runRef: string;
	measuredAt: string;
	evidenceRef: string;
	qualityRubricRef: string;
	resultArtifactHash: string;
	agentCount: number;
	orchestrationTokens: number;
	mainContextGrowthTokens: number;
	totalTokens: number;
	qualityScore: number;
	firstPass: boolean;
	/** Required for Managed evidence; the report derives budget compliance itself. */
	approvedTokenLimit?: number;
	/** Required for Managed evidence and copied from run_approved. */
	approvalBoundary?: string;
	/** Required for Managed evidence and derived from the committed node graph. */
	nodeGraphHash?: string;
}

export interface WorkflowBenchmarkAggregate {
	mode: WorkflowBenchmarkMode;
	sampleCount: number;
	medianOrchestrationTokens: number;
	medianMainContextGrowthTokens: number;
	medianTotalTokens: number;
	medianQualityScore: number;
	firstPassRate: number;
	withinBudgetRate: number;
}

export interface WorkflowTokenGate {
	name:
		| "sample_coverage"
		| "orchestration_reduction"
		| "context_growth_reduction"
		| "quality_no_regression"
		| "first_pass_no_regression"
		| "managed_within_budget";
	passed: boolean;
	actual: number;
	required: number;
	unit: "count" | "ratio";
}

export interface WorkflowTokenReport {
	status: "passed" | "failed" | "insufficient_data";
	sopCount: number;
	runsPerModeBySop: Record<string, { skill: number; managed: number }>;
	bySop: Record<string, WorkflowTokenSopResult>;
	skill: WorkflowBenchmarkAggregate;
	managed: WorkflowBenchmarkAggregate;
	orchestrationReduction: number;
	contextGrowthReduction: number;
	gates: WorkflowTokenGate[];
}

export interface WorkflowTokenSopResult {
	skill: WorkflowBenchmarkAggregate;
	managed: WorkflowBenchmarkAggregate;
	orchestrationReduction: number;
	contextGrowthReduction: number;
}

export interface WorkflowTokenReportThresholds {
	minimumSops: number;
	minimumRunsPerMode: number;
	minimumOrchestrationReduction: number;
	minimumContextGrowthReduction: number;
}

export const DEFAULT_WORKFLOW_TOKEN_THRESHOLDS: Readonly<WorkflowTokenReportThresholds> = Object.freeze({
	minimumSops: 5,
	minimumRunsPerMode: 5,
	minimumOrchestrationReduction: 0.3,
	minimumContextGrowthReduction: 0.5,
});

function assertNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty.`);
}

function assertCanonicalTimestamp(value: string, label: string): void {
	assertNonEmpty(value, label);
	const time = Date.parse(value);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
		throw new Error(`${label} must be a canonical ISO timestamp.`);
	}
}

function assertSample(sample: WorkflowBenchmarkSample): void {
	assertNonEmpty(sample.sampleId, "Workflow benchmark sampleId");
	assertNonEmpty(sample.sopId, "Workflow benchmark sopId");
	if (sample.mode !== "skill" && sample.mode !== "managed") {
		throw new Error("Workflow benchmark mode must be skill or managed.");
	}
	if (!Number.isInteger(sample.run) || sample.run < 1) {
		throw new Error("Workflow benchmark run must be a positive integer.");
	}
	for (const [label, value] of [
		["fixtureHash", sample.fixtureHash],
		["sourceHash", sample.sourceHash],
		["repositoryCommit", sample.repositoryCommit],
		["model", sample.model],
		["settingsHash", sample.settingsHash],
		["sessionRef", sample.sessionRef],
		["runRef", sample.runRef],
		["evidenceRef", sample.evidenceRef],
		["qualityRubricRef", sample.qualityRubricRef],
		["resultArtifactHash", sample.resultArtifactHash],
	] as const) {
		assertNonEmpty(value, `Workflow benchmark ${label}`);
	}
	assertCanonicalTimestamp(sample.measuredAt, "Workflow benchmark measuredAt");
	for (const [label, value] of [
		["agentCount", sample.agentCount],
		["orchestrationTokens", sample.orchestrationTokens],
		["mainContextGrowthTokens", sample.mainContextGrowthTokens],
		["totalTokens", sample.totalTokens],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`Workflow benchmark ${label} must be a non-negative safe integer.`);
		}
	}
	if (
		sample.mode === "managed" &&
		(!Number.isSafeInteger(sample.approvedTokenLimit) || (sample.approvedTokenLimit ?? 0) <= 0)
	) {
		throw new Error("Managed Workflow benchmark approvedTokenLimit must be a positive integer.");
	}
	if (sample.mode === "managed") {
		assertNonEmpty(sample.approvalBoundary ?? "", "Managed Workflow benchmark approvalBoundary");
		assertNonEmpty(sample.nodeGraphHash ?? "", "Managed Workflow benchmark nodeGraphHash");
	}
	if (!Number.isFinite(sample.qualityScore) || sample.qualityScore < 0 || sample.qualityScore > 1) {
		throw new Error("Workflow benchmark qualityScore must be between 0 and 1.");
	}
	if (typeof sample.firstPass !== "boolean") throw new Error("Workflow benchmark firstPass must be a boolean.");
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function aggregate(
	mode: WorkflowBenchmarkMode,
	samples: readonly WorkflowBenchmarkSample[],
): WorkflowBenchmarkAggregate {
	const selected = samples.filter(sample => sample.mode === mode);
	return {
		mode,
		sampleCount: selected.length,
		medianOrchestrationTokens: median(selected.map(sample => sample.orchestrationTokens)),
		medianMainContextGrowthTokens: median(selected.map(sample => sample.mainContextGrowthTokens)),
		medianTotalTokens: median(selected.map(sample => sample.totalTokens)),
		medianQualityScore: median(selected.map(sample => sample.qualityScore)),
		firstPassRate: selected.length === 0 ? 0 : selected.filter(sample => sample.firstPass).length / selected.length,
		withinBudgetRate:
			selected.length === 0
				? 0
				: selected.filter(
						sample => sample.mode === "skill" || sample.totalTokens <= (sample.approvedTokenLimit ?? 0),
					).length / selected.length,
	};
}

function reduction(baseline: number, candidate: number): number {
	if (baseline === 0) return candidate === 0 ? 0 : -1;
	return (baseline - candidate) / baseline;
}

function noRegressionRatio(baseline: number, candidate: number): number {
	if (baseline === 0) return 1;
	return candidate / baseline;
}

function assertComparablePair(skill: WorkflowBenchmarkSample, managed: WorkflowBenchmarkSample): void {
	for (const field of ["fixtureHash", "repositoryCommit", "model", "settingsHash", "qualityRubricRef"] as const) {
		if (skill[field] !== managed[field]) {
			throw new Error(
				`Workflow benchmark pair ${skill.sopId}/${skill.run} has mismatched ${field}: ${skill[field]} != ${managed[field]}`,
			);
		}
	}
}

function validateThresholds(thresholds: WorkflowTokenReportThresholds): void {
	if (!Number.isInteger(thresholds.minimumSops) || thresholds.minimumSops < 1) {
		throw new Error("Workflow token report minimumSops must be a positive integer.");
	}
	if (!Number.isInteger(thresholds.minimumRunsPerMode) || thresholds.minimumRunsPerMode < 1) {
		throw new Error("Workflow token report minimumRunsPerMode must be a positive integer.");
	}
	for (const [name, value] of [
		["minimumOrchestrationReduction", thresholds.minimumOrchestrationReduction],
		["minimumContextGrowthReduction", thresholds.minimumContextGrowthReduction],
	] as const) {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new Error(`Workflow token report ${name} must be between 0 and 1.`);
		}
	}
}

export function buildWorkflowTokenReport(
	samples: readonly WorkflowBenchmarkSample[],
	thresholds: WorkflowTokenReportThresholds = DEFAULT_WORKFLOW_TOKEN_THRESHOLDS,
): WorkflowTokenReport {
	validateThresholds(thresholds);
	const seen = new Set<string>();
	const seenRuns = new Set<string>();
	const seenExecutionRefs = new Set<string>();
	const seenEvidenceRefs = new Set<string>();
	for (const sample of samples) {
		assertSample(sample);
		if (seen.has(sample.sampleId)) throw new Error(`Duplicate Workflow benchmark sampleId: ${sample.sampleId}`);
		seen.add(sample.sampleId);
		const runKey = `${sample.sopId}\u0000${sample.mode}\u0000${sample.run}`;
		if (seenRuns.has(runKey)) {
			throw new Error(`Duplicate Workflow benchmark run: ${sample.sopId}/${sample.mode}/${sample.run}`);
		}
		seenRuns.add(runKey);
		const executionRef = `${sample.sessionRef}\u0000${sample.runRef}`;
		if (seenExecutionRefs.has(executionRef)) {
			throw new Error(`Duplicate Workflow benchmark execution reference: ${sample.sessionRef}/${sample.runRef}`);
		}
		seenExecutionRefs.add(executionRef);
		if (seenEvidenceRefs.has(sample.evidenceRef)) {
			throw new Error(`Duplicate Workflow benchmark evidenceRef: ${sample.evidenceRef}`);
		}
		seenEvidenceRefs.add(sample.evidenceRef);
	}

	const sopIds = [...new Set(samples.map(sample => sample.sopId))].sort();
	const runsPerModeBySop = Object.create(null) as Record<string, { skill: number; managed: number }>;
	const bySop = Object.create(null) as Record<string, WorkflowTokenSopResult>;
	const pairedSamples: WorkflowBenchmarkSample[] = [];
	let coveredSops = 0;
	for (const sopId of sopIds) {
		const skillByRun = new Map(
			samples
				.filter(sample => sample.sopId === sopId && sample.mode === "skill")
				.map(sample => [sample.run, sample]),
		);
		const managedByRun = new Map(
			samples
				.filter(sample => sample.sopId === sopId && sample.mode === "managed")
				.map(sample => [sample.run, sample]),
		);
		const allRuns = new Set([...skillByRun.keys(), ...managedByRun.keys()]);
		for (const run of allRuns) {
			const skillSample = skillByRun.get(run);
			const managedSample = managedByRun.get(run);
			if (!skillSample || !managedSample) {
				throw new Error(`Workflow benchmark run ${sopId}/${run} must include both Skill and Managed evidence.`);
			}
			assertComparablePair(skillSample, managedSample);
			pairedSamples.push(skillSample, managedSample);
		}
		const counts = { skill: skillByRun.size, managed: managedByRun.size };
		runsPerModeBySop[sopId] = counts;
		if (allRuns.size >= thresholds.minimumRunsPerMode) coveredSops++;
		const sopSamples = pairedSamples.filter(sample => sample.sopId === sopId);
		const skillForSop = aggregate("skill", sopSamples);
		const managedForSop = aggregate("managed", sopSamples);
		bySop[sopId] = {
			skill: skillForSop,
			managed: managedForSop,
			orchestrationReduction: reduction(
				skillForSop.medianOrchestrationTokens,
				managedForSop.medianOrchestrationTokens,
			),
			contextGrowthReduction: reduction(
				skillForSop.medianMainContextGrowthTokens,
				managedForSop.medianMainContextGrowthTokens,
			),
		};
	}

	const skill = aggregate("skill", pairedSamples);
	const managed = aggregate("managed", pairedSamples);
	const sopResults = Object.values(bySop);
	const orchestrationReduction = median(sopResults.map(result => result.orchestrationReduction));
	const contextGrowthReduction = median(sopResults.map(result => result.contextGrowthReduction));
	const qualityRatio =
		sopResults.length === 0
			? 0
			: Math.min(
					...sopResults.map(result =>
						noRegressionRatio(result.skill.medianQualityScore, result.managed.medianQualityScore),
					),
				);
	const firstPassRatio =
		sopResults.length === 0
			? 0
			: Math.min(
					...sopResults.map(result => noRegressionRatio(result.skill.firstPassRate, result.managed.firstPassRate)),
				);
	const coveragePassed = coveredSops >= thresholds.minimumSops;
	const gates: WorkflowTokenGate[] = [
		{
			name: "sample_coverage",
			passed: coveragePassed,
			actual: coveredSops,
			required: thresholds.minimumSops,
			unit: "count",
		},
		{
			name: "orchestration_reduction",
			passed: orchestrationReduction >= thresholds.minimumOrchestrationReduction,
			actual: orchestrationReduction,
			required: thresholds.minimumOrchestrationReduction,
			unit: "ratio",
		},
		{
			name: "context_growth_reduction",
			passed: contextGrowthReduction >= thresholds.minimumContextGrowthReduction,
			actual: contextGrowthReduction,
			required: thresholds.minimumContextGrowthReduction,
			unit: "ratio",
		},
		{
			name: "quality_no_regression",
			passed: qualityRatio >= 1,
			actual: qualityRatio,
			required: 1,
			unit: "ratio",
		},
		{
			name: "first_pass_no_regression",
			passed: firstPassRatio >= 1,
			actual: firstPassRatio,
			required: 1,
			unit: "ratio",
		},
		{
			name: "managed_within_budget",
			passed: managed.sampleCount > 0 && managed.withinBudgetRate === 1,
			actual: managed.withinBudgetRate,
			required: 1,
			unit: "ratio",
		},
	];

	return {
		status: !coveragePassed ? "insufficient_data" : gates.every(gate => gate.passed) ? "passed" : "failed",
		sopCount: sopIds.length,
		runsPerModeBySop,
		bySop,
		skill,
		managed,
		orchestrationReduction,
		contextGrowthReduction,
		gates,
	};
}
