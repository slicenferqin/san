import {
	CONTEXT_PLAN_CUSTOM_TYPE,
	CONTEXT_PLAN_SCHEMA_VERSION,
	type ContextPlanAudit,
	type ContextPlanCoverageAudit,
	type ContextPlanMaterialAudit,
} from "../../context-steady/plan-types";
import type { SessionEntry } from "../../session/session-entries";

const DEFAULT_PLAN_REPORT_COUNT = 1;
const MAX_PLAN_REPORT_COUNT = 20;

interface PlanEntryRef {
	entryId: string;
	plan: ContextPlanAudit;
}

export interface ContextPlanReportOptions {
	count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isContextPlanAudit(value: unknown): value is ContextPlanAudit {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === CONTEXT_PLAN_SCHEMA_VERSION &&
		typeof value.planId === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.epochId === "string" &&
		isRecord(value.budget) &&
		isRecord(value.qualityGate) &&
		Array.isArray(value.materials) &&
		Array.isArray(value.coverage)
	);
}

function clampReportCount(count: number | undefined): number {
	if (count === undefined || !Number.isFinite(count)) return DEFAULT_PLAN_REPORT_COUNT;
	return Math.min(MAX_PLAN_REPORT_COUNT, Math.max(1, Math.floor(count)));
}

export function parseContextPlanReportCount(input: string): number | { error: string } {
	const trimmed = input.trim();
	if (!trimmed) return DEFAULT_PLAN_REPORT_COUNT;
	const count = Number(trimmed);
	if (!Number.isInteger(count) || count < 1 || count > MAX_PLAN_REPORT_COUNT) {
		return { error: `Usage: /context plan [1-${MAX_PLAN_REPORT_COUNT}]` };
	}
	return count;
}

function findContextPlanEntries(entries: readonly SessionEntry[]): PlanEntryRef[] {
	const plans: PlanEntryRef[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONTEXT_PLAN_CUSTOM_TYPE) continue;
		if (!isContextPlanAudit(entry.data)) continue;
		plans.push({ entryId: entry.id, plan: entry.data });
	}
	return plans;
}

function formatNumber(value: number): string {
	return value.toLocaleString();
}

function formatRefs(refs: readonly string[]): string {
	return refs.length > 0 ? refs.join(", ") : "none";
}

function formatBudget(plan: ContextPlanAudit): string[] {
	const budget = plan.budget;
	return [
		"Budget:",
		`- contextWindow=${formatNumber(budget.contextWindow)}`,
		`- nonMessageTokens=${formatNumber(budget.nonMessageTokens)}`,
		`- steadyTarget=${formatNumber(budget.steadyTarget)}`,
		`- controlMax=${formatNumber(budget.controlMax)}`,
		`- burstCeiling=${formatNumber(budget.burstCeiling)}`,
		`- selectedInput=${budget.selectedInputMode}:${formatNumber(budget.selectedInputLimit)}`,
		`- messageBudget=${formatNumber(budget.messageBudget)}`,
		`- planTokenBudget=${formatNumber(budget.planTokenBudget)}`,
	];
}

function formatQuality(plan: ContextPlanAudit): string[] {
	const gate = plan.qualityGate;
	return [
		"Quality gate:",
		`- outcome=${gate.outcome}`,
		`- protected=${formatRefs(gate.protectedEntryRefs)}`,
		`- missing=${formatRefs(gate.missingEntryRefs)}`,
		`- reasons=${gate.reasons.length > 0 ? gate.reasons.join(", ") : "none"}`,
		...(gate.requiredBurstTokens === undefined
			? []
			: [`- requiredBurstTokens=${formatNumber(gate.requiredBurstTokens)}`]),
	];
}

function formatMaterial(material: ContextPlanMaterialAudit): string {
	return [
		`- ${material.materialId}: ${material.representation}/${material.kind}`,
		`refs=${formatRefs(material.entryRefs)}`,
		`tokens=${formatNumber(material.tokenEstimate)}`,
		`reason=${material.reason}`,
	].join("; ");
}

function formatCoverage(coverage: ContextPlanCoverageAudit): string {
	return [
		`- ${coverage.replacementMaterialId}`,
		`covers=${formatRefs(coverage.sourceEntryRefs)}`,
		`reason=${coverage.reason}`,
	].join("; ");
}

function formatPlan(entry: PlanEntryRef): string {
	const lines = [
		`## ContextPlan ${entry.plan.planId}`,
		`Audit entry: ${entry.entryId}`,
		`Created: ${entry.plan.createdAt}`,
		`Session: ${entry.plan.sessionId}`,
		`Epoch: ${entry.plan.epochId}`,
		`Prompt generation: ${entry.plan.promptGeneration}`,
	];
	lines.push(...formatBudget(entry.plan));
	lines.push(...formatQuality(entry.plan));
	lines.push("Materials:");
	if (entry.plan.materials.length === 0) lines.push("- none");
	else for (const material of entry.plan.materials) lines.push(formatMaterial(material));
	lines.push("Coverage:");
	if (entry.plan.coverage.length === 0) lines.push("- none");
	else for (const coverage of entry.plan.coverage) lines.push(formatCoverage(coverage));
	return lines.join("\n");
}

export function buildContextPlanReportText(
	entries: readonly SessionEntry[],
	options: ContextPlanReportOptions = {},
): string {
	const count = clampReportCount(options.count);
	const plans = findContextPlanEntries(entries);
	if (plans.length === 0) {
		return "No San ContextPlan audit entries found.";
	}
	const selected = plans.slice(-count).reverse();
	const heading = `San ContextPlan audit view (${selected.length}/${plans.length} shown)`;
	return [heading, ...selected.map(formatPlan)].join("\n\n");
}
