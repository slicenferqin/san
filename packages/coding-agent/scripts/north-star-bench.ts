#!/usr/bin/env bun
/**
 * 北极星 benchmark runner(打磨规划 3.1,指标经 goal-fidelity 研究修正)。
 *
 * 指标(对固定样本集,见 north-star-samples.ts):
 * - 目标保真度:确定性验收命令通过率 — 产出与初始契约一致的主信号;
 * - 介入效率:steering 样本中,一次纠偏后验收通过率;
 * - 预算内完成:未触墙钟上限的比率;
 * - 终态可解释:会话终态带非空结论文本的比率(第一版弱信号,原文入档供人审)。
 *
 * 用法:
 *   bun run bench:north-star --model <pattern> [--samples id1,id2] [--out report.json]
 *
 * 真实 provider、真实会话;每样本独立 fixture 与会话,互不污染。无人值守
 * 语义:单条 prompt(steering 样本恰好一次纠偏),agent 停即采集,不追问。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { NORTH_STAR_SAMPLES, type NorthStarSample } from "./north-star-samples";

interface SampleResult {
	id: string;
	kind: NorthStarSample["kind"];
	acceptancePassed: boolean;
	withinBudget: boolean;
	terminalExplained: boolean;
	elapsedMs: number;
	messageCount: number;
	tokens: { input: number; output: number; cacheRead: number };
	costUsd: number;
	finalAssistantText: string;
	error?: string;
}

async function emit(text: string): Promise<void> {
	await Bun.write(Bun.stdout, `${text}\n`);
}

function lastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map(block => (block.type === "text" ? block.text : ""))
				.join("\n")
				.trim();
		}
		return "";
	}
	return "";
}

async function runSample(sample: NorthStarSample, modelPattern: string): Promise<SampleResult> {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), `north-star-${sample.id}-`));
	const startedAt = Date.now();
	let session: AgentSession | undefined;
	const result: SampleResult = {
		id: sample.id,
		kind: sample.kind,
		acceptancePassed: false,
		withinBudget: true,
		terminalExplained: false,
		elapsedMs: 0,
		messageCount: 0,
		tokens: { input: 0, output: 0, cacheRead: 0 },
		costUsd: 0,
		finalAssistantText: "",
	};
	try {
		for (const [file, content] of Object.entries(sample.files)) {
			await Bun.write(path.join(fixture, file), content);
		}
		await $`git init -q && git add -A && git -c user.email=bench@san.local -c user.name=bench commit -qm fixture`
			.cwd(fixture)
			.quiet();

		const created = await createAgentSession({ cwd: fixture, modelPattern, spawns: "*" });
		session = created.session;

		const budget = { done: false };
		const deadline = Bun.sleep(sample.timeoutMs).then(() => {
			if (!budget.done) {
				result.withinBudget = false;
				return session?.abort({ reason: "bench budget exceeded" });
			}
		});
		await session.prompt(sample.prompt);
		if (sample.steer && result.withinBudget) {
			// 介入效率场景:恰好一次纠偏,然后无人值守到停。
			await session.prompt(sample.steer);
		}
		budget.done = true;
		await Promise.race([deadline, Bun.sleep(0)]);

		result.finalAssistantText = lastAssistantText(session).slice(0, 2_000);
		result.terminalExplained = result.finalAssistantText.trim().length >= 40;
		result.messageCount = session.messages.length;
		const stats = session.getSessionStats();
		result.tokens = {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
		};
		result.costUsd = stats.cost;

		const acceptance = await $`sh -c ${sample.acceptance}`.cwd(fixture).quiet().nothrow();
		result.acceptancePassed = acceptance.exitCode === 0;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	} finally {
		result.elapsedMs = Date.now() - startedAt;
		await session?.dispose().catch(() => {});
		await fs.rm(fixture, { recursive: true, force: true });
	}
	return result;
}

function ratio(numerator: number, denominator: number): string {
	if (denominator === 0) return "n/a";
	return `${numerator}/${denominator} (${((numerator / denominator) * 100).toFixed(0)}%)`;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			model: { type: "string" },
			samples: { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.model) {
		await emit("usage: north-star-bench.ts --model <pattern> [--samples id1,id2] [--out report.json]");
		process.exit(2);
	}
	const filter = values.samples ? new Set(values.samples.split(",").map(part => part.trim())) : undefined;
	const samples = NORTH_STAR_SAMPLES.filter(sample => !filter || filter.has(sample.id));
	if (samples.length === 0) {
		await emit("no samples matched the filter");
		process.exit(2);
	}

	const results: SampleResult[] = [];
	for (const sample of samples) {
		await emit(`── running ${sample.id} (${sample.kind}) …`);
		const result = await runSample(sample, values.model);
		results.push(result);
		await emit(
			`   ${result.acceptancePassed ? "PASS" : "fail"} acceptance=${result.acceptancePassed} budget=${result.withinBudget} ` +
				`explained=${result.terminalExplained} ${Math.round(result.elapsedMs / 1000)}s $${result.costUsd.toFixed(4)}` +
				(result.error ? ` error=${result.error.slice(0, 120)}` : ""),
		);
	}

	const steering = results.filter(result => result.kind === "steering");
	const summary = {
		timestamp: new Date().toISOString(),
		model: values.model,
		sampleCount: results.length,
		metrics: {
			goalFidelity: {
				passed: results.filter(result => result.acceptancePassed).length,
				total: results.length,
			},
			steeringEfficiency: {
				passed: steering.filter(result => result.acceptancePassed).length,
				total: steering.length,
			},
			withinBudget: {
				passed: results.filter(result => result.withinBudget).length,
				total: results.length,
			},
			terminalExplained: {
				passed: results.filter(result => result.terminalExplained).length,
				total: results.length,
			},
		},
		totalCostUsd: Number(results.reduce((sum, result) => sum + result.costUsd, 0).toFixed(4)),
		results,
	};

	await emit("");
	await emit(`North-star benchmark — model ${values.model}, ${results.length} samples`);
	await emit(
		`  goal fidelity      : ${ratio(summary.metrics.goalFidelity.passed, summary.metrics.goalFidelity.total)}`,
	);
	await emit(
		`  steering efficiency: ${ratio(summary.metrics.steeringEfficiency.passed, summary.metrics.steeringEfficiency.total)}`,
	);
	await emit(
		`  within budget      : ${ratio(summary.metrics.withinBudget.passed, summary.metrics.withinBudget.total)}`,
	);
	await emit(
		`  terminal explained : ${ratio(summary.metrics.terminalExplained.passed, summary.metrics.terminalExplained.total)}`,
	);
	await emit(`  total cost         : $${summary.totalCostUsd}`);
	if (values.out) {
		await Bun.write(values.out, `${JSON.stringify(summary, null, "\t")}\n`);
		await emit(`report written to ${values.out}`);
	}
	process.exit(0);
}

await main();
