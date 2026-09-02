import type { AgentMessage } from "@san/agent";
import type { AssistantMessage, Usage } from "@san/ai";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import type { SessionInfo, SessionStatus } from "../../session/session-listing";
import { loadEntriesFromFile } from "../../session/session-loader";
import { SessionManager } from "../../session/session-manager";

const DEFAULT_DAYS = 14;
const DEFAULT_SESSION_LIMIT = 200;
const MAX_DAYS = 90;
const MAX_SESSION_LIMIT = 500;
const LOAD_WORKERS = 8;

export interface UsageAggregate {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	premiumRequests: number;
	toolCalls: number;
	failures: number;
	aborted: number;
	durationMs: number;
	averageTtftMs: number;
	tokensPerSecond: number;
	cacheHitRate: number;
	successRate: number;
}

export interface UsageBreakdown extends UsageAggregate {
	key: string;
	label: string;
	provider?: string;
	model?: string;
}

export interface UsageSessionSummary extends UsageAggregate {
	sessionId: string;
	title: string;
	cwd: string;
	updatedAt: string;
	status: SessionStatus;
	provider?: string;
	model?: string;
	delegatedTokens: number;
}

export interface UsageDailyPoint extends UsageAggregate {
	date: string;
}

export interface UsageAnalytics {
	generatedAt: string;
	days: number;
	sessionCount: number;
	persistedSessionCount: number;
	activeSessionIncluded: boolean;
	sessionsTruncated: boolean;
	totals: UsageAggregate;
	currentSession?: UsageSessionSummary;
	byProvider: UsageBreakdown[];
	byModel: UsageBreakdown[];
	byUpstreamProvider: UsageBreakdown[];
	daily: UsageDailyPoint[];
	sessions: UsageSessionSummary[];
}

export interface ActiveUsageSession {
	sessionId: string;
	title?: string;
	cwd: string;
	messages: readonly AgentMessage[];
	updatedAt?: string;
	status?: SessionStatus;
}

interface MutableUsage {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	premiumRequests: number;
	toolCalls: number;
	failures: number;
	aborted: number;
	durationMs: number;
	ttftMs: number;
	ttftSamples: number;
}

interface SessionAccumulator {
	metrics: MutableUsage;
	delegatedTokens: number;
	provider?: string;
	model?: string;
}

interface AggregateContext {
	totals: MutableUsage;
	providers: Map<string, MutableUsage>;
	models: Map<string, MutableUsage>;
	upstreamProviders: Map<string, MutableUsage>;
	days: Map<string, MutableUsage>;
}

function emptyUsage(): MutableUsage {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		premiumRequests: 0,
		toolCalls: 0,
		failures: 0,
		aborted: 0,
		durationMs: 0,
		ttftMs: 0,
		ttftSamples: 0,
	};
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageTotal(usage: Partial<Usage>): number {
	const reported = finiteNonNegative(usage.totalTokens);
	if (reported > 0) return reported;
	return (
		finiteNonNegative(usage.input) +
		finiteNonNegative(usage.output) +
		finiteNonNegative(usage.cacheRead) +
		finiteNonNegative(usage.cacheWrite)
	);
}

function addMetrics(target: MutableUsage, source: MutableUsage): void {
	target.requests += source.requests;
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.totalTokens += source.totalTokens;
	target.costUsd += source.costUsd;
	target.premiumRequests += source.premiumRequests;
	target.toolCalls += source.toolCalls;
	target.failures += source.failures;
	target.aborted += source.aborted;
	target.durationMs += source.durationMs;
	target.ttftMs += source.ttftMs;
	target.ttftSamples += source.ttftSamples;
}

function groupMetric(groups: Map<string, MutableUsage>, key: string, metric: MutableUsage): void {
	let aggregate = groups.get(key);
	if (!aggregate) {
		aggregate = emptyUsage();
		groups.set(key, aggregate);
	}
	addMetrics(aggregate, metric);
}

