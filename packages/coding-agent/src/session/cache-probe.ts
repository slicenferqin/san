/**
 * Provider prompt-cache 命中归因观测(magic-context 研究 §4.2 的第一步)。
 *
 * §4.2 的"bust 分类学"要把 checkpoint rebase 等重写时机与缓存天然失效时刻
 * 对齐,但改动之前必须先有观测:没有命中率与击穿归因的基线,任何缓存策略
 * 变更都无法验证效果。本模块只做观测——每次 assistant 回合 settle 时,把
 * host 侧可得的请求事实归因为一条确定性样本,落 journal(custom entry),
 * 零行为变化。
 *
 * 归因是启发式但确定性的:同输入永远同输出。它回答"这次请求为什么没吃到
 * 缓存":模型换了、system prompt 变了、闲置超过 TTL、还是前缀字节漂移
 * (plan 重写/checkpoint rebase 的嫌疑区,正是 §4.2 要优化的对象)。
 */
import { stableValueFingerprint } from "../execution-control/progress-classifier";

export const CACHE_PROBE_CUSTOM_TYPE = "san.cache_probe";

/** 命中率高于该值视为缓存命中(provider 计费口径下前缀命中通常远高于此)。 */
const HIT_RATIO_THRESHOLD = 0.5;
/** 闲置超过该时长视为缓存 TTL 过期嫌疑(主流 provider 缓存 TTL 约 5 分钟)。 */
const IDLE_TTL_MS = 5 * 60_000;

export type CacheProbeAttribution =
	| "cache_hit"
	| "first_request"
	| "model_changed"
	| "system_prompt_changed"
	| "idle_gap"
	| "prefix_diverged";

export interface CacheProbeRequestFacts {
	readonly provider: string;
	readonly model: string;
	readonly systemPromptHash: string;
	readonly timestampMs: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface CacheProbeSample extends CacheProbeRequestFacts {
	readonly requestSequence: number;
	readonly attribution: CacheProbeAttribution;
	readonly hitRatio: number;
	readonly idleMs?: number;
}

export function systemPromptHash(systemPrompt: readonly string[] | string | undefined): string {
	return stableValueFingerprint(systemPrompt ?? "");
}

/**
 * 确定性归因。优先级:首请求 → 命中 → 模型变化 → system prompt 变化 →
 * 闲置过期 → 前缀漂移(排除以上后的默认解释)。
 */
export function classifyCacheProbe(
	previous: CacheProbeSample | undefined,
	facts: CacheProbeRequestFacts,
): CacheProbeSample {
	const hitRatio = facts.input > 0 ? facts.cacheRead / facts.input : 0;
	const requestSequence = (previous?.requestSequence ?? 0) + 1;
	const idleMs = previous ? Math.max(0, facts.timestampMs - previous.timestampMs) : undefined;
	let attribution: CacheProbeAttribution;
	if (!previous) {
		attribution = "first_request";
	} else if (hitRatio >= HIT_RATIO_THRESHOLD) {
		attribution = "cache_hit";
	} else if (previous.provider !== facts.provider || previous.model !== facts.model) {
		attribution = "model_changed";
	} else if (previous.systemPromptHash !== facts.systemPromptHash) {
		attribution = "system_prompt_changed";
	} else if (idleMs !== undefined && idleMs > IDLE_TTL_MS) {
		attribution = "idle_gap";
	} else {
		attribution = "prefix_diverged";
	}
	return {
		...facts,
		requestSequence,
		attribution,
		hitRatio: Number(hitRatio.toFixed(4)),
		...(idleMs !== undefined ? { idleMs } : {}),
	};
}
