import { extractExplicitUserMemoryDirective } from "../context-steady/memory-authorization";
import { isAuthoritativeUserMessage } from "../context-steady/session";
import type { TurnDigest, TurnDigestMemoryCandidate } from "../context-steady/types";
import type { SessionEntry } from "../session/session-entries";
import { buildSanBrainEvidenceRef } from "./evidence";
import type {
	SanBrainCandidate,
	SanBrainEvidenceSourceMode,
	SanBrainExperienceCandidate,
	SanBrainProfileCandidate,
	SanBrainProfileCandidateType,
	SanBrainScope,
	SanBrainSensitivity,
} from "./types";

const FAILURE_PATTERN = /\b(error|failed|failure|timed out|timeout)\b|错误|失败|超时/iu;
const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/\b(?:ghp|github_pat|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/u,
	/\bsk-[A-Za-z0-9_-]{16,}\b/u,
	/\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?key|secret|token)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
];
const SENSITIVE_PATTERNS: readonly RegExp[] = [
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
	/\b(?:\+?\d[\d ()-]{7,}\d)\b/u,
	/\b(?:passport|social security|ssn|medical|diagnosis|salary|bank account|credit card)\b/iu,
	/(护照|身份证|手机号|家庭住址|病历|诊断|薪资|银行账户|银行卡)/u,
];

export function classifySanBrainSensitivity(value: string): SanBrainSensitivity {
	if (SECRET_PATTERNS.some(pattern => pattern.test(value))) return "secret";
	if (SENSITIVE_PATTERNS.some(pattern => pattern.test(value))) return "sensitive";
	return "normal";
}

export interface SanBrainExtractOptions {
	digest: TurnDigest;
	digestEntryId?: string;
	entries: readonly SessionEntry[];
	sourceMode: SanBrainEvidenceSourceMode;
	maxCandidates: number;
	minConfidence: number;
	userScope?: SanBrainScope;
	fallbackScope?: SanBrainScope;
}

export interface SanBrainExtractResult {
	profileCandidates: SanBrainProfileCandidate[];
	experienceCandidates: SanBrainExperienceCandidate[];
}

function normalizedText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function entryText(entry: SessionEntry): string {
	if (entry.type === "message") {
		if (!isAuthoritativeUserMessage(entry.message) || entry.message.role !== "user") return "";
		if (typeof entry.message.content === "string") return entry.message.content;
		return entry.message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map(content => content.text)
			.join(" ");
	}
	if (entry.type !== "custom_message" || entry.attribution !== "user") return "";
	if (typeof entry.content === "string") return entry.content;
	return entry.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join(" ");
}

function explicitUserPreference(options: SanBrainExtractOptions): string | undefined {
	const fromIndex = options.entries.findIndex(entry => entry.id === options.digest.source.fromEntryId);
	const toIndex = options.entries.findIndex(entry => entry.id === options.digest.source.toEntryId);
	if (fromIndex < 0 || toIndex < fromIndex) return undefined;
	for (const entry of options.entries.slice(fromIndex, toIndex + 1)) {
		const directive = extractExplicitUserMemoryDirective(entryText(entry));
		if (directive) return normalizedText(directive);
	}
	return undefined;
}

function stableHash(value: string): string {
	return Bun.hash(value).toString(36);
}

