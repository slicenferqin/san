import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@san/utils";
import type { AgentSessionEvent } from "../../session/agent-session";
import {
	DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
	LEASE_EXPIRY_MS,
	leaseIsFresh,
	leasePathForSession,
	writeLeaseRecord,
} from "./crash-recovery";
import { EventSequencer } from "./event-sequencer";
import { type InteractiveEventSource, InteractiveSessionPublisher } from "./interactive-session-publisher";
import type { SessionId } from "./protocol/ids";
import { RpcV2StateStore } from "./state-store";

const tempDirectories: string[] = [];

interface SourceHarness {
	source: InteractiveEventSource;
	emit(event: AgentSessionEvent): void;
}

function createSource(sessionFile: string, sessionId: string): SourceHarness {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const identityListeners = new Set<(change: { previousSessionId: string; sessionId: string }) => void>();
	const source: InteractiveEventSource = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
			flush: async () => {},
			onSessionIdentityChanged: callback => {
				identityListeners.add(callback);
				return () => identityListeners.delete(callback);
			},
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

function assistantMessage(text = "done"): Record<string, unknown> {
	return { role: "assistant", content: [{ type: "text", text }] };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (await predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition did not become true");
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

describe("InteractiveSessionPublisher", () => {
	test("persists only durable events, continues the sequence, and releases its lease", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-interactive-publisher-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		const sessionId = "ses_interactive_publisher" as SessionId;
		await Bun.write(sessionFile, "session\n");

		const store = new RpcV2StateStore(sessionFile, sessionId);
		const seed = new EventSequencer(sessionId, 6).emit(
			"run.completed",
			{ runId: "run_seed" },
			{ durability: "durable" },
		);
		await store.appendEvent(seed);
		const state = (await store.load()).state;
		state.lastSequence = 7;
		await store.saveState(state);

		const harness = createSource(sessionFile, sessionId);
		const publisher = new InteractiveSessionPublisher(harness.source, {
			heartbeatIntervalMs: 100_000,
			flushIntervalMs: 100_000,
		});
		await publisher.start();
		const leasePath = leasePathForSession(sessionFile);
		expect(await Bun.file(leasePath).exists()).toBe(true);

		const message = assistantMessage();
		harness.emit({ type: "agent_start" } as AgentSessionEvent);
		harness.emit({ type: "turn_start" } as AgentSessionEvent);
		harness.emit({ type: "message_start", message } as unknown as AgentSessionEvent);
		harness.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", delta: "partial", contentIndex: 0, partial: message },
		} as unknown as AgentSessionEvent);
		harness.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
		harness.emit({ type: "tool_execution_start", toolCallId: "tool_1", toolName: "edit" } as AgentSessionEvent);
		harness.emit({ type: "tool_execution_update", toolCallId: "tool_1", toolName: "edit" } as AgentSessionEvent);
		harness.emit({
			type: "tool_execution_end",
			toolCallId: "tool_1",
			toolName: "edit",
			result: { content: [] },
			isError: false,
		} as AgentSessionEvent);
		harness.emit({ type: "turn_end" } as AgentSessionEvent);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await publisher.stop();

		const persisted = await new RpcV2StateStore(sessionFile, sessionId).load();
		expect(persisted.events.map(event => event.type)).toEqual([
			"run.completed",
			"run.started",
			"turn.started",
			"message.started",
			"message.completed",
			"tool.started",
			"tool.completed",
			"evidence.recorded",
			"turn.completed",
			"run.completed",
		]);
		expect(persisted.events.map(event => event.sequence)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		expect(persisted.events.some(event => event.type === "message.delta" || event.type === "tool.progress")).toBe(
			false,
		);
		expect(await Bun.file(leasePath).exists()).toBe(false);
	});

	test("persists an active run projection while the agent is streaming", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-interactive-active-run-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		const sessionId = "ses_interactive_active" as SessionId;
		await Bun.write(sessionFile, "session\n");

		const harness = createSource(sessionFile, sessionId);
		const publisher = new InteractiveSessionPublisher(harness.source, {
			heartbeatIntervalMs: 100_000,
			flushIntervalMs: 1,
		});
		await publisher.start();
		try {
			harness.emit({ type: "agent_start" } as AgentSessionEvent);
			harness.emit({ type: "turn_start" } as AgentSessionEvent);
			await waitFor(async () => {
				const state = (await new RpcV2StateStore(sessionFile, sessionId).load()).state;
				return state.activeRun?.status === "running" && typeof state.activeRun.currentTurnId === "string";
			});

			const state = (await new RpcV2StateStore(sessionFile, sessionId).load()).state;
			expect(state.activeRun).toMatchObject({ status: "running" });
			expect(state.activeRun?.userMessageId).toEqual(expect.any(String));
			expect(state.activeRun?.currentTurnId).toEqual(expect.any(String));
			expect(state.lastRun).toBeUndefined();
		} finally {
			await publisher.stop();
		}
	});

	test("continues after an expired lease and preserves the heartbeat contract", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-interactive-recovery-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		const sessionId = "ses_interactive_recovery" as SessionId;
		await Bun.write(sessionFile, "session\n");
		const staleAt = new Date(Date.now() - LEASE_EXPIRY_MS - 1_000).toISOString();
		const store = new RpcV2StateStore(sessionFile, sessionId);
		const seed = new EventSequencer(sessionId, 8).emit(
			"run.started",
			{ runId: "run_crashed", turnId: "turn_crashed" },
			{ durability: "durable" },
		);
		await store.appendEvent(seed);
		const state = (await store.load()).state;
		state.lastSequence = 9;
		state.activeRun = {
			runId: "run_crashed",
			userMessageId: "message_crashed",
			status: "running",
			startedAt: staleAt,
		};
		await store.saveState(state);
		let recoveryCallbackCalls = 0;
		await writeLeaseRecord(
			{
				leaseId: "lease_previous",
				runtimeId: "runtime_previous",
				pid: process.pid,
				sessionId,
				acquiredAt: staleAt,
				lastHeartbeat: staleAt,
				lastStableSequence: 9,
				heartbeatIntervalMs: 40,
			},
			sessionFile,
		);

		const harness = createSource(sessionFile, sessionId);
		const publisher = new InteractiveSessionPublisher(harness.source, {
			heartbeatIntervalMs: 40,
			flushIntervalMs: 100_000,
			recoverAfterLeaseTakeover: () => {
				recoveryCallbackCalls += 1;
			},
		});
		await publisher.start();

		const persisted = await new RpcV2StateStore(sessionFile, sessionId).load();
		expect(persisted.events.map(event => event.type)).toEqual(["run.started", "session.recovered"]);
		expect(persisted.events.map(event => event.sequence)).toEqual([9, 10]);
		expect(persisted.state.activeRun).toBeUndefined();
		expect(persisted.state.lastRun).toMatchObject({
			runId: "run_crashed",
			status: "interrupted",
			reason: "runtime_crash",
		});
		expect(recoveryCallbackCalls).toBe(1);
		const activeLease = (await Bun.file(leasePathForSession(sessionFile)).json()) as Record<string, unknown>;
		expect(activeLease.runtimeId).toBe(publisher.runtimeId);
		expect(activeLease.heartbeatIntervalMs).toBe(40);
		expect(leaseIsFresh(activeLease as never)).toBe(true);
		await publisher.stop();
	});

	test("marks the lease degraded when the event projection cannot flush", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-interactive-degraded-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		const sessionId = "ses_interactive_degraded" as SessionId;
		await Bun.write(sessionFile, "session\n");
		const harness = createSource(sessionFile, sessionId);
		const publisher = new InteractiveSessionPublisher(harness.source, {
			heartbeatIntervalMs: 100_000,
			flushIntervalMs: 100_000,
		});
		await publisher.start();
		const appendSpy = spyOn(RpcV2StateStore.prototype, "appendEvents").mockRejectedValue(new Error("disk full"));
		try {
			harness.emit({ type: "agent_start" } as AgentSessionEvent);
			harness.emit({ type: "turn_end" } as AgentSessionEvent);
			await waitFor(async () => {
				const lease = (await Bun.file(leasePathForSession(sessionFile)).json()) as Record<string, unknown>;
				return lease.eventStreamDegraded === true;
			});
			expect(publisher.eventStreamDegraded).toBe(true);
		} finally {
			appendSpy.mockRestore();
			await publisher.stop();
		}
	});

	test("uses heartbeat freshness rather than pid liveness for new leases", () => {
		const now = Date.parse("2026-08-26T00:00:00.000Z");
		const record = {
			leaseId: "lease",
			runtimeId: "runtime",
			pid: process.pid,
			sessionId: "session",
			acquiredAt: new Date(now).toISOString(),
			lastHeartbeat: new Date(now).toISOString(),
			lastStableSequence: 0,
			heartbeatIntervalMs: DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
		};
		expect(leaseIsFresh(record, now + LEASE_EXPIRY_MS - 1)).toBe(true);
		expect(leaseIsFresh(record, now + LEASE_EXPIRY_MS + 1)).toBe(false);
	});
});
