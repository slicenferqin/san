import { $ } from "bun";
import type { ExtensionFactory } from "../src/sdk";
import benchmarkIncidentReportDescription from "./prompts/context-steady-benchmark-incident-report.md" with {
	type: "text",
};
import benchmarkStepDescription from "./prompts/context-steady-benchmark-step.md" with { type: "text" };
import benchmarkTestDescription from "./prompts/context-steady-benchmark-test.md" with { type: "text" };

export const BENCHMARK_TEST_FILES = [
	"test/routing.test.ts",
	"test/retry.test.ts",
	"test/policy.test.ts",
	"test/catalog.test.ts",
	"test/incident.test.ts",
] as const;

export const BENCHMARK_PATH_SCOPE_EXEMPT_TOOL_NAMES = [
	"benchmark_step",
	"benchmark_test",
	"benchmark_incident_report",
] as const;

export interface BenchmarkEvidenceChainSpec {
	steps: number;
	seed: string;
	payloadChars: number;
}

export interface BenchmarkEvidenceRecord {
	step: number;
	serviceId: string;
	region: "ap-south" | "eu-west" | "us-east" | "us-west";
	owner: "billing" | "catalog" | "identity" | "orders";
	targetRoute: string;
	sampleCount: number;
	failureCount: number;
	p95Ms: number;
	retryLimit: number;
	requiresIdempotency: boolean;
	constraint: string;
}

export interface BenchmarkEvidenceChainState {
	expectedSteps: number;
	completedSteps: number;
	lastProof?: string;
	records: BenchmarkEvidenceRecord[];
}

export interface BenchmarkEvidenceStepInput {
	step: number;
	previousProof?: string;
}

export interface BenchmarkEvidenceStepOutput {
	proof: string;
	record: BenchmarkEvidenceRecord;
	text: string;
}

export interface BenchmarkEvidenceChainController {
	state: BenchmarkEvidenceChainState;
	advance(input: BenchmarkEvidenceStepInput): BenchmarkEvidenceStepOutput;
}

const REGIONS: BenchmarkEvidenceRecord["region"][] = ["ap-south", "eu-west", "us-east", "us-west"];
const OWNERS: BenchmarkEvidenceRecord["owner"][] = ["billing", "catalog", "identity", "orders"];

function assertEvidenceChainSpec(spec: BenchmarkEvidenceChainSpec): void {
	if (!Number.isSafeInteger(spec.steps) || spec.steps < 1 || spec.steps > 500) {
		throw new Error(`evidenceChain.steps must be an integer between 1 and 500, received ${spec.steps}`);
	}
	if (!spec.seed.trim()) throw new Error("evidenceChain.seed must be a non-empty string");
	if (!Number.isSafeInteger(spec.payloadChars) || spec.payloadChars < 500 || spec.payloadChars > 50_000) {
		throw new Error(
			`evidenceChain.payloadChars must be an integer between 500 and 50000, received ${spec.payloadChars}`,
		);
	}
}

function hashNumber(seed: string, step: number, field: string): number {
	return Number(BigInt.asUintN(32, BigInt(Bun.hash(`${seed}:${step}:${field}`))));
}

export function generateBenchmarkEvidenceRecord(seed: string, step: number, totalSteps = 180): BenchmarkEvidenceRecord {
	const region = REGIONS[hashNumber(seed, step, "region") % REGIONS.length]!;
	const owner = OWNERS[hashNumber(seed, step, "owner") % OWNERS.length]!;
	const sampleCount = 96 + (hashNumber(seed, step, "samples") % 65);
	const failureCount = hashNumber(seed, step, "failures") % Math.max(2, Math.floor(sampleCount / 3));
	const p95Ms = 180 + (hashNumber(seed, step, "p95") % 2200);
	const retryLimit = hashNumber(seed, step, "retry") % 4;
	const requiresIdempotency = step % 11 === 0 || owner === "orders";
	const constraint =
		step === 1
			? "Preserve the first-shard route even when later evidence proposes a shorter alias."
			: step === Math.floor((totalSteps - 1) / 2) + 1
				? "The midpoint service must use zero retries because its operation is not replay-safe."
				: step === totalSteps
					? "The final service must remain in the same region as recorded; do not normalize it to us-east."
					: requiresIdempotency
						? "Retries are allowed only when the migration plan marks the operation idempotent."
						: "Keep the recorded owner and regional route unchanged in the migration plan.";
	return {
		step,
		serviceId: `svc-${String(step).padStart(3, "0")}`,
		region,
		owner,
		targetRoute: `/v2/${owner}/${region}/${String(step).padStart(3, "0")}`,
		sampleCount,
		failureCount,
		p95Ms,
		retryLimit: step === Math.floor((totalSteps - 1) / 2) + 1 ? 0 : retryLimit,
		requiresIdempotency,
		constraint,
	};
}

