/**
 * /context steady report contract: layered steady-target maintenance metrics
 * computed from journal audit entries.
 */

import { describe, expect, test } from "bun:test";
import { buildContextSteadyReportText } from "@san/coding-agent/slash-commands/helpers/context-steady-report";
import { CONTEXT_PLAN_CUSTOM_TYPE } from "../../src/context-steady/plan-types";
import {
	CONTEXT_MAINTENANCE_CUSTOM_TYPE,
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	CONTEXT_SEGMENT_SCHEMA_VERSION,
} from "../../src/context-steady/types";

function customEntry(id: string, customType: string, data: unknown): Record<string, unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date().toISOString(), customType, data };
}

function segmentEntry(
	id: string,
	trigger: string,
	matchedTriggers: string[],
	tokensBefore: number,
	tokensAfter?: number,
): Record<string, unknown> {
	return customEntry(id, CONTEXT_SEGMENT_CUSTOM_TYPE, {
		schemaVersion: CONTEXT_SEGMENT_SCHEMA_VERSION,
		segmentId: `seg_${id}`,
		logicalTurnId: "turn",
		sessionId: "s1",
		createdAt: "2026-08-22T00:00:00.000Z",
		status: "closed",
		authority: "context-full",
		source: { fromEntryId: "a", toEntryId: "b", promptGeneration: 1 },
		maintenance: {
			maintenanceId: `maint_${id}`,
			trigger,
			matchedTriggers,
			action: "context-full",
			phase: "pre_turn",
			tokensBefore,
			...(tokensAfter === undefined ? {} : { tokensAfter }),
		},
		checkpoint: {
			userIntent: "intent",
			actionsTaken: [],
			decisions: [],
			filesTouched: [],
			toolEvidence: [],
			factsLearned: [],
			openQuestions: [],
			risks: [],
			nextSteps: [],
			activeUserEntryId: "u",
		},
	});
}

const asEntries = (entries: Record<string, unknown>[]) =>
	entries as unknown as Parameters<typeof buildContextSteadyReportText>[0];

describe("buildContextSteadyReportText", () => {
	test("aggregates steady-target triggers, reclamation, overlap, repeats, and pauses", () => {
		const entries = asEntries([
			// First steady_target trigger reclaimed 30k tokens.
			segmentEntry("seg1", "steady_target", ["steady_target"], 60_000, 30_000),
			customEntry("p1", CONTEXT_PLAN_CUSTOM_TYPE, { planId: "plan1" }),
			// Repeat trigger: fired again within the plan window and reclaimed nothing.
			segmentEntry("seg2", "steady_target", ["steady_target"], 32_000, 32_000),
			customEntry("p2", CONTEXT_PLAN_CUSTOM_TYPE, { planId: "plan2" }),
			// Unrelated native-threshold segment is counted but not a steady trigger.
			segmentEntry("seg3", "native_threshold", ["native_threshold", "steady_target"], 50_000, 20_000),
			customEntry("m1", CONTEXT_MAINTENANCE_CUSTOM_TYPE, {
				schemaVersion: 1,
				maintenanceId: "maint_x",
				sessionId: "s1",
				createdAt: "2026-08-22T00:00:00.000Z",
				promptGeneration: 3,
				state: "paused_for_context",
				reason: "hard_pressure",
				phase: "pre_turn",
				recoveryAttempt: 1,
			}),
		]);

		const text = buildContextSteadyReportText(entries);

		expect(text).toContain("Steady-target maintenances: 2/3 segments");
		// seg3 overlaps native_threshold but its primary trigger is native, so
		// only seg1/seg2 count as steady triggers; neither overlaps native.
		expect(text).toContain("overlapWithNativeThreshold=0");
		expect(text).toContain("reclaimedTokensTotal=30,000 over 2 measured");
		expect(text).toContain("reclaimedNothing=1");
		expect(text).toContain("repeatTriggers=1");
		expect(text).toContain("pausedForContext=1");
		expect(text).toContain("planAudits=2");
		expect(text).toContain("Latest steady-target maintenance:");
		expect(text).toContain("tokensBefore=32,000");
	});

	test("reports empty when the session has no maintenance records", () => {
		const text = buildContextSteadyReportText(asEntries([]));
		expect(text).toBe("No context maintenance records found for this session.");
	});
});
