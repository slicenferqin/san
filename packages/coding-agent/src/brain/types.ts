export const BRAIN_SCHEMA_VERSION = 1 as const;

export const BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE = "san.brain.profile_candidate";
export const BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE = "san.brain.experience_candidate";
export const BRAIN_DECISION_CUSTOM_TYPE = "san.brain.decision";
export const BRAIN_PROJECTION_CUSTOM_TYPE = "san.brain.projection";
export const BRAIN_ACTIVATION_CUSTOM_TYPE = "san.brain.activation";
export const BRAIN_ERROR_CUSTOM_TYPE = "san.brain.error";

export const BRAIN_CUSTOM_TYPES = [
	BRAIN_PROFILE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_EXPERIENCE_CANDIDATE_CUSTOM_TYPE,
	BRAIN_DECISION_CUSTOM_TYPE,
	BRAIN_PROJECTION_CUSTOM_TYPE,
	BRAIN_ACTIVATION_CUSTOM_TYPE,
	BRAIN_ERROR_CUSTOM_TYPE,
] as const;

export type SanBrainCandidateKind = "profile" | "experience";
export type SanBrainScopeKind = "user" | "repo" | "project" | "session";
export type SanBrainSensitivity = "normal" | "sensitive" | "secret";

export interface SanBrainScope {
	kind: SanBrainScopeKind;
	key: string;
	resolverVersion: typeof BRAIN_SCHEMA_VERSION;
}

export interface SanBrainLoopEvidenceRef {
	runId: string;
	assignmentId: string;
	attemptId: string;
	reviewId?: string;
	accepted: boolean;
}

export type SanBrainEvidenceSourceMode = "turn_digest" | "turn_digest_unpersisted" | "message_span_fallback";

export interface SanBrainEvidenceRef {
	sessionId: string;
	sourceMode: SanBrainEvidenceSourceMode;
	entryIds: string[];
	digestEntryIds: string[];
	loopRefs: SanBrainLoopEvidenceRef[];
	fileRefs: Array<{ path: string; range?: string; contentHash?: string }>;
	toolCallIds: string[];
	summary: string;
}

export type SanBrainProfileCandidateType =
	| "user_preference"
	| "user_profile_fact"
	| "standing_decision"
	| "project_fact"
	| "project_decision"
	| "other";

export interface SanBrainProfileCandidate {
	schemaVersion: typeof BRAIN_SCHEMA_VERSION;
	candidateId: string;
	scope: SanBrainScope;
	type: SanBrainProfileCandidateType;
	subject: string;
	predicate: string;
	value: string;
	claimKey: string;
	dedupeKey: string;
	taskTags: string[];
	confidence: number;
	importance: number;
	independentEvidenceCount: number;
	sensitivity: SanBrainSensitivity;
	expiresAt?: string;
	evidence: SanBrainEvidenceRef[];
	createdAt: string;
}

export interface SanBrainTriggerSelector {
	taskFamilies?: string[];
	commands?: string[];
	fileGlobs?: string[];
	languages?: string[];
	roles?: Array<"primary" | "commander" | "worker" | "supervisor" | "oracle">;
	riskClasses?: string[];
}

export type SanBrainCheckSeverity = "info" | "warning" | "error" | "blocker";

export type SanBrainAction =
	| { kind: "prelude_fact"; subject: string; predicate: string; value: string }
	| { kind: "risk_rule"; riskClass: string; requiredCheck: string }
	| { kind: "workflow_suggestion"; workflowId: string }
	| {
			kind: "skill_reference";
			skillName: string;
			description?: string;
			body?: string;
			action?: "create" | "update";
			expectedHash?: string;
	  }
	| {
			kind: "check_suggestion";
			checkId: string;
			title?: string;
			severity?: SanBrainCheckSeverity;
			body?: string;
	  }
	| { kind: "recall_policy"; queryTemplateId: string };

export type SanBrainExperienceCandidateType =
	| "workflow_pattern"
	| "failure_posture"
	| "skill_candidate"
	| "check_candidate"
	| "recall"
	| "do_not_retain"
	| "other";

