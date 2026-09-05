import { replaceTabs, truncateToWidth } from "@san/tui";
import { formatDuration, formatNumber } from "@san/utils";
import chalk from "chalk";
import { createLiveBoard, type LiveBoardOutput } from "../cli/live-board";
import type { IfBenchFailure } from "./protocol";
import type { IfBenchModelReport, IfBenchObserver, IfBenchSummary, IfBenchTurnRecord } from "./runner";

const LADDER_WIDTH = 28;
const LABEL_WIDTH = 34;
const DETAIL_WIDTH = 120;
const FAILURE_TEXT: Record<IfBenchFailure, string> = {
	result: "wrong array",
	cat: "no cat sound",
	"result+cat": "wrong array + no cat sound",
	format: "no <result> block",
	provider: "provider error",
};

export interface IfBenchBoard extends IfBenchObserver {
	readonly interactive: boolean;
	log(text: string): void;
	close(): void;
}

interface RowState {
	startedAt: number;
	turn: number;
	actions: number;
	passed: number;
	failed: boolean;
	placement: string;
	lastDurationMs: number;
}

export interface IfBenchBoardMeta {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
}

export function createIfBenchBoard(
	meta: IfBenchBoardMeta,
	output: LiveBoardOutput = process.stdout,
	errors: LiveBoardOutput = process.stderr,
): IfBenchBoard {
	const rows = new Map<string, RowState>();
	const startedAt = Date.now();
	const board = createLiveBoard(spinner => renderLive(meta, rows, spinner, startedAt), output);

	return {
		interactive: board.interactive,
		log: board.log,
		modelStarted(label) {
			rows.set(label, {
				startedAt: Date.now(),
				turn: 0,
				actions: 0,
				passed: 0,
				failed: false,
				placement: "",
				lastDurationMs: 0,
			});
			board.repaint();
		},
		turnStarted(label, turn) {
			const row = rows.get(label);
			if (!row) return;
			row.turn = turn;
			board.repaint();
		},
		turnFinished(label, record) {
			const row = rows.get(label);
			if (row) {
				row.actions = record.cumulativeActions;
				row.placement = record.placement;
				row.lastDurationMs = record.durationMs;
				if (record.passed) row.passed = record.turn;
				else row.failed = true;
				board.repaint();
			}
			if (!board.interactive) {
				const sink = record.passed ? output : errors;
				sink.write(`${formatTurnLine(label, record)}\n`);
			}
		},
		modelFinished(report) {
			rows.delete(report.label);
			board.log(formatVerdict(report, meta));
			if (report.failure) {
				for (const line of failureDetail(report)) board.log(line);
			}
		},
		close: board.close,
	};
}

function renderLive(
	meta: IfBenchBoardMeta,
	rows: ReadonlyMap<string, RowState>,
	spinner: string,
	startedAt: number,
): string[] {
	if (rows.size === 0) return [];
	const deepest = Math.max(0, ...[...rows.values()].map(row => row.actions));
	const header =
		`${chalk.cyan(spinner)} ${chalk.bold("if-bench")} ${chalk.dim("·")} ` +
		`${rows.size} live ${chalk.dim("·")} ${deepest} actions ${chalk.dim("·")} ` +
		`${chalk.dim(`L=${meta.arrayLength} nya{1,${meta.nyaMax}}`)} ${chalk.dim("·")} ` +
		`${formatDuration(Date.now() - startedAt)}`;
	const lines = [header];
	for (const [label, row] of rows) {
		const meterCells = ladder(row, meta.maxTurns, spinner);
		const parts = [
			`turn ${Math.max(row.turn, 1)}/${meta.maxTurns}`,
			`${row.actions} acts`,
			formatDuration(Date.now() - row.startedAt),
		];
		if (row.placement) parts.push(chalk.dim(`cat@${row.placement}`));
		lines.push(`  ${chalk.yellow(spinner)} ${pad(label, LABEL_WIDTH)} ${meterCells} ${parts.join(chalk.dim(" · "))}`);
	}
	return lines;
}

function ladder(row: RowState, maxTurns: number, spinner: string): string {
	const width = Math.min(maxTurns, LADDER_WIDTH);
	const scale = width / maxTurns;
	const filled = Math.min(width, Math.round(row.passed * scale));
	const active = row.failed || filled >= width ? 0 : Math.max(0, Math.min(width - filled, Math.round(scale)) || 1);
	const rest = Math.max(0, width - filled - active);
	return (
		chalk.green("█".repeat(filled)) +
		(row.failed ? chalk.red("▚") : chalk.yellow(spinner.repeat(active))) +
		chalk.dim("░".repeat(rest))
	);
}

