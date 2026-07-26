import { estimateTokens } from "@san/agent/compaction";
import { prompt } from "@san/utils";
import { CONTEXT_PLAN_CUSTOM_TYPE, type ContextPlanAudit } from "../context-steady/plan-types";
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

function isContextPlanAudit(value: unknown): value is ContextPlanAudit {
	if (!isRecord(value)) return false;
	return value.schemaVersion === 1 && typeof value.planId === "string" && Array.isArray(value.materials);
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function newId(prefix: string): string {
	return `${prefix}_${Bun.randomUUIDv7()}`;
}

function contextPlanMaterialsForRefs(
	entries: readonly SessionEntry[],
	planRefs: readonly string[],
): Array<{ representation: string; kind: string; reason: string; tokenEstimate: number }> {
	if (planRefs.length === 0) return [];
	const refSet = new Set(planRefs);
	const materials: Array<{ representation: string; kind: string; reason: string; tokenEstimate: number }> = [];
	// Walk newest-first so later plans for the same ref win, but only emit
	// materials whose entry id is explicitly bound to the current run.
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTEXT_PLAN_CUSTOM_TYPE) continue;
		if (!refSet.has(entry.id)) continue;
		if (!isContextPlanAudit(entry.data)) continue;
		for (const material of entry.data.materials.slice(0, 8)) {
			materials.push({
				representation: material.representation,
				kind: material.kind,
				reason: material.reason,
				tokenEstimate: material.tokenEstimate,
			});
			if (materials.length >= 8) return materials;
		}
	}
	return materials;
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

function fitRoleContextToBudget(content: string, tokenBudget: number): { content: string; trimmed: boolean } {
	if (estimateRoleContextTokens(content) <= tokenBudget) return { content, trimmed: false };
	const closing = "</san_execution_loop_context>";
	const body = content.endsWith(closing) ? content.slice(0, -closing.length) : content;
	const suffix = `\n[role context omitted at ${tokenBudget}-token boundary]\n${closing}`;
	let lower = 0;
	let upper = body.length;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (estimateRoleContextTokens(`${body.slice(0, middle)}${suffix}`) <= tokenBudget) lower = middle;
		else upper = middle - 1;
	}
	return { content: `${body.slice(0, lower)}${suffix}`, trimmed: true };
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
	// Only plans explicitly bound on the run are projected. Session-global
	// "latest plan" must not contaminate this run's role context (P1-02).
	const sourceContextPlanRefs = [...(run.contextPlanRefs ?? [])];
	const sourceContextPacketRefs = [...run.contextPacketRefs];
	const contextPlanMaterials = contextPlanMaterialsForRefs(entries, sourceContextPlanRefs);
	const rendered = renderRoleContext({
		role: options.role,
		run,
		assignment,
		latestReview,
		events,
		decisions,
		sourceContextPlanRefs,
		sourceContextPacketRefs,
		contextPlanMaterials,
	});
	const fitted = fitRoleContextToBudget(rendered, tokenBudget);
	const content = fitted.content;
	const tokenEstimate = estimateRoleContextTokens(content);
	const packet: SanLoopRoleContextPacketDebug = {
		schemaVersion: SAN_LOOP_SCHEMA_VERSION,
		packetId: options.packetId ?? newId("loop_ctx"),
		runId: run.runId,
		sessionId: run.sessionId,
		createdAt: options.createdAt ?? new Date().toISOString(),
		role: options.role,
		sourceContextPlanRefs,
		sourceContextPacketRefs,
		entryRefs: [
			runRef.entryId,
			...ledger.events.filter(event => event.data.runId === run.runId).map(event => event.entryId),
			...ledger.reviews.filter(review => review.data.runId === run.runId).map(review => review.entryId),
		],
		tokenEstimate,
		tokenBudget,
		trimmed: fitted.trimmed ? 1 : 0,
	};
	return { packet, content, run, assignment };
}

export function appendSanLoopRoleContextDebugEntry(
	sessionManager: AppendCustomEntrySessionManager,
	packet: SanLoopRoleContextPacketDebug,
): string {
	return sessionManager.appendCustomEntry(SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE, packet);
}
