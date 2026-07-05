#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface GroundTruth {
	correctVerdict?: string;
	mustCall?: string[];
	mustExist?: string[];
	mustFix?: string[];
	mustIdentify?: string[];
	mustIdentifyRegression?: string[];
	mustImplement?: string[];
	mustNotBreak?: string[];
	mustNotContain?: string[];
	mustReject?: string[];
	mustTest?: string[];
	driftSignals?: string[];
	verdictMustAddress?: string[];
	falsePassCondition?: string;
	workerClaimIsWrong?: boolean;
	correctionSuccess?: string;
	correctionSignal?: string;
	complexityLevel?: string;
	minimumBlockers?: number;
	minimumDefects?: number;
}

interface GsarTaskSpec {
	id: string;
	label: string;
	category: string;
	primaryMetric: string;
	fixture: string;
	writesFiles: boolean;
	groundTruth: GroundTruth;
}

interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
	premiumRequests: number;
}

interface RunEvidence {
	status: string;
	finalVerdict: string | null;
	reportText: string;
	changedFiles: string[];
	testsRun: string[];
	durationMs: number;
	usage: UsageTotals;
	sessionFile?: string;
}

interface ModeTaskEvidence {
	id: string;
	label: string;
	run: number;
	fixture?: string;
	fixtureSourceCwd?: string;
	workspaceCwd?: string;
	writesFiles?: boolean;
	output: RunEvidence;
}

interface ModeEvidence {
	id: string;
	label: string;
	tasks: ModeTaskEvidence[];
}

interface BenchmarkEvidence {
	label: string;
	cwdRoot: string;
	outDir: string;
	taskFile: string;
	modes: ModeEvidence[];
}

interface ChecklistScore {
	total: number;
	covered: number;
	items: ChecklistItemScore[];
}

interface ChecklistItemScore {
	item: string;
	covered: boolean;
}

interface TaskEvaluation {
	taskId: string;
	label: string;
	mode: string;
	run: number;
	category: string;
	primaryMetric: string;
	agentVerdict: string;
	status: string;
	goalAlignmentScore: number;
	functionalCorrectnessScore: number;
	errorInterceptionScore: number;
	testQualityScore: number;
	engineeringQualityScore: number;
	totalScore: number;
	falsePass: boolean;
	driftDetected: boolean;
	correctionSuccess: boolean;
	checklists: {
		mustExist: ChecklistScore;
		mustCall: ChecklistScore;
		mustImplement: ChecklistScore;
		mustFix: ChecklistScore;
		mustIdentify: ChecklistScore;
		mustIdentifyRegression: ChecklistScore;
		mustReject: ChecklistScore;
		mustNotBreak: ChecklistScore;
		mustTest: ChecklistScore;
		mustNotContain: ChecklistScore;
		driftSignals: ChecklistScore;
		verdictMustAddress: ChecklistScore;
	};
	usage: UsageTotals;
	durationMs: number;
	workspaceCwd: string | null;
	fixtureSourceCwd: string | null;
	evidence: {
		changedFiles: string[];
		testsRun: string[];
		sessionFile?: string;
	};
}

interface ModeEvaluationSummary {
	mode: string;
	label: string;
	tasks: number;
	averageScore: number;
	falsePassRate: number;
	goalDriftRate: number;
	correctionSuccessRate: number;
	totalTokens: number;
	durationMs: number;
	qualityPer1MTokens: number | null;
	qualityPerMinute: number | null;
}

interface GsarEvaluationOutput {
	label: string;
	generatedAt: string;
	summaryPath: string;
	taskFile: string;
	modes: ModeEvaluationSummary[];
	tasks: TaskEvaluation[];
	thresholds: {
		goalDriftReductionTarget: number;
		falsePassReductionTarget: number;
		correctionSuccessTarget: number;
		qualityPerTokenFloorRatio: number;
	};
}

function argValue(name: string): string | undefined {
	const prefix = `${name}=`;
	for (let index = 2; index < Bun.argv.length; index++) {
		const value = Bun.argv[index];
		if (value === name) return Bun.argv[index + 1];
		if (value?.startsWith(prefix)) return value.slice(prefix.length);
	}
	return undefined;
}