export interface SanBrainExperienceCandidate {
	schemaVersion: typeof BRAIN_SCHEMA_VERSION;
	candidateId: string;
	scope: SanBrainScope;
	type: SanBrainExperienceCandidateType;
	selector: SanBrainTriggerSelector;
	action: SanBrainAction;
	taskTags: string[];
	claimKey: string;
	dedupeKey: string;
	conflictKey: string;
	repeatCount: number;
	confidence: number;
	impact: "low" | "medium" | "high";
	sensitivity: SanBrainSensitivity;
	expiresAt?: string;
	evidence: SanBrainEvidenceRef[];
	createdAt: string;
}

export type SanBrainCandidate = SanBrainProfileCandidate | SanBrainExperienceCandidate;

export type SanBrainDecisionAction =
	| "approve"
	| "discard"
	| "supersede"
	| "undo"
	| "reduce_scope"
	| "reduce_confidence";

export interface SanBrainDecision {
	schemaVersion: typeof BRAIN_SCHEMA_VERSION;
	decisionId: string;
	ownerType: "profile_candidate" | "experience_candidate";
	ownerId: string;
	action: SanBrainDecisionAction;
	previousRevision?: number;
	nextRevision: number;
	requestedBy: "user" | "policy" | "migration";
	reason: string;
	policyVersion: string;
	idempotencyKey: string;
	projectionIds: string[];
	createdAt: string;
}

export type SanBrainProjectionTarget = "memory" | "managed_skill" | "check_suggestion";
export type SanBrainProjectionState =
	| "pending"
	| "applying"
	| "applied"
	| "failed"
	| "compensating"
	| "compensated"
	| "blocked";

export interface SanBrainProjection {
	schemaVersion: typeof BRAIN_SCHEMA_VERSION;
	projectionId: string;
	decisionId: string;
	target: SanBrainProjectionTarget;
	state: SanBrainProjectionState;
	attemptCount: number;
	revision?: number;
	beforeHash?: string;
	afterHash?: string;
	error?: string;
	updatedAt: string;
}

export type SanBrainActivationRole = "primary" | "commander" | "worker" | "supervisor" | "oracle";
export type SanBrainActivationSkipReason =
	| "scope_mismatch"
	| "role_mismatch"
	| "selector_mismatch"
	| "current_user_conflict"
	| "blocked_claim"
	| "expired"
	| "below_confidence"
	| "sensitive"
	| "item_limit"
	| "token_budget"
	| "global_token_budget";
export type SanBrainInjectionSource = "san_loop" | "brain" | "context_packet";

export interface SanBrainActivationSelectedRule {
	ownerId: string;
	decisionId: string;
	revision: number;
	kind: SanBrainCandidateKind;
	scope: SanBrainScope;
	actionKind: SanBrainAction["kind"];
	priority: number;
	relevance: number;
	tokenEstimate: number;
}

export interface SanBrainActivationSkippedRule {
	ownerId: string;
	reason: SanBrainActivationSkipReason;
}

export interface SanBrainActivationSourceBudget {
	source: SanBrainInjectionSource;
	tokenEstimate: number;
	included: boolean;
	reason?: "global_token_budget";
}

export interface SanBrainActivation {
	schemaVersion: typeof BRAIN_SCHEMA_VERSION;
	activationId: string;
	sessionId: string;
	turnId: string;
	role: SanBrainActivationRole;
	scopeKeys: string[];
	selectedRules: SanBrainActivationSelectedRule[];
	skippedRules: SanBrainActivationSkippedRule[];
	tokenEstimate: number;
	tokenBudget: number;
	globalTokenEstimate: number;
	globalTokenBudget: number;
	sourceBudgets: SanBrainActivationSourceBudget[];
	trimReason?: "item_limit" | "token_budget" | "global_token_budget";
	policyVersion: string;
	renderedHash: string;
	createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isBrainScopeKind(value: unknown): value is SanBrainScopeKind {
	return value === "user" || value === "repo" || value === "project" || value === "session";
}

function isSensitivity(value: unknown): value is SanBrainSensitivity {
	return value === "normal" || value === "sensitive" || value === "secret";
}

export function isSanBrainScope(value: unknown): value is SanBrainScope {
	if (!isRecord(value)) return false;
	return isBrainScopeKind(value.kind) && isNonEmptyString(value.key) && value.resolverVersion === BRAIN_SCHEMA_VERSION;
}

function isLoopEvidenceRef(value: unknown): value is SanBrainLoopEvidenceRef {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.runId) &&
		isNonEmptyString(value.assignmentId) &&
		isNonEmptyString(value.attemptId) &&
		isOptionalString(value.reviewId) &&
		typeof value.accepted === "boolean"
	);
}

