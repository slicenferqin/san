/**
 * San RPC v2 Session DTOs.
 */

import type { LeaseId, RunId, RuntimeId, SessionId } from "../protocol/ids";
import type { RecoveryReason, RecoveryStrategy, SessionPersistedStatus, Timestamp } from "../protocol/lifecycle";
import type { ApprovalRequest } from "./approval";
import type { ContinuitySnapshot } from "./context";
import type { EvidenceRecord } from "./evidence";
import type { SessionRuntimeSettings, SubagentSnapshot } from "./integration";
import type { InteractionRequest } from "./interaction";
import type { QueueItem, RunSnapshot } from "./run";

// ============================================================================
// Session Summary (index entry)
// ============================================================================

export interface SessionSummary {
	schemaVersion: 1;
	sessionId: SessionId;
	title?: string;
	cwd: string;
	parentSessionId?: SessionId;
	createdAt: Timestamp;
	updatedAt: Timestamp;
	persistedStatus: SessionPersistedStatus;
	access?: "closed" | "read_only" | "read_write" | "locked";
	/** Cross-client user flags owned by the San runtime; absent when never set. */
	pinned?: boolean;
	archived?: boolean;
	unread?: boolean;
	/** 项目分组元数据（server 侧 git 探测）；非 git cwd 或探测失败时省略。 */
	projectRoot?: string;
	gitCommonDir?: string;
	branch?: string;
	attention: SessionAttention[];
	messageCount: number;
	sizeBytes: number;
	lastSequence: number;
	latestRun?: Pick<RunSnapshot, "runId" | "status" | "startedAt" | "finishedAt">;
	evidenceCount?: number;
	checkpoint?: { checkpointId: string; createdAt: Timestamp };
}

export type SessionAttention = "approval" | "input" | "retry" | "failure" | "recovery";

// ============================================================================
// Session Snapshot (full state from sync)
// ============================================================================

export interface SessionSnapshot {
	schemaVersion: 1;
	session: SessionSummary;
	runtimeId: RuntimeId;
	leaseId: LeaseId;
	revision: number;
	asOfSequence: number;
	lifecycle: "ready" | "recovering" | "read_only" | "corrupt";
	recovery?: RecoveryDescriptor;
	activeRun?: RunSnapshot;
	lastRun?: RunSnapshot;
	queue: QueueItem[];
	pendingApprovals: ApprovalRequest[];
	pendingInteractions: InteractionRequest[];
	todoPhases: TodoPhaseSnapshot[];
	goal?: GoalSnapshot;
	planMode?: PlanModeSnapshot;
	model?: ModelSnapshot;
	thinking: { configured?: string; effective?: string };
	settings: SessionRuntimeSettings;
	context: ContinuitySnapshot;
	subagents: SubagentSnapshot[];
	evidence: EvidenceSummary;
	commandCatalogRevision: number;
	activeStreams?: ActiveStreamSnapshot[];
}

export type ActiveStreamSnapshot =
	| {
			kind: "message";
			messageId: string;
			role: string;
			content: string;
			truncated: boolean;
	  }
	| {
			kind: "tool";
			toolCallId: string;
			toolName: string;
			status: "running";
	  };

export interface TodoPhaseSnapshot {
	name: string;
	status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked";
	description?: string;
}

export interface GoalSnapshot {
	text: string;
	budget?: { maxTurns?: number; maxTokens?: number; maxCostUsd?: number };
	progress?: string;
}

export interface PlanModeSnapshot {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}

export interface ModelSnapshot {
	provider: string;
	modelId: string;
	displayName?: string;
	contextWindow?: number;
	logicalModel?: string;
	routeId?: string;
}

export interface EvidenceSummary {
	total: number;
	passed: number;
	failed: number;
	latest: EvidenceRecord[];
}

// ============================================================================
// Transcript messages (persisted history, independent of the event journal)
// ============================================================================

/**
 * 一条持久化的会话消息投影。事件日志只覆盖当前 Runtime，CLI 创建的会话
 * 没有 journal，客户端只能从这里拿到历史正文。
 */
export interface SessionMessage {
	role: "user" | "assistant";
	timestamp: Timestamp;
	content: string;
	truncated?: boolean;
	entryId?: string;
	thinking?: string;
	/** 助手消息的结束方式；"aborted"/"error" 意味着正文可能是中断的半截。 */
	stopReason?: string;
	/** stopReason 为 "error" 时的失败归因（如进程退出前未完成本轮）。 */
	errorMessage?: string;
	toolCalls?: Array<{
		toolCallId: string;
		toolName: string;
		isError: boolean;
		intent?: string;
		/** Compact command/path projection of the call arguments (display label). */
		args?: { command?: string; path?: string };
	}>;
}

// ============================================================================
// Recovery
// ============================================================================

export interface RecoveryDescriptor {
	required: boolean;
	reason: RecoveryReason;
	previousRuntimeId?: RuntimeId;
	lastStableSequence: number;
	interruptedRunId?: RunId;
	allowedStrategies: RecoveryStrategy[];
}

// ============================================================================
// Sync
// ============================================================================

export interface SyncResult {
	mode: "snapshot" | "replay";
	subscriptionId: string;
	asOfSequence: number;
	snapshot?: Record<string, unknown>;
	events?: unknown[];
}

export interface StreamPolicy {
	subagents?: "off" | "progress" | "events";
	thinkingDeltas?: boolean;
	maxTransientEventsPerSecond?: number;
}