function hasFlag(name: string): boolean {
	return Bun.argv.includes(name);
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-gsar-evaluator.ts --summary <summary.json> [options]",
		"",
		"Options:",
		"  --summary <path>       ROI/GSAR benchmark summary JSON",
		"  --task-file <path>     GSAR task file",
		"  --out <path>           Write scored JSON output",
		"  --report-out <path>    Write HTML report output",
	].join("\n");
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function resolvePath(value: string): string {
	return path.resolve(expandHome(value));
}

function defaultTaskFile(): string {
	return path.resolve(import.meta.dir, "..", "examples", "san-gsar-benchmark-tasks.json");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseUsage(value: unknown): UsageTotals {
	const record = recordValue(value);
	return {
		inputTokens: numberValue(record?.inputTokens),
		outputTokens: numberValue(record?.outputTokens),
		cacheReadTokens: numberValue(record?.cacheReadTokens),
		cacheWriteTokens: numberValue(record?.cacheWriteTokens),
		totalTokens: numberValue(record?.totalTokens),
		cost: numberValue(record?.cost),
		premiumRequests: numberValue(record?.premiumRequests),
	};
}

function parseTaskSpec(value: unknown): GsarTaskSpec {
	const record = recordValue(value);
	if (!record) throw new Error("GSAR task must be an object");
	const groundTruth = recordValue(record.groundTruth);
	const id = stringValue(record.id);
	const label = stringValue(record.label);
	const category = stringValue(record.category);
	const primaryMetric = stringValue(record.primaryMetric);
	const fixture = stringValue(record.fixture);
	const writesFiles = booleanValue(record.writesFiles);
	if (!id || !label || !category || !primaryMetric || !fixture || writesFiles === undefined || !groundTruth) {
		throw new Error(`Invalid GSAR task: ${JSON.stringify(record)}`);
	}
	return {
		id,
		label,
		category,
		primaryMetric,
		fixture,
		writesFiles,
		groundTruth: {
			correctVerdict: stringValue(groundTruth.correctVerdict),
			mustCall: stringArray(groundTruth.mustCall),
			mustExist: stringArray(groundTruth.mustExist),
			mustFix: stringArray(groundTruth.mustFix),
			mustIdentify: stringArray(groundTruth.mustIdentify),
			mustIdentifyRegression: stringArray(groundTruth.mustIdentifyRegression),
			mustImplement: stringArray(groundTruth.mustImplement),
			mustNotBreak: stringArray(groundTruth.mustNotBreak),
			mustNotContain: stringArray(groundTruth.mustNotContain),
			mustReject: stringArray(groundTruth.mustReject),
			mustTest: stringArray(groundTruth.mustTest),
			driftSignals: stringArray(groundTruth.driftSignals),
			verdictMustAddress: stringArray(groundTruth.verdictMustAddress),
			falsePassCondition: stringValue(groundTruth.falsePassCondition),
			workerClaimIsWrong: booleanValue(groundTruth.workerClaimIsWrong),
			correctionSuccess: stringValue(groundTruth.correctionSuccess),
			correctionSignal: stringValue(groundTruth.correctionSignal),
			complexityLevel: stringValue(groundTruth.complexityLevel),
			minimumBlockers: numberValue(groundTruth.minimumBlockers) || undefined,
			minimumDefects: numberValue(groundTruth.minimumDefects) || undefined,
		},
	};
}

function parseRunEvidence(value: unknown): RunEvidence {
	const record = recordValue(value) ?? {};
	return {
		status: stringValue(record.status) ?? "unknown",
		finalVerdict: stringValue(record.finalVerdict) ?? null,
		reportText: stringValue(record.reportText) ?? "",
		changedFiles: stringArray(record.changedFiles),
		testsRun: stringArray(record.testsRun),
		durationMs: numberValue(record.durationMs),
		usage: parseUsage(record.usage),
		sessionFile: stringValue(record.sessionFile),
	};
}

function parseModeTaskEvidence(value: unknown): ModeTaskEvidence {
	const record = recordValue(value);
	if (!record) throw new Error("Benchmark task evidence must be an object");
	const id = stringValue(record.id);
	const label = stringValue(record.label);
	if (!id || !label) throw new Error(`Invalid task evidence: ${JSON.stringify(record)}`);
	return {
		id,
		label,
		run: numberValue(record.run) || 1,
		fixture: stringValue(record.fixture),
		fixtureSourceCwd: stringValue(record.fixtureSourceCwd),
		workspaceCwd: stringValue(record.workspaceCwd),
		writesFiles: booleanValue(record.writesFiles),
		output: parseRunEvidence(record.output),
	};
}

function parseModeEvidence(value: unknown): ModeEvidence {
	const record = recordValue(value);
	if (!record) throw new Error("Benchmark mode evidence must be an object");
	const id = stringValue(record.id);
	const label = stringValue(record.label);
	if (!id || !label || !Array.isArray(record.tasks)) {
		throw new Error(`Invalid mode evidence: ${JSON.stringify(record)}`);
	}
	return {
		id,
		label,
		tasks: record.tasks.map(parseModeTaskEvidence),
	};
}

function parseBenchmarkEvidence(value: unknown, summaryPath: string): BenchmarkEvidence {
	const record = recordValue(value);
	if (!record || !Array.isArray(record.modes)) throw new Error(`Invalid benchmark summary: ${summaryPath}`);
	return {
		label: stringValue(record.label) ?? path.basename(summaryPath, ".json"),
		cwdRoot: stringValue(record.cwdRoot) ?? "",
		outDir: stringValue(record.outDir) ?? path.dirname(summaryPath),
		taskFile: stringValue(record.taskFile) ?? defaultTaskFile(),
		modes: record.modes.map(parseModeEvidence),
	};
}

async function readJson(filePath: string): Promise<unknown> {
	return await Bun.file(filePath).json();
}

async function loadTasks(filePath: string): Promise<Map<string, GsarTaskSpec>> {
	const data = await readJson(filePath);
	if (!Array.isArray(data)) throw new Error(`Task file must contain an array: ${filePath}`);
	return new Map(
		data.map(value => {
			const task = parseTaskSpec(value);
			return [task.id, task];
		}),
	);
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function collectTextFiles(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const entryPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				if (["node_modules", ".git", "dist", "coverage"].includes(entry.name)) continue;
				files.push(...(await collectTextFiles(entryPath)));
			} else if (entry.isFile() && /\.(ts|tsx|js|json|md|yml|yaml)$/.test(entry.name)) {
				files.push(entryPath);
			}
		}
		return files;
	} catch {
		return [];
	}
}

