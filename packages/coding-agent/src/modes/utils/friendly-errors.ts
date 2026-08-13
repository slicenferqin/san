/**
 * 错误呈现的人话层(拎包入住原则:用户只需要"卡在哪 + 下一步做什么")。
 *
 * 只改呈现,不改诊断:原始错误文本继续完整展示在人话摘要之下,`san stats`
 * 与日志不受影响。分类是保守的文本启发式 — 认不出的错误返回 undefined,
 * 呈现保持原样,绝不给错误贴错标签。
 */

export interface FriendlyErrorSummary {
	/** 一句话说清卡在哪(用户语言,零机制词汇)。 */
	headline: string;
	/** 一个可执行的下一步。 */
	nextStep: string;
}

interface Rule {
	pattern: RegExp;
	summary: FriendlyErrorSummary;
}

/** 顺序即优先级:更具体的分类在前(额度先于泛化 4xx,窗口先于泛化 400)。 */
const RULES: readonly Rule[] = [
	{
		pattern: /usage limit|quota|credit balance|insufficient credit|out of credit|billing|payment required|402/i,
		summary: {
			headline: "模型服务商的额度用完了。",
			nextStep: "检查该服务商的余额/订阅,或用 /model 切到别的服务商继续。",
		},
	},
	{
		pattern: /rate limit|too many requests|429|concurrency|retry.?after/i,
		summary: {
			headline: "请求太频繁,服务商临时限流了。",
			nextStep: "稍等片刻重试;San 的自动重试通常会自己恢复。",
		},
	},
	{
		pattern:
			/401|403|unauthorized|forbidden|invalid.{0,12}(api.?key|token|credential)|authentication|oauth.{0,20}(expired|invalid|revoked)|invalidated oauth/i,
		summary: {
			headline: "模型服务商拒绝了当前凭据。",
			nextStep: "运行 /auth 重新登录该服务商,或检查 API key 是否有效。",
		},
	},
	{
		pattern:
			/context.{0,20}(length|window|limit)|maximum.{0,12}tokens|token limit|prompt is too long|request too large/i,
		summary: {
			headline: "这轮内容超出了模型的上下文窗口。",
			nextStep: "用 /compact 压缩会话,或换一个窗口更大的模型再试。",
		},
	},
	{
		pattern:
			/econnrefused|econnreset|etimedout|enotfound|eai_again|fetch failed|network|socket hang up|connection (closed|refused|reset)/i,
		summary: {
			headline: "连不上模型服务商(网络问题)。",
			nextStep: "检查网络或代理设置,恢复后重发这条消息即可。",
		},
	},
	{
		pattern:
			/\b(5\d{2})\b.*\b(error|status)\b|overloaded|server error|internal error|bad gateway|service unavailable|upstream/i,
		summary: {
			headline: "服务商那边暂时出故障了,不是你的问题。",
			nextStep: "稍等重试;持续失败的话用 /model 先切一个可用的服务商。",
		},
	},
];

/**
 * 把技术错误文本映射为人话摘要;认不出返回 undefined(呈现保持原样)。
 */
export function friendlyErrorSummary(errorMessage: string): FriendlyErrorSummary | undefined {
	if (!errorMessage) return undefined;
	for (const rule of RULES) {
		if (rule.pattern.test(errorMessage)) return rule.summary;
	}
	return undefined;
}

/** 组合人话摘要与原始诊断:摘要置顶,原文完整保留在下方。 */
export function withFriendlyHeadline(errorMessage: string): string {
	const friendly = friendlyErrorSummary(errorMessage);
	if (!friendly) return errorMessage;
	return `${friendly.headline}\n→ ${friendly.nextStep}\n\n${errorMessage}`;
}
