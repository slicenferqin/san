import { prompt } from "@san/utils";
import fallbackTemplate from "../prompts/context-steady/compaction-summary-fallback.md" with { type: "text" };
import repairInstructions from "../prompts/context-steady/compaction-summary-repair.md" with { type: "text" };
import type { ActiveContinuationState, ContextSummaryAuthorityAudit, ContextSummarySource } from "./types";

const GOAL_HEADING_RE = /^\s{0,3}#{1,6}\s+goal\s*:?[ \t]*$/i;
const MUTATION_CLAIM_RE =
	/(?:已|已经|成功)(?:创建|修改|更新|编辑|删除|写入|新增|实现|修复)|(?:创建|修改|更新|编辑|删除|写入|新增|实现|修复)(?:完成|成功)|\b(?:created|modified|updated|edited|deleted|wrote|added|implemented|fixed)\b|\b(?:implementation|fix|work)\s+(?:is\s+)?complete\b/i;
const VERIFICATION_CLAIM_RE =
	/(?:测试|检查|构建|校验).{0,48}(?:通过|成功)|(?:通过|成功).{0,48}(?:测试|检查|构建|校验)|\b(?:tests?|checks?|builds?)\b.{0,48}\b(?:passed|succeeded|successful)\b|\b(?:passed|succeeded|successful)\b.{0,48}\b(?:tests?|checks?|builds?)\b/i;
const NON_AUTHORITATIVE_CLAIM_RE =
	/(?:未验证|未经验证|无法确认|尚未|没有|并未|未曾|声称|报告称|缺少|无证据|reported but unverified|unverified|unsupported|not verified|did not|has not|have not|no mutation|no verification|without evidence|claimed|reported|none)/i;
const CLAIM_PATH_RE = /(?:^|[\s`"'(])((?:\.{0,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g;
const CLAIM_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|pytest|vitest|jest|cargo|go|mvn|gradle)\b[^\n`]+/gi;

export const COMPACTION_SUMMARY_REPAIR_INSTRUCTIONS = repairInstructions;

export interface ContextSummaryInspection {
	forbiddenGoalField: boolean;
	executionClaimConflictCount: number;
}

function inspectableLines(summary: string): Array<{ line: string; section: string }> {
	const lines: Array<{ line: string; section: string }> = [];
	let fence: "```" | "~~~" | undefined;
	let section = "";
	for (const line of summary.replace(/\r\n/g, "\n").split("\n")) {
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] as "```" | "~~~";
			fence = fence === marker ? undefined : (fence ?? marker);
			continue;
		}
		if (fence || /^\s{4}/.test(line) || /^\s*>/.test(line)) continue;
		const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) section = heading[1]?.trim() ?? "";
		lines.push({ line, section });
	}
	return lines;
}

