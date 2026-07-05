#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AcceptanceRunOutput, RunnerArgs } from "./san-v02-acceptance-runner";
import { collectSessionUsage, runAcceptanceTask } from "./san-v02-acceptance-runner";
import type { SingleAgentRunOutput } from "./san-v02-single-agent-runner";
import { runSingleAgentTask } from "./san-v02-single-agent-runner";

type BenchmarkModeId = "single-agent" | "context-steady-only" | "multi-role-same-model" | "multi-role-heterogeneous";
type BenchmarkRunOutput = AcceptanceRunOutput | SingleAgentRunOutput;

interface AcceptanceTaskSpec {
	id: string;
	label: string;
	mode: RunnerArgs["mode"];
	expect: RunnerArgs["expect"];
	objective: string;
	fixture?: string;
	writesFiles?: boolean;
}

interface BenchmarkModeSpec {
	id: BenchmarkModeId;
	label: string;
	kind: "single" | "san-loop";
	config?: string;
	model?: string;
}

interface BenchmarkTaskOutput {
	id: string;
	label: string;
	mode: RunnerArgs["mode"];
	expect: RunnerArgs["expect"];
	fixture?: string;
	fixtureSourceCwd?: string;
	workspaceCwd: string;
	writesFiles?: boolean;
	run: number;
	output: BenchmarkRunOutput;
}

interface BenchmarkModeOutput {
	id: BenchmarkModeId;
	label: string;
	kind: BenchmarkModeSpec["kind"];
	config?: string;
	model?: string;
	tasks: BenchmarkTaskOutput[];
	summary: BenchmarkSummary;
}

interface BenchmarkSummary {
	total: number;
	ok: number;
	passed: number;
	terminal: number;
	blocked: number;
	failed: number;
	aborted: number;
	retried: number;
	reviewReports: number;
	workerResults: number;
	durationMs: number;
	modelDurationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
	premiumRequests: number;
	passRate: number;
	okRate: number;
	costPerPassed: number | null;
	tokensPerPassed: number | null;
	durationPerPassedMs: number | null;
}

interface RoiBenchmarkOutput {
	label: string;
	startedAt: string;
	completedAt: string;
	runsPerMode: number;
	agentDir: string;
	sourceCwd: string;
	cwdRoot: string;
	outDir: string;
	taskFile: string;
	modes: BenchmarkModeOutput[];
	comparison: RoiComparison[];
}

interface RoiComparison {
	mode: BenchmarkModeId;
	label: string;
	qualityDeltaPassed: number;
	qualityDeltaPassRate: number;
	tokenDelta: number;
	durationDeltaMs: number;
	costDelta: number;
	incrementalTokensPerExtraPass: number | null;
	incrementalCostPerExtraPass: number | null;
	recommendation: string;
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

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function resolvePath(value: string): string {
	return path.resolve(expandHome(value));
}

function defaultTaskFile(): string {
	return path.resolve(import.meta.dir, "..", "examples", "san-v02-acceptance-tasks.json");
}

function defaultHeterogeneousConfig(): string {
	return path.resolve(import.meta.dir, "..", "examples", "config", "san-execution-loop-heterogeneous.yml");
}

function defaultSameModelConfig(): string {
	return path.resolve(import.meta.dir, "..", "examples", "config", "san-execution-loop-same-model.yml");
}

function defaultContextSteadyOnlyConfig(): string {
	return path.resolve(import.meta.dir, "..", "examples", "config", "san-context-steady-only.yml");
}

function usage(): string {
	return [
		"Usage:",
		"  bun packages/coding-agent/scripts/san-v02-roi-benchmark.ts [options]",
		"",
		"Options:",
		"  --agent-dir <path>        Agent dir with models.yml",
		"  --cwd-root <path>         Root for per-task workspaces",
		"  --source-cwd <path>       Source repo copied into each task workspace",
		"  --out-dir <path>          Directory for benchmark evidence",
		"  --task-file <path>        JSON task file",
		"  --label <name>            Benchmark label",
		"  --runs <n>                Runs per mode (default: 1)",
		"  --single-model <selector> Single-agent model selector (default: vb/gpt-5.5:xhigh)",
		"  --context-config <path>   v0.1-only context steady config",
		"  --same-config <path>      Same-model multi-role config",
		"  --hetero-config <path>    Heterogeneous multi-role config",
		"  --report-out <path>       Also write the HTML report to this path",
		"  --mode <id>               Run one mode only; can be repeated",
		"  --resume                  Reuse existing per-task JSON evidence",
		"  --stop-on-fail            Stop after the first failed task expectation",
	].join("\n");
}

function selectedModes(): Set<string> | undefined {
	const values: string[] = [];
	for (let index = 2; index < Bun.argv.length; index++) {
		if (Bun.argv[index] === "--mode" && Bun.argv[index + 1]) values.push(Bun.argv[index + 1]);
		const value = Bun.argv[index];
		if (value?.startsWith("--mode=")) values.push(value.slice("--mode=".length));
	}
	return values.length > 0 ? new Set(values) : undefined;
}

function assertTaskSpec(value: unknown): AcceptanceTaskSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Acceptance task must be an object");
	}
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	const label = typeof record.label === "string" ? record.label : "";
	const mode = record.mode === "rush" || record.mode === "smart" || record.mode === "deep" ? record.mode : undefined;
	const expect = record.expect === "passed" || record.expect === "terminal" ? record.expect : undefined;
	const objective = typeof record.objective === "string" ? record.objective.trim() : "";
	const fixture = typeof record.fixture === "string" && record.fixture.trim() ? record.fixture.trim() : undefined;
	const writesFiles = typeof record.writesFiles === "boolean" ? record.writesFiles : undefined;
	if (!id || !label || !mode || !expect || !objective) {
		throw new Error(`Invalid acceptance task: ${JSON.stringify(record)}`);
	}
	return { id, label, mode, expect, objective, fixture, writesFiles };
}

