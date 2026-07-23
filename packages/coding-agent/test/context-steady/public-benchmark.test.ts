import { describe, expect, test } from "bun:test";

import {
	assertBenchmarkCostGuard,
	assertSecureRuntimeKeyTransport,
	BENCHMARK_TOOL_NAMES,
	type BenchmarkTaskSpec,
	buildBenchmarkPlan,
	collectInvalidInfrastructurePairs,
	consumeInheritedSecretEnvironment,
	parseRuntimeApiKeysStdin,
	parseRuntimeKeyEnvAssignments,
	resolveRuntimeApiKeys,
	summarizeBenchmarkAuthorityProtocol,
	summarizeBenchmarkEvidenceProtocol,
	summarizeComparablePairs,
	summarizeContextProbe,
	summarizeInfrastructureFailures,
} from "../../scripts/san-context-steady-benchmark";
import { createBenchmarkEvidenceChainController } from "../../scripts/san-context-steady-benchmark-evidence";
import { redactRuntimeSecrets } from "../../scripts/san-v02-single-agent-runner";

function task(id: string): BenchmarkTaskSpec {
	return {
		id,
		label: `Task ${id}`,
		objective: `Complete ${id}`,
		verifier: { argv: ["bun", "test"] },
	};
}

describe("Context Steady 公共 benchmark", () => {
	test("Native 与 Steady 可用不同环境变量为同一组 provider 注入凭证", () => {
		const native = parseRuntimeKeyEnvAssignments("asxs=BENCH_NATIVE_KEY,self=BENCH_NATIVE_KEY", "--native-key-env");
		const steady = parseRuntimeKeyEnvAssignments("asxs=BENCH_STEADY_KEY,self=BENCH_STEADY_KEY", "--steady-key-env");

		expect(Object.fromEntries(resolveRuntimeApiKeys(native, { BENCH_NATIVE_KEY: "native-secret" }))).toEqual({
			asxs: "native-secret",
			self: "native-secret",
		});
		expect(Object.fromEntries(resolveRuntimeApiKeys(steady, { BENCH_STEADY_KEY: "steady-secret" }))).toEqual({
			asxs: "steady-secret",
			self: "steady-secret",
		});
	});

	test("凭证解析缺失时报环境变量名且不泄漏已解析的 key", () => {
		const assignments = parseRuntimeKeyEnvAssignments(
			"asxs=BENCH_MAIN_KEY,self=BENCH_DIGEST_KEY",
			"--steady-key-env",
		);
		let message = "";
		try {
			resolveRuntimeApiKeys(assignments, { BENCH_MAIN_KEY: "must-not-leak" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("BENCH_DIGEST_KEY");
		expect(message).not.toContain("must-not-leak");
	});

	test("付费运行从 stdin 读取分组凭证且拒绝进程环境传输", () => {
		const keys = parseRuntimeApiKeysStdin(
			JSON.stringify({
				native: { asxs: "native-secret", self: "native-secret" },
				steady: { asxs: "steady-secret", self: "steady-secret" },
			}),
			"asxs/gpt-5.6-sol:xhigh",
		);

		expect(Object.fromEntries(keys.native)).toEqual({ asxs: "native-secret", self: "native-secret" });
		expect(Object.fromEntries(keys.steady)).toEqual({ asxs: "steady-secret", self: "steady-secret" });
		expect(() => assertSecureRuntimeKeyTransport(false, 2)).toThrow("process-environment");
		expect(() => assertSecureRuntimeKeyTransport(true, 2)).not.toThrow();
	});

	test("stdin 凭证解析错误不回显密钥载荷", () => {
		const secret = "MUST_NOT_LEAK_RUNTIME_SECRET";
		let message = "";
		try {
			parseRuntimeApiKeysStdin(`{"native":{"${secret}":"value"},"steady":{}}`, "asxs/gpt-5.6-sol:xhigh");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("invalid provider id");
		expect(message).not.toContain(secret);
	});

	test("运行时凭证从报告和会话文本中做不可逆替换", () => {
		const redacted = redactRuntimeSecrets("long-secret-value short-secret long-secret-value", [
			"short-secret",
			"long-secret-value",
		]);

		expect(redacted).toBe("[REDACTED_RUNTIME_API_KEY] [REDACTED_RUNTIME_API_KEY] [REDACTED_RUNTIME_API_KEY]");
	});

	test("付费 runner 移除继承的敏感环境变量并保留脱敏值", () => {
		const environment: Record<string, string | undefined> = {
			EXAMPLE_API_KEY: "inherited-secret-value",
			NORMAL_SETTING: "keep-me",
		};

		expect(consumeInheritedSecretEnvironment(environment)).toEqual(["inherited-secret-value"]);
		expect(environment).toEqual({ NORMAL_SETTING: "keep-me" });
	});

	test("Benchmark 使用严格工具白名单且不暴露 eval 旁路", () => {
		expect(BENCHMARK_TOOL_NAMES).toContain("benchmark_step");
		expect(BENCHMARK_TOOL_NAMES).toContain("benchmark_test");
		expect(BENCHMARK_TOOL_NAMES).toContain("benchmark_incident_report");
		expect(BENCHMARK_TOOL_NAMES).not.toContain("bash");
		expect(BENCHMARK_TOOL_NAMES).not.toContain("lsp");
		expect(BENCHMARK_TOOL_NAMES).not.toContain("todo");
		expect(BENCHMARK_TOOL_NAMES).not.toContain("eval");
		expect(BENCHMARK_TOOL_NAMES).not.toContain("task");
	});

	test("smoke 只计划一个任务的一组 Native/Steady 配对", () => {
		const plan = buildBenchmarkPlan([task("L1")], "smoke", "fixed-seed");

		expect(plan).toHaveLength(2);
		expect(new Set(plan.map(item => item.mode))).toEqual(new Set(["native", "steady"]));
		expect(plan.every(item => item.pair === 1 && item.run === 1 && item.task.id === "L1")).toBe(true);
	});

	test("confidence 产生三个任务各三组配对", () => {
		const plan = buildBenchmarkPlan([task("L1"), task("L2"), task("L3")], "confidence", "fixed-seed");

		expect(plan).toHaveLength(18);
		expect(new Set(plan.map(item => item.pair)).size).toBe(9);
		for (const pair of new Set(plan.map(item => item.pair))) {
			expect(
				plan
					.filter(item => item.pair === pair)
					.map(item => item.mode)
					.sort(),
			).toEqual(["native", "steady"]);
		}
	});

	test("Standard 和 Confidence 优先包含成本校准压力任务", () => {
		const stress = { ...task("L5"), calibration: true };
		const plan = buildBenchmarkPlan([task("L1"), task("L2"), task("L3"), task("L4"), stress], "standard", "seed");

		expect(new Set(plan.map(item => item.task.id))).toEqual(new Set(["L1", "L2", "L5"]));
	});

	test("release 默认 30 次，extended 才扩展到 50 次", () => {
		const tasks = [task("L1"), task("L2"), task("L3"), task("L4"), task("L5")];
		expect(buildBenchmarkPlan(tasks, "release", "fixed-seed")).toHaveLength(30);
		expect(buildBenchmarkPlan(tasks, "extended", "fixed-seed")).toHaveLength(50);
	});

	test("高成本档位在模型调用前强制费用预估和显式放行", () => {
		expect(() =>
			assertBenchmarkCostGuard({
				profile: "confidence",
				plannedRuns: 18,
				maxEstimatedCost: 200,
				allowExpensive: false,
			}),
		).toThrow("--estimated-cost-per-run");
		expect(() =>
			assertBenchmarkCostGuard({
				profile: "confidence",
				plannedRuns: 18,
				estimatedCostPerRun: 20,
				maxEstimatedCost: 200,
				allowExpensive: false,
			}),
		).toThrow("exceeds");
		expect(() =>
			assertBenchmarkCostGuard({
				profile: "confidence",
				plannedRuns: 18,
				estimatedCostPerRun: 20,
				maxEstimatedCost: 200,
				allowExpensive: true,
			}),
		).not.toThrow();
	});

	test("探针汇总按公开价格计算真实缓存成本和稳态峰值", () => {
		const probe = [
			{
				timestamp: "2026-07-17T00:00:00.000Z",
				usage: { input: 200, output: 10, cacheRead: 800, cacheWrite: 0, promptTokens: 1000 },
				context: {
					activeEstimatedTokens: 900,
					rawJournalEstimatedTokens: 1200,
					rawJournalWouldTriggerNativeCompaction: false,
				},
				maintenance: { compactionCount: 1, segmentCount: 1 },
			},
			{
				timestamp: "2026-07-17T00:01:00.000Z",
				usage: { input: 100, output: 20, cacheRead: 1900, cacheWrite: 50, promptTokens: 2050 },
				context: {
					activeEstimatedTokens: 1500,
					rawJournalEstimatedTokens: 2600,
					rawJournalWouldTriggerNativeCompaction: true,
				},
				maintenance: { compactionCount: 2, segmentCount: 2 },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		const summary = summarizeContextProbe(probe);

		expect(summary.promptTokens).toBe(3050);
		expect(summary.cacheReadRate).toBeCloseTo(2700 / 3050);
		expect(summary.maxActiveTokens).toBe(1500);
		expect(summary.maxRawTokens).toBe(2600);
		expect(summary.compactionCount).toBe(2);
		expect(summary.firstNativeThresholdCrossing).toBe("2026-07-17T00:01:00.000Z");
		expect(summary.estimatedCost).toBeCloseTo(0.0040625);
	});

	test("探针把 Digest 与 Compaction usage 计入总成本并单独列出维护开销", () => {
		const probe = [
			{
				request: { kind: "agent" },
				usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, promptTokens: 1000 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1000 },
				maintenance: { compactionCount: 0, segmentCount: 0 },
			},
			{
				request: { kind: "turn_digest" },
				usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, promptTokens: 200 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1000 },
				maintenance: { compactionCount: 0, segmentCount: 0 },
			},
			{
				request: { kind: "compaction" },
				usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, promptTokens: 300 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1000 },
				maintenance: { compactionCount: 1, segmentCount: 0 },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		const summary = summarizeContextProbe(probe);

		expect(summary.promptTokens).toBe(1500);
		expect(summary.agentPromptTokens).toBe(1000);
		expect(summary.maintenancePromptTokens).toBe(500);
		expect(summary).toMatchObject({ agentRequests: 1, digestRequests: 1, compactionRequests: 1 });
		expect(summary.estimatedCost).toBeCloseTo(summary.agentEstimatedCost + summary.maintenanceEstimatedCost);
	});

	test("探针汇总兼容 v2/v3 混合记录且 maintenance decision 不计为 agent 请求", () => {
		const probe = [
			{
				schemaVersion: 2,
				request: { kind: "agent" },
				usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, promptTokens: 1000 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1000 },
				maintenance: { compactionCount: 0, segmentCount: 0 },
			},
			{
				schemaVersion: 3,
				request: { kind: "compaction" },
				usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, promptTokens: 300 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1200 },
				maintenance: { compactionCount: 1, segmentCount: 0 },
				compaction: { summaryInputTokens: 280, summaryOutputTokens: 25, summarySource: "local" },
			},
			{
				schemaVersion: 3,
				request: { kind: "maintenance" },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
				context: { activeEstimatedTokens: 900, rawJournalEstimatedTokens: 1300 },
				maintenance: {
					compactionCount: 1,
					segmentCount: 1,
					maintenanceId: "maintenance-checkpoint",
					primaryTrigger: "segment_tokens",
					action: "checkpoint",
				},
				authority: { forbiddenGoalField: false, executionClaimConflictCount: 0 },
				convergence: { softRedirects: 0, forcedFinalizations: 0 },
			},
			{
				schemaVersion: 3,
				request: { kind: "maintenance" },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
				context: { activeEstimatedTokens: 500, rawJournalEstimatedTokens: 1400 },
				maintenance: {
					compactionCount: 2,
					segmentCount: 1,
					maintenanceId: "maintenance-physical",
					primaryTrigger: "native_threshold",
					action: "context-full",
				},
				compaction: { tokensBefore: 1400, tokensAfter: 500, summarySource: "local" },
				authority: { forbiddenGoalField: true, executionClaimConflictCount: 2 },
				convergence: { softRedirects: 1, forcedFinalizations: 1 },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		const summary = summarizeContextProbe(probe);

		expect(summary).toMatchObject({
			schemaVersions: [2, 3],
			agentRequests: 1,
			compactionRequests: 1,
			maintenanceRecords: 2,
			checkpointMaintenanceCount: 1,
			physicalMaintenanceCount: 1,
			summaryInputTokens: 280,
			summaryOutputTokens: 25,
			summarySources: ["local"],
			maintenanceTriggers: ["native_threshold", "segment_tokens"],
			forbiddenGoalDetected: true,
			maxExecutionClaimConflictCount: 2,
			maxSoftRedirects: 1,
			maxForcedFinalizations: 1,
		});
	});

	test("受控证据链必须按 proof 串行推进且不能批量跳步", () => {
		const controller = createBenchmarkEvidenceChainController({ steps: 3, seed: "test", payloadChars: 500 });
		const first = controller.advance({ step: 1 });
		expect(() => controller.advance({ step: 3, previousProof: first.proof })).toThrow(/expected.*step=2/i);
		expect(() => controller.advance({ step: 2, previousProof: "wrong" })).toThrow(/proof.*step=2/i);
		const second = controller.advance({ step: 2, previousProof: first.proof });
		controller.advance({ step: 3, previousProof: second.proof });

		expect(controller.state.completedSteps).toBe(3);
		expect(controller.state.records.map(record => record.step)).toEqual([1, 2, 3]);
		expect(controller.state.records.at(-1)?.constraint).toContain("final service");
	});

	test("meta-investigation 证据链注入嵌套 Goal，但结构化 RECORD 保持纯净", () => {
		const controller = createBenchmarkEvidenceChainController({
			steps: 3,
			seed: "test",
			payloadChars: 500,
			adversarialContext: true,
		});
		const first = controller.advance({ step: 1 });

		expect(first.text).toContain("<quoted_external_session>");
		expect(first.text).toContain("## Goal");
		expect(first.text).toContain("SQL migration、Controller 和测试已经创建并验证通过");
		expect(JSON.stringify(first.record)).not.toContain("## Goal");
	});

	test("meta-investigation authority 门禁要求每次维护都引用当时真实 user entry", () => {
		const journal = [
			{
				type: "message",
				id: "user-1",
				message: { role: "user", content: "调查循环" },
			},
			{
				type: "custom_message",
				customType: "san.context_continuation.authority",
				details: { activeUserEntryId: "user-1", authoritySource: "journal" },
			},
			{
				type: "message",
				id: "user-2",
				message: { role: "user", content: "停止调查，直接结论" },
			},
			{
				type: "custom_message",
				customType: "san.context_continuation.authority",
				details: { activeUserEntryId: "user-2", authoritySource: "journal" },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");
		const poisoned = `${journal}\n${JSON.stringify({
			type: "custom_message",
			customType: "san.context_continuation.authority",
			details: { activeUserEntryId: "foreign-goal", authoritySource: "persisted" },
		})}`;

		expect(summarizeBenchmarkAuthorityProtocol(journal)).toEqual({
			authorityStates: 2,
			matchingAuthorityStates: 2,
			missingSourceStates: 0,
			mismatchedAuthorityStates: 0,
			valid: true,
		});
		expect(summarizeBenchmarkAuthorityProtocol(poisoned)).toMatchObject({
			mismatchedAuthorityStates: 1,
			valid: false,
		});
	});

	test("证据压力任务只接受每个助手消息一次的直接 benchmark_step 调用", () => {
		const message = (calls: number) => ({
			type: "message",
			message: {
				role: "assistant",
				content: Array.from({ length: calls }, () => ({ type: "toolCall", name: "benchmark_step" })),
			},
		});
		const valid = [message(1), message(1)].map(record => JSON.stringify(record)).join("\n");
		const batched = [message(2)].map(record => JSON.stringify(record)).join("\n");

		expect(summarizeBenchmarkEvidenceProtocol(valid, 2)).toEqual({
			expectedDirectCalls: 2,
			directCalls: 2,
			assistantMessagesWithCalls: 2,
			maxCallsPerAssistantMessage: 1,
			valid: true,
		});
		expect(summarizeBenchmarkEvidenceProtocol(batched, 2)).toMatchObject({
			directCalls: 2,
			assistantMessagesWithCalls: 1,
			maxCallsPerAssistantMessage: 2,
			valid: false,
		});
	});

	test("Provider 429/5xx 和网络错误会使整组配对失效", () => {
		const session = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "error",
					provider: "asxs",
					model: "gpt-5.6-sol",
					errorStatus: 429,
					errorMessage: "concurrency limit exceeded",
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: { role: "assistant", stopReason: "stop", provider: "asxs", model: "gpt-5.6-sol" },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		expect(summarizeInfrastructureFailures(session)).toMatchObject({
			failed: true,
			events: [{ provider: "asxs", status: 429, message: "concurrency limit exceeded" }],
		});
	});

	test("Digest 和 Compaction 的基础设施错误同样使整组配对失效", () => {
		const session = JSON.stringify({
			type: "message",
			message: { role: "assistant", stopReason: "stop", provider: "asxs", model: "gpt-5.6-sol" },
		});
		const probe = [
			{
				request: {
					kind: "turn_digest",
					stopReason: "error",
					errorStatus: 503,
					errorMessage: "service unavailable",
				},
				model: { provider: "self", id: "gpt-5.4-mini" },
			},
			{
				request: {
					kind: "compaction",
					stopReason: "error",
					errorMessage: "network socket disconnected",
				},
				model: { provider: "asxs", id: "gpt-5.6-sol" },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");

		expect(summarizeInfrastructureFailures(session, probe)).toMatchObject({
			failed: true,
			events: [
				{
					requestKind: "turn_digest",
					provider: "self",
					model: "gpt-5.4-mini",
					status: 503,
					message: "service unavailable",
				},
				{
					requestKind: "compaction",
					provider: "asxs",
					model: "gpt-5.6-sol",
					message: "network socket disconnected",
				},
			],
		});
	});

	test("Provider overload、stream read 和额度错误同样使整组配对失效", () => {
		const session = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "error",
					errorStatus: 400,
					errorMessage: "server_is_overloaded",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "error",
					errorStatus: 403,
					errorMessage: "insufficient_quota",
				},
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n");
		const probe = JSON.stringify({
			request: { kind: "agent", stopReason: "error", errorMessage: "stream_read_error" },
			model: { provider: "asxs", id: "gpt-5.6-sol" },
		});

		const summary = summarizeInfrastructureFailures(session, probe);

		expect(summary.failed).toBe(true);
		expect(summary.events.map(event => event.message)).toEqual([
			"server_is_overloaded",
			"insufficient_quota",
			"stream_read_error",
		]);
	});

	test("最终仍含基础设施错误的整个配对会从汇总中排除", () => {
		expect(
			collectInvalidInfrastructurePairs([
				{ pair: 1, infrastructure: { failed: false, events: [] } },
				{ pair: 1, infrastructure: { failed: true, events: [{ message: "stream_read_error" }] } },
				{ pair: 2, infrastructure: { failed: false, events: [] } },
				{ pair: 2, infrastructure: { failed: false, events: [] } },
			]),
		).toEqual([1]);
	});

	test("效率只汇总 Native 和 Steady 都通过质量门禁的配对", () => {
		const probe = summarizeContextProbe(
			JSON.stringify({
				usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, promptTokens: 1000 },
				context: { activeEstimatedTokens: 800, rawJournalEstimatedTokens: 1000 },
				maintenance: { compactionCount: 0, segmentCount: 0 },
			}),
		);
		const summary = summarizeComparablePairs([
			{ pair: 1, mode: "native", qualityPassed: true, probe },
			{ pair: 1, mode: "steady", qualityPassed: true, probe: { ...probe, promptTokens: 700, estimatedCost: 0.002 } },
			{ pair: 2, mode: "native", qualityPassed: true, probe },
			{ pair: 2, mode: "steady", qualityPassed: false, probe },
		]);

		expect(summary.totalPairs).toBe(2);
		expect(summary.comparablePairs).toBe(1);
		expect(summary.nativePromptTokens).toBe(1000);
		expect(summary.steadyPromptTokens).toBe(700);
		expect(summary.promptTokenSavingsRate).toBeCloseTo(0.3);
		expect(summary.promptSavingsDistribution).toEqual({
			count: 1,
			median: 0.3,
			q1: 0.3,
			q3: 0.3,
			bootstrap95Low: 0.3,
			bootstrap95High: 0.3,
		});
	});
});