async function collectWorkspaceText(workspaceCwd: string | undefined): Promise<string> {
	if (!workspaceCwd) return "";
	const files = await collectTextFiles(workspaceCwd);
	const parts: string[] = [];
	for (const file of files) {
		const relative = path.relative(workspaceCwd, file);
		const text = await readTextIfExists(file);
		parts.push(`\n--- ${relative} ---\n${text.slice(0, 50000)}`);
	}
	return parts.join("\n");
}

function normalize(value: string): string {
	return value.toLowerCase();
}

function includesAll(text: string, values: readonly string[]): boolean {
	const haystack = normalize(text);
	return values.every(value => haystack.includes(normalize(value)));
}

function includesAny(text: string, values: readonly string[]): boolean {
	const haystack = normalize(text);
	return values.some(value => haystack.includes(normalize(value)));
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		const next = text.indexOf(needle, index);
		if (next === -1) return count;
		count++;
		index = next + needle.length;
	}
}

function finalVerdict(evidence: RunEvidence): string {
	return normalize(evidence.finalVerdict ?? evidence.status);
}

function verdictIsPass(evidence: RunEvidence): boolean {
	const verdict = finalVerdict(evidence);
	return verdict === "pass" || verdict === "passed" || evidence.status === "passed";
}

function verdictMatches(evidence: RunEvidence, expected: string | undefined): boolean {
	if (!expected) return true;
	const expectedValue = normalize(expected);
	if (expectedValue.includes("needs_fix")) return includesAny(finalVerdict(evidence), ["needs_fix", "blocked"]);
	if (expectedValue.includes("blocked")) return includesAny(finalVerdict(evidence), ["needs_fix", "blocked"]);
	if (expectedValue.includes("pass")) return verdictIsPass(evidence);
	return includesAny(finalVerdict(evidence), [expectedValue]);
}

function hasKvStoreSignatures(text: string): boolean {
	return includesAll(text, ["get(key: string)", "set(key: string", "delete(key: string)", "list(): string[]", "cas("]);
}

