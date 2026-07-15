import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { prompt } from "@oh-my-pi/pi-utils";
import statePreludeTemplate from "../prompts/brain/state-prelude.md" with { type: "text" };
import type { ReadonlySessionManager } from "../session/session-manager";
import type { SanBrainActiveStateRecord } from "./store";
import {
	BRAIN_ERROR_CUSTOM_TYPE,
	BRAIN_SCHEMA_VERSION,
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	type SanBrainAction,
	type SanBrainActivation,
	type SanBrainActivationRole,
	type SanBrainActivationSelectedRule,
	type SanBrainActivationSkipReason,
	type SanBrainActivationSourceBudget,
	type SanBrainInjectionSource,
	type SanBrainScope,
} from "./types";

export const BRAIN_STATE_MESSAGE_TYPE = "san.brain.state_prelude";
export const BRAIN_ACTIVATION_POLICY_VERSION = "brain-m4-v1";

const MAX_RENDERED_FIELD_CHARS = 400;
const GLOBAL_CONFLICT_PATTERN =
	/(?:ignore|disable|forget|do not use|don't use|never use).{0,24}(?:brain|memory|history)|(?:不要|禁用|忽略|忘掉).{0,16}(?:brain|记忆|历史)/iu;
const NEGATION_PATTERN = /\b(?:not|never|avoid|ignore|disable|don't|do not)\b|不要|禁止|避免|忽略|不再/iu;
const PATH_PATTERN = /(?:^|[\s"'`])([\p{L}\p{N}_./\\-]+\.[\p{L}\p{N}_-]+)(?=$|[\s"'`,:;])/gu;

interface ActivationMatchContext {
	promptText: string;
	normalizedPrompt: string;
	role: SanBrainActivationRole;
	scopeKeys: Set<string>;
	blockedClaimKeys: Set<string>;
	filePaths: string[];
	languages: Set<string>;
	now: number;
}

export interface SanBrainSelectedActiveState {
	record: SanBrainActiveStateRecord;
	action: SanBrainAction;
	priority: number;
	relevance: number;
}

export interface SelectSanBrainActiveStatesOptions {
	role: SanBrainActivationRole;
	scopes: readonly SanBrainScope[];
	promptText: string;
	minConfidence: number;
	blockedClaimKeys?: readonly string[];
	now?: number;
}

export interface SanBrainActiveStateSelection {
	selectedStates: SanBrainSelectedActiveState[];
	skippedRules: SanBrainActivation["skippedRules"];
	scopeKeys: string[];
}

interface RenderedRule {
	id: string;
	decisionId: string;
	revision: number;
	scope: { kind: string; key: string };
	action: SanBrainAction;
}

export interface BuildSanBrainStatePreludeOptions {
	sessionId: string;
	turnId: string;
	role: SanBrainActivationRole;
	scopes: readonly SanBrainScope[];
	promptText: string;
	maxItems: number;
	maxTokens: number;
	minConfidence: number;
	blockedClaimKeys?: readonly string[];
	createdAt?: string;
	activationId?: string;
}

export interface BuiltSanBrainStatePrelude {
	content?: string;
	activation: SanBrainActivation;
}

export interface SanBrainInjectionCandidate {
	source: SanBrainInjectionSource;
	content?: string;
	tokenEstimate?: number;
}

export interface SanBrainInjectionPlan {
	includedSources: SanBrainInjectionSource[];
	sourceBudgets: SanBrainActivationSourceBudget[];
	tokenEstimate: number;
	tokenBudget: number;
}

function clampNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function clampProbability(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function normalizeMatchText(value: string): string {
	return value.toLocaleLowerCase().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function sanitizeRenderedText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, MAX_RENDERED_FIELD_CHARS);
}

function promptSafeJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</gu, "\\u003c")
		.replace(/>/gu, "\\u003e")
		.replace(/&/gu, "\\u0026")
		.replace(/\u2028/gu, "\\u2028")
		.replace(/\u2029/gu, "\\u2029");
}

export function estimateSanBrainInjectionTokens(content: string): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
	});
}

export function sanBrainScopeKey(scope: SanBrainScope): string {
	return `${scope.kind}:${scope.key}`;
}

export function isSanBrainHistorySuppressed(promptText: string): boolean {
	return GLOBAL_CONFLICT_PATTERN.test(promptText);
}