function clampProbability(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function profileType(candidate: TurnDigestMemoryCandidate): SanBrainProfileCandidateType {
	switch (candidate.type) {
		case "preference":
			return "user_preference";
		case "project_fact":
			return "project_fact";
		case "decision":
			return "standing_decision";
		default:
			return "other";
	}
}

function profileScope(candidate: TurnDigestMemoryCandidate, options: SanBrainExtractOptions): SanBrainScope {
	if (candidate.type === "preference") {
		return options.userScope ?? { kind: "user", key: "user:local", resolverVersion: 1 };
	}
	return (
		options.fallbackScope ?? {
			kind: "session",
			key: options.digest.sessionId,
			resolverVersion: 1,
		}
	);
}

function topic(value: string): string {
	const separatorIndex = value.search(/[:：=]/u);
	if (separatorIndex > 0 && separatorIndex <= 80) return value.slice(0, separatorIndex).trim();
	return value.slice(0, 80);
}

function createProfileCandidate(
	memory: TurnDigestMemoryCandidate,
	options: SanBrainExtractOptions,
	explicitPreference?: string,
): SanBrainProfileCandidate | undefined {
	const summarizedValue = normalizedText(memory.content);
	const authorizedValue = memory.type === "preference" ? explicitPreference : undefined;
	const value = authorizedValue ?? summarizedValue;
	const sensitivity = classifySanBrainSensitivity(value);
	const confidence = clampProbability(memory.importance);
	if (!value || sensitivity === "secret" || confidence < options.minConfidence) return undefined;
	const scope = profileScope(memory, options);
	const type = profileType(memory);
	const subject = topic(value);
	const predicate = memory.type === "preference" ? "preference" : memory.type;
	const claimKey = `profile:${scope.kind}:${stableHash(scope.key)}:${type}:${stableHash(`${subject}\0${predicate}`)}`;
	const dedupeKey = `${claimKey}:${stableHash(value)}`;
	const evidence = buildSanBrainEvidenceRef(options);

	return {
		schemaVersion: 1,
		candidateId: `brain_profile_${stableHash(`${options.digest.source.fromEntryId}\0${dedupeKey}`)}`,
		scope,
		type,
		authorization: authorizedValue ? "explicit_user" : "inferred",
		subject,
		predicate,
		value,
		claimKey,
		dedupeKey,
		taskTags: [],
		confidence,
		importance: confidence,
		independentEvidenceCount: evidence.loopRefs.length > 0 ? 2 : 1,
		sensitivity,
		evidence: [evidence],
		createdAt: options.digest.createdAt,
	};
}

function createWorkflowCandidate(
	memory: TurnDigestMemoryCandidate,
	options: SanBrainExtractOptions,
): SanBrainExperienceCandidate | undefined {
	if (memory.type !== "workflow") return undefined;
	const content = normalizedText(memory.content);
	const sensitivity = classifySanBrainSensitivity(content);
	const confidence = clampProbability(memory.importance);
	if (!content || sensitivity === "secret" || confidence < options.minConfidence) return undefined;
	const scope = options.fallbackScope ?? {
		kind: "session",
		key: options.digest.sessionId,
		resolverVersion: 1,
	};
	const workflowId = `captured-${stableHash(content)}`;
	const claimKey = `experience:${scope.kind}:${stableHash(scope.key)}:workflow:${workflowId}`;
	const dedupeKey = `${claimKey}:${stableHash(content)}`;

	return {
		schemaVersion: 1,
		candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${dedupeKey}`)}`,
		scope,
		type: "workflow_pattern",
		authorization: "inferred",
		selector: {},
		action: { kind: "workflow_suggestion", workflowId },
		taskTags: [],
		claimKey,
		dedupeKey,
		conflictKey: claimKey,
		repeatCount: 1,
		confidence,
		impact: "low",
		sensitivity,
		evidence: [buildSanBrainEvidenceRef(options)],
		createdAt: options.digest.createdAt,
	};
}

function createWorkflowSkillCandidate(
	memory: TurnDigestMemoryCandidate,
	options: SanBrainExtractOptions,
): SanBrainExperienceCandidate | undefined {
	if (memory.type !== "workflow") return undefined;
	const content = normalizedText(memory.content);
	const sensitivity = classifySanBrainSensitivity(content);
	const confidence = clampProbability(memory.importance);
	if (!content || sensitivity === "secret" || confidence < options.minConfidence) return undefined;
	const scope = options.fallbackScope ?? {
		kind: "session",
		key: options.digest.sessionId,
		resolverVersion: 1,
	};
	const skillName = `captured-workflow-${stableHash(content)}`;
	const claimKey = `experience:${scope.kind}:${stableHash(scope.key)}:skill:${skillName}`;
	const dedupeKey = `${claimKey}:${stableHash(content)}`;
	return {
		schemaVersion: 1,
		candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${dedupeKey}`)}`,
		scope,
		type: "skill_candidate",
		authorization: "inferred",
		selector: {},
		action: {
			kind: "skill_reference",
			skillName,
			description: content.slice(0, 160),
			body: content,
			action: "create",
		},
		taskTags: [],
		claimKey,
		dedupeKey,
		conflictKey: claimKey,
		repeatCount: 1,
		confidence,
		impact: "low",
		sensitivity,
		evidence: [buildSanBrainEvidenceRef(options)],
		createdAt: options.digest.createdAt,
	};
}

function createToolFailureCandidates(options: SanBrainExtractOptions): SanBrainExperienceCandidate[] {
	const scope = options.fallbackScope ?? {
		kind: "session",
		key: options.digest.sessionId,
		resolverVersion: 1,
	};
	const candidates: SanBrainExperienceCandidate[] = [];
	for (const tool of options.digest.toolEvidence) {
		const summary = normalizedText(tool.summary);
		if (!FAILURE_PATTERN.test(summary)) continue;
		const requiredCheck = summary.slice(0, 240);
		const sensitivity = classifySanBrainSensitivity(requiredCheck);
		if (sensitivity === "secret") continue;
		const riskClass = `tool:${tool.tool}`;
		const claimKey = `experience:${scope.kind}:${stableHash(scope.key)}:failure:${stableHash(riskClass)}`;
		const dedupeKey = `${claimKey}:${stableHash(requiredCheck)}`;
		candidates.push({
			schemaVersion: 1,
			candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${dedupeKey}`)}`,
			scope,
			type: "failure_posture",
			authorization: "inferred",
			selector: { commands: [tool.tool] },
			action: { kind: "risk_rule", riskClass, requiredCheck },
			taskTags: [tool.tool],
			claimKey,
			dedupeKey,
			conflictKey: claimKey,
			repeatCount: 1,
			confidence: 0.85,
			impact: "medium",
			sensitivity,
			evidence: [buildSanBrainEvidenceRef(options)],
			createdAt: options.digest.createdAt,
		});
		const checkId =
			`tool-${tool.tool.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${stableHash(requiredCheck)}`.slice(0, 64);
		const checkClaimKey = `experience:${scope.kind}:${stableHash(scope.key)}:check:${checkId}`;
		candidates.push({
			schemaVersion: 1,
			candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${checkClaimKey}`)}`,
			scope,
			type: "check_candidate",
			selector: { commands: [tool.tool] },
			authorization: "inferred",
			action: {
				kind: "check_suggestion",
				checkId,
				title: `Verify ${tool.tool} failures`,
				severity: "error",
				body: requiredCheck,
			},
			taskTags: [tool.tool],
			claimKey: checkClaimKey,
			dedupeKey: `${checkClaimKey}:${stableHash(requiredCheck)}`,
			conflictKey: checkClaimKey,
			repeatCount: 1,
			confidence: 0.85,
			impact: "medium",
			sensitivity,
			evidence: [buildSanBrainEvidenceRef(options)],
			createdAt: options.digest.createdAt,
		});
		const recallClaimKey = `experience:${scope.kind}:${stableHash(scope.key)}:recall:${stableHash(riskClass)}`;
		candidates.push({
			schemaVersion: 1,
			candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${recallClaimKey}`)}`,
			scope,
			type: "recall",
			selector: { commands: [tool.tool] },
			authorization: "inferred",
			action: { kind: "recall_policy", queryTemplateId: "risk-history-v1" },
			taskTags: [tool.tool],
			claimKey: recallClaimKey,
			dedupeKey: `${recallClaimKey}:risk-history-v1`,
			conflictKey: recallClaimKey,
			repeatCount: 1,
			confidence: 0.85,
			impact: "medium",
			sensitivity,
			evidence: [buildSanBrainEvidenceRef(options)],
			createdAt: options.digest.createdAt,
		});
	}
	return candidates;
}

export function extractSanBrainCandidates(options: SanBrainExtractOptions): SanBrainExtractResult {
	const limit = Math.max(0, Math.trunc(options.maxCandidates));
	if (limit === 0) return { profileCandidates: [], experienceCandidates: [] };
	const explicitPreference = explicitUserPreference(options);
	const candidates: SanBrainCandidate[] = [];
	const dedupeKeys = new Set<string>();
	const add = (candidate: SanBrainCandidate | undefined) => {
		if (!candidate || candidates.length >= limit || dedupeKeys.has(candidate.dedupeKey)) return;
		dedupeKeys.add(candidate.dedupeKey);
		candidates.push(candidate);
	};
	if (explicitPreference) {
		add(
			createProfileCandidate(
				{ content: explicitPreference, type: "preference", importance: 1, authorization: "explicit_user" },
				options,
				explicitPreference,
			),
		);
	}

	for (const memory of options.digest.memoryCandidates) {
		if (memory.type === "preference" && explicitPreference) continue;
		if (memory.type === "workflow") {
			add(createWorkflowCandidate(memory, options));
			add(createWorkflowSkillCandidate(memory, options));
		} else add(createProfileCandidate(memory, options));
	}
	for (const candidate of createToolFailureCandidates(options)) add(candidate);

	return {
		profileCandidates: candidates.filter(
			(candidate): candidate is SanBrainProfileCandidate => "subject" in candidate,
		),
		experienceCandidates: candidates.filter(
			(candidate): candidate is SanBrainExperienceCandidate => "selector" in candidate,
		),
	};
}
