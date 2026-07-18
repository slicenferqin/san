#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { $ } from "bun";
import {
	type BenchmarkEvidenceChainSpec,
	type BenchmarkEvidenceRecord,
	generateBenchmarkEvidenceRecord,
} from "../../scripts/san-context-steady-benchmark-evidence";

type TaskId = "L1" | "L2" | "L3" | "L4" | "L5";

interface VerifierConfig {
	hiddenTest: string;
	publicTest: string;
	allowedPaths: string[];
}

interface EvidenceArtifact {
	schemaVersion: 1;
	spec: BenchmarkEvidenceChainSpec;
	state: {
		expectedSteps: number;
		completedSteps: number;
		lastProof?: string;
		records: BenchmarkEvidenceRecord[];
	};
}

const CONFIG: Record<TaskId, VerifierConfig> = {
	L1: {
		hiddenTest: "l1-routing.test.ts",
		publicTest: "test/routing.test.ts",
		allowedPaths: ["src/routing/", "test/routing.test.ts"],
	},
	L2: {
		hiddenTest: "l2-retry.test.ts",
		publicTest: "test/retry.test.ts",
		allowedPaths: ["src/retry/", "test/retry.test.ts"],
	},
	L3: {
		hiddenTest: "l3-policy.test.ts",
		publicTest: "test/policy.test.ts",
		allowedPaths: ["src/policy/", "test/policy.test.ts"],
	},
	L4: {
		hiddenTest: "l4-catalog.test.ts",
		publicTest: "test/catalog.test.ts",
		allowedPaths: ["src/catalog/", "test/catalog.test.ts", "docs/catalog.md"],
	},
	L5: {
		hiddenTest: "l5-incident.test.ts",
		publicTest: "test/incident.test.ts",
		allowedPaths: ["src/incident/", "test/incident.test.ts", "evidence.ndjson", "incident-report.json"],
	},
};

function parseTaskId(value: string | undefined): TaskId {
	if (value === "L1" || value === "L2" || value === "L3" || value === "L4" || value === "L5") return value;
	throw new Error(`Verifier task id must be one of L1-L5, received ${value ?? "<missing>"}`);
}

async function changedFiles(workspace: string): Promise<string[]> {
	const root = await $`git rev-list --max-parents=0 HEAD`.cwd(workspace).quiet().nothrow();
	if (root.exitCode !== 0) throw new Error(`Cannot resolve benchmark baseline: ${root.stderr.toString()}`);
	const revision = root.text().trim().split("\n")[0];
	if (!revision) throw new Error(`Benchmark workspace has no root commit: ${workspace}`);
	const diff = await $`git diff --name-only ${revision}`.cwd(workspace).quiet().nothrow();
	if (diff.exitCode !== 0) throw new Error(`Cannot inspect benchmark diff: ${diff.stderr.toString()}`);
	return diff
		.text()
		.split("\n")
		.map(value => value.trim())
		.filter(Boolean);
}

function assertChangeScope(taskId: TaskId, files: readonly string[]): void {
	if (files.length === 0) throw new Error(`${taskId} produced no workspace changes`);
	const allowed = CONFIG[taskId].allowedPaths;
	const unrelated = files.filter(file => !allowed.some(prefix => file === prefix || file.startsWith(prefix)));
	if (unrelated.length > 0) {
		throw new Error(`${taskId} changed files outside its task boundary: ${unrelated.join(", ")}`);
	}
}

function parseEvidenceArtifact(value: unknown, filePath: string): EvidenceArtifact {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`L5 evidence artifact is not an object: ${filePath}`);
	}
	const artifact = value as Partial<EvidenceArtifact>;
	if (artifact.schemaVersion !== 1 || !artifact.spec || !artifact.state) {
		throw new Error(`L5 evidence artifact has an unsupported shape: ${filePath}`);
	}
	return artifact as EvidenceArtifact;
}

async function verifyEvidenceChain(workspace: string, evidenceFile: string | undefined): Promise<void> {
	if (!evidenceFile) throw new Error("L5 verifier requires the trusted evidence-state artifact path");
	const artifact = parseEvidenceArtifact(await Bun.file(evidenceFile).json(), evidenceFile);
	const { spec, state } = artifact;
	if (state.expectedSteps !== spec.steps || state.completedSteps !== spec.steps) {
		throw new Error(
			`L5 evidence chain incomplete: completed=${state.completedSteps}, expected=${spec.steps}, stateExpected=${state.expectedSteps}`,
		);
	}
	if (!state.lastProof) throw new Error("L5 evidence chain completed without a final proof");
	const expected = Array.from({ length: spec.steps }, (_, index) =>
		generateBenchmarkEvidenceRecord(spec.seed, index + 1, spec.steps),
	);
	if (!Bun.deepEquals(state.records, expected)) {
		throw new Error("L5 trusted evidence state does not match the deterministic benchmark corpus");
	}
	const workspaceEvidencePath = path.join(workspace, "evidence.ndjson");
	const workspaceRecords: unknown = Bun.JSONL.parse(await Bun.file(workspaceEvidencePath).text());
	if (!Array.isArray(workspaceRecords) || !Bun.deepEquals(workspaceRecords, expected)) {
		throw new Error(
			`L5 workspace evidence must contain all ${spec.steps} RECORD objects exactly once and in step order`,
		);
	}
}

async function runTests(taskId: TaskId, workspace: string, evidenceFile: string | undefined): Promise<void> {
	const config = CONFIG[taskId];
	const hiddenSource = path.join(import.meta.dir, "hidden", config.hiddenTest);
	const hiddenTarget = path.join(workspace, ".san-benchmark-hidden.test.ts");
	await fs.copyFile(hiddenSource, hiddenTarget);
	try {
		const result = await $`bun test ${config.publicTest} ${hiddenTarget}`
			.cwd(workspace)
			.env({ ...process.env, SAN_BENCH_EVIDENCE_FILE: evidenceFile ?? "" })
			.quiet()
			.nothrow();
		await Bun.write(Bun.stdout, result.stdout);
		await Bun.write(Bun.stderr, result.stderr);
		if (result.exitCode !== 0) {
			throw new Error(`${taskId} public/hidden verifier tests failed with exit code ${result.exitCode}`);
		}
	} finally {
		await fs.rm(hiddenTarget, { force: true });
	}
}

const taskId = parseTaskId(Bun.argv[2]);
const workspace = Bun.argv[3] ? path.resolve(Bun.argv[3]) : undefined;
const evidenceFile = Bun.argv[4] ? path.resolve(Bun.argv[4]) : undefined;
if (!workspace) throw new Error("Verifier requires an absolute benchmark workspace path");

assertChangeScope(taskId, await changedFiles(workspace));
if (taskId === "L5") await verifyEvidenceChain(workspace, evidenceFile);
await runTests(taskId, workspace, evidenceFile);
