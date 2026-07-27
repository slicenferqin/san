/** Session-scoped RPC v2 state, event watermark and idempotency sidecar。 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
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
	readonly #sessionId: string;
	#stateWriteTail: Promise<void> = Promise.resolve();

	constructor(sessionFile: string | undefined, sessionId: string) {
		const base = sessionFile ? `${sessionFile}.rpc-v2` : path.join(os.tmpdir(), "san-rpc-v2", sessionId);
		this.#sessionId = sessionId;
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
		const foreignEvent = events.find(event => event.sessionId !== this.#sessionId);
		if (foreignEvent) throw new Error(`RPC v2 event ${foreignEvent.eventId} belongs to another Session`);
		if (state.pendingEvent) {
			if (state.pendingEvent.sessionId !== this.#sessionId) {
				throw new Error(`RPC v2 pending event ${state.pendingEvent.eventId} belongs to another Session`);
			}
			const matchingEvent = events.find(event => event.eventId === state.pendingEvent?.eventId);
			assertEventCompatible(state.pendingEvent, matchingEvent, events);
			if (!matchingEvent) events.push(state.pendingEvent);
			events.sort((left, right) => left.sequence - right.sequence);
		}
		const journalSequence = events.at(-1)?.sequence ?? 0;
		if (state.lastSequence > journalSequence) {
			throw new Error(`RPC v2 state watermark ${state.lastSequence} exceeds event journal ${journalSequence}`);
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
		const body = `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`;
		const scheduled = this.#stateWriteTail
			.catch(() => undefined)
			.then(async () => {
				await fs.mkdir(path.dirname(this.#statePath), { recursive: true });
				const tempPath = `${this.#statePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
				try {
					await Bun.write(tempPath, body);
					await fs.rename(tempPath, this.#statePath);
				} finally {
					await fs.rm(tempPath, { force: true }).catch(() => undefined);
				}
			});
		this.#stateWriteTail = scheduled.catch(() => undefined);
		return scheduled;
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
		const tempPath = `${this.#eventsPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(tempPath, events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
			await fs.rename(tempPath, this.#eventsPath);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	async clear(): Promise<void> {
		await Promise.all([fs.rm(this.#statePath, { force: true }), fs.rm(this.#eventsPath, { force: true })]);
	}

	async #loadState(): Promise<PersistedRpcState> {
		try {
			const value: unknown = await Bun.file(this.#statePath).json();
			if (!isRecord(value)) throw new Error("expected a JSON object");
			if (value.schemaVersion !== 1) throw new Error("expected schemaVersion 1");
			if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
				throw new Error("revision must be a non-negative safe integer");
			}
			if (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) {
				throw new Error("lastSequence must be a non-negative safe integer");
			}
			return {
				...EMPTY_STATE,
				...value,
				queue: Array.isArray(value.queue) ? value.queue : [],
				pendingApprovals: Array.isArray(value.pendingApprovals) ? value.pendingApprovals : [],
				pendingInteractions: Array.isArray(value.pendingInteractions) ? value.pendingInteractions : [],
				settings: isRecord(value.settings) ? value.settings : {},
				receipts: Array.isArray(value.receipts) ? value.receipts.filter(isIdempotencyReceipt) : [],
				resources: Array.isArray(value.resources) ? value.resources : [],
				activeResourceIds: Array.isArray(value.activeResourceIds)
					? value.activeResourceIds.filter((item): item is string => typeof item === "string")
					: [],
				pendingResourceReleases: Array.isArray(value.pendingResourceReleases)
					? value.pendingResourceReleases.filter((item): item is string => typeof item === "string")
					: [],
				evidence: Array.isArray(value.evidence) ? value.evidence.filter(isEvidenceRecord) : [],
				artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
				pendingEvent: isSessionEvent(value.pendingEvent) ? value.pendingEvent : undefined,
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
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error: unknown) {
					const isFinalPartialLine = index === lines.length - 1 && !text.endsWith("\n");
					if (isFinalPartialLine) break;
					throw new Error(`event line ${index + 1} is not valid JSON: ${String(error)}`);
				}
				if (!isSessionEvent(parsed)) throw new Error(`event line ${index + 1} has an invalid envelope`);
				events.push(parsed);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdempotencyReceipt(value: unknown): value is IdempotencyReceipt {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		value.key.trim().length > 0 &&
		typeof value.paramsHash === "string" &&
		value.paramsHash.length > 0 &&
		Number.isSafeInteger(value.createdAt) &&
		(value.createdAt as number) >= 0 &&
		"result" in value
	);
}

const EVIDENCE_KINDS = new Set([
	"command_result",
	"test_result",
	"file_change",
	"tool_result",
	"approval_decision",
	"checkpoint",
	"subagent_report",
	"host_observation",
]);
const EVIDENCE_VERDICTS = new Set(["passed", "failed", "informational", "unknown"]);
const EVIDENCE_SOURCE_KINDS = new Set(["deterministic_tool", "san_runtime", "model_summary", "desktop_host"]);

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.evidenceId === "string" &&
		value.evidenceId.length > 0 &&
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		typeof value.createdAt === "string" &&
		EVIDENCE_KINDS.has(value.kind as string) &&
		EVIDENCE_VERDICTS.has(value.verdict as string) &&
		typeof value.title === "string" &&
		typeof value.summary === "string" &&
		isRecord(value.source) &&
		EVIDENCE_SOURCE_KINDS.has(value.source.kind as string)
	);
}

function isSessionEvent(value: unknown): value is SessionEvent {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.eventId === "string" &&
		value.eventId.length > 0 &&
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		Number.isSafeInteger(value.sequence) &&
		(value.sequence as number) > 0 &&
		typeof value.timestamp === "string" &&
		typeof value.type === "string" &&
		(value.durability === "durable" || value.durability === "transient") &&
		"data" in value
	);
}
