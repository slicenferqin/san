import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getUsageAnalyticsStats } from "../api";
import { CHART_THEMES } from "../components/chart-shared";
import { formatCost, formatDurationMs, formatInteger, formatPercent, formatTokensPerSecond } from "../data/formatters";
import { useResource } from "../data/useResource";
import type { TimeRange, UsageAnalyticsFilter, UsageAnalyticsStats } from "../types";
import { AsyncBoundary, Panel, SegmentedControl } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface OverviewRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

type TrendMetric = "cost" | "tokens" | "requests";
type RankingTab = "provider" | "model" | "project";
type RankingMetric = "cost" | "tokens" | "requests" | "successRate" | "speed";

interface RankingRow {
	key: string;
	name: string;
	subtitle: string;
	cost: number;
	tokens: number;
	requests: number;
	successRate: number;
	speed: number | null;
}

interface BreakdownItem {
	label: string;
	value: number;
	color: string;
}

const TREND_OPTIONS: Array<{ value: TrendMetric; label: string }> = [
	{ value: "cost", label: "花费" },
	{ value: "tokens", label: "Token" },
	{ value: "requests", label: "请求" },
];

const RANKING_TAB_OPTIONS: Array<{ value: RankingTab; label: string }> = [
	{ value: "provider", label: "服务商" },
	{ value: "model", label: "模型" },
	{ value: "project", label: "项目" },
];

const RANKING_METRIC_OPTIONS: Array<{ value: RankingMetric; label: string }> = [
	{ value: "cost", label: "花费" },
	{ value: "tokens", label: "Token" },
	{ value: "requests", label: "请求" },
	{ value: "successRate", label: "成功率" },
	{ value: "speed", label: "速度" },
];

function formatWindow(range: TimeRange, firstTimestamp: number, lastTimestamp: number): string {
	if (!firstTimestamp || !lastTimestamp) return `${range} · 暂无请求`;
	const pattern = range === "1h" || range === "24h" ? "MM/dd HH:mm" : "yyyy/MM/dd";
	return `${format(new Date(firstTimestamp), pattern)} — ${format(new Date(lastTimestamp), pattern)}`;
}

function toRankingRows(analytics: UsageAnalyticsStats, tab: RankingTab): RankingRow[] {
	if (tab === "provider") {
		return analytics.byProvider.map(item => ({
			key: item.provider,
			name: item.provider,
			subtitle: "服务商",
			cost: item.totalCost,
			tokens: item.totalTokens,
			requests: item.totalRequests,
			successRate: item.successRate,
			speed: item.weightedTokensPerSecond,
		}));
	}
	if (tab === "model") {
		return analytics.byModel.map(item => ({
			key: `${item.provider}:${item.model}`,
			name: item.model,
			subtitle: item.provider,
			cost: item.totalCost,
			tokens: item.totalTokens,
			requests: item.totalRequests,
			successRate: item.successRate,
			speed: item.weightedTokensPerSecond,
		}));
	}
	return analytics.byProject.map(item => ({
		key: item.project,
		name: item.project,
		subtitle: "项目",
		cost: item.totalCost,
		tokens: item.totalTokens,
		requests: item.totalRequests,
		successRate: item.successRate,
		speed: item.weightedTokensPerSecond,
	}));
}

function rankingValue(row: RankingRow, metric: RankingMetric): number {
	if (metric === "speed") return row.speed ?? -1;
	return row[metric];
}

function MetricCard({
	label,
	value,
	detail,
	primary = false,
}: {
	label: string;
	value: string;
	detail: string;
	primary?: boolean;
}) {
	return (
		<div className={primary ? "stats-metric-card primary" : "stats-metric-card secondary"}>
			<div className="stats-metric-label">{label}</div>
			<div className="stats-metric-value">{value}</div>
			<div className="stats-text-xs stats-text-muted mt-1">{detail}</div>
		</div>
	);
}