function messageMetric(message: AssistantMessage): MutableUsage {
	const usage = message.usage ?? ({} as Usage);
	const metric = emptyUsage();
	metric.requests = 1;
	metric.inputTokens = finiteNonNegative(usage.input);
	metric.outputTokens = finiteNonNegative(usage.output);
	metric.reasoningTokens = finiteNonNegative(usage.reasoningTokens);
	metric.cacheReadTokens = finiteNonNegative(usage.cacheRead);
	metric.cacheWriteTokens = finiteNonNegative(usage.cacheWrite);
	metric.totalTokens = usageTotal(usage);
	metric.costUsd = finiteNonNegative(usage.cost?.total);
	metric.premiumRequests = finiteNonNegative(usage.premiumRequests);
	metric.toolCalls = Array.isArray(message.content)
		? message.content.filter(item => item.type === "toolCall").length
		: 0;
	metric.failures = message.stopReason === "error" ? 1 : 0;
	metric.aborted = message.stopReason === "aborted" ? 1 : 0;
	metric.durationMs = finiteNonNegative(message.duration);
	const ttft = finiteNonNegative(message.ttft);
	if (ttft > 0) {
		metric.ttftMs = ttft;
		metric.ttftSamples = 1;
	}
	return metric;
}

function utcDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function taskDelegatedTokens(message: AgentMessage): number {
	if (
		message.role !== "toolResult" ||
		message.toolName !== "task" ||
		!message.details ||
		typeof message.details !== "object"
	) {
		return 0;
	}
	const usage = (message.details as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return 0;
	return usageTotal(usage as Partial<Usage>);
}

function accumulateMessages(messages: readonly AgentMessage[], context: AggregateContext): SessionAccumulator {
	const session: SessionAccumulator = { metrics: emptyUsage(), delegatedTokens: 0 };
	for (const message of messages) {
		session.delegatedTokens += taskDelegatedTokens(message);
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const metric = messageMetric(assistant);
		addMetrics(session.metrics, metric);
		addMetrics(context.totals, metric);
		session.provider = assistant.provider;
		session.model = assistant.model;
		groupMetric(context.providers, assistant.provider || "unknown", metric);
		groupMetric(context.models, `${assistant.provider || "unknown"}\0${assistant.model || "unknown"}`, metric);
		if (assistant.upstreamProvider) groupMetric(context.upstreamProviders, assistant.upstreamProvider, metric);
		const timestamp = finiteNonNegative(assistant.timestamp);
		if (timestamp > 0) {
			const date = utcDate(timestamp);
			const daily = context.days.get(date);
			if (daily) addMetrics(daily, metric);
		}
	}
	return session;
}

function finalize(source: MutableUsage): UsageAggregate {
	const promptTokens = source.inputTokens + source.cacheReadTokens + source.cacheWriteTokens;
	const successful = Math.max(0, source.requests - source.failures - source.aborted);
	return {
		requests: source.requests,
		inputTokens: source.inputTokens,
		outputTokens: source.outputTokens,
		reasoningTokens: source.reasoningTokens,
		cacheReadTokens: source.cacheReadTokens,
		cacheWriteTokens: source.cacheWriteTokens,
		totalTokens: source.totalTokens,
		costUsd: source.costUsd,
		premiumRequests: source.premiumRequests,
		toolCalls: source.toolCalls,
		failures: source.failures,
		aborted: source.aborted,
		durationMs: source.durationMs,
		averageTtftMs: source.ttftSamples > 0 ? source.ttftMs / source.ttftSamples : 0,
		tokensPerSecond: source.durationMs > 0 ? (source.outputTokens * 1000) / source.durationMs : 0,
		cacheHitRate: promptTokens > 0 ? source.cacheReadTokens / promptTokens : 0,
		successRate: source.requests > 0 ? successful / source.requests : 1,
	};
}

function messagesFromEntries(entries: readonly FileEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push((entry as SessionMessageEntry).message);
	}
	return messages;
}

function makeSessionSummary(
	metadata: {
		id: string;
		title?: string;
		cwd: string;
		updatedAt: string;
		status?: SessionStatus;
	},
	accumulator: SessionAccumulator,
): UsageSessionSummary {
	return {
		sessionId: metadata.id,
		title: metadata.title?.trim() || "未命名会话",
		cwd: metadata.cwd,
		updatedAt: metadata.updatedAt,
		status: metadata.status ?? "unknown",
		...(accumulator.provider ? { provider: accumulator.provider } : {}),
		...(accumulator.model ? { model: accumulator.model } : {}),
		delegatedTokens: accumulator.delegatedTokens,
		...finalize(accumulator.metrics),
	};
}

