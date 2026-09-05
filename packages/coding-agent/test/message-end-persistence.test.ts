import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@san/agent";

import { MessageEndPersistenceQueue } from "../src/session/message-end-persistence";

function userMessage(timestamp: number): AgentMessage {
	return {
		role: "user",
		content: `message-${timestamp}`,
		timestamp,
		attribution: "user",
	} as AgentMessage;
}

describe("MessageEndPersistenceQueue", () => {
	test("persists message-end callbacks in creation order", async () => {
		const queue = new MessageEndPersistenceQueue();
		const first = queue.create(userMessage(1));
		const second = queue.create(userMessage(2));
		if (!first || !second) throw new Error("expected persistent message slots");

		const order: string[] = [];
		await Promise.all([first.persist(() => order.push("first")), second.persist(() => order.push("second"))]);

		expect(order).toEqual(["first", "second"]);
		await queue.waitForAll();
	});

	test("release unblocks the next message-end callback", async () => {
		const queue = new MessageEndPersistenceQueue();
		const first = queue.create(userMessage(1));
		const second = queue.create(userMessage(2));
		if (!first || !second) throw new Error("expected persistent message slots");

		let persisted = false;
		const secondPersistence = second.persist(() => {
			persisted = true;
		});
		first.release();
		await secondPersistence;

		expect(persisted).toBe(true);
	});

	test("ignores message roles without a persistence key", async () => {
		const queue = new MessageEndPersistenceQueue();
		const nonPersistentMessage = { role: "custom" } as AgentMessage;

		expect(queue.create(nonPersistentMessage)).toBeUndefined();
		await queue.waitFor(nonPersistentMessage);
		await queue.waitForAll();
	});
});