function BreakdownList({
	items,
	total,
	formatter,
}: {
	items: BreakdownItem[];
	total: number;
	formatter: (value: number) => string;
}) {
	return (
		<div className="space-y-3">
			{items.map(item => {
				const share = total > 0 ? (item.value / total) * 100 : 0;
				return (
					<div key={item.label}>
						<div className="flex items-center justify-between gap-3 text-xs">
							<div className="flex items-center gap-2 stats-text-secondary">
								<span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
								<span>{item.label}</span>
							</div>
							<div className="stats-text-primary tabular-nums">
								{formatter(item.value)} <span className="stats-text-muted">{share.toFixed(1)}%</span>
							</div>
						</div>
						<div className="stats-progress-bar-track h-2 mt-1">
							<div
								className="stats-progress-bar-fill"
								style={{ width: `${Math.min(100, share)}%`, backgroundColor: item.color }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

interface UsageDashboardProps {
	analytics: UsageAnalyticsStats;
	range: TimeRange;
	filter: UsageAnalyticsFilter;
	onProviderChange: (provider: string | null) => void;
	onModelChange: (selection: { model: string; provider: string } | null) => void;
}

function UsageDashboard({ analytics, range, filter, onProviderChange, onModelChange }: UsageDashboardProps) {
	const [trendMetric, setTrendMetric] = useState<TrendMetric>("cost");
	const [rankingTab, setRankingTab] = useState<RankingTab>("model");
	const [rankingMetric, setRankingMetric] = useState<RankingMetric>("cost");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const summary = analytics.summary;

	const rankingRows = useMemo(
		() =>
			toRankingRows(analytics, rankingTab)
				.sort((left, right) => rankingValue(right, rankingMetric) - rankingValue(left, rankingMetric))
				.slice(0, 8),
		[analytics, rankingMetric, rankingTab],
	);

	const chartData = useMemo(() => {
		const labels = analytics.trend.map(point =>
			format(new Date(point.timestamp), range === "1h" || range === "24h" ? "HH:mm" : "MM/dd"),
		);
		const data = analytics.trend.map(point => {
			if (trendMetric === "cost") return point.cost;
			if (trendMetric === "tokens") return point.totalTokens;
			return point.requests;
		});
		return {
			labels,
			datasets: [
				{
					label: TREND_OPTIONS.find(option => option.value === trendMetric)?.label ?? "趋势",
					data,
					borderColor: trendMetric === "cost" ? "#ed4abf" : trendMetric === "tokens" ? "#9b4dff" : "#5ad8e6",
					backgroundColor: trendMetric === "cost" ? "rgba(237, 74, 191, 0.12)" : "rgba(155, 77, 255, 0.12)",
					fill: true,
					tension: 0.2,
					borderWidth: 2,
					pointRadius: analytics.trend.length <= 2 ? 3 : 0,
					pointHoverRadius: 4,
				},
			],
		};
	}, [analytics.trend, range, trendMetric]);

	const chartOptions = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: {
				legend: {
					display: true,
					position: "top" as const,
					align: "end" as const,
					labels: { color: chartTheme.legendLabel, boxWidth: 8, usePointStyle: true, font: { size: 11 } },
				},
				tooltip: {
					backgroundColor: chartTheme.tooltipBackground,
					titleColor: chartTheme.tooltipTitle,
					bodyColor: chartTheme.tooltipBody,
					borderColor: chartTheme.tooltipBorder,
					borderWidth: 1,
					cornerRadius: 8,
					padding: 10,
				},
			},
			scales: {
				x: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 10 } },
				},
				y: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 10 } },
					min: 0,
				},
			},
		}),
		[chartTheme],
	);

	const topProvider = analytics.byProvider[0];
	const topModel = analytics.byModel[0];
	const topProject = analytics.byProject[0];
	const modelOptions = filter.provider
		? analytics.options.models.filter(item => item.provider === filter.provider)
		: analytics.options.models;
	const selectedModelKey = filter.model && filter.provider ? `${filter.provider}\u0000${filter.model}` : "";

	return (
		<div className="stats-route-container space-y-6">
			<div className="stats-panel">
				<div className="stats-panel-body">
					<div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
						<div>
							<div className="stats-text-xs stats-text-muted uppercase tracking-wider">
								消耗概览 · {analytics.range}
							</div>
							<h2 className="text-3xl font-bold stats-text-primary mt-2">
								这段时间，San 花了 {formatCost(summary.totalCost)}
							</h2>
							<p className="stats-text-secondary text-sm mt-2">
								{formatWindow(range, summary.firstTimestamp, summary.lastTimestamp)}
							</p>
						</div>
						<div className="text-left md:text-right">
							<div className="stats-text-xs stats-text-muted">处理 Token</div>
							<div className="text-2xl font-bold stats-text-primary tabular-nums">
								{formatInteger(summary.totalTokens)}
							</div>
							<div className="stats-text-xs stats-text-muted">四类 Token 相加</div>
						</div>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
						<div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
							<div className="stats-text-xs stats-text-muted">主要服务商</div>
							<div className="stats-font-semibold stats-text-primary mt-1 truncate">
								{topProvider?.provider ?? "暂无"}
							</div>
						</div>
						<div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
							<div className="stats-text-xs stats-text-muted">花费最多模型</div>
							<div className="stats-font-semibold stats-text-primary mt-1 truncate">
								{topModel?.model ?? "暂无"}
							</div>
						</div>
						<div className="rounded-lg p-3" style={{ background: "var(--surface-2)" }}>
							<div className="stats-text-xs stats-text-muted">花费最多项目</div>
							<div className="stats-font-semibold stats-text-primary mt-1 truncate">
								{topProject?.project ?? "暂无"}
							</div>
						</div>
					</div>
				</div>
			</div>

			<div className="stats-usage-filter-bar">
				<div>
					<div className="stats-text-xs stats-text-muted uppercase tracking-wider">筛选范围</div>
					<div className="stats-text-sm stats-text-secondary mt-1">选择服务商或模型，下面所有指标同步更新</div>
				</div>
				<div className="stats-usage-filter-controls">
					<label className="stats-usage-filter-field">
						<span>服务商</span>
						<select
							className="stats-usage-filter-select"
							value={filter.provider ?? ""}
							onChange={event => onProviderChange(event.target.value || null)}
						>
							<option value="">全部服务商</option>
							{analytics.options.providers.map(provider => (
								<option key={provider} value={provider}>
									{provider}
								</option>
							))}
						</select>
					</label>
					<label className="stats-usage-filter-field">
						<span>模型</span>
						<select
							className="stats-usage-filter-select"
							value={selectedModelKey}
							onChange={event => {
								const selected = modelOptions.find(
									item => `${item.provider}\u0000${item.model}` === event.target.value,
								);
								onModelChange(selected ?? null);
							}}
						>
							<option value="">全部模型</option>
							{modelOptions.map(item => (
								<option key={`${item.provider}:${item.model}`} value={`${item.provider}\u0000${item.model}`}>
									{filter.provider ? item.model : `${item.provider} · ${item.model}`}
								</option>
							))}
						</select>
					</label>
				</div>
			</div>

			<div className="stats-metric-primary-grid">
				<MetricCard
					label="请求次数"
					value={formatInteger(summary.totalRequests)}
					detail={`${formatInteger(summary.successfulRequests)} 次成功`}
					primary
				/>
				<MetricCard
					label="成功率"
					value={formatPercent(summary.successRate)}
					detail={`${formatInteger(summary.failedRequests)} 次失败`}
					primary
				/>
				<MetricCard
					label="缓存命中率"
					value={formatPercent(summary.cacheRate)}
					detail={`${formatInteger(summary.totalCacheReadTokens)} cache read`}
					primary
				/>
				<MetricCard
					label="平均每次花费"
					value={formatCost(summary.totalRequests ? summary.totalCost / summary.totalRequests : 0, 4)}
					detail="总花费 ÷ 请求次数"
					primary
				/>
			</div>

			<div className="stats-metric-secondary-grid">
				<MetricCard
					label="输入 Token"
					value={formatInteger(summary.totalInputTokens)}
					detail={formatCost(summary.costInput, 4)}
				/>
				<MetricCard
					label="输出 Token"
					value={formatInteger(summary.totalOutputTokens)}
					detail={formatCost(summary.costOutput, 4)}
				/>
				<MetricCard
					label="Cache Read"
					value={formatInteger(summary.totalCacheReadTokens)}
					detail={formatCost(summary.costCacheRead, 4)}
				/>
				<MetricCard
					label="Cache Write"
					value={formatInteger(summary.totalCacheWriteTokens)}
					detail={formatCost(summary.costCacheWrite, 4)}
				/>
				<MetricCard label="首字延迟" value={formatDurationMs(summary.avgTtft)} detail="平均 TTFT" />
				<MetricCard
					label="输出速度"
					value={formatTokensPerSecond(summary.weightedTokensPerSecond)}
					detail="加权 Token/s"
				/>
			</div>

			<Panel
				title="消耗趋势"
				subtitle="同一时间窗口内的花费、Token 与请求量"
				actions={<SegmentedControl options={TREND_OPTIONS} value={trendMetric} onChange={setTrendMetric} />}
			>
				<div className="h-[280px]">
					{chartData.labels.length > 0 ? (
						<Line data={chartData} options={chartOptions} />
					) : (
						<div className="h-full flex items-center justify-center stats-text-muted text-sm">
							这个时间段还没有请求
						</div>
					)}
				</div>
			</Panel>

			<div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
				<Panel title="Token 构成" subtitle="输入、输出与缓存 Token 的真实占比">
					<BreakdownList
						items={[
							{ label: "输入", value: summary.totalInputTokens, color: "#ed4abf" },
							{ label: "输出", value: summary.totalOutputTokens, color: "#9b4dff" },
							{ label: "Cache Read", value: summary.totalCacheReadTokens, color: "#5ad8e6" },
							{ label: "Cache Write", value: summary.totalCacheWriteTokens, color: "#f5c14b" },
						]}
						total={summary.totalTokens}
						formatter={formatInteger}
					/>
					<div className="border-t border-stats-border mt-5 pt-4 flex items-center justify-between">
						<span className="stats-text-secondary text-sm">Token 总量</span>
						<strong className="stats-text-primary tabular-nums">{formatInteger(summary.totalTokens)}</strong>
					</div>
				</Panel>

				<Panel title="成本构成" subtitle="按实际记录的输入、输出和缓存成本拆分">
					<BreakdownList
						items={[
							{ label: "输入成本", value: summary.costInput, color: "#ed4abf" },
							{ label: "输出成本", value: summary.costOutput, color: "#9b4dff" },
							{ label: "Cache Read", value: summary.costCacheRead, color: "#5ad8e6" },
							{ label: "Cache Write", value: summary.costCacheWrite, color: "#f5c14b" },
						]}
						total={summary.totalCost}
						formatter={value => formatCost(value, 4)}
					/>
					<div className="border-t border-stats-border mt-5 pt-4 flex items-center justify-between">
						<span className="stats-text-secondary text-sm">总花费</span>
						<strong className="stats-text-primary tabular-nums">{formatCost(summary.totalCost)}</strong>
					</div>
				</Panel>
			</div>

			<Panel
				title="消耗排行榜"
				subtitle="切换维度和排序指标，直接定位主要消耗来源"
				actions={
					<div className="flex flex-wrap gap-2">
						<SegmentedControl options={RANKING_TAB_OPTIONS} value={rankingTab} onChange={setRankingTab} />
						<SegmentedControl
							options={RANKING_METRIC_OPTIONS}
							value={rankingMetric}
							onChange={setRankingMetric}
						/>
					</div>
				}
			>
				{rankingRows.length === 0 ? (
					<div className="stats-table-empty">这个时间段还没有可排名的数据</div>
				) : (
					<div className="stats-table-container">
						<table className="stats-table">
							<thead>
								<tr className="stats-table-tr">
									<th className="stats-table-th stats-text-left">名称</th>
									<th className="stats-table-th stats-text-right">花费</th>
									<th className="stats-table-th stats-text-right">Token</th>
									<th className="stats-table-th stats-text-right">请求</th>
									<th className="stats-table-th stats-text-right">成功率</th>
									<th className="stats-table-th stats-text-right">速度</th>
								</tr>
							</thead>
							<tbody>
								{rankingRows.map((row, index) => (
									<tr key={row.key} className="stats-table-tr">
										<td className="stats-table-td">
											<div className="flex items-center gap-3">
												<span className="stats-text-muted text-xs w-4">{index + 1}</span>
												<div className="min-w-0">
													<div className="stats-font-medium stats-text-primary truncate">{row.name}</div>
													<div className="stats-text-xs stats-text-muted truncate">{row.subtitle}</div>
												</div>
											</div>
										</td>
										<td className="stats-table-td stats-text-right">{formatCost(row.cost, 4)}</td>
										<td className="stats-table-td stats-text-right">{formatInteger(row.tokens)}</td>
										<td className="stats-table-td stats-text-right">{formatInteger(row.requests)}</td>
										<td className="stats-table-td stats-text-right">{formatPercent(row.successRate)}</td>
										<td className="stats-table-td stats-text-right">{formatTokensPerSecond(row.speed)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>
		</div>
	);
}
export function OverviewRoute({ active, range, refreshTrigger }: OverviewRouteProps) {
	const [filter, setFilter] = useState<UsageAnalyticsFilter>({ provider: null, model: null });
	const {
		data: analytics,
		error: analyticsError,
		loading: analyticsLoading,
	} = useResource(
		["usage-analytics", range, filter.provider, filter.model, refreshTrigger],
		signal => getUsageAnalyticsStats(range, filter, signal),
		{
			pollMs: 30000,
			enabled: active,
		},
	);

	return (
		<AsyncBoundary loading={analyticsLoading} error={analyticsError} data={analytics}>
			{analytics && (
				<UsageDashboard
					analytics={analytics}
					range={range}
					filter={filter}
					onProviderChange={provider => setFilter({ provider, model: null })}
					onModelChange={selection => setFilter(selection ?? { provider: null, model: null })}
				/>
			)}
		</AsyncBoundary>
	);
}
