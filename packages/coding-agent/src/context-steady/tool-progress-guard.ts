import type { AssistantMessage, ToolCall, ToolResultMessage } from "@san/ai";
import { INTENT_FIELD } from "@san/wire";

const LEGACY_INTENT_FIELD = "__intent";
const VOLATILE_ARGUMENT_KEYS: ReadonlySet<string> = new Set([INTENT_FIELD, LEGACY_INTENT_FIELD, "toolCallId"]);
const MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "ast_edit", "memory_edit", "manage_skill"]);
const OBSERVATION_PATH_KEYS = ["path", "filePath", "file_path", "url", "uri"] as const;
const OBSERVATION_SCOPE_KEYS = ["offset", "limit", "range", "line", "start", "end", "cwd"] as const;
const SEARCH_QUERY_KEYS = ["query", "pattern", "regex", "search", "symbol"] as const;
const VERIFICATION_COMMAND_RE =
	/(?:^|[;&|]\s*|\s)(?:bun\s+(?:run\s+)?(?:test|check)|npm\s+(?:run\s+)?(?:test|check|build|lint)|pnpm\s+(?:run\s+)?(?:test|check|build|lint)|yarn\s+(?:run\s+)?(?:test|check|build|lint)|pytest|vitest|jest|cargo\s+(?:test|check|build)|go\s+test|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build))(?:\s|$)/i;

export type ToolProgressGuardMode = "observe" | "soft" | "hard";
export type ToolProgressGuardState = "tracking" | "soft_redirect" | "finalize_required";

export interface ToolProgressGuardOptions {
	mode: ToolProgressGuardMode;
	repeatThreshold: number;
	saturationWindow: number;
	saturationMaxResources: number;
	finalizeAfterNoProgress: number;
	historyLimit: number;
	exemptTools: readonly string[];
}

export interface ToolProgressGuardTurn {
	message: AssistantMessage;
	toolResults: readonly ToolResultMessage[];
}

export interface ToolProgressGuardSnapshot {
	state: ToolProgressGuardState;
	actionRepeatCount: number;
	noEvidenceCount: number;
	uniqueResourceCount: number;
	softRedirects: number;
	forcedFinalizations: number;
	mutationCount: number;
	verificationCount: number;
	observationCount: number;
}

export interface ToolProgressGuardDetection {
	kind: "soft_redirect" | "finalize_required";
	reason: "repeated_result" | "observation_saturation" | "post_redirect_no_progress";
	repeatedTools: string[];
	snapshot: ToolProgressGuardSnapshot;
}

type ObservationKind = "mutation" | "verification" | "observation";

interface ProgressObservation {
	toolName: string;
	kind: ObservationKind;
	actionFingerprint: string;
	evidenceFingerprint: string;
	resourceFingerprint: string;
	progress: boolean;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (VOLATILE_ARGUMENT_KEYS.has(key)) continue;
		output[key] = canonicalize(input[key]);
	}
	return output;
}

function stableJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function fingerprint(value: string): string {
	return String(Bun.hash(value));
}

function normalizedText(result: ToolResultMessage): string {
	return result.content
		.map(block => {
			if (block.type === "text") return block.text.replace(/\r\n/g, "\n").trimEnd();
			return `${block.type}:${block.mimeType}:${fingerprint(block.data)}`;
		})
		.join("\n");
}