function extractFilePaths(promptText: string): string[] {
	return [...promptText.matchAll(PATH_PATTERN)].map(match => match[1].replaceAll("\\", "/"));
}

function extractLanguages(promptText: string, filePaths: readonly string[]): Set<string> {
	const languages = new Set<string>();
	const extensionLanguages: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		rb: "ruby",
		php: "php",
		cs: "csharp",
		cpp: "cpp",
		cc: "cpp",
		c: "c",
		h: "c",
	};
	for (const filePath of filePaths) {
		const extension = filePath.split(".").at(-1)?.toLocaleLowerCase();
		if (extension) languages.add(extensionLanguages[extension] ?? extension);
	}
	const normalized = normalizeMatchText(promptText);
	for (const language of new Set(Object.values(extensionLanguages))) {
		if (normalized.includes(language)) languages.add(language);
	}
	return languages;
}

function promptMatchesValue(normalizedPrompt: string, value: string): boolean {
	const normalizedValue = normalizeMatchText(value);
	return normalizedValue.length > 0 && normalizedPrompt.includes(normalizedValue);
}

function matchesFileGlob(filePaths: readonly string[], pattern: string): boolean {
	try {
		const glob = new Bun.Glob(pattern);
		return filePaths.some(filePath => glob.match(filePath));
	} catch {
		return false;
	}
}

function selectorMatch(
	record: SanBrainActiveStateRecord,
	context: ActivationMatchContext,
): { matches: boolean; relevance: number } {
	const candidate = record.candidate;
	if (isSanBrainProfileCandidate(candidate)) {
		if (candidate.taskTags.length === 0) return { matches: true, relevance: 1 };
		const matches = candidate.taskTags.some(tag => promptMatchesValue(context.normalizedPrompt, tag));
		return { matches, relevance: matches ? 2 : 0 };
	}
	if (!isSanBrainExperienceCandidate(candidate)) return { matches: false, relevance: 0 };

	const selector = candidate.selector;
	let relevance = 1;
	const dimensions: boolean[] = [];
	if (selector.roles?.length) {
		const matches = selector.roles.includes(context.role);
		dimensions.push(matches);
		if (matches) relevance++;
	}
	if (selector.taskFamilies?.length) {
		const matches = selector.taskFamilies.some(value => promptMatchesValue(context.normalizedPrompt, value));
		dimensions.push(matches);
		if (matches) relevance++;
	}
	if (selector.commands?.length) {
		const matches = selector.commands.some(value => promptMatchesValue(context.normalizedPrompt, value));
		dimensions.push(matches);
		if (matches) relevance++;
	}
	if (selector.fileGlobs?.length) {
		const matches = selector.fileGlobs.some(value => matchesFileGlob(context.filePaths, value));
		dimensions.push(matches);
		if (matches) relevance++;
	}
	if (selector.languages?.length) {
		const matches = selector.languages.some(value => context.languages.has(normalizeMatchText(value)));
		dimensions.push(matches);
		if (matches) relevance++;
	}
	if (selector.riskClasses?.length) {
		const matches = selector.riskClasses.some(value => promptMatchesValue(context.normalizedPrompt, value));
		dimensions.push(matches);
		if (matches) relevance++;
	}
	return { matches: dimensions.every(Boolean), relevance };
}

function candidateAction(record: SanBrainActiveStateRecord): SanBrainAction {
	const candidate = record.candidate;
	if (isSanBrainExperienceCandidate(candidate)) return candidate.action;
	if (isSanBrainProfileCandidate(candidate)) {
		return {
			kind: "prelude_fact",
			subject: candidate.subject,
			predicate: candidate.predicate,
			value: candidate.value,
		};
	}
	throw new Error("Unsupported active Brain state.");
}

function priority(record: SanBrainActiveStateRecord, action: SanBrainAction): number {
	const candidate = record.candidate;
	if (isSanBrainProfileCandidate(candidate)) {
		switch (candidate.type) {
			case "standing_decision":
				return 600;
			case "project_decision":
				return 550;
			case "project_fact":
				return 450;
			case "user_preference":
				return 350;
			case "user_profile_fact":
				return 300;
			case "other":
				return 200;
		}
	}
	if (action.kind === "risk_rule") return 500;
	if (action.kind === "check_suggestion") return 400;
	if (action.kind === "workflow_suggestion") return 325;
	if (action.kind === "skill_reference") return 300;
	if (action.kind === "recall_policy") return 250;
	return 200;
}

