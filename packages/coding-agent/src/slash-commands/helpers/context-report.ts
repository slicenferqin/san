import { contextProbeFilePath } from "../../context-steady/probe";
import { computeContextBreakdown } from "../../modes/utils/context-usage";
import type { SessionManager } from "../../session/session-manager";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "./format";

function renderContextPath(value: string): string {
	return truncateToWidth(replaceTabs(shortenPath(value)), TRUNCATE_LENGTHS.LINE);
}

export function buildContextSessionMetadataText(sessionManager: SessionManager): string {
	const sessionId = sessionManager.getSessionId();
	const sessionFile = sessionManager.getSessionFile();
	const lines = [
		`Session ID: ${sessionId || "Unavailable"}`,
		`Session file: ${sessionFile ? renderContextPath(sessionFile) : "In-memory"}`,
		`Context probe: ${sessionFile ? renderContextPath(contextProbeFilePath(sessionFile)) : "Unavailable (in-memory session)"}`,
	];
	if (typeof sessionManager.getUsageStatistics === "function") {
		const usage = sessionManager.getUsageStatistics();
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const cacheRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : 0;
		lines.push(
			`Cache read: ${usage.cacheRead.toLocaleString()}/${promptTokens.toLocaleString()} prompt tokens (${cacheRate.toFixed(1)}%)`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	const metadata = buildContextSessionMetadataText(runtime.sessionManager);
	try {
		const breakdown = computeContextBreakdown(runtime.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			return `${metadata}\n\nContext usage is unavailable: no model is selected for this session.`;
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [metadata, "", `Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens`);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.autoCompactBufferTokens} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.freeTokens} tokens`);
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push("Snapcompact: inactive (model has no image input)");
			} else {
				lines.push("Snapcompact (estimated wire savings):");
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? `  System prompt: ${sp.textTokens} text tokens → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${sp.imageTokens} tokens (saves ~${sp.savedTokens})`
							: "  System prompt: stays text (no net savings)",
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? `  Tool results: ${tr.swapped} of ${tr.total} imaged, ${tr.textTokens} text tokens → ${tr.frames} frames ≈ ${tr.imageTokens} tokens (saves ~${tr.savedTokens})`
							: `  Tool results: none imaged (${tr.total} in history)`,
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(`  Estimated next request: ~${breakdown.usedTokens - snap.savedTokens} tokens on the wire`);
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return `${metadata}\n\nContext usage is unavailable.`;
		return [metadata, "", "Context", `Window: ${fallback.contextWindow}`, `Used: ${fallback.tokens ?? 0}`].join("\n");
	}
}