function recordField(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function actionFingerprint(call: ToolCall): string {
	return fingerprint(`${call.name}:${stableJson(call.arguments)}`);
}

function resourceFingerprint(call: ToolCall): string {
	const args = call.arguments as Record<string, unknown>;
	const pathValue = recordField(args, OBSERVATION_PATH_KEYS);
	const scope: Record<string, unknown> = {};
	for (const key of OBSERVATION_SCOPE_KEYS) {
		if (args[key] !== undefined) scope[key] = args[key];
	}
	const query = recordField(args, SEARCH_QUERY_KEYS);
	if (pathValue !== undefined) {
		return fingerprint(`${call.name}:resource:${stableJson({ path: pathValue, query, scope })}`);
	}

	if (call.name === "bash" || call.name === "eval") {
		const cwd = recordField(args, ["cwd", "workdir"]);
		return fingerprint(`${call.name}:execution:${stableJson({ cwd })}`);
	}

	if (query !== undefined) return fingerprint(`${call.name}:query:${stableJson({ query, scope })}`);
	return fingerprint(`${call.name}:default-scope`);
}

function stableEvidenceDetails(call: ToolCall, result: ToolResultMessage): unknown {
	if (!result.details || typeof result.details !== "object") return result.details;
	const details = result.details as Record<string, unknown>;
	if (call.name === "bash" || call.name === "eval") {
		const asyncDetails =
			details.async && typeof details.async === "object"
				? { state: (details.async as Record<string, unknown>).state }
				: undefined;
		return {
			exitCode: details.exitCode,
			...(asyncDetails ? { async: asyncDetails } : {}),
		};
	}
	if (call.name === "read") {
		return {
			resolvedPath: details.resolvedPath,
			suffixResolution: details.suffixResolution,
		};
	}
	if (
		call.name === "grep" ||
		call.name === "glob" ||
		call.name === "browser" ||
		call.name === "web_search" ||
		call.name === "search_tool_bm25"
	) {
		return undefined;
	}
	return details;
}

function evidenceFingerprint(call: ToolCall, result: ToolResultMessage): string {
	return fingerprint(
		stableJson({
			isError: result.isError === true,
			content: normalizedText(result),
			details: stableEvidenceDetails(call, result),
		}),
	);
}

function observationKind(call: ToolCall): ObservationKind {
	if (MUTATION_TOOLS.has(call.name)) return "mutation";
	if (call.name === "bash") {
		const command = (call.arguments as Record<string, unknown>).command;
		if (typeof command === "string" && VERIFICATION_COMMAND_RE.test(command)) return "verification";
	}
	return "observation";
}

function clampInteger(value: number, minimum: number): number {
	return Math.max(minimum, Math.floor(value));
}

/** 以当前真实用户 turn 为作用域，按动作与证据增量识别无效工具循环。 */
export class ToolProgressGuard {
	#mode: ToolProgressGuardMode;
	#repeatThreshold: number;
	#saturationWindow: number;
	#saturationMaxResources: number;
	#finalizeAfterNoProgress: number;
	#historyLimit: number;
	#exemptTools: ReadonlySet<string>;
	#history: ProgressObservation[] = [];
	#seenEvidence = new Set<string>();
	#seenResources = new Set<string>();
	#state: ToolProgressGuardState = "tracking";
	#turnSequence = 0;
	#redirectTurnSequence = 0;
	#noEvidenceAfterRedirect = 0;
	#actionRepeatCount = 0;
	#softRedirects = 0;
	#forcedFinalizations = 0;
	#mutationCount = 0;
	#verificationCount = 0;
	#observationCount = 0;
	#finalizationPending = false;

	constructor(options: ToolProgressGuardOptions) {
		this.#mode = options.mode;
		this.#repeatThreshold = clampInteger(options.repeatThreshold, 2);
		this.#saturationWindow = clampInteger(options.saturationWindow, 2);
		this.#saturationMaxResources = clampInteger(options.saturationMaxResources, 1);
		this.#finalizeAfterNoProgress = clampInteger(options.finalizeAfterNoProgress, 1);
		this.#historyLimit = Math.max(this.#saturationWindow, clampInteger(options.historyLimit, 2));
		this.#exemptTools = new Set(options.exemptTools);
	}

	reset(): void {
		this.#history = [];
		this.#seenEvidence.clear();
		this.#seenResources.clear();
		this.#state = "tracking";
		this.#turnSequence = 0;
		this.#redirectTurnSequence = 0;
		this.#noEvidenceAfterRedirect = 0;
		this.#actionRepeatCount = 0;
		this.#softRedirects = 0;
		this.#forcedFinalizations = 0;
		this.#mutationCount = 0;
		this.#verificationCount = 0;
		this.#observationCount = 0;
		this.#finalizationPending = false;
	}

	recordTurn(turn: ToolProgressGuardTurn): ToolProgressGuardDetection | null {
		this.#turnSequence++;
		const calls = turn.message.content.filter((block): block is ToolCall => block.type === "toolCall");
		const results = new Map(turn.toolResults.map(result => [result.toolCallId, result]));
		const observations: ProgressObservation[] = [];
		for (const call of calls) {
			if (this.#exemptTools.has(call.name)) continue;
			const result = results.get(call.id);
			if (!result) continue;
			const action = actionFingerprint(call);
			const evidence = evidenceFingerprint(call, result);
			const resource = resourceFingerprint(call);
			const kind = observationKind(call);
			const successful = result.isError !== true;
			const evidenceKey = `${kind}:${evidence}`;
			const resourceIsNew = !this.#seenResources.has(resource);
			const evidenceIsNew = !this.#seenEvidence.has(evidenceKey);
			const progress = successful && (kind === "mutation" || resourceIsNew || evidenceIsNew);
			if (successful) {
				this.#seenResources.add(resource);
				this.#seenEvidence.add(evidenceKey);
				if (kind === "mutation") this.#mutationCount++;
				else if (kind === "verification" && progress) this.#verificationCount++;
			}
			if (kind === "observation") this.#observationCount++;
			observations.push({
				toolName: call.name,
				kind,
				actionFingerprint: action,
				evidenceFingerprint: evidence,
				resourceFingerprint: resource,
				progress,
			});
		}

		if (observations.length === 0) return null;
		const madeProgress = observations.some(observation => observation.progress);
		const resetsFingerprintHistory = observations.some(
			observation => observation.progress && observation.kind !== "observation",
		);
		if (madeProgress) {
			// 新证据重置无增量状态；mutation/verification 还会开启新的动作指纹区间，
			// 防止执行阶段转换前的观察历史提前触发下一次 redirect/finalize。
			if (resetsFingerprintHistory) this.#history = [];
			this.#state = "tracking";
			this.#noEvidenceAfterRedirect = 0;
			this.#finalizationPending = false;
		}
		this.#history.push(...observations);
		if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);

		const latest = this.#history.at(-1)!;
		const latestPair = `${latest.actionFingerprint}:${latest.evidenceFingerprint}`;
		this.#actionRepeatCount = this.#history.filter(
			observation => `${observation.actionFingerprint}:${observation.evidenceFingerprint}` === latestPair,
		).length;

		if (this.#state === "soft_redirect" && this.#turnSequence > this.#redirectTurnSequence) {
			this.#noEvidenceAfterRedirect = madeProgress
				? 0
				: this.#noEvidenceAfterRedirect + observations.filter(observation => !observation.progress).length;
			if (this.#mode === "hard" && this.#noEvidenceAfterRedirect >= this.#finalizeAfterNoProgress) {
				this.#state = "finalize_required";
				this.#finalizationPending = true;
				return this.#detection("finalize_required", "post_redirect_no_progress");
			}
		}

		if (this.#state !== "tracking") return null;
		const repeatedResult = this.#actionRepeatCount >= this.#repeatThreshold && !latest.progress;
		const observationWindow = this.#history.slice(-this.#saturationWindow);
		const saturatedObservations =
			observationWindow.length === this.#saturationWindow &&
			observationWindow.every(observation => observation.kind === "observation" && !observation.progress) &&
			new Set(observationWindow.map(observation => observation.resourceFingerprint)).size <=
				this.#saturationMaxResources;
		if (!repeatedResult && !saturatedObservations) return null;

		this.#state = "soft_redirect";
		this.#redirectTurnSequence = this.#turnSequence;
		this.#noEvidenceAfterRedirect = 0;
		if (this.#mode === "observe" || this.#softRedirects > 0) return null;
		this.#softRedirects++;
		return this.#detection("soft_redirect", repeatedResult ? "repeated_result" : "observation_saturation");
	}

	consumeForcedFinalization(): boolean {
		if (!this.#finalizationPending || this.#mode !== "hard") return false;
		this.#finalizationPending = false;
		this.#forcedFinalizations++;
		return true;
	}

	snapshot(): ToolProgressGuardSnapshot {
		return {
			state: this.#state,
			actionRepeatCount: this.#actionRepeatCount,
			noEvidenceCount: this.#noEvidenceAfterRedirect,
			uniqueResourceCount: this.#seenResources.size,
			softRedirects: this.#softRedirects,
			forcedFinalizations: this.#forcedFinalizations,
			mutationCount: this.#mutationCount,
			verificationCount: this.#verificationCount,
			observationCount: this.#observationCount,
		};
	}

	#detection(
		kind: ToolProgressGuardDetection["kind"],
		reason: ToolProgressGuardDetection["reason"],
	): ToolProgressGuardDetection {
		return {
			kind,
			reason,
			repeatedTools: [...new Set(this.#history.slice(-this.#saturationWindow).map(item => item.toolName))],
			snapshot: this.snapshot(),
		};
	}
}