function pad(text: string, width: number): string {
	const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
	return clipped.padEnd(width);
}

function formatTurnLine(label: string, record: IfBenchTurnRecord): string {
	const head = `[turn ${record.turn}] ${label} ${record.cumulativeActions} acts cat@${record.placement}`;
	return record.passed
		? `${head} PASS ${formatDuration(Math.round(record.durationMs))}`
		: `${head} FAIL ${record.failure ?? "format"}`;
}

function formatVerdict(report: IfBenchModelReport, meta: IfBenchBoardMeta): string {
	const stats = [
		`${report.turnsPassed}/${meta.maxTurns} turns`,
		`${report.actionsPassed} actions`,
		`${formatDuration(Math.round(meanTurnMs(report)))}/turn`,
	];
	if (report.outputTokens > 0) stats.push(`${formatNumber(report.outputTokens)} tok`);
	if (report.cost > 0) stats.push(formatCost(report.cost));
	const body = `${chalk.bold(report.label)} ${stats.join(chalk.dim(" · "))}`;
	if (!report.failure) return `${chalk.green("✓")} ${body}`;
	return `${chalk.red("✗")} ${body} ${chalk.dim("·")} ${chalk.red(`broke on turn ${report.failure.turn}: ${FAILURE_TEXT[report.failure.kind]}`)}`;
}

function failureDetail(report: IfBenchModelReport): string[] {
	const failed = report.turns[report.turns.length - 1];
	if (!failed) return [];
	const oneLine = (text: string): string =>
		truncateToWidth(replaceTabs(text).replace(/\s+/g, " ").trim(), DETAIL_WIDTH);
	if (failed.failure === "provider") return [`    ${chalk.dim("provider")} ${chalk.red(oneLine(failed.response))}`];
	return [
		`    ${chalk.dim("expected")} <${failed.expected}>`,
		`    ${chalk.dim("actual  ")} ${oneLine(failed.response)}`,
	];
}

function meanTurnMs(report: IfBenchModelReport): number {
	return report.turns.length === 0 ? 0 : report.durationMs / report.turns.length;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

interface ScoreboardColumn {
	header: string;
	value(report: IfBenchModelReport): string;
	align?: "right";
}

export function formatIfBenchScoreboard(summary: IfBenchSummary): string {
	const ranked = [...summary.models].sort(
		(left, right) =>
			right.turnsPassed - left.turnsPassed ||
			right.actionsPassed - left.actionsPassed ||
			meanTurnMs(left) - meanTurnMs(right),
	);
	const columns: ScoreboardColumn[] = [
		{ header: "model", value: report => report.label },
		{ header: "turns", value: report => `${report.turnsPassed}/${summary.maxTurns}`, align: "right" },
		{ header: "actions", value: report => String(report.actionsPassed), align: "right" },
		{
			header: "broke on",
			value: report =>
				report.failure ? `turn ${report.failure.turn} · ${FAILURE_TEXT[report.failure.kind]}` : "survived",
		},
		{ header: "per turn", value: report => formatDuration(Math.round(meanTurnMs(report))), align: "right" },
		{
			header: "tokens",
			value: report => (report.outputTokens > 0 ? formatNumber(report.outputTokens) : "-"),
			align: "right",
		},
		{ header: "cost", value: report => (report.cost > 0 ? formatCost(report.cost) : "-"), align: "right" },
	];
	const cells = ranked.map(report => columns.map(column => column.value(report)));
	const widths = columns.map((column, index) =>
		Math.max(column.header.length, ...cells.map(row => row[index]!.length)),
	);
	const layout = (row: string[]): string =>
		row
			.map((cell, index) =>
				columns[index]!.align === "right" ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!),
			)
			.join("  ")
			.trimEnd();
	const lines = [chalk.dim(layout(columns.map(column => column.header)))];
	for (const [index, row] of cells.entries()) {
		const line = layout(row);
		lines.push(index === 0 && ranked[0]!.turnsPassed > 0 ? chalk.green(line) : line);
	}
	return `${lines.join("\n")}\n`;
}