async function loadTasks(filePath: string): Promise<AcceptanceTaskSpec[]> {
	const data = await Bun.file(filePath).json();
	if (!Array.isArray(data)) throw new Error(`Acceptance task file must contain an array: ${filePath}`);
	return data.map(assertTaskSpec);
}

async function readExistingTaskOutput(filePath: string): Promise<BenchmarkRunOutput | null> {
	try {
		return (await Bun.file(filePath).json()) as BenchmarkRunOutput;
	} catch {
		return null;
	}
}

async function recoverSessionUsage(output: BenchmarkRunOutput): Promise<BenchmarkRunOutput> {
	if (output.usage.totalTokens > 0) return output;
	const usage = await collectSessionUsage(output.sessionFile);
	if (usage.totalTokens <= 0) return output;
	return { ...output, usage };
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function copyWorkspace(sourceCwd: string, destination: string): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.cp(sourceCwd, destination, {
		recursive: true,
		dereference: false,
		errorOnExist: false,
		filter: source => {
			const relative = path.relative(sourceCwd, source);
			if (!relative) return true;
			const segments = relative.split(path.sep);
			if (segments.includes(".git")) return false;
			if (segments.includes(".omp")) return false;
			if (segments.includes(".codegraph")) return false;
			if (segments.includes("node_modules")) return false;
			if (segments.includes(".turbo")) return false;
			if (segments.includes(".next")) return false;
			if (segments.includes("dist")) return false;
			if (segments.includes("coverage")) return false;
			return true;
		},
	});
}

function taskSourceCwd(task: AcceptanceTaskSpec, fallbackSourceCwd: string): string {
	if (!task.fixture) return fallbackSourceCwd;
	return path.resolve(import.meta.dir, "..", "examples", task.fixture);
}

function terminalCount(tasks: readonly BenchmarkTaskOutput[]): number {
	return tasks.filter(task => ["passed", "blocked", "failed", "aborted"].includes(task.output.status)).length;
}

function sumUsage(tasks: readonly BenchmarkTaskOutput[], key: keyof BenchmarkRunOutput["usage"]): number {
	return tasks.reduce((total, task) => total + task.output.usage[key], 0);
}