function isFileRef(value: unknown): value is SanBrainEvidenceRef["fileRefs"][number] {
	if (!isRecord(value)) return false;
	return isNonEmptyString(value.path) && isOptionalString(value.range) && isOptionalString(value.contentHash);
}

export function isSanBrainEvidenceRef(value: unknown): value is SanBrainEvidenceRef {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.sessionId) &&
		isStringArray(value.entryIds) &&
		isStringArray(value.digestEntryIds) &&
		Array.isArray(value.loopRefs) &&
		value.loopRefs.every(isLoopEvidenceRef) &&
		Array.isArray(value.fileRefs) &&
		value.fileRefs.every(isFileRef) &&
		isStringArray(value.toolCallIds) &&
		typeof value.summary === "string"
	);
}

function isEvidenceArray(value: unknown): value is SanBrainEvidenceRef[] {
	return Array.isArray(value) && value.every(isSanBrainEvidenceRef);
}

function isProfileCandidateType(value: unknown): value is SanBrainProfileCandidateType {
	return (
		value === "user_preference" ||
		value === "user_profile_fact" ||
		value === "standing_decision" ||
		value === "project_fact" ||
		value === "project_decision" ||
		value === "other"
	);
}

export function isSanBrainProfileCandidate(value: unknown): value is SanBrainProfileCandidate {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === BRAIN_SCHEMA_VERSION &&
		isNonEmptyString(value.candidateId) &&
		isSanBrainScope(value.scope) &&
		isProfileCandidateType(value.type) &&
		isNonEmptyString(value.subject) &&
		isNonEmptyString(value.predicate) &&
		isNonEmptyString(value.value) &&
		isNonEmptyString(value.claimKey) &&
		isNonEmptyString(value.dedupeKey) &&
		isStringArray(value.taskTags) &&
		isFiniteNumber(value.confidence) &&
		isFiniteNumber(value.importance) &&
		Number.isInteger(value.independentEvidenceCount) &&
		(value.independentEvidenceCount as number) >= 0 &&
		isSensitivity(value.sensitivity) &&
		isOptionalString(value.expiresAt) &&
		isEvidenceArray(value.evidence) &&
		isNonEmptyString(value.createdAt)
	);
}

function isStringArrayProperty(value: unknown): boolean {
	return value === undefined || isStringArray(value);
}

export function isSanBrainTriggerSelector(value: unknown): value is SanBrainTriggerSelector {
	if (!isRecord(value)) return false;
	return (
		isStringArrayProperty(value.taskFamilies) &&
		isStringArrayProperty(value.commands) &&
		isStringArrayProperty(value.fileGlobs) &&
		isStringArrayProperty(value.languages) &&
		isStringArrayProperty(value.roles) &&
		isStringArrayProperty(value.riskClasses)
	);
}

export function isSanBrainAction(value: unknown): value is SanBrainAction {
	if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
	switch (value.kind) {
		case "prelude_fact":
			return isNonEmptyString(value.subject) && isNonEmptyString(value.predicate) && isNonEmptyString(value.value);
		case "risk_rule":
			return isNonEmptyString(value.riskClass) && isNonEmptyString(value.requiredCheck);
		case "workflow_suggestion":
			return isNonEmptyString(value.workflowId);
		case "skill_reference":
			return (
				isNonEmptyString(value.skillName) &&
				isOptionalString(value.description) &&
				isOptionalString(value.body) &&
				(value.action === undefined || value.action === "create" || value.action === "update") &&
				isOptionalString(value.expectedHash)
			);
		case "check_suggestion":
			return (
				isNonEmptyString(value.checkId) &&
				isOptionalString(value.title) &&
				(value.severity === undefined ||
					value.severity === "info" ||
					value.severity === "warning" ||
					value.severity === "error" ||
					value.severity === "blocker") &&
				isOptionalString(value.body)
			);
		case "recall_policy":
			return isNonEmptyString(value.queryTemplateId);
		default:
			return false;
	}
}

