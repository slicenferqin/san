/**
 * San RPC v2 idempotency receipt store.
 *
 * Tracks mutation idempotency keys to ensure at-most-once execution.
 * Same key + same params → returns cached result.
 * Same key + different params → IDEMPOTENCY_CONFLICT error.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";

interface Receipt {
	key: string;
	paramsHash: string;
	result: unknown;
	createdAt: number;
}

export interface IdempotencyReceipt {
	key: string;
	paramsHash: string;
	result: unknown;
	createdAt: number;
}

export class IdempotencyStore {
	#receipts = new Map<string, Receipt>();
	#maxSize: number;

	constructor(options?: { maxSize?: number }) {
		this.#maxSize = options?.maxSize ?? 10_000;
	}

	/**
	 * Check if a mutation with this key was already executed.
	 * Returns the cached result if same params, throws conflict if different params.
	 * Returns undefined if this is a new key.
	 */
	check(key: string, params: unknown): { cached: true; result: unknown } | { cached: false } {
		if (key.trim().length === 0) {
			throw new Error("Idempotency key must be a non-empty string");
		}
		const existing = this.#receipts.get(key);
		if (!existing) return { cached: false };

		const incomingHash = hashParams(params);
		if (existing.paramsHash === incomingHash) {
			return { cached: true, result: existing.result };
		}

		// Same key, different params — conflict
		throw new IdempotencyConflictError(key);
	}

	/** Return a serializable copy for a session sidecar. */
	entries(): IdempotencyReceipt[] {
		return [...this.#receipts.values()].map(receipt => ({ ...receipt }));
	}

	/** Restore receipts loaded from a trusted sidecar. */
	load(entries: readonly IdempotencyReceipt[]): void {
		this.#receipts.clear();
		for (const entry of entries.slice(-this.#maxSize)) {
			if (typeof entry.key !== "string" || typeof entry.paramsHash !== "string") continue;
			this.#receipts.set(entry.key, { ...entry });
		}
	}

	/** Record a completed mutation. */
	record(key: string, params: unknown, result: unknown): void {
		if (this.#receipts.size >= this.#maxSize) {
			// Evict oldest entries
			const entries = Array.from(this.#receipts.entries());
			const toRemove = entries.slice(0, Math.floor(this.#maxSize * 0.1));
			for (const [k] of toRemove) this.#receipts.delete(k);
		}

		this.#receipts.set(key, {
			key,
			paramsHash: hashParams(params),
			result,
			createdAt: Date.now(),
		});
	}

	get size(): number {
		return this.#receipts.size;
	}

	clear(): void {
		this.#receipts.clear();
	}
}

export class IdempotencyConflictError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`Idempotency conflict: key "${key}" was already used with different parameters`);
		this.name = "IdempotencyConflictError";
		this.key = key;
	}
}

interface SessionCreateReservationFile {
	schemaVersion: 1;
	state: "pending" | "complete";
	paramsHash: string;
	pid: number;
	createdAt: string;
	sessionId?: string;
}

export interface SessionCreateReservation {
	path: string;
	paramsHash: string;
	pid: number;
}

export type SessionCreateReservationResult =
	| { cached: true; sessionId: string }
	| { cached: false; reservation: SessionCreateReservation };

/** 跨进程 Session create reservation；pending 崩溃项不会被自动重放副作用。 */
export class SessionCreateReceiptStore {
	readonly #directory: string;

	constructor(directory = path.join(getAgentDir(), "rpc-v2", "session-create-receipts")) {
		this.#directory = directory;
	}

	async begin(key: string, params: unknown): Promise<SessionCreateReservationResult> {
		if (!key.trim()) throw new Error("Idempotency key must be a non-empty string");
		const paramsHash = hashParams(params);
		const receiptPath = path.join(this.#directory, `${hashKey(key)}.json`);
		await fs.mkdir(this.#directory, { recursive: true });
		const pending: SessionCreateReservationFile = {
			schemaVersion: 1,
			state: "pending",
			paramsHash,
			pid: process.pid,
			createdAt: new Date().toISOString(),
		};
		try {
			const handle = await fs.open(receiptPath, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(pending)}\n`, "utf8");
			} finally {
				await handle.close();
			}
			return { cached: false, reservation: { path: receiptPath, paramsHash, pid: process.pid } };
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const existing = await this.#read(receiptPath);
		if (existing.paramsHash !== paramsHash) throw new IdempotencyConflictError(key);
		if (existing.state === "complete" && existing.sessionId) return { cached: true, sessionId: existing.sessionId };
		if (processAlive(existing.pid)) throw new IdempotencyInProgressError(key);
		throw new IdempotencyOutcomeUnknownError(key);
	}

	async complete(reservation: SessionCreateReservation, sessionId: string): Promise<void> {
		const current = await this.#read(reservation.path);
		if (
			current.paramsHash !== reservation.paramsHash ||
			current.pid !== reservation.pid ||
			current.state !== "pending"
		) {
			throw new Error(`Session create reservation changed before completion: ${reservation.path}`);
		}
		const complete: SessionCreateReservationFile = { ...current, state: "complete", sessionId };
		const temporaryPath = `${reservation.path}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(temporaryPath, `${JSON.stringify(complete)}\n`);
		await fs.rename(temporaryPath, reservation.path);
	}

	async cancel(reservation: SessionCreateReservation): Promise<void> {
		try {
			const current = await this.#read(reservation.path);
			if (
				current.paramsHash === reservation.paramsHash &&
				current.pid === reservation.pid &&
				current.state === "pending"
			) {
				await fs.rm(reservation.path, { force: true });
			}
		} catch (error: unknown) {
			if (!isEnoent(error)) throw error;
		}
	}

	async #read(receiptPath: string): Promise<SessionCreateReservationFile> {
		const value = (await Bun.file(receiptPath).json()) as Partial<SessionCreateReservationFile>;
		if (
			value.schemaVersion !== 1 ||
			(value.state !== "pending" && value.state !== "complete") ||
			typeof value.paramsHash !== "string" ||
			typeof value.pid !== "number" ||
			typeof value.createdAt !== "string" ||
			(value.state === "complete" && typeof value.sessionId !== "string")
		) {
			throw new Error(`Invalid Session create idempotency receipt: ${receiptPath}`);
		}
		return value as SessionCreateReservationFile;
	}
}

export class IdempotencyInProgressError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`Idempotent operation is still in progress: ${key}`);
		this.name = "IdempotencyInProgressError";
		this.key = key;
	}
}

export class IdempotencyOutcomeUnknownError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(`Previous idempotent operation ended before its outcome was recorded: ${key}`);
		this.name = "IdempotencyOutcomeUnknownError";
		this.key = key;
	}
}

function hashParams(params: unknown): string {
	return new Bun.CryptoHasher("sha256").update(stableSerialize(params)).digest("hex");
}

function hashKey(key: string): string {
	return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

function processAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stableSerialize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return `bigint:${value.toString()}`;
	if (typeof value === "undefined") return "undefined";
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
			.join(",")}}`;
	}
	return `${typeof value}:${String(value)}`;
}
