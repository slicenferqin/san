import { describe, expect, test } from "bun:test";
import {
	BackpressureWriter,
	isClientDisconnectError,
	type RpcWritable,
} from "@san/coding-agent/modes/rpc-v2/backpressure-writer";

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

/** 底层 stream 可模拟断管：write 抛 EPIPE，或正常写入后回压等待 drain。 */
class BrokenPipeWritable implements RpcWritable {
	readonly lines: string[] = [];
	writeCount = 0;
	broken = false;
	write(chunk: string): boolean {
		this.writeCount++;
		if (this.broken) throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		this.lines.push(chunk);
		return false;
	}
	once(_event: "drain", _listener: () => void): void {}
}

class TwoStageWritable implements RpcWritable {
	readonly lines: string[] = [];
	#drain: (() => void) | undefined;
	#waiter: { count: number; resolve: () => void } | undefined;

	write(chunk: string): boolean {
		this.lines.push(chunk);
		if (this.#waiter && this.lines.length >= this.#waiter.count) {
			this.#waiter.resolve();
			this.#waiter = undefined;
		}
		return this.lines.length > 2;
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

	waitForLineCount(count: number): Promise<void> {
		if (this.lines.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiter = { count, resolve };
		return promise;
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
		expect(writer.pendingCount).toBe(1);
		expect(writer.queuedTransientCount).toBe(1);

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
		expect(writer.pendingCount).toBe(0);
		expect(writer.queuedTransientCount).toBe(0);
	});

	test("rejects a frame larger than one MiB", async () => {
		const stream: RpcWritable = { write: () => true, once: () => undefined };
		const writer = new BackpressureWriter({ stream });
		await expect(writer.write({ text: "x".repeat(1_048_576) })).rejects.toThrow("RPC frame exceeds 1048576 bytes");
	});

	test("releases pending capacity when serialization fails", async () => {
		const stream: RpcWritable = { write: () => true, once: () => undefined };
		const writer = new BackpressureWriter({ stream, maxQueueSize: 1 });
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		await expect(writer.write(circular)).rejects.toThrow();
		expect(writer.pendingCount).toBe(0);
		await expect(writer.write({ id: "after-failure" })).rejects.toThrow();
		expect(writer.pendingCount).toBe(0);
	});

	test("flushes transient frames that arrive while a coalesced frame is draining", async () => {
		const stream = new TwoStageWritable();
		const writer = new BackpressureWriter({ stream, maxQueueSize: 1 });
		const durable = writer.write({ id: "durable" });
		await stream.waitForLineCount(1);
		const firstProgress = writer.write({ id: "progress-1" }, { durability: "transient", coalesceKey: "run:1" });

		stream.release();
		await stream.waitForLineCount(2);
		const lateProgress = writer.write({ id: "progress-2" }, { durability: "transient", coalesceKey: "run:2" });
		stream.release();

		await Promise.all([durable, firstProgress, lateProgress]);
		await writer.close();
		expect(stream.lines.map(line => JSON.parse(line))).toEqual([
			{ id: "durable" },
			{ id: "progress-1" },
			{ id: "progress-2" },
		]);
	});

	test("bounds distinct transient stream keys and evicts the oldest pending stream", async () => {
		const stream = new ControlledWritable();
		const writer = new BackpressureWriter({ stream, maxQueueSize: 1, maxCoalescedKeys: 2 });
		const durable = writer.write({ id: "durable" });
		await Promise.resolve();
		const writes = [
			writer.write({ id: "progress-1" }, { durability: "transient", coalesceKey: "run:1" }),
			writer.write({ id: "progress-2" }, { durability: "transient", coalesceKey: "run:2" }),
			writer.write({ id: "progress-3" }, { durability: "transient", coalesceKey: "run:3" }),
		];
		expect(writer.queuedTransientCount).toBe(2);
		expect(writer.droppedCoalescedCount).toBe(1);

		stream.release();
		await Promise.all([durable, ...writes]);
		await writer.close();
		expect(stream.lines.map(line => JSON.parse(line))).toEqual([
			{ id: "durable" },
			{ jsonrpc: "2.0", method: "stream.coalesced", params: { replaced: 0, dropped: 1, emitted: 2 } },
			{ id: "progress-2" },
			{ id: "progress-3" },
		]);
		expect(writer.droppedCoalescedCount).toBe(1);
	});

	test("treats a synchronous EPIPE as client disconnect and heals the write chain", async () => {
		const stream = new BrokenPipeWritable();
		stream.broken = true;
		const writer = new BackpressureWriter({ stream });

		// 断管写失败被内部治愈：调用方拿到的 promise 收敛，而不是 rejected 扩散成 unhandled rejection。
		await expect(writer.write({ id: "frame-1" })).resolves.toBeUndefined();
		expect(writer.state).toBe("disconnected");
		expect(writer.disconnectError).toBeInstanceOf(Error);
		expect((writer.disconnectError as NodeJS.ErrnoException).code).toBe("EPIPE");

		// 后续写入是 no-op，不再触碰底层 stream。
		const writeCountAfter = stream.writeCount;
		await expect(writer.write({ id: "frame-2" })).resolves.toBeUndefined();
		expect(stream.writeCount).toBe(writeCountAfter);

		// close 幂等且不再抛 EPIPE。
		await writer.close();
		await writer.close();
		expect(writer.pendingCount).toBe(0);
	});

	test("disconnect() from an async stdout error releases a blocked write and drops queued transient frames", async () => {
		const stream = new BrokenPipeWritable();
		const writer = new BackpressureWriter({ stream, maxQueueSize: 1 });
		const durable = writer.write({ id: "durable" });
		await Promise.resolve();
		const transient = writer.write({ id: "progress" }, { durability: "transient", coalesceKey: "run:1" });
		expect(writer.pendingCount).toBe(1);
		expect(writer.queuedTransientCount).toBe(1);

		const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		writer.disconnect(epipe);

		expect(writer.state).toBe("disconnected");
		expect(writer.disconnectError).toBe(epipe);
		// drain 等待者被释放：不死等 drain，也不 flush transient 队列。
		await Promise.all([durable, transient]);
		expect(writer.pendingCount).toBe(0);
		expect(writer.queuedTransientCount).toBe(0);
		// 只有 durable 曾触达底层 stream。
		expect(stream.lines.map(line => JSON.parse(line))).toEqual([{ id: "durable" }]);

		await writer.close();
		await writer.close();
		expect(writer.state).toBe("disconnected");
	});

	test("non-disconnect write failures stay observable and poison the writer", async () => {
		const stream: RpcWritable = {
			write: () => {
				throw new Error("unexpected serialization failure");
			},
			once: () => undefined,
		};
		const writer = new BackpressureWriter({ stream });

		await expect(writer.write({ id: "x" })).rejects.toThrow("unexpected serialization failure");
		expect(writer.state).toBe("failed");
		// 后续写入以相同错误拒绝，而不是被吞掉。
		await expect(writer.write({ id: "y" })).rejects.toThrow("unexpected serialization failure");
		expect(writer.pendingCount).toBe(0);
		// close 同样保留失败语义。
		await expect(writer.close()).rejects.toThrow("unexpected serialization failure");
	});

	test("classifies transport-close errors by code with string fallback", () => {
		const cases: Array<[unknown, boolean]> = [
			[Object.assign(new Error("broken pipe"), { code: "EPIPE" }), true],
			[Object.assign(new Error("conn reset"), { code: "ECONNRESET" }), true],
			[Object.assign(new Error("x"), { code: "ERR_STREAM_DESTROYED" }), true],
			[Object.assign(new Error("x"), { code: "ERR_STREAM_WRITE_AFTER_END" }), true],
			[new Error("some broken pipe elsewhere"), true],
			[new Error("stream destroyed during read"), true],
			[new Error("write after end"), true],
			[new Error("unexpected serialization failure"), false],
			["EPIPE string, not an Error", false],
		];
		for (const [error, expected] of cases) {
			expect(isClientDisconnectError(error)).toBe(expected);
		}
	});
});