function isExperienceCandidateType(value: unknown): value is SanBrainExperienceCandidateType {
	return (
		value === "workflow_pattern" ||
		value === "failure_posture" ||
		value === "skill_candidate" ||
		value === "check_candidate" ||
		value === "recall" ||
		value === "do_not_retain" ||
		value === "other"
	);
}

export function isSanBrainExperienceCandidate(value: unknown): value is SanBrainExperienceCandidate {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === BRAIN_SCHEMA_VERSION &&
		isNonEmptyString(value.candidateId) &&
		isSanBrainScope(value.scope) &&
		isExperienceCandidateType(value.type) &&
		isSanBrainTriggerSelector(value.selector) &&
		isSanBrainAction(value.action) &&
		isStringArray(value.taskTags) &&
		isNonEmptyString(value.claimKey) &&
		isNonEmptyString(value.dedupeKey) &&
		isNonEmptyString(value.conflictKey) &&
		Number.isInteger(value.repeatCount) &&
		(value.repeatCount as number) >= 0 &&
		isFiniteNumber(value.confidence) &&
		(value.impact === "low" || value.impact === "medium" || value.impact === "high") &&
		isSensitivity(value.sensitivity) &&
		isOptionalString(value.expiresAt) &&
		isEvidenceArray(value.evidence) &&
		isNonEmptyString(value.createdAt)
	);
}

function isDecisionAction(value: unknown): value is SanBrainDecisionAction {
	return (
		value === "approve" ||
		value === "discard" ||
		value === "supersede" ||
		value === "undo" ||
		value === "reduce_scope" ||
		value === "reduce_confidence"
	);
}

export function isSanBrainDecision(value: unknown): value is SanBrainDecision {
	if (!isRecord(value)) return false;
	const previousRevision = value.previousRevision;
	return (
		value.schemaVersion === BRAIN_SCHEMA_VERSION &&
		isNonEmptyString(value.decisionId) &&
		(value.ownerType === "profile_candidate" || value.ownerType === "experience_candidate") &&
		isNonEmptyString(value.ownerId) &&
		isDecisionAction(value.action) &&
		(previousRevision === undefined ||
			(typeof previousRevision === "number" && Number.isInteger(previousRevision) && previousRevision >= 0)) &&
		Number.isInteger(value.nextRevision) &&
		(value.nextRevision as number) > 0 &&
		(value.requestedBy === "user" || value.requestedBy === "policy" || value.requestedBy === "migration") &&
		isNonEmptyString(value.reason) &&
		isNonEmptyString(value.policyVersion) &&
		isNonEmptyString(value.idempotencyKey) &&
		isStringArray(value.projectionIds) &&
		isNonEmptyString(value.createdAt)
	);
}

function isProjectionTarget(value: unknown): value is SanBrainProjectionTarget {
	return value === "memory" || value === "managed_skill" || value === "check_suggestion";
}

function isProjectionState(value: unknown): value is SanBrainProjectionState {
	return (
		value === "pending" ||
		value === "applying" ||
		value === "applied" ||
		value === "failed" ||
		value === "compensating" ||
		value === "compensated" ||
		value === "blocked"
	);
}

export function isSanBrainProjection(value: unknown): value is SanBrainProjection {
	return (
		isRecord(value) &&
		value.schemaVersion === BRAIN_SCHEMA_VERSION &&
		isNonEmptyString(value.projectionId) &&
		isNonEmptyString(value.decisionId) &&
		isProjectionTarget(value.target) &&
		isProjectionState(value.state) &&
		Number.isInteger(value.attemptCount) &&
		(value.attemptCount as number) >= 0 &&
		(value.revision === undefined || (Number.isInteger(value.revision) && (value.revision as number) >= 0)) &&
		isOptionalString(value.beforeHash) &&
		isOptionalString(value.afterHash) &&
		isOptionalString(value.error) &&
		isNonEmptyString(value.updatedAt)
	);
}

function isActivationRole(value: unknown): value is SanBrainActivationRole {
	return (
		value === "primary" || value === "commander" || value === "worker" || value === "supervisor" || value === "oracle"
	);
}

