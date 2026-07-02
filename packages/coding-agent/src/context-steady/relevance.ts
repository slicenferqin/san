import type { ContextCheckpoint, TurnDigest } from "./types";

const ASCII_TOKEN = /[a-z0-9][a-z0-9._-]*/g;
const HAN_RUN = /[\p{Script=Han}]+/gu;
const HAS_HAN = /[\p{Script=Han}]/u;

const ASCII_GENERIC_TOKENS = new Set([
	"agent",
	"ai",
	"anthropic",
	"api",
	"assistant",
	"claude",
	"code",
	"coding",
	"context",
	"llm",
	"model",
	"san",
	"task",
	"tool",
]);

const HAN_GENERIC_TOKENS = new Set([
	"一下",
	"上面",
	"事情",
	"什么",
	"以后",
	"他们",
	"以及",
	"但是",
	"你们",
	"使用",
	"修复",
	"做了",
	"关于",
	"分析",
	"刚才",
	"后续",
	"哪个",
	"因为",
	"如果",
	"它们",
	"实际",
	"已经",
	"应该",
	"怎么",
	"我们",
	"所以",
	"报告",
	"按照",
	"接下",
	"时候",
	"是否",
	"有没有",
	"没有",
	"测试",
	"然后",
	"现在",
	"看下",
	"看看",
	"确认",
	"继续",
	"规划",
	"这个",
	"这里",
	"这些",
	"这样",
	"那么",
	"问题",
]);

const HAN_STOP_CHARS = new Set([
	"一",
	"了",
	"也",
	"他",
	"们",
	"你",
	"做",
	"再",
	"和",
	"哪",
	"啊",
	"吗",
	"吧",
	"呢",
	"在",
	"她",
	"它",
	"就",
	"很",
	"我",
	"是",
	"有",
	"没",
	"的",
	"看",
	"要",
	"这",
	"那",
	"都",
]);

const EXPLICIT_CONTINUATION_MARKERS = [
	"continue",
	"follow up",
	"same task",
	"so far",
	"this conversation",
	"this thread",
	"this session",
	"the conversation",
	"the thread",
	"above",
	"previous",
	"earlier",
	"继续",
	"接着",
	"上面",
	"刚才",
	"前面",
	"上一轮",
	"这轮",
	"这个问题",
	"这件事",
	"后续",
	"继续推进",
	"再看",
	"再review",
	"同主题",
	"前几轮",
	"这几轮",
	"目前几轮",
	"最近几轮",
	"基于目前",
	"基于前面",
	"基于刚才",
	"最近的",
];

const HISTORY_REFERENCE_MARKERS = [
	"conversation",
	"thread",
	"session",
	"turn",
	"turns",
	"round",
	"rounds",
	"history",
	"transcript",
	"so far",
	"对话",
	"会话",
	"上下文",
	"历史",
	"前文",
	"记录",
	"轮",
	"几轮",
	"多轮",
	"这次",
	"本次",
	"本轮",
	"当前会话",
	"本次对话",
];

const HISTORY_SUMMARY_INTENT_MARKERS = [
	"summarize",
	"summary",
	"recap",
	"review",
	"evaluate",
	"assessment",
	"conclusion",
	"verdict",
	"acceptance",
	"evidence",
	"what happened",
	"总结",
	"归纳",
	"复盘",
	"回顾",
	"评估",
	"验收",
	"结论",
	"判断",
	"依据",
	"证据",
];

const EXPLICIT_TOPIC_SHIFT_MARKERS = [
	"do not use previous",
	"do not use the previous",
	"don't use previous",
	"don't use the previous",
	"do not rely on previous",
	"do not rely on the previous",
	"ignore previous",
	"ignore the previous",
	"new topic",
	"different topic",
	"unrelated topic",
	"switch topic",
	"不要沿用",
	"不要引用前面",
	"不要参考前面",
	"不要继承前面",
	"不要用前面",
	"不要带入前面",
	"别沿用",
	"别引用前面",
	"别参考前面",
	"别继承前面",
	"别用前面",
	"无关话题",
	"不同话题",
	"完全无关",
	"切换话题",
	"切换到",
	"换个话题",
	"另一个话题",
];

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function addHanTokens(tokens: Set<string>, run: string): void {
	const chars = Array.from(run).filter(char => !HAN_STOP_CHARS.has(char));
	if (chars.length === 0) return;
	if (chars.length === 1) {
		tokens.add(chars[0]!);
		return;
	}
	for (let index = 0; index < chars.length - 1; index++) {
		const token = `${chars[index]}${chars[index + 1]}`;
		if (!HAN_GENERIC_TOKENS.has(token)) tokens.add(token);
	}
}