function actionSearchText(action: SanBrainAction): string {
	switch (action.kind) {
		case "prelude_fact":
			return `${action.subject} ${action.predicate} ${action.value}`;
		case "risk_rule":
			return `${action.riskClass} ${action.requiredCheck}`;
		case "workflow_suggestion":
			return action.workflowId;
		case "skill_reference":
			return action.skillName;
		case "check_suggestion":
			return action.checkId;
		case "recall_policy":
			return action.queryTemplateId;
	}
}

function conflictsWithCurrentPrompt(promptText: string, action: SanBrainAction): boolean {
	if (isSanBrainHistorySuppressed(promptText)) return true;
	if (!NEGATION_PATTERN.test(promptText)) return false;
	const normalizedPrompt = normalizeMatchText(promptText);
	return actionSearchText(action)
		.split(/\s+/u)
		.map(normalizeMatchText)
		.filter(value => value.length >= 4)
		.some(value => normalizedPrompt.includes(value));
}

function eligibilityReason(
	record: SanBrainActiveStateRecord,
	context: ActivationMatchContext,
	minConfidence: number,
): { reason?: SanBrainActivationSkipReason; relevance: number; action?: SanBrainAction } {
	const candidate = record.candidate;
	if (!context.scopeKeys.has(sanBrainScopeKey(candidate.scope))) return { reason: "scope_mismatch", relevance: 0 };
	if (candidate.sensitivity !== "normal") return { reason: "sensitive", relevance: 0 };
	if (candidate.confidence < minConfidence) return { reason: "below_confidence", relevance: 0 };
	if (candidate.expiresAt) {
		const expiresAt = Date.parse(candidate.expiresAt);
		if (Number.isFinite(expiresAt) && expiresAt <= context.now) return { reason: "expired", relevance: 0 };
	}
	if (context.blockedClaimKeys.has(candidate.claimKey)) return { reason: "blocked_claim", relevance: 0 };
	if (isSanBrainHistorySuppressed(context.promptText)) {
		return { reason: "current_user_conflict", relevance: 0 };
	}
	const match = selectorMatch(record, context);
	if (!match.matches) {
		const selector = isSanBrainExperienceCandidate(candidate) ? candidate.selector : undefined;
		if (selector?.roles?.length && !selector.roles.includes(context.role)) {
			return { reason: "role_mismatch", relevance: 0 };
		}
		return { reason: "selector_mismatch", relevance: 0 };
	}
	const action = candidateAction(record);
	if (conflictsWithCurrentPrompt(context.promptText, action)) {
		return { reason: "current_user_conflict", relevance: 0 };
	}
	return { relevance: match.relevance, action };
}

function sanitizeAction(action: SanBrainAction): SanBrainAction {
	switch (action.kind) {
		case "prelude_fact":
			return {
				kind: action.kind,
				subject: sanitizeRenderedText(action.subject),
				predicate: sanitizeRenderedText(action.predicate),
				value: sanitizeRenderedText(action.value),
			};
		case "risk_rule":
			return {
				kind: action.kind,
				riskClass: sanitizeRenderedText(action.riskClass),
				requiredCheck: sanitizeRenderedText(action.requiredCheck),
			};
		case "workflow_suggestion":
			return { kind: action.kind, workflowId: sanitizeRenderedText(action.workflowId) };
		case "skill_reference":
			return { kind: action.kind, skillName: sanitizeRenderedText(action.skillName) };
		case "check_suggestion":
			return { kind: action.kind, checkId: sanitizeRenderedText(action.checkId) };
		case "recall_policy":
			return { kind: action.kind, queryTemplateId: sanitizeRenderedText(action.queryTemplateId) };
	}
}

function renderedRule(rule: SanBrainSelectedActiveState): RenderedRule {
	return {
		id: rule.record.candidate.candidateId,
		decisionId: rule.record.decisionId,
		revision: rule.record.revision,
		scope: {
			kind: rule.record.candidate.scope.kind,
			key: sanitizeRenderedText(rule.record.candidate.scope.key),
		},
		action: sanitizeAction(rule.action),
	};
}