function isActivationSkipReason(value: unknown): value is SanBrainActivationSkipReason {
	return (
		value === "scope_mismatch" ||
		value === "role_mismatch" ||
		value === "selector_mismatch" ||
		value === "current_user_conflict" ||
		value === "blocked_claim" ||
		value === "expired" ||
		value === "below_confidence" ||
		value === "sensitive" ||
		value === "item_limit" ||
		value === "token_budget" ||
		value === "global_token_budget"
	);
}

function isActivationSelectedRule(value: unknown): value is SanBrainActivationSelectedRule {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.ownerId) &&
		isNonEmptyString(value.decisionId) &&
		Number.isInteger(value.revision) &&
		(value.kind === "profile" || value.kind === "experience") &&
		isSanBrainScope(value.scope) &&
		isNonEmptyString(value.actionKind) &&
		isFiniteNumber(value.priority) &&
		isFiniteNumber(value.relevance) &&
		Number.isInteger(value.tokenEstimate) &&
		(value.tokenEstimate as number) >= 0
	);
}

function isActivationSkippedRule(value: unknown): value is SanBrainActivationSkippedRule {
	return isRecord(value) && isNonEmptyString(value.ownerId) && isActivationSkipReason(value.reason);
}

function isActivationSourceBudget(value: unknown): value is SanBrainActivationSourceBudget {
	if (!isRecord(value)) return false;
	return (
		(value.source === "san_loop" || value.source === "brain" || value.source === "context_packet") &&
		Number.isInteger(value.tokenEstimate) &&
		(value.tokenEstimate as number) >= 0 &&
		typeof value.included === "boolean" &&
		(value.reason === undefined || value.reason === "global_token_budget")
	);
}

export function isSanBrainActivation(value: unknown): value is SanBrainActivation {
	if (!isRecord(value)) return false;
	return (
		value.schemaVersion === BRAIN_SCHEMA_VERSION &&
		isNonEmptyString(value.activationId) &&
		isNonEmptyString(value.sessionId) &&
		isNonEmptyString(value.turnId) &&
		isActivationRole(value.role) &&
		isStringArray(value.scopeKeys) &&
		Array.isArray(value.selectedRules) &&
		value.selectedRules.every(isActivationSelectedRule) &&
		Array.isArray(value.skippedRules) &&
		value.skippedRules.every(isActivationSkippedRule) &&
		Number.isInteger(value.tokenEstimate) &&
		(value.tokenEstimate as number) >= 0 &&
		Number.isInteger(value.tokenBudget) &&
		(value.tokenBudget as number) >= 0 &&
		Number.isInteger(value.globalTokenEstimate) &&
		(value.globalTokenEstimate as number) >= 0 &&
		Number.isInteger(value.globalTokenBudget) &&
		(value.globalTokenBudget as number) >= 0 &&
		Array.isArray(value.sourceBudgets) &&
		value.sourceBudgets.every(isActivationSourceBudget) &&
		(value.trimReason === undefined ||
			value.trimReason === "item_limit" ||
			value.trimReason === "token_budget" ||
			value.trimReason === "global_token_budget") &&
		isNonEmptyString(value.policyVersion) &&
		isNonEmptyString(value.renderedHash) &&
		isNonEmptyString(value.createdAt)
	);
}

export function summarizeSanBrainCandidate(kind: SanBrainCandidateKind, candidate: SanBrainCandidate): string {
	if (kind === "profile" && isSanBrainProfileCandidate(candidate)) {
		return `${candidate.subject} ${candidate.predicate} ${candidate.value}`;
	}
	if (kind === "experience" && isSanBrainExperienceCandidate(candidate)) {
		switch (candidate.action.kind) {
			case "prelude_fact":
				return `${candidate.action.subject} ${candidate.action.predicate} ${candidate.action.value}`;
			case "risk_rule":
				return `${candidate.action.riskClass}: ${candidate.action.requiredCheck}`;
			case "workflow_suggestion":
				return `workflow ${candidate.action.workflowId}`;
			case "skill_reference":
				return `skill ${candidate.action.skillName}`;
			case "check_suggestion":
				return `check ${candidate.action.checkId}`;
			case "recall_policy":
				return `recall ${candidate.action.queryTemplateId}`;
		}
	}
	return "Unsupported Brain candidate";
}
