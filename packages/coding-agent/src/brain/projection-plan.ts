import type {
	SanBrainCandidate,
	SanBrainDecision,
	SanBrainExperienceCandidate,
	SanBrainProjectionTarget,
} from "./types";

export interface SanBrainProjectionPlan {
	projectionId: string;
	target: SanBrainProjectionTarget;
}

function experienceProjectionTarget(candidate: SanBrainExperienceCandidate): SanBrainProjectionTarget | undefined {
	if (
		candidate.type === "skill_candidate" &&
		candidate.action.kind === "skill_reference" &&
		candidate.action.description?.trim() &&
		candidate.action.body?.trim()
	) {
		return "managed_skill";
	}
	if (
		candidate.type === "check_candidate" &&
		candidate.action.kind === "check_suggestion" &&
		candidate.action.body?.trim()
	) {
		return "check_suggestion";
	}
	return undefined;
}

export function getSanBrainProjectionTarget(candidate: SanBrainCandidate): SanBrainProjectionTarget | undefined {
	if ("subject" in candidate) return candidate.sensitivity === "normal" ? "memory" : undefined;
	return experienceProjectionTarget(candidate);
}

export function buildSanBrainProjectionPlans(
	candidate: SanBrainCandidate,
	decision: Pick<SanBrainDecision, "decisionId" | "action">,
): SanBrainProjectionPlan[] {
	if (decision.action !== "approve" && decision.action !== "undo") return [];
	const target = getSanBrainProjectionTarget(candidate);
	if (!target) return [];
	const projectionId = `brain-projection-${Bun.hash(`${decision.decisionId}\0${target}`).toString(36)}`;
	return [{ projectionId, target }];
}