function renderStatePrelude(rules: readonly RenderedRule[]): string {
	return prompt.render(statePreludeTemplate, {
		policyVersion: BRAIN_ACTIVATION_POLICY_VERSION,
		stateJson: promptSafeJson({ rules }),
	});
}

function selectedRule(rule: SanBrainSelectedActiveState, tokenEstimate: number): SanBrainActivationSelectedRule {
	return {
		ownerId: rule.record.candidate.candidateId,
		decisionId: rule.record.decisionId,
		revision: rule.record.revision,
		kind: rule.record.kind,
		scope: rule.record.candidate.scope,
		actionKind: rule.action.kind,
		priority: rule.priority,
		relevance: rule.relevance,
		tokenEstimate,
	};
}

export function selectSanBrainActiveStates(
	activeStates: readonly SanBrainActiveStateRecord[],
	options: SelectSanBrainActiveStatesOptions,
): SanBrainActiveStateSelection {
	const minConfidence = clampProbability(options.minConfidence);
	const normalizedPrompt = normalizeMatchText(options.promptText);
	const filePaths = extractFilePaths(options.promptText);
	const context: ActivationMatchContext = {
		promptText: options.promptText,
		normalizedPrompt,
		role: options.role,
		scopeKeys: new Set(options.scopes.map(sanBrainScopeKey)),
		blockedClaimKeys: new Set(options.blockedClaimKeys ?? []),
		filePaths,
		languages: extractLanguages(options.promptText, filePaths),
		now: options.now ?? Date.now(),
	};
	const selectedStates: SanBrainSelectedActiveState[] = [];
	const skippedRules: SanBrainActivation["skippedRules"] = [];

	for (const record of activeStates) {
		const eligibility = eligibilityReason(record, context, minConfidence);
		if (eligibility.reason || !eligibility.action) {
			skippedRules.push({
				ownerId: record.candidate.candidateId,
				reason: eligibility.reason ?? "selector_mismatch",
			});
			continue;
		}
		selectedStates.push({
			record,
			action: eligibility.action,
			priority: priority(record, eligibility.action),
			relevance: eligibility.relevance,
		});
	}

	selectedStates.sort(
		(left, right) =>
			right.priority - left.priority ||
			right.relevance - left.relevance ||
			right.record.candidate.confidence - left.record.candidate.confidence ||
			right.record.updatedAt.localeCompare(left.record.updatedAt) ||
			left.record.candidate.candidateId.localeCompare(right.record.candidate.candidateId),
	);

	return {
		selectedStates,
		skippedRules,
		scopeKeys: [...context.scopeKeys].sort(),
	};
}

export function buildSanBrainStatePrelude(
	activeStates: readonly SanBrainActiveStateRecord[],
	options: BuildSanBrainStatePreludeOptions,
): BuiltSanBrainStatePrelude {
	const maxItems = clampNonNegativeInteger(options.maxItems);
	const maxTokens = clampNonNegativeInteger(options.maxTokens);
	const instructionStates = activeStates.filter(
		record => !(isSanBrainExperienceCandidate(record.candidate) && record.candidate.action.kind === "recall_policy"),
	);
	const selection = selectSanBrainActiveStates(instructionStates, {
		role: options.role,
		scopes: options.scopes,
		promptText: options.promptText,
		minConfidence: options.minConfidence,
		blockedClaimKeys: options.blockedClaimKeys,
	});
	const skippedRules = [...selection.skippedRules];

	const renderedRules: RenderedRule[] = [];
	const selectedRules: SanBrainActivationSelectedRule[] = [];
	let content: string | undefined;
	let tokenEstimate = 0;
	let trimReason: SanBrainActivation["trimReason"];
	for (const rule of selection.selectedStates) {
		if (renderedRules.length >= maxItems) {
			skippedRules.push({ ownerId: rule.record.candidate.candidateId, reason: "item_limit" });
			trimReason ??= "item_limit";
			continue;
		}
		const nextRules = [...renderedRules, renderedRule(rule)];
		const nextContent = renderStatePrelude(nextRules);
		const nextTokenEstimate = estimateSanBrainInjectionTokens(nextContent);
		if (nextTokenEstimate > maxTokens) {
			skippedRules.push({ ownerId: rule.record.candidate.candidateId, reason: "token_budget" });
			trimReason = "token_budget";
			continue;
		}
		renderedRules.push(nextRules.at(-1)!);
		selectedRules.push(selectedRule(rule, Math.max(0, nextTokenEstimate - tokenEstimate)));
		content = nextContent;
		tokenEstimate = nextTokenEstimate;
	}

	const createdAt = options.createdAt ?? new Date().toISOString();
	return {
		...(content ? { content } : {}),
		activation: {
			schemaVersion: BRAIN_SCHEMA_VERSION,
			activationId: options.activationId ?? `brain_activation_${Bun.randomUUIDv7()}`,
			sessionId: options.sessionId,
			turnId: options.turnId,
			role: options.role,
			scopeKeys: selection.scopeKeys,
			selectedRules,
			skippedRules,
			tokenEstimate,
			tokenBudget: maxTokens,
			globalTokenEstimate: 0,
			globalTokenBudget: 0,
			sourceBudgets: [],
			...(trimReason ? { trimReason } : {}),
			policyVersion: BRAIN_ACTIVATION_POLICY_VERSION,
			renderedHash: Bun.hash(content ?? "").toString(36),
			createdAt,
		},
	};
}

