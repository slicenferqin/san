import { prompt } from "@san/utils";
import riskHistoryTemplate from "../prompts/brain/recall/risk-history-v1.md" with { type: "text" };
import taskRelevantTemplate from "../prompts/brain/recall/task-relevant-v1.md" with { type: "text" };
import { isSanBrainHistorySuppressed, sanBrainScopeKey, selectSanBrainActiveStates } from "./activation";
import type { SanBrainActiveStateRecord } from "./store";
import {
	isSanBrainExperienceCandidate,
	type SanBrainActivationRole,
	type SanBrainActivationSkipReason,
	type SanBrainScope,
} from "./types";

export const BRAIN_RECALL_POLICY_VERSION = "brain-m6-recall-v1";

export type SanBrainRecallMemoryType = "working" | "episodic" | "fact";
export type SanBrainRecallSkipReason = SanBrainActivationSkipReason | "unknown_template" | "policy_limit";

export interface SanBrainRecallSkip {
	ownerId: string;
	reason: SanBrainRecallSkipReason;
}

export interface BuildSanBrainRecallPlanOptions {
	role: SanBrainActivationRole;
	scopes: readonly SanBrainScope[];
	promptText: string;
	baseQuery: string;
	maxItems: number;
	tokenBudget: number;
	minConfidence: number;
	maxQueryChars?: number;
	blockedClaimKeys?: readonly string[];
}

export interface SanBrainRecallPlan {
	policyVersion: typeof BRAIN_RECALL_POLICY_VERSION;
	selectedPolicyIds: string[];
	queryTemplateId?: string;
	query?: string;
	memoryTypes: SanBrainRecallMemoryType[];
	scopeKeys: string[];
	role: SanBrainActivationRole;
	maxItems: number;
	tokenBudget: number;
	suppressed: boolean;
	skipReasons: SanBrainRecallSkip[];
}

interface RecallTemplateDefinition {
	content: string;
	memoryTypes: readonly SanBrainRecallMemoryType[];
}

const RECALL_TEMPLATES: Readonly<Record<string, RecallTemplateDefinition>> = {
	"task-relevant-v1": {
		content: taskRelevantTemplate,
		memoryTypes: ["working", "episodic", "fact"],
	},
	"risk-history-v1": {
		content: riskHistoryTemplate,
		memoryTypes: ["episodic", "fact"],
	},
};

export function isSanBrainRecallTemplateId(value: string): boolean {
	return Object.hasOwn(RECALL_TEMPLATES, value);
}

function clampNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function clampQuery(value: string, maxChars: number | undefined): string {
	const limit = maxChars === undefined ? 4000 : clampNonNegativeInteger(maxChars);
	if (limit === 0) return "";
	return value.length <= limit ? value : value.slice(0, limit);
}

export function buildSanBrainRecallPlan(
	activeStates: readonly SanBrainActiveStateRecord[],
	options: BuildSanBrainRecallPlanOptions,
): SanBrainRecallPlan {
	const recallStates = activeStates.filter(
		record => isSanBrainExperienceCandidate(record.candidate) && record.candidate.action.kind === "recall_policy",
	);
	const recallOwnerIds = new Set(recallStates.map(record => record.candidate.candidateId));
	const selection = selectSanBrainActiveStates(recallStates, {
		role: options.role,
		scopes: options.scopes,
		promptText: options.promptText,
		minConfidence: options.minConfidence,
		blockedClaimKeys: options.blockedClaimKeys,
	});
	const skipReasons: SanBrainRecallSkip[] = selection.skippedRules
		.filter(rule => recallOwnerIds.has(rule.ownerId))
		.map(rule => ({ ...rule }));
	const nonGoverningReasons = new Set<SanBrainActivationSkipReason>([
		"scope_mismatch",
		"role_mismatch",
		"blocked_claim",
		"expired",
		"below_confidence",
		"sensitive",
	]);
	const policyGoverned =
		selection.selectedStates.length > 0 ||
		selection.skippedRules.some(rule => recallOwnerIds.has(rule.ownerId) && !nonGoverningReasons.has(rule.reason));
	const suppressed = isSanBrainHistorySuppressed(options.promptText);
	let selectedPolicyId: string | undefined;
	let queryTemplateId: string | undefined;
	let templateDefinition: RecallTemplateDefinition | undefined;

	if (!suppressed) {
		for (const state of selection.selectedStates) {
			if (state.action.kind !== "recall_policy") continue;
			const definition = RECALL_TEMPLATES[state.action.queryTemplateId];
			if (!definition) {
				skipReasons.push({ ownerId: state.record.candidate.candidateId, reason: "unknown_template" });
				continue;
			}
			if (selectedPolicyId) {
				skipReasons.push({ ownerId: state.record.candidate.candidateId, reason: "policy_limit" });
				continue;
			}
			selectedPolicyId = state.record.candidate.candidateId;
			queryTemplateId = state.action.queryTemplateId;
			templateDefinition = definition;
		}
	}

	const renderedQuery = templateDefinition
		? prompt.render(templateDefinition.content, { baseQuery: options.baseQuery })
		: policyGoverned
			? ""
			: options.baseQuery;
	const query = suppressed ? undefined : clampQuery(renderedQuery, options.maxQueryChars).trim() || undefined;
	return {
		policyVersion: BRAIN_RECALL_POLICY_VERSION,
		selectedPolicyIds: selectedPolicyId ? [selectedPolicyId] : [],
		...(queryTemplateId ? { queryTemplateId } : {}),
		...(query ? { query } : {}),
		memoryTypes: templateDefinition ? [...templateDefinition.memoryTypes] : [],
		scopeKeys: options.scopes.map(sanBrainScopeKey).sort(),
		role: options.role,
		maxItems: clampNonNegativeInteger(options.maxItems),
		tokenBudget: clampNonNegativeInteger(options.tokenBudget),
		suppressed,
		skipReasons,
	};
}
