import type { ContextPlanQualityGateAudit, ContextPlanQualityGateOptions } from "./plan-types";

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}

function protectedToolPairRefs(options: ContextPlanQualityGateOptions): string[] {
	const activeToolCallIds = new Set(options.activeToolCallIds ?? []);
	const pairs =
		activeToolCallIds.size > 0
			? options.sourceIndex.toolPairs.filter(pair => activeToolCallIds.has(pair.toolCallId))
			: options.sourceIndex.toolPairs.filter(pair => !pair.complete);
	return pairs.flatMap(pair => pair.entryIds);
}

function requiredEntryRefs(options: ContextPlanQualityGateOptions): string[] {
	return unique([
		...(options.baseRequiredEntryRefs ?? []),
		...(options.currentPromptEntryRefs ?? []),
		...(options.liveTailEntryRefs ?? []),
		...protectedToolPairRefs(options),
	]);
}

function tokenEstimate(refs: readonly string[], estimates: ReadonlyMap<string, number> | undefined): number {
	if (!estimates) return 0;
	return refs.reduce((sum, ref) => sum + Math.max(0, Math.floor(estimates.get(ref) ?? 0)), 0);
}

export function evaluateContextPlanQualityGate(options: ContextPlanQualityGateOptions): ContextPlanQualityGateAudit {
	const sourceEntryIds = new Set(options.sourceIndex.entryIds);
	const protectedEntryRefs = requiredEntryRefs(options);
	const missingEntryRefs = protectedEntryRefs.filter(ref => !sourceEntryIds.has(ref));
	const requiredTokens = tokenEstimate(protectedEntryRefs, options.tokenEstimateByEntryRef);
	const selectedInputTokens = options.nonMessageTokens + requiredTokens;
	const projectedInputTokens = options.projectedInputTokens;
	const reasons: string[] = [];

	if (missingEntryRefs.length > 0) reasons.push("required_entries_missing_from_source_index");
	if (requiredTokens > options.messageBudget) reasons.push("protected_entries_exceed_message_budget");
	if (selectedInputTokens > options.controlMax) reasons.push("protected_entries_exceed_control_band");
	if (selectedInputTokens > options.burstCeiling) reasons.push("protected_entries_exceed_burst_ceiling");
	if (projectedInputTokens !== undefined && projectedInputTokens > options.controlMax) {
		reasons.push("projected_input_exceeds_control_band");
	}
	if (projectedInputTokens !== undefined && projectedInputTokens > options.burstCeiling) {
		reasons.push("projected_input_exceeds_burst_ceiling");
	}

	let outcome: ContextPlanQualityGateAudit["outcome"] = "pass";
	if (
		missingEntryRefs.length > 0 ||
		selectedInputTokens > options.burstCeiling ||
		(projectedInputTokens !== undefined && projectedInputTokens > options.burstCeiling)
	) {
		outcome = "hard_pressure";
	} else if (
		requiredTokens > options.messageBudget ||
		selectedInputTokens > options.controlMax ||
		(projectedInputTokens !== undefined && projectedInputTokens > options.controlMax)
	) {
		outcome = "burst_required";
	}

	// 应急降级档(magic-context 研究 §4.3):hard_pressure 的三个触发源里,
	// 只有"投影超出 burst ceiling"是可挽回的 — 把非保护的已闭合工具输出
	// oldest-first 降为 stub 能直接压低投影。保护集超燃与必需 entry 缺失
	// 保持 fail-closed,永不用降级绕过。
	let emergencyStubEntryRefs: string[] | undefined;
	let emergencyStubReclaimedTokens: number | undefined;
	const projectedOverBurst = projectedInputTokens !== undefined && projectedInputTokens > options.burstCeiling;
	const onlyRecoverableHardPressure =
		outcome === "hard_pressure" &&
		projectedOverBurst &&
		missingEntryRefs.length === 0 &&
		selectedInputTokens <= options.burstCeiling;
	if (onlyRecoverableHardPressure && projectedInputTokens !== undefined) {
		const protectedRefs = new Set(protectedEntryRefs);
		const deficit = projectedInputTokens - options.burstCeiling;
		const stubbed: string[] = [];
		let reclaimed = 0;
		// sourceIndex.toolPairs 按 journal 顺序收集,天然 oldest-first。
		for (const pair of options.sourceIndex.toolPairs) {
			if (reclaimed >= deficit) break;
			if (!pair.complete || pair.resultEntryId === undefined) continue;
			if (pair.entryIds.some(entryRef => protectedRefs.has(entryRef))) continue;
			const resultTokens = Math.max(0, Math.floor(options.tokenEstimateByEntryRef?.get(pair.resultEntryId) ?? 0));
			// Stub 自身 ~40 token;没有正收益的候选不值得打扰缓存。
			const reclaimable = resultTokens - 40;
			if (reclaimable <= 0) continue;
			stubbed.push(pair.resultEntryId);
			reclaimed += reclaimable;
		}
		if (reclaimed >= deficit && stubbed.length > 0) {
			emergencyStubEntryRefs = stubbed;
			emergencyStubReclaimedTokens = reclaimed;
			reasons.push("emergency_tool_stub_downgrade");
			// 降回 burst 语义:投影经降级后回到 ceiling 内;其余 burst 判定不变。
			outcome = "burst_required";
		}
	}

	return {
		outcome,
		reasons,
		protectedEntryRefs,
		missingEntryRefs,
		requiredTokens,
		selectedInputTokens,
		activeEntryCount: Math.max(0, Math.floor(options.activeEntryCount ?? options.sourceIndex.entryIds.length)),
		archivedEntryCount: Math.max(0, Math.floor(options.archivedEntryCount ?? 0)),
		...(options.activeCutoffEntryId ? { activeCutoffEntryId: options.activeCutoffEntryId } : {}),
		...(options.maintenanceId ? { maintenanceId: options.maintenanceId } : {}),
		...(options.recoveryAttempt === undefined ? {} : { recoveryAttempt: options.recoveryAttempt }),
		...(projectedInputTokens !== undefined
			? { projectedInputTokens, projectedInputLimit: options.burstCeiling }
			: {}),
		...(outcome === "burst_required"
			? {
					requiredBurstTokens: Math.max(
						0,
						Math.max(selectedInputTokens, projectedInputTokens ?? 0) - options.controlMax,
					),
				}
			: {}),
		...(emergencyStubEntryRefs !== undefined && emergencyStubReclaimedTokens !== undefined
			? { emergencyStubEntryRefs, emergencyStubReclaimedTokens }
			: {}),
	};
}
