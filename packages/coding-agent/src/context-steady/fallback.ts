/**
 * Deterministic fallback TurnDigest generator.
 *
 * Produces a schema-complete TurnDigest without any LLM call.
 * Used when:
 *   - No summary model is available
 *   - LLM digest fails or times out
 *   - san.contextSteady.digest.persistFallback forces fallback-only mode
 *
 * All types are inlined to avoid importing @oh-my-pi/pi-agent-core
 * which transitively loads native modules via tokenizer → pi-natives.
 */

import type { TurnDigest, TurnDigestFile, TurnDigestSource, TurnDigestToolEvidence } from "./types";
import { TURN_DIGEST_SCHEMA_VERSION } from "./types";

// ── Inlined message shapes (compatible with AgentMessage / Message) ─────────

interface InlinedToolCall {
	type: "toolCall";
	id: string;
	name: string;
	args?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
}

interface InlinedTextBlock {
	type: "text";
	text: string;
}

type InlinedContentBlock = InlinedTextBlock | InlinedToolCall | { type: string; [k: string]: unknown };

interface InlinedMessage {
	role: string;
	content: string | InlinedContentBlock[];
	timestamp: number;
	provider: string;
	model: string;
	status?: string;
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
	entryId?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

// ── ID generation ───────────────────────────────────────────────────────────

/** Generate a unique turn ID without depending on session-migrations. */
export function generateTurnId(): string {
	return `turn_${crypto.randomUUID().slice(-12)}`;
}

// ── Limits ──────────────────────────────────────────────────────────────────

const MAX_ARRAY_ITEMS = 20;
const MAX_FILE_ITEMS = 50;

function truncate<T>(arr: T[], max: number): T[] {
	return arr.length <= max ? arr : arr.slice(0, max);
}

// ── File collection ─────────────────────────────────────────────────────────

function collectFiles(msgs: readonly InlinedMessage[]): TurnDigestFile[] {
	const seen = new Set<string>();
	const files: TurnDigestFile[] = [];

	for (const m of msgs) {
		if (m.role === "toolResult") {
			const p = typeof m.details?.path === "string" ? m.details.path : undefined;
			if (p && !seen.has(p)) {
				seen.add(p);
				files.push({ path: p, action: guessAction(m.toolName ?? "") });
			}
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type === "toolCall" && "name" in b) {
					const tc = b as InlinedToolCall;
					const p = extractPath(tc);
					if (p && !seen.has(p)) {
						seen.add(p);
						files.push({ path: p, action: guessAction(tc.name) });
					}
				}
			}
		}
	}
	return truncate(files, MAX_FILE_ITEMS);
}

function guessAction(tool: string): TurnDigestFile["action"] {
	if (tool === "write") return "created";
	if (tool === "edit" || tool === "apply_patch" || tool === "replace" || tool === "patch") return "modified";
	if (tool === "read" || tool === "glob" || tool === "grep" || tool === "lsp") return "read";
	return "unknown";
}

function extractPath(tc: InlinedToolCall): string | undefined {
	const a = tc.args ?? tc.arguments ?? {};
	if (typeof a.filePath === "string") return a.filePath;
	if (typeof a.path === "string") return a.path;
	if (typeof a.file_path === "string") return a.file_path;
	return undefined;
}

// ── Tool evidence collection ────────────────────────────────────────────────

function collectTools(msgs: readonly InlinedMessage[]): TurnDigestToolEvidence[] {
	const ev: TurnDigestToolEvidence[] = [];
	for (const m of msgs) {
		if (m.role === "toolResult") {
			ev.push({
				tool: m.toolName ?? "unknown",
				summary: toolSummary(m),
				entryIds: m.entryId ? [m.entryId] : undefined,
			});
		}
	}
	return truncate(ev, MAX_ARRAY_ITEMS);
}

function toolSummary(m: InlinedMessage): string {
	const st = toolResultStatus(m);
	const p = typeof m.details?.path === "string" ? m.details.path : undefined;
	let s = `${m.toolName ?? "unknown"}: ${st}`;
	if (st === "error" && typeof m.details?.error === "string") {
		const e = m.details.error;
		s += ` — ${e.length > 80 ? `${e.slice(0, 80)}...` : e}`;
	}
	if (p) s += ` (${p})`;
	return s;
}

function toolResultStatus(m: InlinedMessage): string {
	if (typeof m.status === "string" && m.status.length > 0) return m.status;
	if (m.isError === true) return "error";
	return "completed";
}

// ── Text extraction ─────────────────────────────────────────────────────────

