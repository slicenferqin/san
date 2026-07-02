import { describe, expect, test } from "bun:test";
import type { ContextPacket } from "../../src/context-steady";
import {
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	CONTEXT_PACKET_SCHEMA_VERSION,
} from "../../src/context-steady";
import {
	appendSanLoopEvent,
	appendSanLoopRoleContextDebugEntry,
	appendSanLoopRunSnapshot,
	buildSanLoopRoleContext,
	createSanLoopEvent,
	createSanLoopRunSnapshot,
	SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
	type SanLoopWorkerAssignment,
	updateSanLoopRunSnapshot,
} from "../../src/san-loop";
import { SessionManager } from "../../src/session/session-manager";

function contextPacket(): ContextPacket {
	return {
		schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
		packetId: "ctx_1",
		sessionId: "session-1",
		createdAt: "2026-07-01T00:00:00.000Z",
		currentPromptPreview: "Ship v0.2",
		layers: [],
		digestRefs: [],
		recallRefs: [],
		tokenEstimate: 0,
		tokenBudget: 0,
		budget: {
			qualityWindowTokens: 0,
			reserveRatio: 0.2,
			reservedTokens: 0,
			packetTokenBudget: 0,
			configuredPacketMaxTokens: 0,
		},
		trimDecisions: [],
		injectedMessageCustomType: CONTEXT_PACKET_MESSAGE_TYPE,
	};
}

describe("San loop role context", () => {
	test("builds worker role context from latest run, assignment, review, and context packet refs", () => {
		const session = SessionManager.inMemory();
		const assignment: SanLoopWorkerAssignment = {
			assignmentId: "assign-1",
			runId: "loop_1",
			createdAt: "2026-07-01T00:01:00.000Z",
			objective: "Implement P2 role context",
			taskNodeIds: ["task-1"],
			instructions: "Create role context helper",
			acceptanceCriteria: ["Worker sees assignment"],
			contextRefs: ["ctx_1"],
			checkRefs: ["typescript"],
			status: "pending",
		};
		const run = updateSanLoopRunSnapshot(
			createSanLoopRunSnapshot({
				sessionId: "session-1",
				objective: "Ship v0.2 execution loop",
				runId: "loop_1",
				createdAt: "2026-07-01T00:00:00.000Z",
				contextPacketRefs: ["ctx-entry"],
			}),
			{
				assignments: [assignment],
				decisions: [
					{
						decisionId: "decision-1",
						runId: "loop_1",
						createdAt: "2026-07-01T00:02:00.000Z",
						actor: "commander",
						decision: "Dispatch worker",
						rationale: "P2 needs scoped implementation",
					},
				],
			},
		);
		const runEntryId = appendSanLoopRunSnapshot(session, run);
		appendSanLoopEvent(
			session,
			createSanLoopEvent(run, "assignment_created", "assigned P2 context", {
				eventId: "evt-1",
				actor: "commander",
				refs: [runEntryId],
			}),
		);
		session.appendCustomEntry(CONTEXT_PACKET_CUSTOM_TYPE, contextPacket());

		const built = buildSanLoopRoleContext(session.getEntries(), {
			role: "worker",
			runId: "loop_1",
			assignmentId: "assign-1",
			packetId: "loop_ctx_1",
			createdAt: "2026-07-01T00:03:00.000Z",
		});

		expect(built).not.toBeNull();
		expect(built!.packet).toMatchObject({
			schemaVersion: 1,
			packetId: "loop_ctx_1",
			runId: "loop_1",
			sessionId: "session-1",
			role: "worker",
			sourceContextPacketRefs: ["ctx-entry", session.getEntries().at(-1)!.id],
		});
		expect(built!.packet.entryRefs).toContain(runEntryId);
		expect(built!.packet.tokenEstimate).toBeGreaterThan(0);
		expect(built!.content).toContain('<san_execution_loop_context role="worker">');
		expect(built!.content).toContain("Implement P2 role context");
		expect(built!.content).toContain("Worker sees assignment");
		expect(built!.content).toContain("Dispatch worker");

		const debugEntryId = appendSanLoopRoleContextDebugEntry(session, built!.packet);
		const debugEntry = session.getEntry(debugEntryId);
		expect(debugEntry).toMatchObject({
			type: "custom",
			customType: SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
		});
	});

	test("returns null when no loop run exists", () => {
		expect(buildSanLoopRoleContext([], { role: "commander" })).toBeNull();
	});
});