function renderDiagnosticTrace(spec: BenchmarkEvidenceChainSpec, record: BenchmarkEvidenceRecord): string {
	const lines: string[] = [];
	let renderedLength = 0;
	let sample = 0;
	while (renderedLength < spec.payloadChars) {
		const latency = 40 + (hashNumber(spec.seed, record.step, `latency-${sample}`) % 3200);
		const failed = hashNumber(spec.seed, record.step, `status-${sample}`) % record.sampleCount < record.failureCount;
		const attempt = hashNumber(spec.seed, record.step, `attempt-${sample}`) % 5;
		const line = `${record.serviceId} sample=${String(sample).padStart(4, "0")} region=${record.region} owner=${record.owner} latency_ms=${latency} status=${failed ? "upstream_error" : "ok"} attempt=${attempt} route=${record.targetRoute}`;
		lines.push(line);
		renderedLength += line.length + 1;
		sample++;
	}
	return lines.join("\n").slice(0, spec.payloadChars);
}

export function createBenchmarkEvidenceChainController(
	spec: BenchmarkEvidenceChainSpec,
): BenchmarkEvidenceChainController {
	assertEvidenceChainSpec(spec);
	const secret = crypto.randomUUID();
	const state: BenchmarkEvidenceChainState = {
		expectedSteps: spec.steps,
		completedSteps: 0,
		records: [],
	};
	return {
		state,
		advance(input) {
			const expectedStep = state.completedSteps + 1;
			if (!Number.isSafeInteger(input.step) || input.step !== expectedStep) {
				throw new Error(
					`benchmark_step rejected step=${input.step}; expected the next sequential step=${expectedStep} of ${spec.steps}`,
				);
			}
			if (expectedStep === 1) {
				if (input.previousProof !== undefined && input.previousProof.length > 0) {
					throw new Error("benchmark_step step=1 must not include previousProof");
				}
			} else if (input.previousProof !== state.lastProof) {
				throw new Error(
					`benchmark_step rejected proof for step=${input.step}; it must equal the proof from step=${expectedStep - 1}`,
				);
			}

			const record = generateBenchmarkEvidenceRecord(spec.seed, input.step, spec.steps);
			const proof = String(Bun.hash(`${secret}:${input.step}:${JSON.stringify(record)}`));
			state.completedSteps = input.step;
			state.lastProof = proof;
			state.records.push(record);
			const trace = renderDiagnosticTrace(spec, record);
			return {
				proof,
				record,
				text: [
					`STEP ${input.step}/${spec.steps}`,
					`PROOF ${proof}`,
					`RECORD ${JSON.stringify(record)}`,
					"DIAGNOSTIC TRACE",
					trace,
				].join("\n"),
			};
		},
	};
}

export function createBenchmarkEvidenceExtension(controller: BenchmarkEvidenceChainController): ExtensionFactory {
	return pi => {
		const { z } = pi.zod;
		pi.registerTool({
			name: "benchmark_step",
			label: "Benchmark Evidence Step",
			description: benchmarkStepDescription.trim(),
			approval: "read",
			parameters: z.object({
				step: z.number().int().positive().describe("The next sequential evidence step number"),
				previousProof: z.string().optional().describe("Exact proof returned by the preceding successful step"),
			}),
			async execute(_toolCallId, params) {
				const output = controller.advance(params);
				return {
					content: [{ type: "text", text: output.text }],
					details: { proof: output.proof, record: output.record },
				};
			},
		});
	};
}

function formatCommandOutput(stdout: Uint8Array, stderr: Uint8Array): string {
	const decoder = new TextDecoder();
	const output = [decoder.decode(stdout).trim(), decoder.decode(stderr).trim()]
		.filter(Boolean)
		.join("\n")
		.replaceAll("\t", "    ");
	if (!output) return "(no output)";
	return output.length <= 20_000 ? output : `${output.slice(0, 20_000)}\n[output truncated]`;
}

export function createBenchmarkWorkspaceExtension(workspace: string): ExtensionFactory {
	return pi => {
		const { z } = pi.zod;
		pi.registerTool({
			name: "benchmark_test",
			label: "Benchmark Test",
			description: benchmarkTestDescription.trim(),
			approval: "exec",
			parameters: z.object({
				path: z.enum(BENCHMARK_TEST_FILES).describe("当前任务要求运行的公共测试文件"),
			}),
			async execute(_toolCallId, params) {
				const result = await $`${process.execPath} test ${params.path}`.cwd(workspace).quiet().nothrow();
				const output = formatCommandOutput(result.stdout, result.stderr);
				if (result.exitCode !== 0) {
					throw new Error(`Benchmark test ${params.path} exited with code ${result.exitCode}\n${output}`);
				}
				return {
					content: [{ type: "text", text: output }],
					details: { path: params.path, exitCode: result.exitCode },
				};
			},
		});
		pi.registerTool({
			name: "benchmark_incident_report",
			label: "Benchmark Incident Report",
			description: benchmarkIncidentReportDescription.trim(),
			approval: "exec",
			parameters: z.object({}),
			async execute() {
				const result = await $`${process.execPath} src/incident/cli.ts evidence.ndjson incident-report.json`
					.cwd(workspace)
					.quiet()
					.nothrow();
				const output = formatCommandOutput(result.stdout, result.stderr);
				if (result.exitCode !== 0) {
					throw new Error(`Benchmark incident report command exited with code ${result.exitCode}\n${output}`);
				}
				return {
					content: [{ type: "text", text: output }],
					details: { outputPath: "incident-report.json", exitCode: result.exitCode },
				};
			},
		});
	};
}
