/**
 * San RPC v2 Evidence Generator.
 *
 * Generates EvidenceRecord entries from tool execution results.
 * Evidence is append-only and tied to deterministic tool outcomes.
 */
import type { EvidenceKind, EvidenceRecord, EvidenceVerdict } from "./dto/evidence";
import type { EventId, RunId, SessionId, ToolCallId, TurnId } from "./protocol/ids";
import { newEvidenceId } from "./protocol/ids";

interface ToolCompletionInfo {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	result?: unknown;
	durationMs?: number;
}

/** Classify a tool into an evidence kind. */
function classifyTool(toolName: string): EvidenceKind {
	const name = toolName.toLowerCase();
	if (name === "bash" || name === "execute" || name === "shell") return "command_result";
	if (name.includes("test") || name.includes("jest") || name.includes("vitest")) return "test_result";
	if (name === "write" || name === "edit" || name === "apply_patch" || name === "create_file") return "file_change";
	return "tool_result";
}

/** Determine verdict from tool outcome. */
function determineVerdict(kind: EvidenceKind, isError: boolean, result: unknown): EvidenceVerdict {
	if (kind === "command_result" || kind === "test_result") {
		if (isError) return "failed";
		// Check for exit code in result
		if (typeof result === "object" && result !== null && "exitCode" in result) {
			return (result as { exitCode: number }).exitCode === 0 ? "passed" : "failed";
		}
		return isError ? "failed" : "passed";
	}
	if (kind === "file_change") {
		return isError ? "failed" : "passed";
	}
	return isError ? "failed" : "informational";
}

/** Build a title from tool info. */
function buildTitle(toolName: string, kind: EvidenceKind): string {
	switch (kind) {
		case "command_result":
			return `Command: ${toolName}`;
		case "test_result":
			return `Test: ${toolName}`;
		case "file_change":
			return `File change: ${toolName}`;
		default:
			return `Tool: ${toolName}`;
	}
}

/**
 * Generate an evidence record from a tool completion event.
 * Only deterministic tools produce passed/failed verdicts.
 */
export function generateToolEvidence(
	info: ToolCompletionInfo,
	context: { sessionId: SessionId; runId?: RunId; turnId?: TurnId; eventId?: EventId; sequence?: number },
): EvidenceRecord {
	const kind = classifyTool(info.toolName);
	const verdict = determineVerdict(kind, info.isError, info.result);

	const details: EvidenceRecord["details"] = {};
	if (typeof info.result === "object" && info.result !== null) {
		const r = info.result as Record<string, unknown>;
		if ("command" in r && typeof r.command === "string") details.command = r.command;
		if ("cwd" in r && typeof r.cwd === "string") details.cwd = r.cwd;
		if ("exitCode" in r && typeof r.exitCode === "number") details.exitCode = r.exitCode;
		if ("path" in r && typeof r.path === "string") details.path = r.path;
	}
	if (info.durationMs !== undefined) details.durationMs = info.durationMs;

	return {
		schemaVersion: 1,
		evidenceId: newEvidenceId(),
		sessionId: context.sessionId,
		runId: context.runId,
		turnId: context.turnId,
		createdAt: new Date().toISOString(),
		kind,
		verdict,
		title: buildTitle(info.toolName, kind),
		summary: info.isError ? `${info.toolName} failed` : `${info.toolName} completed`,
		source: {
			kind: "deterministic_tool",
			toolCallId: info.toolCallId as ToolCallId,
			eventId: context.eventId,
			sequence: context.sequence,
		},
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/**
 * In-memory evidence ledger for the current session.
 * Append-only; corrections use supersedes records.
 */
export class EvidenceLedger {
	#records: EvidenceRecord[] = [];

	append(record: EvidenceRecord): void {
		this.#records.push(record);
	}

	list(options?: { kinds?: EvidenceKind[]; verdicts?: EvidenceVerdict[]; limit?: number; offset?: number }): {
		evidence: EvidenceRecord[];
		total: number;
	} {
		let filtered = this.#records;
		if (options?.kinds?.length) {
			filtered = filtered.filter(r => options.kinds!.includes(r.kind));
		}
		if (options?.verdicts?.length) {
			filtered = filtered.filter(r => options.verdicts!.includes(r.verdict));
		}
		const total = filtered.length;
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 50;
		return { evidence: filtered.slice(offset, offset + limit), total };
	}

	get summary(): { total: number; passed: number; failed: number; latest: EvidenceRecord[] } {
		return {
			total: this.#records.length,
			passed: this.#records.filter(r => r.verdict === "passed").length,
			failed: this.#records.filter(r => r.verdict === "failed").length,
			latest: this.#records.slice(-5),
		};
	}
}
