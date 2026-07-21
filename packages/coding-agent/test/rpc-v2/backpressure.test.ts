import { describe, expect, test } from "bun:test";
import { BackpressureWriter, type RpcWritable } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/backpressure-writer";

class ControlledWritable implements RpcWritable {
	readonly lines: string[] = [];
	#blockNext = true;
	#drain: (() => void) | undefined;

	write(chunk: string): boolean {
		this.lines.push(chunk);
		if (!this.#blockNext) return true;
		this.#blockNext = false;
		return false;
	}

	once(_event: "drain", listener: () => void): void {
		this.#drain = listener;
	}

	release(): void {
		const drain = this.#drain;
		this.#drain = undefined;
		if (!drain) throw new Error("Writer did not wait for drain");
		drain();
	}
}

describe("RPC v2 backpressure writer", () => {
	test("waits for drain, preserves durable order, and reports replaced transient frames", async () => {
		const stream = new ControlledWritable();
		const writer = new BackpressureWriter({ stream, maxQueueSize: 1 });
		const durable = writer.write({ id: "durable" });
		await Promise.resolve();
		const firstProgress = writer.write({ id: "progress-1" }, { durability: "transient", coalesceKey: "run:1" });
		const latestProgress = writer.write({ id: "progress-2" }, { durability: "transient", coalesceKey: "run:1" });

		stream.release();
		await Promise.all([durable, firstProgress, latestProgress]);
		await writer.close();

		const frames = stream.lines.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(frames).toEqual([
			{ id: "durable" },
			{ jsonrpc: "2.0", method: "stream.coalesced", params: { replaced: 1, emitted: 1 } },
			{ id: "progress-2" },
		]);
		expect(writer.coalescedCount).toBe(2);
	});

	test("rejects a frame larger than one MiB", async () => {
		const stream: RpcWritable = { write: () => true, once: () => undefined };
		const writer = new BackpressureWriter({ stream });
		await expect(writer.write({ text: "x".repeat(1_048_576) })).rejects.toThrow("RPC frame exceeds 1048576 bytes");
	});
});
