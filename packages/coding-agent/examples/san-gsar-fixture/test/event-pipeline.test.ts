import { describe, expect, test } from "bun:test";
import { createEventPipeline } from "../src/event-pipeline";

describe("EventPipeline", () => {
	test("processes registered events", async () => {
		const pipeline = createEventPipeline();
		const received: string[] = [];
		pipeline.register("order.created", e => {
			received.push(e.id);
		});

		const receipt = await pipeline.process([
			{ id: "1", type: "order.created", partitionKey: "a", payload: {}, timestamp: 1 },
		]);

		expect(receipt.accepted).toBe(1);
		expect(received).toContain("1");
	});

	test("handles handler errors", async () => {
		const pipeline = createEventPipeline();
		pipeline.register("fail", () => {
			throw new Error("boom");
		});

		const receipt = await pipeline.process([{ id: "2", type: "fail", partitionKey: "b", payload: {}, timestamp: 2 }]);

		expect(receipt.accepted).toBe(0);
	});

	test("returns receipt", async () => {
		const pipeline = createEventPipeline();
		const receipt = await pipeline.process([]);
		expect(receipt).toBeDefined();
		expect(receipt.accepted).toBe(0);
	});
});