function topicTokens(value: string): Set<string> {
	const normalized = normalizeText(value);
	const tokens = new Set<string>();
	for (const match of normalized.matchAll(ASCII_TOKEN)) {
		const token = match[0];
		if (token.length < 2) continue;
		if (ASCII_GENERIC_TOKENS.has(token)) continue;
		tokens.add(token);
	}
	for (const match of normalized.matchAll(HAN_RUN)) {
		addHanTokens(tokens, match[0]);
	}
	return tokens;
}

function hasHistoryReference(prompt: string): boolean {
	if (HISTORY_REFERENCE_MARKERS.some(marker => prompt.includes(marker))) return true;
	return (
		/\b\d+\s*(turns?|rounds?)\b/.test(prompt) ||
		/[这本前最近当前]*\s*[0-9一二三四五六七八九十两几多]+\s*轮/u.test(prompt)
	);
}

function hasHistorySummaryIntent(prompt: string): boolean {
	return HISTORY_SUMMARY_INTENT_MARKERS.some(marker => prompt.includes(marker));
}

function overlapSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let count = 0;
	for (const token of left) {
		if (right.has(token)) count++;
	}
	return count;
}

export function isContinuationPrompt(prompt: string): boolean {
	const normalized = normalizeText(prompt);
	if (!normalized) return false;
	if (isTopicShiftPrompt(normalized)) return false;
	if (hasHistoryReference(normalized) && hasHistorySummaryIntent(normalized)) return true;
	return EXPLICIT_CONTINUATION_MARKERS.some(marker => normalized.includes(marker));
}

export function isTopicShiftPrompt(prompt: string): boolean {
	const normalized = normalizeText(prompt);
	if (!normalized) return false;
	return EXPLICIT_TOPIC_SHIFT_MARKERS.some(marker => normalized.includes(marker));
}

export function isTextRelevantToPrompt(currentPrompt: string, candidateText: string): boolean {
	if (isTopicShiftPrompt(currentPrompt)) return false;
	if (isContinuationPrompt(currentPrompt)) return true;
	const currentTokens = topicTokens(currentPrompt);
	if (currentTokens.size === 0) return false;
	const candidateTokens = topicTokens(candidateText);
	if (candidateTokens.size === 0) return false;
	const overlap = overlapSize(currentTokens, candidateTokens);
	if (overlap === 0) return false;
	const overlapRatio = overlap / Math.min(currentTokens.size, candidateTokens.size);
	if (overlap >= 2) return overlapRatio >= 0.3;
	if (HAS_HAN.test(currentPrompt) && currentTokens.size <= 3) return false;
	return currentTokens.size <= 3 && overlapRatio >= 0.5;
}

export function digestRelevanceText(digest: TurnDigest): string {
	return [
		digest.userIntent,
		...digest.actionsTaken,
		...digest.decisions,
		...digest.filesTouched.map(file => `${file.path} ${file.action}`),
		...digest.toolEvidence.map(evidence => `${evidence.tool} ${evidence.summary}`),
		...digest.factsLearned,
		...digest.openQuestions,
		...digest.risks,
		...digest.nextSteps,
	]
		.filter(Boolean)
		.join("\n");
}

export function isDigestRelevantToPrompt(currentPrompt: string, digest: TurnDigest): boolean {
	return isTextRelevantToPrompt(currentPrompt, digestRelevanceText(digest));
}

export function checkpointRelevanceText(checkpoint: ContextCheckpoint): string {
	return [
		...checkpoint.summary.userIntents.map(item => item.text),
		...checkpoint.summary.decisions.map(item => item.text),
		...checkpoint.summary.filesTouched.map(item => `${item.text} ${item.action}`),
		...checkpoint.summary.risks.map(item => item.text),
		...checkpoint.summary.nextSteps.map(item => item.text),
	]
		.filter(Boolean)
		.join("\n");
}

export function isCheckpointRelevantToPrompt(currentPrompt: string, checkpoint: ContextCheckpoint): boolean {
	return isTextRelevantToPrompt(currentPrompt, checkpointRelevanceText(checkpoint));
}
