/** RPC v2 有界、按序且感知 backpressure 的 NDJSON writer。 */

export interface RpcWritable {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): unknown;
}
export interface WriteFrameOptions {
	durability?: "durable" | "transient";
	coalesceKey?: string;
}

interface CoalescedFrame {
	frame: object;
	key: string;
}

export class BackpressureWriter {
	readonly #stream: RpcWritable;
	readonly #maxQueueSize: number;
	#tail: Promise<void> = Promise.resolve();
	readonly #maxCoalescedKeys: number;
	#pending = 0;
	#closed = false;
	#draining = false;
	#coalesced = new Map<string, CoalescedFrame>();
	#coalescedCount = 0;
	#pendingCoalescedCount = 0;
	#droppedCoalescedCount = 0;
	#pendingDroppedCoalescedCount = 0;

	constructor(options?: { stream?: RpcWritable; maxQueueSize?: number; maxCoalescedKeys?: number }) {
		this.#stream = options?.stream ?? process.stdout;
		this.#maxQueueSize = options?.maxQueueSize ?? 4096;
		this.#maxCoalescedKeys = options?.maxCoalescedKeys ?? this.#maxQueueSize;
		if (!Number.isSafeInteger(this.#maxQueueSize) || this.#maxQueueSize < 1) {
			throw new Error("RPC output maxQueueSize must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#maxCoalescedKeys) || this.#maxCoalescedKeys < 1) {
			throw new Error("RPC output maxCoalescedKeys must be a positive integer");
		}
	}

	/**
	 * Durable 帧始终进入有序写队列；transient 帧在队列受压时按 key 保留最新值。
	 * 调用方 await 返回值即可把压力反传到事件生产链。
	 */
	write(frame: object, options: WriteFrameOptions = {}): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("RPC output writer is closed"));
		const durability = options.durability ?? "durable";
		if (durability === "transient" && (this.#draining || this.#pending >= this.#maxQueueSize)) {
			const key = options.coalesceKey ?? inferCoalesceKey(frame);
			const existing = this.#coalesced.delete(key);
			if (!existing && this.#coalesced.size >= this.#maxCoalescedKeys) {
				const oldestKey = this.#coalesced.keys().next().value;
				if (oldestKey !== undefined) {
					this.#coalesced.delete(oldestKey);
					this.#droppedCoalescedCount++;
					this.#pendingDroppedCoalescedCount++;
				}
			}
			this.#coalesced.set(key, { key, frame });
			this.#coalescedCount++;
			this.#pendingCoalescedCount++;
			return this.#tail;
		}

		this.#pending++;
		const write = this.#tail.then(() => this.#writeLine(frame));
		const settled = write.finally(() => {
			this.#pending--;
		});
		this.#tail = settled.then(() => this.#flushCoalesced());
		return this.#tail;
	}

	/** ready 帧在读取 stdin 前写入；仍遵守内核 write 返回值。 */
	writeReady(frame: object): Promise<void> {
		return this.write(frame, { durability: "durable" });
	}

	async flush(): Promise<void> {
		await this.#tail;
	}

	get coalescedCount(): number {
		return this.#coalescedCount;
	}

	get droppedCoalescedCount(): number {
		return this.#droppedCoalescedCount;
	}

	get pendingCount(): number {
		return this.#pending;
	}

	get queuedTransientCount(): number {
		return this.#coalesced.size;
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.flush();
	}

	async #writeLine(frame: object): Promise<void> {
		const line = `${JSON.stringify(frame)}\n`;
		if (Buffer.byteLength(line, "utf8") > 1_048_576) {
			throw new Error(`RPC frame exceeds 1048576 bytes: ${Buffer.byteLength(line, "utf8")}`);
		}
		if (this.#stream.write(line)) return;
		this.#draining = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#stream.once("drain", () => {
			this.#draining = false;
			resolve();
		});
		await promise;
	}

	async #flushCoalesced(): Promise<void> {
		while (!this.#draining && this.#coalesced.size > 0) {
			const frames = [...this.#coalesced.values()];
			const dropped = this.#pendingDroppedCoalescedCount;
			const replaced = Math.max(0, this.#pendingCoalescedCount - frames.length - dropped);
			this.#coalesced.clear();
			this.#pendingCoalescedCount = 0;
			this.#pendingDroppedCoalescedCount = 0;
			if (replaced > 0 || dropped > 0) {
				await this.#writeLine({
					jsonrpc: "2.0",
					method: "stream.coalesced",
					params: { replaced, ...(dropped > 0 ? { dropped } : {}), emitted: frames.length },
				});
			}
			for (const item of frames) await this.#writeLine(item.frame);
		}
	}
}

function inferCoalesceKey(frame: object): string {
	const record = frame as Record<string, unknown>;
	const params =
		typeof record.params === "object" && record.params !== null
			? (record.params as Record<string, unknown>)
			: undefined;
	return [record.method, params?.sessionId, params?.type, params?.runId, params?.turnId].map(String).join(":");
}

/**
 * 捕获 writer 之外的 stdout 写入，保证协议通道只含 JSON。返回恢复函数。
 * 被拦截内容不复制到 stderr，避免正文或凭据通过诊断旁路泄漏。
 */
export function installStdoutPurityGuard(): { restore: () => void; violations: () => number } {
	const original = process.stdout.write;
	let violationCount = 0;
	const guarded = ((chunk: string | Uint8Array) => {
		violationCount++;
		const byteLength = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		process.stderr.write(`[san rpc-v2] blocked non-protocol stdout write (${byteLength} bytes)\n`);
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = guarded;
	return {
		restore: () => {
			process.stdout.write = original;
		},
		violations: () => violationCount,
	};
}
