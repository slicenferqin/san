/**
 * Context Steady State M2 — ContextPacket contract tests.
 */

import { describe, expect, test } from "bun:test";
import { buildContextCheckpoint } from "../../src/context-steady/checkpoint";
import { buildContextPacket, collectDigestRefs } from "../../src/context-steady/packet";
import type { ContextPacketSettings, TurnDigest } from "../../src/context-steady/types";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
} from "../../src/context-steady/types";

function digest(turnId: string, userIntent: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId: "s1",
		createdAt: new Date().toISOString(),
		source: { sessionId: "s1", fromEntryId: `${turnId}-from`, toEntryId: `${turnId}-to`, promptGeneration: 1 },
		userIntent,
		actionsTaken: [`acted on ${userIntent}`],
		decisions: [`decided ${turnId}`],
		filesTouched: [{ path: `src/${turnId}.ts`, action: "modified" }],
		toolEvidence: [],
		factsLearned: [],
		openQuestions: [],
		risks: [],
		nextSteps: [`continue ${turnId}`],
		memoryCandidates: [],
		fallback: true,
	};
}

function verboseDigest(turnId: string, userIntent: string): TurnDigest {
	return {
		...digest(turnId, userIntent),
		actionsTaken: Array.from({ length: 5 }, (_, index) => `action ${index} for ${userIntent}`),
		decisions: Array.from({ length: 5 }, (_, index) => `decision ${index} for ${userIntent}`),
		filesTouched: Array.from({ length: 8 }, (_, index) => ({
			path: `src/${turnId}/file-${index}.ts`,
			action: "modified",
		})),
		risks: Array.from({ length: 4 }, (_, index) => `risk ${index} for ${userIntent}`),
		nextSteps: Array.from({ length: 4 }, (_, index) => `next step ${index} for ${userIntent}`),
	};
}

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextPacket>[0];

function packetSettings(overrides: Partial<ContextPacketSettings> = {}): ContextPacketSettings {
	return {
		enabled: true,
		recentDigests: 3,
		maxTokens: 2000,
		qualityWindowTokens: 0,
		reserveRatio: 0.2,
		...overrides,
	};
}