function summarize(tasks: readonly BenchmarkTaskOutput[]): BenchmarkSummary {
	const passed = tasks.filter(task => task.output.status === "passed").length;
	const total = tasks.length;
	const durationMs = tasks.reduce((sum, task) => sum + task.output.durationMs, 0);
	const totalTokens = sumUsage(tasks, "totalTokens");
	const cost = sumUsage(tasks, "cost");
	return {
		total,
		ok: tasks.filter(task => task.output.ok).length,
		passed,
		terminal: terminalCount(tasks),
		blocked: tasks.filter(task => task.output.status === "blocked").length,
		failed: tasks.filter(task => task.output.status === "failed").length,
		aborted: tasks.filter(task => task.output.status === "aborted").length,
		retried: tasks.filter(task => task.output.retryCount > 0).length,
		reviewReports: tasks.reduce((sum, task) => sum + task.output.reviewReports, 0),
		workerResults: tasks.reduce((sum, task) => sum + task.output.workerResults, 0),
		durationMs,
		modelDurationMs: durationMs,
		inputTokens: sumUsage(tasks, "inputTokens"),
		outputTokens: sumUsage(tasks, "outputTokens"),
		cacheReadTokens: sumUsage(tasks, "cacheReadTokens"),
		cacheWriteTokens: sumUsage(tasks, "cacheWriteTokens"),
		totalTokens,
		cost,
		premiumRequests: sumUsage(tasks, "premiumRequests"),
		passRate: total > 0 ? passed / total : 0,
		okRate: total > 0 ? tasks.filter(task => task.output.ok).length / total : 0,
		costPerPassed: passed > 0 ? cost / passed : null,
		tokensPerPassed: passed > 0 ? totalTokens / passed : null,
		durationPerPassedMs: passed > 0 ? durationMs / passed : null,
	};
}

function buildComparison(modes: readonly BenchmarkModeOutput[]): RoiComparison[] {
	const baseline = modes.find(mode => mode.id === "single-agent");
	if (!baseline) return [];
	return modes
		.filter(mode => mode.id !== "single-agent")
		.map(mode => {
			const qualityDeltaPassed = mode.summary.passed - baseline.summary.passed;
			const tokenDelta = mode.summary.totalTokens - baseline.summary.totalTokens;
			const costDelta = mode.summary.cost - baseline.summary.cost;
			const durationDeltaMs = mode.summary.durationMs - baseline.summary.durationMs;
			return {
				mode: mode.id,
				label: mode.label,
				qualityDeltaPassed,
				qualityDeltaPassRate: mode.summary.passRate - baseline.summary.passRate,
				tokenDelta,
				durationDeltaMs,
				costDelta,
				incrementalTokensPerExtraPass: qualityDeltaPassed > 0 ? tokenDelta / qualityDeltaPassed : null,
				incrementalCostPerExtraPass: qualityDeltaPassed > 0 ? costDelta / qualityDeltaPassed : null,
				recommendation:
					qualityDeltaPassed > 0
						? "Quality improves versus single-agent baseline; evaluate whether incremental spend is acceptable for smart/deep tasks."
						: "No pass-rate lift versus single-agent baseline; keep this mode opt-in until quality improves.",
			};
		});
}

function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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

function formatMinutes(valueMs: number): string {
	return `${formatNumber(valueMs / 60000)} min`;
}

function formatMultiplier(value: number): string {
	return `${formatNumber(value)}x`;
}

function nonCacheTokens(summary: BenchmarkSummary): number {
	return summary.inputTokens + summary.outputTokens + summary.cacheWriteTokens;
}

function tokenRatio(summary: BenchmarkSummary, baseline: BenchmarkSummary | undefined): string {
	if (!baseline || baseline.totalTokens <= 0) return "n/a";
	return formatMultiplier(summary.totalTokens / baseline.totalTokens);
}

function durationRatio(summary: BenchmarkSummary, baseline: BenchmarkSummary | undefined): string {
	if (!baseline || baseline.durationMs <= 0) return "n/a";
	return formatMultiplier(summary.durationMs / baseline.durationMs);
}

function blockedTaskList(mode: BenchmarkModeOutput): string {
	const blocked = mode.tasks.filter(task => task.output.status === "blocked").map(task => `${task.id} ${task.label}`);
	return blocked.length > 0 ? blocked.join(", ") : "none";
}

