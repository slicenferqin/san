import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "@san/coding-agent/modes/rpc-v2/dto/events";
import { IdempotencyStore } from "@san/coding-agent/modes/rpc-v2/idempotency";
import { newEventId, type SessionId } from "@san/coding-agent/modes/rpc-v2/protocol/ids";
import { RpcV2StateStore } from "@san/coding-agent/modes/rpc-v2/state-store";
import { removeWithRetries } from "@san/utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

describe("RPC v2 state-store recovery", () => {
	test("reconciles a receipt's pending event exactly once after append failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-state-recovery-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		await Bun.write(sessionFile, "");
		const sessionId = "ses_pending_event" as SessionId;
		const store = new RpcV2StateStore(sessionFile, sessionId);
		const loaded = await store.load();
		const event: SessionEvent = {
			schemaVersion: 1,
			eventId: newEventId(),
			sessionId,
			sequence: 1,
			timestamp: "2026-07-24T00:00:00.000Z",
			type: "run.accepted",
			durability: "durable",
			data: { runId: "run_recovered" },
		};
		const receipts = new IdempotencyStore();
		receipts.record("run-start-1", { method: "run.start" }, { runId: "run_recovered" });
		loaded.state.revision = 1;
		loaded.state.lastSequence = event.sequence;
		loaded.state.receipts = receipts.entries();
		loaded.state.pendingEvent = event;
		await store.saveState(loaded.state);

		const recoveryStore = new RpcV2StateStore(sessionFile, sessionId);
		const recovered = await recoveryStore.load();
		expect(recovered.state.receipts).toEqual(receipts.entries());
		expect(recovered.state.pendingEvent).toEqual(event);
		expect(recovered.events).toEqual([event]);
		expect(await Bun.file(recoveryStore.eventsPath).exists()).toBe(false);

		await Bun.write(recoveryStore.eventsPath, '{"schemaVersion":1,"eventId":"partial","data":{}');
		const partialTailLoad = await new RpcV2StateStore(sessionFile, sessionId).load();
		expect(partialTailLoad.events).toEqual([event]);
		expect(await Bun.file(recoveryStore.eventsPath).text()).toEndWith('"data":{}');

		await recoveryStore.reconcilePendingEvent(partialTailLoad.state);
		expect(partialTailLoad.state.pendingEvent).toBeUndefined();

		const reloaded = await new RpcV2StateStore(sessionFile, sessionId).load();
		expect(reloaded.state.pendingEvent).toBeUndefined();
		expect(reloaded.events).toEqual([event]);
		expect((await Bun.file(store.eventsPath).text()).trim().split("\n")).toHaveLength(1);

		await Bun.write(store.eventsPath, JSON.stringify(event));
		await store.reconcilePendingEvent(reloaded.state);
		expect(await Bun.file(store.eventsPath).text()).toBe(`${JSON.stringify(event)}\n`);
	});

	test("serializes concurrent state writes without temp-file collisions", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-state-concurrent-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		await Bun.write(sessionFile, "");
		const sessionId = "ses_concurrent_state" as SessionId;
		const store = new RpcV2StateStore(sessionFile, sessionId);
		const state = (await store.load()).state;
		const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const writes = await Promise.all([1, 2, 3, 4].map(revision => store.saveState({ ...state, revision })));
			expect(writes).toHaveLength(4);
		} finally {
			nowSpy.mockRestore();
		}
		const persisted = await store.load();
		expect(persisted.state.revision).toBe(4);
	});
});
