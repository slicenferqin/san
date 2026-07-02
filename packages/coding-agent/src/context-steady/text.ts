/**
 * Text hygiene helpers for context-steady summaries.
 *
 * These helpers keep generated continuity state durable instead of letting
 * benchmark turn labels or per-turn narration leak into future packets.
 */

const TURN_FRAME_RE =
	/^\s*(?:第[一二三四五六七八九十百千万\d]+轮|第\s*\d+\s*轮|turn\s*\d+|round\s*\d+|第[一二三四五六七八九十百千万\d]+次|第\s*\d+\s*次)\s*[：:，,、-]?\s*/iu;

const VOLATILE_MEMORY_RE =
	/(?:第[一二三四五六七八九十百千万\d]+轮|第\s*\d+\s*轮|turn\s*\d+|round\s*\d+|本轮|当前轮|这一轮|上一轮|下一轮|临时判断|当前临时|这\s*\d+\s*轮|10\s*轮)/iu;

export function polishContextSteadyText(value: string): string {
	return value
		.replace(TURN_FRAME_RE, "")
		.replace(/\s+/g, " ")
		.replace(/\s+([。！？.!?])/g, "$1")
		.trim();
}

export function isVolatileContextSteadyMemory(value: string): boolean {
	return VOLATILE_MEMORY_RE.test(value);
}