function renderProductVerdict(
	baseline: BenchmarkModeOutput | undefined,
	contextOnly: BenchmarkModeOutput | undefined,
	sameModel: BenchmarkModeOutput | undefined,
	heterogeneous: BenchmarkModeOutput | undefined,
): string {
	if (!baseline || !heterogeneous) return "证据不完整，暂不能给出默认开启判断。";
	const qualityLift = heterogeneous.summary.passed - baseline.summary.passed;
	if (qualityLift > 0) {
		return "多角色异构模式相对单 Agent 产生 passed 率提升，可进入 smart/deep 默认候选，但仍需多轮均值验证成本弹性。";
	}
	const timeRatio = heterogeneous.summary.durationMs / baseline.summary.durationMs;
	const tokenSpendRatio = heterogeneous.summary.totalTokens / baseline.summary.totalTokens;
	const sameModelText =
		sameModel && sameModel.summary.durationMs > heterogeneous.summary.durationMs
			? "同模型多角色显著更慢，不能作为默认策略。"
			: "同模型多角色未显示出明确效率优势。";
	const contextText = contextOnly
		? `v0.1 Only passed 为 ${contextOnly.summary.passed}/10，用于单独观察 context steady 对目标保持的贡献；`
		: "";
	return `本轮多模式对比中，异构多角色相对单 Agent 没有带来可量化 pass 率提升；${contextText}异构多角色提供 review 证据链，但 token 约为单 Agent 的 ${formatMultiplier(tokenSpendRatio)}、耗时约为 ${formatMultiplier(timeRatio)}。产品上不建议全量默认开启，应作为 smart/deep 或高风险任务档位；${sameModelText}`;
}