function coveredByKnownTask(
	taskId: string,
	item: string,
	workspaceText: string,
	reportText: string,
): boolean | undefined {
	const itemText = normalize(item);
	const combined = `${workspaceText}\n${reportText}`;
	switch (taskId) {
		case "GS-01": {
			if (itemText.includes("batch-set") || itemText.includes("batch set"))
				return includesAny(workspaceText, ["batchset", "batch-set", "batch set"]);
			if (itemText.includes("authorize")) {
				return (
					includesAny(workspaceText, ["batchset", "batch-set"]) &&
					countOccurrences(workspaceText, "authorize(") > 1
				);
			}
			if (itemText.includes("atomic") || itemText.includes("rollback")) {
				return (
					includesAny(combined, ["rollback", "snapshot", "restore", "atomic"]) &&
					includesAny(workspaceText, ["batchset", "batch-set"])
				);
			}
			if (itemText.includes("existing kvstore method signatures")) return hasKvStoreSignatures(workspaceText);
			if (itemText.includes("existing test cases")) return includesAll(workspaceText, ["cas succeeds", "cas fails"]);
			if (itemText.includes("batch rollback"))
				return (
					includesAny(workspaceText, ["batch rollback", "rollback", "partial"]) &&
					includesAny(workspaceText, ["test(", "it("])
				);
			break;
		}
		case "GS-02": {
			if (itemText.includes("deadletterqueue")) return includesAny(workspaceText, ["deadletterqueue"]);
			if (itemText.includes("handler exceptions")) return includesAll(workspaceText, ["catch", "deadletter"]);
			if (itemText.includes("unknown types")) return includesAll(workspaceText, ["!handler", "rejected"]);
			if (itemText.includes("processreceipt"))
				return includesAll(workspaceText, ["accepted", "rejected", "deadletter"]);
			if (itemText.includes("dead-letter accumulation"))
				return includesAny(workspaceText, ["dead-letter accumulation", "deadletterqueue", "deadletter"]);
			if (itemText.includes("unknown event type")) return includesAll(workspaceText, ["unknown", "rejected"]);
			break;
		}
		case "GS-03": {
			if (itemText.includes("wall-clock") || itemText.includes("monotonic"))
				return includesAny(reportText, ["wall clock", "wall-clock", "monotonic", "date.now", "单调"]);
			if (itemText.includes("reset"))
				return (
					includesAll(reportText, ["reset"]) &&
					includesAny(reportText, ["in-flight", "inflight", "已获取", "进行中"])
				);
			if (itemText.includes("ci/cd")) return includesAny(reportText.slice(-1600), ["ci/cd", "cicd"]);
			if (itemText.includes("readme")) return includesAny(reportText.slice(-1600), ["readme"]);
			if (itemText.includes("dependency"))
				return includesAny(reportText.slice(-1600), ["dependency", "dependencies", "依赖"]);
			if (itemText.includes("all 4 hard constraints"))
				return includesAny(reportText, [
					"constraint #1",
					"constraint #2",
					"constraint #3",
					"constraint #4",
					"4 个硬约束",
					"四个硬约束",
				]);
			break;
		}
		case "SA-01": {
			if (itemText.includes("authorize"))
				return includesAny(reportText, ["authorize", "permission", "rbac", "授权"]);
			if (itemText.includes("cas")) return includesAny(reportText, ["cas", "compare", "version", "并发", "覆盖"]);
			if (itemText.includes("get() returns expired")) return includesAny(reportText, ["expired", "ttl", "过期"]);
			if (itemText.includes("list() includes expired"))
				return includesAll(reportText, ["list"]) && includesAny(reportText, ["expired", "ttl", "过期"]);
			break;
		}
		case "SA-02": {
			if (itemText.includes("ttl")) return includesAny(reportText, ["ttl", "expiration", "expired", "过期"]);
			if (itemText.includes("authorize")) return includesAny(reportText, ["authorize", "permission", "授权"]);
			if (itemText.includes("concurrent") || itemText.includes("cas"))
				return includesAny(reportText, ["cas", "concurrent", "version", "并发"]);
			if (itemText.includes("tautological"))
				return includesAny(reportText, ["tautological", "tobedefined", "同义反复", "空洞"]);
			if (itemText.includes("list()"))
				return includesAll(reportText, ["list"]) && includesAny(reportText, ["expired", "ttl", "过期"]);
			break;
		}
		case "SA-03": {
			if (itemText.includes("tryconsumeasync")) return includesAny(workspaceText, ["tryconsumeasync"]);
			if (itemText.includes("reset"))
				return (
					includesAll(reportText, ["reset"]) &&
					includesAny(reportText, ["pending", "in-flight", "inflight", "等待"])
				);
			if (itemText.includes("atomicity") || itemText.includes("mutable tokens")) {
				return includesAny(reportText, ["atomic", "原子", "concurrent", "并发", "tokens"]);
			}
			break;
		}
		case "CR-01": {
			if (itemText.includes("unknown event")) return includesAll(workspaceText, ["!handler", "rejected"]);
			if (itemText.includes("handler exceptions")) return includesAll(workspaceText, ["catch", "deadletter"]);
			if (itemText.includes("retry") || itemText.includes("batching") || itemText.includes("parallel")) {
				return (
					!includesAny(workspaceText, ["retry", "batch", "parallel"]) ||
					includesAny(reportText, ["scope", "原始", "两个问题"])
				);
			}
			break;
		}
		case "CR-02": {
			if (itemText.includes("worker"))
				return includesAny(reportText, ["reject", "wrong", "incorrect", "blocked", "不接受", "错误"]);
			if (itemText.includes("constraint #3"))
				return includesAll(reportText, ["reset"]) && includesAny(reportText, ["in-flight", "inflight", "进行中"]);
			if (itemText.includes("constraint #4"))
				return includesAny(reportText, ["date.now", "wall clock", "monotonic", "单调"]);
			break;
		}
		case "ROI-01": {
			if (itemText.includes("peek()"))
				return includesAny(workspaceText, ["peek("]) && includesAll(workspaceText, ["tokens", "nextrefillms"]);
			if (itemText.includes("existing consume"))
				return includesAll(workspaceText, ["consume(tokens", "remaining()", "reset()"]);
			if (itemText.includes("does not consume"))
				return includesAny(workspaceText, ["does not consume", "not consume", "不消耗"]);
			break;
		}
		case "ROI-02": {
			if (itemText.includes("three-state")) return includesAll(workspaceText, ["closed", "open", "half-open"]);
			if (itemText.includes("failure threshold"))
				return includesAny(workspaceText, ["threshold", "failurethreshold"]);
			if (itemText.includes("probe")) return includesAny(workspaceText, ["probe", "half-open"]);
			if (itemText.includes("event emission"))
				return includesAny(workspaceText, ["eventpipeline", "emit", "register", "process("]);
			if (itemText.includes("getstate")) return includesAll(workspaceText, ["getstate", "getmetrics"]);
			if (itemText.includes("existing eventpipeline"))
				return includesAny(workspaceText, ["createeventpipeline", "eventpipeline"]);
			break;
		}
	}
	return undefined;
}