function msgText(m: InlinedMessage): string {
	if (typeof m.content === "string") return m.content.trim();
	return (m.content as InlinedContentBlock[])
		.filter((b): b is InlinedTextBlock => b.type === "text")
		.map(b => b.text)
		.join(" ")
		.trim();
}

function userIntent(msgs: readonly InlinedMessage[]): string {
	for (const m of msgs) {
		if (m.role === "user") {
			const t = msgText(m);
			return t.length > 200 ? `${t.slice(0, 197)}...` : t;
		}
	}
	return "System-driven continuation";
}

function collectDecisions(text: string): string[] {
	const decisions: string[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		if (/\b(I('ll| will)|let'?s|we('ll| will)|decided to|choosing to|going to|plan to|should)\b/i.test(t)) {
			decisions.push(t.length > 120 ? `${t.slice(0, 117)}...` : t);
		}
	}
	return truncate(decisions, MAX_ARRAY_ITEMS);
}

function collectLineMatches(text: string, patterns: readonly RegExp[]): string[] {
	const matches: string[] = [];
	for (const line of text.split("\n")) {
		const t = line.replace(/^[-*]\s*/, "").trim();
		if (!t) continue;
		if (!patterns.some(pattern => pattern.test(t))) continue;
		matches.push(t.length > 120 ? `${t.slice(0, 117)}...` : t);
	}
	return truncate(matches, MAX_ARRAY_ITEMS);
}

function collectAllDecisions(msgs: readonly InlinedMessage[]): string[] {
	const decisions: string[] = [];
	for (const m of msgs) {
		if (m.role !== "assistant") continue;
		decisions.push(...collectDecisions(msgText(m)));
		if (decisions.length >= MAX_ARRAY_ITEMS) break;
	}
	return truncate(decisions, MAX_ARRAY_ITEMS);
}

function collectAssistantLineMatches(msgs: readonly InlinedMessage[], patterns: readonly RegExp[]): string[] {
	const matches: string[] = [];
	for (const m of msgs) {
		if (m.role !== "assistant") continue;
		matches.push(...collectLineMatches(msgText(m), patterns));
		if (matches.length >= MAX_ARRAY_ITEMS) break;
	}
	return truncate(matches, MAX_ARRAY_ITEMS);
}

function tokenStats(msgs: readonly InlinedMessage[]): TurnDigest["tokenStats"] {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0;
	for (const m of msgs) {
		if (m.role === "assistant" && m.usage) {
			input += m.usage.input ?? 0;
			output += m.usage.output ?? 0;
			cacheRead += m.usage.cacheRead ?? 0;
			cacheWrite += m.usage.cacheWrite ?? 0;
		}
	}
	const total = input + output + cacheRead + cacheWrite;
	return total > 0 ? { input, output, cacheRead, cacheWrite, total } : undefined;
}

function extractModel(msgs: readonly InlinedMessage[]): string | undefined {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "assistant") return `${m.provider}/${m.model}`;
	}
	return undefined;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a deterministic fallback TurnDigest from agent messages.
 * Accepts any message-like objects with role/content.
 * Never throws — always returns a schema-complete digest.
 */
export function generateFallbackDigest(
	msgs: readonly InlinedMessage[],
	source: TurnDigestSource,
	turnId: string,
	sessionId: string,
	model?: string,
): TurnDigest {
	const tools = collectTools(msgs);

	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId,
		createdAt: new Date().toISOString(),
		model: model ?? extractModel(msgs),
		source,
		userIntent: userIntent(msgs),
		actionsTaken: tools.map(t => t.summary),
		decisions: collectAllDecisions(msgs),
		filesTouched: collectFiles(msgs),
		toolEvidence: tools,
		factsLearned: collectAssistantLineMatches(msgs, [
			/\b(evidence|found|observed|confirmed|verified|result|shows|means)\b/i,
			/(证据|发现|观察到|确认|验证|结果|说明|表明)/u,
		]),
		openQuestions: collectAssistantLineMatches(msgs, [
			/\b(open question|unknown|unclear|not covered|still need|needs follow-up)\b/i,
			/(未覆盖|不确定|还需要|待确认|待验证|开放问题)/u,
		]),
		risks: collectAssistantLineMatches(msgs, [
			/\b(risk|risky|could fail|may fail|edge case|not safe|over-prun|under-prun)\b/i,
			/(风险|可能失败|边界|误剪|过剪|漏剪|不安全)/u,
		]),
		nextSteps: collectAssistantLineMatches(msgs, [
			/\b(next step|next|should|need to|follow[- ]?up|todo)\b/i,
			/(下一步|后续|应该|需要|待办|继续)/u,
		]),
		memoryCandidates: [],
		tokenStats: tokenStats(msgs),
		fallback: true,
	};
}
