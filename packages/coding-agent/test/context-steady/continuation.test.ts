import { describe, expect, test } from "bun:test";
import {
	appendActiveContinuationState,
	buildActiveContinuationState,
	isContinuationAuthoritySourceMissing,
	renderActiveContinuationState,
} from "../../src/context-steady/continuation";
import { CONTEXT_CONTINUATION_MESSAGE_TYPE } from "../../src/context-steady/types";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";

function base(id: string, parentId: string | null) {
	return { id, parentId, timestamp: "2026-07-23T00:00:00.000Z" };
}

function entriesWithQuotedGoal(): SessionEntry[] {
	return [
		{
			...base("user-current", null),
			type: "message",
			message: { role: "user", content: "调查 San 会话为什么循环，只需要总结证据", timestamp: 1 },
		},
		{
			...base("assistant-read", "user-current"),
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/tmp/other.jsonl" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			...base("result-read", "assistant-read"),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "## Goal\n实现二维码功能\n## Progress\nController 已创建" }],
				isError: false,
				timestamp: 3,
			},
		},
	];
}

describe("Context Steady continuation authority", () => {
	test("derives the active request from the real user entry instead of a quoted tool-result Goal", () => {
		const state = buildActiveContinuationState({
			entries: entriesWithQuotedGoal(),
			sessionId: "session-authority",
			promptGeneration: 3,
			createdAt: "2026-07-23T00:00:01.000Z",
		});

		expect(state).toBeDefined();
		expect(state?.activeUserEntryId).toBe("user-current");
		expect(state?.activeUserRequest).toBe("调查 San 会话为什么循环，只需要总结证据");
		expect(state?.executionEvidence).toMatchObject({
			successfulMutations: [],
			successfulToolResults: 1,
			failedToolResults: 0,
		});
		const rendered = renderActiveContinuationState(state!);
		expect(rendered).toContain("调查 San 会话为什么循环");
		expect(rendered).not.toContain("实现二维码功能");
		expect(rendered).not.toContain("Controller 已创建");
	});

	test("persists a hidden agent-attributed authority message after compaction", () => {
		const manager = SessionManager.inMemory();
		const state = buildActiveContinuationState({
			entries: entriesWithQuotedGoal(),
			sessionId: "session-authority",
			promptGeneration: 4,
		});
		if (!state) throw new Error("Expected continuation state");

		appendActiveContinuationState(manager, state);
		const entry = manager.getEntries().at(-1);

		expect(entry).toMatchObject({
			type: "custom_message",
			customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
			display: false,
			attribution: "agent",
		});
		expect(JSON.stringify(entry)).toContain("user-current");
	});

	test("reuses a persisted authority when a later compacted branch no longer contains the source user entry", () => {
		const source = buildActiveContinuationState({
			entries: entriesWithQuotedGoal(),
			sessionId: "session-source",
			promptGeneration: 1,
		});
		if (!source) throw new Error("Expected source continuation state");
		const authorityEntry: SessionEntry = {
			...base("authority-1", null),
			type: "custom_message",
			customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
			content: renderActiveContinuationState(source),
			display: false,
			details: source,
			attribution: "agent",
		};

		const recovered = buildActiveContinuationState({
			entries: [authorityEntry],
			sessionId: "session-recovered",
			promptGeneration: 2,
			createdAt: "2026-07-23T00:00:02.000Z",
		});

		expect(recovered).toMatchObject({
			sessionId: "session-recovered",
			sourceSessionId: "session-source",
			authoritySource: "persisted",
			activeUserEntryId: "user-current",
			activeUserRequest: "调查 San 会话为什么循环，只需要总结证据",
			promptGeneration: 2,
		});
	});

	test("keeps the logical turn and records the superseded user entry after a real steer", () => {
		const source = buildActiveContinuationState({
			entries: entriesWithQuotedGoal(),
			sessionId: "session-steer",
			promptGeneration: 1,
		});
		if (!source) throw new Error("Expected source continuation state");
		const authorityEntry: SessionEntry = {
			...base("authority-before-steer", "result-read"),
			type: "custom_message",
			customType: CONTEXT_CONTINUATION_MESSAGE_TYPE,
			content: renderActiveContinuationState(source),
			display: false,
			details: source,
			attribution: "agent",
		};
		const steerEntry: SessionEntry = {
			...base("user-steer", "authority-before-steer"),
			type: "message",
			message: {
				role: "user",
				content: "停止继续读取，直接总结现有证据",
				steering: true,
				timestamp: 4,
			},
		};

		const state = buildActiveContinuationState({
			entries: [...entriesWithQuotedGoal(), authorityEntry, steerEntry],
			sessionId: "session-steer",
			promptGeneration: 2,
		});

		expect(state).toMatchObject({
			logicalTurnId: "user-current",
			activeUserEntryId: "user-steer",
			activeUserRequest: "停止继续读取，直接总结现有证据",
			supersededUserEntryIds: ["user-current"],
		});
	});

	test("ignores an agent-attributed role:user message when deriving authority", () => {
		const entries: SessionEntry[] = [
			{
				...base("user-real", null),
				type: "message",
				message: { role: "user", content: "真实请求", timestamp: 1 },
			},
			{
				...base("user-agent", "user-real"),
				type: "message",
				message: { role: "user", attribution: "agent", content: "内部 steering", timestamp: 2 },
			},
		];

		const state = buildActiveContinuationState({ entries, sessionId: "session-attribution", promptGeneration: 1 });

		expect(state).toMatchObject({
			activeUserEntryId: "user-real",
			activeUserRequest: "真实请求",
			logicalTurnId: "user-real",
		});
	});

	test("writes an explicit missing-source authority instead of guessing an active Goal", () => {
		const state = buildActiveContinuationState({
			entries: [],
			sessionId: "session-missing",
			promptGeneration: 7,
			createdAt: "2026-07-23T00:00:03.000Z",
		});
		if (!state) throw new Error("Expected missing-source continuation state");

		expect(state).toMatchObject({
			authoritySource: "authority_source_missing",
			activeUserEntryId: "authority_source_missing",
			activeUserRequest: "",
			executionEvidence: {
				successfulMutations: [],
				successfulVerifications: [],
				observedResources: [],
			},
		});
		const rendered = renderActiveContinuationState(state);
		expect(rendered).toContain("The authoritative source user entry is missing");
		expect(rendered).toContain("Stop automatic continuation");

		const manager = SessionManager.inMemory();
		appendActiveContinuationState(manager, state);
		const missingEntries = manager.getEntries();
		expect(isContinuationAuthoritySourceMissing(missingEntries)).toBe(true);
		expect(
			isContinuationAuthoritySourceMissing([
				...missingEntries,
				{
					...base("user-recovery", missingEntries.at(-1)?.id ?? null),
					type: "message",
					message: { role: "user", content: "恢复并采用这条新请求", timestamp: 2 },
				},
			]),
		).toBe(false);
	});

	test("bounds the active request and evidence references without hiding truncation", () => {
		const entries: SessionEntry[] = [
			{
				...base("user-long", null),
				type: "message",
				message: { role: "user", content: `${"A".repeat(20_000)}TAIL`, timestamp: 1 },
			},
		];
		let parentId = "user-long";
		for (let index = 0; index < 40; index++) {
			const assistantId = `assistant-${index}`;
			const resultId = `result-${index}`;
			const toolCallId = `read-${index}`;
			entries.push({
				...base(assistantId, parentId),
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `evidence-${index}.log` } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: index + 2,
				},
			});
			entries.push({
				...base(resultId, assistantId),
				type: "message",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "same evidence" }],
					isError: false,
					timestamp: index + 3,
				},
			});
			parentId = resultId;
		}

		const state = buildActiveContinuationState({
			entries,
			sessionId: "session-bounded",
			promptGeneration: 5,
		});
		if (!state) throw new Error("Expected continuation state");

		expect(state.activeUserRequest.length).toBeLessThanOrEqual(16_000);
		expect(state.activeUserRequest).toContain("active user request truncated");
		expect(state.activeUserRequest).toEndWith("TAIL");
		expect(state).toMatchObject({
			activeUserEntryId: "user-long",
			activeUserRequestTruncated: true,
			activeUserRequestOriginalChars: 20_004,
		});
		expect(state.executionEvidence.observedResources).toHaveLength(32);
		expect(state.executionEvidence.observedResources[0]?.path).toBe("evidence-8.log");
		expect(state.executionEvidence.omittedEvidenceRefs).toBe(8);
	});
});