function sourcePriority(source: SanBrainInjectionSource): number {
	switch (source) {
		case "san_loop":
			return 3;
		case "brain":
			return 2;
		case "context_packet":
			return 1;
	}
}

export function planSanBrainGlobalInjection(
	candidates: readonly SanBrainInjectionCandidate[],
	maxTokens: number,
): SanBrainInjectionPlan {
	const tokenBudget = clampNonNegativeInteger(maxTokens);
	const includedSources: SanBrainInjectionSource[] = [];
	const sourceBudgets: SanBrainActivationSourceBudget[] = [];
	let tokenEstimate = 0;
	for (const candidate of [...candidates].sort(
		(left, right) => sourcePriority(right.source) - sourcePriority(left.source),
	)) {
		const sourceTokens =
			candidate.tokenEstimate === undefined
				? estimateSanBrainInjectionTokens(candidate.content ?? "")
				: clampNonNegativeInteger(candidate.tokenEstimate);
		const included = tokenEstimate + sourceTokens <= tokenBudget;
		sourceBudgets.push({
			source: candidate.source,
			tokenEstimate: sourceTokens,
			included,
			...(included ? {} : { reason: "global_token_budget" as const }),
		});
		if (!included) continue;
		includedSources.push(candidate.source);
		tokenEstimate += sourceTokens;
	}
	return { includedSources, sourceBudgets, tokenEstimate, tokenBudget };
}

export function finalizeSanBrainActivation(
	activation: SanBrainActivation,
	plan: SanBrainInjectionPlan,
): SanBrainActivation {
	const brainBudget = plan.sourceBudgets.find(source => source.source === "brain");
	if (brainBudget && !brainBudget.included && activation.selectedRules.length > 0) {
		return {
			...activation,
			selectedRules: [],
			skippedRules: [
				...activation.skippedRules,
				...activation.selectedRules.map(rule => ({
					ownerId: rule.ownerId,
					reason: "global_token_budget" as const,
				})),
			],
			tokenEstimate: 0,
			globalTokenEstimate: plan.tokenEstimate,
			globalTokenBudget: plan.tokenBudget,
			sourceBudgets: plan.sourceBudgets,
			trimReason: "global_token_budget",
			renderedHash: Bun.hash("").toString(36),
		};
	}
	return {
		...activation,
		globalTokenEstimate: plan.tokenEstimate,
		globalTokenBudget: plan.tokenBudget,
		sourceBudgets: plan.sourceBudgets,
	};
}

export function recordSanBrainActivationError(
	sessionManager: ReadonlySessionManager,
	options: { sessionId: string; turnId: string; message: string },
): string {
	return sessionManager.appendCustomEntry(BRAIN_ERROR_CUSTOM_TYPE, {
		schemaVersion: BRAIN_SCHEMA_VERSION,
		errorId: `brain_error_${Bun.randomUUIDv7()}`,
		phase: "activation",
		sessionId: options.sessionId,
		turnId: options.turnId,
		message: options.message,
		createdAt: new Date().toISOString(),
	});
}
