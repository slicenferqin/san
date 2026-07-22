/** Session-scoped RPC v2 state, event watermark and idempotency sidecar。 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionEvent } from "./dto/events";
import type { EvidenceRecord } from "./dto/evidence";
import type { SessionSnapshot } from "./dto/session";
import type { IdempotencyReceipt } from "./idempotency";

export interface PersistedRpcState {
	schemaVersion: 1;
	revision: number;
	lastSequence: number;
	snapshot?: Partial<SessionSnapshot>;
	activeRun?: Record<string, unknown>;
	lastRun?: Record<string, unknown>;
	maintenance?: Record<string, unknown>;
	queue: Array<Record<string, unknown>>;
	pendingApprovals: Array<Record<string, unknown>>;
	pendingInteractions: Array<Record<string, unknown>>;
	settings: Record<string, unknown>;
	receipts: IdempotencyReceipt[];
	resources: Array<Record<string, unknown>>;
	activeResourceIds: string[];
	pendingResourceReleases: string[];
	evidence: EvidenceRecord[];
	artifacts: Array<Record<string, unknown>>;
	updatedAt: string;
}

export interface RpcV2StatePaths {
	state: string;
	events: string;
}

export function rpcV2StatePaths(sessionFile: string): RpcV2StatePaths {
	const base = `${sessionFile}.rpc-v2`;
	return { state: `${base}.state.json`, events: `${base}.events.ndjson` };
}

const EMPTY_STATE: PersistedRpcState = {
	schemaVersion: 1,
	revision: 0,
	lastSequence: 0,
	queue: [],
	pendingApprovals: [],
	pendingInteractions: [],
	settings: {},
	receipts: [],
	resources: [],
	activeResourceIds: [],
	pendingResourceReleases: [],
	evidence: [],
	artifacts: [],
	updatedAt: new Date(0).toISOString(),
};

export class RpcV2StateStore {
	readonly #statePath: string;
	readonly #eventsPath: string;

	constructor(sessionFile: string | undefined, sessionId: string) {
		const base = sessionFile ? `${sessionFile}.rpc-v2` : path.join(os.tmpdir(), "san-rpc-v2", sessionId);
		this.#statePath = `${base}.state.json`;
		this.#eventsPath = `${base}.events.ndjson`;
	}

	get statePath(): string {
		return this.#statePath;
	}

	get eventsPath(): string {
		return this.#eventsPath;
	}

	async load(): Promise<{ state: PersistedRpcState; events: SessionEvent[] }> {
		const state = await this.#loadState();
		const events = await this.#loadEvents();
		return { state, events };
	}

	async saveState(state: PersistedRpcState): Promise<void> {
		await fs.mkdir(path.dirname(this.#statePath), { recursive: true });
		const tempPath = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(tempPath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`);
		await fs.rename(tempPath, this.#statePath);
	}

	async appendEvent(event: SessionEvent): Promise<void> {
		await fs.mkdir(path.dirname(this.#eventsPath), { recursive: true });
		await fs.appendFile(this.#eventsPath, `${JSON.stringify(event)}\n`, "utf8");
	}

	async replaceEvents(events: readonly SessionEvent[]): Promise<void> {
		await fs.mkdir(path.dirname(this.#eventsPath), { recursive: true });
		const tempPath = `${this.#eventsPath}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(tempPath, events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
		await fs.rename(tempPath, this.#eventsPath);
	}

	async clear(): Promise<void> {
		await Promise.all([fs.rm(this.#statePath, { force: true }), fs.rm(this.#eventsPath, { force: true })]);
	}

	async #loadState(): Promise<PersistedRpcState> {
		try {
			const value = (await Bun.file(this.#statePath).json()) as Partial<PersistedRpcState>;
			return {
				...EMPTY_STATE,
				...value,
				queue: Array.isArray(value.queue) ? value.queue : [],
				pendingApprovals: Array.isArray(value.pendingApprovals) ? value.pendingApprovals : [],
				pendingInteractions: Array.isArray(value.pendingInteractions) ? value.pendingInteractions : [],
				settings: value.settings && typeof value.settings === "object" ? value.settings : {},
				receipts: Array.isArray(value.receipts) ? value.receipts : [],
				resources: Array.isArray(value.resources) ? value.resources : [],
				activeResourceIds: Array.isArray(value.activeResourceIds)
					? value.activeResourceIds.filter((item): item is string => typeof item === "string")
					: [],
				pendingResourceReleases: Array.isArray(value.pendingResourceReleases)
					? value.pendingResourceReleases.filter((item): item is string => typeof item === "string")
					: [],
				evidence: Array.isArray(value.evidence) ? value.evidence : [],
				artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
			};
		} catch (error: unknown) {
			if (!isEnoent(error)) throw new Error(`Failed to load RPC v2 state ${this.#statePath}: ${String(error)}`);
			return {
				...EMPTY_STATE,
				queue: [],
				pendingApprovals: [],
				pendingInteractions: [],
				settings: {},
				receipts: [],
				resources: [],
				activeResourceIds: [],
				pendingResourceReleases: [],
				evidence: [],
				artifacts: [],
			};
		}
	}

	async #loadEvents(): Promise<SessionEvent[]> {
		try {
			const text = await Bun.file(this.#eventsPath).text();
			const events: SessionEvent[] = [];
			const lines = text.split("\n");
			for (const [index, line] of lines.entries()) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as SessionEvent;
					if (
						!event ||
						typeof event.sequence !== "number" ||
						typeof event.eventId !== "string" ||
						typeof event.sessionId !== "string"
					) {
						throw new Error(`event line ${index + 1} has an invalid envelope`);
					}
					events.push(event);
				} catch (error: unknown) {
					const isFinalPartialLine = index === lines.length - 1 && !line.endsWith("}");
					if (isFinalPartialLine) break;
					throw new Error(`event line ${index + 1} is not valid JSON: ${String(error)}`);
				}
			}
			events.sort((a, b) => a.sequence - b.sequence);
			for (let index = 1; index < events.length; index++) {
				if (events[index]!.sequence <= events[index - 1]!.sequence) {
					throw new Error(`RPC v2 event sequence is not strictly increasing at ${events[index]!.eventId}`);
				}
			}
			return events;
		} catch (error: unknown) {
			if (!isEnoent(error)) throw new Error(`Failed to load RPC v2 events ${this.#eventsPath}: ${String(error)}`);
			return [];
		}
	}
}
