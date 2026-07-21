import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	appendContextProbeRecord,
	buildContextProbeRecord,
	contextProbeFilePath,
} from "../../src/context-steady/probe";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 20_000,
			output: 500,
			cacheRead: 80_000,
			cacheWrite: 5_000,
			totalTokens: 105_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("Context steady sidecar probe", () => {
	test("records exact provider usage separately from the native-compaction baseline signal", () => {
		const record = buildContextProbeRecord({
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			requestKind: "agent",
			assistant: assistant(),
			contextWindow: 500_000,
			steadyEnabled: true,
			activeEstimatedTokens: 120_000,
			rawJournalEstimatedTokens: 260_000,
			nativeCompactionStrategy: "snapcompact",
			nativeCompactionThresholdTokens: 240_000,
			steadyTargetTokens: 240_000,
			compactionIds: ["compaction-1"],
			segmentIds: ["segment-1", "segment-2"],
			prefixFingerprint: "prefix-b",
			previousPrefixFingerprint: "prefix-a",
		});

		expect(record.request).toEqual({ kind: "agent", stopReason: "stop" });
		expect(record.usage).toMatchObject({ promptTokens: 105_000, cacheReadRate: 80_000 / 105_000 });
		expect(record.context).toMatchObject({
			steadyEnabled: true,
			archivedEstimatedTokens: 140_000,
			nativeCompactionStrategy: "snapcompact",
			rawJournalWouldTriggerNativeCompaction: true,
		});
		expect(record.maintenance).toMatchObject({ compactionCount: 1, segmentCount: 2 });
		expect(record.cache.prefixChanged).toBe(true);
	});

	test("preserves provider error details for benchmark infrastructure classification", () => {
		const response = assistant();
		response.stopReason = "error";
		response.errorStatus = 503;
		response.errorMessage = "service unavailable";
		const record = buildContextProbeRecord({
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			requestKind: "compaction",
			assistant: response,
			contextWindow: 500_000,
			steadyEnabled: true,
			activeEstimatedTokens: 120_000,
			rawJournalEstimatedTokens: 260_000,
			nativeCompactionStrategy: "snapcompact",
			nativeCompactionThresholdTokens: 240_000,
			steadyTargetTokens: 240_000,
			compactionIds: [],
			segmentIds: [],
			prefixFingerprint: "prefix-a",
		});

		expect(record.request).toMatchObject({
			kind: "compaction",
			stopReason: "error",
			errorStatus: 503,
			errorMessage: "service unavailable",
		});
	});

	test("uses a sidecar path that cannot enter the session journal", () => {
		expect(contextProbeFilePath("/tmp/session.jsonl")).toBe("/tmp/session.context-probe.jsonl");
	});

	test("appends observations to the sidecar JSONL", async () => {
		const tempDir = TempDir.createSync("@pi-context-probe-");
		try {
			const sessionFile = `${tempDir.path()}/session.jsonl`;
			const record = buildContextProbeRecord({
				sessionId: "session-1",
				sessionFile,
				requestKind: "turn_digest",
				assistant: assistant(),
				contextWindow: 500_000,
				steadyEnabled: false,
				activeEstimatedTokens: 100_000,
				rawJournalEstimatedTokens: 100_000,
				nativeCompactionStrategy: "snapcompact",
				nativeCompactionThresholdTokens: 240_000,
				steadyTargetTokens: 240_000,
				compactionIds: [],
				segmentIds: [],
				prefixFingerprint: "prefix-a",
			});
			await appendContextProbeRecord(sessionFile, record);
			const records = Bun.JSONL.parse(await Bun.file(contextProbeFilePath(sessionFile)).text()) as Array<{
				sessionId: string;
				usage: { promptTokens: number };
			}>;
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ sessionId: "session-1", request: { kind: "turn_digest" } });
			expect(records[0]!.usage.promptTokens).toBeGreaterThan(0);
		} finally {
			await tempDir.remove();
		}
	});
});
