import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { prompt } from "@oh-my-pi/pi-utils";
import { CONTEXT_PACKET_CUSTOM_TYPE, type ContextPacket } from "../context-steady/types";
import roleContextTemplate from "../prompts/san-loop/role-context.md" with { type: "text" };
import type { SessionEntry } from "../session/session-entries";
import { rebuildSanLoopLedger } from "./ledger";
import {
	SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
	SAN_LOOP_SCHEMA_VERSION,
	type SanLoopEvent,
	type SanLoopRole,
	type SanLoopRoleContextPacketDebug,
	type SanLoopRunSnapshot,
	type SanLoopWorkerAssignment,
} from "./types";

interface AppendCustomEntrySessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface SanLoopRoleContextSettings {
	tokenBudget: number;
	maxEvents: number;
	maxDecisions: number;
}

export interface BuildSanLoopRoleContextOptions {
	role: SanLoopRole;
	runId?: string;
	assignmentId?: string;
	settings?: Partial<SanLoopRoleContextSettings>;
	createdAt?: string;
	packetId?: string;
}

export interface BuiltSanLoopRoleContext {
	packet: SanLoopRoleContextPacketDebug;
	content: string;
	run: SanLoopRunSnapshot;
	assignment?: SanLoopWorkerAssignment;
}

const DEFAULT_ROLE_CONTEXT_SETTINGS: SanLoopRoleContextSettings = {
	tokenBudget: 2000,
	maxEvents: 8,
	maxDecisions: 8,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isContextPacket(value: unknown): value is ContextPacket {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === 1 &&
		typeof value.packetId === "string" &&
		typeof value.sessionId === "string" &&
		Array.isArray(value.digestRefs)
	);
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function newId(prefix: string): string {
	return `${prefix}_${Bun.randomUUIDv7()}`;
}

function latestContextPacketRefs(entries: readonly SessionEntry[]): string[] {
	const refs: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTEXT_PACKET_CUSTOM_TYPE) continue;
		if (!isContextPacket(entry.data)) continue;
		refs.push(entry.id);
	}
	return refs.slice(-3);
}

function roleEvents(events: readonly SanLoopEvent[], role: SanLoopRole, maxEvents: number): SanLoopEvent[] {
	const roleFiltered = events.filter(event => event.actor === undefined || event.actor === role);
	return roleFiltered.slice(-maxEvents);
}

function renderRoleContext(content: Record<string, unknown>): string {
	return prompt.render(roleContextTemplate, content);
}

function estimateRoleContextTokens(content: string): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
	});
}

export function buildSanLoopRoleContext(
	entries: readonly SessionEntry[],
	options: BuildSanLoopRoleContextOptions,
): BuiltSanLoopRoleContext | null {
	const settings = {
		...DEFAULT_ROLE_CONTEXT_SETTINGS,
		...options.settings,
	};
	const tokenBudget = clampPositiveInteger(settings.tokenBudget, DEFAULT_ROLE_CONTEXT_SETTINGS.tokenBudget);
	const maxEvents = clampPositiveInteger(settings.maxEvents, DEFAULT_ROLE_CONTEXT_SETTINGS.maxEvents);
	const maxDecisions = clampPositiveInteger(settings.maxDecisions, DEFAULT_ROLE_CONTEXT_SETTINGS.maxDecisions);
	const ledger = rebuildSanLoopLedger(entries);
	const runRef = options.runId ? ledger.runs.find(run => run.data.runId === options.runId) : ledger.latestRun;
	if (!runRef) return null;

	const run = runRef.data;
	const assignment = options.assignmentId
		? run.assignments.find(item => item.assignmentId === options.assignmentId)
		: run.assignments.at(-1);
	const latestReview = ledger.reviews.filter(review => review.data.runId === run.runId).at(-1)?.data;
	const events = roleEvents(
		ledger.events.filter(event => event.data.runId === run.runId).map(event => event.data),
		options.role,
		maxEvents,
	);
	const decisions = run.decisions.slice(-maxDecisions);
	const sourceContextPacketRefs = [...new Set([...run.contextPacketRefs, ...latestContextPacketRefs(entries)])];
	const content = renderRoleContext({
		role: options.role,
		run,
		assignment,
		latestReview,
		events,
		decisions,
		sourceContextPacketRefs,
	});
	const tokenEstimate = estimateRoleContextTokens(content);
	const packet: SanLoopRoleContextPacketDebug = {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		packetId: options.packetId ?? newId("loop_ctx"),
		runId: run.runId,
		sessionId: run.sessionId,
		createdAt: options.createdAt ?? new Date().toISOString(),
		role: options.role,
		sourceContextPacketRefs,
		entryRefs: [
			runRef.entryId,
			...ledger.events.filter(event => event.data.runId === run.runId).map(event => event.entryId),
			...ledger.reviews.filter(review => review.data.runId === run.runId).map(review => review.entryId),
		],
		tokenEstimate,
		tokenBudget,
		trimmed: tokenEstimate > tokenBudget ? 1 : 0,
	};
	return { packet, content, run, assignment };
}

export function appendSanLoopRoleContextDebugEntry(
	sessionManager: AppendCustomEntrySessionManager,
	packet: SanLoopRoleContextPacketDebug,
): string {
	return sessionManager.appendCustomEntry(SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE, packet);
}
