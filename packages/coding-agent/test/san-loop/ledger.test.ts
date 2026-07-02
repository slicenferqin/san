import { describe, expect, test } from "bun:test";
import {
	abortSanLoopRun,
	appendSanLoopEvent,
	appendSanLoopRunSnapshot,
	createSanLoopEvent,
	createSanLoopRunSnapshot,
	findLatestSanLoopRun,
	rebuildSanLoopLedger,
	recordSanLoopRunCreated,
	recordSanLoopTransition,
	SAN_LOOP_EVENT_CUSTOM_TYPE,
	SAN_LOOP_RUN_CUSTOM_TYPE,
	updateSanLoopRunSnapshot,
} from "../../src/san-loop";
import { SessionManager } from "../../src/session/session-manager";

describe("San loop ledger", () => {
	test("records a run and run_created event as custom entries", () => {
		const session = SessionManager.inMemory();

		const result = recordSanLoopRunCreated(session, {
			sessionId: session.getSessionId(),
			objective: "Ship v0.2 execution loop",
			mode: "deep",
			runId: "loop_test",
			createdAt: "2026-07-01T00:00:00.000Z",
			maxRetries: 3,
			initialRemainingTurns: 12,
		});

		expect(result.runEntryId).toBeString();
		expect(result.eventEntryId).toBeString();
		const entries = session.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: SAN_LOOP_RUN_CUSTOM_TYPE,
		});
		expect(entries[1]).toMatchObject({
			type: "custom",
			customType: SAN_LOOP_EVENT_CUSTOM_TYPE,
		});

		const ledger = rebuildSanLoopLedger(entries);
		expect(ledger.runs).toHaveLength(1);
		expect(ledger.events).toHaveLength(1);
		expect(ledger.latestRun?.data).toMatchObject({
			runId: "loop_test",
			objective: "Ship v0.2 execution loop",
			mode: "deep",
			status: "planning",
			maxRetries: 3,
		});
		expect(ledger.latestRun?.data.budget).toEqual([
			{ createdAt: "2026-07-01T00:00:00.000Z", state: "planning", remainingTurns: 12 },
		]);
		expect(ledger.events[0]?.data).toMatchObject({
			runId: "loop_test",
			type: "run_created",
			refs: [result.runEntryId],
		});
	});

	test("rebuilds latest run state from append-only snapshots", () => {
		const session = SessionManager.inMemory();
		const initial = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Fix execution loop",
			runId: "loop_state",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		appendSanLoopRunSnapshot(session, initial);
		appendSanLoopEvent(session, createSanLoopEvent(initial, "run_created", "started", { eventId: "evt_1" }));

		const updated = updateSanLoopRunSnapshot(initial, {
			status: "reviewing",
			updatedAt: "2026-07-01T00:10:00.000Z",
			contextPacketRefs: ["packet-1"],
			budget: [{ createdAt: "2026-07-01T00:09:00.000Z", state: "reviewing", remainingTurns: 2 }],
		});
		appendSanLoopRunSnapshot(session, updated);
		appendSanLoopEvent(session, createSanLoopEvent(updated, "review_completed", "reviewed", { eventId: "evt_2" }));

		const latest = findLatestSanLoopRun(session.getEntries());
		expect(latest?.entryId).toBe(session.getEntries()[2]?.id);
		expect(latest?.data.status).toBe("reviewing");
		expect(latest?.data.contextPacketRefs).toEqual(["packet-1"]);
		expect(latest?.data.budget).toHaveLength(1);

		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.runs).toHaveLength(1);
		expect(ledger.events.map(event => event.data.eventId)).toEqual(["evt_1", "evt_2"]);
	});

	test("records orchestrator transitions as run snapshots plus events", () => {
		const session = SessionManager.inMemory();
		const initial = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Persist transition",
			runId: "loop_transition",
			createdAt: "2026-07-01T00:00:00.000Z",
		});

		const result = recordSanLoopTransition(session, {
			run: updateSanLoopRunSnapshot(initial, {
				status: "dispatching",
				updatedAt: "2026-07-01T00:01:00.000Z",
			}),
			eventType: "plan_created",
			eventSummary: "Commander created a plan.",
			retryExhausted: false,
		});

		expect(result.runEntryId).toBe(session.getEntries()[0]?.id);
		expect(result.eventEntryId).toBe(session.getEntries()[1]?.id);
		expect(result.event.refs).toEqual([result.runEntryId]);
		expect(result.event.data).toMatchObject({ retryExhausted: false });
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data.status).toBe("dispatching");
		expect(ledger.events[0]?.data.type).toBe("plan_created");
	});

	test("aborts an active run with an audit event", () => {
		const session = SessionManager.inMemory();
		const initial = createSanLoopRunSnapshot({
			sessionId: "session-1",
			objective: "Abort active execution loop",
			runId: "loop_abort",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		appendSanLoopRunSnapshot(session, initial);

		const result = abortSanLoopRun(session, initial, {
			reason: "Operator requested stop",
			createdAt: "2026-07-01T00:02:00.000Z",
		});

		expect(result.run.status).toBe("aborted");
		expect(result.run.updatedAt).toBe("2026-07-01T00:02:00.000Z");
		expect(result.event).toMatchObject({
			type: "aborted",
			summary: "Operator requested stop",
			refs: [result.runEntryId],
			data: { previousStatus: "planning" },
		});
		const ledger = rebuildSanLoopLedger(session.getEntries());
		expect(ledger.latestRun?.data.status).toBe("aborted");
		expect(ledger.events.at(-1)?.data.type).toBe("aborted");
	});

	test("ignores malformed San loop custom entries", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(SAN_LOOP_RUN_CUSTOM_TYPE, { runId: "missing-fields" });
		session.appendCustomEntry("other", { runId: "loop_other" });

		const ledger = rebuildSanLoopLedger(session.getEntries());

		expect(ledger.runs).toHaveLength(0);
		expect(ledger.events).toHaveLength(0);
		expect(ledger.latestRun).toBeUndefined();
	});
});
