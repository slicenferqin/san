import { CONTEXT_PLAN_CUSTOM_TYPE } from "../../context-steady/plan-types";
import {
	CONTEXT_MAINTENANCE_CUSTOM_TYPE,
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	CONTEXT_SEGMENT_SCHEMA_VERSION,
	type ContextMaintenanceAudit,
	type ContextSegment,
} from "../../context-steady/types";
import type { SessionEntry } from "../../session/session-entries";

/**
 * Two steady-target maintenances closer than this many plan audits count as a
 * repeat trigger — the "reclaimed nothing, fired again" failure signal.
 */
const REPEAT_TRIGGER_PLAN_WINDOW = 3;

interface SteadyTriggerObservation {
	segment: ContextSegment;
	/** Plan audits recorded between this trigger and the previous one. */
	plansSincePrevious: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function asContextSegment(value: unknown): ContextSegment | undefined {
	if (!isRecord(value) || value.schemaVersion !== CONTEXT_SEGMENT_SCHEMA_VERSION) return undefined;
	const maintenance = value.maintenance;
	if (!isRecord(maintenance) || !Array.isArray(maintenance.matchedTriggers)) return undefined;
	return value as unknown as ContextSegment;
}

function asContextMaintenanceAudit(value: unknown): ContextMaintenanceAudit | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.maintenanceId !== "string" || typeof value.reason !== "string") return undefined;
	if (typeof value.state !== "string") return undefined;
	return value as unknown as ContextMaintenanceAudit;
}

function collectSteadyObservations(entries: readonly SessionEntry[]): {
	triggers: SteadyTriggerObservation[];
	totalSegments: number;
	pauses: number;
	totalPlans: number;
} {
	const triggers: SteadyTriggerObservation[] = [];
	let totalSegments = 0;
	let pauses = 0;
	let totalPlans = 0;
	let plansSincePrevious = 0;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === CONTEXT_PLAN_CUSTOM_TYPE) {
			totalPlans += 1;
			plansSincePrevious += 1;
			continue;
		}
		if (entry.customType === CONTEXT_SEGMENT_CUSTOM_TYPE) {
			const segment = asContextSegment(entry.data);
			if (!segment) continue;
			totalSegments += 1;
			if (segment.maintenance.trigger !== "steady_target") continue;
			triggers.push({ segment, plansSincePrevious });
			plansSincePrevious = 0;
			continue;
		}
		if (entry.customType === CONTEXT_MAINTENANCE_CUSTOM_TYPE) {
			const audit = asContextMaintenanceAudit(entry.data);
			if (audit?.state === "paused_for_context") pauses += 1;
		}
	}
	return { triggers, totalSegments, pauses, totalPlans };
}

function reclaimedTokens(segment: ContextSegment): number | undefined {
	const before = segment.maintenance.tokensBefore;
	const after = segment.maintenance.tokensAfter;
	if (typeof after !== "number" || !Number.isFinite(after)) return undefined;
	return before - after;
}

function formatNumber(value: number): string {
	return value.toLocaleString();
}

export function buildContextSteadyReportText(entries: readonly SessionEntry[]): string {
	const { triggers, totalSegments, pauses, totalPlans } = collectSteadyObservations(entries);
	if (totalSegments === 0 && pauses === 0) {
		return "No context maintenance records found for this session.";
	}
	const withNative = triggers.filter(observation =>
		observation.segment.maintenance.matchedTriggers.includes("native_threshold"),
	);
	const reclaimed = triggers
		.map(observation => reclaimedTokens(observation.segment))
		.filter((value): value is number => typeof value === "number");
	const ineffective = reclaimed.filter(value => value <= 0).length;
	const totalReclaimed = reclaimed.reduce((sum, value) => sum + value, 0);
	const repeats = triggers.filter(
		observation => observation.plansSincePrevious > 0 && observation.plansSincePrevious <= REPEAT_TRIGGER_PLAN_WINDOW,
	).length;
	const latest = triggers.at(-1);
	const latestLines = latest
		? [
				"Latest steady-target maintenance:",
				`- createdAt=${latest.segment.createdAt}`,
				`- phase=${latest.segment.maintenance.phase}`,
				`- tokensBefore=${formatNumber(latest.segment.maintenance.tokensBefore)}`,
				`- tokensAfter=${
					typeof latest.segment.maintenance.tokensAfter === "number"
						? formatNumber(latest.segment.maintenance.tokensAfter)
						: "unknown"
				}`,
			]
		: [];
	return [
		"Context Steady maintenance view",
		`Steady-target maintenances: ${formatNumber(triggers.length)}/${formatNumber(totalSegments)} segments`,
		`- overlapWithNativeThreshold=${formatNumber(withNative.length)}`,
		`- reclaimedTokensTotal=${formatNumber(totalReclaimed)}${reclaimed.length > 0 ? ` over ${formatNumber(reclaimed.length)} measured` : ""}`,
		`- reclaimedNothing=${formatNumber(ineffective)}`,
		`- repeatTriggers=${formatNumber(repeats)} (fired again within ${REPEAT_TRIGGER_PLAN_WINDOW} plans)`,
		`- pausedForContext=${formatNumber(pauses)}`,
		`- planAudits=${formatNumber(totalPlans)}`,
		...latestLines,
	].join("\n");
}
