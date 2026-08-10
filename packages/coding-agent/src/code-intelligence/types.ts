import type { OutputMeta } from "../tools/output-meta";

export type CodeIntelligenceProviderId = "codegraph" | "lsp-ast" | "text-fallback";

export type CodeIntelligenceFreshness = "fresh" | "pending-files" | "stale-index" | "unavailable";

export interface ExploreRequest {
	query: string;
	path: string;
	maxFiles: number;
}

export interface SourceLineRange {
	startLine: number;
	endLine: number;
}

/**
 * A provider-owned pointer into source. Providers never supply authoritative
 * source bytes: the runtime re-reads these ranges from disk before exposing
 * them, then records the exact file version in FileSnapshotStore.
 */
export interface SourceWindowHint {
	path: string;
	ranges: SourceLineRange[];
	symbols?: string[];
}

export interface CodeIntelligenceResult {
	provider: CodeIntelligenceProviderId;
	freshness: CodeIntelligenceFreshness;
	sourceWindows: SourceWindowHint[];
	relationships: string[];
	blastRadius: string[];
	pendingFiles?: string[];
	repositoryFileCount?: number;
}

export interface CodeIntelligenceProvider {
	explore(request: ExploreRequest, signal?: AbortSignal): Promise<CodeIntelligenceResult | null>;
}

export interface ExploreSourceWindow {
	path: string;
	startLine: number;
	endLine: number;
	evidenceRef: string;
	snapshotTag?: string;
}

export interface ExploreBackReference {
	path: string;
	startLine: number;
	endLine: number;
	evidenceRef: string;
}

export interface ExploreResultDetails {
	provider: CodeIntelligenceProviderId;
	freshness: CodeIntelligenceFreshness;
	sourceWindows: ExploreSourceWindow[];
	relationships: string[];
	blastRadius: string[];
	evidenceRefs: string[];
	pendingFiles?: string[];
	backReferences?: ExploreBackReference[];
	truncated: boolean;
	maxOutputChars: number;
	outputChars: number;
	/** Sanitized, width-bounded copy used only by the TUI renderer. */
	displayContent?: string;
	meta?: OutputMeta;
}
