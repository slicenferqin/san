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
} from "./types";

const FAILURE_PATTERN = /\b(error|failed|failure|timed out|timeout)\b|错误|失败|超时/iu;

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
): SanBrainProfileCandidate | undefined {
	const value = normalizedText(memory.content);
	const confidence = clampProbability(memory.importance);
	if (!value || confidence < options.minConfidence) return undefined;
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
		subject,
		predicate,
		value,
		claimKey,
		dedupeKey,
		taskTags: [],
		confidence,
		importance: confidence,
		independentEvidenceCount: evidence.loopRefs.length > 0 ? 2 : 1,
		sensitivity: "normal",
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
	const confidence = clampProbability(memory.importance);
	if (!content || confidence < options.minConfidence) return undefined;
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
		selector: {},
		action: { kind: "workflow_suggestion", workflowId },
		taskTags: [],
		claimKey,
		dedupeKey,
		conflictKey: claimKey,
		repeatCount: 1,
		confidence,
		impact: "low",
		sensitivity: "normal",
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
		const riskClass = `tool:${tool.tool}`;
		const claimKey = `experience:${scope.kind}:${stableHash(scope.key)}:failure:${stableHash(riskClass)}`;
		const dedupeKey = `${claimKey}:${stableHash(requiredCheck)}`;
		candidates.push({
			schemaVersion: 1,
			candidateId: `brain_experience_${stableHash(`${options.digest.source.fromEntryId}\0${dedupeKey}`)}`,
			scope,
			type: "failure_posture",
			selector: { commands: [tool.tool], riskClasses: [riskClass] },
			action: { kind: "risk_rule", riskClass, requiredCheck },
			taskTags: [tool.tool],
			claimKey,
			dedupeKey,
			conflictKey: claimKey,
			repeatCount: 1,
			confidence: 0.85,
			impact: "medium",
			sensitivity: "normal",
			evidence: [buildSanBrainEvidenceRef(options)],
			createdAt: options.digest.createdAt,
		});
	}
	return candidates;
}

export function extractSanBrainCandidates(options: SanBrainExtractOptions): SanBrainExtractResult {
	const limit = Math.max(0, Math.trunc(options.maxCandidates));
	if (limit === 0) return { profileCandidates: [], experienceCandidates: [] };
	const candidates: SanBrainCandidate[] = [];
	const dedupeKeys = new Set<string>();
	const add = (candidate: SanBrainCandidate | undefined) => {
		if (!candidate || candidates.length >= limit || dedupeKeys.has(candidate.dedupeKey)) return;
		dedupeKeys.add(candidate.dedupeKey);
		candidates.push(candidate);
	};

	for (const memory of options.digest.memoryCandidates) {
		if (memory.type === "workflow") add(createWorkflowCandidate(memory, options));
		else add(createProfileCandidate(memory, options));
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