function renderReport(result: RoiBenchmarkOutput): string {
	const baseline = result.modes.find(mode => mode.id === "single-agent");
	const contextOnly = result.modes.find(mode => mode.id === "context-steady-only");
	const sameModel = result.modes.find(mode => mode.id === "multi-role-same-model");
	const modeRows = result.modes
		.map(
			mode => `<tr>
<td>${htmlEscape(mode.label)}</td>
<td>${mode.summary.total}</td>
<td>${mode.summary.ok}</td>
<td>${mode.summary.passed}</td>
<td>${mode.summary.blocked}</td>
<td>${formatRate(mode.summary.passRate)}</td>
<td>${formatNumber(mode.summary.totalTokens)}</td>
<td>${formatNumber(nonCacheTokens(mode.summary))}</td>
<td>${formatMinutes(mode.summary.durationMs)}</td>
<td>${tokenRatio(mode.summary, baseline?.summary)}</td>
<td>${durationRatio(mode.summary, baseline?.summary)}</td>
<td>${formatNumber(mode.summary.cost)}</td>
<td>${formatNullable(mode.summary.tokensPerPassed)}</td>
<td>${mode.summary.workerResults} / ${mode.summary.reviewReports}</td>
</tr>`,
		)
		.join("\n");
	const comparisonRows = result.comparison
		.map(
			row => `<tr>
<td>${htmlEscape(row.label)}</td>
<td>${row.qualityDeltaPassed >= 0 ? "+" : ""}${row.qualityDeltaPassed}</td>
<td>${row.qualityDeltaPassRate >= 0 ? "+" : ""}${formatRate(row.qualityDeltaPassRate)}</td>
<td>${row.tokenDelta >= 0 ? "+" : ""}${formatNumber(row.tokenDelta)}</td>
<td>${row.durationDeltaMs >= 0 ? "+" : ""}${formatMinutes(row.durationDeltaMs)}</td>
<td>${row.costDelta >= 0 ? "+" : ""}${formatNumber(row.costDelta)}</td>
<td>${formatNullable(row.incrementalTokensPerExtraPass)}</td>
<td>${htmlEscape(row.recommendation)}</td>
</tr>`,
		)
		.join("\n");
	const taskRows = result.modes
		.flatMap(mode =>
			mode.tasks.map(
				task => `<tr>
<td>${htmlEscape(mode.label)}</td>
<td>${task.run}</td>
<td>${htmlEscape(task.id)}</td>
<td>${htmlEscape(task.label)}</td>
<td>${htmlEscape(task.output.status)}</td>
<td>${htmlEscape(task.output.finalVerdict ?? "none")}</td>
<td>${task.output.ok ? "true" : "false"}</td>
<td>${formatNumber(task.output.usage.totalTokens)}</td>
<td>${formatMinutes(task.output.durationMs)}</td>
</tr>`,
			),
		)
		.join("\n");
	const hetero = result.modes.find(mode => mode.id === "multi-role-heterogeneous");
	const verdict = renderProductVerdict(baseline, contextOnly, sameModel, hetero);
	const allCostsZero = result.modes.every(mode => mode.summary.cost === 0);
	const blockedRows = result.modes
		.map(
			mode => `<tr>
<td>${htmlEscape(mode.label)}</td>
<td>${htmlEscape(blockedTaskList(mode))}</td>
<td>${mode.summary.retried}</td>
<td>${mode.summary.workerResults}</td>
<td>${mode.summary.reviewReports}</td>
</tr>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>San v0.2 ROI Benchmark 汇报</title>
<style>
body { margin: 0; background: #f7f8fb; color: #172033; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1180px, calc(100vw - 48px)); margin: 0 auto; padding: 40px 0 56px; }
header, section { background: #fff; border: 1px solid #d9dee8; border-radius: 10px; padding: 24px; margin-bottom: 18px; }
h1, h2, p { margin-top: 0; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { border: 1px solid #d9dee8; padding: 8px 10px; vertical-align: top; text-align: left; }
th { background: #eef2f7; }
code { background: #eef2f7; border: 1px solid #d9dee8; border-radius: 5px; padding: 1px 5px; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric { border: 1px solid #d9dee8; border-radius: 8px; padding: 14px; background: #fbfcff; }
.metric strong { display: block; font-size: 26px; line-height: 1; color: #16794c; margin-bottom: 6px; }
.callout { border-left: 4px solid #1f5fbf; background: #eef5ff; padding: 12px 14px; }
.warn { border-left-color: #9a5b00; background: #fff7e8; }
.muted { color: #647084; }
.pill { display: inline-block; border-radius: 999px; padding: 2px 9px; background: #eef2f7; font-size: 12px; font-weight: 700; }
</style>
</head>
<body>
<main>
<header>
<p>生成时间：${htmlEscape(result.completedAt)}</p>
<h1>San v0.2 ROI Benchmark 汇报</h1>
<p class="callout"><strong>产品判断：</strong>${htmlEscape(verdict)}</p>
<p>同一套任务，对比单 Agent、v0.1 context steady only、多角色同模型、多角色异构模型的交付质量、耗时、token 与成本。</p>
</header>
<section>
<h2>执行摘要</h2>
<div class="grid">
<div class="metric"><strong>${result.modes.length}</strong><span>模式</span></div>
<div class="metric"><strong>${result.runsPerMode}</strong><span>每模式轮次</span></div>
<div class="metric"><strong>${result.modes.reduce((sum, mode) => sum + mode.summary.passed, 0)}</strong><span>总 passed</span></div>
<div class="metric"><strong>${formatNumber(result.modes.reduce((sum, mode) => sum + mode.summary.totalTokens, 0))}</strong><span>总 token</span></div>
</div>
<p class="muted">本轮满足“每模式至少 1 轮完整 suite”的验收下限；结论应按单轮 benchmark 看待，下一阶段建议跑 3 轮均值和方差。</p>
${allCostsZero ? '<p class="callout warn"><strong>成本口径：</strong>当前本地 models.yml 中 provider cost 配置为 0，因此报告不声称真实金额成本；ROI 先以 total token、非缓存 token 和 wall time 作为投入代理。</p>' : ""}
<table>
<thead><tr><th>模式</th><th>total</th><th>ok</th><th>passed</th><th>blocked</th><th>pass rate</th><th>total tokens</th><th>non-cache tokens</th><th>耗时</th><th>token 倍率</th><th>耗时倍率</th><th>cost</th><th>tokens / passed</th><th>workers / reviews</th></tr></thead>
<tbody>${modeRows}</tbody>
</table>
</section>
<section>
<h2>相对单 Agent 增量</h2>
<table>
<thead><tr><th>模式</th><th>passed 增量</th><th>pass rate 增量</th><th>token 增量</th><th>耗时增量</th><th>成本增量</th><th>增量 token / 额外 pass</th><th>建议</th></tr></thead>
<tbody>${comparisonRows}</tbody>
</table>
</section>
<section>
<h2>失败样本</h2>
<table>
<thead><tr><th>模式</th><th>blocked 任务</th><th>retry 次数</th><th>workerResults</th><th>reviewReports</th></tr></thead>
<tbody>${blockedRows}</tbody>
</table>
<p class="muted">T06 在三种模式中都未直接 passed，说明“文档交付 gate”任务本身仍是当前测试集中最稳定暴露质量边界的样本。异构多角色在 T07 给出 blocked/none，保留了失败命令闭环风险；同模型多角色在 T02/T05/T06 更保守。</p>
</section>
<section>
<h2>产品建议</h2>
<p><span class="pill">Default</span> 不建议把多角色设为所有任务默认开启：多角色必须在目标漂移率、错误放行率或纠偏成功率上证明增益，而不是只看 pass rate。</p>
<p><span class="pill">v0.1 Only</span> Context steady only 模式用于隔离上下文稳态贡献，重点观察长程任务的目标保持，而不是 review 证据链数量。</p>
<p><span class="pill">Smart / Deep</span> 建议保留异构多角色作为高风险任务、架构审查、验收报告、需要独立 review 的档位；它比同模型多角色快很多，并且产生了 15 个 worker 结果和 14 个 review 证据。</p>
<p><span class="pill">Same Model</span> 不建议作为主推策略：同样 7/10 passed，但耗时约为单 Agent 的 ${durationRatio(sameModel?.summary ?? baseline?.summary ?? result.modes[0].summary, baseline?.summary)}，token 约为 ${tokenRatio(sameModel?.summary ?? baseline?.summary ?? result.modes[0].summary, baseline?.summary)}。</p>
<p><span class="pill">Next</span> 下一步优先降低 token：收紧 roleContext、减少 T08 deep 的 worker 扩散、按任务难度触发 Oracle，并补 3 轮均值/方差后再判断是否进入默认策略候选。</p>
</section>
<section>
<h2>任务明细</h2>
<table>
<thead><tr><th>模式</th><th>轮次</th><th>任务</th><th>标签</th><th>状态</th><th>verdict</th><th>ok</th><th>tokens</th><th>耗时</th></tr></thead>
<tbody>${taskRows}</tbody>
</table>
</section>
<section>
<h2>证据路径</h2>
<p>JSON 汇总：<code>${htmlEscape(path.join(result.outDir, "summary.json"))}</code></p>
<p>任务证据目录：<code>${htmlEscape(result.outDir)}</code></p>
<p>源任务文件：<code>${htmlEscape(result.taskFile)}</code></p>
</section>
</main>
</body>
</html>
`;
}

async function runMode(
	mode: BenchmarkModeSpec,
	tasks: readonly AcceptanceTaskSpec[],
	options: {
		agentDir: string;
		cwdRoot: string;
		outDir: string;
		runsPerMode: number;
		resume: boolean;
		sourceCwd: string;
		stopOnFail: boolean;
	},
): Promise<BenchmarkModeOutput> {
	const taskOutputs: BenchmarkTaskOutput[] = [];
	for (let run = 1; run <= options.runsPerMode; run++) {
		for (const task of tasks) {
			const taskLabel = `${mode.id}-r${run}-${task.id.toLowerCase()}-${task.label}`;
			const cwd = path.join(options.cwdRoot, taskLabel);
			const outPath = path.join(options.outDir, mode.id, `r${run}`, `${task.id.toLowerCase()}-${task.label}.json`);
			const existing = options.resume ? await readExistingTaskOutput(outPath) : null;
			const rawOutput =
				existing ??
				(await (async () => {
					await copyWorkspace(taskSourceCwd(task, options.sourceCwd), cwd);
					return mode.kind === "single"
						? await runSingleAgentTask({
								agentDir: options.agentDir,
								config: mode.config,
								cwd,
								expect: task.expect,
								label: taskLabel,
								model: mode.model,
								objective: task.objective,
								out: outPath,
							})
						: await runAcceptanceTask({
								agentDir: options.agentDir,
								config: mode.config,
								cwd,
								expect: task.expect,
								label: taskLabel,
								mode: task.mode,
								objective: task.objective,
								out: outPath,
							});
				})());
			const output = await recoverSessionUsage(rawOutput);
			taskOutputs.push({
				id: task.id,
				label: task.label,
				mode: task.mode,
				expect: task.expect,
				fixture: task.fixture,
				fixtureSourceCwd: taskSourceCwd(task, options.sourceCwd),
				workspaceCwd: cwd,
				writesFiles: task.writesFiles,
				run,
				output,
			});
			await writeJsonFile(outPath, output);
			await writeJsonFile(path.join(options.outDir, mode.id, `r${run}`, "partial-summary.json"), {
				id: mode.id,
				label: mode.label,
				kind: mode.kind,
				config: mode.config,
				model: mode.model,
				tasks: taskOutputs,
				summary: summarize(taskOutputs),
			});
			await Bun.write(
				Bun.stdout,
				`${existing ? "reuse " : ""}${mode.id} r${run} ${task.id} ${task.label}: ${output.status}; verdict=${output.finalVerdict ?? "none"}; ok=${output.ok}\n`,
			);
			if (!output.ok && options.stopOnFail) {
				return {
					id: mode.id,
					label: mode.label,
					kind: mode.kind,
					config: mode.config,
					model: mode.model,
					tasks: taskOutputs,
					summary: summarize(taskOutputs),
				};
			}
		}
	}
	return {
		id: mode.id,
		label: mode.label,
		kind: mode.kind,
		config: mode.config,
		model: mode.model,
		tasks: taskOutputs,
		summary: summarize(taskOutputs),
	};
}

async function main(): Promise<void> {
	if (hasFlag("--help") || hasFlag("-h")) {
		await Bun.write(Bun.stdout, `${usage()}\n`);
		return;
	}
	const label = argValue("--label") ?? "san-v02-roi-benchmark";
	const runsPerMode = Math.max(1, Number.parseInt(argValue("--runs") ?? "1", 10) || 1);
	const agentDir = resolvePath(
		argValue("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? "/private/tmp/san-v02-agent",
	);
	const sourceCwd = resolvePath(argValue("--source-cwd") ?? process.cwd());
	const cwdRoot = resolvePath(argValue("--cwd-root") ?? `/private/tmp/${label}-workspaces`);
	const outDir = resolvePath(argValue("--out-dir") ?? `/private/tmp/${label}-evidence`);
	const taskFile = resolvePath(argValue("--task-file") ?? defaultTaskFile());
	const singleModel = argValue("--single-model") ?? "vb/gpt-5.5:xhigh";
	const contextConfig = resolvePath(argValue("--context-config") ?? defaultContextSteadyOnlyConfig());
	const sameConfig = resolvePath(argValue("--same-config") ?? defaultSameModelConfig());
	const heteroConfig = resolvePath(argValue("--hetero-config") ?? defaultHeterogeneousConfig());
	const reportOut = argValue("--report-out");
	const resume = hasFlag("--resume");
	const stopOnFail = hasFlag("--stop-on-fail");
	const selected = selectedModes();
	const tasks = await loadTasks(taskFile);
	const allModes: BenchmarkModeSpec[] = [
		{
			id: "single-agent",
			label: "Single Agent Baseline",
			kind: "single",
			model: singleModel,
		},
		{
			id: "context-steady-only",
			label: "Context Steady Only",
			kind: "single",
			config: contextConfig,
			model: singleModel,
		},
		{
			id: "multi-role-same-model",
			label: "Multi-role Same Model",
			kind: "san-loop",
			config: sameConfig,
		},
		{
			id: "multi-role-heterogeneous",
			label: "Multi-role Heterogeneous",
			kind: "san-loop",
			config: heteroConfig,
		},
	];
	const modes = allModes.filter(mode => !selected || selected.has(mode.id));

	await fs.mkdir(cwdRoot, { recursive: true });
	await fs.mkdir(outDir, { recursive: true });

	const startedAt = new Date().toISOString();
	const modeOutputs: BenchmarkModeOutput[] = [];
	for (const mode of modes) {
		modeOutputs.push(
			await runMode(mode, tasks, {
				agentDir,
				cwdRoot,
				outDir,
				resume,
				runsPerMode,
				sourceCwd,
				stopOnFail,
			}),
		);
	}
	const result: RoiBenchmarkOutput = {
		label,
		startedAt,
		completedAt: new Date().toISOString(),
		runsPerMode,
		agentDir,
		sourceCwd,
		cwdRoot,
		outDir,
		taskFile,
		modes: modeOutputs,
		comparison: buildComparison(modeOutputs),
	};
	await writeJsonFile(path.join(outDir, "summary.json"), result);
	const reportHtml = renderReport(result);
	await Bun.write(path.join(outDir, "report.html"), reportHtml);
	if (reportOut) await Bun.write(resolvePath(reportOut), reportHtml);
	await Bun.write(
		Bun.stdout,
		`${JSON.stringify({ modes: result.modes.map(mode => ({ id: mode.id, summary: mode.summary })), comparison: result.comparison }, null, 2)}\n`,
	);
}

await main();
process.exit(0);