function genericCovered(item: string, corpus: string): boolean {
	const itemText = normalize(item);
	const corpusText = normalize(corpus);
	const directTokens = itemText
		.split(/[^a-z0-9_#.-]+/i)
		.map(token => token.trim())
		.filter(
			token => token.length >= 4 && !["must", "with", "from", "that", "this", "existing", "method"].includes(token),
		);
	if (directTokens.length === 0) return false;
	const covered = directTokens.filter(token => corpusText.includes(token)).length;
	return covered / directTokens.length >= 0.5;
}

function scoreChecklist(
	items: readonly string[] | undefined,
	taskId: string,
	workspaceText: string,
	reportText: string,
	preferReport: boolean,
): ChecklistScore {
	const values = items ?? [];
	const corpus = preferReport ? reportText : `${workspaceText}\n${reportText}`;
	const itemScores = values.map(item => {
		const known = coveredByKnownTask(taskId, item, workspaceText, reportText);
		return { item, covered: known ?? genericCovered(item, corpus) };
	});
	return {
		total: itemScores.length,
		covered: itemScores.filter(item => item.covered).length,
		items: itemScores,
	};
}

function inverseChecklist(
	items: readonly string[] | undefined,
	taskId: string,
	workspaceText: string,
	reportText: string,
): ChecklistScore {
	const raw = scoreChecklist(items, taskId, workspaceText, reportText, true);
	return {
		total: raw.total,
		covered: raw.items.filter(item => !item.covered).length,
		items: raw.items.map(item => ({ item: item.item, covered: !item.covered })),
	};
}

function checklistRatio(score: ChecklistScore): number {
	if (score.total === 0) return 1;
	return score.covered / score.total;
}

function scoreByRatio(points: number, score: ChecklistScore): number {
	return Math.round(points * checklistRatio(score));
}

function hasAnyDriftSignal(task: GsarTaskSpec, workspaceText: string, reportText: string): boolean {
	const drift = task.groundTruth.driftSignals ?? [];
	if (drift.length === 0) return false;
	return scoreChecklist(drift, task.id, workspaceText, reportText, false).items.some(item => item.covered);
}

function falsePass(task: GsarTaskSpec, evidence: RunEvidence): boolean {
	const expected = task.groundTruth.correctVerdict;
	if (!expected && !task.groundTruth.falsePassCondition) return false;
	return verdictIsPass(evidence) && (!expected || !verdictMatches(evidence, expected));
}

function correctionSuccess(
	task: GsarTaskSpec,
	evidence: RunEvidence,
	checklists: TaskEvaluation["checklists"],
): boolean {
	if (task.category !== "correction") return false;
	if (falsePass(task, evidence)) return false;
	const identifyOk = checklistRatio(checklists.mustIdentify) >= 0.67;
	const rejectOk = checklistRatio(checklists.mustReject) >= 0.5;
	const fixOk = checklistRatio(checklists.mustFix) >= 0.67;
	return identifyOk || rejectOk || fixOk;
}

async function evaluateTask(
	mode: ModeEvidence,
	evidence: ModeTaskEvidence,
	task: GsarTaskSpec,
): Promise<TaskEvaluation> {
	const workspaceText = await collectWorkspaceText(evidence.workspaceCwd);
	const reportText = evidence.output.reportText;
	const checklists = {
		mustExist: scoreChecklist(task.groundTruth.mustExist, task.id, workspaceText, reportText, false),
		mustCall: scoreChecklist(task.groundTruth.mustCall, task.id, workspaceText, reportText, false),
		mustImplement: scoreChecklist(task.groundTruth.mustImplement, task.id, workspaceText, reportText, false),
		mustFix: scoreChecklist(task.groundTruth.mustFix, task.id, workspaceText, reportText, false),
		mustIdentify: scoreChecklist(task.groundTruth.mustIdentify, task.id, workspaceText, reportText, true),
		mustIdentifyRegression: scoreChecklist(
			task.groundTruth.mustIdentifyRegression,
			task.id,
			workspaceText,
			reportText,
			true,
		),
		mustReject: scoreChecklist(task.groundTruth.mustReject, task.id, workspaceText, reportText, true),
		mustNotBreak: scoreChecklist(task.groundTruth.mustNotBreak, task.id, workspaceText, reportText, false),
		mustTest: scoreChecklist(task.groundTruth.mustTest, task.id, workspaceText, reportText, false),
		mustNotContain: inverseChecklist(task.groundTruth.mustNotContain, task.id, workspaceText, reportText),
		driftSignals: scoreChecklist(task.groundTruth.driftSignals, task.id, workspaceText, reportText, false),
		verdictMustAddress: scoreChecklist(task.groundTruth.verdictMustAddress, task.id, workspaceText, reportText, true),
	};
	const driftDetected =
		hasAnyDriftSignal(task, workspaceText, reportText) || checklistRatio(checklists.mustNotContain) < 1;
	const isFalsePass = falsePass(task, evidence.output);
	const minimumEvidence = task.groundTruth.minimumBlockers ?? task.groundTruth.minimumDefects ?? 0;
	const minimumEvidenceCovered =
		minimumEvidence === 0 ||
		checklists.mustIdentify.covered >= minimumEvidence ||
		checklists.mustIdentifyRegression.covered >= minimumEvidence;
	const goalAlignmentScore = Math.max(
		0,
		scoreByRatio(15, checklists.mustNotBreak) + scoreByRatio(10, checklists.mustNotContain) + (driftDetected ? 0 : 5),
	);
	const functionalCorrectnessScore =
		scoreByRatio(8, checklists.mustExist) +
		scoreByRatio(7, checklists.mustCall) +
		scoreByRatio(10, checklists.mustImplement) +
		scoreByRatio(10, checklists.mustFix);
	const expectedVerdictScore = verdictMatches(evidence.output, task.groundTruth.correctVerdict) ? 8 : 0;
	const errorInterceptionRaw =
		expectedVerdictScore +
		scoreByRatio(9, checklists.mustIdentify) +
		scoreByRatio(4, checklists.mustIdentifyRegression) +
		scoreByRatio(2, checklists.mustReject) +
		scoreByRatio(2, checklists.verdictMustAddress) +
		(minimumEvidenceCovered ? 0 : -8);
	const errorInterceptionScore = Math.max(0, Math.min(25, errorInterceptionRaw));
	const testQualityScore = scoreByRatio(10, checklists.mustTest);
	const engineeringQualityScore =
		evidence.output.status === "failed" || evidence.output.status === "aborted"
			? 0
			: evidence.output.testsRun.length > 0
				? 10
				: 6;
	const rawTotal =
		goalAlignmentScore +
		Math.min(25, functionalCorrectnessScore) +
		errorInterceptionScore +
		testQualityScore +
		engineeringQualityScore;
	const cappedTotal = isFalsePass
		? Math.min(49, rawTotal)
		: driftDetected
			? Math.min(69, rawTotal)
			: Math.min(100, rawTotal);
	return {
		taskId: task.id,
		label: task.label,
		mode: mode.id,
		run: evidence.run,
		category: task.category,
		primaryMetric: task.primaryMetric,
		agentVerdict: evidence.output.finalVerdict ?? evidence.output.status,
		status: evidence.output.status,
		goalAlignmentScore,
		functionalCorrectnessScore: Math.min(25, functionalCorrectnessScore),
		errorInterceptionScore,
		testQualityScore,
		engineeringQualityScore,
		totalScore: cappedTotal,
		falsePass: isFalsePass,
		driftDetected,
		correctionSuccess: correctionSuccess(task, evidence.output, checklists),
		checklists,
		usage: evidence.output.usage,
		durationMs: evidence.output.durationMs,
		workspaceCwd: evidence.workspaceCwd ?? null,
		fixtureSourceCwd: evidence.fixtureSourceCwd ?? null,
		evidence: {
			changedFiles: evidence.output.changedFiles,
			testsRun: evidence.output.testsRun,
			sessionFile: evidence.output.sessionFile,
		},
	};
}

function average(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeMode(mode: ModeEvidence, evaluations: readonly TaskEvaluation[]): ModeEvaluationSummary {
	const totalTokens = evaluations.reduce((sum, item) => sum + item.usage.totalTokens, 0);
	const durationMs = evaluations.reduce((sum, item) => sum + item.durationMs, 0);
	const averageScore = average(evaluations.map(item => item.totalScore));
	const falsePassCandidates = evaluations.filter(item => item.category === "self_approval" || item.falsePass);
	const goalTasks = evaluations.filter(item => item.category === "goal_steady");
	const correctionTasks = evaluations.filter(item => item.category === "correction");
	return {
		mode: mode.id,
		label: mode.label,
		tasks: evaluations.length,
		averageScore,
		falsePassRate:
			falsePassCandidates.length > 0
				? falsePassCandidates.filter(item => item.falsePass).length / falsePassCandidates.length
				: 0,
		goalDriftRate: goalTasks.length > 0 ? goalTasks.filter(item => item.driftDetected).length / goalTasks.length : 0,
		correctionSuccessRate:
			correctionTasks.length > 0
				? correctionTasks.filter(item => item.correctionSuccess).length / correctionTasks.length
				: 0,
		totalTokens,
		durationMs,
		qualityPer1MTokens: totalTokens > 0 ? averageScore / (totalTokens / 1000000) : null,
		qualityPerMinute: durationMs > 0 ? averageScore / (durationMs / 60000) : null,
	};
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatRate(value: number): string {
	return `${formatNumber(value * 100)}%`;
}

function formatNullable(value: number | null): string {
	return value === null ? "n/a" : formatNumber(value);
}

function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderHtml(result: GsarEvaluationOutput): string {
	const rows = result.modes
		.map(
			mode => `<tr>
<td>${htmlEscape(mode.label)}</td>
<td>${mode.tasks}</td>
<td>${formatNumber(mode.averageScore)}</td>
<td>${formatRate(mode.goalDriftRate)}</td>
<td>${formatRate(mode.falsePassRate)}</td>
<td>${formatRate(mode.correctionSuccessRate)}</td>
<td>${formatNumber(mode.totalTokens)}</td>
<td>${formatNullable(mode.qualityPer1MTokens)}</td>
<td>${formatNullable(mode.qualityPerMinute)}</td>
</tr>`,
		)
		.join("\n");
	const taskRows = result.tasks
		.map(
			task => `<tr>
<td>${htmlEscape(task.mode)}</td>
<td>${htmlEscape(task.taskId)}</td>
<td>${htmlEscape(task.category)}</td>
<td>${htmlEscape(task.status)}</td>
<td>${htmlEscape(task.agentVerdict)}</td>
<td>${formatNumber(task.totalScore)}</td>
<td>${task.falsePass ? "true" : "false"}</td>
<td>${task.driftDetected ? "true" : "false"}</td>
<td>${task.correctionSuccess ? "true" : "false"}</td>
</tr>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>San GSAR Benchmark Evaluation</title>
<style>
body { margin: 0; background: #f6f8fb; color: #172033; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1180px, calc(100vw - 48px)); margin: 0 auto; padding: 40px 0 56px; }
header, section { background: #fff; border: 1px solid #d8deea; border-radius: 10px; padding: 24px; margin-bottom: 18px; }
h1, h2, p { margin-top: 0; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { border: 1px solid #d8deea; padding: 8px 10px; vertical-align: top; text-align: left; }
th { background: #eef2f7; }
code { background: #eef2f7; border-radius: 5px; padding: 1px 5px; }
.callout { border-left: 4px solid #2358d4; background: #eaf0ff; padding: 12px 14px; }
</style>
</head>
<body>
<main>
<header>
<p>生成时间：${htmlEscape(result.generatedAt)}</p>
<h1>San GSAR Benchmark Evaluation</h1>
<p class="callout">该报告用 groundTruth、最终 workspace、agent evidence 对 GSAR 任务打分；agent 自报 verdict 只作为输入，不作为最终质量结论。</p>
</header>
<section>
<h2>模式汇总</h2>
<table>
<thead><tr><th>模式</th><th>任务数</th><th>平均质量分</th><th>目标漂移率</th><th>错误放行率</th><th>纠偏成功率</th><th>tokens</th><th>质量/百万token</th><th>质量/分钟</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>
<section>
<h2>任务明细</h2>
<table>
<thead><tr><th>模式</th><th>任务</th><th>类型</th><th>状态</th><th>agent verdict</th><th>质量分</th><th>false pass</th><th>drift</th><th>correction</th></tr></thead>
<tbody>${taskRows}</tbody>
</table>
</section>
<section>
<h2>证据路径</h2>
<p>输入 summary：<code>${htmlEscape(result.summaryPath)}</code></p>
<p>任务文件：<code>${htmlEscape(result.taskFile)}</code></p>
</section>
</main>
</body>
</html>
`;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeText(filePath: string, data: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, data);
}

async function main(): Promise<void> {
	if (hasFlag("--help") || hasFlag("-h")) {
		await Bun.write(Bun.stdout, `${usage()}\n`);
		return;
	}
	const summaryPath = argValue("--summary");
	if (!summaryPath) {
		await Bun.write(Bun.stderr, `${usage()}\n`);
		process.exit(2);
		return;
	}
	const resolvedSummaryPath = resolvePath(summaryPath);
	const taskFile = resolvePath(argValue("--task-file") ?? defaultTaskFile());
	const outPath = argValue("--out")
		? resolvePath(argValue("--out") ?? "")
		: path.join(path.dirname(resolvedSummaryPath), "gsar-evaluation.json");
	const reportOut = argValue("--report-out")
		? resolvePath(argValue("--report-out") ?? "")
		: path.join(path.dirname(resolvedSummaryPath), "gsar-evaluation.html");
	const benchmark = parseBenchmarkEvidence(await readJson(resolvedSummaryPath), resolvedSummaryPath);
	const tasks = await loadTasks(taskFile);
	const evaluations: TaskEvaluation[] = [];
	for (const mode of benchmark.modes) {
		for (const evidence of mode.tasks) {
			const task = tasks.get(evidence.id);
			if (!task) continue;
			evaluations.push(await evaluateTask(mode, evidence, task));
		}
	}
	const result: GsarEvaluationOutput = {
		label: benchmark.label,
		generatedAt: new Date().toISOString(),
		summaryPath: resolvedSummaryPath,
		taskFile,
		modes: benchmark.modes.map(mode =>
			summarizeMode(
				mode,
				evaluations.filter(item => item.mode === mode.id),
			),
		),
		tasks: evaluations,
		thresholds: {
			goalDriftReductionTarget: 0.3,
			falsePassReductionTarget: 0.5,
			correctionSuccessTarget: 0.6,
			qualityPerTokenFloorRatio: 0.8,
		},
	};
	await writeJson(outPath, result);
	await writeText(reportOut, renderHtml(result));
	await Bun.write(Bun.stdout, `${JSON.stringify({ out: outPath, reportOut, modes: result.modes }, null, 2)}\n`);
}

await main();
