import { describe, expect, it } from "bun:test";
import { TinyModelClient } from "@san/coding-agent/tiny/client";
import type { TinyModelWorkerInbound, TinyModelWorkerOutbound } from "@san/coding-agent/tiny/protocol";

class FakeTinyWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: TinyModelWorkerOutbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: TinyModelWorkerInbound, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyModelWorkerInbound, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyModelWorkerInbound): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyModelWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: TinyModelWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

describe("issue #1940 — local model failures release the worker process", () => {
	it("releases the failed worker and suppresses repeated attempts for that model", async () => {
		const first = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "error", id: message.id, error: "Error: Unknown failure" });
			}
		});
		let spawnCount = 0;
		const client = new TinyModelClient(() => {
			spawnCount += 1;
			return first;
		});

		try {
			expect(await client.complete("qwen3-1.7b", "long prompt")).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.complete("qwen3-1.7b", "retry prompt")).toBeNull();
			expect(spawnCount).toBe(1);
		} finally {
			await client.terminate();
		}
	});

	it("faults queued local completions when the failed worker is recycled", async () => {
		let firstRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type !== "complete") return;
			firstRequestId ||= message.id;
		});
		const client = new TinyModelClient(() => worker);

		try {
			const first = client.complete("qwen3-1.7b", "first prompt");
			const second = client.complete("qwen3-1.7b", "second prompt");
			worker.emit({ type: "error", id: firstRequestId, error: "Error: Unknown failure" });

			expect(await first).toBeNull();
			expect(await second).toBeNull();
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("allows an unrelated model after the worker crashes", async () => {
		const first = new FakeTinyWorker(() => {});
		const second = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "completion", id: message.id, text: "recovered" });
			}
		});
		const workers = [first, second];
		let nextWorker = 0;
		const client = new TinyModelClient(() => {
			const worker = workers[nextWorker];
			if (!worker) throw new Error("unexpected worker spawn");
			nextWorker += 1;
			return worker;
		});

		try {
			const crashed = client.complete("qwen3-1.7b", "first prompt");
			first.emitError(new Error("tiny model subprocess exited with signal SIGKILL"));

			expect(await crashed).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.complete("qwen2.5-1.5b", "retry prompt")).toBe("recovered");
			expect(nextWorker).toBe(2);
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #3291 — tiny-model downloads keep the worker referenced", () => {
	it("references the worker while a memory-model download is pending", async () => {
		let downloadRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new TinyModelClient(() => worker);

		try {
			const download = client.downloadModel("lfm2-1.2b");

			expect(downloadRequestId).not.toBe("");
			expect(worker.refCalls).toBe(1);
			expect(worker.unrefCalls).toBe(0);

			worker.emit({ type: "downloaded", id: downloadRequestId });

			expect(await download).toEqual({ ok: true });
			expect(worker.unrefCalls).toBe(1);
		} finally {
			await client.terminate();
		}
	});

	it("returns the worker error for failed download requests", async () => {
		let downloadRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type === "download") downloadRequestId = message.id;
		});
		const client = new TinyModelClient(() => worker);

		try {
			const download = client.downloadModel("lfm2-1.2b");

			expect(downloadRequestId).not.toBe("");
			worker.emit({ type: "error", id: downloadRequestId, error: "Error: runtime install failed" });

			expect(await download).toEqual({ ok: false, error: "Error: runtime install failed" });
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});
});
