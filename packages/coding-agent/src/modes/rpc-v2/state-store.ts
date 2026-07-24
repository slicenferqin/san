/** Session-scoped RPC v2 state, event watermark and idempotency sidecar。 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "../../config/file-lock";
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
	pendingEvent?: SessionEvent;
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
	pendingEvent: undefined,
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
		if (state.pendingEvent) {
			const matchingEvent = events.find(event => event.eventId === state.pendingEvent?.eventId);
			assertEventCompatible(state.pendingEvent, matchingEvent, events);
			if (!matchingEvent) events.push(state.pendingEvent);
			events.sort((left, right) => left.sequence - right.sequence);
		}
		return { state, events };
	}

	async reconcilePendingEvent(state: PersistedRpcState): Promise<void> {
		const event = state.pendingEvent;
		await fs.mkdir(path.dirname(this.#eventsPath), { recursive: true });
		await withFileLock(this.#eventsPath, async () => {
			await this.#repairEventTail();
			if (!event) return;
			const existing = await this.#loadEvents();
			const matchingEvent = existing.find(candidate => candidate.eventId === event.eventId);
			assertEventCompatible(event, matchingEvent, existing);
			if (!matchingEvent) await this.#appendEvent(event);
		});
		if (!event) return;
		state.pendingEvent = undefined;
		await this.saveState(state);
	}

	async saveState(state: PersistedRpcState): Promise<void> {
		await fs.mkdir(path.dirname(this.#statePath), { recursive: true });
		const tempPath = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(tempPath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`);
		await fs.rename(tempPath, this.#statePath);
	}

	async appendEvent(event: SessionEvent): Promise<void> {
		await fs.mkdir(path.dirname(this.#eventsPath), { recursive: true });
		await this.#appendEvent(event);
	}

	async appendEventIdempotently(event: SessionEvent): Promise<void> {
		await fs.mkdir(path.dirname(this.#eventsPath), { recursive: true });
		await withFileLock(this.#eventsPath, async () => {
			await this.#repairEventTail();
			const existing = await this.#loadEvents();
			const matchingEvent = existing.find(candidate => candidate.eventId === event.eventId);
			assertEventCompatible(event, matchingEvent, existing);
			if (matchingEvent) return;
			await this.#appendEvent(event);
		});
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
				pendingEvent: value.pendingEvent && typeof value.pendingEvent === "object" ? value.pendingEvent : undefined,
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
				let event: SessionEvent;
				try {
					event = JSON.parse(line) as SessionEvent;
				} catch (error: unknown) {
					const isFinalPartialLine = index === lines.length - 1 && !text.endsWith("\n");
					if (isFinalPartialLine) break;
					throw new Error(`event line ${index + 1} is not valid JSON: ${String(error)}`);
				}
				if (
					!event ||
					typeof event.sequence !== "number" ||
					typeof event.eventId !== "string" ||
					typeof event.sessionId !== "string"
				) {
					throw new Error(`event line ${index + 1} has an invalid envelope`);
				}
				events.push(event);
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

	async #appendEvent(event: SessionEvent): Promise<void> {
		await fs.appendFile(this.#eventsPath, `${JSON.stringify(event)}\n`, "utf8");
	}

	async #repairEventTail(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.#eventsPath).text();
		} catch (error: unknown) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (text.length === 0 || text.endsWith("\n")) return;
		const lastNewline = text.lastIndexOf("\n");
		const tail = text.slice(lastNewline + 1);
		let complete = true;
		try {
			JSON.parse(tail);
		} catch {
			complete = false;
		}
		if (complete) await fs.appendFile(this.#eventsPath, "\n", "utf8");
		else await Bun.write(this.#eventsPath, text.slice(0, lastNewline + 1));
	}
}

function assertEventCompatible(
	event: SessionEvent,
	matchingEvent: SessionEvent | undefined,
	existing: readonly SessionEvent[],
): void {
	if (matchingEvent) {
		if (matchingEvent.sequence !== event.sequence || !Bun.deepEquals(matchingEvent, event)) {
			throw new Error(`RPC v2 event identity collision for ${event.eventId}`);
		}
		return;
	}
	if (existing.some(candidate => candidate.sequence === event.sequence)) {
		throw new Error(`RPC v2 event sequence collision at ${event.sequence}`);
	}
}
