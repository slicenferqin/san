/**
 * Digest 多分辨率渲染与确定性 decay 选级(magic-context 研究 §4.1 的 San 版)。
 *
 * MC 需要在压缩期预存 4 级 paraphrase,因为它的分舱是自由文本;San 的
 * TurnDigest 是结构化数据,任意粒度都可以在渲染期**确定性投影**——不改
 * schema、不加 LLM 调用、旧 digest 天然兼容。三档:
 *
 * - `full`    完整结构化视图(现状);
 * - `compact` 意图 + 前几项动作/决策 + 文件路径;
 * - `anchor`  单行锚点(意图 + 文件数),digest ref 仍可 `context_expand` 取回原文。
 *
 * 选级公式借 MC 半衰期形态:越旧(ageRank 越大)、预算压力越高,降到越粗
 * 的档。纯函数,同输入永远同输出——同一历史在同一压力下逐字节可重现。
 */
import type { TurnDigest } from "./types";

export type DigestTier = "full" | "compact" | "anchor";

/** 压力低于此值时永不降级(舒适区,渐进降级不启动)。 */
const PRESSURE_FLOOR = 0.5;
/** 半衰期常数:allowance = K / max(pressure, 0.1)。K 越大降级越晚。 */
const COMPACT_ALLOWANCE_K = 2.4;
const ANCHOR_ALLOWANCE_K = 4.8;

/**
 * 确定性选级。`ageRank` 为该 digest 在选中集合里按新旧排序的名次
 * (0 = 最新);`pressure` 为上下文占用率(selectedInputTokens / messageBudget,
 * 0–1+)。最新的 digest 永远保持 full。
 */
export function selectDigestTier(ageRank: number, pressure: number): DigestTier {
	if (ageRank <= 0) return "full";
	if (!Number.isFinite(pressure) || pressure < PRESSURE_FLOOR) return "full";
	const effective = Math.max(pressure, 0.1);
	const compactAllowance = Math.ceil(COMPACT_ALLOWANCE_K / effective);
	const anchorAllowance = Math.ceil(ANCHOR_ALLOWANCE_K / effective);
	if (ageRank >= anchorAllowance) return "anchor";
	if (ageRank >= compactAllowance) return "compact";
	return "full";
}

export interface DigestTierView {
	tier: DigestTier;
	userIntent: string;
	actionsTaken: string[];
	decisions: string[];
	filesTouched: Array<{ path: string; action: string }>;
	risks: string[];
	nextSteps: string[];
}

function clampString(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function clampArray(values: readonly string[], maxItems: number, maxLength: number): string[] {
	return values.slice(0, maxItems).map(value => clampString(value, maxLength));
}

/** 把 digest 投影到指定粒度的渲染视图;所有档从既有结构化字段确定性派生。 */
export function projectDigestTier(digest: TurnDigest, tier: DigestTier): DigestTierView {
	if (tier === "anchor") {
		const fileCount = digest.filesTouched.length;
		const suffix = fileCount > 0 ? ` (${fileCount} file${fileCount === 1 ? "" : "s"} touched)` : "";
		return {
			tier,
			userIntent: `${clampString(digest.userIntent, 160)}${suffix}`,
			actionsTaken: [],
			decisions: [],
			filesTouched: [],
			risks: [],
			nextSteps: [],
		};
	}
	if (tier === "compact") {
		return {
			tier,
			userIntent: clampString(digest.userIntent, 240),
			actionsTaken: clampArray(digest.actionsTaken, 2, 120),
			decisions: clampArray(digest.decisions, 2, 120),
			filesTouched: digest.filesTouched.slice(0, 4).map(file => ({
				path: clampString(file.path, 160),
				action: file.action,
			})),
			risks: [],
			nextSteps: clampArray(digest.nextSteps, 1, 120),
		};
	}
	return {
		tier,
		userIntent: clampString(digest.userIntent, 240),
		actionsTaken: clampArray(digest.actionsTaken, 5, 180),
		decisions: clampArray(digest.decisions, 5, 180),
		filesTouched: digest.filesTouched.slice(0, 8).map(file => ({
			path: clampString(file.path, 240),
			action: file.action,
		})),
		risks: clampArray(digest.risks, 4, 180),
		nextSteps: clampArray(digest.nextSteps, 4, 180),
	};
}