/** 检查摘要是否试图定义当前 Goal，或在缺少工具证据时生成执行完成事实。 */
export function inspectContextSummary(
	summary: string,
	state: ActiveContinuationState | undefined,
): ContextSummaryInspection {
	const lines = inspectableLines(summary);
	const forbiddenGoalField = lines.some(({ line }) => GOAL_HEADING_RE.test(line));
	if (!state) return { forbiddenGoalField, executionClaimConflictCount: 0 };

	const hasMutation = state.executionEvidence.successfulMutations.length > 0;
	const hasVerification = state.executionEvidence.successfulVerifications.length > 0;
	const mutationPaths = state.executionEvidence.successfulMutations
		.flatMap(item => [item.path, item.resource])
		.filter((value): value is string => typeof value === "string");
	const verificationPaths = state.executionEvidence.successfulVerifications
		.flatMap(item => [item.path, item.resource])
		.filter((value): value is string => typeof value === "string");
	const verificationCommands = state.executionEvidence.successfulVerifications
		.map(item => item.command)
		.filter((value): value is string => typeof value === "string");
	const claimPaths = (line: string): string[] =>
		[...line.matchAll(CLAIM_PATH_RE)].map(match => match[1]).filter(Boolean);
	const claimCommands = (line: string): string[] => [...line.matchAll(CLAIM_COMMAND_RE)].map(match => match[0].trim());
	const pathMatches = (claim: string, evidence: readonly string[]): boolean =>
		evidence.some(item => item === claim || item.endsWith(claim) || claim.endsWith(item));
	const commandMatches = (claim: string, command: string): boolean => {
		const normalizedClaim = claim.replace(/\s+/g, " ").trim();
		const normalizedCommand = command.replace(/\s+/g, " ").trim();
		if (normalizedClaim === normalizedCommand) return true;
		if (!normalizedClaim.startsWith(normalizedCommand)) return false;
		const suffix = normalizedClaim.slice(normalizedCommand.length).trim();
		return /^(?:(?:passed|succeeded|successful)(?:\s+successfully)?|通过|成功)[.!。]?$/i.test(suffix);
	};
	const matchesEvidence = (claims: readonly string[], evidence: readonly string[]): boolean =>
		claims.every(claim => pathMatches(claim, evidence));
	const matchesCommandEvidence = (claims: readonly string[]): boolean =>
		claims.every(claim => verificationCommands.some(command => commandMatches(claim, command)));
	const matchesVerificationPaths = (paths: readonly string[], commands: readonly string[]): boolean =>
		paths.every(
			claimPath =>
				pathMatches(claimPath, verificationPaths) ||
				commands.some(claimCommand =>
					verificationCommands.some(
						command =>
							commandMatches(claimCommand, command) &&
							claimCommand.includes(claimPath) &&
							command.includes(claimPath),
					),
				),
		);
	let executionClaimConflictCount = 0;
	for (const { line, section } of lines) {
		if (!line.trim() || NON_AUTHORITATIVE_CLAIM_RE.test(line) || NON_AUTHORITATIVE_CLAIM_RE.test(section)) {
			continue;
		}
		const paths = claimPaths(line);
		const commands = claimCommands(line);
		const mutationConflict = MUTATION_CLAIM_RE.test(line) && (!hasMutation || !matchesEvidence(paths, mutationPaths));
		const verificationConflict =
			VERIFICATION_CLAIM_RE.test(line) &&
			(!hasVerification ||
				(paths.length > 0 && !matchesVerificationPaths(paths, commands)) ||
				(commands.length > 0 && !matchesCommandEvidence(commands)));
		if (mutationConflict || verificationConflict) executionClaimConflictCount++;
	}
	return { forbiddenGoalField, executionClaimConflictCount };
}

export function buildContextSummaryAuthorityAudit(options: {
	summarySource: ContextSummarySource;
	inspection: ContextSummaryInspection;
	repairAttempted: boolean;
	repairSucceeded: boolean;
	fallbackReason?: string;
}): ContextSummaryAuthorityAudit {
	return {
		summarySource: options.summarySource,
		forbiddenGoalField: options.inspection.forbiddenGoalField,
		executionClaimConflictCount: options.inspection.executionClaimConflictCount,
		repairAttempted: options.repairAttempted,
		repairSucceeded: options.repairSucceeded,
		...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
	};
}

export function contextSummaryInspectionFailed(inspection: ContextSummaryInspection): boolean {
	return inspection.forbiddenGoalField || inspection.executionClaimConflictCount > 0;
}

/** 摘要修复仍失败时生成有明确来源和原因的最小历史记录。 */
export function renderDeterministicHistoricalFallback(options: {
	state: ActiveContinuationState | undefined;
	summarySource: ContextSummarySource;
	failureReason: string;
}): string {
	const evidence = options.state?.executionEvidence;
	const evidenceRefs = [
		...(evidence?.successfulMutations ?? []),
		...(evidence?.successfulVerifications ?? []),
		...(evidence?.observedResources ?? []),
	].slice(-20);
	const evidenceLines =
		evidenceRefs.length > 0
			? evidenceRefs
					.map(
						item => `- ${item.tool}: ${item.path ?? item.resource ?? item.resultEntryId} (${item.resultEntryId})`,
					)
					.join("\n")
			: "- No bounded resource references were available.";
	return prompt.render(fallbackTemplate, {
		summarySource: options.summarySource,
		failureReason: options.failureReason,
		activeUserEntryId: options.state?.activeUserEntryId ?? "authority_source_missing",
		mutationCount: evidence?.successfulMutations.length ?? 0,
		verificationCount: evidence?.successfulVerifications.length ?? 0,
		successfulToolResults: evidence?.successfulToolResults ?? 0,
		failedToolResults: evidence?.failedToolResults ?? 0,
		evidenceLines,
	});
}