function breakdowns(groups: Map<string, MutableUsage>, kind: "provider" | "model" | "upstream"): UsageBreakdown[] {
	const rows: UsageBreakdown[] = [];
	for (const [key, metrics] of groups) {
		if (kind === "model") {
			const separator = key.indexOf("\0");
			const provider = separator >= 0 ? key.slice(0, separator) : "unknown";
			const model = separator >= 0 ? key.slice(separator + 1) : key;
			rows.push({ key: `${provider}/${model}`, label: model, provider, model, ...finalize(metrics) });
		} else {
			rows.push({ key, label: key, provider: key, ...finalize(metrics) });
		}
	}
	return rows.sort((left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd);
}

function buildDayMap(days: number, now: Date): Map<string, MutableUsage> {
	const result = new Map<string, MutableUsage>();
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	for (let offset = days - 1; offset >= 0; offset--) {
		result.set(utcDate(today - offset * 86_400_000), emptyUsage());
	}
	return result;
}

async function loadPersistedSessions(
	infos: readonly SessionInfo[],
	context: AggregateContext,
	activeSessionId: string | undefined,
): Promise<UsageSessionSummary[]> {
	const candidates = infos.filter(info => info.id !== activeSessionId);
	const output = new Array<UsageSessionSummary>(candidates.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = cursor++;
			if (index >= candidates.length) return;
			const info = candidates[index]!;
			const entries = await loadEntriesFromFile(info.path);
			const accumulator = accumulateMessages(messagesFromEntries(entries), context);
			output[index] = makeSessionSummary(
				{
					id: info.id,
					title: info.title || info.firstMessage,
					cwd: info.cwd,
					updatedAt: info.modified.toISOString(),
					status: info.status,
				},
				accumulator,
			);
		}
	};
	const workers = Math.min(LOAD_WORKERS, candidates.length);
	await Promise.all(Array.from({ length: workers }, worker));
	return output;
}

export async function buildUsageAnalytics(options?: {
	activeSession?: ActiveUsageSession;
	days?: number;
	sessionLimit?: number;
	/** 只聚合内存中的活跃会话，跳过全盘 Session 文件扫描（指标条等高频刷新场景）。 */
	currentOnly?: boolean;
	now?: Date;
}): Promise<UsageAnalytics> {
	const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(options?.days ?? DEFAULT_DAYS)));
	const sessionLimit = Math.min(
		MAX_SESSION_LIMIT,
		Math.max(1, Math.trunc(options?.sessionLimit ?? DEFAULT_SESSION_LIMIT)),
	);
	const now = options?.now ?? new Date();
	const context: AggregateContext = {
		totals: emptyUsage(),
		providers: new Map(),
		models: new Map(),
		upstreamProviders: new Map(),
		days: buildDayMap(days, now),
	};
	const infos = options?.currentOnly ? [] : await SessionManager.listAll();
	const persisted = options?.currentOnly
		? []
		: await loadPersistedSessions(infos, context, options?.activeSession?.sessionId);
	let currentSession: UsageSessionSummary | undefined;
	if (options?.activeSession) {
		const accumulator = accumulateMessages(options.activeSession.messages, context);
		currentSession = makeSessionSummary(
			{
				id: options.activeSession.sessionId,
				title: options.activeSession.title,
				cwd: options.activeSession.cwd,
				updatedAt: options.activeSession.updatedAt ?? now.toISOString(),
				status: options.activeSession.status,
			},
			accumulator,
		);
	}
	const allSessions = currentSession ? [currentSession, ...persisted] : persisted;
	allSessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return {
		generatedAt: now.toISOString(),
		days,
		sessionCount: allSessions.length,
		persistedSessionCount: infos.length,
		activeSessionIncluded: currentSession !== undefined,
		sessionsTruncated: allSessions.length > sessionLimit,
		totals: finalize(context.totals),
		...(currentSession ? { currentSession } : {}),
		byProvider: breakdowns(context.providers, "provider"),
		byModel: breakdowns(context.models, "model"),
		byUpstreamProvider: breakdowns(context.upstreamProviders, "upstream"),
		daily: [...context.days].map(([date, metrics]) => ({ date, ...finalize(metrics) })),
		sessions: allSessions.slice(0, sessionLimit),
	};
}