describe("ContextPacket builder", () => {
	test("collects only TurnDigest custom entries", () => {
		const refs = collectDigestRefs(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first")),
				customEntry("x1", "other", { schemaVersion: 1, turnId: "not-a-digest", source: {} }),
				{ type: "custom_message", id: "m1", parentId: null, timestamp: new Date().toISOString() },
			]),
		);

		expect(refs.map(ref => ref.entryId)).toEqual(["d1"]);
	});

	test("builds a packet from recent digests with debug metadata", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"continue third task follow-up",
			packetSettings({ recentDigests: 2 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.schemaVersion).toBe(CONTEXT_PACKET_SCHEMA_VERSION);
		expect(built!.packet.injectedMessageCustomType).toBe(CONTEXT_PACKET_MESSAGE_TYPE);
		expect(built!.packet.digestRefs).toEqual(["d2", "d3"]);
		expect(built!.packet.tokenEstimate).toBeGreaterThan(0);
		expect(built!.packet.layers[0]!.tokenBudget).toBe(2000);
		expect(built!.packet.layers[0]!.stability).toBe("append-only");
		expect(built!.packet.layers[0]!.cachePriority).toBe("medium");
		expect(built!.packet.budget).toMatchObject({
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 2000,
			configuredPacketMaxTokens: 2000,
		});
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "recent_limit",
			omitted: 1,
		});
		expect(built!.content).toContain("second task");
		expect(built!.content).toContain("third task");
		expect(built!.content).not.toContain("first task");
	});

	test("places retrieved context after digest ledger as a volatile low-cache layer", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
			]),
			"s1",
			"continue second task follow-up",
			packetSettings({ recentDigests: 1 }),
			{
				query: "continue second task follow-up",
				tokenBudget: 500,
				items: [
					{
						id: "mem-1",
						content: "User prefers compact implementation reports",
						source: "mnemopi",
						timestamp: "2026-06-30T00:00:00.000Z",
						score: 0.91,
					},
				],
			},
		);

		expect(built).not.toBeNull();
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger", "retrieved_context"]);
		expect(built!.packet.layers[1]).toMatchObject({
			entryRefs: ["mem-1"],
			stability: "volatile",
			cachePriority: "low",
			tokenBudget: 500,
		});
		expect(built!.packet.recallQuery).toBe("continue second task follow-up");
		expect(built!.packet.recallRefs).toEqual(["mem-1"]);
		expect(built!.packet.tokenBudget).toBe(2000);
		expect(built!.content.indexOf("Recent turn digests")).toBeLessThan(built!.content.indexOf("Retrieved context"));
		expect(built!.content).toContain("Treat retrieved context as read-only background memory");
	});

	test("builds a recall-only packet for first-turn retrieved context", () => {
		const built = buildContextPacket(asEntries([]), "s1", "current prompt", packetSettings(), {
			query: "current prompt",
			tokenBudget: 500,
			items: [{ content: "Project decision: keep San docs in HTML", source: "mnemopi" }],
		});

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs).toEqual([]);
		expect(built!.packet.recallRefs).toEqual(["recall:1"]);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger", "retrieved_context"]);
		expect(built!.content).toContain("Recent turn digests: none");
		expect(built!.content).toContain("Project decision: keep San docs in HTML");
	});

	test("trims retrieved context against its own volatile token budget", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"continue first task follow-up",
			packetSettings(),
			{
				query: "continue first task follow-up",
				tokenBudget: 1,
				items: [
					{
						id: "mem-1",
						content: "A recalled project decision that cannot fit the volatile recall budget",
						source: "mnemopi",
					},
				],
			},
		);

		expect(built).not.toBeNull();
		expect(built!.packet.recallRefs).toEqual([]);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["turn_digest_ledger"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "retrieved_context",
			reason: "token_budget",
			omitted: 1,
		});
		expect(built!.content).not.toContain("Retrieved context");
		expect(built!.content).not.toContain("A recalled project decision");
	});

	test("returns null when disabled or no digests exist", () => {
		expect(
			buildContextPacket(asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first"))]), "s1", "p", {
				...packetSettings(),
				enabled: false,
			}),
		).toBeNull();
		expect(buildContextPacket(asEntries([]), "s1", "p", packetSettings())).toBeNull();
	});

	test("trims old digests when the packet exceeds the token budget", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"continue third task follow-up",
			packetSettings({ maxTokens: 180 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs.length).toBeLessThan(3);
		expect(built!.packet.tokenEstimate).toBeLessThanOrEqual(180);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "token_budget",
			omitted: 1,
		});
	});

	test("derives packet budget from quality window and reserve ratio", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"continue third task follow-up",
			packetSettings({ maxTokens: 2000, qualityWindowTokens: 220, reserveRatio: 0.25 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.tokenBudget).toBe(165);
		expect(built!.packet.budget).toEqual({
			qualityWindowTokens: 220,
			reserveRatio: 0.25,
			reservedTokens: 55,
			packetTokenBudget: 165,
			configuredPacketMaxTokens: 2000,
		});
		expect(built!.packet.layers[0]!.tokenBudget).toBe(165);
		expect(built!.packet.tokenEstimate).toBeLessThanOrEqual(165);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "token_budget",
			omitted: 1,
		});
	});

	test("returns null when the effective packet budget cannot hold any digest", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"continue first task follow-up",
			packetSettings({ maxTokens: 2000, qualityWindowTokens: 1, reserveRatio: 0.9 }),
		);

		expect(built).toBeNull();
	});

	test("returns null when the configured packet budget is disabled by zero tokens", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"continue first task follow-up",
			packetSettings({ maxTokens: 0, qualityWindowTokens: 0 }),
		);

		expect(built).toBeNull();
	});

	test("keeps maxTokens as a hard packet cap when quality window is configured", () => {
		const built = buildContextPacket(
			asEntries([customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task"))]),
			"s1",
			"continue first task follow-up",
			packetSettings({ maxTokens: 0, qualityWindowTokens: 220, reserveRatio: 0.25 }),
		);

		expect(built).toBeNull();
	});

	test("builds stable checkpoint entries from uncovered digest ledger prefix", () => {
		const built = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		);

		expect(built).not.toBeNull();
		expect(built!.checkpoint.entryRefs).toEqual(["d1", "d2"]);
		expect(built!.checkpoint.digestCount).toBe(2);
		expect(built!.checkpoint.stability).toBe("stable");
		expect(built!.checkpoint.cachePriority).toBe("high");
		expect(built!.checkpoint.summary.userIntents.map(item => item.text)).toEqual(["first task", "second task"]);
	});

	test("polishes turn-framed digest and checkpoint narration before packet rendering", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t1", "第1轮：确认 San context steady 基线。"),
					actionsTaken: ["第1轮读取推荐配置。"],
				}),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t2", "第2轮：复盘 digest 质量。"),
					actionsTaken: ["第2轮评估摘要是否历史化。"],
				}),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "第1轮：确认 San context steady 基线。")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "第2轮：复盘 digest 质量。")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t3", "第十轮：最终验收 San context steady 是否稳住。"),
					actionsTaken: ["第十轮给出最终验收结论。"],
				}),
			]),
			"s1",
			"继续总结 context steady 验收",
			packetSettings({ recentDigests: 5 }),
		);

		expect(checkpoint.summary.userIntents.map(item => item.text)).toEqual([
			"确认 San context steady 基线。",
			"复盘 digest 质量。",
		]);
		expect(built).not.toBeNull();
		expect(built!.content).not.toContain("第1轮");
		expect(built!.content).not.toContain("第2轮");
		expect(built!.content).not.toContain("第十轮");
		expect(built!.content).toContain("最终验收 San context steady 是否稳住。");
		expect(built!.content).toContain("给出最终验收结论。");
	});

	test("extends stable checkpoint coverage when another digest batch becomes eligible", () => {
		const firstCheckpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const secondCheckpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, firstCheckpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
				customEntry("d4", TURN_DIGEST_CUSTOM_TYPE, digest("t4", "fourth task")),
				customEntry("d5", TURN_DIGEST_CUSTOM_TYPE, digest("t5", "fifth task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, firstCheckpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
				customEntry("d4", TURN_DIGEST_CUSTOM_TYPE, digest("t4", "fourth task")),
				customEntry("ck2", CONTEXT_CHECKPOINT_CUSTOM_TYPE, secondCheckpoint),
				customEntry("d5", TURN_DIGEST_CUSTOM_TYPE, digest("t5", "fifth task")),
			]),
			"s1",
			"continue fifth task follow-up",
			packetSettings({ recentDigests: 5 }),
		);

		expect(secondCheckpoint.entryRefs).toEqual(["d1", "d2", "d3", "d4"]);
		expect(secondCheckpoint.digestCount).toBe(4);
		expect(secondCheckpoint.summary.userIntents.map(item => item.text)).toEqual([
			"first task",
			"second task",
			"third task",
			"fourth task",
		]);
		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck2");
		expect(built!.packet.digestRefs).toEqual(["d5"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: 4,
		});
		expect(built!.content).toContain("first task");
		expect(built!.content).toContain("fourth task");
		expect(built!.content).toContain("fifth task");
	});

	test("places stable checkpoint before append-only digest tail and avoids duplicated covered digests", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "first task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "second task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
			]),
			"s1",
			"continue third task follow-up",
			packetSettings({ recentDigests: 5 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck1");
		expect(built!.packet.tokenBudget).toBe(2000);
		expect(built!.packet.layers.map(layer => layer.name)).toEqual(["stable_checkpoint", "turn_digest_ledger"]);
		expect(built!.packet.layers[0]).toMatchObject({
			entryRefs: ["ck1"],
			stability: "stable",
			cachePriority: "high",
		});
		expect(built!.packet.layers[1]).toMatchObject({
			entryRefs: ["d3"],
			stability: "append-only",
			cachePriority: "medium",
		});
		expect(built!.packet.digestRefs).toEqual(["d3"]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: 2,
		});
		expect(built!.content).toContain("Stable checkpoint");
		expect(built!.content).toContain("first task");
		expect(built!.content).toContain("third task");
	});

	test("trims recall, old digests, and checkpoint summary against the total packet budget", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, verboseDigest("t1", "first verbose task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, verboseDigest("t2", "second verbose task")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, verboseDigest("t1", "first verbose task")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, verboseDigest("t2", "second verbose task")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
				customEntry("d3", TURN_DIGEST_CUSTOM_TYPE, digest("t3", "third task")),
				customEntry("d4", TURN_DIGEST_CUSTOM_TYPE, digest("t4", "fourth task")),
			]),
			"s1",
			"continue fourth task follow-up",
			packetSettings({ recentDigests: 2, maxTokens: 300 }),
			{
				query: "continue fourth task follow-up",
				tokenBudget: 1000,
				items: [
					{ id: "mem-1", content: "Recall item one ".repeat(20), source: "memory" },
					{ id: "mem-2", content: "Recall item two ".repeat(20), source: "memory" },
				],
			},
		);

		expect(built).not.toBeNull();
		expect(built!.packet.tokenBudget).toBe(300);
		expect(built!.packet.tokenEstimate).toBeLessThanOrEqual(300);
		expect(built!.packet.currentPromptPreview).toBe("continue fourth task follow-up");
		expect(built!.packet.digestRefs.at(-1)).toBe("d4");
		expect(built!.packet.trimDecisions).toEqual(
			expect.arrayContaining([
				{ layer: "retrieved_context", reason: "packet_total_budget", omitted: expect.any(Number) },
				{ layer: "turn_digest_ledger", reason: "packet_total_budget", omitted: expect.any(Number) },
				{ layer: "stable_checkpoint", reason: "packet_total_budget", omitted: expect.any(Number) },
			]),
		);
		const packetBudgetTrimLayers = built!.packet.trimDecisions
			.filter(decision => decision.reason === "packet_total_budget")
			.map(decision => decision.layer);
		expect(packetBudgetTrimLayers).toEqual(["retrieved_context", "turn_digest_ledger", "stable_checkpoint"]);
	});

	test("omits stale digest context when a new prompt shares entity terms but changes intent", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry(
					"d1",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t1", "Investigate Claude Code malware, mail tracking, and proxy routing signals"),
				),
			]),
			"s1",
			"Compare Claude Code model benchmark performance with GLM 5.2",
			packetSettings(),
		);

		expect(built).toBeNull();
	});

	test("keeps prior digest context when the prompt explicitly continues earlier work", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry(
					"d1",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t1", "Investigate Claude Code malware, mail tracking, and proxy routing signals"),
				),
			]),
			"s1",
			"继续上面的调查",
			packetSettings(),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs).toEqual(["d1"]);
		expect(built!.content).toContain("mail tracking");
	});

	test("keeps same-thread Chinese San context through file and action evidence", () => {
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t1", "Review San context steady recommended configuration"),
					actionsTaken: ["validated digest, contextPacket, checkpoint, and recall wiring"],
					filesTouched: [
						{ path: "packages/coding-agent/src/prompts/context-steady/recommended.yml", action: "read" },
					],
					toolEvidence: [{ tool: "read_file", summary: "inspected recommended.yml context steady settings" }],
				}),
			]),
			"s1",
			"请读取 recommended.yml，继续确认 digest/contextPacket/checkpoint/recall 的推荐配置",
			packetSettings(),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.digestRefs).toEqual(["d1"]);
		expect(built!.content).toContain("recommended.yml");
		expect(built!.content).toContain("digest, contextPacket, checkpoint, and recall wiring");
	});

	test("uses checkpoint file evidence for same-thread San configuration prompts", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t1", "Review San context steady recommended configuration"),
					filesTouched: [
						{ path: "packages/coding-agent/src/prompts/context-steady/recommended.yml", action: "read" },
					],
				}),
				customEntry(
					"d2",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t2", "Inspect context packet recall checkpoint behavior"),
				),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, {
					...digest("t1", "Review San context steady recommended configuration"),
					filesTouched: [
						{ path: "packages/coding-agent/src/prompts/context-steady/recommended.yml", action: "read" },
					],
				}),
				customEntry(
					"d2",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t2", "Inspect context packet recall checkpoint behavior"),
				),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
			]),
			"s1",
			"继续读取 recommended.yml，验收 digest/contextPacket/checkpoint/recall 是否稳态",
			packetSettings({ recentDigests: 5 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck1");
		expect(built!.packet.digestRefs).toEqual([]);
		expect(built!.packet.trimDecisions).toContainEqual({
			layer: "turn_digest_ledger",
			reason: "checkpoint_covered",
			omitted: 2,
		});
		expect(built!.content).toContain("recommended.yml");
	});

	test("keeps checkpoint for history-dependent summary prompts without explicit continue marker", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "Inspect San ContextPacket injection")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "Assess provider-bound pruning evidence")),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "Inspect San ContextPacket injection")),
				customEntry("d2", TURN_DIGEST_CUSTOM_TYPE, digest("t2", "Assess provider-bound pruning evidence")),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
			]),
			"s1",
			"请总结这 10 轮 dogfood 的验收结论和判断依据",
			packetSettings({ recentDigests: 5 }),
		);

		expect(built).not.toBeNull();
		expect(built!.packet.checkpointRef).toBe("ck1");
		expect(built!.packet.digestRefs).toEqual([]);
		expect(built!.content).toContain("ContextPacket injection");
		expect(built!.content).toContain("provider-bound pruning evidence");
	});

	test("drops prior San checkpoint and digest when the prompt explicitly rejects previous context", () => {
		const checkpoint = buildContextCheckpoint(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "Assess San context steady acceptance quality")),
				customEntry(
					"d2",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t2", "Review San context packet checkpoint recall behavior"),
				),
			]),
			"s1",
			{ enabled: true, checkpointEveryTurns: 2, checkpointMaxTokens: 12000 },
		)!.checkpoint;
		const built = buildContextPacket(
			asEntries([
				customEntry("d1", TURN_DIGEST_CUSTOM_TYPE, digest("t1", "Assess San context steady acceptance quality")),
				customEntry(
					"d2",
					TURN_DIGEST_CUSTOM_TYPE,
					digest("t2", "Review San context packet checkpoint recall behavior"),
				),
				customEntry("ck1", CONTEXT_CHECKPOINT_CUSTOM_TYPE, checkpoint),
			]),
			"s1",
			"请解释 release 流程，不要沿用前面 San context steady 的验收结论",
			packetSettings({ recentDigests: 5 }),
		);

		expect(built).toBeNull();
	});
});
