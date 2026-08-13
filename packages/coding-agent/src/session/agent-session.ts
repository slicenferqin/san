/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isPromise } from "node:util/types";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolResult,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	type CompactionSummaryMessage,
	countTokens,
	createToolScopedAbortReason,
	resolveTelemetry,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	ThinkingLevel,
	type ToolChoiceDirective,
} from "@san/agent";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	applyShakeRegions,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	collectShakeRegions,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	DEFAULT_SHAKE_CONFIG,
	effectiveReserveTokens,
	estimateTokens,
	generateBranchSummary,
	generateHandoffFromContext,
	prepareCompaction,
	renderHandoffPrompt,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	type SessionMessageEntry,
	type ShakeConfig,
	type ShakeRegion,
	type SummaryOptions,
	shouldCompact,
	shouldUseOpenAiRemoteCompaction,
} from "@san/agent/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@san/agent/compaction/pruning";
import type { ProtectedToolMatcher } from "@san/agent/compaction/tool-protection";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ProviderResponseMetadata,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	Usage,
	UsageReport,
} from "@san/ai";
import {
	calculateRateLimitBackoffMs,
	clearAnthropicFastModeFallback,
	deriveClaudeDeviceId,
	Effort,
	isUsageLimitOutcome,
	parseRateLimitReason,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	streamSimple,
} from "@san/ai";
import * as AIError from "@san/ai/error";
import { resetOpenAICodexHistoryAfterCompaction } from "@san/ai/providers/openai-codex-responses";
import { toolWireSchema } from "@san/ai/utils/schema";
import { GeminiHeaderRunDetector, isGeminiThinkingModel } from "@san/ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@san/ai/utils/tool-call-loop-guard";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@san/catalog/fireworks-model-id";
import { getSupportedEfforts } from "@san/catalog/model-thinking";
import { modelsAreEqual } from "@san/catalog/models";
import type { InMemorySnapshotStore } from "@san/hashline";
import { Patch } from "@san/hashline";
import { MacOSPowerAssertion } from "@san/natives";
import * as snapcompact from "@san/snapcompact";
import {
	escapeXmlText,
	extractHttpStatusFromError,
	extractRetryHint,
	formatDuration,
	getAgentDbPath,
	getInstallId,
	isBunTestRuntime,
	isEnoent,
	isRecord,
	logger,
	postmortem,
	prompt,
	relativePathWithinRoot,
	Snowflake,
	withTimeout,
} from "@san/utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	AdviseTool,
	type AdvisorAgent,
	type AdvisorConfig,
	AdvisorEmissionGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorRuntimeStatus,
	type AdvisorSeverity,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	annotateForStaleness,
	buildAdvisorQuarantineSourceText,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../advisor";
import { type AsyncJob, type AsyncJobDeliveryState, AsyncJobManager } from "../async";
import { classifyDifficulty } from "../auto-thinking/classifier";
import {
	BRAIN_STATE_MESSAGE_TYPE,
	buildSanBrainStatePrelude,
	finalizeSanBrainActivation,
	planSanBrainGlobalInjection,
	recordSanBrainActivationError,
	type SanBrainInjectionCandidate,
} from "../brain/activation";
import { runSanBrainAutoDecisions } from "../brain/auto-decision";
import { captureSanBrainTurn, recordSanBrainCaptureError } from "../brain/capture";
import {
	appendSanBrainActivation,
	appendSanBrainProjectionNotification,
	appendSanBrainRecallAudit,
} from "../brain/ledger";
import { runSanBrainProjections } from "../brain/projection";
import { buildSanBrainRecallPlan } from "../brain/recall";
import { resolveSanBrainRuntimePolicy } from "../brain/runtime-policy";
import { type SanBrainActiveStateRecord, SanBrainStore } from "../brain/store";
import type { SanBrainActivation, SanBrainScope } from "../brain/types";
import { reset as resetCapabilities } from "../capability";
import type { Rule } from "../capability/rule";
import { filterPresentedCodeGraphTools } from "../code-intelligence";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import type { ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatLogicalRouteFailure,
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelRouteRuntimeRejection,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds, MODEL_ROLE_IDS, MODEL_ROLES } from "../config/model-roles";
import type { ModelRouteResolutionRequest } from "../config/model-route-resolver";
import type { RouteFailureCategory } from "../config/model-routes-schema";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import type { Settings, SkillsSettings } from "../config/settings";
import {
	getDefault,
	onAppendOnlyModeChanged,
	onModelRolesChanged,
	validateProviderMaxInFlightRequests,
} from "../config/settings";
import { resolveDialect } from "../config/tool-dialect";
import { resolveContextPlanBudget } from "../context-steady/budget";
import { appendContextCheckpoint, buildContextCheckpoint } from "../context-steady/checkpoint";
import {
	appendActiveContinuationState,
	buildActiveContinuationState,
	findLatestActiveContinuationState,
	isContinuationAuthoritySourceMissing,
	rebaseActiveContinuationState,
} from "../context-steady/continuation";
import { generateDigest as generateContextSteadyDigest } from "../context-steady/digest";
import { type ContextExpandResult, expandDigestSpan } from "../context-steady/expand";
import { generateFallbackDigest } from "../context-steady/fallback";
import { estimateContextPlanProjectedTokens, materializeContextPlanMessages } from "../context-steady/materialize";
import { type BuiltContextPlan, CONTEXT_PLAN_CUSTOM_TYPE } from "../context-steady/plan-types";
import { type BuildContextPlanOptions, buildContextPlan } from "../context-steady/planner";
import {
	appendContextProbeRecord,
	type BuildContextProbeSnapshotOptions,
	buildContextMaintenanceProbeRecord,
	buildContextProbeRecord,
	type ContextProbeCompactionObservation,
	type ContextProbeMaintenanceDecision,
	type ContextProbeRecord,
	type ContextProbeRequestKind,
	contextProbeFilePath,
} from "../context-steady/probe";
import { buildContextSteadyRecallQuery, normalizeContextSteadyRecallItems } from "../context-steady/recall";
import { isTopicShiftPrompt } from "../context-steady/relevance";
import {
	appendContextSegment,
	buildContextSegment,
	buildContextSegmentCheckpoint,
	buildContextSegmentDigestInput,
	collectContextSegmentRefs,
} from "../context-steady/segment";
import {
	computeTurnSourceSpan,
	extractSpanMessages,
	isAuthoritativeUserEntry,
	skipContextPacketPreludeInDigestSource,
} from "../context-steady/session";
import {
	buildContextSummaryAuthorityAudit,
	COMPACTION_SUMMARY_REPAIR_INSTRUCTIONS,
	contextSummaryInspectionFailed,
	inspectContextSummary,
	renderDeterministicHistoricalFallback,
} from "../context-steady/summary-authority";
import { ToolProgressGuard, type ToolProgressGuardDetection } from "../context-steady/tool-progress-guard";
import {
	type ActiveContinuationState,
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_MAINTENANCE_CUSTOM_TYPE,
	CONTEXT_MAINTENANCE_SCHEMA_VERSION,
	CONTEXT_SEGMENT_CUSTOM_TYPE,
	CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE,
	CONTEXT_STEADY_ACTIVATION_SCHEMA_VERSION,
	type ContextCheckpointRebaseReason,
	type ContextMaintenanceAudit,
	type ContextMaintenanceFailureStage,
	type ContextMaintenanceTrigger,
	type ContextPacketRecallLayer,
	type ContextSegment,
	type ContextSteadyActivation,
	type ContextSummaryAuthorityAudit,
	type ContextSummarySource,
	TURN_DIGEST_CUSTOM_TYPE,
} from "../context-steady/types";
import { CursorExecHandlers } from "../cursor";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { expandApplyPatchToEntries, normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../edit";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import { disposeJuliaKernelSessionsByOwner } from "../eval/jl/executor";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { disposeRubyKernelSessionsByOwner } from "../eval/rb/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type {
	ExecutionLedgerAppendResult,
	ExecutionRuntime,
	ExecutionScopeHandle,
	ImmutableObjectiveContract,
} from "../execution-control";
import { ProviderCircuitOpenError, StaleExecutionRevisionError } from "../execution-control";
import { isTerminalExecutionState, TerminalExecutionStateError } from "../execution-control/execution-ledger";
import { toolCompletionObservation } from "../execution-control/host-observation-adapter";
import { stableValueFingerprint } from "../execution-control/progress-classifier";
import { SessionSkillGateState } from "../execution-control/skill-gate-session";
import type { TaskContractRegistry } from "../execution-control/task-contract";
import type { WatchdogDecision } from "../execution-control/watchdog";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelRouteChangedEvent,
	ModelRouteResolvedEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionStopEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import { ManagedTimers } from "../extensibility/extensions/managed-timers";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { GoalRuntime } from "../goals/runtime";
import type { Goal, GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
import { type RuntimeScopeIdentity, resolveRuntimeScopeIdentity } from "../identity";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { IrcBus, type IrcMessage } from "../irc/bus";
import { resolveMemoryBackend } from "../memory-backend";
import { shutdownMnemopiEmbedClient } from "../mnemopi/embed-client";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../mnemopi/state";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "../modes/orchestrate";
import { theme } from "../modes/theme/theme";
import { parseTurnBudget } from "../modes/turn-budget";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
} from "../modes/utils/context-usage";
import { containsWorkflow, renderWorkflowNotice } from "../modes/workflow";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { createPlanReadMatcher } from "../plan-mode/plan-protection";
import type { PlanModeState } from "../plan-mode/state";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import toolProgressFinalizeTemplate from "../prompts/context-steady/tool-progress-finalize.md" with { type: "text" };
import toolProgressRedirectTemplate from "../prompts/context-steady/tool-progress-redirect.md" with { type: "text" };
import contractEchoGeneralTemplate from "../prompts/execution/contract-echo-general.md" with { type: "text" };
import watchdogRedirectTemplate from "../prompts/execution/watchdog-redirect.md" with { type: "text" };
import goalModeContextPrompt from "../prompts/goals/goal-mode-context.md" with { type: "text" };
import goalTodoContextPrompt from "../prompts/goals/goal-todo-context.md" with { type: "text" };
import skillContractEchoTemplate from "../prompts/skills/contract-echo.md" with { type: "text" };
import skillEvidenceReminderTemplate from "../prompts/skills/evidence-reminder.md" with { type: "text" };
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import crossSessionHandoffTemplate from "../prompts/system/cross-session-handoff.md" with { type: "text" };
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import geminiToolReminderTemplate from "../prompts/system/gemini-tool-call-reminder.md" with { type: "text" };
import interruptedThinkingTemplate from "../prompts/system/interrupted-thinking.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import midRunTodoNudgePrompt from "../prompts/system/mid-run-todo-nudge.md" with { type: "text" };
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import rewindReportTemplate from "../prompts/system/rewind-report.md" with { type: "text" };
import sideChannelNoToolsReminder from "../prompts/system/side-channel-no-tools.md" with { type: "text" };
import thinkingLoopRedirectTemplate from "../prompts/system/thinking-loop-redirect.md" with { type: "text" };
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import vibeModeActivePrompt from "../prompts/system/vibe-mode-active.md" with { type: "text" };
import xdevMountNoticePrompt from "../prompts/system/xdev-mount-notice.md" with { type: "text" };
import adHocWorkflowDraftPrompt from "../prompts/workflows/ad-hoc-draft.md" with { type: "text" };
import managedSopWorkflowDraftPrompt from "../prompts/workflows/managed-sop-draft.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import {
	appendSanLoopRoleContextDebugEntry,
	buildSanLoopRoleContext,
	findLatestSanLoopRun,
	isSanLoopTerminalStatus,
	recoverSanLoopRun,
} from "../san-loop";
import { SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE } from "../san-loop/types";
import {
	deobfuscateAssistantContent,
	deobfuscateSessionContext,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "../secrets/obfuscator";
import { usesCodexTaskPrompt } from "../task/prompt-policy";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	prewalkWouldBeNoop,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { shutdownTinyModelClient } from "../tiny/client";
import { formatTitleConversationContext, type TitleConversationTurn } from "../tiny/message-preproc";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { releaseTabsForOwner } from "../tools/browser/tab-supervisor";
import { isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { outputMeta, wrapToolWithMetaNotice } from "../tools/output-meta";
import { isInternalUrlPath, normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import {
	buildResolveReminderMessage,
	isPreviewResolutionToolCall,
	isProposeToolCall,
	type PlanProposalHandler,
	PROPOSE_DEVICE_NAME,
	writeDeviceDispatch,
} from "../tools/resolve";
import { getLatestTodoPhasesFromEntries, type TodoItem, type TodoPhase } from "../tools/todo";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import { isMountableUnderXdev, type XdevRegistry } from "../tools/xdev";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { formatLocalCalendarDate } from "../utils/local-date";
import { generateSessionTitle } from "../utils/title-generator";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { VibeModeState } from "../vibe/state";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge";
import {
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { findCompactMode } from "./compact-modes";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "./exit-diagnostics";
import {
	type BashExecutionMessage,
	CONTRACT_ECHO_MESSAGE_TYPE,
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	demoteInterruptedThinking,
	type FileMentionMessage,
	type HookMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	readQueueChipText,
	SILENT_ABORT_MARKER,
	SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	stripImagesFromMessage,
	USER_INTERRUPT_LABEL,
} from "./messages";
import {
	type ActiveModelRoute,
	ModelRouteLeaseController,
	type ModelRouteLeaseState,
	type ModelRouteSelection,
} from "./model-route-lease";
import { ResponseDocumentRuntime } from "./response-documents";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import {
	getLatestCompactionEntry,
	getRestorableSessionLogicalModels,
	getRestorableSessionModels,
} from "./session-context";
import { formatSessionDumpText } from "./session-dump-format";
import type { BranchSummaryEntry, CompactionEntry, NewSessionOptions, SessionEntry } from "./session-entries";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import { cleanupEmptyMoveSession, type SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";
import { getSessionSubagentModelOverride } from "./subagent-model-override";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";
import { YieldQueue } from "./yield-queue";

const SESSION_STOP_CONTINUATION_CAP = 8;
const PLAN_MODE_REMINDER_MAX = 3;

type BashAppendDestination =
	| { kind: "current"; manager: SessionManager }
	| { kind: "detached"; manager: SessionManager }
	| { kind: "branch"; manager: SessionManager; parentId: string | null };

interface BashSessionTarget {
	sessionId: string;
	refs: number;
	destination?: BashAppendDestination;
	pending?: Promise<BashAppendDestination>;
}

interface PendingBashMessage {
	target: BashSessionTarget;
	message: BashExecutionMessage;
}

interface BashSessionTransition {
	oldTarget: BashSessionTarget;
	newTarget: BashSessionTarget;
	oldSessionId: string;
	oldSessionFile: string | undefined;
	oldLeafId: string | null;
	detachedManager: SessionManager | undefined;
	resolveOld: ((destination: BashAppendDestination) => void) | undefined;
	resolveNew: (destination: BashAppendDestination) => void;
}

/**
 * Mutating tool results (`bash`/`eval`/`edit`/`write`/`ast_edit`) without the
 * agent touching the `todo` tool that trip the mid-run reconciliation nudge.
 * Read-only exploration (grep/read/glob/lsp) never ticks this: an agent
 * researching for a long stretch has nothing to flip. Picked so a normal
 * fix-verify loop (~3-6 mutations) never sees the nudge, but a sustained run
 * of landed work without flipping any todos does. Without this nudge, long
 * runs drive the live todo HUD to `0/N` until the final stop, then batch-flip
 * to `N/N` (issue #3651).
 */
const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;
/** Mid-run nudges per prompt cycle. Deliberately tighter than
 *  `todo.remindersMax` (the stop-time budget): this is a gentle hidden hint,
 *  not an escalation ladder. */
const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;
/** Tool results that count as landed work for the mid-run todo nudge. */
const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n")
		.trim();
}

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	const lastLine = text.split(/\r?\n/).at(-1)?.trim();
	return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}
/** `customType` for the hidden mid-run todo nudge; `display: false`, so it reaches
 *  the model but never renders in the TUI or transcript. */
const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
/** Hidden plan nudge injected by prewalk; scrubbed from the LLM context
 *  when the switch happens. */
const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}
/** Hidden safety-net nudge forcing one more turn after a text-only reply to
 *  the plan nudge, which would otherwise end the run with no code written. */
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
/** Hidden "verify before finishing" checklist steered into the run at the
 *  switch, aimed at the fast model's specific failure patterns: partial
 *  multi-site fixes, unnecessarily broad rewrites, and reported-test-only
 *  verification. */
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";
/** Hidden steered notice announcing a mid-session `xd://` mount/unmount delta
 *  (see {@link AgentSession.#notifyXdevMountDelta}). */
const XDEV_MOUNT_NOTICE_MESSAGE_TYPE = "xdev-mount-notice";

interface XdevMountNoticeDetails {
	added: string[];
	removed: string[];
}
/** Tools whose first successful call triggers the switch — once the todo
 *  gate is open (see {@link AgentSession.#prewalkTodoSeen}). Bash is
 *  deliberately excluded: it doubles as exploration (ls/cat) and fired
 *  turn-1 switches in practice. `todo` is deliberately NOT a trigger: firing
 *  at the todo init handed the fast model 100% of the implementation with
 *  zero started work and measurably regressed pass rates. */
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

/** A device write only counts as implementation when its wrapped tier mutates state. */
function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	if (!isRecord(details) || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	if (!isRecord(xdev) || !("tier" in xdev)) return false;
	return xdev.tier === "write" || xdev.tier === "exec";
}
/** `customType` for the hidden hand-off message steered to the target model
 *  once PlanYolo auto-approves the plan. Unlike prewalk's plan nudge this
 *  is never scrubbed — it IS the instruction the target model acts on. */
const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";
/** Abort reason for the Gemini reasoning-header runaway interrupt. Surfaced on the
 *  discarded assistant turn only; never reaches the model. */
const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
/** `customType` for the hidden tool-call reminder injected after the interrupt. */
const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";
/** `customType` for the hidden redirect notice injected into a turn retried after a
 *  thinking/response loop. Steers the model off the repeated content; never displayed. */
const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";
const TOOL_PROGRESS_REDIRECT_TYPE = "tool-progress-redirect";
const TOOL_PROGRESS_FINALIZE_TYPE = "tool-progress-finalize";

function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

type SemanticCheckpointToolName = "checkpoint" | "rewind";

type SemanticToolResult = {
	toolName: SemanticCheckpointToolName;
	details?: unknown;
};

/**
 * Normalize checkpoint/rewind results across native calls and `write xd://`
 * dispatches. Xdev keeps the wrapped tool's result details under `xdev.inner`,
 * while direct calls put them on the result itself.
 */
function semanticToolResult(toolName: string | undefined, result: unknown): SemanticToolResult | undefined {
	if (toolName === "checkpoint" || toolName === "rewind") {
		const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
		return { toolName, details };
	}
	const dispatch = writeDeviceDispatch(toolName ?? "", result);
	if (dispatch?.mode !== "execute" || (dispatch.tool !== "checkpoint" && dispatch.tool !== "rewind")) {
		return undefined;
	}
	return { toolName: dispatch.tool, details: dispatch.inner };
}

function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned"),
	);
}

function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}
function isSuccessfulCheckpointEntry(
	entry: SessionEntry,
): entry is SessionEntry & { type: "message"; message: Extract<AgentMessage, { role: "toolResult" }> } {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError === true) {
		return false;
	}
	return semanticToolResult(entry.message.toolName, entry.message)?.toolName === "checkpoint";
}

function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = semanticToolResult(entry.message.toolName, entry.message)?.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

// A side-channel assistant response is signed for the hidden prompt/history that
// produced it. If we persist that response under a different user turn, native
// replay anchors become invalid; keep only visible, non-cryptographic content.
function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "auto_compaction_start";
			maintenanceId: string;
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			trigger: ContextMaintenanceTrigger;
			matchedTriggers: ContextMaintenanceTrigger[];
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			maintenanceId: string;
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
			failureStage?: ContextMaintenanceFailureStage;
			failureReason?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			recoveredErrors?: RecoveredRetryError[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| {
			type: "model_route_resolved";
			logicalModel: string;
			routeId: string;
			model: string;
			reason: "primary" | "affinity" | "recovery" | "manual";
	  }
	| {
			type: "model_route_changed";
			logicalModel: string;
			fromRoute: string;
			toRoute: string;
			trigger: RouteFailureCategory;
			cooldownUntil?: number;
	  }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level (e.g. `auto`). */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };
/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;

interface SanBrainCaptureScopes {
	userScope: SanBrainScope;
	fallbackScope: SanBrainScope;
}
/**
 * Budget for callers on the user-visible `/quit` / `/exit` shutdown path that
 * want to cap how long they wait for `MnemopiSessionState.dispose()` to finish
 * its consolidate pass. Consolidate fires fresh LLM fact extractions, each a
 * 1–3 s round-trip, so interactive shutdown passes this budget to keep the
 * UI responsive. Callers that keep the process/session host alive must omit it
 * so dispose still awaits the full consolidate-then-close pipeline.
 */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;
const SESSION_DISPOSE_DRAIN_TIMEOUT_MS = 5_000;

export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/** dispose 等待 active run 与事件持久化链排空的期限；超时后仍会异步终态化。 */
	drainTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
	reason?: postmortem.Reason;
}

type CompactionCheckResult = Readonly<{
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
	failureStage?: ContextMaintenanceAudit["failureStage"];
	failureReason?: string;
}>;

interface ToolLoopBudgetRecoveryResult {
	plan?: BuiltContextPlan;
	failureStage?: ContextMaintenanceAudit["failureStage"];
	failureReason?: string;
}

interface ContextSummaryAuthorityResolution {
	summary: string;
	shortSummary?: string;
	replacement?: CompactionResult;
	audit: ContextSummaryAuthorityAudit;
}

interface ContextProbeSnapshot {
	sessionFile: string;
	options: BuildContextProbeSnapshotOptions;
}

const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
};
const COMPACTION_CHECK_DEFERRED_HANDOFF: CompactionCheckResult = {
	deferredHandoff: true,
	continuationScheduled: false,
};
const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: true,
};
const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

/**
 * User-facing notice for a compaction dead end: maintenance freed too little
 * to retry safely. `remedies` names the recovery actions left on the emitting
 * path — by the time the post-pass dead end fires, the tiered rescue has
 * already attempted both elide and image-drop automatically.
 */
function compactionDeadEndWarning(remedies: string): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		`The most recent turn alone is too large to reduce further; ${remedies} or switch to a larger-context model.`
	);
}

function createCodexCompactionContext(options: {
	trigger: CodexCompactionContext["trigger"];
	reason: CodexCompactionContext["reason"];
	phase: CodexCompactionContext["phase"];
}): CodexCompactionContext {
	return {
		operationId: crypto.randomUUID(),
		trigger: options.trigger,
		reason: options.reason,
		phase: options.phase,
		strategy: "memento",
	};
}

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL — "long" retention (the OAuth default) is 1h — or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

const RETRY_BACKOFF_JITTER_RATIO = 0.25;
/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * check shared by the shake tail and the context-full / snapcompact tail. A
 * pass counts as having resolved threshold pressure only when residual context
 * lands at or below `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against
 * the raw threshold lets a pass keep reclaiming a trickle of the previous
 * turn's output and land just under the line every turn, sustaining the
 * auto-continue dead loop reported in #2275; the same band stops the
 * context-full / snapcompact tail from re-firing on a history whose single
 * most-recent kept turn already exceeds the threshold (the snapcompact thrash).
 */
const COMPACTION_RECOVERY_BAND = 0.8;

function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/**
 * Slack added past a sibling credential's block expiry before retrying, so
 * the next getApiKey lands after the block has actually lapsed.
 */
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

function clampPositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult };
/**
 * Prewalk: switches an active session one-way from its starting model to
 * a fast/cheap `target` at the first completed turn that runs an edit/write
 * tool once the todo list exists. A hidden plan nudge asks the starting
 * model to write a plan, initialize its todo list from it, and start; the
 * todo call opens the trigger gate (it never fires the switch itself), so
 * the starting model always begins the implementation. A hidden
 * checklist nudge asks the target model to verify its work before
 * finishing. Both are always on — this is the one mechanism that won out
 * over turn-count and ungated variants in testing.
 */
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * PlanYolo: forces the session into read-only plan mode at start, then
 * auto-approves the plan the instant the model calls `resolve({ action:
 * "apply" })` for it — no interactive review — and switches to a fast/cheap
 * `target` model to implement it. The headless counterpart to interactive
 * plan mode's "Approve and execute", for print/non-interactive runs where
 * there is no one to click Approve.
 */
export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** RPC 历史浏览模式；只读期间不得追加任何 Session journal 记录。 */
	sessionAccess?: "read_write" | "read_only";
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** 启动或恢复时已经解析出的 Logical Model route lease。 */
	initialModelRoute?: ActiveModelRoute;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first
	 *  plan proposal (`write xd://propose`), then switch to the target to implement. */
	planYolo?: PlanYolo;

	/** Initial per-family service tiers (OpenAI / Anthropic / Google) for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/** Skill loading warnings (already captured by SDK) */
	skillWarnings?: SkillWarning[];
	/** Whether runtime reloads may rediscover disk-backed skills for this session. */
	skillsReloadable?: boolean;
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/**
	 * 共享 execution runtime。根会话创建实例并向下传递；子会话采纳父 runtime，
	 * 自身不得 start/sync/dispose。
	 */
	executionRuntime?: ExecutionRuntime;
	/**
	 * 本会话拥有的 execution runtime（创建它的根会话）。子/采纳会话保持
	 * undefined，不得拆除；只有 owner 的 {@link AgentSession.dispose} 释放它。
	 */
	ownedExecutionRuntime?: ExecutionRuntime;
	/** 从父会话继承的固定不可变 execution scope（子会话）。 */
	executionScopeId?: string;
	/** 与嵌套会话共享的 root 级 Task 准入注册表。 */
	taskContractRegistry?: TaskContractRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Creates the tools registered only while `/vibe` mode is active. */
	createVibeTools?: () => AgentTool[];
	/** Tool names whose current registry entry is still the built-in implementation. */
	builtInToolNames?: Iterable<string>;
	/** Update tool-session predicates that render guidance from the live active tool set. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Register the write transport lazily when runtime xdev mounts first need it. */
	ensureWriteRegistered?: () => Promise<boolean>;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Per-request transform applied after `convertToLlm` and before the
	 * provider call. Used for snapcompact, secret obfuscation, and image
	 * clamping. When supplied via {@link createAgentSession}, the advisor agent
	 * inherits this so its requests undergo the same shaping as the main turn.
	 */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/**
	 * Stream wrapper passed to side-channel requests (`/btw`, `/omfg`, IRC
	 * auto-replies, and handoff generation) so they apply the same provider
	 * shaping and host-level request wrappers as normal agent turns. Defaults
	 * to plain `streamSimple` when omitted.
	 */
	sideStreamFn?: StreamFn;
	/**
	 * Stream wrapper passed to the advisor agent so its requests apply the
	 * session's `providers.openrouterVariant`, `providers.antigravityEndpoint`,
	 * `providers.maxInFlightRequests`, and `model.loopGuard.*` settings —
	 * keeping OpenRouter sticky-routing / response caching consistent with the
	 * main agent. Defaults to plain `streamSimple` when omitted.
	 */
	advisorStreamFn?: StreamFn;
	/** Hint that OpenAI Codex requests should prefer websocket transport when supported. */
	preferWebsockets?: boolean;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. Returns ordered provider-facing blocks. */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	/** Local calendar date provider used by prompt-cache invalidation. Defaults to the host local date. */
	getLocalCalendarDate?: () => string;
	/** Entries of tools mounted under `xd://` (name + one-line summary), for /tools display. */
	getXdevToolEntries?: () => Array<{ name: string; summary: string }>;
	/** Session-owned `xd://` device registry; reconciled as the active tool set changes. */
	xdevRegistry?: XdevRegistry;
	/** Discoverable tools mounted under `xd://` in the initial enabled set (startup partition in `sdk.ts`). */
	initialMountedXdevToolNames?: string[];
	/** Explicit/effective names pinned top-level during runtime repartitioning. */
	presentationPinnedToolNames?: ReadonlySet<string>;
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained eval kernels created by this session. */
	evalKernelOwnerId?: string;
	/**
	 * AsyncJobManager that this session installed as the process-global instance.
	 * Only set for top-level sessions; subagents inherit the parent's manager and
	 * **MUST NOT** dispose it on their own teardown.
	 */
	ownedAsyncJobManager?: AsyncJobManager;
	/**
	 * AsyncJobManager reachable by this session for scoped job actions.
	 *
	 * Top-level owners receive their own manager, subagents receive the inherited
	 * parent manager, and secondary in-process top-level sessions receive
	 * `undefined` so job snapshots and ACP drains cannot observe the primary's
	 * state.
	 */
	asyncJobManager?: AsyncJobManager;
	/** Agent identity (registry id like "Main" or "Alice") used for IRC routing. */
	agentId?: string;
	/** Whether this session is the top-level agent or a subagent. Drives eager-task
	 *  prelude gating so a top-level session created with a custom `agentId` still
	 *  receives the always-mode reminder. Defaults to "main". */
	agentKind?: "main" | "sub";
	/**
	 * Override the provider-facing session ID for all API requests from this session.
	 * When absent, `sessionManager.getSessionId()` is used. Needed when benchmark or
	 * SDK callers issue probes / prewarming with an explicit `--provider-session-id`
	 * so that credential sticky selection is consistent with the session's streaming calls.
	 */
	providerSessionId?: string;
	/** Marks `agent.promptCacheKey` as fork-inherited so incompatible route changes can clear it. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/**
	 * Full advisor toolset, pre-built in `createAgentSession` against a distinct,
	 * advisor-scoped `ToolSession` (its own `-advisor` session/agent id) so the
	 * advisor's tool state stays isolated from the primary. The advisor is a full
	 * agent; its config `tools` selects a subset (default read/grep/glob). Undefined
	 * when the advisor is disabled.
	 */
	advisorTools?: AgentTool[];
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Preloaded YAML top-level `instructions` shared baseline, kept separate from
	 *  `advisorWatchdogPrompt` so `/advisor configure` can swap it live. */
	advisorSharedInstructions?: string;
	/**
	 * Preloaded project context files (AGENTS.md, etc.) rendered as a system-prompt
	 * block for the advisor — the same standing instructions the primary agent
	 * receives, so the reviewer holds the agent to them.
	 */
	advisorContextPrompt?: string;
	/**
	 * Advisors discovered from `WATCHDOG.yml`. Empty/undefined runs a single
	 * legacy advisor on the `advisor` role (byte-for-byte the pre-config path).
	 */
	advisorConfigs?: AdvisorConfig[];
	/**
	 * Strip tool descriptions from provider-bound tool specs on side requests
	 * (handoff). Must match the session-start value used to build the system
	 * prompt so inline descriptors are not also sent through provider schemas.
	 */
	pruneToolDescriptions?: boolean;
	/**
	 * Disconnect this session's OWNED MCP manager on dispose. Provided only when
	 * the session created the manager (top-level sessions); subagents reuse a
	 * parent's manager via `options.mcpManager` and omit this so a child's
	 * teardown never tears down the shared servers.
	 */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/**
	 * Override the bundled system prompt used by automatic session-title
	 * generation paths (initial title + replan refresh). Source-of-truth is
	 * `TITLE_SYSTEM.md` discovered via {@link discoverTitleSystemPromptFile} and
	 * resolved through {@link resolvePromptInput}; refresh after a `/move`-style
	 * cwd change via {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Marks this prompt as a deliberate user action (typed message, `.`/`c`
	 *  continue). Clears advisor auto-resume suppression that a user interrupt set.
	 *  Defaults to `!synthetic`; manual-continue is synthetic yet user-initiated, so
	 *  it sets this explicitly. Agent-initiated synthetic prompts (auto-continue,
	 *  plan re-prime, reminders) leave it unset and keep suppression latched. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Options for AgentSession.followUp() */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message (agent-attributed by default) instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. Defaults to `agent` for synthetic follow-ups. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model, used by role cycling and
 *  the plan-approval model slider. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	logicalModelId?: string;
	routeId?: string;
}

type PromptModelRouteRequirements = Pick<
	ModelRouteResolutionRequest,
	"requiredContextTokens" | "requiredOutputTokens" | "requiresImages"
>;

interface ModelRouteTransitionSnapshot {
	model: Model | undefined;
	routeState: ModelRouteLeaseState;
	thinkingLevel: ThinkingLevel | undefined;
	autoThinking: boolean;
	autoResolvedLevel: Effort | undefined;
	baseSystemPrompt: string[];
	baseSystemPromptBeforeMemoryPromotion: string[] | undefined;
	systemPrompt: string[];
	lastAppliedToolSignature: string | undefined;
	promptModelKey: string | undefined;
	inheritedProviderPromptCacheKey: string | undefined;
	agentPromptCacheKey: string | undefined;
}

/** The set of resolvable role models plus the index of the currently active
 *  one within {@link ResolvedRoleModel.role} order. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

/** Advisor statistics for /advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
	/** Per-advisor breakdown; one entry per active advisor (single-advisor sessions have one). */
	advisors: PerAdvisorStat[];
}

/** One advisor's slice of {@link AdvisorStats}. Active advisors carry full
 *  token/cost data; disabled/no-model/quota-exhausted advisors appear with
 *  just `name` + `status` so the status line can render a dot for every
 *  configured advisor. */
export interface PerAdvisorStat {
	name: string;
	status: AdvisorRuntimeStatus;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
	sessionId?: string;
}

/**
 * One live advisor instance: its own agent/runtime/tools/recorder plus a
 * per-advisor emission guard and identity. The session holds an array of these;
 * primary-scoped state (turn counters, interrupt latches, the shared yield
 * channel) stays on the session.
 */
interface AdvisorRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel;
	lastAppliedThinkingLevel: ThinkingLevel;
}

interface ActiveAdvisor {
	/** Display name from config ("default" for the legacy no-YAML advisor). */
	name: string;
	/** Slug for the transcript filename/session id; "" → `__advisor.jsonl`. */
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;
	/** Latest recorder close, awaited by dispose() so the final turn lands on disk. */
	recorderClosed: Promise<void>;
	/** Unsubscribe for the advisor agent's event stream feeding the recorder. */
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	/** Provider credential/session identity retained across advisor model switches. */
	providerSessionId: string | undefined;
	/** Active chain state retained until the configured primary can be restored. */
	retryFallback?: AdvisorRetryFallbackState;
	/** A switched advisor model has not yet completed its first successful turn. */
	retryFallbackPendingSuccess: boolean;
	/** Stable key for the resolved runtime inputs that require a rebuild to change. */
	signature: string;
}

/** Runtime-only advisor compaction metadata. It never enters the model-facing summary text. */
interface AdvisorCompactionSummaryMessage extends CompactionSummaryMessage {
	firstKeptEntryId?: string;
	/** First message index eligible to anchor provider usage after this compaction. */
	advisorUsageAnchorStartIndex?: number;
}

/** Resolved advisor config ready to instantiate as an {@link ActiveAdvisor}. */
interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

/** `retry.fallbackChains` config: chain key (role name or model selector) → ordered fallback selectors. */
type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	originalModelRoute?: ActiveModelRoute;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowAutoAlias: true,
		allowMaxSuffix: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are either model-role names (`smol`, `default`)
 * or model selectors (`provider/model-id[:thinking]`). Role names never
 * contain a slash, so its presence marks a model-keyed chain whose primary is
 * the key itself — the chain follows the model across role reassignments.
 */
function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A wildcard fallback-chain key/entry: `provider/*` matches any model of that
 * provider; an id-prefixed `provider/prefix/*` (e.g. `openrouter/google/*`)
 * scopes it to ids under that prefix — aggregators namespace model ids by
 * upstream vendor.
 */
function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/**
 * Split a `…/*` wildcard key/entry into its provider and optional id prefix
 * (`google-vertex/*` → provider only; `openrouter/google/*` → provider
 * `openrouter`, prefix `google`). A template that names a known provider in
 * full wins over the split, so provider ids containing `/` keep working.
 */
function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

const EPHEMERAL_REPLY_MAX_BYTES = 4096;

/**
 * Collapse degenerate ephemeral replies (/btw, /omfg side-channel turns).
 * Models occasionally loop on a single line (~16 reports of N-times-repeated
 * replies); compress runs longer than 3 down to one instance + `[…N×]`, then
 * cap at 4 KiB so a runaway reply can't flood the channel.
 */
function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		// Trim by characters until we're under the byte budget — handles multi-byte
		// glyphs at the boundary without splitting them.
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both San's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

function throwIfHandoffAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = signal.reason;
	if (reason instanceof DOMException && reason.name === "AbortError") {
		throw new Error("Handoff cancelled");
	}
	if (reason instanceof Error) throw reason;
	if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
	throw new Error("Handoff aborted by session");
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** Tools that require user permission before execution when an ACP client is connected. */
const PERMISSION_REQUIRED_TOOLS = new Set(["bash", "edit", "delete", "move"]);

/** Permission options presented to the client on each gated tool call. */
const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const patch = Patch.parse(input);
			for (const section of patch.sections) {
				if (section.fileOp?.kind === "rem") return { kind: "delete", paths: [section.path] };
				if (section.fileOp?.kind === "move") return { kind: "move", paths: [section.path, section.fileOp.dest] };
			}
		} catch {
			// Not a hashline patch — fall through to apply_patch parsing.
		}
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	if (toolName === "bash") {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === "edit") {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** Entry returned by {@link AgentSession.clearQueue} / {@link AgentSession.popLastQueuedMessage}. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images: ImageContent[] = [];
	for (const part of message.content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push(part);
		}
	}
	return images.length > 0 ? images : undefined;
}

function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (part.type === "thinking" || part.type === "redactedThinking" || part.type === "fallback") continue;
		return false;
	}
	return hasText;
}

/**
 * A queued message the user can restore to the editor / pull back as a draft.
 * Only genuinely user-authored messages qualify: plain user turns, or custom
 * messages explicitly attributed to the user (e.g. `/skill` invocations).
 * Agent-authored queued cards — advisor concern/blocker notes, IRC asides,
 * extension notices, hidden goal/plan/budget steers — ride the same
 * steer/follow-up queues but must never be dumped into the editor on Esc/Alt+Up.
 */
function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/**
 * 文件修改类内置工具:before-fix 软拦截只对这些工具生效。bash 虽然也能改
 * 文件,但把它计入会让"先跑复现命令"这一推荐动作本身触发提醒,故排除。
 */
const FILE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write", "ast_edit"]);

/** Custom-message types of the hidden magic-keyword notices that `#createMagicKeywordNotices`
 *  enqueues alongside a user prompt. Keep in sync with that method. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

/** Custom-message type of the hidden companion carrying vision descriptions of image
 *  attachments sent to a text-only model (see `#buildImageDescriptionNotice`). */
const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: the magic-keyword
 * notices (`ultrathink`/`orchestrate`/`workflow`) enqueued alongside the user
 * message. They are `attribution: "user"` but `display: false`, so they are not
 * editor-restorable; when the user pulls their prompt back out of the queue these
 * must leave with it rather than linger as stale, companion-less steering. Scoped to
 * the known notice types so an unrelated hidden user custom is never silently dropped.
 */
function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) || message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}

function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return snapcompact.stripPreservedArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}

type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};
type PendingRecoveredRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

type PostPromptSkipReason = "aborted" | "stale-generation";

type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: () => void;
};

const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

type SessionTitleSource = "auto" | "user";
type SessionNameTrigger = "replan";
type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const text = block.text.trim();
		if (text) parts.push(text);
	}
	return parts.join("\n\n");
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? getStringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

/**
 * 由真实 journal entry 派生 host-minted user-turn objective contract。
 *
 * 仅使用 entryId（真实持久化身份）与消息内容（稳定 fingerprint）推导，
 * 绝不读取模型文本。同一 entry 重入必然得到完全相同的契约（scope registry
 * 以此校验不可变绑定）。clauseRefs 必须非空且从 entryId 派生：typed
 * acceptance gate 的 objectiveClauseRefs 必须属于契约，空 clauseRefs 会让
 * 任何 gate 都无法通过验证，scope 将永远无法 completed。
 */
export function buildAuthoritativeUserObjectiveContract(
	entryId: string,
	message: AgentMessage,
): ImmutableObjectiveContract {
	if (message.role !== "user") {
		throw new Error(`Authoritative objective contracts require a user message, received ${message.role}.`);
	}
	const fingerprintText = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
	return {
		source: "authoritative_user",
		authoritativeUserTurnId: entryId,
		ref: {
			contractId: `user-turn:${entryId}`,
			revision: 1,
			contractHash: stableValueFingerprint(fingerprintText),
			clauseRefs: [`user-turn:${entryId}:objective`],
		},
	};
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	/** Entries of tools mounted under `xd://`; empty when virtual devices are unmounted. */
	getXdevToolEntries: () => Array<{ name: string; summary: string }>;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;
	#autoApprove: boolean;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Effective, metadata-clamped thinking level applied to the agent (never `auto`). */
	#thinkingLevel: ThinkingLevel | undefined;
	/** True when the user configured `auto`; the effective level is resolved per turn. */
	#autoThinking: boolean = false;
	/** The level `auto` last resolved to (for UI); undefined until a turn is classified. */
	#autoResolvedLevel: Effort | undefined;
	#prewalk: Prewalk | undefined;
	/** True once the plan nudge has been queued; scrubbed from context at the switch. */
	#prewalkPlanInjected = false;
	/** Armed by plan/tool progress; consumed by one text-only continuation. */
	#prewalkContinuePending = false;
	/** True once any successful `todo` call landed — opens the prewalk
	 *  trigger gate: the switch fires at the first edit/write AFTER the todo
	 *  list exists (sessions without an ACTIVE todo tool skip the gate). */
	#prewalkTodoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousTools: string[] | undefined;
	#planYoloArmed = false;

	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#exitRecorded = false;
	#sessionWritesEnabled: boolean;
	readonly #responseDocuments: ResponseDocumentRuntime;
	#unsubscribeAppendOnly?: () => void;
	#unsubscribeModelRoles?: () => void;
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;
	#pendingUserMessageEnqueueCount = 0;
	/** Latched true when the user deliberately interrupts (USER_INTERRUPT_LABEL);
	 *  suppresses advisor concern/blocker auto-resume until the user next resumes.
	 *  Advisor advice is still recorded into the transcript, just not auto-run. */
	#advisorAutoResumeSuppressed = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#planModeState: PlanModeState | undefined;
	#vibeModeState: VibeModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	#advisorEnabled = false;
	#advisorTools?: AgentTool[];
	#advisorWatchdogPrompt?: string;
	#advisorSharedInstructions?: string;
	#advisorContextPrompt?: string;
	#advisorYieldQueueUnsubscribe?: () => void;
	/** Live advisors. Empty when no advisor is active. */
	#advisors: ActiveAdvisor[] = [];
	/** Configured advisor roster from WATCHDOG.yml; undefined/empty → single legacy advisor. */
	#advisorConfigs?: AdvisorConfig[];
	/** Per-advisor runtime status (slug → {name, status}). Tracks disabled/quota/states
	 *  for the configured roster even when the advisor has no live runtime. The name
	 *  is stored alongside the status so {@link getAdvisorStats} doesn't need to
	 *  recompute slugs or resolve config names. */
	#advisorStatuses: Map<string, { name: string; status: AdvisorRuntimeStatus }> = new Map();
	/** Provider-facing UUIDv7 identities keyed by primary provider session and advisor slug. */
	#advisorProviderSessionIds = new Map<string, string>();
	/** Aggregate of the most recent stop's recorder closes; awaited by dispose() and
	 *  used as the open barrier for the next build so two writers never share a file. */
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath = "local://PLAN.md";
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Per-session memory of allow_always / reject_always decisions for gated tools. */
	#acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map();
	/** Session file created by this session's `/move`; removed on dispose if it stayed empty. */
	#movedFromEmptySessionFile?: string;

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;
	#textOutputCommitted = true;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	#modelRouteLease: ModelRouteLeaseController;
	#promptModelRouteRequirements: PromptModelRouteRequirements | undefined;
	#pendingRecoveredRetryErrors: PendingRecoveredRetryError[] = [];
	// Todo completion reminder state
	#todoReminderCount = 0;
	/**
	 * Set true after a todo reminder is appended; cleared when the agent makes any tool-level
	 * progress (toolResult) or a new user prompt arrives. Suppresses follow-up reminders within
	 * the same agent self-continuation chain so a text-only acknowledgement ("paused at your
	 * instruction") does not drive 1/3 → 2/3 → 3/3 without user input.
	 */
	#todoReminderAwaitingProgress = false;
	/**
	 * Successful mutating tool results (bash/eval/edit/write/ast_edit) since the
	 * agent last touched the `todo` tool. Drives {@link #takeMidRunTodoNudge} so
	 * the live HUD stays in sync with actual progress instead of flipping
	 * `0/N -> N/N` only at the very end of a long run (issue #3651). Read-only
	 * tools and errored results never tick it. Reset to 0 on any `todo` tool
	 * result, on a nudge fire (cooldown), on a stop-time reminder, and at every
	 * new-prompt / clear / handoff lifecycle boundary.
	 */
	#mutationsSinceLastTodoTouch = 0;
	/** Mid-run nudges fired this prompt cycle; capped by
	 *  {@link MID_RUN_TODO_NUDGE_MAX_PER_CYCLE}, reset with the counter above. */
	#midRunNudgeCount = 0;
	#planModeReminderCount = 0;
	#planModeReminderAwaitingProgress = false;
	#todoPhases: TodoPhase[] = [];
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;
	/** Resolved TITLE_SYSTEM.md override applied to every automatic session-title
	 *  generation path. Refresh via {@link AgentSession.setTitleSystemPrompt} when
	 *  the session cwd changes. */
	#titleSystemPrompt: string | undefined;
	#titleGenerationAbortController = new AbortController();
	#toolChoiceQueue = new ToolChoiceQueue();

	// Bash execution state
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: PendingBashMessage[] = [];
	#bashSessionTarget!: BashSessionTarget;

	// Python execution state
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	#parentEvalSessionId: string | undefined;
	/**
	 * AsyncJobManager owned by this session (top-level only). Subagents leave
	 * this undefined and **MUST NOT** dispose the global instance on teardown.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	/**
	 * AsyncJobManager scoped to this session for introspection/cancellation.
	 *
	 * This differs from `#ownedAsyncJobManager`: subagents can inherit a parent
	 * manager for their own owner id, while secondary top-level sessions are left
	 * undefined to avoid reading the primary's jobs.
	 */
	readonly #asyncJobManager: AsyncJobManager | undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	// Incoming IRC messages received while a turn was streaming. Parent IRCs
	// enter the steering queue; peer IRCs enter the interrupt queue and drain as
	// asides at the next boundary; passive IRC records stay in the aside queue.
	#pendingIrcInterrupts: CustomMessage[] = [];
	#pendingIrcAsides: CustomMessage[] = [];
	// Agent identity (registry id) used for IRC routing and job ownership.
	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#inheritedProviderPromptCacheKey: string | undefined;
	#autolearnCaptureAbortController: AbortController | undefined;
	#autolearnCaptureTask: Promise<void> | undefined;
	#isDisposed = false;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	/**
	 * Backs `ctx.setInterval`/`setTimeout`/`clearTimer` for the runner-less
	 * command-context fallback (SDK embeddings with no extension runner). Lazily
	 * created; cleared on dispose alongside the runner's own timers (#5664).
	 */
	#fallbackExtensionTimers: ManagedTimers | undefined = undefined;
	#turnIndex = 0;
	#messageEndPersistenceTail: Promise<void> = Promise.resolve();
	#pendingMessageEndPersistence = new Map<string, Promise<void>>();
	#persistedMessageKeys: { anchor: string; keys: Set<string> } | undefined;

	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	/**
	 * 会话级 skill evidence gate 容器(M3)。首个证据链 skill 触发时才创建;
	 * 无证据链 skill 的会话保持 undefined,所有钩子路径零行为变化。
	 */
	#skillGateState: SessionSkillGateState | undefined;
	/** 已发出 watchdog 提醒的 strategy fingerprint(同一重复动作只提醒一次)。 */
	#watchdogRemindedStrategies = new Set<string>();

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;
	#taskContractRegistry: TaskContractRegistry | undefined;
	#executionRuntime: ExecutionRuntime | undefined;
	#ownedExecutionRuntime: ExecutionRuntime | undefined;
	#executionScopeId: string | undefined;
	/** 本会话的 active execution scope handle（仅 root 会话）。 */
	#executionHandle: ExecutionScopeHandle | undefined;
	/** 本会话已驱动到终态的 scope；永不重复 finish。 */
	#finishedExecutionScopes = new Set<string>();
	#toolRegistry: Map<string, AgentTool>;
	#createVibeTools: (() => AgentTool[]) | undefined;
	#installedVibeToolNames = new Set<string>();
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#transformProviderContext: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
	#sideStreamFn: StreamFn;
	#advisorStreamFn: StreamFn | undefined;
	#preferWebsockets: boolean | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt:
		| ((
				toolNames: string[],
				tools: Map<string, AgentTool>,
		  ) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>)
		| undefined;
	#getLocalCalendarDate: () => string;
	#getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
	#setActiveToolNames: ((names: Iterable<string>) => void) | undefined;
	#ensureWriteRegistered: (() => Promise<boolean>) | undefined;
	#disconnectOwnedMcpManager: (() => Promise<void>) | undefined;
	#presentationPinnedToolNames: ReadonlySet<string> | undefined;
	#runtimeSelectedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	#baseSystemPromptBeforeMemoryPromotion: string[] | undefined;
	/** Per-turn prompt replacement returned by `before_agent_start`. */
	#turnSystemPromptOverride: string[] | undefined;
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	/**
	 * Model identifier (`provider/id`) currently rendered into `#baseSystemPrompt`.
	 * The prompt surfaces the active model to the agent, so a model switch must
	 * trigger a rebuild. Compared against the live model after every model change
	 * to decide whether the cached prompt is stale.
	 */
	#promptModelKey: string | undefined;
	#builtInToolNames = new Set<string>();
	#rpcHostToolNames = new Set<string>();
	/** Session-owned `xd://` device registry (built-ins + dynamic mounts); `undefined` when the transport is off. */
	#xdevRegistry: XdevRegistry | undefined;
	/** Names of discoverable tools currently mounted under `xd://` (dynamic mounts only, not built-in devices). */
	#mountedXdevToolNames = new Set<string>();
	/** Coalesced mount delta delivered with the next user-authored prompt. */
	#pendingXdevMountDelta: { added: Set<string>; removed: Set<string> } | undefined;
	/** Dynamic devices already visible through delivered notices or the outgoing base catalog. */
	#announcedMounts = new Set<string>();
	#announcedMountsSeeded = false;
	/** Device names rendered by the current base system prompt. */
	#basePromptXdevNames: ReadonlySet<string> = new Set();

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  These are folded into the matched tool call's `toolResult` content as an
	 *  in-band system reminder, instead of spawning a separate follow-up turn. */
	#perToolTtsrInjections = new Map<string, Rule[]>();
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;

	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-approval continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
	#planInternalAbortPending = false;
	#pendingAbortErrorId?: number;

	#postPromptTasks = new Set<Promise<unknown>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditAbortTriggered = false;
	#streamingEditCheckedLineCounts = new Map<string, number>();

	#streamingEditPrecheckedToolCallIds = new Set<string>();

	#streamingEditFileCache = new Map<string, string>();

	/** Active Gemini reasoning-header runaway detector for the current block.
	 *  (Re)created on each `thinking_start` when the guard applies (see
	 *  `#geminiHeaderGuardActive`); undefined for non-Gemini models or when the
	 *  guard is off. Fed thinking deltas in the assistant-message interceptor. */
	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	#toolCallLoopGuardSettingsKey: string | undefined;
	#toolProgressGuard: ToolProgressGuard | undefined;
	#toolProgressGuardSettingsKey: string | undefined;
	#promptInFlightCount = 0;
	#abortInProgress = false;
	// Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;
	#promptGeneration = 0;
	#contextSteadyPreTurnLeafId: string | null = null;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#pendingContextSnapshot:
		| {
				promptTokens: number;
				nonMessageTokens: number;
				cutoffCount: number;
		  }
		| undefined = undefined;
	#contextSteadyRequestPlan: BuiltContextPlan | undefined = undefined;
	#contextSteadyGlobalInjectionAllowed = true;
	/** Survives turn end so idle status/compaction can share the last plan snapshot. */
	#contextSteadyLastPlan: BuiltContextPlan | undefined = undefined;
	/** Sticky per-session activation; persisted Context Steady entries restore it after resume. */
	#contextSteadyActivatedSessionId: string | undefined;
	#contextSteadyActivationScannedSessionId: string | undefined;
	#contextSteadyLastRebaseCheckpointEntryId: string | undefined;
	/** Next plan/checkpoint should advertise resume rebase after session switch. */
	#contextSteadyPendingResumeRebase = false;
	/** Next plan/checkpoint should advertise budget_pressure after hard-pressure refusal. */
	#contextSteadyPendingBudgetPressureRebase = false;
	#contextSteadyMaintenanceId: string | undefined;
	#contextSteadyRecoveryAttempt = 0;
	#contextProbeWrite: Promise<void> = Promise.resolve();
	#contextProbeLastPrefixFingerprint: { sessionId: string; value: string } | undefined;
	#contextProbeActiveMaintenanceDecision: ContextProbeMaintenanceDecision | undefined;
	#contextProbeActiveCompaction: ContextProbeCompactionObservation | undefined;
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;
	/** When a session_stop continuation is active, holds the original pre-turn
	 * leaf ID from the user's initial prompt. The continuation's own prompt
	 * cycle would overwrite #contextSteadyPreTurnLeafId; this field preserves
	 * the original boundary so the consolidated digest covers the full
	 * logical turn (original user prompt + all continuations). */
	#contextSteadyOriginalPreTurnLeafId: string | null = null;
	#contextSteadyOriginalPreTurnLeafCaptured = false;
	#sanBrainIdentityCache: { key: string; promise: Promise<RuntimeScopeIdentity> } | undefined;
	// Bumped whenever the pending in-flight snapshot is set/cleared. The
	// status-line context memo includes this so clearing the snapshot on
	// turn-end/abort invalidates the cache even though the message list is
	// unchanged — otherwise a mid-turn estimate would survive into idle.
	#contextUsageRevision = 0;
	#obfuscator: SecretObfuscator | undefined;
	/** Session-start value of `inlineToolDescriptors`; drives handoff tool pruning. */
	#pruneToolDescriptions = false;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastCompletedRewind: CompletedRewindState | undefined = undefined;
	#rewoundToolResultIds = new Set<string>();
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	/**
	 * Sticky across an in-flight prompt run: a successful `yield` makes the run
	 * terminal for execution purposes, so any trailing empty/aborted assistant
	 * stop must NOT trigger empty-stop/unexpected-stop/compaction continuations.
	 * Cleared before every new prompt turn so the next turn evaluates cleanly.
	 */
	#yieldTerminationPending = false;
	#synchronouslyTerminatedYieldToolCallIds = new Set<string>();
	#providerSessionState = new Map<string, ProviderSessionState>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#resetPromptMaintenanceState(): void {
		this.#emptyStopRetryCount = 0;
		this.#unexpectedStopRetryCount = 0;
		this.#yieldTerminationPending = false;
		this.#acceptTerminalEmptyStopForPrompt = false;
	}

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "San agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(): void {
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount === 0) {
			this.#releasePowerAssertion();
			this.#flushPendingAgentEnd();
			this.#drainStrandedQueuedMessages();
		}
	}

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still owns the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's #extractQueuedAdvisorCards —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in #canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisorAutoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	/** IRC records that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in pending IRC queues with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count peer IRC interrupts. Once idle, wake a turn so
	 *  the agent responds to the peer. Skip only when a queued steer/follow-up will itself drive a
	 *  resume turn whose aside poll already consumes these (no double-wake). */
	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming) return;
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		if (this.#planModeState?.enabled) {
			// Plan mode: fold stranded IRC asides into context without waking an
			// autonomous turn. Convergence to ask/resolve stays user-driven.
			for (const record of records) {
				this.agent.appendMessage(record);
				this.sessionManager.appendCustomMessageEntry(
					record.customType,
					record.content,
					record.display,
					record.details,
					record.attribution ?? "agent",
				);
			}
			return;
		}
		this.#wakeForIrc(records);
	}

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in #beginInFlight/#endInFlight so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because #canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wakeForIrc(records: CustomMessage[]): void {
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? [...this.agent.peekFollowUpQueue()]
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues([...this.agent.peekSteeringQueue()], []);
		}
		this.#resetPromptMaintenanceState();
		this.#beginInFlight();
		void this.agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						[...this.agent.peekSteeringQueue()],
						[...parkedFollowUps, ...this.agent.peekFollowUpQueue()],
					);
				}
				this.#endInFlight();
			});
	}

	/** Remove advisor concern/blocker cards from the agent-core steer/follow-up
	 *  queues and return them. Used on a deliberate user interrupt so the post-abort
	 *  stranded-message drain cannot auto-resume the run on an advisor card that was
	 *  steered in just before the user stopped; real user follow-ups stay queued.
	 *  Synchronous and await-free so it runs before the abort path polls the queue. */
	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	/** Record a suppressed advisor concern as visible, persisted advice without
	 *  triggering a turn. When the agent is idle (the normal post-interrupt case,
	 *  including the post-prompt unwind window where the core loop has ended), emit
	 *  message_start/message_end like #flushPendingIrcAsides so #handleAgentEvent
	 *  renders it live (TUI/ACP) and persists it as a CustomMessageEntry. Only while
	 *  an abort is still tearing a live turn down do we park it hidden, so abort's
	 *  settle step replays it once idle — never appended into a live streamMessage. */
	#preserveAdvisorCard(card: CustomMessage): void {
		if (this.#abortInProgress && this.isStreaming) {
			this.#pendingNextTurnMessages.push(card);
			return;
		}
		this.agent.emitExternalEvent({ type: "message_start", message: card });
		this.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		this.#drainStrandedQueuedMessages();
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	#isPrewalkNoop(prewalk: Prewalk): boolean {
		return prewalkWouldBeNoop(this.model, this.configuredThinkingLevel(), prewalk.target, prewalk.thinkingLevel);
	}

	#clearPrewalkState(): void {
		this.#prewalk = undefined;
		this.#prewalkPlanInjected = false;
		this.#prewalkContinuePending = false;
		this.#prewalkTodoSeen = false;
	}

	#disarmNoopPrewalk(prewalk: Prewalk): void {
		this.#clearPrewalkState();
		this.emitNotice(
			"info",
			`Prewalk: target ${prewalk.target.provider}/${prewalk.target.id} already matches the active model and thinking level; nothing to switch.`,
			"prewalk",
		);
	}

	/** Advance the one-way prewalk switch at a completed assistant-turn boundary. */
	async #advancePrewalk(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		if (this.#isPrewalkNoop(prewalk)) {
			this.#scrubPrewalkPlanNudge(liveMessages);
			this.#disarmNoopPrewalk(prewalk);
			return;
		}

		const todoCalledThisTurn = context.toolResults.some(result => result.toolName === "todo" && !result.isError);
		if (todoCalledThisTurn) this.#prewalkTodoSeen = true;

		// The plan nudge asks for a prose plan before implementation begins,
		// but the agent loop treats each text-only reply as terminal — observed
		// silently killing production SWE-bench runs before any code was ever
		// written. Tool progress re-arms one continuation, allowing split flows
		// such as plan → todo → prose → read → prose → edit/write. Consuming the
		// arm before steering also detects completion: two consecutive text-only
		// replies have no intervening progress, so the second ends naturally
		// instead of producing the #5551 loop.
		const hasToolResults = context.toolResults.length > 0;
		if (this.#prewalkPlanInjected && hasToolResults) {
			this.#prewalkContinuePending = true;
		} else if (this.#prewalkContinuePending) {
			this.#prewalkContinuePending = false;
			this.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: prewalkContinuePrompt,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		// Todo gate: the plan nudge instructs "finish the plan, then init the
		// todo list from it and start" — so the switch waits until a todo list
		// exists AND the model has actually started implementing (first
		// edit/write). The todo call itself never triggers: firing there handed
		// the fast model the whole implementation cold. The gate keys on the
		// ACTIVE tool set, not the registry: a registered-but-deactivated todo
		// (e.g. a restricted active-tool slate) is uncallable and would
		// deadlock the switch.
		const todoGateOpen = this.#prewalkTodoSeen || !this.getActiveToolNames().includes("todo");
		const action = todoGateOpen
			? context.toolResults.find(result => isPrewalkImplementationAction(result))
			: undefined;
		if (!action) {
			if (!this.#prewalkPlanInjected) {
				this.#prewalkPlanInjected = true;
				this.#prewalkContinuePending = true;
				this.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: prewalkPlanPrompt,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#waitForSessionMessagePersistence(toolResult);
		}

		this.#scrubPrewalkPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.#isPrewalkNoop(prewalk)) {
			this.#disarmNoopPrewalk(prewalk);
			return;
		}

		await this.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
		this.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: prewalkChecklistPrompt,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	/**
	 * Arm prewalk outside the normal startup path (the `/prewalk` slash
	 * command): sets the target and immediately steers the plan nudge rather
	 * than waiting for the next turn boundary, since an explicit manual
	 * invocation means "start this now." A no-op with a notice if a prewalk
	 * is already armed and waiting.
	 */
	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): boolean {
		const active = this.#prewalk;
		if (active) {
			this.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return (
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel
			);
		}
		const candidate = { target, thinkingLevel };
		if (this.#isPrewalkNoop(candidate)) {
			this.#disarmNoopPrewalk(candidate);
			return false;
		}
		this.#prewalk = candidate;
		this.#prewalkPlanInjected = true;
		this.#prewalkContinuePending = true;
		this.#prewalkTodoSeen = false;
		this.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
		return true;
	}

	/**
	 * Remove the one-run plan nudge from the live model context before the
	 * switch. The nudge is transient and is never persisted, so resume, fork,
	 * and context rebuilds cannot resurrect it.
	 */
	#scrubPrewalkPlanNudge(liveMessages: AgentMessage[]): void {
		if (!this.#prewalkPlanInjected) return;
		const isPlanNudge = isPrewalkPlanNudge;
		for (let i = liveMessages.length - 1; i >= 0; i--) {
			if (isPlanNudge(liveMessages[i])) liveMessages.splice(i, 1);
		}
		const stateMessages = this.agent.state.messages;
		const filtered = stateMessages.filter(m => !isPlanNudge(m));
		if (filtered.length !== stateMessages.length) this.agent.replaceMessages(filtered);
	}

	/**
	 * Lazily arm PlanYolo before the first prompt is built: restricts tools to
	 * the plan-mode read-only set (plus `write`, which carries the resolution
	 * devices including `xd://propose`), marks plan-mode state so
	 * `#buildPlanModeMessage` injects the standard plan-mode-active instructions
	 * on this and every following prompt, and registers the auto-approve plan-proposal handler.
	 * Idempotent — a no-op once armed or when PlanYolo is not configured.
	 */
	async #armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousTools = this.getEnabledToolNames();
		const augmentations = this.hasBuiltInTool("write") ? ["write"] : [];
		await this.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
		this.#planYoloPreviousTools = previousTools;
		this.setPlanModeState({
			enabled: true,
			planFilePath: this.getPlanReferencePath() || "local://PLAN.md",
			workflow: "parallel",
		});
		this.setPlanProposalHandler(title => this.#approvePlanYoloProposal(title));
	}

	/**
	 * Plan-proposal handler while PlanYolo's plan phase is active. Auto-approves
	 * the instant the model writes the plan slug/title to `xd://propose` — no
	 * interactive review, the headless counterpart to plan mode's "Approve and
	 * execute" — then restores tools, exits plan-mode state, switches to the
	 * configured `target`, and hands off the approved plan for it to implement.
	 */
	#approvePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		return this.#finalizePlanYoloProposal(title);
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const planYolo = this.#planYolo;
		const state = this.getPlanModeState();
		if (!planYolo || !state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readPlanYoloFile(url),
			listPlanFiles: () => this.#listPlanYoloFiles(),
		});
		this.setPlanModeState(undefined);
		const previousTools = this.#planYoloPreviousTools;
		try {
			if (previousTools) {
				await this.setActiveToolsByName(previousTools);
			}
		} catch (error) {
			this.setPlanModeState(state);
			throw error;
		}
		this.setPlanProposalHandler(null);
		this.#planYolo = undefined;
		this.#planYoloPreviousTools = undefined;
		await this.setModelTemporary(planYolo.target, planYolo.thinkingLevel, { ephemeral: true });
		this.emitNotice(
			"info",
			`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${resolvedTitle}".`,
			"plan-yolo",
		);
		this.agent.steer({
			role: "custom",
			customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
			content: prompt.render(planYoloHandoffPrompt, { planFilePath, title: resolvedTitle }),
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
		return {
			content: [{ type: "text" as const, text: `Plan approved. Implementing now with ${planYolo.target.id}.` }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}

	async #readPlanYoloFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), this.#localProtocolOptions())
			: resolveToCwd(planFilePath, this.sessionManager.getCwd());
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  a fallback for `resolveApprovedPlan` when the agent dropped `extra.title`. */
	async #listPlanYoloFiles(): Promise<string[]> {
		const localRoot = resolveLocalUrlToPath("local://", this.#localProtocolOptions());
		try {
			const entries = await fs.promises.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.promises.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.#bashSessionTarget = {
			sessionId: this.sessionManager.getSessionId(),
			refs: 0,
			destination: { kind: "current", manager: this.sessionManager },
		};
		this.settings = config.settings;
		this.#responseDocuments = new ResponseDocumentRuntime(this.sessionManager, this.settings);
		this.#sessionWritesEnabled = config.sessionAccess !== "read_only";
		this.#autoApprove = config.autoApprove === true;
		// Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#parentEvalSessionId = config.parentEvalSessionId;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		if (config.thinkingLevel === AUTO_THINKING) {
			// `auto` is session-level: keep the flag and show a provisional concrete
			// level (the agent's initial effort was already set by the caller) until
			// the first user turn is classified.
			this.#autoThinking = true;
			this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
		} else {
			this.#thinkingLevel = config.thinkingLevel;
		}
		if (config.prewalk) {
			this.#prewalk = config.prewalk;
		}
		if (config.planYolo) {
			this.#planYolo = config.planYolo;
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);

		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#customCommands = config.customCommands ?? [];
		this.#skillsReloadable = config.skillsReloadable ?? true;
		this.#skillsSettings = config.skillsSettings;
		this.#executionRuntime = config.executionRuntime;
		this.#ownedExecutionRuntime = config.ownedExecutionRuntime;
		this.#executionScopeId = config.executionScopeId;
		this.#modelRegistry = config.modelRegistry;
		this.#taskContractRegistry = config.taskContractRegistry;
		this.#modelRouteLease = new ModelRouteLeaseController(
			() => this.#modelRegistry.getModelRouteRegistry(),
			config.initialModelRoute,
		);
		this.#recoverPersistedSanLoopRun();
		// Resolve the wire service-tier per request so the Fireworks Priority
		// toggle scopes priority to Fireworks alone, without mutating the shared
		// session `serviceTier` that drives `/fast` and OpenAI/Anthropic priority.
		this.agent.serviceTierResolver = model => this.#effectiveServiceTier(model);
		this.#serviceTierByFamily = config.serviceTierByFamily ?? {};
		this.#advisorTools = config.advisorTools;
		this.#advisorWatchdogPrompt = config.advisorWatchdogPrompt;
		this.#advisorSharedInstructions = config.advisorSharedInstructions;
		this.#advisorContextPrompt = config.advisorContextPrompt;
		this.#advisorConfigs = config.advisorConfigs;
		this.#titleSystemPrompt = config.titleSystemPrompt;
		this.#pruneToolDescriptions = config.pruneToolDescriptions === true;
		this.#validateRetryFallbackChains();
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#createVibeTools = config.createVibeTools;
		this.#builtInToolNames = new Set(config.builtInToolNames ?? []);
		this.#presentationPinnedToolNames = config.presentationPinnedToolNames;
		this.#ensureWriteRegistered = config.ensureWriteRegistered;
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.agent.setTransformContext((messages, signal) => this.#transformContextForProvider(messages, signal));
		this.#transformProviderContext = config.transformProviderContext;
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		this.#advisorStreamFn = config.advisorStreamFn;
		this.#preferWebsockets = config.preferWebsockets;
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#extractRewindReport(messages);
			if (rewindReport) {
				this.#pendingRewindReport = undefined;
				await this.#applyRewind(rewindReport, messages);
				return;
			}
			const userInputQueued = this.#hasQueuedUserMessage();
			if (context?.message.role === "assistant") {
				if (userInputQueued) {
					this.#resetToolLoopGuardsForUserInput();
				} else {
					const detection = this.#activeToolCallLoopGuard()?.recordTurn({
						message: context.message,
						toolResults: context.toolResults,
					});
					if (detection) this.#maybeInjectToolCallLoopRedirect(messages, detection);
					const progressDetection = this.#activeToolProgressGuard()?.recordTurn({
						message: context.message,
						toolResults: context.toolResults,
					});
					if (progressDetection) this.#maybeInjectToolProgressGuardMessage(messages, progressDetection);
				}
			}
			if (!userInputQueued) await this.#advancePrewalk(messages, context);
			this.#advisorPrimaryTurnsCompleted++;
			if (this.#advisors.length > 0) {
				for (const a of this.#advisors) {
					if (a.runtime.disposed) continue;
					try {
						a.runtime.onTurnEnd(messages, { willContinue: context?.willContinue });
					} catch (advisorErr) {
						// CRITICAL boundary: NOTHING an advisor does may abort the
						// primary agent's turn-end. A throwing advisor loses its
						// delta; the primary continues untouched.
						logger.warn("advisor onTurnEnd threw; delta dropped", {
							advisor: a.name,
							err: String(advisorErr),
						});
					}
				}
				const syncBacklog = this.settings.get("advisor.syncBacklog");
				if (syncBacklog !== "off" && !this.#hasQueuedUserMessage()) {
					const threshold = parseInt(syncBacklog, 10);
					// Parallel so the 30s catch-up budget is shared across advisors, not summed.
					await Promise.all(this.#advisors.map(a => a.runtime.waitForCatchup(30000, threshold, signal)));
				}
			}
			await this.#maintainContextMidRun(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#schedulePostPromptTask(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides. Peer IRCs share the aside
		// injection boundary, but also expose a non-consuming interrupt peek so
		// `hub` waits can return early before the boundary drains them.
		this.agent.hasIrcInterrupts = () => this.#pendingIrcInterrupts.length > 0;
		this.agent.setAsideMessageProvider(() => {
			const pendingIrc = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
			this.#pendingIrcInterrupts = [];
			this.#pendingIrcAsides = [];
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			// Mid-run todo reconciliation — evaluated at injection time so a turn
			// that flips a todo just before this poll suppresses the nudge.
			thunks.push(() => this.#takeMidRunTodoNudge());
			return thunks;
		});
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#getLocalCalendarDate = config.getLocalCalendarDate ?? formatLocalCalendarDate;
		this.#getMcpServerInstructions = config.getMcpServerInstructions;
		this.getXdevToolEntries = config.getXdevToolEntries ?? (() => []);
		this.#xdevRegistry = config.xdevRegistry;
		this.#mountedXdevToolNames = new Set(config.initialMountedXdevToolNames ?? []);
		this.#setActiveToolNames = config.setActiveToolNames;
		this.#disconnectOwnedMcpManager = config.disconnectOwnedMcpManager;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#promptModelKey = this.#currentPromptModelKey();
		this.#ttsrManager = config.ttsrManager;
		this.#obfuscator = config.obfuscator;
		this.#agentId = config.agentId;
		this.#agentKind = config.agentKind ?? "main";
		this.#providerSessionId = config.providerSessionId;
		this.#inheritedProviderPromptCacheKey =
			config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined;
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#preCacheStreamingEditFile(event);
			this.#maybeAbortStreamingEdit(event);
			this.#maybeInterruptGeminiHeaderRunaway(message, assistantMessageEvent);
		});
		// Tool-result hook owns synchronous post-tool actions that must affect the current loop.
		this.agent.afterToolCall = ctx => this.#afterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#syncTodoPhasesFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (!this.#sessionWritesEnabled) return;
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});
		if (this.#sessionWritesEnabled) this.#registerExitRecorder();

		this.#advisorEnabled = this.settings.get("advisor.enabled") as boolean;
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();

		this.#rehydrateCheckpointRewindState();

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		this.#unsubscribeModelRoles = onModelRolesChanged(() => {
			if (!this.#advisorEnabled || this.#isDisposed) return;
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			this.#buildAdvisorRuntime(true);
		});
	}
	// -------------------------------------------------------------------------
	// Advisor runtime lifecycle
	// -------------------------------------------------------------------------
	#advisorImmuneTurnLimit(): number {
		const immuneTurns = this.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#advisorPrimaryTurnsCompleted`, `#advisorInterruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	#resetAdvisorSessionState(): void {
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset();
			a.adviseTool.resetDeliveredNotes();
			a.emissionGuard.reset();
			this.#attachAdvisorRecorderFeed(a);
		}
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.yieldQueue.clear("advisor");
		this.#extractQueuedAdvisorCards();
		if (this.#pendingNextTurnMessages.some(isAdvisorCard)) {
			this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
		}
	}

	#resolveAdvisorRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#advisorConfigs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#advisorConfigs!;
		const descriptors: AdvisorRuntimeDescriptor[] = [];
		const usedSlugs = new Set<string>();
		for (const config of roster) {
			let slug = legacy ? "" : slugifyAdvisorName(config.name);
			if (slug) {
				let candidate = slug;
				let n = 2;
				while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
				slug = candidate;
				usedSlugs.add(slug);
			}
			// Per-advisor toggle: skip disabled advisors but keep them in the
			// status map so they show `○` rather than disappearing.
			if (config.enabled === false) {
				this.#advisorStatuses.set(slug, { name: config.name, status: "paused" });
				continue;
			}

			// Resolve the advisor's model: an explicit `model` override wins; else the
			// `advisor` role chain. A model that fails to resolve skips just this advisor.
			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], this.#modelRegistry, this.settings);
				model = resolved.model;
				thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
				if (!model) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						this.emitNotice("warning", `Advisor "${config.name}": no model matched "${config.model}"`, "advisor");
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(this.settings, this.#modelRegistry);
				if (!sel) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						logger.debug("advisor enabled but no model assigned to the 'advisor' role; advisor inactive", {
							advisor: config.name,
						});
					}
					continue;
				}
				model = sel.model;
				thinkingLevel = concreteThinkingLevel(sel.thinkingLevel);
			}
			// Clamp the effort against the resolved model. Historically we defaulted
			// to `ThinkingLevel.Medium` unconditionally, which threw at first stream
			// on reasoning models that expose no controllable effort surface
			// (e.g. `devin-agent`: Cascade routes by sibling model id, not a wire
			// param; `getSupportedEfforts` returns `[]`). `resolveThinkingLevelForModel`
			// preserves an explicit `off`, clamps a concrete effort into the model's
			// supported range, and returns `undefined` for reasoning models without
			// controllable efforts — for that case we forward `Inherit` so no effort
			// is sent and reasoning stays enabled (matching the `auto`-path fix for
			// Devin models via `clampAutoThinkingEffort`). See #4579.
			const requestedLevel = thinkingLevel ?? ThinkingLevel.Medium;
			const resolvedLevel = resolveThinkingLevelForModel(model, requestedLevel);
			const advisorThinkingLevel: ThinkingLevel = resolvedLevel ?? ThinkingLevel.Inherit;
			// Record the status entry now (in roster order) so the Map's insertion
			// order matches the configured roster even when earlier advisors were
			// skipped as paused/no_model. The build loop overwrites this to "running"
			// without changing insertion order.
			this.#advisorStatuses.set(slug, { name: config.name, status: "running" });
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				signature: this.#advisorRuntimeSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#advisorRuntimeSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join(
			"\u001f",
		);
	}

	#advisorRuntimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#buildAdvisorRuntime(seedToCurrent = false): boolean {
		if (this.#isDisposed) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#advisorEnabled) return false;
		if (this.#agentKind !== "main" && !this.settings.get("advisor.subagents")) return false;

		// Rebuild the status map from scratch so removed/renamed advisors don't
		// leave stale entries. #resolveAdvisorRuntimeDescriptors populates every
		// entry (`paused`/`no_model`/`running`) in roster order; the build loop
		// below confirms `running` for successfully built advisors.
		this.#advisorStatuses.clear();
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(true);

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.
		const advisorTierSetting = this.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? this.#effectiveServiceTier(model)
				: resolveModelServiceTier(advisorTierMap, model);

		for (const descriptor of descriptors) {
			const {
				config,
				slug,
				model: advisorModel,
				name: advisorName,
				thinkingLevel: advisorThinkingLevel,
				signature,
			} = descriptor;

			const emissionGuard = new AdvisorEmissionGuard();
			const adviseTool = new AdviseTool((note, severity) => this.#routeAdvice(advisorRef, note, severity));

			// `#advisorWatchdogPrompt` already carries WATCHDOG.md + YAML shared
			// instructions; `config.instructions` adds this advisor's specialization.
			const systemPrompt = [advisorSystemPrompt];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#advisorTools ?? []).filter(t => names.has(t.name));
			const advisorLoopTools: AgentTool<any>[] = [adviseTool, ...tools];
			const advisorToolMap = new Map<string, AgentTool>();
			const availableAdvisorToolNames = new Set<string>();
			for (const tool of advisorLoopTools) {
				availableAdvisorToolNames.add(tool.name);
				advisorToolMap.set(tool.name, tool);
				if (tool.customWireName !== undefined) {
					availableAdvisorToolNames.add(tool.customWireName);
					advisorToolMap.set(tool.customWireName, tool);
				}
			}
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.sessionId;
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
				this.#advisorProviderSessionIds,
				primaryProviderSessionId,
				slug,
			);
			const appendOnlyContext = new AppendOnlyContextManager();

			// Thread the primary's telemetry into the advisor loop so the advisor
			// model's GenAI spans + usage/cost hooks fire stamped with the local advisor
			// identity. `conversationId` is cleared so provider telemetry falls back to
			// the UUIDv7 provider session id, not the local `-advisor` label.
			const advisorTelemetry = this.agent.telemetry
				? {
						...this.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
							description: formatModelString(advisorModel),
						},
						conversationId: undefined,
					}
				: undefined;
			// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
			// providerSessionState, promptCacheKey, transformProviderContext) so each
			// advisor's requests cache, route, and obfuscate like the main turn.
			// `promptCacheKey` preserves an explicitly pinned provider cache key
			// unchanged so tan/shared-session advisor calls read the exact shard the
			// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
			// Codex request identity remains UUID-shaped while local labels keep the
			// `-advisor` suffix.
			const advisorPromptCacheKey = this.agent.promptCacheKey ?? advisorProviderSessionId;
			// On the Cursor provider every tool runs server-side and is dispatched
			// back through `cursorExecHandlers`; without this bridge the advisor's
			// own tools (including the MCP `advise` tool) return `toolNotFound` and
			// no advice is ever routed (issue #5680). Mirrors the primary agent's
			// bridge (`sdk.ts`), scoped to this advisor's granted tool set.
			// Cursor's native `delete` frame removes files directly, bypassing the
			// tool map, so gate it on the advisor actually holding a file-mutating
			// tool. A default read-only advisor (advise/read/grep/glob) never gets
			// to delete workspace files it was never granted (issue #5680 review).
			const advisorCanMutateFiles = advisorToolMap.has("write") || advisorToolMap.has("edit");
			if (advisorCanMutateFiles) availableAdvisorToolNames.add("delete");
			const advisorCursorExecHandlers = new CursorExecHandlers({
				cwd: this.sessionManager.getCwd(),
				getCwd: () => this.sessionManager.getCwd(),
				tools: advisorToolMap,
				allowNativeDelete: advisorCanMutateFiles,
			});
			const advisorAgent = new Agent({
				initialState: {
					systemPrompt,
					model: advisorModel,
					thinkingLevel: toReasoningEffort(advisorThinkingLevel),
					tools: advisorLoopTools,
				},
				appendOnlyContext,
				sessionId: advisorProviderSessionId,
				promptCacheKey: advisorPromptCacheKey,
				providerSessionState: this.#providerSessionState,
				cursorExecHandlers: advisorCursorExecHandlers,
				cwdResolver: () => this.sessionManager.getCwd(),
				preferWebsockets: this.#preferWebsockets,
				getApiKey: requestModel => this.#modelRegistry.resolver(requestModel, advisorProviderSessionId),
				streamFn: this.#advisorStreamFn,
				onPayload: this.#onPayload,
				onResponse: this.#onResponse,
				onSseEvent: this.#onSseEvent,
				transformProviderContext: this.#transformProviderContext,
				intentTracing: false,
				transformAssistantMessage: message => {
					quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
						message,
						availableAdvisorToolNames,
						buildAdvisorQuarantineSourceText(currentAdvisorInput, advisorAgent.state.messages),
					);
				},
				telemetry: advisorTelemetry,
				serviceTier: undefined,
				serviceTierResolver: advisorServiceTierResolver,
			});
			advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));

			const advisorAgentFacade: AdvisorAgent = {
				prompt: async input => {
					let quarantined: string | undefined;
					try {
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = input;
						await advisorAgent.prompt(input);
						quarantined = quarantinedAdvisorOutput;
					} finally {
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = "";
					}
					if (quarantined) throw new AdvisorOutputQuarantinedError(quarantined);
				},
				abort: reason => advisorAgent.abort(reason),
				reset: () => {
					advisorAgent.reset();
					appendOnlyContext.log.clear();
				},
				rollbackTo: count => {
					// Drop the failed user batch + synthetic assistant-error turn
					// `Agent.#runLoop` appended for a turn ending in `stopReason: "error"`.
					const messages = advisorAgent.state.messages;
					if (count < messages.length) {
						messages.length = count;
					}
					appendOnlyContext.resetSyncCursor();
					advisorAgent.state.error = undefined;
				},
				state: advisorAgent.state,
			};

			// Persist this advisor's turns to `<session>/__advisor[.<slug>].jsonl`
			// (resolved lazily so it follows session switches) for stats attribution
			// and Agent Hub observability, without registering it as a peer.
			const recorder = new AdvisorTranscriptRecorder(
				() => this.sessionManager.getSessionFile(),
				() => this.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),
				// On the advisor on→off→on toggle, wait for the prior recorders' closes
				// so two SessionManagers never hold the same file at once.
				this.#advisorRecorderClosed,
			);
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.agent.state.messages,
				enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
				maintainContext: incomingTokens => this.#maintainAdvisorContext(advisorRef, incomingTokens),
				obfuscator: this.#obfuscator,
				beginAdvisorUpdate: () => advisorRef.emissionGuard.beginUpdate(),
				onTurnError: (error, failedMessages) => this.#recoverAdvisorTurn(advisorRef, error, failedMessages),
				onTurnSuccess: async () => {
					const fallback = advisorRef.retryFallback;
					if (!advisorRef.retryFallbackPendingSuccess || !fallback) return;
					advisorRef.retryFallbackPendingSuccess = false;
					await this.#emitSessionEvent({
						type: "retry_fallback_succeeded",
						model: formatRetryFallbackSelector(advisorRef.agent.state.model, advisorRef.thinkingLevel),
						role: fallback.role,
					});
				},
				notifyFailure: error => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "error" });
					const message = error instanceof Error ? error.message : String(error);
					this.emitNotice(
						"warning",
						`Advisor${slug ? ` "${advisorName}"` : ""} unavailable for ${formatModelString(advisorAgent.state.model)}: ${message}`,
						"advisor",
					);
				},
				notifyQuotaExhausted: () => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "quota_exhausted" });
					this.emitNotice("warning", `Advisor "${advisorName}" quota exhausted — pausing until reset.`, "advisor");
				},
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				agent: advisorAgent,
				runtime,
				adviseTool,
				emissionGuard,
				recorder,
				recorderClosed: Promise.resolve(),
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				providerSessionId: advisorProviderSessionId,
				retryFallbackPendingSuccess: false,
				signature,
			};
			this.#attachAdvisorRecorderFeed(advisorRef);
			if (seedToCurrent) runtime.seedTo(this.agent.state.messages.length);
			this.#advisorStatuses.set(slug, { name: advisorName, status: "running" });
			this.#advisors.push(advisorRef);
		}

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
		if (this.#advisors.length > 0 && !this.#advisorYieldQueueUnsubscribe) {
			this.#advisorYieldQueueUnsubscribe = this.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content: formatAdvisorBatchContent(entries),
								details: { notes: entries } satisfies AdvisorMessageDetails,
							} satisfies CustomMessage),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	/**
	 * Route one accepted advice note from `advisor` to the primary. Concern and
	 * blocker interrupt the running agent through the steering channel; once the
	 * loop has yielded, `triggerTurn` resumes it. After a terminal text answer with
	 * no queued work, a concern is preserved as a visible advisor card, while a
	 * blocker wakes the primary to acknowledge work it handed off incorrectly.
	 * After a deliberate user interrupt auto-resume is suppressed while idle/unwinding
	 * (the note becomes a preserved card re-entering on resume); a live-streaming turn is
	 * steered in directly. A plain nit always rides the non-interrupting YieldQueue
	 * aside. Suppression by the per-advisor emission guard drops the note silently —
	 * the model still saw `Recorded.`, so it isn't tempted to rephrase the same note
	 * past the dedupe.
	 */
	#hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.agent.hasQueuedMessages() || this.#pendingNextTurnMessages.length > 0) return false;
		const messages = this.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): void {
		if (!advisor.emissionGuard.accept(note)) {
			logger.debug("advisor advice suppressed by emission guard", { severity, advisor: advisor.name });
			return;
		}
		// When newer primary turns already arrived while the advisor model was
		// processing this batch, the advice was generated without seeing them.
		// Append a lightweight staleness caveat so the primary can weigh recency.
		const deliveredNote = annotateForStaleness(note, advisor.runtime.hasFreshBacklog);
		// The implicit single ("default") advisor stamps no source name, so its
		// agent-facing `<advisory>` bytes stay identical to the pre-multi-advisor path.
		const source = advisor.slug ? advisor.name : undefined;
		const interrupting = isInterruptingSeverity(severity);
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			// Key on the live agent-core loop, not session `isStreaming` (which also
			// counts `#promptInFlightCount` during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
			streaming: this.agent.state.isStreaming,
			aborting: this.#abortInProgress,
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isAdvisorInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.yieldQueue.enqueue("advisor", { note: deliveredNote, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note: deliveredNote, severity, advisor: source }];
		const content = formatAdvisorBatchContent(notes);
		const details = { notes } satisfies AdvisorMessageDetails;
		if (channel === "preserve") {
			this.#preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		// A steered interrupting note only continues the run when the session can
		// actually start (or is already running) a turn. Two idle cases cannot, so
		// `sendCustomMessage({ triggerTurn: true })` would silently bury the card in
		// `#pendingNextTurnMessages` until the next user prompt — strictly worse than
		// the visible preserved card. Preserve instead:
		//  - Plan mode: only user-driven turns converge on ask/resolve.
		//  - ACP bridges with `deferAgentInitiatedTurns`: the client cannot show an
		//    agent-initiated turn as busy, so idle triggers are refused (#5628 review).
		const cannotAutoTrigger =
			!this.agent.state.isStreaming &&
			this.#clientBridge?.deferAgentInitiatedTurns === true &&
			!this.#allowAcpAgentInitiatedTurns;
		if (this.#planModeState?.enabled || cannotAutoTrigger) {
			this.#preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		// Arm the post-interrupt immune window only now that a turn is actually
		// being steered/triggered. A merely preserved card never interrupts, so
		// arming earlier would downgrade the next `advisor.immuneTurns` worth of
		// real concerns/blockers to skip-idle-flush asides (#5628 review).
		this.#recordAdvisorInterruptDelivered();
		void this.sendCustomMessage(
			{ customType: "advisor", content, display: true, attribution: "agent", details },
			{ deliverAs: "steer", triggerTurn: true },
		).catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
	}

	/** Re-prime every advisor's transcript view (compaction/shake/rewind) without the
	 *  session-level latch reset {@link #resetAdvisorSessionState} performs. */
	#resetAllAdvisorRuntimes(): void {
		for (const a of this.#advisors) a.runtime.reset();
	}

	#stopAdvisorRuntime(): void {
		// Detach each recorder feed BEFORE aborting its advisor agent: dispose() aborts
		// the loop, and an abort emits a final `message_end` we must not enqueue against
		// a closing recorder (it would reopen and resurrect an already-released file).
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();
			// Capture each close so dispose()/`/drop` can await the queued open+append+close —
			// the last advisor turn would otherwise be lost on a fast process exit.
			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachAdvisorRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type === "message_end") advisor.recorder.record(event.message);
		});
	}

	/** Switch one advisor model while preserving its context and effort invariants. */
	#setAdvisorModel(advisor: ActiveAdvisor, model: Model, requestedThinkingLevel: ThinkingLevel): ThinkingLevel {
		const resolvedThinkingLevel = resolveThinkingLevelForModel(model, requestedThinkingLevel);
		const nextThinkingLevel = resolvedThinkingLevel ?? ThinkingLevel.Inherit;
		advisor.agent.setModel(model);
		advisor.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
		advisor.agent.setDisableReasoning(shouldDisableReasoning(nextThinkingLevel));
		advisor.agent.appendOnlyContext?.invalidateForModelChange();
		advisor.model = model;
		advisor.thinkingLevel = nextThinkingLevel;
		return nextThinkingLevel;
	}

	/** Restore an advisor's configured primary once its fallback cooldown expires. */
	async #maybeRestoreAdvisorRetryFallbackPrimary(advisor: ActiveAdvisor): Promise<void> {
		const fallback = advisor.retryFallback;
		if (!fallback || this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const originalSelector = parseRetryFallbackSelector(fallback.originalSelector, this.#modelRegistry);
		if (!originalSelector) {
			advisor.retryFallback = undefined;
			advisor.retryFallbackPendingSuccess = false;
			return;
		}
		const currentSelector = formatRetryFallbackSelector(advisor.agent.state.model, advisor.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				advisor.retryFallback = undefined;
				advisor.retryFallbackPendingSuccess = false;
			}
			return;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride([originalSelector.raw], this.#modelRegistry, this.settings);
		const primaryModel =
			resolvedPrimary.model ?? this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#modelRegistry.getApiKey(primaryModel, advisor.providerSessionId);
		if (!apiKey) return;

		const thinkingToApply =
			advisor.thinkingLevel === fallback.lastAppliedThinkingLevel
				? fallback.originalThinkingLevel
				: advisor.thinkingLevel;
		this.#setAdvisorModel(advisor, primaryModel, thinkingToApply);
		this.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(primaryModel));
		advisor.retryFallback = undefined;
		advisor.retryFallbackPendingSuccess = false;
	}

	/**
	 * Apply the advisor's configured provider-failure fallback chain after
	 * same-provider credential rotation has no usable sibling.
	 */
	async #recoverAdvisorTurn(
		advisor: ActiveAdvisor,
		error: unknown,
		failedMessages: readonly AgentMessage[],
	): Promise<boolean> {
		if (error instanceof AdvisorOutputQuarantinedError) return false;

		const failedMessage = failedMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const assistantFailure = failedMessage?.stopReason === "error" ? failedMessage : undefined;
		// Advisor 不经过 text print 的最终输出缓冲，非空文本始终按已提交处理。
		if (assistantFailure && this.#hasReplayUnsafeOutput(assistantFailure, true)) return false;

		const currentModel = advisor.agent.state.model;
		const message = assistantFailure?.errorMessage ?? (error instanceof Error ? error.message : String(error));
		const errorId = assistantFailure
			? AIError.classifyMessage({
					api: currentModel.api,
					errorId: assistantFailure.errorId,
					errorMessage: message,
					errorStatus: assistantFailure.errorStatus,
				})
			: AIError.classify(error, currentModel.api);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) return false;
		if (
			AIError.is(errorId, AIError.Flag.ContextOverflow) ||
			(assistantFailure && AIError.isContextOverflow(assistantFailure, currentModel.contextWindow ?? 0))
		) {
			return false;
		}

		const accountPolicyDenial = AIError.is(errorId, AIError.Flag.AccountPolicy);
		if (accountPolicyDenial) {
			const switched = await this.#modelRegistry.authStorage.rotateSessionCredential(
				currentModel.provider,
				advisor.providerSessionId,
				{ error: message, modelId: currentModel.id },
			);
			if (switched) return true;
		}

		const retryAfterMs = extractRetryHint(undefined, message);
		const usageLimit =
			AIError.is(errorId, AIError.Flag.UsageLimit) ||
			isUsageLimitOutcome(extractHttpStatusFromError(error), message);
		if (usageLimit) {
			const outcome = await this.#modelRegistry.authStorage.markUsageLimitReached(
				currentModel.provider,
				advisor.providerSessionId,
				{
					retryAfterMs,
					baseUrl: currentModel.baseUrl,
					modelId: currentModel.id,
				},
			);
			if (outcome.switched) return true;
		}
		if (!assistantFailure && !accountPolicyDenial && !usageLimit) return false;

		const currentSelector = formatRetryFallbackSelector(currentModel, advisor.thinkingLevel);

		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		const role = advisor.retryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector, currentModel);
		if (!role || this.#findRetryFallbackCandidates(role, currentSelector, currentModel).length === 0) return false;

		this.#noteRetryFallbackCooldown(currentSelector, retryAfterMs, message);
		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector, currentModel)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
			const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
			if (!candidate || modelsAreEqual(candidate, currentModel)) continue;
			const apiKey = await this.#modelRegistry.getApiKey(candidate, advisor.providerSessionId);
			if (!apiKey) continue;

			const originalThinkingLevel = advisor.thinkingLevel;
			const requestedThinkingLevel = selector.thinkingLevel ?? originalThinkingLevel;
			const nextThinkingLevel = this.#setAdvisorModel(advisor, candidate, requestedThinkingLevel);
			if (advisor.retryFallback) {
				advisor.retryFallback.lastAppliedThinkingLevel = nextThinkingLevel;
			} else {
				advisor.retryFallback = {
					role,
					originalSelector: currentSelector,
					originalThinkingLevel,
					lastAppliedThinkingLevel: nextThinkingLevel,
				};
			}
			advisor.retryFallbackPendingSuccess = true;
			this.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(candidate));
			await this.#emitSessionEvent({
				type: "retry_fallback_applied",
				from: currentSelector,
				to: selector.raw,
				role,
			});
			return true;
		}
		return false;
	}

	async #promoteAdvisorContextModel(advisor: ActiveAdvisor, currentModel: Model): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		// Preserve this advisor's own thinking level (a configured `model:...:high`
		// keeps its suffix across a promotion); only the model changes.
		const advisorThinkingLevel = advisor.thinkingLevel;
		try {
			this.#setAdvisorModel(advisor, targetModel, advisorThinkingLevel);
			logger.debug("Advisor context promotion switched model on overflow", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #maintainAdvisorContext(advisor: ActiveAdvisor, incomingTokens: number): Promise<boolean> {
		await this.#maybeRestoreAdvisorRetryFallbackPrimary(advisor);
		const agent = advisor.agent;

		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return false;
		if (!compactionSettings.enabled) return false;

		const advisorModel = agent.state.model;
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = agent.state.messages;
		const estimateOptions = { excludeEncryptedReasoning: true } as const;
		let storedConversationTokens = 0;
		for (const message of messages) {
			storedConversationTokens += estimateTokens(message, estimateOptions);
		}
		// Provider usage (including cache reads and generated output) is the
		// trustworthy anchor for accumulated context. Add only the trailing incoming
		// delta to that arm. Floor it by a full local estimate — fixed advisor system
		// prompt, tool schemas, stored messages, and incoming delta — so provider
		// under-reporting or payload transforms cannot suppress maintenance.
		const providerContextTokens = this.#estimateAdvisorContextTokens(messages) + incomingTokens;
		const localContextTokens =
			countTokens(agent.state.systemPrompt) +
			estimateToolSchemaTokens(agent.state.tools) +
			storedConversationTokens +
			incomingTokens;
		const contextTokens = compactionContextTokens(providerContextTokens, localContextTokens);

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		// 1. Try promotion first
		if (await this.#promoteAdvisorContextModel(advisor, advisorModel)) {
			// Promotion succeeded, check if new model has enough space
			const newModel = agent.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

		// 2. Run compaction on advisor messages
		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				const advisorSummary = message as AdvisorCompactionSummaryMessage;
				return {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId: advisorSummary.firstKeptEntryId || `msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const availableModels = this.#modelRegistry.getAvailable();
		const candidates = this.#resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			// No compaction candidates, fallback to re-prime
			return true;
		}
		const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			this.sessionId,
			advisor.slug,
		);
		const preparation = prepareCompaction(
			pathEntries,
			compactionSettings,
			await this.#runnableCompactionCandidates(candidates, advisorProviderSessionId),
		);
		if (!preparation) {
			// Cannot prepare compaction, fallback to re-prime
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		// Advisor state is in-memory-only, so snapcompact's frame archive has no
		// stable SessionEntry preserveData slot to carry across future advisor
		// maintenance runs. Use an LLM summary even when the primary session is
		// configured for snapcompact.

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;
		// Instrument the advisor's overflow-compaction one-shot like the primary
		// compaction path so the advisor model's maintenance call also emits spans.
		const telemetry = resolveTelemetry(agent.telemetry, advisorProviderSessionId);

		const codexCompaction = createCodexCompactionContext({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, advisorProviderSessionId);
			if (!apiKey) continue;

			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#modelRegistry.resolver(candidate, advisorProviderSessionId),
					undefined,
					undefined,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
						tools: agent.state.tools,
						sessionId: advisorProviderSessionId,
						promptCacheKey: advisorProviderSessionId,
						providerSessionState: this.#providerSessionState,
						codexCompaction,
						completeImpl: (requestModel, requestContext, requestOptions) =>
							this.#completeSideRequestWithProbe("compaction", requestModel, requestContext, requestOptions),
					},
				);
				break;
			} catch (error) {
				lastError = error;
			}
		}

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		// The retained messages still carry provider usage from before this
		// compaction. Record their exact array boundary on the in-memory summary so
		// only assistants appended afterward can become the next usage anchor.
		const advisorUsageAnchorStartIndex = preparation.recentMessages.length + 1;
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), shortSummary),
			firstKeptEntryId,
			advisorUsageAnchorStartIndex,
		} satisfies AdvisorCompactionSummaryMessage;

		agent.replaceMessages([summaryMessage, ...preparation.recentMessages]);
		return false;
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	/** Dequeue the next HARD forced tool choice for the upcoming LLM call, dropping
	 *  (and rejecting) one whose named tool is no longer active. */
	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	/**
	 * The per-turn tool-choice directive for the agent loop's `getToolChoice`. Priority:
	 *   1. a HARD forced choice from the queue (genuine forces: user-force, eager-todo, …) —
	 *      consuming (advances the queue generator);
	 *   2. else, when a non-forcing preview is pending, a {@link SoftToolRequirement} — a
	 *      PEEK (advances/pops nothing), so the agent-loop injects the reminder once per head
	 *      and escalates to a forced `write` only if the model declines to
	 *      resolve via `xd://resolve` or `xd://reject`. A compliant turn
	 *      pays ZERO tool_choice change (no prompt-cache messages-cache invalidation);
	 *   3. else undefined.
	 */
	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		if (this.#hasQueuedUserMessage()) this.#resetToolLoopGuardsForUserInput();
		if (this.#activeToolProgressGuard()?.consumeForcedFinalization()) return "none";
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,
				// Preview resolution is a `write` to xd://resolve or xd://reject;
				// only those exact shapes satisfy the requirement — a plain write
				// elsewhere is a detour.
				toolName: "write",
				satisfies: isPreviewResolutionToolCall,
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	/** Peek the head non-forcing pending preview invoker, for the preview-resolution dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	/** Clear stale non-forcing pending preview invokers after a resolve dispatch proves none can run. */
	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for the preview-resolution dispatch. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Plan-proposal handler consulted by `xd://propose` while plan mode is active. */
	#planProposalHandler: PlanProposalHandler | undefined;

	peekPlanProposalHandler(): PlanProposalHandler | undefined {
		return this.#planProposalHandler;
	}

	setPlanProposalHandler(handler: PlanProposalHandler | null): void {
		this.#planProposalHandler = handler ?? undefined;
	}

	#sessionSwitchReconciler: (() => Promise<void>) | undefined;

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.#sessionSwitchReconciler = reconciler ?? undefined;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	/** Hint forwarded to provider calls that support websocket transport. */
	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsightSessionState;
		this.#hindsightSessionState = state;
		return previous;
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
	}

	/** Whether an expected internal plan-mode abort is pending. Consumed by
	 *  `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER` on the next aborted
	 *  assistant message_end; callers clear it in `finally`. */
	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanInternalAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	/**
	 * Cancel async jobs registered by *this* agent only. Used by lifecycle
	 * transitions (newSession, switchSession, handoff, dispose) so a subagent
	 * cleans up its own background work without touching its parent's jobs.
	 *
	 * Cancellation runs against this session's scoped manager. Subagents have
	 * unique agent ids and inherit the parent's manager to clean up their own
	 * jobs. A secondary in-process top-level session gets no scoped manager,
	 * because it defaults to `MAIN_AGENT_ID`; reaching through the global
	 * singleton would tear down the owning primary session's bash/task jobs at
	 * dispose time (issue #1923).
	 *
	 * No-op when no manager is reachable or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		manager?.cancelAll({ ownerId: this.#agentId });
	}

	/**
	 * True when a background async job owned by this agent is still running with
	 * an unsuppressed delivery, or a finished job's delivery is still queued or
	 * in flight. Either way the async-result follow-up will re-wake the loop, so
	 * a settle observed now is a scheduling pause rather than a terminal stop:
	 * stop-time passes (todo reminder, session_stop hooks) defer to the settle
	 * reached once the session is fully idle. Suppressed deliveries
	 * (acknowledged, or watched by an in-flight `hub` wait) never wake the loop,
	 * so they don't count.
	 */
	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter)
		);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration.
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;
				// Listener may be an async function whose returned Promise we don't await;
				// attach a catch so a rejection does not become an unhandled rejection.
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#recordToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		if (!this.#sessionWritesEnabled) return;
		const data: ToolExecutionStartData = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: new Date().toISOString(),
		};
		// The assistant message already persists the full arguments; store only
		// the command/path projection the resume warning renders.
		const args = summarizeToolArguments(event.args);
		if (args) data.args = args;
		if (event.intent) data.intent = event.intent;
		this.sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
	}

	#recordSessionExit(reason: postmortem.Reason | "dispose"): void {
		if (!this.#sessionWritesEnabled) return;
		if (this.#exitRecorded) return;
		this.#exitRecorded = true;
		const pendingToolCalls = collectPendingToolCalls(this.sessionManager.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!this.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			this.sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			this.sessionManager.flushSync();
			// Only pending tool calls or an abnormal teardown are noteworthy; a
			// clean dispose logs at debug so routine exits don't read as problems.
			const exitLog = pendingToolCalls.length > 0 || kind !== "normal" ? logger.warn : logger.debug;
			exitLog("Session exit recorded", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#registerExitRecorder(): void {
		if (this.#cancelExitRecorder) return;
		this.#cancelExitRecorder = postmortem.register(`agent-session:${this.sessionManager.getSessionId()}`, reason => {
			this.#recordSessionExit(reason);
		});
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);
		// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
		// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
		// emitting while #promptInFlightCount > 0 lets a client fire its next
		// `prompt` into a session that still reports isStreaming === true. Flush
		// happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
		// an auto-compaction turn that starts before the original prompt unwinds)
		// supersedes the pending one, which is what subscribers want — they only
		// care about the final settle.
		if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;
	/**
	 * agent-core 以 fire-and-forget 方式调用订阅者；即使 agent.waitForIdle() 已完成，
	 * message_end/agent_end 仍可能停在扩展 hook 或持久化 await 中。
	 */
	#inFlightEventHandlers = new Set<Promise<void>>();

	/** 同步登记事件处理 Promise，供 dispose 在释放 transcript 前排空。 */
	#handleAgentEvent = (event: AgentEvent): Promise<void> => {
		const processing = this.#dispatchAgentEvent(event);
		this.#inFlightEventHandlers.add(processing);
		void processing.finally(() => this.#inFlightEventHandlers.delete(processing)).catch(() => {});
		return processing;
	};

	async #drainInFlightEventHandlers(): Promise<void> {
		while (this.#inFlightEventHandlers.size > 0) {
			await Promise.allSettled([...this.#inFlightEventHandlers]);
		}
	}

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules deferred post-prompt recovery work
	 * (compaction/handoff, context-promotion continuations). It is invoked
	 * fire-and-forget by the agent's synchronous `#emit`, and only reaches
	 * `#checkCompaction` after several internal awaits. `prompt()` runs
	 * `#waitForPostPromptRecovery()` the instant `agent.prompt()` resolves — which
	 * can land BEFORE the handler registers its tasks, so the wait would observe an
	 * empty task set and return early, letting a deferred handoff/promotion race
	 * prompt completion. Tracking the `agent_end` handler as a post-prompt task
	 * that is registered SYNCHRONOUSLY (before the first await) closes that window:
	 * `#postPromptTasksPromise` is set the moment `#emit` invokes this handler, so
	 * the recovery wait always sees the in-flight handler and blocks until it — and
	 * everything it schedules — settles. */
	#dispatchAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type !== "agent_end") {
			return this.#processAgentEvent(event);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#trackPostPromptTask(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	#createMessageEndPersistenceSlot(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#messageEndPersistenceTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pendingMessageEndPersistence.get(key) === promise) {
				this.#pendingMessageEndPersistence.delete(key);
			}
		};
		this.#pendingMessageEndPersistence.set(key, promise);
		this.#messageEndPersistenceTail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	async #waitForSessionMessagePersistence(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pendingMessageEndPersistence.get(key);
	}

	async #waitForMessageEndPersistence(): Promise<void> {
		await this.#messageEndPersistenceTail;
	}

	#latestAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
	}

	/**
	 * Index every message entry on the current branch by persistence key, so
	 * the mid-run-compaction planner can ask "is this turn message already on
	 * the branch?" in O(1). The set is memoized through the current leaf path
	 * and validated at use time against a (session file, leaf id) anchor.
	 *
	 * The mid-run ordering check uses key identity alone: same-key content
	 * variants are one logical message at this boundary, because otherwise a
	 * display-side rewrite can make the assistant look missing after its tool
	 * results have already persisted.
	 *
	 * Coherency is anchor-based, not invalidation-based: every branch mutation
	 * (rewind, branch switch, new session, custom-entry append) changes the
	 * session manager's leaf id or session file, so `#ensurePersistedMessageKeys`
	 * detects staleness itself and rebuilds. No mutation call site has to
	 * remember to invalidate anything.
	 *
	 * Pre-#3629 the equivalent was `sessionManager.getBranch()` called twice
	 * per turn message, each call rebuilding the path via O(n²) `unshift` and
	 * structurally JSON-comparing every entry — seconds of synchronous work
	 * per `onTurnEnd` on a long session and the load-bearing source of the
	 * `ui.loop-blocked` warnings in the bug report.
	 */
	#indexPersistedMessageKeys(): Set<string> {
		return this.#ensurePersistedMessageKeys();
	}

	#persistedMessageKeysAnchor(): string {
		return `${this.sessionManager.getSessionFile() ?? ""}\u0000${this.sessionManager.getLeafId() ?? ""}`;
	}

	#ensurePersistedMessageKeys(): Set<string> {
		const anchor = this.#persistedMessageKeysAnchor();
		let cache = this.#persistedMessageKeys;
		if (cache === undefined || cache.anchor !== anchor) {
			cache = { anchor, keys: this.#buildPersistedMessageKeySet() };
			this.#persistedMessageKeys = cache;
		}
		return cache.keys;
	}

	#buildPersistedMessageKeySet(): Set<string> {
		const keys = new Set<string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const key = sessionMessagePersistenceKey(entry.message);
			if (key !== undefined) keys.add(key);
		}
		return keys;
	}

	/**
	 * True when {@link message} is structurally identical to a message already
	 * appended to the current branch. Uses the current branch's memoized
	 * persistence-key cache for the common missing-key case, and only walks the
	 * branch to verify content when a key hit could be a rare collision.
	 */
	#sessionMessageAlreadyPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		const keys = this.#ensurePersistedMessageKeys();
		if (!keys.has(key)) return false;
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			if (sessionMessagePersistenceKey(entry.message) !== key) continue;
			if (sameMessageContent(entry.message, message)) return true;
		}
		return false;
	}

	#appendSessionMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const cache = this.#persistedMessageKeys;
		const wasFresh = cache !== undefined && cache.anchor === this.#persistedMessageKeysAnchor();
		const entryId = this.sessionManager.appendMessage(message);
		const key = sessionMessagePersistenceKey(message);
		if (wasFresh && cache && key) {
			cache.keys.add(key);
			cache.anchor = this.#persistedMessageKeysAnchor();
		}
		return entryId;
	}

	#persistSessionMessageIfMissing(message: AgentMessage): void {
		if (!this.#sessionWritesEnabled) return;
		if (
			message.role !== "user" &&
			message.role !== "developer" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "fileMention"
		) {
			return;
		}
		if (this.#sessionMessageAlreadyPersisted(message)) return;
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			if (this.#isClassifierRefusal(assistantMsg)) return;
			if (isEmptyErrorTurn(assistantMsg)) return;
			if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
				assistantMsg.contextSnapshot = {
					promptTokens: calculatePromptTokens(assistantMsg.usage),
					nonMessageTokens: this.#pendingContextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this),
				};
			}
		}
		const isRewoundToolResult =
			message.role === "toolResult" &&
			semanticToolResult(message.toolName, message)?.toolName === "rewind" &&
			this.#rewoundToolResultIds.delete(message.toolCallId);
		if (!isRewoundToolResult) {
			this.#appendSessionMessage(message);
		}
	}

	/**
	 * On a user-interrupted (`Esc`) abort, copy the trailing thinking run into a
	 * hidden `display: false` continuity message for the next turn WITHOUT
	 * mutating the assistant message. The original thinking stays on the message
	 * so live render, reload, and Ctrl+L rebuilds keep showing it; `convertToLlm`
	 * strips the run from the provider request (incomplete/unsigned thinking is
	 * rejected on resend) when this continuity message follows the assistant turn.
	 */
	#demoteInterruptedThinkingOnUserInterrupt(
		message: AssistantMessage,
	): CustomMessage<InterruptedThinkingDetails> | undefined {
		if (message.stopReason !== "aborted" || !isUserInterruptAbort(message)) return undefined;
		const demoted = demoteInterruptedThinking(message);
		if (!demoted) return undefined;
		const interruptedAt = Date.now();
		return {
			role: "custom",
			customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
			content: prompt.render(interruptedThinkingTemplate, { reasoning: demoted.reasoning }),
			display: false,
			details: {
				interruptedAt,
				provider: message.provider,
				model: message.model,
				blockCount: demoted.blockCount,
			},
			attribution: "agent",
			timestamp: interruptedAt,
		};
	}

	async #persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const turnMessages = [context.message, ...context.toolResults];
		for (const message of turnMessages) {
			await this.#waitForSessionMessagePersistence(message);
		}
		// One branch snapshot + one persistence-key index drives the entire
		// planning pass. Pre-#3629 this re-walked the branch and structurally
		// JSON-compared every entry per turn message, which on long sessions
		// turned each `onTurnEnd` into a seconds-long sync block (the
		// `ui.loop-blocked` warnings tagged `subagent:*` in the bug report).
		const branchKeys = this.#indexPersistedMessageKeys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (let index = 0; index < turnMessages.length; index++) {
			const key = turnKeys[index];
			if (key === undefined) continue;
			// Mid-run ordering is keyed by logical identity. A persisted display
			// variant (for example, redacted/deobfuscated content) must still count;
			// otherwise the assistant can look missing while later tool results are
			// present, producing a false out-of-order skip.
			if (branchKeys.has(key)) {
				persistedKeys.add(key);
			}
		}
		const plan = planTurnPersistence(turnKeys, persistedKeys);
		if (plan.kind === "out-of-order") {
			const message = turnMessages[plan.messageIndex];
			logger.debug("Skipping mid-run compaction because turn persistence is out of order", {
				role: message.role,
				timestamp: message.timestamp,
			});
			return false;
		}
		for (const index of plan.toPersist) {
			this.#persistSessionMessageIfMissing(turnMessages[index]);
		}
		return true;
	}

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		// Step the mid-run todo counter synchronously, BEFORE any await in this
		// handler. The agent loop's next-turn `getAsideMessages` poll can run
		// before queued microtasks drain, so `#takeMidRunTodoNudge` MUST see the
		// freshest counter — otherwise a turn that just invoked `todo` could
		// trip a spurious nudge against stale state, and a turn that just hit
		// the threshold could fail to nudge until a later turn (issue #3651).
		// Pure in-memory math — no ordering requirement vs persistence or
		// session-event fan-out. Keyed on toolResult (not the assistant toolCall
		// turn) so planned-but-aborted or permission-denied calls never count,
		// and only successful mutating tools tick — read-only exploration is
		// not progress an agent could mark done.
		if (event.type === "message_end" && event.message.role === "toolResult") {
			const { toolName, isError } = event.message;
			if (toolName === "todo") {
				this.#mutationsSinceLastTodoTouch = 0;
			} else if (!isError && MID_RUN_TODO_NUDGE_MUTATING_TOOLS[toolName]) {
				this.#mutationsSinceLastTodoTouch++;
			}
		}
		// Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the
		// persisted message BEFORE the obfuscator's display-side copy below.
		// Invariant (must hold across refactors): this branch precedes the
		// `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
		// block. After stamping, both `displayEvent.message` (via the spread)
		// and `event.message` (in-place mutation, used by SessionManager
		// persistence) carry the marker, guaranteeing streaming render and
		// history replay branch identically. The one-shot flag is consumed
		// here, scoped strictly to this aborted message_end; callers still clear it
		// in `finally` so a leaked flag cannot silence a later unrelated abort.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
			const message = event.message as AssistantMessage;
			if (this.#planInternalAbortPending) {
				message.errorMessage = SILENT_ABORT_MARKER;
				message.errorId = AIError.create(AIError.Flag.SilentAbort);
				this.#planInternalAbortPending = false;
			} else if (this.#pendingAbortErrorId) {
				message.errorId = this.#pendingAbortErrorId;
				this.#pendingAbortErrorId = undefined;
			}
		}

		const interruptedThinkingMessage =
			event.type === "message_end" && event.message.role === "assistant"
				? this.#demoteInterruptedThinkingOnUserInterrupt(event.message as AssistantMessage)
				: undefined;
		// `message_end` handling is fire-and-forget from agent-core. Make the
		// hidden continuity turn visible to the next prompt before any awaited
		// extension delivery or persistence can stall this handler.
		if (interruptedThinkingMessage) {
			this.agent.appendMessage(interruptedThinkingMessage);
		}

		const messageEndPersistence =
			event.type === "message_end" && this.#sessionWritesEnabled
				? this.#createMessageEndPersistenceSlot(event.message)
				: undefined;

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = deobfuscateAssistantContent(obfuscator, message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}
		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		if (event.type === "tool_execution_start") {
			this.#recordToolExecutionStart(event);
		}

		try {
			await this.#emitSessionEvent(displayEvent);
		} catch (error) {
			messageEndPersistence?.release();
			throw error;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const visibleMessage =
				displayEvent.type === "message_end" && displayEvent.message.role === "assistant"
					? displayEvent.message
					: event.message;
			this.#responseDocuments.rememberVisibleAssistant(event.message, visibleMessage);
		}

		if (event.type === "turn_start") {
			this.#resetStreamingEditState();
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
			if (event.toolName === "goal") {
				await this.#goalRuntime.onGoalToolCompleted();
			} else {
				await this.#goalRuntime.onToolCompleted(event.toolName);
			}
			this.#planModeReminderAwaitingProgress = false;
			if (
				event.toolName === "ask" ||
				writeDeviceDispatch(event.toolName, event.result)?.tool === PROPOSE_DEVICE_NAME
			) {
				this.#planModeReminderCount = 0;
				this.#planModeReminderAwaitingProgress = false;
			}
		}
		if (event.type === "tool_execution_end" && this.#isTerminalYieldToolResult(event)) {
			const alreadyTerminated = this.#synchronouslyTerminatedYieldToolCallIds.delete(event.toolCallId);
			if (!alreadyTerminated) {
				this.#markTerminalYieldToolCall(event.toolCallId);
				this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			}
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;
			let streamingToolCall: ToolCall | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
				matchContext = this.#getTtsrToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
				const matches = this.#checkTtsrStream(assistantEvent.delta, matchContext, streamingToolCall);
				if (matches.length > 0 && this.#handleTtsrMatches(matches, matchContext, targetMessageTimestamp)) {
					return;
				}
				// ast-grep `astCondition` rules match against the reconstructed edit/write
				// snapshot, which only exists for tool argument streams. The native worker
				// call is async, so this path is awaited and self-throttled by the manager.
				if (matchContext.source === "tool" && this.#ttsrManager?.hasAstRules()) {
					const astMatches = await this.#checkTtsrAstStream(matchContext, streamingToolCall);
					if (astMatches.length > 0 && this.#handleTtsrMatches(astMatches, matchContext, targetMessageTimestamp)) {
						return;
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#maybeAbortStreamingEdit(event);
		}

		if (event.type === "message_end" && isUserQueuedMessage(event.message)) {
			this.#resetToolLoopGuardsForUserInput();
		}

		// Handle session persistence
		if (event.type === "message_end" && this.#sessionWritesEnabled) {
			const persistMessageEnd = () => {
				// Check if this is a hook/custom message
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					if (!isPrewalkPlanNudge(event.message)) {
						this.sessionManager.appendCustomMessageEntry(
							event.message.customType,
							event.message.content,
							event.message.display,
							event.message.details,
							event.message.attribution ?? "agent",
						);
					}
					if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
						this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details));
					}
				} else {
					this.#persistSessionMessageIfMissing(event.message);
				}
			};
			if (messageEndPersistence) {
				await messageEndPersistence.persist(persistMessageEnd);
			} else {
				persistMessageEnd();
			}
			if (interruptedThinkingMessage) {
				this.sessionManager.appendCustomMessageEntry(
					interruptedThinkingMessage.customType,
					interruptedThinkingMessage.content,
					interruptedThinkingMessage.display,
					interruptedThinkingMessage.details,
					interruptedThinkingMessage.attribution,
				);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				this.#recordContextProbe(assistantMsg, "agent");
				// Fold this turn's timing into per-model perf aggregates (drives the
				// /models TPS/TTFT display). Errored turns measure nothing; aborted
				// turns with reported usage are still valid throughput samples.
				if (assistantMsg.stopReason !== "error" && assistantMsg.duration !== undefined) {
					this.settings.getStorage()?.recordModelPerf(`${assistantMsg.provider}/${assistantMsg.model}`, {
						outputTokens: assistantMsg.usage.output,
						durationMs: assistantMsg.duration,
						ttftMs: assistantMsg.ttft,
					});
				}
				if (
					assistantMsg.disabledFeatures?.includes("priority") &&
					this.#serviceTierByFamily.anthropic === "priority"
				) {
					this.setServiceTierFamily("anthropic", undefined);
					this.emitNotice(
						"warning",
						"Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
						"priority",
					);
				}
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
				if (!this.#ttsrAbortPending) {
					this.#resolveTtsrResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				const assistantSucceeded =
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					!this.#isEmptyAssistantStop(assistantMsg);
				if (assistantSucceeded && this.#modelRouteLease.matchesModel(this.model)) {
					this.#modelRouteLease.markSuccess();
				}
				if (assistantSucceeded && this.#retryAttempt > 0) {
					if (this.#activeRetryFallback && this.model) {
						await this.#emitSessionEvent({
							type: "retry_fallback_succeeded",
							model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
							role: this.#activeRetryFallback.role,
						});
					}
					const recoveredErrors = await this.#markPendingRecoveredRetryErrors(assistantMsg);
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: this.#retryAttempt,
						recoveredErrors,
					});
					this.#clearPendingRecoveredRetryErrors();
					this.#retryAttempt = 0;
				}
				if (assistantMsg.provider === "opencode-go") {
					this.#modelRegistry.authStorage.recordUsageCost(assistantMsg.provider, assistantMsg.usage.cost.total, {
						sessionId: this.#activeProviderSessionId(),
						recordedAt: assistantMsg.timestamp,
						baseUrl: this.#modelRegistry.getProviderBaseUrl?.(assistantMsg.provider),
					});
				}
			}
			if (event.message.role === "toolResult") {
				const { toolName, toolCallId, isError, content } = event.message;
				const details = isRecord(event.message.details) ? event.message.details : undefined;
				const semanticResult = semanticToolResult(toolName, event.message);
				const semanticDetails = isRecord(semanticResult?.details) ? semanticResult.details : undefined;
				// A tool actually ran. Clear the post-reminder suppression: the agent did
				// productive work in response to the prior nudge, so the next text-only stop
				// is allowed to escalate to the next reminder if todos remain incomplete.
				this.#todoReminderAwaitingProgress = false;
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				const editedPath = details ? getStringProperty(details, "path") : undefined;
				if (toolName === "edit" && editedPath) {
					this.#invalidateFileCacheForPath(editedPath);
				}
				const phases = details?.phases;
				if (toolName === "todo" && !isError && details && Array.isArray(phases) && phases.every(isTodoPhase)) {
					this.setTodoPhases(phases);
					if (this.#isTodoInitResult(details, toolCallId)) {
						this.#scheduleReplanTitleRefresh();
					}
				}
				if (toolName === "todo" && isError) {
					const errorText = content.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
						"Fix the todo payload and call todo again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (semanticResult?.toolName === "checkpoint" && !isError) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt:
							(semanticDetails && stringProperty(semanticDetails, "startedAt")) ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
					this.#lastCompletedRewind = undefined;
				}
				if (semanticResult?.toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = semanticDetails ? (stringProperty(semanticDetails, "report")?.trim() ?? "") : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			await this.#waitForMessageEndPersistence();
			// dispose 的 bounded drain 可能在扩展 hook 完成前释放 agent.state；
			// 固化本次 settle 的数组，保证 agent_end/session_stop 仍能看到完整 transcript。
			const settledMessages = [...this.agent.state.messages];
			const eventAssistant = this.#latestAssistantMessage(event.messages);
			// TTSR retry work runs concurrently and clears the live flag before
			// maintenance can emit agent_end, so preserve the state at settle entry.
			const ttsrAbortPendingAtAgentEnd = this.#ttsrAbortPending;
			const emitAgentEndNotification = async (options?: { willContinue?: boolean }) => {
				await this.#emitAgentEndNotification(settledMessages, options);
			};
			const usage = this.getSessionStats().tokens;
			await this.#goalRuntime.onAgentEnd({
				currentUsage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
			});
			const fallbackAssistant = this.#latestAssistantMessage(settledMessages);
			const msg = eventAssistant ?? fallbackAssistant ?? this.#lastAssistantMessage;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				logger.debug("agent_end maintenance routing", {
					reason: "no-assistant-message",
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
				});
				await emitAgentEndNotification();
				return;
			}

			const successfulYieldMessage = this.#findSuccessfulYieldAssistantMessage(settledMessages);
			const yieldOnThisMessage = this.#assistantEndedWithSuccessfulYield(msg);

			const maintenanceRoute = (route: string, extra?: Record<string, unknown>) => {
				logger.debug("agent_end maintenance routing", {
					route,
					stopReason: msg.stopReason,
					provider: msg.provider,
					model: msg.model,
					contentBlocks: msg.content.length,
					hasToolCalls: msg.content.some(content => content.type === "toolCall"),
					hasText: msg.content.some(content => content.type === "text"),
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
					successfulYield: successfulYieldMessage !== undefined,
					...extra,
				});
			};
			maintenanceRoute("entered");

			// Copilot 的硬认证失败会使旧凭证失效；账号额度和并发上限只需轮换或短暂退避，
			// 不能删除仍然有效的凭证。
			if (msg.stopReason === "error" && msg.provider === "github-copilot") {
				const errorId = AIError.classifyMessage(msg);
				const concurrencyCap = parseRateLimitReason(msg.errorMessage ?? "") === "CONCURRENT_LIMIT";
				if (
					AIError.is(errorId, AIError.Flag.AuthFailed) &&
					!AIError.is(errorId, AIError.Flag.UsageLimit) &&
					!concurrencyCap
				) {
					await this.#modelRegistry.authStorage.remove("github-copilot");
				}
			}

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				maintenanceRoute("skip-post-turn-maintenance");
				await emitAgentEndNotification();
				return;
			}

			const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
			// A successful `yield` in this run is terminal for execution purposes.
			// Suppress empty-stop retry, unexpected-stop retry, queued-message drain,
			// and compaction-driven continuations for the rest of this prompt cycle:
			// the executor consumed the yield as the terminal result, so a trailing
			// empty/aborted assistant stop must NOT revive the agent loop. The
			// `#yieldTerminationPending` sticky flag clears on the next `prompt()`.
			if (successfulYieldMessage || this.#yieldTerminationPending) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				if (successfulYieldMessage && activeGoal) {
					maintenanceRoute(
						yieldOnThisMessage
							? "successful-yield-active-goal-checkCompaction"
							: "post-yield-trailing-stop-active-goal-checkCompaction",
					);
					const compactionTask = this.#checkCompaction(successfulYieldMessage);
					this.#trackPostPromptTask(compactionTask);
					await compactionTask;
				} else if (successfulYieldMessage) {
					maintenanceRoute("successful-yield-no-active-goal");
				} else {
					maintenanceRoute("post-yield-trailing-stop-suppressed");
				}
				await emitAgentEndNotification();
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			// Empty-stop cleanup MUST run before any compaction continuation: an
			// empty toolUse stop must be stripped from active context + session
			// history before we schedule another turn, otherwise the next
			// Anthropic turn carries a tool_use block with no matching
			// tool_result and corrupts message history. The handler also
			// schedules its own retry, so a real empty stop never needs the
			// active-goal threshold pre-empt below.
			if (await this.#handleEmptyAssistantStop(msg)) {
				maintenanceRoute("empty-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}

			let compactionResult = COMPACTION_CHECK_NONE;
			let checkedCompaction = false;
			if (activeGoal) {
				maintenanceRoute("active-goal-pre-empt-checkCompaction");
				const compactionTask = this.#checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
				checkedCompaction = true;
				if (
					compactionResult.deferredHandoff ||
					compactionResult.continuationScheduled ||
					compactionResult.automaticContinuationBlocked
				) {
					maintenanceRoute("active-goal-pre-empt-compaction-handled", {
						deferredHandoff: compactionResult.deferredHandoff,
						continuationScheduled: compactionResult.continuationScheduled,
						automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
					});
					this.#resolveRetry();
					await emitAgentEndNotification(
						compactionResult.continuationScheduled ? { willContinue: true } : undefined,
					);
					return;
				}
			}

			if (await this.#handleUnexpectedAssistantStop(msg)) {
				maintenanceRoute("unexpected-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}

			if (this.#isRetryableReasonlessAbort(msg)) {
				const didRetry = await this.#handleRetryableError(msg, { allowModelFallback: false });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}

			// A deliberate abort should settle the current turn, not trigger queued
			// continuations — except TTSR self-repair, which already scheduled a
			// hidden retry while #ttsrAbortPending is still true.
			if (msg.stopReason === "aborted") {
				this.#resolveRetry();
				// Capture the original logical-turn boundary before
				// #resetSessionStopContinuationState clears it. If this abort
				// fires during a session_stop continuation, the original
				// boundary must still be used so the digest spans from the
				// original user prompt (not just the continuation cycle).
				const persistedOriginalBoundary = this.#contextSteadyOriginalPreTurnLeafCaptured
					? this.#contextSteadyOriginalPreTurnLeafId
					: this.#contextSteadyPreTurnLeafId;
				this.#resetSessionStopContinuationState();
				const settledLeafId = this.sessionManager.getLeafId();
				await emitAgentEndNotification(ttsrAbortPendingAtAgentEnd ? { willContinue: true } : undefined);
				if (!ttsrAbortPendingAtAgentEnd) {
					this.#trackPostPromptTask(
						this.#generateTurnDigest(settledLeafId, {
							allowAbortInProgress: true,
							boundaryOverride: persistedOriginalBoundary,
						}),
					);
				}
				return;
			}
			// Fireworks Fast variants degrade to their base model on a failed turn —
			// including hard router errors the generic retry classifier rejects — so
			// run this gate before the standard retryability check.
			if (this.#isFireworksFastFallbackEligible(msg)) {
				const didRetry = await this.#handleRetryableError(msg, { fireworksFastFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			if (this.#isRetryableError(msg)) {
				const didRetry = await this.#handleRetryableError(msg);
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			} else if (this.#isHardErrorModelRouteFallbackEligible(msg)) {
				// Logical routes own provider/model-unavailable hard errors before
				// cross-model fallback. A successful route switch retries immediately;
				// otherwise the original non-retryable error remains terminal.
				const didRetry = await this.#handleRetryableError(msg, { hardErrorRouteFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			} else if (this.#isHardErrorFallbackEligible(msg)) {
				// A non-retryable hard error on a model covered by a configured
				// fallback chain: retrying the SAME model is pointless, but a
				// DIFFERENT model is a fresh chance — consult the chain before
				// surfacing the failure. #handleRetryableError bails out (no
				// backoff-retry of the failing model) when no switch happens.
				const didRetry = await this.#handleRetryableError(msg, { hardErrorFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			// Classifier refusals are persisted-skipped above; also prune the trailing
			// stub from active context so the next turn's prompt does not replay it.
			// Fall through to the standard error tail so `session_stop` hooks (block,
			// continue, telemetry) still fire — matching the pre-fix flow for
			// `stopReason === "error"`.
			if (this.#isClassifierRefusal(msg)) {
				this.#removeAssistantMessageFromActiveContext(msg);
			}
			this.#resolveRetry();

			if (!checkedCompaction) {
				maintenanceRoute("bottom-checkCompaction");
				const compactionTask = this.#checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
			}
			// Stop-time todo reconciliation only fires at a text-only final stop. A run
			// that ends still mid-tool-use (deadline hit, context full, etc.) skips the
			// reminder so we don't pile a follow-up onto an already in-flight turn.
			// Mid-run sync is handled separately via #takeMidRunTodoNudge so a long
			// tool-use loop still gets prodded to keep the live HUD honest (issue #3651).
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				maintenanceRoute("tool-call-turn-skip-final-maintenance");
				await emitAgentEndNotification();
				return;
			}
			// When compaction queued recovery or hit a deliberate dead-end, skip the
			// rewind/todo/session_stop passes: any reminder or hook continuation we append
			// here would race the handoff, retry, auto-continue prompt, queued-message
			// drain, or the explicit pause that is preventing a compaction loop.
			if (
				compactionResult.deferredHandoff ||
				compactionResult.continuationScheduled ||
				compactionResult.automaticContinuationBlocked
			) {
				maintenanceRoute("compaction-handled-before-session-stop", {
					deferredHandoff: compactionResult.deferredHandoff,
					continuationScheduled: compactionResult.continuationScheduled,
					automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
				});
				await emitAgentEndNotification(compactionResult.continuationScheduled ? { willContinue: true } : undefined);
				return;
			}
			if (msg.stopReason !== "error") {
				if (this.#enforceRewindBeforeYield()) {
					maintenanceRoute("rewind-reminder-scheduled");
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
				const planModeContinuationScheduled = await this.#enforcePlanModeDecisionAtSettle();
				if (planModeContinuationScheduled) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
				const todoContinuationScheduled = await this.#checkTodoCompletion(msg);
				if (todoContinuationScheduled) {
					maintenanceRoute("todo-reminder-scheduled");
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			// A pending async wake means this settle is a scheduling pause, not
			// the terminal stop. Defer session_stop until the session is fully idle.
			if (this.#hasPendingAsyncWake()) {
				await emitAgentEndNotification({ willContinue: true });
				return;
			}
			const sessionStopResult = await this.#emitSessionStopEvent(settledMessages, msg);
			// Capture the leaf immediately after session_stop settles and before
			// agent_end hooks can append entries, keeping the digest endpoint stable.
			const settledLeafId = this.sessionManager.getLeafId();
			if (sessionStopResult.chainEnded && this.#sessionWritesEnabled) {
				const responseDocument = await this.#responseDocuments.externalizeAssistant(msg);
				if (responseDocument) {
					this.emitNotice(
						"info",
						`Response saved as artifact://${responseDocument.artifactId}; later model turns receive a bounded synopsis.`,
						"response-document",
					);
				}
			}
			await emitAgentEndNotification(sessionStopResult.continuationScheduled ? { willContinue: true } : undefined);
			if (sessionStopResult.continuationScheduled) {
				// Continuation is queued and will run as a hidden next turn.
				// Do NOT generate a digest yet — the continuation's own settled
				// path will produce the consolidated digest spanning the full
				// logical turn.
			} else if (sessionStopResult.chainEnded) {
				// Continuation chain ended (or was never started). Generate the
				// consolidated digest. It uses #contextSteadyOriginalPreTurnLeafId
				// if a continuation chain was active, or #contextSteadyPreTurnLeafId
				// for a normal turn — covering the full logical turn in either case.
				this.#trackPostPromptTask(this.#generateTurnDigest(settledLeafId));
			}
			// When invalidated: no digest, no cleanup needed — the next prompt
			// cycle will start fresh.
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/**
	 * Generate and persist a TurnDigest for the just-settled turn.
	 * Fire-and-forget — failures are logged but never propagate.
	 *
	 * The source span always uses #contextSteadyOriginalPreTurnLeafId when
	 * available (covering the full logical turn including any session_stop
	 * continuations), falling back to #contextSteadyPreTurnLeafId for a
	 * normal turn boundary.
	 *
	 * After generation (or when skipped/failed), continuation boundary state
	 * is cleaned up so the next logical turn starts with a clean slate.
	 */
	#generateTurnDigest(
		settledLeafId?: string | null,
		options?: { allowAbortInProgress?: boolean; boundaryOverride?: string | null },
	): Promise<void> {
		const settings = this.settings;
		const hasBoundaryOverride = options && "boundaryOverride" in options;
		const originalBoundary = hasBoundaryOverride
			? (options.boundaryOverride ?? null)
			: this.#contextSteadyOriginalPreTurnLeafCaptured
				? this.#contextSteadyOriginalPreTurnLeafId
				: this.#contextSteadyPreTurnLeafId;

		const scheduleCleanup = () => {
			this.#contextSteadyOriginalPreTurnLeafId = null;
			this.#contextSteadyOriginalPreTurnLeafCaptured = false;
		};

		return (async () => {
			try {
				const contextSteadyEnabled = this.#contextSteadyIsActive();
				const digestEnabled = settings.get("san.contextSteady.digest.enabled") as boolean;
				const persistFallback = settings.get("san.contextSteady.digest.persistFallback") as boolean;
				const brainPolicy = resolveSanBrainRuntimePolicy(settings);
				const brainCaptureEnabled = brainPolicy.captureEnabled;
				if (!contextSteadyEnabled && !brainCaptureEnabled) return;
				if (!digestEnabled && !brainCaptureEnabled) return;

				if ((this.#abortInProgress && options?.allowAbortInProgress !== true) || this.#isDisposed) return;

				const sessionManager = this.sessionManager;
				const preTurnLeafId = originalBoundary;
				const currentLeafId = settledLeafId ?? sessionManager.getLeafId();
				const branch = sessionManager.getBranch();
				if (preTurnLeafId && !branch.some(entry => entry.id === preTurnLeafId)) {
					logger.debug("preTurnLeafId not found in branch while generating TurnDigest", {
						sessionId: this.sessionId,
						preTurnLeafId,
						currentLeafId,
						branchLength: branch.length,
					});
				}
				const span = computeTurnSourceSpan(branch, preTurnLeafId, currentLeafId);
				if (!span) {
					logger.debug("Skipping TurnDigest because source span is empty", {
						sessionId: this.sessionId,
						preTurnLeafId,
						currentLeafId,
						branchLength: branch.length,
					});
					return;
				}
				const toEntryId = span.toEntryId;
				const fromEntryId = skipContextPacketPreludeInDigestSource(branch, span.fromEntryId, toEntryId);
				const segmentEnabled = settings.get("san.contextSteady.segment.enabled") as boolean;
				const segmentInput = segmentEnabled
					? buildContextSegmentDigestInput(
							branch,
							fromEntryId,
							toEntryId,
							Math.max(1, Math.floor(settings.get("san.contextSteady.segment.maxDigestInputTokens") as number)),
						)
					: undefined;
				const spanMessages = segmentInput?.messages ?? extractSpanMessages(branch, fromEntryId, toEntryId);
				if (spanMessages.length === 0) {
					logger.debug("Skipping TurnDigest because source span has no digestible messages", {
						sessionId: this.sessionId,
						preTurnLeafId,
						currentLeafId,
						fromEntryId,
						toEntryId,
						branchLength: branch.length,
					});
					return;
				}
				if (segmentInput && (segmentInput.segmentEntryId || segmentInput.trimmedMessages > 0)) {
					logger.debug("Using bounded Segment frontier for TurnDigest", {
						sessionId: this.sessionId,
						fromEntryId,
						toEntryId,
						segmentEntryId: segmentInput.segmentEntryId,
						estimatedTokens: segmentInput.estimatedTokens,
						trimmedMessages: segmentInput.trimmedMessages,
					});
				}

				const source = {
					sessionId: this.sessionId,
					fromEntryId,
					toEntryId,
					promptGeneration: this.#promptGeneration,
				};
				const digestTimeoutMs = (settings.get("san.contextSteady.digest.timeoutMs") as number) ?? 30000;
				const steadySettings = {
					enabled: contextSteadyEnabled,
					digest: {
						enabled: digestEnabled,
						persistFallback,
						timeoutMs: digestTimeoutMs,
						llm: {
							enabled: settings.get("san.contextSteady.digest.llm.enabled") as boolean,
							modelRole: settings.get("san.contextSteady.digest.llm.modelRole") as string,
						},
					},
				};
				const digestModelRole = steadySettings.digest.llm.modelRole || "@smol";
				const resolvedDigestModel = steadySettings.digest.llm.enabled
					? resolveModelOverride([digestModelRole], this.#modelRegistry, settings).model
					: undefined;
				const digestModel = resolvedDigestModel
					? {
							model: resolvedDigestModel,
							apiKey: this.#modelRegistry.resolver(resolvedDigestModel, this.sessionId),
							metadata: this.agent.metadataForProvider(resolvedDigestModel.provider),
							obfuscator: this.#obfuscator,
							prepareStreamOptions: (options: SimpleStreamOptions, provider: string) =>
								this.prepareSimpleStreamOptions(options, provider),
							onResponse: (response: AssistantMessage) =>
								this.#recordContextProbe(response, "turn_digest", resolvedDigestModel.contextWindow),
						}
					: undefined;

				const digestResult =
					contextSteadyEnabled && digestEnabled
						? await generateContextSteadyDigest(
								spanMessages,
								source,
								sessionManager,
								settings,
								steadySettings,
								digestModel,
							)
						: undefined;

				if (brainCaptureEnabled) {
					const scopes = await this.#resolveSanBrainCaptureScopes();
					const digest =
						digestResult?.digest ??
						generateFallbackDigest(
							spanMessages as Parameters<typeof generateFallbackDigest>[0],
							source,
							`brain_fallback_${Bun.hash(`${source.sessionId}\0${fromEntryId}\0${toEntryId}`).toString(36)}`,
							this.sessionId,
						);
					try {
						const capture = captureSanBrainTurn(sessionManager, {
							digest,
							...(digestResult?.entryId ? { digestEntryId: digestResult.entryId } : {}),
							sourceMode: digestResult
								? digestResult.persisted
									? "turn_digest"
									: "turn_digest_unpersisted"
								: "message_span_fallback",
							maxCandidates: settings.get("san.brain.capture.maxCandidatesPerTurn") as number,
							minConfidence: settings.get("san.brain.capture.minConfidence") as number,
							userScope: scopes.userScope,
							fallbackScope: scopes.fallbackScope,
						});
						if (brainPolicy.autoDecisionEnabled) {
							const store = SanBrainStore.open(settings.getAgentDir());
							try {
								const autoDecision = runSanBrainAutoDecisions({
									store,
									sessionManager,
									candidateIds: capture.candidateIds,
									explicitMinConfidence: settings.get("san.brain.autoDecision.explicitMinConfidence"),
									inferredMinConfidence: settings.get("san.brain.autoDecision.inferredMinConfidence"),
									minIndependentEvidence: settings.get("san.brain.autoDecision.minIndependentEvidence"),
									maxPerTurn: settings.get("san.brain.autoDecision.maxPerTurn"),
									createdAt: digest.createdAt,
								});
								logger.debug("San Brain automatic decisions persisted", {
									sessionId: this.sessionId,
									turnId: digest.turnId,
									evaluated: autoDecision.evaluated,
									automaticallyHandled: autoDecision.automaticallyHandled,
									escalated: autoDecision.escalated,
									failures: autoDecision.failures.length,
								});
							} finally {
								store.close();
							}
						}
						logger.debug("San Brain capture persisted", {
							sessionId: this.sessionId,
							turnId: digest.turnId,
							profileCandidates: capture.profileCandidates,
							experienceCandidates: capture.experienceCandidates,
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("Failed to capture San Brain candidates", {
							error: message,
							sessionId: this.sessionId,
						});
						try {
							recordSanBrainCaptureError(sessionManager, {
								sessionId: this.sessionId,
								turnId: digest.turnId,
								message,
							});
						} catch (recordError) {
							logger.warn("Failed to persist San Brain capture error", {
								error: recordError instanceof Error ? recordError.message : String(recordError),
								sessionId: this.sessionId,
							});
						}
					}
				}

				if (digestResult?.persisted && !digestResult.reused) this.#maybeAppendContextSteadyCheckpoint();
			} catch (error) {
				logger.warn("Failed to generate TurnDigest", {
					error: error instanceof Error ? error.message : String(error),
					sessionId: this.sessionId,
				});
			} finally {
				scheduleCleanup();
			}
		})();
	}

	#maybeAppendContextSteadyCheckpoint(options?: { rebaseReason?: ContextCheckpointRebaseReason }): void {
		if (!this.#contextSteadyIsActive()) return;
		if (this.settings.get("san.contextSteady.checkpoint.enabled") !== true) return;

		const rebaseReason =
			options?.rebaseReason ??
			(this.#contextSteadyPendingBudgetPressureRebase
				? "budget_pressure"
				: this.#contextSteadyPendingResumeRebase
					? "resume"
					: "checkpoint");
		// Branch-only: never fold digests/checkpoints from discarded sibling branches.
		const built = buildContextCheckpoint(this.sessionManager.getBranch(), this.sessionId, {
			enabled: true,
			checkpointEveryTurns: this.settings.get("san.contextSteady.checkpoint.everyTurns") as number,
			checkpointMaxTokens: this.settings.get("san.contextSteady.checkpoint.maxTokens") as number,
			epochId: this.#contextSteadyEpochId(rebaseReason),
			rebaseReason,
		});
		if (!built) return;
		appendContextCheckpoint(this.sessionManager, built.checkpoint);
		if (rebaseReason === "budget_pressure") this.#contextSteadyPendingBudgetPressureRebase = false;
		if (rebaseReason === "resume") this.#contextSteadyPendingResumeRebase = false;
	}

	#dropSanLoopRoleContextMessagesFromActiveContext(): void {
		const messages = this.agent.state.messages;
		if (
			!messages.some(
				message => message.role === "custom" && message.customType === SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
			)
		) {
			return;
		}
		this.agent.replaceMessages(
			messages.filter(
				message => !(message.role === "custom" && message.customType === SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE),
			),
		);
	}

	#dropSanBrainStateMessagesFromActiveContext(): void {
		const messages = this.agent.state.messages;
		if (!messages.some(message => message.role === "custom" && message.customType === BRAIN_STATE_MESSAGE_TYPE)) {
			return;
		}
		this.agent.replaceMessages(
			messages.filter(message => !(message.role === "custom" && message.customType === BRAIN_STATE_MESSAGE_TYPE)),
		);
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
	#resolveTtsrResume(): void {
		if (!this.#ttsrResumeResolve) return;
		this.#ttsrResumeResolve();
		this.#ttsrResumeResolve = undefined;
		this.#ttsrResumePromise = undefined;
	}

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<unknown>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: (reason: PostPromptSkipReason) => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.("aborted");
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.("stale-generation");
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
		logger.debug("agent.continue skipped after scheduling", { reason });
		options?.onSkip?.(reason);
	}

	#scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void {
		this.#schedulePostPromptTask(
			async signal => {
				// Defense in depth: if compaction/handoff slipped onto the post-prompt queue
				// alongside us (e.g. via a scheduler we don't own), refuse to start a fresh
				// streaming turn — agent.continue() here would race the handoff's session
				// reset. The first-class fix is in #checkCompaction/the agent_end handler,
				// but this guard catches anything that bypasses that path.
				if (signal.aborted || this.#isDisposed || this.isCompacting || this.isGeneratingHandoff) {
					this.#skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					this.#skipAgentContinue("should-continue-false", options);
					return;
				}
				this.#beginInFlight();
				try {
					const reverted = await this.#maybeRestoreRetryFallbackPrimary();
					if (signal.aborted || this.#isDisposed) {
						this.#skipAgentContinue("post-restore-unavailable", options);
						return;
					}
					if (reverted) {
						await this.#runPrePromptCompactionIfNeeded([]);
						if (signal.aborted || this.#isDisposed) {
							this.#skipAgentContinue("post-restore-unavailable", options);
							return;
						}
					}
					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.();
				} finally {
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => this.#skipAgentContinue(reason, options),
			},
		);
	}

	#scheduleCompactionContinuation(options: {
		generation: number;
		autoContinue: boolean;
		terminalTextAnswer: boolean;
		suppressContinuation: boolean;
	}): boolean {
		if (options.suppressContinuation) return false;
		if (this.agent.hasQueuedMessages()) {
			this.#scheduleAgentContinue({
				delayMs: 100,
				generation: options.generation,
				shouldContinue: () => this.agent.hasQueuedMessages(),
			});
			return true;
		}
		if (!options.autoContinue) return false;
		const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
		if (options.terminalTextAnswer && !activeGoal) return false;
		return this.#scheduleAutoContinuePrompt(options.generation);
	}

	#scheduleAutoContinuePrompt(generation: number): boolean {
		if (this.#continuationAuthoritySourceMissing()) {
			logger.warn("Automatic continuation blocked because the active user authority source is missing", {
				sessionId: this.sessionId,
				generation,
			});
			return false;
		}
		const continuePrompt = async () => {
			// Compaction summarizes away the first-message eager preludes, so re-assert the
			// delegate-via-tasks / phased-todo reminders on this auto-resumed turn. This runs
			// at invocation (past the abort check below), so an aborted continuation queues
			// nothing; scoped to this request via prependMessages, never the shared queue.
			const eagerNudges = this.#buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				if (this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					return;
				}
				await continuePrompt();
			},
			{ generation },
		);
		return true;
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#resolveTtsrResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			// An abort bumps #promptGeneration. When this wait runs on behalf of a
			// specific prompt turn, stop as soon as that turn has been superseded:
			// its promise must resolve on the abort, not block on a queued
			// steer/follow-up that the post-abort drain starts as a fresh turn.
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			if (this.#retryPromise) {
				await this.#retryPromise;
				continue;
			}
			if (this.#ttsrResumePromise) {
				await this.#ttsrResumePromise;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#formatTtsrAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		const ruleNames = rules.map(rule => rule.name).join(", ");
		return `TTSR matched ${label}: ${ruleNames}`;
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingTtsrInjections.length === 0) return undefined;
		const rules = this.#pendingTtsrInjections;
		const content = rules
			.map(r =>
				prompt.render(ttsrInterruptTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
				}),
			)
			.join("\n\n");
		this.#pendingTtsrInjections = [];
		return { content, rules };
	}

	/**
	 * Render a rule's file path for model-facing TTSR injections without leaking
	 * the absolute home directory: cwd-relative when the rule lives in the
	 * project, `~`-relative when it lives under home, else the raw path.
	 */
	#displayRulePath(rulePath: string): string {
		const cwdRel =
			relativePathWithinRoot(this.sessionManager.getCwd(), rulePath) ??
			this.#displayPathWithinRoot(this.sessionManager.getCwd(), rulePath);
		if (cwdRel) return cwdRel;
		const homeRel = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRel) return `~/${homeRel}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingTtsrInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingTtsrInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingTtsrInjections.push(rule);
			seen.add(rule.name);
		}
	}

	/** Tool-call id whose argument deltas triggered a TTSR match, when known. */
	#extractTtsrToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolTtsrInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolTtsrInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		// Dedupe against rules already bucketed for other tool calls in this
		// same assistant message so one rule attaches to exactly one tool call.
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolTtsrInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolTtsrInjections.set(toolCallId, bucket);
		// Claim the rules in the TTSR manager so subsequent deltas in this same
		// turn (e.g. a sibling tool call's argument stream) don't re-match them.
		// Persistence still happens in #ttsrAfterToolCall when the tool actually
		// produces a result we can fold the reminder into.
		if (newlyAdded.length > 0) {
			this.#ttsrManager?.markInjectedByNames(newlyAdded);
		}
	}

	#afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		if (
			this.#isTerminalYieldToolResult({
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.#markTerminalYieldToolCall(ctx.toolCall.id);
			this.#synchronouslyTerminatedYieldToolCallIds.add(ctx.toolCall.id);
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		this.#recordSkillGateCommandObservation(ctx);
		const ttsrResult = this.#ttsrAfterToolCall(ctx);
		const folded = this.#skillGateReminderFold(ctx, ttsrResult) ?? ttsrResult;
		return this.#hostWatchdogAfterToolCall(ctx, folded) ?? folded;
	}

	/**
	 * 根会话 watchdog 闭环:每个完成的工具调用规范化为 HostObservation 喂进
	 * execution runtime(经 scheduler.enforce 走 Watchdog 并落 ledger),可疑
	 * 决策(同一动作反复、无变化轮询、重复派发)fold 一次性 redirect 提醒进
	 * 工具结果 — 与 TTSR/skill-gate 同机制,不阻断执行。观察失败绝不影响
	 * 工具结果本身;terminal scope 拒绝迟到观察(不喂、不警告)。
	 */
	#hostWatchdogAfterToolCall(
		ctx: AfterToolCallContext,
		prior: AfterToolCallResult | undefined,
	): AfterToolCallResult | undefined {
		if (this.settings.get("san.sessionWatchdog.enabled") !== true) return undefined;
		const runtime = this.#executionRuntime;
		if (!runtime) return undefined;
		const scopeId = this.getActiveExecutionScopeId();
		if (scopeId === undefined) return undefined;
		const handle = runtime.getScope(scopeId);
		if (!handle || isTerminalExecutionState(handle.snapshot().state)) return undefined;
		const contractId = handle.snapshot().objectiveContract?.ref.contractId;
		const observation = toolCompletionObservation({
			toolName: ctx.toolCall.name,
			args: ctx.args,
			isError: ctx.isError,
			details: ctx.result.details,
			workKey: contractId ?? `scope:${scopeId}`,
		});
		if (!observation) return undefined;
		// 每次工具完成都是独立宿主事实:以 toolCall id 作 ledger 观察身份,
		// 否则同一动作重复时会撞 progress 记录的不可变约束。
		const identifiedObservation = { ...observation, observationId: `tool:${ctx.toolCall.id}` };
		let decision: WatchdogDecision;
		try {
			const result = runtime.recordHostObservation({ scopeId, observation: identifiedObservation });
			if (result.kind !== "observation") return undefined;
			decision = result.decision;
		} catch (error) {
			// 观察是尽力而为的宿主事实登记:scope 恰在本次调用间隙被 finish 属于
			// 正常竞争,绝不让它污染工具结果。其余错误照常上抛。
			if (error instanceof TerminalExecutionStateError || error instanceof StaleExecutionRevisionError) {
				return undefined;
			}
			throw error;
		}
		const suspicious =
			decision.suspicious || decision.action === "suppress_unchanged_poll" || decision.action === "reject_duplicate";
		if (!suspicious) return undefined;
		if (this.#watchdogRemindedStrategies.has(decision.strategyFingerprint)) return undefined;
		this.#watchdogRemindedStrategies.add(decision.strategyFingerprint);
		const reminder = prompt
			.render(watchdogRedirectTemplate, {
				alerts: [{ reason: decision.reason, repeatCount: decision.repeatCount }],
			})
			.trim();
		const baseContent = prior?.content ?? ctx.result.content;
		return { ...(prior ?? {}), content: [{ type: "text", text: reminder }, ...baseContent] };
	}

	/**
	 * 会话级 skill gate 的 command 回执薄适配:bash 完成即从 host 事实
	 * (exitCode + 命令文本)生成回执。超时/取消/缺失退出码的调用不算完成的
	 * 命令,不产回执。容器不存在(会话没有证据链 skill)时零行为。
	 */
	#recordSkillGateCommandObservation(ctx: AfterToolCallContext): void {
		const state = this.#skillGateState;
		if (!state?.hasActiveChains) return;
		if (ctx.toolCall.name !== "bash") return;
		const command = typeof ctx.args.command === "string" ? ctx.args.command : "";
		if (!command) return;
		const details = ctx.result.details as { exitCode?: unknown; timedOut?: unknown } | undefined;
		if (details?.timedOut === true) return;
		// bash 只在非零退出时写 details.exitCode;成功结果 exitCode 缺失即 0。
		// isError 且无退出码(取消、缺失退出状态)不是完成的命令观察。
		const exitCode = typeof details?.exitCode === "number" ? details.exitCode : ctx.isError ? undefined : 0;
		if (exitCode === undefined) return;
		state.recordCommandObservation({ command, exitCode });
	}

	/**
	 * before-fix 软拦截:文件修改类工具产出结果时,若存在尚无满足回执的
	 * before-fix 门,把一次性结构化提醒 fold 进工具结果(与 TTSR 同机制,
	 * 不阻断执行)。容器负责"同一 gate 只提醒一次"。
	 */
	#skillGateReminderFold(
		ctx: AfterToolCallContext,
		prior: AfterToolCallResult | undefined,
	): AfterToolCallResult | undefined {
		const state = this.#skillGateState;
		if (!state?.hasActiveChains) return undefined;
		if (!FILE_MUTATION_TOOL_NAMES.has(ctx.toolCall.name)) return undefined;
		const reminders = state.takeBeforeFixReminders();
		if (reminders.length === 0) return undefined;
		const reminder = prompt.render(skillEvidenceReminderTemplate, { reminders }).trim();
		const baseContent = prior?.content ?? ctx.result.content;
		return { ...(prior ?? {}), content: [{ type: "text", text: reminder }, ...baseContent] };
	}

	/** `afterToolCall` hook: fold any per-tool TTSR reminders into the result. */
	#ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolTtsrInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(r =>
				prompt.render(ttsrToolReminderTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
				}),
			)
			.join("\n\n");
		// The TTSR manager was already claimed at bucket time; only persistence remains.
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		if (ruleNames.length > 0) {
			this.sessionManager.appendTtsrInjection(ruleNames);
		}
		return {
			content: [{ type: "text", text: reminder }, ...ctx.result.content],
		};
	}

	#extractTtsrRuleNames(details: unknown): string[] {
		if (!details || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markTtsrInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#ttsrManager?.markInjectedByNames(uniqueRuleNames);
		this.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries.
			this.#perToolTtsrInjections.clear();
		}
		if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingTtsrInjections = [];
			return;
		}

		const injection = this.#getTtsrInjectionContent();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureTtsrResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#resolveTtsrResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#resolveTtsrResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#resolveTtsrResume();
			},
		});
	}

	/** Extract the tool-call block a toolcall_delta event refers to, if present. */
	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") {
			return undefined;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return undefined;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return undefined;
		}

		return block as ToolCall;
	}

	/** Build TTSR match context for tool call argument deltas. */
	#getTtsrToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) {
			return context;
		}

		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractTtsrToolFilePaths(toolCall);
		return context;
	}

	/**
	 * Resolve the file paths a tool call would touch for TTSR path-glob matching.
	 *
	 * Prefer the tool's own `matcherPaths` hook — it understands the wire format
	 * (hashline `[path#TAG]` section headers, apply_patch envelope markers) and
	 * surfaces paths the generic top-level argument scan never sees. Fall back
	 * to {@link #extractTtsrFilePathsFromArgs} for tools that pass paths as
	 * `path`/`paths` arguments and for tool calls whose payload has not yet
	 * streamed a header.
	 */
	#extractTtsrToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const tools = this.agent.state.tools;
		const tool =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(p => this.#normalizeTtsrPathCandidates(p));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#extractTtsrFilePathsFromArgs(args);
	}

	/**
	 * Match a stream delta against TTSR rules.
	 *
	 * Tool argument streams prefer the tool's `matcherDigest` normalization — the
	 * real content the call introduces — over the raw argument delta, so rule
	 * conditions written against source text keep working regardless of the
	 * tool's wire format (hashline patches, JSON-escaped strings, ...).
	 */
	#checkTtsrStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveTtsrMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(...manager.checkSnapshot(entry.digest, this.#perFileTtsrContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest !== undefined) {
			return manager.checkSnapshot(digest, matchContext);
		}
		return manager.checkDelta(delta, matchContext);
	}

	/** Reconstruct the tool's normalized source snapshot via its `matcherDigest`, if any. */
	#resolveTtsrMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTtsrTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	/**
	 * Per-file split of a streamed call (one entry per touched file paired with
	 * the digest of only that file's added lines). Lets {@link #checkTtsrStream}
	 * and {@link #checkTtsrAstStream} evaluate each file in isolation so a
	 * path-scoped rule like `tool:edit(*.ts)` never fires on text that belongs
	 * to a sibling Markdown hunk in a multi-file payload.
	 */
	#resolveTtsrMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTtsrTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTtsrTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.agent.state.tools;
		return (
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name)
		);
	}

	/**
	 * Replace `matchContext`'s `filePaths` + `streamKey` so a per-file entry
	 * gets its own glob-eligible path and its own TTSR buffer/repeat tracking
	 * (each file's stream is independent inside the same tool call).
	 */
	#perFileTtsrContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizeTtsrPathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	/**
	 * Match ast-grep `astCondition` rules against the reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams expose a `matcherDigest`, which is the real source
	 * the call introduces; AST matching needs that (and a language inferred from the
	 * path argument), so non-digest streams never produce AST matches.
	 */
	async #checkTtsrAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveTtsrMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(
					...(await manager.checkAstSnapshot(entry.digest, this.#perFileTtsrContext(matchContext, entry.path))),
				);
			}
			return matches;
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest === undefined) {
			return [];
		}
		return manager.checkAstSnapshot(digest, matchContext);
	}

	/**
	 * Route TTSR matches to either a per-tool injection or a stream-interrupting
	 * retry. Returns true when the stream was aborted and the caller should stop
	 * processing this event.
	 */
	#handleTtsrMatches(
		matches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		// Decide first: a non-interrupting tool-source match attaches to the
		// specific tool call's result instead of driving a loop-wide follow-up.
		const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext);
		const matchedToolId = this.#extractTtsrToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolTtsrInjections(perToolId, matches);
			this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
			return false;
		}

		// Queue rules for injection; mark as injected only after successful enqueue.
		this.#addPendingTtsrInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		// Abort the stream immediately — do not gate on extension callbacks
		this.#ttsrAbortPending = true;
		this.#ensureTtsrResumePromise();
		const abortReason = this.#formatTtsrAbortReason(matches);
		this.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		// Notify extensions (fire-and-forget, does not block abort)
		this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
		// Schedule retry after a short delay
		const retryToken = ++this.#ttsrRetryToken;
		const generation = this.#promptGeneration;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#ttsrRetryToken !== retryToken) {
					this.#resolveTtsrResume();
					return;
				}

				const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp);
				if (!this.#ttsrAbortPending || this.#promptGeneration !== generation || targetAssistantIndex === -1) {
					this.#ttsrAbortPending = false;
					this.#pendingTtsrInjections = [];
					this.#perToolTtsrInjections.clear();
					this.#resolveTtsrResume();
					return;
				}
				this.#ttsrAbortPending = false;
				this.#perToolTtsrInjections.clear();
				const ttsrSettings = this.#ttsrManager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					// Remove the partial/aborted assistant turn from agent state
					this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
				}
				// Inject TTSR rules as system reminder before retry
				const injection = this.#getTtsrInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markTtsrInjected(details.rules);
				}
				try {
					await this.agent.continue();
				} catch {
					this.#resolveTtsrResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
	#extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizeTtsrPathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
	#normalizeTtsrPathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#resetStreamingEditState(): void {
		this.#streamingEditAbortTriggered = false;
		this.#streamingEditCheckedLineCounts.clear();
		this.#streamingEditPrecheckedToolCallIds.clear();
		this.#streamingEditFileCache.clear();
	}

	#activeToolCallLoopGuard(): ToolCallLoopGuard | undefined {
		if (this.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
			return undefined;
		}

		const threshold = this.settings.get("model.toolCallLoopGuard.threshold");
		const exemptTools = this.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#toolCallLoopGuardSettingsKey = settingsKey;
		}
		return this.#toolCallLoopGuard;
	}

	#activeToolProgressGuard(): ToolProgressGuard | undefined {
		if (this.settings.get("model.toolProgressGuard.enabled") !== true) {
			this.#toolProgressGuard = undefined;
			this.#toolProgressGuardSettingsKey = undefined;
			return undefined;
		}

		const mode = this.settings.get("model.toolProgressGuard.mode");
		const repeatThreshold = this.settings.get("model.toolProgressGuard.repeatThreshold");
		const saturationWindow = this.settings.get("model.toolProgressGuard.saturationWindow");
		const saturationMaxResources = this.settings.get("model.toolProgressGuard.saturationMaxResources");
		const finalizeAfterNoProgress = this.settings.get("model.toolProgressGuard.finalizeAfterNoProgress");
		const historyLimit = this.settings.get("model.toolProgressGuard.historyLimit");
		const exemptTools = this.settings
			.get("model.toolProgressGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = JSON.stringify({
			mode,
			repeatThreshold,
			saturationWindow,
			saturationMaxResources,
			finalizeAfterNoProgress,
			historyLimit,
			exemptTools,
		});
		if (!this.#toolProgressGuard || this.#toolProgressGuardSettingsKey !== settingsKey) {
			this.#toolProgressGuard = new ToolProgressGuard({
				mode,
				repeatThreshold,
				saturationWindow,
				saturationMaxResources,
				finalizeAfterNoProgress,
				historyLimit,
				exemptTools,
			});
			this.#toolProgressGuardSettingsKey = settingsKey;
		}
		return this.#toolProgressGuard;
	}

	#resetToolLoopGuardsForUserInput(): void {
		this.#toolCallLoopGuard = undefined;
		this.#toolCallLoopGuardSettingsKey = undefined;
		this.#toolProgressGuard?.reset();
	}

	#maybeInjectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		const content = prompt.render(toolCallLoopRedirectTemplate, {
			tool_name: detection.toolName,
			count: detection.count,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
		const details = {
			toolName: detection.toolName,
			count: detection.count,
			argumentsSummary: detection.argumentsSummary,
			resultSummary: detection.resultSummary,
		};
		logger.warn("cross-turn tool-call loop detected", {
			toolName: detection.toolName,
			count: detection.count,
		});
		const redirectMessage: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirectMessage);
		if (this.agent.state.messages !== messages) {
			this.agent.appendMessage(redirectMessage);
		}
		this.sessionManager.appendCustomMessageEntry(TOOL_CALL_LOOP_REDIRECT_TYPE, content, false, details, "agent");
	}

	#maybeInjectToolProgressGuardMessage(messages: AgentMessage[], detection: ToolProgressGuardDetection): void {
		const template = detection.kind === "soft_redirect" ? toolProgressRedirectTemplate : toolProgressFinalizeTemplate;
		const content = prompt.render(template, {
			tools: detection.repeatedTools.join(", ") || "unknown",
			reason: detection.reason,
			...detection.snapshot,
		});
		const customType = detection.kind === "soft_redirect" ? TOOL_PROGRESS_REDIRECT_TYPE : TOOL_PROGRESS_FINALIZE_TYPE;
		logger.warn("tool progress guard transition", {
			kind: detection.kind,
			reason: detection.reason,
			tools: detection.repeatedTools,
			...detection.snapshot,
		});
		const message: CustomMessage = {
			role: "custom",
			customType,
			content,
			display: false,
			details: detection,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(message);
		if (this.agent.state.messages !== messages) this.agent.appendMessage(message);
		this.sessionManager.appendCustomMessageEntry(customType, content, false, detection, "agent");
	}

	/**
	 * Whether the Gemini header-runaway guard applies to the current model: the loop
	 * guard is on (settings + `PI_NO_THINKING_LOOP_GUARD`), the tool-call reminder is
	 * enabled, and the active model is a Gemini thinking model.
	 */
	#geminiHeaderGuardActive(): boolean {
		const model = this.model;
		return (
			process.env.PI_NO_THINKING_LOOP_GUARD !== "1" &&
			this.settings.get("model.loopGuard.enabled") === true &&
			this.settings.get("model.loopGuard.toolCallReminder") === true &&
			model !== undefined &&
			isGeminiThinkingModel(model)
		);
	}

	/**
	 * Feed streamed assistant events to the Gemini header-runaway detector. Each
	 * reasoning block (`thinking_start`) re-arms a fresh detector when the guard
	 * applies; thinking deltas accumulate thought-summary headers; assistant prose
	 * or a tool call ends the run. On the threshold hit, interrupts the stream (see
	 * {@link #interruptGeminiHeaderRunaway}). Runs synchronously inside the
	 * assistant-message interceptor so the abort lands before more budget burns.
	 * Armed on `thinking_start` (not `turn_start`, which the agent loop skips for the
	 * first turn) so the very first reasoning block is guarded too.
	 */
	#maybeInterruptGeminiHeaderRunaway(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type === "thinking_start") {
			this.#geminiHeaderDetector = this.#geminiHeaderGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#geminiHeaderDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptGeminiHeaderRunaway(detector.count, message.timestamp);
			return;
		}
		// Leaving the reasoning channel ends the run: the consecutive-header count
		// only matters within one uninterrupted stretch of reasoning.
		if (event.type === "text_start" || event.type === "toolcall_start") {
			detector.reset();
		}
	}

	/**
	 * Interrupt a Gemini reasoning stream that has emitted too many consecutive
	 * planning headers without calling a tool. Aborts the live turn, discards the
	 * stalled reasoning-only turn (so its partial, loop-fueling thinking is neither
	 * replayed nor reloaded), injects a hidden tool-call reminder, and continues.
	 * `targetTimestamp` identifies the turn being aborted so the post-prompt task
	 * can drop exactly it.
	 */
	#interruptGeminiHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: this.model?.id,
			provider: this.model?.provider,
			headers: headerCount,
		});
		this.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		this.agent.abort(GEMINI_HEADER_INTERRUPT_REASON);
		const generation = this.#promptGeneration;
		this.#schedulePostPromptTask(async signal => {
			if (signal.aborted || this.#isDisposed || this.#promptGeneration !== generation) return;
			// Let the aborted stream finish unwinding so continue() doesn't race it.
			await this.agent.waitForIdle();
			if (signal.aborted || this.#isDisposed || this.#promptGeneration !== generation) return;
			const aborted = this.agent.state.messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant" && m.timestamp === targetTimestamp,
			);
			if (aborted) this.#discardAssistantTurn(aborted);
			const content = prompt.render(geminiToolReminderTemplate, { count: headerCount });
			const details = { headers: headerCount };
			this.agent.appendMessage({
				role: "custom",
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			this.sessionManager.appendCustomMessageEntry(GEMINI_TOOL_REMINDER_TYPE, content, false, details, "agent");
			try {
				await this.agent.continue();
			} catch (err) {
				logger.warn("gemini tool-call reminder continue failed", { error: String(err) });
			}
		});
	}

	#getStreamingEditToolCall(event: AgentEvent):
		| {
				toolCall: ToolCall;
				path: string;
				resolvedPath: string;
				diff?: string;
				op?: string;
				rename?: string;
		  }
		| undefined {
		if (event.type !== "message_update") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const contentIndex = event.assistantMessageEvent.contentIndex ?? 0;
		const messageContent = event.message.content;
		if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
			return undefined;
		}

		const toolCall = messageContent[contentIndex] as ToolCall;
		if (toolCall.name !== "edit") return undefined;

		const args = toolCall.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		if ("old_text" in args || "new_text" in args) return undefined;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;

		// `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
		// on-disk artifacts path; pre-caching works as long as we ask the
		// local-protocol handler. Other internal-scheme URLs have no local
		// filesystem representation; skip pre-cache entirely for those — the
		// edit tool itself will reject them through its normal dispatch path.
		const resolvedPath = this.#resolveSessionFsPath(path);
		if (resolvedPath === undefined) return undefined;

		return {
			toolCall,
			path,
			resolvedPath,
			diff: typeof args.diff === "string" ? args.diff : undefined,
			op: typeof args.op === "string" ? args.op : undefined,
			rename: typeof args.rename === "string" ? args.rename : undefined,
		};
	}

	#lastStreamingEditToolCallId: string | undefined;
	#abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
		if (this.#lastStreamingEditToolCallId === toolCall.id) return;
		this.#lastStreamingEditToolCallId = toolCall.id;
		void assertEditableFile(resolvedPath, path).catch(err => {
			// peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
			// auto-generated detection; other failures are left for the edit tool.
			if (!(err instanceof ToolError)) return;
			if (this.#lastStreamingEditToolCallId !== toolCall.id) return;

			if (!this.#streamingEditAbortTriggered) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to auto-generated file guard", {
					toolCallId: toolCall.id,
					path,
				});
				this.agent.abort();
			}
		});
	}

	#preCacheStreamingEditFile(event: AgentEvent): void {
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end"
		) {
			return;
		}

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit) return;

		// The auto-generated guard runs unconditionally: editing a generated file
		// is never the user's intent, and the cost of a false-positive abort is one
		// wasted turn vs. silently corrupting a regenerated source.
		const shouldCheckAutoGenerated =
			!streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id);
		if (shouldCheckAutoGenerated) {
			if (streamingEdit.toolCall.id) {
				this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id);
			}
			this.#abortStreamingEditForAutoGeneratedPath(
				streamingEdit.toolCall,
				streamingEdit.path,
				streamingEdit.resolvedPath,
			);
		}

		// File-cache priming feeds #maybeAbortStreamingEdit's removed-lines check,
		// which is the optional patch-preview verification gated by
		// edit.streamingAbort. Skip the read when the setting is off.
		if (this.settings.get("edit.streamingAbort")) {
			this.#ensureFileCache(streamingEdit.resolvedPath);
		}
	}

	#ensureFileCache(resolvedPath: string): void {
		if (this.#streamingEditFileCache.has(resolvedPath)) return;

		try {
			const rawText = fs.readFileSync(resolvedPath, "utf-8");
			const { text } = stripBom(rawText);
			this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text));
		} catch {
			// Don't cache on read errors (including ENOENT) - let the edit tool handle them
		}
	}

	/** Invalidate cache for a file after an edit completes to prevent stale data */
	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs have no local filesystem path; this returns
	 *   `undefined` so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (isInternalUrlPath(normalized)) return undefined;
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#maybeAbortStreamingEdit(event: AgentEvent): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit?.toolCall.id) return;

		const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit;
		if (!diff) return;
		if (op && op !== "update") return;

		if (!diff.includes("\n")) return;
		const lastNewlineIndex = diff.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return;
		const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
		if (diffForCheck.trim().length === 0) return;

		let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""));
		if (!normalizedDiff) return;
		// Deobfuscate the diff so removed lines match real file content
		if (this.#obfuscator) normalizedDiff = this.#obfuscator.deobfuscate(normalizedDiff);
		if (!normalizedDiff) return;
		const lines = normalizedDiff.split("\n");
		const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
		if (!hasChangeLine) return;

		const lineCount = lines.length;
		const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id);
		if (lastChecked !== undefined && lineCount <= lastChecked) return;
		this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount);

		const removedLines = lines
			.filter(line => line.startsWith("-") && !line.startsWith("--- "))
			.map(line => line.slice(1));
		if (removedLines.length > 0) {
			let cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			if (cachedContent === undefined) {
				this.#ensureFileCache(resolvedPath);
				cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			}
			if (cachedContent !== undefined) {
				const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
				if (missing) {
					this.#streamingEditAbortTriggered = true;
					logger.warn("Streaming edit aborted due to patch preview failure", {
						toolCallId: toolCall.id,
						path,
						error: `Failed to find expected lines in ${path}:\n${missing}`,
					});
					this.agent.abort();
				}
				return;
			}
			if (assistantEvent.type === "toolcall_delta") return;
			void this.#checkRemovedLinesAsync(toolCall.id, path, resolvedPath, removedLines);
			return;
		}

		if (assistantEvent.type === "toolcall_delta") return;
		void this.#checkPreviewPatchAsync(toolCall.id, path, rename, normalizedDiff);
	}

	async #checkRemovedLinesAsync(
		toolCallId: string,
		path: string,
		resolvedPath: string,
		removedLines: string[],
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			const { text } = stripBom(await Bun.file(resolvedPath).text());
			const normalizedContent = normalizeToLF(text);
			const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
			if (missing) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId,
					path,
					error: `Failed to find expected lines in ${path}:\n${missing}`,
				});
				this.agent.abort();
			}
		} catch (err) {
			// Ignore ENOENT (file not found) - let the edit tool handle missing files
			// Also ignore other errors during async fallback
			if (!isEnoent(err)) {
				// Log unexpected errors but don't abort
			}
		}
	}

	async #checkPreviewPatchAsync(
		toolCallId: string,
		path: string,
		rename: string | undefined,
		normalizedDiff: string,
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			await previewPatch(
				{ path, op: "update", rename, diff: normalizedDiff },
				{
					cwd: this.sessionManager.getCwd(),
					allowFuzzy: this.settings.get("edit.fuzzyMatch"),
					fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
				},
			);
		} catch (error) {
			if (error instanceof ParseError) return;
			this.#streamingEditAbortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			this.agent.abort();
		}
	}

	#resetSessionStopContinuationState(): void {
		this.#sessionStopContinuationCount = 0;
		this.#sessionStopHookActive = false;
		this.#contextSteadyOriginalPreTurnLeafId = null;
		this.#contextSteadyOriginalPreTurnLeafCaptured = false;
	}

	/** Remove queued session-stop continuations from the pending queue. */
	#clearPendingSessionStopContinuations(): void {
		if (!this.#pendingNextTurnMessages.some(message => message.customType === "session-stop-continuation")) {
			return;
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
			message => message.customType !== "session-stop-continuation",
		);
	}

	#sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
		if (!result) return undefined;
		const additionalContext =
			typeof result.additionalContext === "string" && result.additionalContext.length > 0
				? result.additionalContext
				: undefined;
		const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
		if (result.continue === true) {
			return additionalContext ?? reason;
		}
		if (result.decision === "block") {
			return reason ?? additionalContext;
		}
		return undefined;
	}

	async #emitAgentEndNotification(messages: AgentMessage[], options?: { willContinue?: boolean }): Promise<void> {
		await this.#extensionRunner?.emit({
			type: "agent_end",
			messages,
			willContinue: options?.willContinue,
		});
	}

	/**
	 * Emit the `session_stop` event and determine what the settled path
	 * should do next.
	 *
	 * Returns a result describing the disposition:
	 * - `{ continuationScheduled: true }` — hook queued a continuation;
	 *   caller should NOT generate a digest yet.
	 * - `{ chainEnded: true }` — hook returned no context or cap reached;
	 *   final turn has settled; caller should generate the consolidated digest.
	 * - `{ invalidated: true }` — generation/abort/dispose invalidated this
	 *   turn; caller should NOT generate a digest.
	 */
	async #emitSessionStopEvent(
		messages: AgentMessage[],
		lastAssistantMessage = this.getLastAssistantMessage(),
	): Promise<{ continuationScheduled?: boolean; chainEnded?: boolean; invalidated?: boolean }> {
		if (this.#agentKind === "sub" || !this.#extensionRunner?.hasHandlers("session_stop")) {
			return { chainEnded: true };
		}
		const generation = this.#promptGeneration;
		const result = await this.#extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#turnIndex - 1),
			last_assistant_message: lastAssistantMessage,
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopHookActive,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return { invalidated: true };
		}
		const additionalContext = this.#sessionStopContinuationContext(result);
		if (!additionalContext) {
			// Continuation chain ended (or never started). The caller should
			// generate the consolidated digest. Keep #contextSteadyOriginalPreTurnLeafId
			// so the digest can span the full logical turn.
			this.#sessionStopContinuationCount = 0;
			this.#sessionStopHookActive = false;
			return { chainEnded: true };
		}
		if (this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#sessionStopContinuationCount = 0;
			this.#sessionStopHookActive = false;
			return { chainEnded: true };
		}
		this.#sessionStopContinuationCount++;
		this.#sessionStopHookActive = true;
		// Preserve the original pre-turn leaf boundary so the final
		// consolidated digest covers the full logical turn including
		// all continuations.
		if (!this.#contextSteadyOriginalPreTurnLeafCaptured) {
			this.#contextSteadyOriginalPreTurnLeafId = this.#contextSteadyPreTurnLeafId;
			this.#contextSteadyOriginalPreTurnLeafCaptured = true;
		}
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
		return { continuationScheduled: true };
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
			// `agent_end` extension notification is emitted from the settled
			// agent_end maintenance path so `session_stop` control hooks are not
			// blocked by unrelated notification-only work.
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				maintenanceId: event.maintenanceId,
				reason: event.reason,
				trigger: event.trigger,
				matchedTriggers: event.matchedTriggers,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				maintenanceId: event.maintenanceId,
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
				failureStage: event.failureStage,
				failureReason: event.failureReason,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				recoveredErrors: event.recoveredErrors,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		} else if (event.type === "model_route_resolved") {
			const extensionEvent: ModelRouteResolvedEvent = {
				type: "model_route_resolved",
				logicalModel: event.logicalModel,
				routeId: event.routeId,
				model: event.model,
				reason: event.reason,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "model_route_changed") {
			const extensionEvent: ModelRouteChangedEvent = {
				type: "model_route_changed",
				logicalModel: event.logicalModel,
				fromRoute: event.fromRoute,
				toRoute: event.toRoute,
				trigger: event.trigger,
				cooldownUntil: event.cooldownUntil,
			};
			await this.#extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = [...this.#commandMetadataChangedListeners];
		for (const listener of listeners) {
			try {
				void listener();
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	#activeProviderSessionId(sessionId?: string): string {
		return this.#freshProviderSessionId ?? this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
	}

	#adoptInheritedProviderPromptCacheKey(): void {
		const key = this.sessionManager.getHeader()?.providerPromptCacheKey;
		if (!key) return;
		if (this.#inheritedProviderPromptCacheKey !== undefined || this.agent.promptCacheKey === undefined) {
			this.agent.promptCacheKey = key;
			this.#inheritedProviderPromptCacheKey = key;
		}
	}

	#clearInheritedProviderPromptCacheKey(): void {
		const key = this.#inheritedProviderPromptCacheKey;
		this.#inheritedProviderPromptCacheKey = undefined;
		if (key !== undefined && this.agent.promptCacheKey === key) {
			this.agent.promptCacheKey = undefined;
		}
	}

	/**
	 * Set agent.sessionId from the session manager and install a dynamic
	 * metadata resolver so every Anthropic API request carries
	 * `metadata.user_id` shaped like real Claude Code's `getAPIMetadata` output:
	 * `{ session_id, account_uuid, device_id }`. `account_uuid` is included only
	 * when an Anthropic OAuth credential with a known account UUID is loaded;
	 * `device_id` is derived from both the persistent San install id and that
	 * account UUID. Resolving live keeps the value in sync with auth-state changes
	 * (login/logout, token refresh that surfaces a new account UUID) without
	 * needing to re-call `#syncAgentSessionId()` on every such event.
	 */
	#syncAgentSessionId(sessionId?: string): void {
		const sid = this.#activeProviderSessionId(sessionId);
		this.agent.sessionId = sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "hindsight") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getHindsightSessionState()?.setSessionId(sid);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "mnemopi") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getMnemopiSessionState()?.setSessionId(sid);
	}

	/** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
	#resetHindsightConversationTrackingIfHindsight(): boolean {
		if (this.settings.get("memory.backend") !== "hindsight") return false;
		const state = this.getHindsightSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	#resetMnemopiConversationTrackingIfMnemopi(): boolean {
		if (this.settings.get("memory.backend") !== "mnemopi") return false;
		const state = this.getMnemopiSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	async #resetMemoryContextForNewTranscript(): Promise<void> {
		const hadPromotedMemoryPrompt = this.#baseSystemPromptBeforeMemoryPromotion !== undefined;
		const resetHindsight = this.#resetHindsightConversationTrackingIfHindsight();
		const resetMnemopi = this.#resetMnemopiConversationTrackingIfMnemopi();
		if (hadPromotedMemoryPrompt) {
			this.#baseSystemPrompt = this.#baseSystemPromptBeforeMemoryPromotion!;
			this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		}
		if (resetHindsight || resetMnemopi || hadPromotedMemoryPrompt) {
			await this.refreshBaseSystemPrompt();
		}
	}
	/** Run one abortable auto-learn capture outside the primary agent loop. */
	async runAutolearnCapture(capture: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.#autolearnCaptureTask || this.#isDisposed) return;
		const controller = new AbortController();
		this.#autolearnCaptureAbortController = controller;
		const task = (async () => {
			try {
				await capture(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) throw error;
			} finally {
				if (this.#autolearnCaptureAbortController === controller) {
					this.#autolearnCaptureAbortController = undefined;
				}
			}
		})();
		this.#autolearnCaptureTask = task;
		try {
			await task;
		} finally {
			if (this.#autolearnCaptureTask === task) this.#autolearnCaptureTask = undefined;
		}
	}

	#abortAutolearnCapture(): void {
		this.#autolearnCaptureAbortController?.abort();
	}

	async #drainAutolearnCapture(): Promise<void> {
		const task = this.#autolearnCaptureTask;
		if (!task) return;
		try {
			await withTimeout(task, 3_000, "Timed out draining auto-learn capture during dispose");
		} catch (error) {
			logger.warn("Auto-learn capture did not settle during dispose", { error: String(error) });
		}
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/** 恢复流程取得写租约后，允许 Session 继续追加 journal。 */
	enableSessionWrites(): void {
		if (this.#sessionWritesEnabled) return;
		this.#sessionWritesEnabled = true;
		this.#registerExitRecorder();
	}

	/** 恢复确认取得写租约后，补写启动阶段刻意延后的中断回合终止记录。 */
	repairInterruptedTurnAfterRecovery(): void {
		if (!this.#sessionWritesEnabled)
			throw new Error("Cannot repair an interrupted turn without Session write access");
		const model = this.model;
		const interruptedTurnAbort = createInterruptedTurnAbortMessage(
			this.sessionManager.getBranch(),
			model ? { api: model.api, provider: model.provider, model: model.id } : undefined,
		);
		if (!interruptedTurnAbort) return;
		this.sessionManager.appendMessage(interruptedTurnAbort);
		this.agent.replaceMessages(this.buildDisplaySessionContext().messages);
	}

	/** 强制关闭在释放租约前调用，阻止异步尾事件继续写 Session journal。 */
	disableSessionWrites(): void {
		if (!this.#sessionWritesEnabled) return;
		this.#sessionWritesEnabled = false;
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately: eval starts throw, queued asides are dropped, and the
	 * aside provider is detached. Idempotent; `dispose()` runs it first.
	 *
	 * Wrappers that await other teardown before delegating to `dispose()` MUST
	 * call this before their first await — otherwise work started in that async
	 * gap slips past the disposal guards.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
		this.#titleGenerationAbortController.abort();
		this.#abortAutolearnCapture();
		this.#flushPendingIrcAsides();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#stopAdvisorRuntime();
		this.#evalExecutionDisposing = true;
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 *
	 * Idempotent: concurrent or repeated calls share one settled promise. The
	 * keypress `InteractiveMode.shutdown()` path and the postmortem
	 * `SIGTERM`/`SIGHUP`/`uncaughtException` callback can both target this
	 * method, so a second invocation must never re-emit `session_shutdown` or
	 * double-drain the owned `AsyncJobManager` (issue #4080).
	 */
	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#recordSessionExit(options.reason ?? "dispose");
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		try {
			if (this.#sessionWritesEnabled && this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		// Clear any timers extensions scheduled via `ctx.setInterval`/`ctx.setTimeout`
		// so their background work does not outlive the session (issue #5664).
		// Optional-called: hosts and tests may inject partial runner facades that
		// implement only the dispatch surface.
		this.#extensionRunner?.clearManagedTimers?.();
		this.#fallbackExtensionTimers?.clearAll();
		// Abort post-prompt work so the drain below can complete. Without this, a
		// deferred-handoff task that has already advanced into
		// `await this.handoff(...) → generateHandoff(...)` keeps awaiting a live LLM stream
		// — Promise.allSettled() in #cancelPostPromptTasks then waits forever, freezing
		// /exit and Ctrl+C-double-tap. The post-prompt task's own AbortSignal does not
		// propagate into the inner handoff/compaction controllers, so we abort them
		// explicitly. agent.abort() is needed for an agent.continue() that may have
		// raced the deferred handoff (its streaming loop is awaited by the wrapper IIFE).
		//
		// Tool work (bash/eval/python) is NOT aborted here — those have their own
		// dispose paths and shared kernels are contractually allowed to survive a
		// session's dispose.
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		await this.#drainAutolearnCapture();
		// Cancel jobs this agent registered so a subagent's teardown doesn't
		// leak its background bash/task work into the parent's manager. Only
		// the session that owns the manager goes on to dispose it (which itself
		// nukes any leftover jobs and pending deliveries).
		this.#cancelOwnAsyncJobs();
		const ownedAsyncManager = this.#ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const evalExecutionsSettled = await this.#prepareEvalExecutionsForDispose();
		if (!evalExecutionsSettled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		await disposeKernelSessionsByOwner(this.#evalKernelOwnerId);
		await disposeRubyKernelSessionsByOwner(this.#evalKernelOwnerId);
		await disposeJuliaKernelSessionsByOwner(this.#evalKernelOwnerId);
		// Release headless / spawned Chromium and worker tabs this session
		// opened via the browser tool. The tool's `tabs`/`browsers` maps are
		// module-global — subagents and future sessions share them — so we
		// walk by `ownerSessionId` (assigned at `acquireTab` creation, never on
		// reuse) and touch only what THIS session created. Bounded so a broken
		// CDP close cannot stall `/exit`; mirrors the async-job/MCP pattern.
		// (Issue #3963.)
		const browserOwnerId = this.sessionManager.getSessionId();
		if (browserOwnerId) {
			try {
				const released = await withTimeout(
					releaseTabsForOwner(browserOwnerId, { kill: true }),
					3_000,
					"Timed out releasing owned browser tabs during dispose",
				);
				if (released > 0) {
					logger.debug("Released owned browser tabs during dispose", { ownerId: browserOwnerId, released });
				}
			} catch (error) {
				logger.warn("Failed to release owned browser tabs during dispose", { error: String(error) });
			}
		}
		this.#releasePowerAssertion();
		// Clean up an empty session created by this session's /move so it doesn't accumulate.
		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		await this.#contextProbeWrite;
		// beginDispose() stopped the advisor and captured its recorder close; await
		// it so the final advisor turn is flushed before the process may exit.
		await this.#advisorRecorderClosed;
		this.#closeAllProviderSessions("dispose");
		// Disconnect the MCP manager this session OWNS so its stdio servers are
		// not orphaned at exit. Best-effort: a failure here must never throw out
		// of dispose. Only owning (top-level) sessions provide this callback;
		// subagents reuse a parent's manager and must not tear it down. Idempotent
		// with the deferred-discovery disconnect in `createAgentSession`.
		//
		// BOUNDED: an owned manager may hold an HTTP/SSE server whose session-
		// termination DELETE blocks up to the MCP request timeout (30s default,
		// unbounded when SAN_MCP_TIMEOUT_MS=0 (legacy: OMP_MCP_TIMEOUT_MS), so awaiting `disconnectAll()`
		// unbounded would stall /exit and print-mode shutdown on a broken remote
		// endpoint. Race it against a short deadline — stdio close (the subprocess
		// reap this targets) completes well within the bound; a slow transport
		// close is left to finish detached. Mirrors the bounded async-job teardown.
		if (this.#disconnectOwnedMcpManager) {
			try {
				await withTimeout(
					this.#disconnectOwnedMcpManager(),
					3_000,
					"Timed out disconnecting owned MCP manager during dispose",
				);
			} catch (error) {
				logger.warn("Failed to disconnect owned MCP manager during dispose", { error: String(error) });
			}
		}
		// 释放本会话拥有的 execution runtime（创建它的根会话）。采纳会话共享父
		// runtime，不得拆除。runtime dispose 按契约幂等；失败会上抛，绝不静默。
		if (this.#ownedExecutionRuntime) {
			this.#ownedExecutionRuntime.dispose();
			this.#ownedExecutionRuntime = undefined;
		}
		// Flush the retain queue BEFORE clearing the session's pointer so
		// `HindsightRetainQueue.#doFlush` still sees `session.getHindsightSessionState() === state`.
		// Reversed, the spliced batch survives just long enough to fail the
		// identity check and get dropped with a `session vanished` warning.
		const hindsightState = this.getHindsightSessionState();
		await hindsightState?.flushRetainQueue();
		this.setHindsightSessionState(undefined);
		hindsightState?.dispose();
		const mnemopiState = setMnemopiSessionState(this, undefined);
		await mnemopiState?.dispose({ timeoutMs: options.mnemopiConsolidateTimeoutMs });
		// Tear down the embeddings subprocess AFTER mnemopi state.dispose:
		// consolidate-on-dispose may still call `embed()` to store the final
		// memories, and that round-trips through the worker we are about to
		// hard-kill (issue #3031).
		await shutdownMnemopiEmbedClient();
		await shutdownTinyModelClient();
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		if (this.#unsubscribeModelRoles) {
			this.#unsubscribeModelRoles();
			this.#unsubscribeModelRoles = undefined;
		}
		this.#eventListeners = [];

		// 停止继续捕获 provider 帧；agent.abort() 只发出中止信号，核心 run 与
		// fire-and-forget 事件处理仍需排空后才能安全释放内存。
		this.agent.setProviderResponseInterceptor(undefined);
		this.agent.setRawSseEventInterceptor(undefined);
		let drained = false;
		try {
			await withTimeout(
				(async () => {
					await this.agent.waitForIdle();
					await this.#drainInFlightEventHandlers();
				})(),
				options.drainTimeoutMs ?? SESSION_DISPOSE_DRAIN_TIMEOUT_MS,
				"Timed out waiting for the active agent run to settle during dispose",
			);
			drained = true;
		} catch (error) {
			logger.warn("Active agent run still settling at dispose deadline", { error: String(error) });
		}

		// seal 必须先于最终 close：超时事件可能在 close 等待 disk tail 时恢复，
		// 但旧 manager 从此不能再向已被新会话打开的 transcript 排队写入。
		this.sessionManager.seal();
		await this.sessionManager.close();
		this.#releaseRetainedSessionMemory();

		// deadline 不会取消原事件链。链路最终结束后再清一次内存；磁盘写屏障已
		// 升起，因此这次终态化不会与 revival 的新 manager 竞争。
		if (!drained) {
			void (async () => {
				await this.agent.waitForIdle();
				await this.#drainInFlightEventHandlers();
				this.#releaseRetainedSessionMemory();
			})().catch(error => logger.warn("Deferred dispose finalization failed", { error: String(error) }));
		}
	}

	/** 释放 dispose 后不再使用的全部会话内存副本。 */
	#releaseRetainedSessionMemory(): void {
		this.agent.reset();
		this.agent.setAppendOnlyContext(undefined);
		this.rawSseDebugBuffer.clear();
		this.sessionManager.releaseRetainedEntries();
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessionState.size;
		this.#closeAllProviderSessions("fresh session");
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Session-local model selector for subagents bound to the task role. */
	getSubagentModelOverride(): string | undefined {
		return getSessionSubagentModelOverride(this.sessionManager.getBranch());
	}

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	#serviceTierByFamily: ServiceTierByFamily = {};

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** 标记流式文本是否已经写入当前输出端，供重放安全判定使用。 */
	setTextOutputCommitted(committed: boolean): void {
		this.#textOutputCommitted = committed;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/**
	 * Enabled tool names: top-level active tools plus discoverable tools mounted
	 * under `xd://`. Reconcile callers (MCP refresh, discovery, plan/goal mode)
	 * build their next active set from this so a mount survives an active-set
	 * change; {@link getActiveToolNames} stays the top-level-only view.
	 */
	getEnabledToolNames(): string[] {
		if (this.#mountedXdevToolNames.size === 0) return this.getActiveToolNames();
		return [...this.getActiveToolNames(), ...this.#mountedXdevToolNames];
	}

	/** Names of discoverable tools currently mounted under `xd://` (dynamic mounts). */
	getMountedXdevToolNames(): string[] {
		return [...this.#mountedXdevToolNames];
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/** True when the current registry entry for `name` came from a built-in factory. */
	hasBuiltInTool(name: string): boolean {
		return this.#builtInToolNames.has(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		return this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped;
	}

	/**
	 * Registers the ephemeral vibe tools and activates them alongside `baseToolNames`.
	 *
	 * @throws When this session cannot create vibe tools or the factory returns duplicate names.
	 */
	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		const createVibeTools = this.#createVibeTools;
		if (!createVibeTools) {
			throw new Error("Vibe tools are unavailable in this session.");
		}

		const tools = createVibeTools();
		const vibeToolNames = tools.map(tool => tool.name);
		if (new Set(vibeToolNames).size !== vibeToolNames.length) {
			throw new Error("Vibe tool names must be unique.");
		}

		for (const tool of tools) {
			if (this.#toolRegistry.has(tool.name)) continue;
			this.#toolRegistry.set(tool.name, this.#wrapRuntimeTool(tool));
			this.#builtInToolNames.add(tool.name);
			this.#installedVibeToolNames.add(tool.name);
		}

		await this.#applyActiveToolsByName([...new Set([...baseToolNames, ...vibeToolNames])]);
	}

	/** Removes tools installed by {@link activateVibeTools} and activates `nextToolNames`. */
	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		for (const name of this.#installedVibeToolNames) {
			this.#toolRegistry.delete(name);
			this.#builtInToolNames.delete(name);
		}
		this.#installedVibeToolNames.clear();
		await this.#applyActiveToolsByName(nextToolNames);
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	#currentHarnessProfile(): string | undefined {
		const model = this.model;
		if (!model) return undefined;
		const activeRoute = this.#modelRouteLease.active;
		if (activeRoute && this.#modelRouteLease.matchesModel(model)) return activeRoute.harnessProfile;
		return formatModelString(model);
	}

	/** 行为 profile 与 concrete tool dialect 共同决定模型相关 prompt 内容。 */
	#currentPromptModelKey(): string | undefined {
		const harnessProfile = this.#currentHarnessProfile();
		if (!harnessProfile) return undefined;
		const guidanceKey = this.settings.get("includeModelInPrompt")
			? `profile:${harnessProfile}`
			: usesCodexTaskPrompt(harnessProfile)
				? "task-policy:gpt-5.6"
				: "task-policy:default";
		const dialect = resolveDialect(this.settings.get("tools.format"), this.model) ?? "native";
		return `${guidanceKey}|tool-dialect:${dialect}`;
	}

	async #syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");
		const promptProfileChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || promptProfileChanged) {
			await this.refreshBaseSystemPrompt();
		}
	}

	getSelectedMCPToolNames(): string[] {
		// Every connected MCP tool is enabled; presentation (top-level vs xd://) is
		// decided by loadMode. Return the enabled MCP tools in the current set.
		return this.getEnabledToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 *
	 * When the user has explicitly opted into `yolo` / auto-approve behavior (via
	 * the SDK/CLI `autoApprove` flag or a configured `tools.approvalMode: yolo`),
	 * skips the gate unless the per-tool policy explicitly requires a prompt or
	 * deny. The schema default is also `yolo`, so an explicit configuration or
	 * explicit session flag is required: default-config ACP sessions keep the
	 * client-side permission gate.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#clientBridge;
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;
		// Skip the gate only on explicit yolo opt-in; honour per-tool policies
		// that require a prompt or deny (matching the normal approval wrapper).
		if (this.#isExplicitAutoApproveMode()) {
			const userPolicies = (this.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === "bash" && args && typeof args === "object" && !Array.isArray(args)
							? getStringProperty(args as Record<string, unknown>, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					// Short-circuit on persisted decisions.
					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(target.name === "bash" ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.sessionManager.getCwd(),
									permissionIntent.paths,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(this.settings.isConfigured("tools.approvalMode") && this.settings.get("tools.approvalMode") === "yolo")
		);
	}

	async #applyActiveToolsByName(toolNames: string[]): Promise<void> {
		toolNames = normalizeToolNames(toolNames);
		let builtInWriteAvailable = this.#builtInToolNames.has("write");
		if (toolNames.includes("write") && !builtInWriteAvailable) {
			builtInWriteAvailable = (await this.#ensureWriteRegistered?.()) === true;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		const selectedTools = toolNames.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [{ name, tool }] : [];
		});
		const xdevReadAvailable = this.#builtInToolNames.has("read") && selectedTools.some(({ name }) => name === "read");
		const xdevWriteAvailable = builtInWriteAvailable && selectedTools.some(({ name }) => name === "write");
		const isPresentationPinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mountCandidates = selectedTools.filter(
			({ name, tool }) =>
				this.#xdevRegistry !== undefined &&
				xdevReadAvailable &&
				xdevWriteAvailable &&
				!isPresentationPinned(name) &&
				isMountableUnderXdev(tool),
		);
		const mountNames = new Set(mountCandidates.map(({ name }) => name));
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const mountedTools: AgentTool[] = [];
		for (const { name, tool } of selectedTools) {
			if (mountNames.has(name)) {
				mountedTools.push(this.#wrapToolForAcpPermission(tool));
			} else {
				tools.push(this.#wrapToolForAcpPermission(tool));
				validToolNames.push(name);
			}
		}

		const pinnedWrite = isPresentationPinned("write");
		const activeDeferrableTool = tools.some(tool => tool.deferrable === true);
		const transportNeeded = mountedTools.length > 0 || activeDeferrableTool || this.#planModeState?.enabled === true;
		if (transportNeeded && !builtInWriteAvailable) {
			builtInWriteAvailable = (await this.#ensureWriteRegistered?.()) === true;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		if (transportNeeded && builtInWriteAvailable) {
			const write = this.#toolRegistry.get("write");
			if (write && !validToolNames.includes("write")) {
				tools.push(this.#wrapToolForAcpPermission(write));
				validToolNames.push("write");
			}
		} else if (
			!pinnedWrite &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined)
		) {
			const writeNameIndex = validToolNames.indexOf("write");
			if (writeNameIndex >= 0 && this.#builtInToolNames.has("write")) validToolNames.splice(writeNameIndex, 1);
			const writeToolIndex = tools.findIndex(tool => tool.name === "write" && this.#builtInToolNames.has("write"));
			if (writeToolIndex >= 0) tools.splice(writeToolIndex, 1);
		}

		const previousMounted = this.#mountedXdevToolNames;
		const previousMountedTools = [...previousMounted].flatMap(name => {
			const tool = this.#xdevRegistry?.get(name);
			return tool ? [tool] : [];
		});
		const previousActiveToolNames = this.getActiveToolNames();
		this.#mountedXdevToolNames = new Set(mountedTools.map(tool => tool.name));
		this.#xdevRegistry?.reconcile(mountedTools);
		this.#setActiveToolNames?.(validToolNames);

		let rebuiltSystemPrompt: string[] | undefined;
		let rebuiltSignature: string | undefined;
		let rebuiltXdevCatalogNames: readonly string[] | undefined;
		try {
			if (this.#rebuildSystemPrompt) {
				const signature = this.#computeAppliedToolSignature(validToolNames, tools);
				if (signature !== this.#lastAppliedToolSignature) {
					const built = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
					rebuiltSystemPrompt = built.systemPrompt;
					rebuiltSignature = signature;
					rebuiltXdevCatalogNames = built.xdevCatalogNames;
				}
			}
		} catch (error) {
			this.#mountedXdevToolNames = previousMounted;
			this.#xdevRegistry?.reconcile(previousMountedTools);
			this.#setActiveToolNames?.(previousActiveToolNames);
			throw error;
		}

		this.#notifyXdevMountDelta(previousMounted);
		this.agent.setTools(tools);
		if (rebuiltSystemPrompt && rebuiltSignature) {
			if (this.#lastAppliedToolSignature !== undefined) this.#clearInheritedProviderPromptCacheKey();
			this.#baseSystemPrompt = rebuiltSystemPrompt;
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
			this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			this.#lastAppliedToolSignature = rebuiltSignature;
			this.#promptModelKey = this.#currentPromptModelKey();
			this.#basePromptXdevNames = new Set(rebuiltXdevCatalogNames);
		}
	}

	/** Record mount churn without starting an unsolicited model turn. */
	#notifyXdevMountDelta(previousMounted: ReadonlySet<string>): void {
		if (!this.#xdevRegistry) return;
		const current = this.#mountedXdevToolNames;
		const addedNames = [...current].filter(name => !previousMounted.has(name));
		const removedNames = [...previousMounted].filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;

		const pending = this.#pendingXdevMountDelta ?? { added: new Set<string>(), removed: new Set<string>() };
		for (const name of addedNames) {
			if (!pending.removed.delete(name)) pending.added.add(name);
		}
		for (const name of removedNames) {
			if (!pending.added.delete(name)) pending.removed.add(name);
		}
		this.#pendingXdevMountDelta = pending.added.size > 0 || pending.removed.size > 0 ? pending : undefined;

		if (this.settings.get("startup.quiet")) return;
		const parts: string[] = [];
		if (addedNames.length > 0) parts.push(`mounted ${addedNames.join(", ")}`);
		if (removedNames.length > 0) parts.push(`unmounted ${removedNames.join(", ")}`);
		this.emitNotice("info", `xd://: ${parts.join("; ")}`, "xdev");
	}

	/** Re-seed delivered mount history after the active transcript changes. */
	#resetAnnouncedMounts(): void {
		this.#announcedMounts.clear();
		this.#announcedMountsSeeded = false;
	}

	#ensureAnnouncedMountsSeeded(): void {
		if (this.#announcedMountsSeeded) return;
		this.#announcedMountsSeeded = true;
		for (const message of this.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== XDEV_MOUNT_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (
				isRecord(details) &&
				Array.isArray(details.added) &&
				details.added.every(name => typeof name === "string") &&
				Array.isArray(details.removed) &&
				details.removed.every(name => typeof name === "string")
			) {
				for (const name of details.added) this.#announcedMounts.add(name);
				for (const name of details.removed) this.#announcedMounts.delete(name);
				continue;
			}

			if (typeof message.content !== "string") continue;
			let section: "added" | "removed" | undefined;
			for (const line of message.content.split("\n")) {
				if (line === "These tools became available:") {
					section = "added";
					continue;
				}
				if (line.startsWith("These tools became available.")) {
					section = "added";
					continue;
				}
				if (line.startsWith("No longer mounted")) {
					section = "removed";
					continue;
				}
				if (line === "Configured inline device docs:" || line === "</system-notice>") break;
				if (line.startsWith("Read `xd://<tool>`")) {
					section = undefined;
					continue;
				}
				if (!section) continue;
				const match = /^- xd:\/\/(\S+?)(?:\s+—|$)/.exec(line);
				const name = match?.[1];
				if (!name) continue;
				if (section === "added") this.#announcedMounts.add(name);
				else this.#announcedMounts.delete(name);
			}
		}
	}

	/** Consume a coalesced mount delta at a user prompt boundary. */
	#takePendingXdevMountNotice(baseCatalogDelivered: boolean): CustomMessage<XdevMountNoticeDetails> | undefined {
		const pending = this.#pendingXdevMountDelta;
		if (!pending) return undefined;
		this.#pendingXdevMountDelta = undefined;
		this.#ensureAnnouncedMountsSeeded();

		if (baseCatalogDelivered) {
			for (const name of pending.added) {
				if (this.#basePromptXdevNames.has(name)) this.#announcedMounts.add(name);
			}
		}
		const addedNames = [...pending.added].filter(name => !this.#announcedMounts.has(name));
		const removedNames = [...pending.removed].filter(name => this.#announcedMounts.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return undefined;

		const summaries = new Map(this.#xdevRegistry?.entries().map(entry => [entry.name, entry.summary]) ?? []);
		const added = addedNames.map(name => ({ name, summary: summaries.get(name) ?? "" }));
		const removed = removedNames.map(name => ({ name }));
		const docs =
			this.#xdevRegistry?.docsFor(
				addedNames,
				this.settings.get("tools.xdevDocs"),
				this.settings.get("tools.xdevInlineDevices"),
			) ?? "";
		for (const name of addedNames) this.#announcedMounts.add(name);
		for (const name of removedNames) this.#announcedMounts.delete(name);
		return {
			role: "custom",
			customType: XDEV_MOUNT_NOTICE_MESSAGE_TYPE,
			content: prompt.render(xdevMountNoticePrompt, { added, removed, docs }),
			details: { added: addedNames, removed: removedNames },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * Rediscover disk-backed skills and rebuild prompt-facing state without
	 * recreating the session. Explicit skill snapshots (`--no-skills`,
	 * SDK-provided `skills`) remain fixed for the lifetime of the session.
	 */
	async refreshSkills(): Promise<void> {
		if (!this.#skillsReloadable) {
			return;
		}

		resetCapabilities();
		const skillsSettings = this.settings.getGroup("skills");
		const discovered = await loadSkills({
			...skillsSettings,
			cwd: this.sessionManager.getCwd(),
			agentDir: this.settings.getAgentDir(),
			disabledExtensions: this.settings.get("disabledExtensions") ?? [],
		});
		this.#skills = discovered.skills;
		this.#skillWarnings = discovered.warnings;
		this.#skillsSettings = skillsSettings;

		if (this.#agentKind === "main") {
			setActiveSkills(this.#skills);
		}
		await this.refreshBaseSystemPrompt();
		this.#notifyCommandMetadataChanged();
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		const mounted = this.#mountedXdevToolNames;
		const normalized = normalizeToolNames(toolNames);
		const transportWriteActive =
			this.#builtInToolNames.has("write") &&
			this.getActiveToolNames().includes("write") &&
			this.#presentationPinnedToolNames?.has("write") !== true &&
			this.#runtimeSelectedToolNames?.has("write") !== true &&
			(mounted.size > 0 || this.#planModeState?.enabled === true);
		const previousRuntimeSelectedToolNames = this.#runtimeSelectedToolNames;
		this.#runtimeSelectedToolNames = new Set(
			normalized.filter(name => !mounted.has(name) && !(name === "write" && transportWriteActive)),
		);
		try {
			await this.#applyActiveToolsByName(normalized);
		} catch (error) {
			this.#runtimeSelectedToolNames = previousRuntimeSelectedToolNames;
			throw error;
		}
	}

	/** Apply a rebuilt base prompt without clobbering the active turn override. */
	#applyAgentSystemPrompt(base: string[]): void {
		this.agent.setSystemPrompt(this.#turnSystemPromptOverride ?? base);
	}

	#setTurnSystemPromptOverride(prompt: string[]): void {
		this.#turnSystemPromptOverride = prompt;
		this.agent.setSystemPrompt(prompt);
	}

	#clearTurnSystemPromptOverride(): void {
		this.#turnSystemPromptOverride = undefined;
	}

	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		this.#setActiveToolNames?.(activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.#baseSystemPrompt = built.systemPrompt;
		this.#basePromptXdevNames = new Set(built.xdevCatalogNames);
		this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#clearInheritedProviderPromptCacheKey();
		}
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();
		// Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
	}

	async #buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		if (this.#contextSteadyIsActive() && this.settings.get("san.contextSteady.recall.enabled") === true) {
			if (this.#baseSystemPromptBeforeMemoryPromotion) {
				this.#baseSystemPrompt = this.#baseSystemPromptBeforeMemoryPromotion;
				this.#baseSystemPromptBeforeMemoryPromotion = undefined;
				this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			}
			return this.#baseSystemPrompt;
		}

		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt;

		try {
			const injected = await backend.beforeAgentStartPrompt(this, promptText);
			if (!injected) return this.#baseSystemPrompt;

			const previousBaseSystemPrompt = this.#baseSystemPrompt;
			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(refreshErr),
				});
			}

			if (
				this.#baseSystemPrompt.length !== previousBaseSystemPrompt.length ||
				this.#baseSystemPrompt.some((part, index) => part !== previousBaseSystemPrompt[index])
			) {
				return this.#baseSystemPrompt;
			}

			this.#baseSystemPromptBeforeMemoryPromotion ??= previousBaseSystemPrompt;
			const stablePrompt = [...previousBaseSystemPrompt, injected];
			this.#baseSystemPrompt = stablePrompt;
			this.#applyAgentSystemPrompt(stablePrompt);
			return stablePrompt;
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#baseSystemPrompt;
		}
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let instructionsSegment = "";
		const serverInstructions = this.#getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		// The xd:// device inventory is deliberately NOT part of the signature:
		// a mount/unmount announces itself via `#notifyXdevMountDelta` instead of
		// rewriting the system prompt, so MCP connects/disconnects keep the
		// prompt (and its provider cache prefix) byte-stable. Rebuilds triggered
		// by other inputs pick up the current device docs opportunistically.
		const date = this.#getLocalCalendarDate();
		return `${nameSegment}\u0003${descriptionSegment}\u0007${instructionsSegment}|${date}`;
	}

	/**
	 * Replace MCP tools in the registry and enable them immediately. Every
	 * connected MCP tool becomes available (mounted under `xd://` when that
	 * transport is active, else top-level). Lets `/mcp add/remove/reauth` take
	 * effect without restarting the session.
	 */
	async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const presentedMcpTools = filterPresentedCodeGraphTools(
			mcpTools,
			this.settings.get("san.codeIntelligence.enabled"),
		);
		const existingNames = Array.from(this.#toolRegistry.keys());
		const previousMcpTools = new Map(
			existingNames.flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return isMCPToolName(name) && tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of existingNames) {
			if (isMCPToolName(name)) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			localProtocolOptions: this.#localProtocolOptions(),
		});

		for (const customTool of presentedMcpTools) {
			const wrapped = wrapToolWithMetaNotice(CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool);
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		// Every connected MCP tool is selected; centralized repartitioning owns
		// presentation pins and write-transport activation/removal.
		const nextActive = [
			...new Set([...this.#getActiveNonMCPToolNames(), ...presentedMcpTools.map(tool => tool.name)]),
		];
		try {
			await this.#applyActiveToolsByName(nextActive);
		} catch (error) {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#toolRegistry.delete(name);
			}
			for (const [name, tool] of previousMcpTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getEnabledToolNames();
		const previousRpcHostTools = new Map(
			[...previousRpcHostToolNames].flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(metaWrapped, this.#extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		try {
			await this.#applyActiveToolsByName(
				Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
			);
		} catch (error) {
			for (const name of this.#rpcHostToolNames) this.#toolRegistry.delete(name);
			this.#rpcHostToolNames = previousRpcHostToolNames;
			for (const [name, tool] of previousRpcHostTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): { label: string; uri: string; image: ImageContent }[] {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.map((image, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
			}));
		}
		return [];
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator);
	}

	/**
	 * Transcript for TUI display. Full history is kept for export/resume-style
	 * callers; live chat can collapse compacted history to keep the hot render
	 * surface bounded. Display-only — NEVER feed the result to
	 * `agent.replaceMessages` or a provider.
	 */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return deobfuscateSessionContext(
			this.sessionManager.buildSessionContext({
				transcript: true,
				collapseCompactedHistory: options?.collapseCompactedHistory,
				keepDanglingToolCalls: options?.keepDanglingToolCalls,
			}),
			this.#obfuscator,
		);
	}

	#obfuscateTextForProvider(text: string | undefined): string | undefined {
		if (!text || !this.#obfuscator?.hasSecrets()) return text;
		return this.#obfuscator.obfuscate(text);
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#obfuscator?.hasSecrets()) return preparation;
		const previousSummary = this.#obfuscateTextForProvider(preparation.previousSummary);
		// `compact()` folds the prior snapcompact archive's plaintext into the
		// summarization prompt on the snapcompact→context-full transition, so the
		// archive's text regions must be redacted alongside the summary. Only the
		// `snapcompact` slot's text is rewritten; every other preserveData key —
		// notably the OpenAI remote-compaction `encrypted_content` replay state — is
		// opaque provider-replay data and stays byte-identical.
		const previousPreserveData = this.#obfuscatePreservedArchiveText(preparation.previousPreserveData);
		if (
			previousSummary === preparation.previousSummary &&
			previousPreserveData === preparation.previousPreserveData
		) {
			return preparation;
		}
		return { ...preparation, previousSummary, previousPreserveData };
	}

	/** Redact secrets in the persisted snapcompact archive's plaintext regions
	 *  ({@link snapcompact.archiveSourceText}'s `text`/`textHead`/`textTail`) so the
	 *  snapcompact→context-full migration in `compact()` cannot ship raw archived
	 *  user/tool text to the provider. Frames and every non-`snapcompact` key pass
	 *  through byte-identical; the same reference is returned when nothing changes. */
	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		const obfuscator = this.#obfuscator;
		if (!obfuscator?.hasSecrets() || !preserveData || !snapcompact.getPreservedArchive(preserveData)) {
			return preserveData;
		}
		const slot = preserveData[snapcompact.PRESERVE_KEY] as Record<string, unknown>;
		const obfuscated: Record<string, unknown> = { ...slot };
		let changed = false;
		for (const key of ["text", "textHead", "textTail"] as const) {
			const value = slot[key];
			if (typeof value !== "string" || value.length === 0) continue;
			const next = obfuscator.obfuscate(value);
			if (next === value) continue;
			obfuscated[key] = next;
			changed = true;
		}
		return changed ? { ...preserveData, [snapcompact.PRESERVE_KEY]: obfuscated } : preserveData;
	}

	#deobfuscateFromProvider(text: string): string {
		if (!this.#obfuscator?.hasSecrets()) return text;
		return this.#obfuscator.deobfuscate(text);
	}

	#deobfuscatedProviderTextReadyForDelta(text: string): string {
		const deobfuscated = this.#deobfuscateFromProvider(text);
		if (!this.#obfuscator?.hasSecrets()) return deobfuscated;
		const pendingPlaceholderStart = deobfuscated.match(/#[A-Z0-9]{0,4}$/);
		if (pendingPlaceholderStart?.index === undefined) return deobfuscated;
		return deobfuscated.slice(0, pendingPlaceholderStart.index);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		return this.#obfuscator?.hasSecrets() ? obfuscateMessages(this.#obfuscator, converted) : converted;
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContextForProvider(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	async #transformContextForProvider(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		const responseProjectedMessages = this.#responseDocuments.project(transformedMessages);
		if (!this.#contextSteadyIsActive(this.#estimateFullProviderInputTokens(responseProjectedMessages))) {
			return responseProjectedMessages;
		}
		if (!this.#contextSteadyPlanEnabled()) return responseProjectedMessages;
		// Re-gate every provider call (including tool-loop steps) against live tail growth.
		const plan = await this.#refreshContextSteadyPlanForProviderCall(responseProjectedMessages);
		if (plan) {
			// Materialize against the original transcript so Context Plan coverage
			// can still match branch message identity/content, then project any
			// surviving response documents at the final provider boundary.
			const plannedMessages = materializeContextPlanMessages(
				transformedMessages,
				this.sessionManager.getBranch(),
				plan,
			);
			return this.#responseDocuments.project(plannedMessages);
		}
		return responseProjectedMessages;
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		const sessionMetadata = this.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? this.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? this.settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: this.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
		// they share the same session bucket as Agent.prompt-routed requests on Anthropic
		// OAuth. Caller-provided metadata wins so explicit overrides are respected.
		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#activeProviderSessionId();
	}
	/** 共享 execution runtime（根创建或父采纳）；execution control 未接线时为 undefined。 */
	getExecutionRuntime(): ExecutionRuntime | undefined {
		return this.#executionRuntime;
	}
	/**
	 * 真实分支/会话切换后重同步 execution runtime。sync 必须发生在任何新分支
	 * replay（agent.replaceMessages 等）之前：runtime 依据传入的当前分支
	 * entries 重建 ledger/scheduler/registries。错误绝不吞掉——runtime 自身的
	 * CAS 规则拒绝过期/迟到状态，失败必须上抛以便调用方处理。固定 scope 的
	 * 子会话共享父 runtime，不得 syncBranch。
	 */
	async #syncExecutionBranch(): Promise<void> {
		if (!this.#executionRuntime || this.#executionScopeId !== undefined) return;
		await this.#executionRuntime.syncBranch(this.sessionManager.getBranch());
	}
	/**
	 * 真实宿主用户 turn 在首次 provider 派发前 mint 根 scope；同一 turn 内的
	 * continuation/steering/compaction/handoff/recovery 只复用当前 active
	 * scope，绝不新建。用户消息先持久化进 journal，其真实 entry id 同时作为
	 * logicalTurnId 与 host evidence ref（objectiveContract.authoritativeUserTurnId），
	 * 契约由 buildAuthoritativeUserObjectiveContract 从 entryId 稳定派生。
	 * synthetic/model 文本永远不能 mint scope；read-only 会话与固定 scope 的
	 * child 同样零 scope 写入。
	 */
	async #ensureExecutionScopeForTurn(message: AgentMessage): Promise<CustomMessage | undefined> {
		const runtime = this.#executionRuntime;
		if (!runtime || this.#executionScopeId !== undefined || !this.#sessionWritesEnabled) return undefined;
		// 非真实用户消息：只复用当前 active scope（存在时），绝不新建。
		if (message.role !== "user") {
			const activeScopeId = runtime.activeScopeId();
			if (activeScopeId !== undefined) {
				this.#executionHandle = runtime.getScope(activeScopeId);
			}
			return undefined;
		}
		// 每个新的顶层用户 prompt 都是独立 authoritative turn：即使上一 scope
		// 仍 active（evidence gate 未满足而保持运行），也不能因“已有 active”
		// 复用它——先持久化拿到真实 entryId，再 mint 新 scope。
		let entryId: string | undefined;
		if (this.#sessionMessageAlreadyPersisted(message)) {
			const key = sessionMessagePersistenceKey(message);
			const branch = this.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type !== "message") continue;
				if (sessionMessagePersistenceKey(entry.message) !== key) continue;
				if (sameMessageContent(entry.message, message)) {
					entryId = entry.id;
					break;
				}
			}
		} else {
			entryId = this.#appendSessionMessage(message);
		}
		if (entryId === undefined) return undefined;
		this.#executionHandle = runtime.startScope({
			rootSessionId: runtime.rootSessionId,
			logicalTurnId: entryId,
			objectiveContract: buildAuthoritativeUserObjectiveContract(entryId, message),
		});
		return this.#buildGeneralContractEcho(message);
	}

	/**
	 * 契约回显泛化(novice-first M3 延伸):会话首个权威用户 turn mint scope 时,
	 * 把工作契约作为可见消息回显一次。skill 证据链会话有自己的回显(带完成
	 * 标准),此处只覆盖无 skill 契约的普通会话;分支上已存在任一回显(含
	 * resume 的历史回显)则永不重复。
	 */
	#buildGeneralContractEcho(message: AgentMessage): CustomMessage | undefined {
		if (this.settings.get("san.contractEcho.firstTurn") !== true) return undefined;
		// 回显作为伴随消息进 agent 流后持久化为 custom_message entry;skill
		// 回显同理。任一载体存在都算"已回显",resume 的历史分支同样命中。
		const isEchoType = (type: string | undefined): boolean =>
			type === CONTRACT_ECHO_MESSAGE_TYPE || type === SKILL_CONTRACT_ECHO_MESSAGE_TYPE;
		const hasEcho = this.sessionManager.getBranch().some(entry => {
			if (entry.type === "custom_message" || entry.type === "custom") return isEchoType(entry.customType);
			return entry.type === "message" && entry.message.role === "custom" && isEchoType(entry.message.customType);
		});
		if (hasEcho) return undefined;
		const objective = message.role === "user" ? customMessageContentText(message.content).trim() : "";
		if (!objective) return undefined;
		const contractRef = this.#executionHandle?.snapshot().objectiveContract?.ref;
		const text = prompt
			.render(contractEchoGeneralTemplate, {
				objective: objective.length > 300 ? `${objective.slice(0, 300)}…` : objective,
			})
			.trim();
		return {
			role: "custom",
			customType: CONTRACT_ECHO_MESSAGE_TYPE,
			content: text,
			display: true,
			details: {
				contractId: contractRef?.contractId,
				contractHash: contractRef?.contractHash,
			},
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * 以 revision CAS 把 active scope 驱动到终态。仅 root（固定 scope 的 child
	 * 永不 finish）；每个 scope 恰好一次被接受的 finish——runtime 的终态守卫与
	 * 本会话的 one-shot 集合共同拒绝任何迟到 re-finish（如 host abort 之后才
	 * 到达的 provider 响应）。CAS 过期时以最新 revision 做单次权威重试；仍冲突
	 * 则上抛，绝不静默。`completed` 仅在 required host evidence gate 全部 pass
	 * 且带 host evidence 时才尝试；缺证据保持 scope 运行，永不转成用户可见失败。
	 */
	async #finishExecutionScope(
		state: "completed" | "aborted_by_user" | "budget_exhausted" | "runtime_fault" | "no_provider_available",
	): Promise<void> {
		const runtime = this.#executionRuntime;
		if (!runtime || this.#executionScopeId !== undefined) return;
		const scopeId = runtime.activeScopeId();
		if (scopeId === undefined || this.#finishedExecutionScopes.has(scopeId)) return;
		const handle = runtime.getScope(scopeId);
		if (!handle) return;
		if (state === "completed") {
			const snapshot = handle.snapshot();
			const requiredGates = snapshot.gates.filter(gate => gate.required !== false);
			const evidenceSatisfied =
				requiredGates.length > 0 &&
				requiredGates.every(gate => gate.status === "pass" && gate.evidenceRefs.length > 0);
			if (!evidenceSatisfied) return;
		}
		const finishOnce = (expectedRevision: number): ExecutionLedgerAppendResult =>
			runtime.finishScope(scopeId, { expectedRevision, state });
		let result: ExecutionLedgerAppendResult;
		try {
			result = finishOnce(handle.snapshot().revision);
		} catch (error) {
			if (!(error instanceof StaleExecutionRevisionError)) throw error;
			// 单次权威重试：以最新 revision 重新 CAS；仍过期则向上抛，绝不吞掉。
			const fresh = runtime.getScope(scopeId);
			if (!fresh) return;
			result = finishOnce(fresh.snapshot().revision);
		}
		if (result.accepted) {
			this.#finishedExecutionScopes.add(scopeId);
			if (this.#executionHandle?.scopeId === scopeId) this.#executionHandle = undefined;
		}
	}
	/** 从父会话继承的固定不可变 execution scope（子会话）。 */
	getExecutionScopeId(): string | undefined {
		return this.#executionScopeId;
	}
	getActiveExecutionScopeId(): string | undefined {
		return this.#executionScopeId ?? this.#executionRuntime?.activeScopeId();
	}
	/** 当前会话可派生任务时使用的 root 级 Task 准入注册表。 */
	getTaskContractRegistry(): TaskContractRegistry | undefined {
		return this.#taskContractRegistry;
	}
	getEvalSessionId(): string | null {
		if (this.#parentEvalSessionId !== undefined) return this.#parentEvalSessionId;
		return defaultEvalSessionId({
			cwd: this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	/** Prewalk state, if armed and active */
	getPrewalkState(): Prewalk | undefined {
		return this.#prewalk;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		} else {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			// Drop any unconsumed forced decision so a post-plan execution turn
			// does not inherit a stale `required` tool choice.
			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	getVibeModeState(): VibeModeState | undefined {
		return this.#vibeModeState;
	}

	setVibeModeState(state: VibeModeState | undefined): void {
		this.#vibeModeState = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	markPlanReferenceSent(): void {
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	getPlanReferencePath(): string {
		return this.#planReferencePath;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#acpPermissionDecisions.clear();
		const activeToolNames = this.getActiveToolNames();
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.agent.setTools(activeTools);
		const mountedTools = [...this.#mountedXdevToolNames]
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.#xdevRegistry?.reconcile(mountedTools);
	}

	#clearCheckpointRuntimeState(): void {
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
		this.#lastCompletedRewind = undefined;
		this.#rewoundToolResultIds.clear();
	}

	/**
	 * Rebuild checkpoint/rewind runtime state from the current branch. Handles two
	 * cases surfaced by session resume, `switchSession()` reloading the same file,
	 * and tree navigation:
	 *   - The branch's most recent checkpoint has already been rewound → restore
	 *     `#lastCompletedRewind` so a repeat `rewind` call receives the
	 *     "checkpoint already completed" recovery guidance.
	 *   - The branch's most recent checkpoint has NOT been rewound (e.g. the run
	 *     was aborted between `checkpoint` and `rewind`) → restore
	 *     `#checkpointState` so the next `rewind` call can complete the
	 *     checkpoint instead of failing with "No active checkpoint".
	 */
	#rehydrateCheckpointRewindState(): void {
		this.#clearCheckpointRuntimeState();
		let completed: CompletedRewindState | undefined;
		let pending: { entryId: string; startedAt: string; messageCount: number } | undefined;
		let messageCount = 0;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message") messageCount++;
			if (isSuccessfulCheckpointEntry(entry)) {
				completed = undefined;
				pending = {
					entryId: entry.id,
					startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
					messageCount,
				};
				continue;
			}
			const completedFromEntry = completedRewindFromEntry(entry);
			if (completedFromEntry) {
				completed = completedFromEntry;
				pending = undefined;
			}
		}
		if (pending) {
			this.#checkpointState = {
				checkpointEntryId: pending.entryId,
				startedAt: pending.startedAt,
				checkpointMessageCount: pending.messageCount,
			};
			return;
		}
		this.#lastCompletedRewind = completed;
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	/**
	 * Context-steady 自助召回(`context_expand` 工具的会话侧能力):按 digest
	 * entry id 把其 source 区间从当前分支 journal 解压为有界文本。仅根会话
	 * 且 context steady 开启时提供;固定 scope 的子会话读的是父的历史,不提供。
	 */
	expandContextDigest(digestEntryId: string): ContextExpandResult | undefined {
		if (this.settings.get("san.contextSteady.enabled") !== true) return undefined;
		if (this.#executionScopeId !== undefined) return undefined;
		return expandDigestSpan(this.sessionManager.getBranch(), digestEntryId);
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#lastCompletedRewind;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (state) {
			this.#lastCompletedRewind = undefined;
		} else {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildVibeModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	/**
	 * Resolve the explicit thinking suffix that should apply when a temporary
	 * picker selects a model already assigned to a configured role.
	 */
	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.settings);
		for (const role of getKnownRoleIds(this.settings)) {
			const roleValue = this.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
		try {
			await fs.promises.access(resolvedPlanPath, fs.constants.R_OK);
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
		});

		this.#planReferenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			isHashlineEditMode: this.#resolveActiveEditMode() === "hashline",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		const todoContext = this.#buildGoalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalModeContextPrompt, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildVibeModeMessage(): CustomMessage | null {
		if (!this.#vibeModeState?.enabled) return null;
		return {
			role: "custom",
			customType: "vibe-mode-context",
			content: prompt.render(vibeModeActivePrompt),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#sanitizeGoalTodoText(text: string): string {
		return escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	}

	#buildGoalTodoContext(): string | undefined {
		if (!this.settings.get("todo.enabled")) return undefined;
		const canCallTodoTool = this.getActiveToolNames().includes("todo");
		if (!canCallTodoTool) return undefined;
		const phases = this.getTodoPhases().filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return undefined;

		let total = 0;
		let closed = 0;
		let open = 0;
		const promptPhases = phases.map(phase => ({
			name: this.#sanitizeGoalTodoText(phase.name),
			tasks: phase.tasks.map(task => {
				total++;
				if (task.status === "completed" || task.status === "abandoned") {
					closed++;
				} else {
					open++;
				}
				return { content: this.#sanitizeGoalTodoText(task.content), status: task.status };
			}),
		}));

		return prompt.render(goalTodoContextPrompt, {
			canCallTodoTool,
			closed: String(closed),
			open: String(open),
			phases: promptPhases,
			total: String(total),
		});
	}

	#normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.model });
	}

	/**
	 * Build a hidden companion message describing image attachments for a text-only
	 * model. Each image is saved under local:// and a vision-capable model describes
	 * it; the descriptions are returned as a `display: false` custom message (so the
	 * model reads them but the TUI does not render the blob) carrying one
	 * `<image path="local://…">…</image>` block per image. Returns `undefined` when
	 * the active model already accepts images, the feature is disabled, or no
	 * description could be produced. Never throws.
	 */
	async #buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.model;
		const shouldDescribe =
			!!model &&
			!model.input.includes("image") &&
			!this.settings.get("images.blockImages") &&
			this.settings.get("images.describeForTextModels");
		if (!shouldDescribe || !model) {
			return undefined;
		}
		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#modelRegistry,
					settings: this.settings,
					localProtocolOptions: this.#localProtocolOptions(),
					activeModelString: formatModelString(model),
					telemetryConfig: this.agent.telemetry,
					sessionId: this.sessionId,
				},
				signal,
			);
		} catch (err) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
		if (blocks.length === 0) {
			return undefined;
		}
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	async #normalizeMessageContentImages(
		content: string | (TextContent | ImageContent)[],
	): Promise<string | (TextContent | ImageContent)[]> {
		if (typeof content === "string") return content;
		const images = content.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return content;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		if (!normalizedImages) return content;
		let imageIndex = 0;
		return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
	}

	async #normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) return message;
		const normalized = await this.#normalizeMessageContentImages(content as string | (TextContent | ImageContent)[]);
		if (normalized === content) return message;
		return { ...message, content: normalized } as T;
	}

	#magicKeywordEnabled(keyword: "orchestrate" | "ultrathink" | "workflow"): boolean {
		return this.settings.get("magicKeywords.enabled") && this.settings.get(`magicKeywords.${keyword}`);
	}

	#createMagicKeywordNotices(text: string): CustomMessage[] {
		const timestamp = Date.now();
		const turnBudget = parseTurnBudget(text);
		this.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
		const keywordNotices: CustomMessage[] = [];
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "ultrathink-notice",
				content: ULTRATHINK_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("orchestrate") && containsOrchestrate(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "orchestrate-notice",
				content: ORCHESTRATE_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (
			this.#magicKeywordEnabled("workflow") &&
			containsWorkflow(text) &&
			this.getActiveToolNames().includes("task")
		) {
			keywordNotices.push({
				role: "custom",
				customType: "workflow-notice",
				content: renderWorkflowNotice({ taskBatch: this.settings.get("task.batch") }),
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		return keywordNotices;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// Magic keywords ("ultrathink", "orchestrate"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (options?.userInitiated ?? !options?.synthetic) {
			this.#resetToolLoopGuardsForUserInput();
			this.#advisorAutoResumeSuppressed = false;
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			// A user turn owns the next decision; drop a queued forced choice from
			// a reminder continuation this prompt just preempted.
			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			// Steer/follow-up the keyword notices BEFORE the queued user message so the
			// model reads the steering notice ahead of the prompt it modifies.
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTaskPrelude(expandedText) : undefined;
		const normalizedImages = await this.#normalizeImagesForModel(options?.images);

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			userContent.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and inject the
		// description as a hidden companion (the image stays in the visible user message).
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}
		if (eagerTaskPrelude) {
			preludeMessages.push(eagerTaskPrelude);
		}
		const sanLoopPrelude = options?.synthetic ? undefined : this.#buildSanLoopCommanderPrelude();
		this.#contextSteadyGlobalInjectionAllowed = true;
		const brainPolicy = resolveSanBrainRuntimePolicy(this.settings);
		const brainActivationEnabled = !options?.synthetic && brainPolicy.activationEnabled;
		if (!options?.synthetic && brainPolicy.projectionEnabled) {
			await this.#runPendingSanBrainProjections();
		}
		const brainPrelude = brainActivationEnabled ? await this.#buildBrainStatePrelude(expandedText) : undefined;
		if (brainActivationEnabled) {
			const brainStateMessage: CustomMessage | undefined = brainPrelude?.content
				? {
						role: "custom",
						customType: BRAIN_STATE_MESSAGE_TYPE,
						content: brainPrelude.content,
						display: false,
						details: {
							activationId: brainPrelude.activation.activationId,
							selectedRuleIds: brainPrelude.activation.selectedRules.map(rule => rule.ownerId),
							renderedHash: brainPrelude.activation.renderedHash,
						},
						attribution: "agent",
						timestamp: Date.now(),
					}
				: undefined;
			const injectionCandidates: SanBrainInjectionCandidate[] = [];
			if (sanLoopPrelude && typeof sanLoopPrelude.content === "string") {
				injectionCandidates.push({ source: "san_loop", content: sanLoopPrelude.content });
			}
			if (brainStateMessage && typeof brainStateMessage.content === "string") {
				injectionCandidates.push({ source: "brain", content: brainStateMessage.content });
			}
			const contextSteadyActive = this.#contextSteadyIsActive(
				this.#estimateStoredContextTokens([...this.messages, message]),
			);
			const contextPlanReservedTokens =
				contextSteadyActive && this.#contextSteadyPlanEnabled() ? this.#contextSteadyPlanMaxTokens() : 0;
			if (contextPlanReservedTokens > 0) {
				injectionCandidates.push({ source: "context_packet", tokenEstimate: contextPlanReservedTokens });
			}
			const injectionPlan = planSanBrainGlobalInjection(
				injectionCandidates,
				this.settings.get("san.brain.activation.globalMaxTokens") as number,
			);
			this.#contextSteadyGlobalInjectionAllowed =
				contextPlanReservedTokens === 0 || injectionPlan.includedSources.includes("context_packet");
			for (const source of injectionPlan.includedSources) {
				if (source === "san_loop" && sanLoopPrelude) preludeMessages.push(sanLoopPrelude);
				if (source === "brain" && brainStateMessage) preludeMessages.push(brainStateMessage);
			}
			if (brainPrelude) {
				const activation = finalizeSanBrainActivation(brainPrelude.activation, injectionPlan);
				try {
					appendSanBrainActivation(this.sessionManager, activation);
				} catch (error) {
					logger.warn("Failed to persist San Brain activation audit", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: this.sessionId,
						activationId: activation.activationId,
					});
				}
			}
		} else {
			if (sanLoopPrelude) preludeMessages.push(sanLoopPrelude);
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice
						? [...preludeMessages, ...keywordNotices, ...(imageDescriptionNotice ? [imageDescriptionNotice] : [])]
						: undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		return true;
	}

	/**
	 * Stable epoch for a request/rebase boundary. Does not include the current leaf —
	 * leaf churn every turn would create a new epoch each prompt and break cache stability.
	 */
	#contextSteadyEpochId(reason?: ContextCheckpointRebaseReason): string {
		const rebase = this.#contextSteadyLastRebaseCheckpointEntryId ?? "base";
		const reasonTag = reason ?? "steady";
		return `epoch_${this.sessionId}_${reasonTag}_${rebase}`.slice(0, 140);
	}

	#contextSteadyActivePlan(): BuiltContextPlan | undefined {
		const plan = this.#contextSteadyRequestPlan ?? this.#contextSteadyLastPlan;
		return plan && !this.#contextSteadyPlanInputsChanged(plan) ? plan : undefined;
	}

	/**
	 * 只把最新 compaction 后仍会出现在 provider working set 中的 journal
	 * 区间交给 ContextPlan。更早的 entry 继续留在 journal 供审计和回放，
	 * 但不再参与 protected token 或 hard-pressure 计算。
	 */
	#contextSteadyActivePlanningEntries(branchEntries: readonly SessionEntry[]): {
		entries: SessionEntry[];
		activeCutoffEntryId?: string;
		archivedEntryCount: number;
	} {
		const latestCompaction = getLatestCompactionEntry([...branchEntries]);
		if (!latestCompaction) return { entries: [...branchEntries], archivedEntryCount: 0 };
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		const firstKeptIndex = branchEntries.findIndex(entry => entry.id === latestCompaction.firstKeptEntryId);
		const activeStart = firstKeptIndex >= 0 && firstKeptIndex < compactionIndex ? firstKeptIndex : compactionIndex;
		const entries = branchEntries.slice(Math.max(0, activeStart));
		return {
			entries,
			...(entries[0] ? { activeCutoffEntryId: entries[0].id } : {}),
			archivedEntryCount: Math.max(0, activeStart),
		};
	}

	#appendContextSteadyMaintenanceAudit(
		state: ContextMaintenanceAudit["state"],
		plan: BuiltContextPlan,
		phase: ContextMaintenanceAudit["phase"],
		detail?: string,
		failureStage?: ContextMaintenanceAudit["failureStage"],
	): void {
		const gate = plan.audit.qualityGate;
		const maintenanceId = this.#contextSteadyMaintenanceId ?? `maintenance_${crypto.randomUUID().slice(-12)}`;
		this.#contextSteadyMaintenanceId = maintenanceId;
		const audit: ContextMaintenanceAudit = {
			schemaVersion: CONTEXT_MAINTENANCE_SCHEMA_VERSION,
			maintenanceId,
			sessionId: this.sessionId,
			createdAt: new Date().toISOString(),
			promptGeneration: this.#promptGeneration,
			state,
			reason: "hard_pressure",
			phase,
			recoveryAttempt: this.#contextSteadyRecoveryAttempt,
			...(gate.projectedInputTokens === undefined ? {} : { projectedInputTokens: gate.projectedInputTokens }),
			requiredTokens: gate.requiredTokens,
			activeEntryCount: gate.activeEntryCount,
			archivedEntryCount: gate.archivedEntryCount,
			...(detail ? { detail } : {}),
			...(failureStage ? { failureStage } : {}),
		};
		this.sessionManager.appendCustomEntry(CONTEXT_MAINTENANCE_CUSTOM_TYPE, audit);
	}

	#pauseForContextSteadyPressure(
		plan: BuiltContextPlan,
		phase: ContextMaintenanceAudit["phase"],
		detail: string,
		failureStage?: ContextMaintenanceAudit["failureStage"],
	): void {
		this.#appendContextSteadyMaintenanceAudit("paused_for_context", plan, phase, detail, failureStage);
		this.emitNotice(
			"warning",
			`Context maintenance paused this run after recovery could not fit the provider request. ${detail}`,
			"context-steady",
		);
	}

	#contextSteadyPlanInputsChanged(plan: BuiltContextPlan): boolean {
		const sourceEntryIds = new Set(plan.sourceIndex.entryIds);
		const latestCompaction = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (latestCompaction && !sourceEntryIds.has(latestCompaction.id)) return true;
		if (plan.audit.budget.contextWindow !== (this.model?.contextWindow ?? 0)) return true;
		return plan.audit.budget.nonMessageTokens !== computeNonMessageTokens(this);
	}

	/**
	 * Semantic required set: recent exact turns + a bounded window of still-open
	 * risks/questions (not every historical file touch). File evidence alone never
	 * permanently freezes raw spans — that would make 12–20 turn history unbounded.
	 */
	#contextSteadySemanticRequiredEntryRefs(
		entries: readonly SessionEntry[],
		excludeRefs: ReadonlySet<string>,
		tokenEstimateByEntryRef: ReadonlyMap<string, number>,
	): string[] {
		const tokenBudget = Math.max(
			0,
			Math.floor(this.settings.get("san.contextSteady.contextPlan.recentExactTokens") as number),
		);
		return this.#contextSteadyRecentExactEntryRefs(entries, excludeRefs, tokenBudget, tokenEstimateByEntryRef);
	}

	#contextSteadyIsActive(observedInputTokens?: number): boolean {
		if (this.settings.get("san.contextSteady.enabled") !== true) return false;
		if (this.#contextSteadyActivatedSessionId === this.sessionId) return true;

		let persistedActivation = false;
		if (this.#contextSteadyActivationScannedSessionId !== this.sessionId) {
			for (const entry of this.sessionManager.getBranch()) {
				if (entry.type !== "custom") continue;
				switch (entry.customType) {
					case CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE:
					case CONTEXT_PLAN_CUSTOM_TYPE:
					case TURN_DIGEST_CUSTOM_TYPE:
					case CONTEXT_CHECKPOINT_CUSTOM_TYPE:
					case CONTEXT_SEGMENT_CUSTOM_TYPE:
					case CONTEXT_MAINTENANCE_CUSTOM_TYPE:
						persistedActivation = true;
						break;
				}
				if (persistedActivation) break;
			}
			this.#contextSteadyActivationScannedSessionId = this.sessionId;
		}

		const configuredThreshold = this.settings.get("san.contextSteady.activationThresholdTokens") as number;
		const activationThresholdTokens = Number.isFinite(configuredThreshold)
			? Math.max(0, Math.floor(configuredThreshold))
			: 240_000;
		const inputTokens = observedInputTokens ?? (persistedActivation ? 0 : this.#estimateStoredContextTokens());
		if (!persistedActivation && activationThresholdTokens > 0 && inputTokens < activationThresholdTokens) {
			return false;
		}

		if (!persistedActivation && activationThresholdTokens > 0) {
			const activation: ContextSteadyActivation = {
				schemaVersion: CONTEXT_STEADY_ACTIVATION_SCHEMA_VERSION,
				activationThresholdTokens,
				observedInputTokens: inputTokens,
			};
			this.sessionManager.appendCustomEntry(CONTEXT_STEADY_ACTIVATION_CUSTOM_TYPE, activation);
		}
		this.#contextSteadyActivatedSessionId = this.sessionId;
		logger.debug("Context Steady activated for session", {
			sessionId: this.sessionId,
			source: persistedActivation ? "persisted" : activationThresholdTokens === 0 ? "immediate" : "threshold",
			inputTokens,
			activationThresholdTokens,
		});
		return true;
	}

	/**
	 * Rendered ContextPlans include their projected-input audit, so that audit can
	 * change the final wire size. Rebuild until the recorded projection equals
	 * the final wire estimate; fail closed if it cannot settle promptly.
	 */
	#buildContextSteadyPlanForProvider(
		commonOptions: Omit<BuildContextPlanOptions, "projectedInputTokens">,
		messages: readonly AgentMessage[],
		planningEntries: readonly SessionEntry[],
		mode: "pending" | "full" = "pending",
	): BuiltContextPlan {
		let plan = buildContextPlan(commonOptions);
		let projectedInputTokens = this.#estimateMaterializedProjectedInputTokens(messages, planningEntries, plan, mode);
		for (let attempt = 0; attempt < 4; attempt++) {
			plan = buildContextPlan({ ...commonOptions, projectedInputTokens });
			const finalProjection = this.#estimateMaterializedProjectedInputTokens(messages, planningEntries, plan, mode);
			if (finalProjection === projectedInputTokens) return plan;
			projectedInputTokens = finalProjection;
		}
		return buildContextPlan({ ...commonOptions, projectedInputTokens: Number.MAX_SAFE_INTEGER });
	}

	async #buildContextSteadyRequestPlan(
		messages: readonly AgentMessage[],
		expandedText: string,
		options?: { persistAudit?: boolean; throwOnHardPressure?: boolean; liveTailOnly?: boolean },
	): Promise<BuiltContextPlan | undefined> {
		if (!this.#contextSteadyIsActive(this.#estimateStoredContextTokens(messages))) return undefined;
		if (!this.#contextSteadyPlanEnabled()) return undefined;
		if (!this.#contextSteadyGlobalInjectionAllowed) return undefined;
		const persistAudit = options?.persistAudit !== false;
		const throwOnHardPressure = options?.throwOnHardPressure !== false;
		const recall = options?.liveTailOnly ? undefined : await this.#buildContextSteadyRecallLayer(expandedText);
		const branchEntries = this.sessionManager.getBranch();
		const activeScope = this.#contextSteadyActivePlanningEntries(branchEntries);
		const rebaseBoundary = this.#contextSteadyRebaseBoundary(activeScope.entries);
		// Prefer real journal ids when the prompt messages are already persisted;
		// otherwise synthesize pending_* ids and rewrite after append (see remap).
		const pendingEntries = this.#contextSteadyPendingEntries(messages);
		const planningEntries = this.#contextSteadyMergePlanningEntries(activeScope.entries, pendingEntries);
		const currentPromptEntryRefs = this.#contextSteadyCurrentPromptEntryRefs(planningEntries, messages);
		const tokenEstimateByEntryRef = this.#contextSteadyTokenEstimateByEntryRef(planningEntries);
		const liveTailEntryRefs = this.#contextSteadyCollectLiveTailEntryRefs(
			planningEntries,
			currentPromptEntryRefs,
			tokenEstimateByEntryRef,
		);
		const topicShift = expandedText.trim().length > 0 && isTopicShiftPrompt(expandedText);
		// Pending semantic reasons outrank a stale checkpoint boundary so resume /
		// topic_shift / budget_pressure remain auditable after checkpoints exist.
		const pendingReason: ContextCheckpointRebaseReason | undefined = this.#contextSteadyPendingResumeRebase
			? "resume"
			: this.#contextSteadyPendingBudgetPressureRebase
				? "budget_pressure"
				: topicShift
					? "topic_shift"
					: undefined;
		const resolvedRebaseReason = pendingReason ?? rebaseBoundary?.reason;
		const commonOptions = {
			entries: planningEntries,
			sessionId: this.sessionId,
			requestKey: `${this.#promptGeneration}:${this.sessionManager.getLeafId() ?? "root"}:${liveTailEntryRefs.join(",")}`,
			epochId: this.#contextSteadyEpochId(resolvedRebaseReason),
			promptGeneration: this.#promptGeneration,
			rebaseReason: resolvedRebaseReason,
			settings: {
				qualityWindowTokens: this.settings.get("san.contextSteady.qualityWindowTokens") as number,
				reserveRatio: this.settings.get("san.contextSteady.reserveRatio") as number,
				planMaxTokens: this.#contextSteadyPlanMaxTokens(),
				burstWindowTokens: this.#contextSteadyBurstWindowTokens(),
			},
			contextWindow: this.model?.contextWindow ?? 0,
			nonMessageTokens: computeNonMessageTokens(this),
			recall,
			maxDigestMaterials: this.#contextSteadyRecentDigests(),
			baseRequiredEntryRefs: this.#contextSteadySemanticRequiredEntryRefs(
				planningEntries,
				new Set(currentPromptEntryRefs),
				tokenEstimateByEntryRef,
			),
			currentPromptEntryRefs,
			liveTailEntryRefs,
			tokenEstimateByEntryRef,
			currentPromptText: expandedText,
			activeToolCallIds: this.#contextSteadyActiveToolCallIds(planningEntries),
			activeEntryCount: planningEntries.length,
			archivedEntryCount: activeScope.archivedEntryCount,
			activeCutoffEntryId: activeScope.activeCutoffEntryId,
			maintenanceId: this.#contextSteadyMaintenanceId,
			recoveryAttempt: this.#contextSteadyRecoveryAttempt,
		};
		const plan = this.#buildContextSteadyPlanForProvider(commonOptions, messages, planningEntries);
		if (plan.audit.qualityGate.outcome === "hard_pressure") {
			this.#contextSteadyPendingBudgetPressureRebase = true;
			// Persist the refused prompt + audit, and sync active agent context so the
			// same-session follow-up can still see the refused task.
			if (persistAudit) {
				for (const message of messages) {
					if (message.role !== "user" && message.role !== "developer" && message.role !== "fileMention") {
						continue;
					}
					if (this.#sessionMessageAlreadyPersisted(message)) continue;
					this.#appendSessionMessage(message);
					// Keep journal and live agent state aligned for same-session recovery.
					if (!this.messages.includes(message as AgentMessage)) {
						this.agent.appendMessage(message as AgentMessage);
					}
				}
				// Rebuild protected refs against real journal ids when possible.
				const remapped = this.#remapContextSteadyPlanPendingRefs(plan);
				this.sessionManager.appendCustomEntry(CONTEXT_PLAN_CUSTOM_TYPE, remapped.audit);
				this.#contextSteadyLastPlan = remapped;
				if (throwOnHardPressure) {
					this.#pauseForContextSteadyPressure(
						remapped,
						"pre_turn",
						`Projected input remains above the burst ceiling (${remapped.audit.qualityGate.reasons.join(", ") || "unknown"}).`,
					);
					throw new Error(
						`San ContextPlan hard pressure: projected input exceeds burst ceiling (${remapped.audit.qualityGate.reasons.join(", ") || "unknown"}).`,
					);
				}
				return remapped;
			}
			this.#contextSteadyLastPlan = plan;
			if (throwOnHardPressure) {
				throw new Error(
					`San ContextPlan hard pressure: projected input exceeds burst ceiling (${plan.audit.qualityGate.reasons.join(", ") || "unknown"}).`,
				);
			}
			return plan;
		}
		if (rebaseBoundary) this.#applyContextSteadySafeRebase(rebaseBoundary);
		else if (pendingReason === "topic_shift" || pendingReason === "resume" || pendingReason === "budget_pressure") {
			// Safe rebase without a new checkpoint: rotate provider session for semantic boundary.
			this.#closeAllProviderSessions(`context steady ${pendingReason} rebase`);
			this.#freshProviderSessionId = Bun.randomUUIDv7();
			this.#syncAgentSessionId();
			this.agent.appendOnlyContext?.invalidateForModelChange();
		}
		if (pendingReason === "resume") this.#contextSteadyPendingResumeRebase = false;
		if (pendingReason === "budget_pressure") this.#contextSteadyPendingBudgetPressureRebase = false;
		if (plan.audit.materials.length === 0 && plan.audit.coverage.length === 0 && messages.length === 0) {
			return undefined;
		}
		// Defer audit persistence until after journal append + pending-ref remap so
		// /context plan joins real entry ids and TurnDigest spans stay clean.
		// Hard-pressure path above already persists immediately.
		void persistAudit;
		return plan;
	}

	/**
	 * Hard pressure at a user boundary gets one safe recovery pass before the
	 * request is refused. A larger model may restore the input budget; otherwise
	 * configured context maintenance rewrites settled history and the plan is
	 * rebuilt against that new active context. The final build retains the normal
	 * fail-closed audit + prompt persistence when neither recovery makes room.
	 */
	async #buildContextSteadyRequestPlanWithRecovery(
		messages: readonly AgentMessage[],
		expandedText: string,
	): Promise<BuiltContextPlan | undefined> {
		let plan = await this.#buildContextSteadyRequestPlan(messages, expandedText, {
			persistAudit: false,
			throwOnHardPressure: false,
		});
		if (plan?.audit.qualityGate.outcome !== "hard_pressure") return plan;

		if (await this.#promoteContextModel()) {
			plan = await this.#buildContextSteadyRequestPlan(messages, expandedText, {
				persistAudit: false,
				throwOnHardPressure: false,
			});
			if (plan?.audit.qualityGate.outcome !== "hard_pressure") return plan;
		}

		const maxRecoveryPasses = Math.max(
			0,
			Math.floor(this.settings.get("san.contextSteady.hardPressure.maxRecoveryPasses") as number),
		);
		this.#contextSteadyMaintenanceId = `maintenance_${crypto.randomUUID().slice(-12)}`;
		let recoveryFailureStage: ContextMaintenanceAudit["failureStage"];
		let recoveryFailureDetail: string | undefined =
			maxRecoveryPasses === 0 ? "Hard-pressure recovery is disabled by configuration." : undefined;
		try {
			for (let attempt = 1; attempt <= maxRecoveryPasses; attempt++) {
				this.#contextSteadyRecoveryAttempt = attempt;
				this.#appendContextSteadyMaintenanceAudit("maintenance", plan, "pre_turn");
				const recovery = await this.#runAutoCompaction("threshold", false, false, false, {
					autoContinue: false,
					triggerContextTokens: plan.audit.qualityGate.projectedInputTokens,
					trigger: "hard_pressure",
					matchedTriggers: ["hard_pressure"],
					suppressContinuation: true,
					phase: "pre_turn",
				});
				recoveryFailureStage = recovery.failureStage;
				recoveryFailureDetail = recovery.failureReason;
				plan = await this.#buildContextSteadyRequestPlan(messages, expandedText, {
					persistAudit: false,
					throwOnHardPressure: false,
				});
				if (plan?.audit.qualityGate.outcome !== "hard_pressure") {
					if (plan) this.#appendContextSteadyMaintenanceAudit("recovered", plan, "pre_turn");
					return plan;
				}
			}

			// 最终构建保留正常的审计、拒绝提示和显式 paused_for_context 状态。
			const refused = await this.#buildContextSteadyRequestPlan(messages, expandedText, {
				persistAudit: true,
				throwOnHardPressure: false,
			});
			if (!refused) return refused;
			const pressureDetail = `Projected input remains above the burst ceiling (${refused.audit.qualityGate.reasons.join(", ") || "unknown"}).`;
			const detail = recoveryFailureDetail
				? `${pressureDetail} Recovery stopped: ${recoveryFailureDetail}`
				: pressureDetail;
			this.#pauseForContextSteadyPressure(refused, "pre_turn", detail, recoveryFailureStage);
			throw new Error(
				`San ContextPlan hard pressure: projected input exceeds burst ceiling (${refused.audit.qualityGate.reasons.join(", ") || "unknown"}).`,
			);
		} finally {
			this.#contextSteadyMaintenanceId = undefined;
			this.#contextSteadyRecoveryAttempt = 0;
		}
	}

	/**
	 * Tool-loop re-gate: rebuild plan from current branch + live messages when
	 * projected full input would cross control/burst bands or the plan's inputs
	 * changed. Freezes old-history selection from the request-start plan only
	 * while the source history and non-message context are unchanged.
	 */
	async #refreshContextSteadyPlanForProviderCall(
		messages: readonly AgentMessage[],
	): Promise<BuiltContextPlan | undefined> {
		const existing = this.#contextSteadyRequestPlan;
		if (!existing) return undefined;
		const branchEntries = this.sessionManager.getBranch();
		const activeScope = this.#contextSteadyActivePlanningEntries(branchEntries);
		// Tool-loop: `messages` is already the full transformed provider context.
		const projected = this.#estimateMaterializedProjectedInputTokens(messages, branchEntries, existing, "full");
		const controlMax = existing.audit.budget.controlMax;
		const nonMessageTokens = computeNonMessageTokens(this);
		if (!this.#contextSteadyPlanInputsChanged(existing) && projected <= controlMax) {
			// 同一逻辑 turn 内冻结 ContextPlan 字节。每次工具调用都重写投影值会让
			// plan 之后的整条 turn 前缀失效，实际会把 provider cache read 压到仅剩
			// system/tools。实时 projected 只用于门控；跨过 controlMax 时才重建。
			return existing;
		}
		// Crossed control band, or a model/history/non-message input changed: rebuild
		// with the live tail for an accurate gate and material selection.
		const liveText = this.#contextSteadyLatestUserText(messages) ?? "";
		// Synchronous rebuild path (no recall) so transformContext stays non-async beyond current await.
		const pendingEntries = this.#contextSteadyPendingEntries(
			messages.filter(message => {
				if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return false;
				return !branchEntries.some(entry => entry.type === "message" && entry.message === message);
			}),
		);
		const planningEntries = this.#contextSteadyMergePlanningEntries(activeScope.entries, pendingEntries);
		const currentPromptEntryRefs = this.#contextSteadyCurrentPromptEntryRefs(planningEntries, messages);
		const tokenEstimateByEntryRef = this.#contextSteadyTokenEstimateByEntryRef(planningEntries);
		const liveTailEntryRefs = this.#contextSteadyCollectLiveTailEntryRefs(
			planningEntries,
			currentPromptEntryRefs,
			tokenEstimateByEntryRef,
		);
		const commonOptions = {
			entries: planningEntries,
			sessionId: this.sessionId,
			requestKey: `${this.#promptGeneration}:live:${this.sessionManager.getLeafId() ?? "root"}:${liveTailEntryRefs.length}`,
			epochId: existing.audit.epochId,
			promptGeneration: this.#promptGeneration,
			settings: {
				qualityWindowTokens: this.settings.get("san.contextSteady.qualityWindowTokens") as number,
				reserveRatio: this.settings.get("san.contextSteady.reserveRatio") as number,
				planMaxTokens: this.#contextSteadyPlanMaxTokens(),
				burstWindowTokens: this.#contextSteadyBurstWindowTokens(),
			},
			contextWindow: this.model?.contextWindow ?? 0,
			nonMessageTokens,
			maxDigestMaterials: this.#contextSteadyRecentDigests(),
			baseRequiredEntryRefs: this.#contextSteadySemanticRequiredEntryRefs(
				planningEntries,
				new Set(currentPromptEntryRefs),
				tokenEstimateByEntryRef,
			),
			currentPromptEntryRefs,
			liveTailEntryRefs,
			tokenEstimateByEntryRef,
			currentPromptText: liveText,
			activeToolCallIds: this.#contextSteadyActiveToolCallIds(planningEntries),
			activeEntryCount: planningEntries.length,
			archivedEntryCount: activeScope.archivedEntryCount,
			activeCutoffEntryId: activeScope.activeCutoffEntryId,
			maintenanceId: this.#contextSteadyMaintenanceId,
			recoveryAttempt: this.#contextSteadyRecoveryAttempt,
		};
		const plan = this.#buildContextSteadyPlanForProvider(commonOptions, messages, planningEntries, "full");
		this.#contextSteadyRequestPlan = plan;
		this.#contextSteadyLastPlan = plan;
		if (plan.audit.qualityGate.outcome === "hard_pressure") {
			let recoveryFailureStage: ContextMaintenanceAudit["failureStage"];
			let recoveryFailureReason: string | undefined;
			// Attempt one bounded recovery (auto-compaction) before pausing. This
			// covers the case where a model window shrink collapses the budget and
			// the current input slightly exceeds the new ceiling — compaction can
			// reclaim enough to continue the tool-loop without user intervention.
			if (this.#contextSteadyRecoveryAttempt === 0) {
				this.#contextSteadyRecoveryAttempt++;
				const recovered = await this.#attemptToolLoopBudgetRecovery(messages, commonOptions);
				if (recovered.plan) return recovered.plan;
				recoveryFailureStage = recovered.failureStage;
				recoveryFailureReason = recovered.failureReason;
			}
			// Only tool-loop hard pressure appends an extra audit (refusal evidence).
			this.sessionManager.appendCustomEntry(CONTEXT_PLAN_CUSTOM_TYPE, plan.audit);
			const pressureDetail = `Tool-loop input remains above the burst ceiling (${plan.audit.qualityGate.reasons.join(", ") || "tool_loop_overflow"}).`;
			const detail = recoveryFailureReason
				? `${pressureDetail} Recovery stopped: ${recoveryFailureReason}`
				: pressureDetail;
			this.#pauseForContextSteadyPressure(plan, "mid_turn", detail, recoveryFailureStage);
			throw new Error(
				`San ContextPlan hard pressure: projected input exceeds burst ceiling (${plan.audit.qualityGate.reasons.join(", ") || "tool_loop_overflow"}).`,
			);
		}
		// Soft rebuild under control→burst: keep request-start audit as source of truth;
		// only replace in-memory plan for materialize/status.
		return plan;
	}

	/**
	 * 工具循环 hard_pressure 的单次有界恢复：自动压缩后重建 ContextPlan。
	 * 恢复成功时返回 plan，否则返回维护阶段产生的失败诊断。
	 */
	async #attemptToolLoopBudgetRecovery(
		messages: readonly AgentMessage[],
		commonOptions: Omit<BuildContextPlanOptions, "projectedInputTokens">,
	): Promise<ToolLoopBudgetRecoveryResult> {
		logger.debug("Context Steady tool-loop budget recovery: attempting auto-compaction", {
			recoveryAttempt: this.#contextSteadyRecoveryAttempt,
			contextWindow: this.model?.contextWindow,
		});
		const compactionBefore = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
		const recovery = await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			suppressContinuation: true,
			suppressHandoff: true,
			trigger: "hard_pressure",
			matchedTriggers: ["hard_pressure"],
			phase: "mid_turn",
		});
		const compactionAfter = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
		if (compactionAfter === compactionBefore) {
			// Compaction did not commit; no point rebuilding.
			return {
				failureStage: recovery.failureStage,
				failureReason: recovery.failureReason,
			};
		}
		// Rebuild the plan against the post-compaction state.
		const rebuiltPlan = this.#buildContextSteadyPlanForProvider(
			commonOptions,
			messages,
			commonOptions.entries,
			"full",
		);
		if (rebuiltPlan.audit.qualityGate.outcome === "hard_pressure") {
			return {};
		}
		this.#contextSteadyRequestPlan = rebuiltPlan;
		this.#contextSteadyLastPlan = rebuiltPlan;
		logger.debug("Context Steady tool-loop budget recovery: compaction resolved pressure", {
			recoveryAttempt: this.#contextSteadyRecoveryAttempt,
			outcome: rebuiltPlan.audit.qualityGate.outcome,
		});
		return { plan: rebuiltPlan };
	}

	#contextSteadyLatestUserText(messages: readonly AgentMessage[]): string | undefined {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "user") continue;
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) {
				const text = message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map(block => block.text)
					.join("\n");
				if (text) return text;
			}
		}
		return undefined;
	}

	#contextSteadyMergePlanningEntries(
		branchEntries: readonly SessionEntry[],
		pendingEntries: readonly SessionEntry[],
	): SessionEntry[] {
		const knownIds = new Set(branchEntries.map(entry => entry.id));
		const knownMessages = new WeakSet<AgentMessage>();
		for (const entry of branchEntries) {
			if (entry.type === "message") knownMessages.add(entry.message);
		}
		const extras = pendingEntries.filter(entry => {
			if (knownIds.has(entry.id)) return false;
			if (entry.type === "message" && knownMessages.has(entry.message)) return false;
			return true;
		});
		return [...branchEntries, ...extras];
	}

	#contextSteadyCurrentPromptEntryRefs(
		planningEntries: readonly SessionEntry[],
		messages: readonly AgentMessage[],
	): string[] {
		const message = [...messages].reverse().find(item => item.role === "user");
		if (!message) return [];
		const match = [...planningEntries]
			.reverse()
			.find(entry => entry.type === "message" && entry.message.role === "user" && entry.message === message);
		if (match) return [match.id];
		const byContent = [...planningEntries]
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content) === JSON.stringify(message.content),
			);
		return byContent ? [byContent.id] : [];
	}

	#contextSteadyCollectLiveTailEntryRefs(
		planningEntries: readonly SessionEntry[],
		currentPromptEntryRefs: readonly string[],
		tokenEstimateByEntryRef: ReadonlyMap<string, number>,
	): string[] {
		const promptSet = new Set(currentPromptEntryRefs);
		const lastPromptIndex = planningEntries.reduce((last, entry, index) => {
			return promptSet.has(entry.id) ? index : last;
		}, -1);
		const tail = lastPromptIndex >= 0 ? planningEntries.slice(lastPromptIndex + 1) : planningEntries;
		const tokenBudget = Math.max(
			0,
			Math.floor(this.settings.get("san.contextSteady.contextPlan.liveTailTokens") as number),
		);
		const selected: string[] = [];
		let used = 0;
		for (let index = tail.length - 1; index >= 0; index--) {
			const entry = tail[index];
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			const estimate = Math.max(0, tokenEstimateByEntryRef.get(entry.id) ?? 0);
			if (used + estimate > tokenBudget) {
				if (selected.length > 0) break;
				continue;
			}
			selected.unshift(entry.id);
			used += estimate;
		}
		return selected;
	}

	#contextSteadyActiveToolCallIds(entries: readonly SessionEntry[]): string[] {
		const pending = new Set<string>();
		const completed = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
				for (const block of entry.message.content) {
					if (
						block &&
						typeof block === "object" &&
						"type" in block &&
						block.type === "toolCall" &&
						"id" in block &&
						typeof block.id === "string"
					) {
						pending.add(block.id);
					}
				}
			}
			if (entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") {
				completed.add(entry.message.toolCallId);
			}
		}
		return [...pending].filter(id => !completed.has(id));
	}

	#contextSteadyPlanEnabled(): boolean {
		if (this.settings.isConfigured("san.contextSteady.contextPlan.enabled")) {
			return this.settings.get("san.contextSteady.contextPlan.enabled") === true;
		}
		return this.settings.get("san.contextSteady.contextPacket.enabled") === true;
	}

	#contextSteadyRecentDigests(): number {
		return this.settings.isConfigured("san.contextSteady.contextPlan.recentDigests")
			? (this.settings.get("san.contextSteady.contextPlan.recentDigests") as number)
			: (this.settings.get("san.contextSteady.contextPacket.recentDigests") as number);
	}

	#contextSteadyPlanMaxTokens(): number {
		return this.settings.isConfigured("san.contextSteady.contextPlan.maxTokens")
			? (this.settings.get("san.contextSteady.contextPlan.maxTokens") as number)
			: (this.settings.get("san.contextSteady.contextPacket.maxTokens") as number);
	}

	#contextSteadyBurstWindowTokens(): number {
		if (this.settings.isConfigured("san.contextSteady.burstWindowTokens")) {
			return this.settings.get("san.contextSteady.burstWindowTokens") as number;
		}
		return 320_000;
	}

	/**
	 * Project full provider input for a ContextPlan.
	 *
	 * - First user request: `messages` is only the pending prompt → combine with stored.
	 * - Tool-loop transform: pass `mode: "full"` — `messages` is already the full context.
	 * Double-counting stored + full context falsely trips the burst ceiling on legal tool tails.
	 */
	#estimateMaterializedProjectedInputTokens(
		messages: readonly AgentMessage[],
		planningEntries: readonly SessionEntry[],
		plan: BuiltContextPlan,
		mode: "pending" | "full" = "pending",
	): number {
		const activeMessages = mode === "full" ? [...messages] : [...this.messages, ...messages];
		return (
			computeNonMessageTokens(this) +
			estimateContextPlanProjectedTokens(activeMessages, planningEntries, plan, message =>
				this.#estimateProviderWireMessageTokens(message),
			)
		);
	}

	#estimateProviderWireMessageTokens(
		message: AgentMessage,
		options?: { excludeEncryptedReasoning?: boolean },
	): number {
		return convertToLlm([message]).reduce(
			(sum, providerMessage) => sum + estimateTokens(providerMessage as unknown as AgentMessage, options),
			0,
		);
	}

	#estimateFullProviderInputTokens(messages: readonly AgentMessage[]): number {
		const options = { excludeEncryptedReasoning: true } as const;
		return (
			computeNonMessageTokens(this) +
			messages.reduce((sum, message) => sum + this.#estimateProviderWireMessageTokens(message, options), 0)
		);
	}

	#contextSteadyMessageContentKey(message: AgentMessage): string {
		return JSON.stringify("content" in message ? message.content : undefined);
	}

	#contextSteadyPendingEntries(messages: readonly AgentMessage[]): SessionEntry[] {
		const branch = this.sessionManager.getBranch();
		return messages.map((message, index): SessionEntry => {
			// Prefer the real journal entry when the message is already persisted.
			const existing = branch.find(entry => {
				if (entry.type !== "message") return false;
				if (entry.message === message) return true;
				if (entry.message.role !== message.role) return false;
				if (entry.message.timestamp !== message.timestamp) return false;
				return (
					this.#contextSteadyMessageContentKey(entry.message) === this.#contextSteadyMessageContentKey(message)
				);
			});
			if (existing) return existing;
			return {
				type: "message",
				id: `pending_${this.#promptGeneration}_${index}`,
				parentId: null,
				timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
				message,
			};
		});
	}

	/**
	 * After the user prompt is journaled, rewrite any pending_* audit refs to real
	 * entry ids so /context plan remains joinable to the journal.
	 */
	#remapContextSteadyPlanPendingRefs(plan: BuiltContextPlan): BuiltContextPlan {
		const branch = this.sessionManager.getBranch();
		const remap = new Map<string, string>();
		const exactByPending = new Map<string, AgentMessage>();
		for (const exact of plan.sourceIndex.exactEntries) {
			if (exact.entryId.startsWith("pending_")) exactByPending.set(exact.entryId, exact.message);
		}
		for (const [pendingId, message] of exactByPending) {
			const match = [...branch]
				.reverse()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === message.role &&
						this.#contextSteadyMessageContentKey(entry.message) === this.#contextSteadyMessageContentKey(message),
				);
			if (match) remap.set(pendingId, match.id);
		}
		if (remap.size === 0) return plan;

		const mapRef = (ref: string) => remap.get(ref) ?? ref;
		const mapRefs = (refs: readonly string[]) => refs.map(mapRef);
		const audit = {
			...plan.audit,
			qualityGate: {
				...plan.audit.qualityGate,
				protectedEntryRefs: mapRefs(plan.audit.qualityGate.protectedEntryRefs),
				missingEntryRefs: mapRefs(plan.audit.qualityGate.missingEntryRefs),
			},
			materials: plan.audit.materials.map(material => ({
				...material,
				entryRefs: mapRefs(material.entryRefs),
			})),
			coverage: plan.audit.coverage.map(item => ({
				...item,
				sourceEntryRefs: mapRefs(item.sourceEntryRefs),
			})),
		};
		return {
			...plan,
			audit,
			coverageEntryRefs: mapRefs(plan.coverageEntryRefs),
			materials: plan.materials.map(material => ({
				...material,
				coveredEntryRefs: mapRefs(material.coveredEntryRefs),
			})),
			sourceIndex: {
				...plan.sourceIndex,
				entryIds: mapRefs(plan.sourceIndex.entryIds),
				exactEntries: plan.sourceIndex.exactEntries.map(exact => ({
					...exact,
					entryId: mapRef(exact.entryId),
				})),
			},
		};
	}

	/** Persist the request plan once, after pending_* refs have been remapped. */
	#persistContextSteadyPlanAudit(plan: BuiltContextPlan): void {
		const already = this.sessionManager
			.getBranch()
			.some(
				entry =>
					entry.type === "custom" &&
					entry.customType === CONTEXT_PLAN_CUSTOM_TYPE &&
					(entry.data as { planId?: string } | undefined)?.planId === plan.audit.planId,
			);
		if (already) return;
		this.sessionManager.appendCustomEntry(CONTEXT_PLAN_CUSTOM_TYPE, plan.audit);
	}

	#contextSteadyTokenEstimateByEntryRef(entries: readonly SessionEntry[]): Map<string, number> {
		const estimates = new Map<string, number>();
		for (const entry of entries) {
			if (entry.type === "message") estimates.set(entry.id, estimateTokens(entry.message));
			else if (entry.type === "custom_message") {
				estimates.set(
					entry.id,
					estimateTokens({
						role: "custom",
						customType: entry.customType,
						content: entry.content,
						display: entry.display,
						attribution: entry.attribution,
						timestamp: Date.parse(entry.timestamp),
					}),
				);
			}
		}
		return estimates;
	}

	#contextSteadyRecentExactEntryRefs(
		entries: readonly SessionEntry[],
		excludeRefs: ReadonlySet<string>,
		tokenBudget: number,
		tokenEstimateByEntryRef: ReadonlyMap<string, number>,
	): string[] {
		const selected: string[] = [];
		let used = 0;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			if (excludeRefs.has(entry.id)) continue;
			const estimate = Math.max(0, tokenEstimateByEntryRef.get(entry.id) ?? 0);
			if (used + estimate > tokenBudget) {
				if (selected.length > 0) break;
				continue;
			}
			selected.unshift(entry.id);
			used += estimate;
		}
		return selected;
	}

	#contextSteadyRebaseBoundary(
		entries: readonly SessionEntry[],
	): { checkpointEntryId: string; reason: ContextCheckpointRebaseReason } | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry?.type !== "custom" || entry.customType !== CONTEXT_CHECKPOINT_CUSTOM_TYPE) continue;
			if (entry.id === this.#contextSteadyLastRebaseCheckpointEntryId) return undefined;
			return { checkpointEntryId: entry.id, reason: this.#contextSteadyCheckpointRebaseReason(entry.data) };
		}
		return undefined;
	}

	#contextSteadyCheckpointRebaseReason(value: unknown): ContextCheckpointRebaseReason {
		if (value && typeof value === "object") {
			const reason = (value as Record<string, unknown>).rebaseReason;
			if (
				reason === "checkpoint" ||
				reason === "resume" ||
				reason === "budget_pressure" ||
				reason === "topic_shift"
			) {
				return reason;
			}
		}
		return "checkpoint";
	}

	#applyContextSteadySafeRebase(boundary: { checkpointEntryId: string; reason: ContextCheckpointRebaseReason }): void {
		this.#closeAllProviderSessions(`context steady ${boundary.reason} rebase`);
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		this.#contextSteadyLastRebaseCheckpointEntryId = boundary.checkpointEntryId;
	}

	#buildSanLoopCommanderPrelude(): CustomMessage | undefined {
		if (this.settings.get("san.executionLoop.enabled") !== true) return undefined;
		if (this.settings.get("san.executionLoop.ledger.enabled") !== true) return undefined;
		this.#dropSanLoopRoleContextMessagesFromActiveContext();

		// Active branch only — off-branch plan/packet refs must not pollute role context.
		const built = buildSanLoopRoleContext(this.sessionManager.getBranch(), {
			role: "commander",
			settings: {
				tokenBudget: this.settings.get("san.executionLoop.roleContext.tokenBudget") as number,
				maxEvents: this.settings.get("san.executionLoop.roleContext.maxEvents") as number,
				maxDecisions: this.settings.get("san.executionLoop.roleContext.maxDecisions") as number,
			},
		});
		if (!built) return undefined;
		if (this.settings.get("san.executionLoop.ledger.persistRolePackets") === true) {
			appendSanLoopRoleContextDebugEntry(this.sessionManager, built.packet);
		}
		return {
			role: "custom",
			customType: SAN_LOOP_CONTEXT_PACKET_CUSTOM_TYPE,
			content: built.content,
			display: false,
			details: {
				packetId: built.packet.packetId,
				runId: built.packet.runId,
				role: built.packet.role,
				sourceContextPacketRefs: built.packet.sourceContextPacketRefs,
			},
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #runPendingSanBrainProjections(): Promise<void> {
		const store = SanBrainStore.open(this.settings.getAgentDir());
		try {
			await runSanBrainProjections({
				store,
				sessionManager: this.sessionManager,
				session: this,
				agentDir: this.settings.getAgentDir(),
				cwd: path.resolve(this.settings.getCwd()),
				maxAttempts: this.settings.get("san.brain.projections.maxAttempts"),
				attemptTimeoutMs: this.settings.get("san.brain.projections.attemptTimeoutMs"),
				limit: this.settings.get("san.brain.projections.maxPerTurn"),
			});
			const unnotified = store
				.readProjectionDebug("blocked", this.settings.get("san.brain.projections.maxPerTurn"))
				.records.filter(projection => !projection.notifiedAt);
			for (const projection of unnotified) {
				const notifiedAt = new Date().toISOString();
				appendSanBrainProjectionNotification(this.sessionManager, {
					schemaVersion: 1,
					projectionId: projection.projectionId,
					notifiedAt,
				});
				store.syncSessionEntries(this.sessionId, this.sessionManager.getEntries());
			}
			if (unnotified.length > 0) {
				this.emitNotice(
					"warning",
					`${unnotified.length} San Brain projection${unnotified.length === 1 ? " is" : "s are"} blocked; use /brain debug blocked.`,
					"brain",
				);
			}
		} catch (error) {
			logger.warn("Failed to run pending San Brain projections", {
				error: error instanceof Error ? error.message : String(error),
				sessionId: this.sessionId,
			});
		} finally {
			store.close();
		}
	}

	async #buildBrainStatePrelude(
		expandedText: string,
	): Promise<{ content?: string; activation: SanBrainActivation } | undefined> {
		this.#dropSanBrainStateMessagesFromActiveContext();
		const turnId = `brain_prompt_${this.#promptGeneration + 1}`;
		const cwd = path.resolve(this.settings.getCwd());
		try {
			const scopes = await this.#resolveSanBrainScopes(cwd);
			const store = SanBrainStore.open(this.settings.getAgentDir());
			try {
				store.syncSessionEntries(this.sessionId, this.sessionManager.getEntries());
				return buildSanBrainStatePrelude(store.listActiveStates(1000), {
					sessionId: this.sessionId,
					turnId,
					role: "primary",
					scopes,
					promptText: expandedText,
					maxItems: this.settings.get("san.brain.activation.maxItems") as number,
					maxTokens: this.settings.get("san.brain.activation.maxTokens") as number,
					minConfidence: this.settings.get("san.brain.activation.minConfidence") as number,
				});
			} finally {
				store.close();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Failed to build San Brain activation", { error: message, sessionId: this.sessionId, turnId });
			try {
				recordSanBrainActivationError(this.sessionManager, { sessionId: this.sessionId, turnId, message });
			} catch (recordError) {
				logger.warn("Failed to persist San Brain activation error", {
					error: recordError instanceof Error ? recordError.message : String(recordError),
					sessionId: this.sessionId,
					turnId,
				});
			}
			return undefined;
		}
	}

	#resolveSanBrainIdentity(cwd = path.resolve(this.sessionManager.getCwd())): Promise<RuntimeScopeIdentity> {
		const agentDir = this.settings.getAgentDir();
		const key = `${agentDir}\0${cwd}\0${this.sessionId}`;
		if (this.#sanBrainIdentityCache?.key === key) return this.#sanBrainIdentityCache.promise;
		const promise = resolveRuntimeScopeIdentity({ agentDir, cwd, sessionId: this.sessionId });
		const cached = { key, promise };
		this.#sanBrainIdentityCache = cached;
		void promise.catch(() => {
			if (this.#sanBrainIdentityCache === cached) this.#sanBrainIdentityCache = undefined;
		});
		return promise;
	}

	async #resolveSanBrainCaptureScopes(): Promise<SanBrainCaptureScopes> {
		try {
			const identity = await this.#resolveSanBrainIdentity();
			return {
				userScope: { kind: "user", key: identity.userKey, resolverVersion: 1 },
				fallbackScope: { kind: "project", key: identity.projectKey, resolverVersion: 1 },
			};
		} catch (error) {
			logger.warn("Failed to resolve stable San Brain capture scope; using session scope", {
				error: error instanceof Error ? error.message : String(error),
				sessionId: this.sessionId,
			});
			return {
				userScope: { kind: "user", key: "user:local", resolverVersion: 1 },
				fallbackScope: { kind: "session", key: this.sessionId, resolverVersion: 1 },
			};
		}
	}

	async #resolveSanBrainScopes(cwd = path.resolve(this.sessionManager.getCwd())): Promise<SanBrainScope[]> {
		const identity = await this.#resolveSanBrainIdentity(cwd);
		return [
			{ kind: "user", key: identity.userKey, resolverVersion: 1 },
			{ kind: "session", key: identity.sessionKey, resolverVersion: 1 },
			{ kind: "project", key: identity.projectKey, resolverVersion: 1 },
			...(identity.repoKey ? [{ kind: "repo" as const, key: identity.repoKey, resolverVersion: 1 as const }] : []),
			...identity.legacyProjectKeys.map(key => ({ kind: "project" as const, key, resolverVersion: 1 as const })),
			...identity.legacyRepoKeys.map(key => ({ kind: "repo" as const, key, resolverVersion: 1 as const })),
		];
	}

	#recoverPersistedSanLoopRun(): void {
		if (this.settings.get("san.executionLoop.enabled") !== true) return;
		if (this.settings.get("san.executionLoop.ledger.enabled") !== true) return;
		const latest = findLatestSanLoopRun(this.sessionManager.getEntries());
		if (!latest || isSanLoopTerminalStatus(latest.data.status)) return;
		recoverSanLoopRun(this.sessionManager, latest.data);
	}

	async #buildContextSteadyRecallLayer(expandedText: string): Promise<ContextPacketRecallLayer | undefined> {
		if (this.settings.get("san.contextSteady.recall.enabled") !== true) return undefined;

		const maxQueryChars = this.settings.get("san.contextSteady.recall.maxQueryChars") as number;
		const baseQuery = buildContextSteadyRecallQuery(this.sessionManager.getEntries(), expandedText, {
			recentDigests: this.#contextSteadyRecentDigests(),
			maxQueryChars,
		});
		if (!baseQuery) return undefined;

		const maxItems = clampPositiveInteger(this.settings.get("san.contextSteady.recall.maxItems") as number, 3);
		const maxTokens = clampPositiveInteger(this.settings.get("san.contextSteady.recall.maxTokens") as number, 1000);
		const scopes = await this.#resolveSanBrainScopes();
		let activeStates: SanBrainActiveStateRecord[] = [];
		const brainPolicy = resolveSanBrainRuntimePolicy(this.settings);
		if (brainPolicy.activationEnabled) {
			const store = SanBrainStore.open(this.settings.getAgentDir());
			try {
				store.syncSessionEntries(this.sessionId, this.sessionManager.getEntries());
				activeStates = store.listActiveStates(1000);
			} catch (error) {
				logger.debug("San Brain recall policy lookup failed", { error: String(error), sessionId: this.sessionId });
			} finally {
				store.close();
			}
		}
		const recallPlan = buildSanBrainRecallPlan(activeStates, {
			role: "primary",
			scopes,
			promptText: expandedText,
			baseQuery,
			maxItems,
			tokenBudget: maxTokens,
			minConfidence: this.settings.get("san.brain.activation.minConfidence") as number,
			maxQueryChars,
		});
		const turnId = `brain_recall_${this.#promptGeneration + 1}`;
		const appendRecallAudit = (
			backend: "off" | "local" | "hindsight" | "mnemopi",
			outcome: "applied" | "suppressed" | "backend_unavailable" | "search_unsupported" | "failed",
			resultCount: number,
			durationMs: number,
			errorCode?: "backend_unavailable" | "search_unsupported" | "external_failure",
		): void => {
			appendSanBrainRecallAudit(this.sessionManager, {
				schemaVersion: 1,
				recallId: `brain_recall_${Bun.randomUUIDv7()}`,
				sessionId: this.sessionId,
				turnId,
				policyVersion: recallPlan.policyVersion,
				selectedPolicyIds: recallPlan.selectedPolicyIds,
				...(recallPlan.queryTemplateId ? { queryTemplateId: recallPlan.queryTemplateId } : {}),
				backend,
				outcome,
				resultCount,
				durationMs,
				skipReasons: recallPlan.skipReasons,
				...(errorCode ? { errorCode } : {}),
				createdAt: new Date().toISOString(),
			});
		};
		if (!recallPlan.query) {
			appendRecallAudit(this.settings.get("memory.backend"), "suppressed", 0, 0);
			return undefined;
		}

		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.search) {
			const outcome = backend.id === "off" ? "backend_unavailable" : "search_unsupported";
			appendRecallAudit(backend.id, outcome, 0, 0, outcome);
			return undefined;
		}

		const startedAt = performance.now();
		try {
			const result = await backend.search(
				{ agentDir: this.settings.getAgentDir(), cwd: this.sessionManager.getCwd(), session: this },
				recallPlan.query,
				{
					limit: recallPlan.maxItems,
					maxTokens: recallPlan.tokenBudget,
					memoryTypes: recallPlan.memoryTypes,
					scopeKeys: recallPlan.scopeKeys,
				},
			);
			const items = normalizeContextSteadyRecallItems(result.items, {
				maxItems: recallPlan.maxItems,
				memoryTypes: recallPlan.memoryTypes,
				scopeKeys: recallPlan.scopeKeys,
			});
			appendRecallAudit(backend.id, "applied", items.length, Math.max(0, Math.round(performance.now() - startedAt)));
			if (items.length === 0) return undefined;
			return {
				query: result.query,
				items,
				tokenBudget: recallPlan.tokenBudget,
				policyVersion: recallPlan.policyVersion,
				selectedPolicyIds: recallPlan.selectedPolicyIds,
				...(recallPlan.queryTemplateId ? { queryTemplateId: recallPlan.queryTemplateId } : {}),
				skipReasons: recallPlan.skipReasons,
			};
		} catch (error) {
			appendRecallAudit(
				backend.id,
				"failed",
				0,
				Math.max(0, Math.round(performance.now() - startedAt)),
				"external_failure",
			);
			logger.debug("San context steady recall failed", {
				backend: backend.id,
				error: String(error),
			});
			return undefined;
		}
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
			queueChipText?: string;
			queueOnly?: boolean;
		},
	): Promise<void> {
		if (message.attribution === "user" && message.display !== false) {
			this.#resetToolLoopGuardsForUserInput();
		}
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			let skillName = "";
			if (details && typeof details === "object") {
				if ("args" in details && typeof details.args === "string") skillArgs = details.args;
				if ("name" in details && typeof details.name === "string") skillName = details.name;
			}
			keywordNotices = this.#createMagicKeywordNotices(skillArgs);
			// 证据链 skill:编译 gate 挂到会话容器,并把契约回显作为可见伴随
			// 消息注入 — 与 keyword notices 走同一投递机制,queue/steer/prompt
			// 三条分支自动一致。
			const contractEcho = this.#activateSkillEvidenceGates(skillName, skillArgs);
			if (contractEcho) keywordNotices.push(contractEcho);
		}

		if (options?.queueOnly) {
			if (!options.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, options.streamingBehavior);
			}
			await this.#queueCustomMessage(message, options.streamingBehavior, options.queueChipText);
			return;
		}
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			await this.sendCustomMessage(message, {
				deliverAs: options.streamingBehavior,
				queueChipText: options.queueChipText,
			});
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	/**
	 * 证据链 skill 触发时:编译 evidence 声明为 acceptance gate 并挂到会话级
	 * 容器,返回契约回显消息(可见、agent 归属)。以下情况返回 undefined 且
	 * 零副作用:开关关闭、skill 不存在或无 evidence 声明、同名链已激活(重复
	 * 触发不重置回执,也不重复回显)。
	 */
	#activateSkillEvidenceGates(skillName: string, skillArgs: string): CustomMessage | undefined {
		if (!skillName) return undefined;
		if (this.settings.get("skills.evidenceGates") !== true) return undefined;
		const skill = this.#skills.find(candidate => candidate.name === skillName);
		if (!skill?.evidence?.length) return undefined;
		this.#skillGateState ??= new SessionSkillGateState(this.sessionManager.getSessionId());
		const chain = this.#skillGateState.activate(skill);
		if (!chain) return undefined;
		const text = prompt
			.render(skillContractEchoTemplate, {
				skillName: skill.name,
				objective: skillArgs.trim() || undefined,
				skillDescription: skill.description,
				doneGates: skill.evidence.filter(spec => spec.phase === "before-done"),
			})
			.trim();
		const echoHash = this.#skillGateState.recordContractEcho(skill.name, text);
		return {
			role: "custom",
			customType: SKILL_CONTRACT_ECHO_MESSAGE_TYPE,
			content: text,
			display: true,
			details: {
				skillName: skill.name,
				contractHash: chain.contractRef.contractHash,
				echoHash,
			},
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** 会话级 skill gate 容器(测试与 San Loop 接线读取;无证据链 skill 时为 undefined)。 */
	get skillGateState(): SessionSkillGateState | undefined {
		return this.#skillGateState;
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<void> {
		this.#beginInFlight();
		const generation = this.#promptGeneration;
		const previousRouteRequirements = this.#promptModelRouteRequirements;
		const pendingRouteMessages = [...(options?.prependMessages ?? []), message, ...this.#pendingNextTurnMessages];
		this.#promptModelRouteRequirements = {
			requiredContextTokens: this.#estimateStoredContextTokens(pendingRouteMessages),
			requiredOutputTokens: this.agent.maxTokens,
			requiresImages: pendingRouteMessages.some(
				pending =>
					"content" in pending &&
					Array.isArray(pending.content) &&
					pending.content.some(content => content.type === "image"),
			),
		};
		try {
			this.#contextSteadyRequestPlan = undefined;
			// Flush any pending bash messages before the new prompt
			await this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingIrcAsides();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			this.#mutationsSinceLastTodoTouch = 0;
			this.#midRunNudgeCount = 0;
			this.#resetPromptMaintenanceState();
			this.#acceptTerminalEmptyStopForPrompt = options?.acceptTerminalEmptyStop === true;

			await this.#maybeRestoreRetryFallbackPrimary();
			const routeRuntimeRejections: ModelRouteRuntimeRejection[] = [];
			await this.#maybeRecoverModelRoute(routeRuntimeRejections);

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			await this.#ensurePromptModelRoute(routeRuntimeRejections);

			// Check if we need to compact before sending (catches aborted responses). Run
			// inline (allowDefer=false) so the handoff/maintenance fully settles before this
			// prompt's agent loop starts — otherwise a deferred handoff would fire on the
			// next microtask alongside the new turn.
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false, false, false);
			}

			await this.#armPlanYoloIfNeeded();

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			const vibeModeMessage = this.#buildVibeModeMessage();
			if (vibeModeMessage) {
				messages.push(vibeModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			const xdevMountNoticeIndex = messages.length;
			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
					snapshotStore: getFileSnapshotStore(this),
				});
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await this.#normalizeAgentMessageImages(fileMentionMessage));
				}
			}

			const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText);

			let baseXdevCatalogDelivered = true;
			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						const normalized = normalizeCustomMessagePayload(msg);
						const hasExplicitAttribution =
							msg !== null &&
							typeof msg === "object" &&
							!Array.isArray(msg) &&
							(msg.attribution === "user" || msg.attribution === "agent");
						messages.push(
							await this.#normalizeAgentMessageImages({
								role: "custom",
								customType: normalized.customType,
								content: normalized.content,
								display: normalized.display,
								details: normalized.details,
								attribution: hasExplicitAttribution
									? normalized.attribution
									: (promptAttribution ?? (message.role === "user" ? "user" : "agent")),
								timestamp: Date.now(),
							}),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					baseXdevCatalogDelivered = false;
					this.#setTurnSystemPromptOverride(result.systemPrompt);
				} else {
					this.#clearTurnSystemPromptOverride();
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.#clearTurnSystemPromptOverride();
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			const xdevMountNotice = isUserQueuedMessage(message)
				? this.#takePendingXdevMountNotice(baseXdevCatalogDelivered)
				: undefined;
			if (xdevMountNotice) {
				messages.splice(xdevMountNoticeIndex, 0, xdevMountNotice);
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.#autoThinking && message.role === "user") {
				await this.#applyAutoThinkingLevel(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			// Build ContextPlan before pre-prompt compaction so send/status/compaction
			// share one projected snapshot for this request lifecycle.
			this.#contextSteadyRequestPlan = await this.#buildContextSteadyRequestPlanWithRecovery(messages, expandedText);
			if (this.#contextSteadyRequestPlan) {
				this.#contextSteadyLastPlan = this.#contextSteadyRequestPlan;
			}
			if (this.#promptGeneration !== generation) {
				return;
			}

			await this.#runPrePromptCompactionIfNeeded(messages);
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			const nonMessageTokens = computeNonMessageTokens(this);
			const contextWindow = this.model?.contextWindow ?? 0;
			const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
			const promptTokens =
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0) +
					messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
			this.#setPendingContextSnapshot({
				promptTokens,
				nonMessageTokens,
				cutoffCount: this.messages.length + messages.length,
			});
			// Context steady: capture leaf entry ID before this prompt cycle's
			// entries are appended, so the source range spans the full turn.
			this.#contextSteadyPreTurnLeafId = this.sessionManager.getLeafId();
			// Execution control：真实宿主用户 turn 在首次 provider 派发前 mint
			// 根 scope；continuation/steering 复用 active scope。用户消息 entry
			// id 即 host evidence ref（authoritativeUserTurnId）。synthetic/
			// model 文本永远不能 mint scope。首个权威 turn 可能返回契约回显,
			// 作为本批次伴随消息随 prompt 一起进入消息流与转录。
			const generalContractEcho = await this.#ensureExecutionScopeForTurn(message);
			if (generalContractEcho) messages.push(generalContractEcho);
			if (this.#promptGeneration !== generation) {
				return;
			}
			// Provider 派发 gate 位于 SDK provider wrapper：每次调用先以
			// Snowflake requestId 向 runtime 登记（任何 provider/network 工作
			// 之前），scheduler gate 拒绝即零网络。ProviderHealthRegistry 保持
			// 为传输层电路 gate。
			try {
				await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			} catch (error) {
				// `abort()` 自行决定当前 Scope 是否需要终态化；其等待 Agent idle
				// 期间保持该标记，避免 prompt 的并发失败路径抢先写入 runtime_fault。
				// 内部手动压缩会继续同一执行，因此不得终结 Scope。
				if (!this.#abortInProgress) {
					if (error instanceof ProviderCircuitOpenError) {
						await this.#finishExecutionScope("no_provider_available");
					} else {
						await this.#finishExecutionScope("runtime_fault");
					}
				}
				throw error;
			}
			// 正常完成：尝试终态迁移；仅当 required host evidence gate 全部
			// pass 且带 host evidence 时 runtime 才接受 `completed`——assistant
			// 文本永远不是 evidence，缺 evidence 不是用户错误，scope 保持运行。
			await this.#finishExecutionScope("completed");
			// 追加 journal 后重映射 pending_* 引用；仅在后提示恢复之后持久化
			// 审计，以便 TurnDigest settledLeafId 指向非 plan entry。
			if (this.#contextSteadyRequestPlan) {
				this.#contextSteadyRequestPlan = this.#remapContextSteadyPlanPendingRefs(this.#contextSteadyRequestPlan);
				this.#contextSteadyLastPlan = this.#contextSteadyPlanInputsChanged(this.#contextSteadyRequestPlan)
					? undefined
					: this.#contextSteadyRequestPlan;
			}
			this.#setPendingContextSnapshot(undefined);
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
			// Queue plan audit after digests: digests pin settledLeafId before this task runs.
			if (this.#contextSteadyLastPlan) {
				const planToPersist = this.#contextSteadyLastPlan;
				this.#trackPostPromptTask(
					Promise.resolve().then(() => {
						this.#persistContextSteadyPlanAudit(planToPersist);
					}),
				);
				if (!options?.skipPostPromptRecoveryWait) {
					await this.#waitForPostPromptRecovery(generation);
				}
			}
		} finally {
			this.#clearTurnSystemPromptOverride();
			// Drop the in-flight request plan, but keep last plan for idle status parity.
			this.#contextSteadyRequestPlan = undefined;
			this.#promptModelRouteRequirements = previousRouteRequirements;
			this.#endInFlight();
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			models: createExtensionModelQuery(this.#modelRegistry, this.settings, () => this.model ?? undefined),
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				// Await the idempotent dispose() before exiting so the browser
				// reaper and other bounded teardown complete — a fire-and-forget
				// `void this.dispose()` raced process.exit() and could leave an
				// San-owned Chromium alive (#5643).
				void this.dispose().finally(() => process.exit(0));
			},
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
			setInterval: (callback, ms, ...args) => this.#fallbackTimers().setInterval(callback, ms, ...args),
			setTimeout: (callback, ms, ...args) => this.#fallbackTimers().setTimeout(callback, ms, ...args),
			clearTimer: timer => this.#fallbackTimers().clear(timer),
		};
	}

	/** Lazily create the runner-less command-context timer registry (#5664). */
	#fallbackTimers(): ManagedTimers {
		this.#fallbackExtensionTimers ??= new ManagedTimers((event, error) =>
			logger.warn("Extension timer callback threw", { event, error }),
		);
		return this.#fallbackExtensionTimers;
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 * Set `options.synthetic` to enqueue a hidden developer message (agent-attributed
	 * by default) instead of a user-attributed follow-up; the plan-approval flow
	 * uses this to land its execution directive behind a queued user turn without
	 * flipping advisor auto-resume.
	 */
	async followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText =
			options?.expandPromptTemplates === false ? text : expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!options?.synthetic) {
			await this.#queueUserMessage(expandedText, images, "followUp");
			return;
		}
		// Synthetic branch: agent-initiated hidden developer message. Bypass
		// #queueUserMessage (which clears advisor auto-resume suppression and
		// enqueues as a user-attributed message) and place the developer message
		// directly on the follow-up queue.
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
		this.agent.followUp({
			role: "developer",
			content,
			attribution: options.attribution ?? "agent",
			timestamp: Date.now(),
		});
		this.#scheduleIdleQueueDrain();
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		mode: "steer" | "followUp",
	): Promise<void> {
		this.#pendingUserMessageEnqueueCount++;
		try {
			// RPC/SDK/collab 或流式输入排队的 user 消息代表用户主动恢复；
			// 同时解除用户中断留下的 advisor 自动恢复抑制。
			this.#resetToolLoopGuardsForUserInput();
			for (const advisor of this.#advisors) advisor.runtime.preemptCatchupWait();
			this.#advisorAutoResumeSuppressed = false;
			const normalizedImages = await this.#normalizeImagesForModel(images);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
			if (normalizedImages?.length) {
				content.push(...normalizedImages);
			}
			// 文本模型收到图片时，先用视觉模型生成描述，并紧邻 user 消息前注入隐藏伴随消息。
			const imageDescriptionNotice = normalizedImages?.length
				? await this.#buildImageDescriptionNotice(normalizedImages)
				: undefined;
			if (mode === "followUp") {
				if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
				this.agent.followUp({
					role: "user",
					content,
					attribution: "user",
					timestamp: Date.now(),
				});
			} else {
				if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
				this.agent.steer({
					role: "user",
					content,
					steering: true,
					attribution: "user",
					timestamp: Date.now(),
				});
			}
			this.#scheduleIdleQueueDrain();
		} finally {
			this.#pendingUserMessageEnqueueCount--;
		}
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (this.#queuedMessageDrainScheduled || !this.#canAutoContinueForFollowUp() || !this.agent.hasQueuedMessages()) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages();
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
			},
		});
	}

	/**
	 * Gate for idle-path queued-message auto-continue. See `#scheduleIdleQueueDrain` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (this.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (#advisorAutoResumeSuppressed, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (this.#advisorAutoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		// Context steady: the continuation prompt overwrites
		// #contextSteadyPreTurnLeafId (in #promptWithMessage). Save and restore
		// it so the consolidated digest (triggered by chainEnded) can use the
		// captured original boundary. The restored value is only the fallback
		// for non-continuation prompts; the captured flag lets a first-turn
		// continuation preserve a deliberate null boundary.
		const steadyLeafBeforeContinuation = this.#contextSteadyPreTurnLeafId;
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		} finally {
			this.#contextSteadyPreTurnLeafId = steadyLeafBeforeContinuation;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#beginInFlight();
		try {
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#acceptTerminalEmptyStopForPrompt = acceptTerminalEmptyStop;
			// Capture leaf entry ID before this agent-initiated prompt cycle's entries
			// are appended, matching #promptWithMessage's pre-turn boundary setup.
			this.#contextSteadyPreTurnLeafId = this.sessionManager.getLeafId();
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#endInFlight();
		}
	}

	/** Queue a custom message without starting a turn, matching steer/follow-up delivery. */
	async #queueCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		deliverAs: "steer" | "followUp",
		queueChipText?: string,
	): Promise<void> {
		const details =
			queueChipText !== undefined
				? ({
						...((message.details && typeof message.details === "object" ? message.details : {}) as Record<
							string,
							unknown
						>),
						__queueChipText: queueChipText,
					} as T)
				: message.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (deliverAs === "followUp") {
			this.agent.followUp(normalizedAppMessage);
		} else {
			this.agent.steer(normalizedAppMessage);
		}
		this.#scheduleIdleQueueDrain();
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @returns true iff this call synchronously started a new turn (awaited
	 * `agent.prompt`); false when the message was queued/appended without a turn
	 * — including when `triggerTurn` is downgraded because the client defers
	 * agent-initiated turns. Callers that must mirror the resulting `agent_end`
	 * use this to avoid acting on a turn that never ran.
	 */
	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? ({
						...((normalizedPayload.details && typeof normalizedPayload.details === "object"
							? normalizedPayload.details
							: {}) as Record<string, unknown>),
						__queueChipText: options.queueChipText,
					} as T)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage, {
					acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true,
				});
				return true;
			}
			this.agent.appendMessage(normalizedAppMessage);
			this.sessionManager.appendCustomMessageEntry(
				normalizedAppMessage.customType,
				normalizedAppMessage.content,
				normalizedAppMessage.display,
				normalizedAppMessage.details,
				normalizedAppMessage.attribution,
			);
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.agent.appendMessage(normalizedAppMessage);
		this.sessionManager.appendCustomMessageEntry(
			normalizedAppMessage.customType,
			normalizedAppMessage.content,
			normalizedAppMessage.display,
			normalizedAppMessage.details,
			normalizedAppMessage.attribution,
		);
		return false;
	}

	/**
	 * Send a user message through the prompt flow.
	 *
	 * Omitted `deliverAs` starts a turn when idle and queues as a steer while streaming.
	 * Explicit `deliverAs` queues without starting a turn in either state.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion.
		// `streamingBehavior: "steer"` preserves prompt-flow side effects during streaming while
		// covering the narrow race where a stream starts before prompt() acquires the turn.
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			streamingBehavior: "steer",
		});
	}

	/** Clear queued messages and return the user-restorable ones (text plus any attached images).
	 *  Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 *  returned for editor restore. Other queued messages stay in the agent-core queues so a continuing
	 *  stream still delivers them — EXCEPT on `forInterrupt` (Esc+abort), where only advisor cards are
	 *  kept (abort()'s #extractQueuedAdvisorCards preserves them as visible advice) and every other
	 *  non-user steer (hidden goal/plan/budget, IRC/extension asides) is dropped, so abort()'s
	 *  #drainStrandedQueuedMessages can't auto-resume the run the user just interrupted (the drain only
	 *  fires while agent.hasQueuedMessages()). Plain Alt+Up dequeue preserves those non-user steers. */
	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		return { steering, followUp };
	}

	/** Number of pending displayable messages (includes steering, follow-up, and next-turn messages).
	 *  Reflects actual queued work (advisor cards included) — feeds hasPendingMessages()/RPC and the
	 *  empty-submit abort gate. The user-restorable subset is surfaced by getQueuedMessages()/clearQueue(). */
	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Steps over agent-authored queued messages (advisor cards, hidden/internal steers).
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};
		// Notices queue immediately before their user message, so dropping the popped
		// prompt means also dropping the contiguous hidden-user companions right before
		// it — companions of other queued prompts stay put.
		const removeWithCompanions = (queue: readonly AgentMessage[], userIndex: number): AgentMessage[] => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return next;
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			this.agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			this.agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#cloneTodoPhases(this.#todoPhases);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todoPhases = this.#cloneTodoPhases(phases);
	}

	#isTodoInitResult(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const detailOp = getStringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	#buildReplanTitleContext(): string {
		const turns: TitleConversationTurn[] = [];
		for (
			let i = this.agent.state.messages.length - 1;
			i >= 0 && turns.length < REPLAN_TITLE_CONTEXT_TURN_LIMIT;
			i--
		) {
			const message = this.agent.state.messages[i];
			if (!message) continue;
			const turn = titleConversationTurnFromMessage(message);
			if (turn) turns.push(turn);
		}
		turns.reverse();
		return formatTitleConversationContext(turns);
	}

	#scheduleReplanTitleRefresh(): void {
		if (this.#replanTitleRefreshInFlight) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const context = this.#buildReplanTitleContext();
		if (!context) return;
		const sessionId = this.sessionManager.getSessionId();
		const refresh = this.#refreshTitleAfterReplan(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (this.#replanTitleRefreshInFlight === refresh) {
					this.#replanTitleRefreshInFlight = undefined;
				}
			});
		this.#replanTitleRefreshInFlight = refresh;
	}

	/**
	 * Generate an automatic online session title tied to this session's lifecycle.
	 * Input and replan callers share the signal so disposal cancels the provider
	 * request instead of leaving background inference alive.
	 */
	generateTitle(firstMessage: string): Promise<string | null> {
		return generateSessionTitle(
			firstMessage,
			this.#modelRegistry,
			this.settings,
			this.sessionId,
			this.model,
			provider => this.agent.metadataForProvider(provider),
			this.#titleSystemPrompt,
			this.#titleGenerationAbortController.signal,
		);
	}

	async #refreshTitleAfterReplan(context: string, sessionId: string): Promise<void> {
		const title = await this.generateTitle(context);
		if (!title) return;
		if (this.sessionManager.getSessionId() !== sessionId) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(this.sessionManager, title, "auto", "replan");
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#titleSystemPrompt = prompt;
	}

	#syncTodoPhasesFromBranch(): void {
		const phases = getLatestTodoPhasesFromEntries(this.sessionManager.getBranch());
		this.setTodoPhases(phases);
	}

	#cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
		}));
	}

	// Auto-clear of completed/abandoned tasks was removed: the timer-driven
	// splice mutated canonical `#todoPhases` between tool calls, so the model
	// observed phase totals shrinking ("5 → 4") after marking tasks done. The
	// `tasks.todoClearDelay` setting is now inert; completed tasks survive
	// until the next explicit `todo` call removes them via `rm`/`drop`.

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 */
	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		/** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */
		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisorAutoResumeSuppressed = true;
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.#abortAutolearnCapture();
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			// 先把宿主原因写入 handoff signal，避免随后通用 compaction abort
			// 用无原因的 AbortError 覆盖它。
			this.abortHandoff(new Error(options?.reason ?? "Handoff aborted by session"));
			if (options?.preserveCompaction) {
				// Manual `/compact` installed its own #compactionAbortController before
				// this internal abort and must keep it alive (that marker is what makes
				// isCompacting report true during startup). Any in-flight
				// auto-compaction MUST still be cancelled, though: otherwise a
				// background maintenance pass races the manual run and both
				// appendCompaction/replaceMessages, double-rewriting session history.
				this.#autoCompactionAbortController?.abort();
			} else {
				this.abortCompaction();
			}
			this.abortBash();
			this.abortEval();
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			// 手动压缩只暂停当前 provider turn，随后仍在同一执行 Scope 中恢复；
			// 其余宿主中止则立即终态化，拒绝任何迟到 provider 响应复活 Scope。
			if (!options?.preserveCompaction) {
				await this.#finishExecutionScope("aborted_by_user");
			}
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#drainAutolearnCapture();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();
			// Safety net: if the agent loop aborted without producing an assistant
			// message (e.g. failed before the first stream), the in-flight yield was
			// never resolved or rejected by the normal message_end path. Reject it now
			// so any requeue callback still fires and the queue stays consistent.
			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}
			// Re-record advisor concerns the interrupt would otherwise strand, as
			// visible/persisted advice without triggering a turn (the agent is idle
			// now): cards steered into the queue before the user stopped, plus any
			// that arrived via enqueueAdvice mid-abort and were parked hidden in
			// #pendingNextTurnMessages while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#preserveAdvisorCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#cancelOwnAsyncJobs();
		this.#closeAllProviderSessions("new session");
		await this.#flushPendingBashMessages();
		const bashTransition = this.#beginBashSessionTransition({ persistDetached: options?.drop !== true });
		let sessionTransitioned = false;
		try {
			this.agent.reset();
			if (options?.drop && previousSessionFile) {
				// Detach the advisor recorder feed and drain its writer BEFORE deleting the
				// old artifacts dir: `await this.abort()` only stops the primary, so a still-
				// running advisor turn could otherwise finish, emit `message_end`, and recreate
				// `<old>/__advisor.jsonl`. #resetAdvisorSessionState (after newSession) re-primes
				// the advisor and re-attaches the feed at the new session's path.
				for (const a of this.#advisors) {
					a.agentUnsubscribe?.();
					a.agentUnsubscribe = undefined;
					await a.recorder.close();
				}
				try {
					await this.sessionManager.dropSession(previousSessionFile);
				} catch (err) {
					logger.error("Failed to delete session during /drop", { err });
				}
			} else {
				await this.sessionManager.flush();
			}
			await this.sessionManager.newSession(options);
			this.#markBashSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#finishBashSessionTransition(bashTransition, sessionTransitioned);
		}
		this.#resetAnnouncedMounts();

		this.#clearCheckpointRuntimeState();
		this.setTodoPhases([]);
		this.#freshProviderSessionId = undefined;
		this.#clearInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		await this.#resetMemoryContextForNewTranscript();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel, this.configuredThinkingLevel());
		this.sessionManager.appendServiceTierChange(this.#serviceTierEntry());

		this.#todoReminderCount = 0;
		this.#todoReminderAwaitingProgress = false;
		this.#mutationsSinceLastTodoTouch = 0;
		this.#midRunNudgeCount = 0;
		this.#planReferenceSent = false;
		this.#planReferencePath = "local://PLAN.md";
		this.#resetAdvisorSessionState();
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#flushPendingBashMessages();
		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();
		const bashTransition = this.#beginBashSessionTransition();

		// Fork the session (creates new session file with same entries)
		let forkResult: { oldSessionFile: string; newSessionFile: string } | undefined;
		try {
			forkResult = await this.sessionManager.fork();
		} catch (error) {
			this.#finishBashSessionTransition(bashTransition, false);
			throw error;
		}
		if (!forkResult) {
			this.#finishBashSessionTransition(bashTransition, false);
			return false;
		}
		this.#markBashSessionTransition(bashTransition);
		this.#finishBashSessionTransition(bashTransition, true);

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.#freshProviderSessionId = undefined;
		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		await this.#resetMemoryContextForNewTranscript();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	get activeModelRoute(): ActiveModelRoute | undefined {
		return this.#modelRouteLease.matchesModel(this.model) ? this.#modelRouteLease.active : undefined;
	}

	#modelRouteResolutionRequest(
		logicalModelId: string,
		overrides: ModelRouteResolutionRequest = {},
	): ModelRouteResolutionRequest {
		const group = this.#modelRegistry.getModelRouteRegistry().get(logicalModelId);
		const suppressedRouteIds = new Set(overrides.suppressedRouteIds ?? []);
		for (const route of group?.routes ?? []) {
			if (this.#modelRegistry.isSelectorSuppressed(route.modelSelector)) {
				suppressedRouteIds.add(route.id);
			}
		}
		const requiredContextTokens = Math.max(
			this.getContextUsage()?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
			this.#promptModelRouteRequirements?.requiredContextTokens ?? 0,
			overrides.requiredContextTokens ?? 0,
		);
		const historyRequiresImages = this.messages.some(
			message =>
				"content" in message &&
				Array.isArray(message.content) &&
				message.content.some(content => content.type === "image"),
		);
		return {
			requiredOutputTokens:
				overrides.requiredOutputTokens ??
				this.#promptModelRouteRequirements?.requiredOutputTokens ??
				this.agent.maxTokens,
			requiresImages:
				overrides.requiresImages ??
				(historyRequiresImages || this.#promptModelRouteRequirements?.requiresImages === true),
			requiresTools: this.agent.state.tools.length > 0,
			thinkingLevel: this.configuredThinkingLevel(),
			isAvailable: route =>
				this.#modelRegistry.isProviderEnabled(route.model.provider) &&
				this.#modelRegistry.find(route.model.provider, route.model.id) !== undefined,
			hasAuth: route => this.#modelRegistry.hasConfiguredAuth(route.model),
			...overrides,
			requiredContextTokens: requiredContextTokens > 0 ? requiredContextTokens : undefined,
			suppressedRouteIds: suppressedRouteIds.size > 0 ? suppressedRouteIds : undefined,
		};
	}

	#captureModelRouteTransition(): ModelRouteTransitionSnapshot {
		return {
			model: this.model,
			routeState: this.#modelRouteLease.captureState(),
			thinkingLevel: this.#thinkingLevel,
			autoThinking: this.#autoThinking,
			autoResolvedLevel: this.#autoResolvedLevel,
			baseSystemPrompt: [...this.#baseSystemPrompt],
			baseSystemPromptBeforeMemoryPromotion: this.#baseSystemPromptBeforeMemoryPromotion
				? [...this.#baseSystemPromptBeforeMemoryPromotion]
				: undefined,
			systemPrompt: [...this.agent.state.systemPrompt],
			lastAppliedToolSignature: this.#lastAppliedToolSignature,
			promptModelKey: this.#promptModelKey,
			inheritedProviderPromptCacheKey: this.#inheritedProviderPromptCacheKey,
			agentPromptCacheKey: this.agent.promptCacheKey,
		};
	}

	#restoreModelRouteTransition(snapshot: ModelRouteTransitionSnapshot): void {
		this.#modelRouteLease.restoreState(snapshot.routeState);
		if (snapshot.model) this.#setModelWithProviderSessionReset(snapshot.model);
		this.#thinkingLevel = snapshot.thinkingLevel;
		this.#autoThinking = snapshot.autoThinking;
		this.#autoResolvedLevel = snapshot.autoResolvedLevel;
		this.#applyThinkingLevelToAgent(snapshot.thinkingLevel);
		this.#baseSystemPrompt = snapshot.baseSystemPrompt;
		this.#baseSystemPromptBeforeMemoryPromotion = snapshot.baseSystemPromptBeforeMemoryPromotion;
		this.#lastAppliedToolSignature = snapshot.lastAppliedToolSignature;
		this.#promptModelKey = snapshot.promptModelKey;
		this.#inheritedProviderPromptCacheKey = snapshot.inheritedProviderPromptCacheKey;
		this.agent.promptCacheKey = snapshot.agentPromptCacheKey;
		this.agent.setSystemPrompt(snapshot.systemPrompt);
	}

	async #getRouteApiKeyRejection(
		selection: Pick<ModelRouteSelection, "route" | "model">,
	): Promise<{ available: boolean; rejection?: ModelRouteRuntimeRejection; error?: Error }> {
		try {
			const apiKey = await this.#modelRegistry.getApiKey(selection.model, this.sessionId);
			if (apiKey) return { available: true };
			const error = new Error(`No API key found for ${selection.model.provider}`);
			return {
				available: false,
				error,
				rejection: { routeId: selection.route.routeId, code: "api_key_unavailable", message: error.message },
			};
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
			return {
				available: false,
				error,
				rejection: { routeId: selection.route.routeId, code: "api_key_error", message: error.message },
			};
		}
	}

	async #emitModelRouteResolved(selection: ModelRouteSelection): Promise<void> {
		const reason = selection.reason === "failover" ? "recovery" : selection.reason;
		await this.#emitSessionEvent({
			type: "model_route_resolved",
			logicalModel: selection.route.logicalModelId,
			routeId: selection.route.routeId,
			model: selection.route.modelSelector,
			reason,
		});
	}

	async selectLogicalModel(
		logicalModelId: string,
		role: string = "default",
		options?: {
			thinkingLevel?: ConfiguredThinkingLevel;
			persist?: boolean;
			routeId?: string;
		},
	): Promise<{ switched: boolean; route: ActiveModelRoute }> {
		if (!this.settings.get("routing.enabled")) {
			throw new Error(`Logical model routing is disabled; cannot select "${logicalModelId}"`);
		}
		const registry = this.#modelRegistry.getModelRouteRegistry();
		if (!registry.has(logicalModelId)) {
			throw new Error(`Unknown logical model "${logicalModelId}"`);
		}

		const previousRoute = this.#modelRouteLease.snapshot();
		const transitionSnapshot = this.#captureModelRouteTransition();
		const affinityRouteId =
			options?.routeId === undefined && previousRoute?.logicalModelId === logicalModelId
				? previousRoute.routeId
				: undefined;
		const request = this.#modelRouteResolutionRequest(logicalModelId, {
			...(options?.routeId !== undefined && { manualRouteId: options.routeId }),
			...(affinityRouteId !== undefined && { affinityRouteId }),
			thinkingLevel: options?.thinkingLevel ?? this.configuredThinkingLevel(),
		});
		const selection = this.#modelRouteLease.select(logicalModelId, role, request);
		if (!selection) {
			const failedResolution = registry.resolve(logicalModelId, request);
			if (!failedResolution) throw new Error(`Unknown logical model "${logicalModelId}"`);
			throw new Error(formatLogicalRouteFailure(failedResolution));
		}

		const previousEditMode = this.#resolveActiveEditMode();
		let targetModel: Model;
		try {
			targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(selection.model);
			this.#setModelWithProviderSessionReset(targetModel);
			await this.#syncAfterModelChange(previousEditMode);
		} catch (error) {
			this.#restoreModelRouteTransition(transitionSnapshot);
			throw error;
		}

		this.#clearActiveRetryFallback();
		this.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, role, {
			logicalModel: logicalModelId,
			routeId: selection.route.routeId,
		});
		if (options?.persist) {
			this.settings.setModelRole(role, formatModelSelectorValue(logicalModelId, options.thinkingLevel));
		}
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		if (options?.thinkingLevel !== undefined) {
			this.setThinkingLevel(options.thinkingLevel);
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		await this.#emitModelRouteResolved(selection);
		return { switched: true, route: selection.route };
	}

	/**
	 * Set model directly.
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs). Active switches
	 * always take effect; if the current transcript is too large for the target
	 * model, the next prompt's compaction/error path owns that recovery instead
	 * of leaving the session pinned to the old model.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
			currentContextTokens?: number;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(model);

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#clearActiveRetryFallback();
		this.#modelRouteLease.clear();
		this.#setModelWithProviderSessionReset(targetModel);
		this.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, role);
		if (options?.persist) {
			this.settings.setModelRole(
				role,
				this.#formatRoleModelValue(role, targetModel, options.selector, options.thinkingLevel),
			);
		}
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		await this.#syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(model);

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#clearActiveRetryFallback();
		this.#modelRouteLease.clear();
		this.#setModelWithProviderSessionReset(targetModel);
		this.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		await this.#syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				logicalModelId: resolved.logicalModelId,
				routeId: resolved.routeId,
			});
		}

		if (models.length === 0) return undefined;

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		if (entry.logicalModelId) {
			await this.selectLogicalModel(entry.logicalModelId, entry.role, {
				routeId: entry.routeId,
				thinkingLevel: entry.explicitThinkingLevel ? entry.thinkingLevel : undefined,
			});
			return;
		}
		await this.setModel(entry.model, entry.role);
		if (entry.explicitThinkingLevel && entry.thinkingLevel !== undefined) {
			this.setThinkingLevel(entry.thinkingLevel);
		}
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#clearActiveRetryFallback();
		this.#modelRouteLease.clear();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level, preserving auto.
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : next.thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#clearActiveRetryFallback();
		this.#modelRouteLease.clear();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#modelRegistry.getAvailable();
		const patterns = this.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.settings, this.#modelRegistry);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.agent.setThinkingLevel(toReasoningEffort(level));
		this.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. `auto` enables per-turn classification; the selector
	 * itself is never written to the session log, but resolved concrete levels are
	 * persisted when real user turns are classified so resumed sessions keep the
	 * last resolved effort instead of reverting to pending auto.
	 */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist: boolean = false): void {
		if (level === AUTO_THINKING) {
			const provisional = resolveProvisionalAutoLevel(this.model);
			const wasAuto = this.#autoThinking;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			if (!wasAuto) {
				this.#clearInheritedProviderPromptCacheKey();
			}
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				this.settings.set("defaultThinkingLevel", AUTO_THINKING);
			}
			if (!wasAuto || this.#thinkingLevel !== provisional) {
				this.#emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
			}
			return;
		}

		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging) {
			this.#clearInheritedProviderPromptCacheKey();
			this.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.settings.set("defaultThinkingLevel", effectiveLevel);
			}
			this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/**
	 * Re-apply the active thinking selection after a model change. Preserves `auto`
	 * (re-clamping the provisional level to the new model); otherwise re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel): void {
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : (preferredDefault ?? this.#thinkingLevel));
	}

	/**
	 * Cycle to next thinking level: off → auto → every model-supported effort → off.
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		if (!this.model?.reasoning) return undefined;

		const levels: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Off,
			AUTO_THINKING,
			...this.getAvailableThinkingLevels(),
		];
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * Bounded by a timeout + abort; on any failure (no smol model, timeout, parse
	 * error) it falls back to the provisional concrete level and continues. Never
	 * throws into the turn, and never clears `#autoThinking` (auto stays active).
	 */
	async #applyAutoThinkingLevel(promptText: string, generation: number): Promise<void> {
		const model = this.model;
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// and jump straight to the highest auto-supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.Ultra);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), AgentSession.#AUTO_THINKING_TIMEOUT_MS);
			try {
				resolved = await classifyDifficulty(promptText, {
					settings: this.settings,
					registry: this.#modelRegistry,
					model,
					sessionId: this.sessionId,
					signal: controller.signal,
					metadataResolver: provider => this.agent.metadataForProvider(provider),
				});
			} catch (error) {
				logger.debug("auto-thinking: classification failed; using fallback level", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#promptGeneration !== generation || !this.#autoThinking) return;

		const effort = resolved ?? resolveProvisionalAutoLevel(model);
		if (effort === undefined) return;
		const shouldPersistResolution = this.#autoResolvedLevel !== effort;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			this.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.model;
		return !!model && realizesPriorityServiceTier(this.#effectiveServiceTier(model), model);
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	#effectiveServiceTier(model: Model | undefined = this.model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	#serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.sessionManager.appendServiceTierChange(this.#serviceTierEntry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. Returns `false` when the model
	 * has no service-tier family, so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		if (!family) {
			this.emitNotice("info", "The current model has no service-tier control for /fast to toggle.", "priority");
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] === "priority") this.setServiceTierFamily(family, undefined);
			return true;
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Append plan-read protection to a prune/shake config so the active plan
	 * file survives compaction alongside skill reads (the config defaults
	 * already carry skill protection). The matcher reads the current plan
	 * reference path at match time, so retitled plans are covered.
	 */
	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#planReferencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Per-turn stale-result pass: prune older `read` results that a newer read
	 * of the same file has made stale, plus results their tool flagged
	 * contextually useless. Cache-aware (only fires when the suffix after a
	 * candidate is small or the session has been idle long enough that the
	 * provider prompt cache is cold), so it is cheap to run every turn. Gated
	 * on the `compaction.supersedeReads` and `compaction.dropUseless` settings.
	 *
	 * Persists via `rewriteEntries` like every other history rewrite — the
	 * session file must match the live (pruned) context or file-based forks
	 * (`/fork`, `/tan`) and resume rebuild a divergent prefix and cold-miss the
	 * provider prompt cache.
	 */
	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const { supersedeReads, dropUseless } = this.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Strip image content blocks from every message on the current branch and
	 * persist the rewrite. Walks `SessionManager.getBranch()` in place — both
	 * `SessionMessageEntry.message` and `CustomMessageEntry.content` arrays
	 * are mutated, then `rewriteEntries` durably commits the new shape. The
	 * agent's runtime view is rebuilt from the freshly-mutated entries so any
	 * provider sessions caching message identity (Codex Responses) are torn
	 * down to force a clean replay on the next turn.
	 *
	 * No-op when the branch carries no images; returns `{ removed: 0 }` and
	 * skips the disk rewrite.
	 */
	async dropImages(): Promise<{ removed: number }> {
		const branchEntries = this.sessionManager.getBranch();
		let removed = 0;
		for (const entry of branchEntries) {
			if (entry.type === "message") {
				removed += stripImagesFromMessage(entry.message);
				continue;
			}
			if (entry.type === "custom_message" && typeof entry.content !== "string") {
				const kept: typeof entry.content = [];
				let dropped = 0;
				for (const part of entry.content) {
					if (part.type === "image") {
						dropped++;
					} else {
						kept.push(part);
					}
				}
				if (dropped > 0) {
					if (kept.length === 0) {
						kept.push({ type: "text", text: "[image removed]" });
					}
					entry.content = kept;
					removed += dropped;
				}
			}
		}
		if (removed === 0) {
			return { removed: 0 };
		}
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return { removed };
	}

	/**
	 * Surgically reduce context by dropping heavy content ("shake").
	 *
	 * - `images` delegates to {@link dropImages}.
	 * - `elide` replaces whole tool-call results and large fenced/XML blocks
	 *   with short placeholders that embed an `artifact://` recovery link.
	 *
	 * Mutates the branch in place, persists via `rewriteEntries`, replays the
	 * rebuilt context through the agent, and tears down provider sessions that
	 * cache message identity — same rewrite contract as {@link dropImages}.
	 *
	 * No-op (zero counts) when nothing is eligible.
	 */
	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			// Skip entries summarized away by the latest compaction — shaking them
			// only churns persisted history with no prompt/cache effect.
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});
		const regions = collectShakeRegions(branchEntries, config);
		if (regions.length === 0) {
			return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		}

		const artifactId = await this.#saveShakeArtifact(regions);
		const replacements = regions.map((region, index) => this.#shakeElidePlaceholder(region, index, artifactId));

		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = replacements[index];
			if (replacement.length > 0) replacementTokens += countTokens(replacement);
			return { region, replacement };
		});

		applyShakeRegions(items);

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return {
			mode,
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	#shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
		if (artifactId) {
			return `[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`;
		}
		return `[shaken ~${region.tokens} tokens]`;
	}

	/**
	 * Concatenate the original region contents into one session artifact so the
	 * agent can read them back via `artifact://<id>`. Returns `undefined` when
	 * the session is not persisted or the write fails — callers degrade to a
	 * bare placeholder.
	 */
	async #saveShakeArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.sessionManager.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		// Resolve the `/compact <mode>` subcommand up front so input validation
		// runs before we disconnect/abort the active agent operation below.
		const compactMode = options?.mode ? findCompactMode(options.mode) : undefined;
		// Modes that produce no LLM summary (snapcompact) have nothing to focus.
		// Reject focus text loudly so programmatic callers don't silently lose
		// instructions (the slash path pre-validates via parseCompactArgs).
		// `internalGuidance` counts the same way — plan-mode approval never
		// combines with a rejects-focus mode, but reject early if a caller ever
		// wires it up so we don't silently drop the directive on the snapcompact
		// fallback (issue #4359).
		if (compactMode?.rejectsFocus && (customInstructions || options?.internalGuidance)) {
			throw new Error(`/compact ${compactMode.name} does not take focus instructions.`);
		}
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;
		let probeMaintenanceDecision: ContextProbeMaintenanceDecision | undefined;
		const updateProbeMaintenanceAction = (action: ContextProbeMaintenanceDecision["action"]): void => {
			if (!probeMaintenanceDecision) return;
			probeMaintenanceDecision = { ...probeMaintenanceDecision, action };
			this.#contextProbeActiveMaintenanceDecision = probeMaintenanceDecision;
		};

		try {
			this.#disconnectFromAgent();
			await this.abort({ goalReason: "internal", preserveCompaction: true });
			if (!this.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.settings.getGroup("compaction");
			// The `/compact <mode>` override (resolved above) replaces the configured
			// strategy/remote flags for this one invocation. Merged before
			// prepareCompaction so the remote gating (preparation.settings.
			// remoteEnabled/endpoint) and the snapcompact decision below both see it.
			const effectiveSettings = compactMode
				? { ...compactionSettings, ...compactMode.overrides }
				: compactionSettings;
			// /compact remote demands provider-native compaction. When no remote
			// endpoint is configured (one would override per-model gating in
			// compact()), drop fallback candidates that aren't remote-capable so the
			// engine never silently runs a local summary on a configured-but-non-
			// remote compactionModel. If filtering empties the chain, warn and fall
			// back to the full chain so the operation still completes.
			const availableModels = this.#modelRegistry.getAvailable();
			const requireProviderRemote = Boolean(compactMode?.requiresRemote && !effectiveSettings.remoteEndpoint);
			let compactionCandidates = this.#getCompactionModelCandidates(
				availableModels,
				requireProviderRemote ? shouldUseOpenAiRemoteCompaction : undefined,
			);
			if (requireProviderRemote && compactionCandidates.length === 0) {
				this.emitNotice(
					"warning",
					`remote compaction is unavailable for ${this.model.id} (no remote endpoint configured and no provider-native remote-capable model in the fallback chain) — using a local summary instead`,
					"compaction",
				);
				compactionCandidates = this.#getCompactionModelCandidates(availableModels);
			}
			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(
				pathEntries,
				effectiveSettings,
				await this.#runnableCompactionCandidates(compactionCandidates, this.sessionId),
			);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}
			probeMaintenanceDecision = {
				maintenanceId: `maintenance_${crypto.randomUUID().slice(-12)}`,
				primaryTrigger: "manual",
				matchedTriggers: ["manual"],
				action:
					effectiveSettings.strategy === "snapcompact" && !customInstructions && !options?.internalGuidance
						? "snapcompact"
						: "context-full",
			};
			this.#contextProbeActiveMaintenanceDecision = probeMaintenanceDecision;
			this.#contextProbeActiveCompaction = { tokensBefore: preparation.tokensBefore };

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					updateProbeMaintenanceAction("none");
					throw new CompactionCancelledError();
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			// Strategy honored on manual /compact too. Custom instructions (public
			// user focus OR internal plan-mode guidance) imply a directed LLM
			// summary; a text-only model cannot read snapcompact frames.
			const wantsSnapcompact =
				compactionPrep.kind !== "fromHook" &&
				effectiveSettings.strategy === "snapcompact" &&
				!customInstructions &&
				!options?.internalGuidance;
			// `/compact snapcompact` is an explicit no-LLM archive request: honor
			// its contract by failing locally rather than silently shipping the
			// transcript to a provider. The default-configured snapcompact
			// strategy, in contrast, falls back to LLM compaction (mirroring the
			// auto-compaction path) so a routine /compact still completes on a
			// text-only model (issue #5064).
			const explicitSnapcompact = compactMode?.name === "snapcompact";
			let snapcompactReady = wantsSnapcompact;
			const snapcompactShapeSetting = this.settings.get("snapcompact.shape");
			let snapcompactShape: snapcompact.Shape | undefined;
			if (wantsSnapcompact && !this.model.input.includes("image")) {
				if (explicitSnapcompact) {
					this.emitNotice(
						"warning",
						`snapcompact needs a vision-capable model (${this.model.id} is text-only)`,
						"compaction",
					);
					throw new Error(`snapcompact cannot run locally: ${this.model.id} is text-only.`);
				}
				this.emitNotice(
					"warning",
					`snapcompact needs a vision-capable model (${this.model.id} is text-only); using an LLM context-full fallback`,
					"compaction",
				);
				snapcompactReady = false;
				updateProbeMaintenanceAction("context-full");
			} else if (snapcompactReady) {
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				snapcompactShape = snapcompact.resolveShapeForText(probeText, this.model, snapcompactShapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape: snapcompactShape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					this.emitNotice(
						"warning",
						`snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%). No LLM fallback was attempted.`,
						"compaction",
					);
					throw new Error(
						`snapcompact cannot render this conversation locally: unsupported characters for selected snapcompact font (${percent}%).`,
					);
				}
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let codexCompaction: CodexCompactionContext | undefined;
			let summarySource: ContextSummarySource | undefined;

			// Snapcompact runs locally first. The frame cap is sized from the live
			// model window via #computeSnapcompactMaxFrames so the post-render context
			// fits without the warning loop (issue #3247). Zero-frame budget now fails
			// the snapcompact request locally rather than falling back to an LLM call.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			if (snapcompactReady) {
				const maxFrames = this.#computeSnapcompactMaxFrames(preparation, effectiveSettings);
				if (maxFrames < 1) {
					logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
						model: this.model?.id,
					});
					this.emitNotice(
						"warning",
						"snapcompact: kept history alone exceeds the context budget. No LLM fallback was attempted.",
						"compaction",
					);
					throw new Error("snapcompact cannot run locally: kept history alone exceeds the context budget.");
				} else {
					const shape = snapcompactShape;
					if (!shape) {
						throw new Error("snapcompact shape was not resolved before rendering.");
					}
					snapcompactResult = await snapcompact.compact(preparation, {
						convertToLlm,
						model: this.model,
						...(snapcompactShapeSetting === "auto" ? {} : { shape }),
						maxFrames,
					});
					const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
					if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
						logger.warn("Snapcompact exceeded the per-request frame payload budget", {
							model: this.model?.id,
							framePayloadBytes,
							budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
						});
						this.emitNotice(
							"warning",
							"snapcompact produced too much standing image payload. No LLM fallback was attempted.",
							"compaction",
						);
						throw new Error(
							"snapcompact cannot run locally: standing image payload exceeds the per-request budget.",
						);
					}
					const ctxWindow = this.model?.contextWindow ?? 0;
					const budget =
						ctxWindow > 0
							? ctxWindow - effectiveReserveTokens(ctxWindow, effectiveSettings)
							: Number.POSITIVE_INFINITY;
					if (this.#projectSnapcompactContextTokens(preparation, snapcompactResult) > budget) {
						logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
							model: this.model?.id,
						});
						this.emitNotice(
							"warning",
							"snapcompact could not bring the context under the limit. No LLM fallback was attempted.",
							"compaction",
						);
						throw new Error("snapcompact could not bring the context under the limit locally.");
					}
				}
			}

			if (compactionPrep.kind === "fromHook") {
				updateProbeMaintenanceAction("context-full");
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(snapcompactResult.preserveData ?? {}) };
			} else {
				codexCompaction = createCodexCompactionContext({
					trigger: "manual",
					reason: "user_requested",
					phase: "standalone_turn",
				});
				// Generate compaction result. Only convert known abort-shaped
				// rejections (AbortError raised while the abort signal is set,
				// or an already-typed sentinel) into `CompactionCancelledError`
				// so downstream callers can discriminate cancel from generic
				// failure via `instanceof` without inspecting message strings.
				// Real compaction bugs (network, server, parsing, etc.) keep
				// their original shape — they must not be silently relabeled
				// as cancellations even if the signal happens to be aborted
				// for an unrelated reason. Assignments live inside the try
				// block because every catch path throws — the post-try reads
				// of the result-derived locals are reachable only on success.
				try {
					const result = await this.#compactWithFallbackModel(
						preparation,
						options?.internalGuidance ?? customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
							extraContext: compactionPrep.hookContext,
							remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
							convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
							codexCompaction,
						},
						compactionCandidates,
					);
					summary = result.summary;
					shortSummary = result.shortSummary;
					firstKeptEntryId = result.firstKeptEntryId;
					tokensBefore = result.tokensBefore;
					details = result.details;
					preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, result.preserveData);
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						throw err;
					}
					if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			summarySource = fromExtension
				? "extension"
				: snapcompactResult
					? "snapcompact"
					: effectiveSettings.remoteEndpoint || preserveData?.openaiRemoteCompaction
						? "remote"
						: "local";
			if (summarySource === "remote") updateProbeMaintenanceAction("remote_compaction");
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore,
				summarySource,
			};
			const continuationState = buildActiveContinuationState({
				entries: pathEntries,
				sessionId: this.sessionId,
				promptGeneration: this.#promptGeneration,
			});
			const authorityResolution = await this.#enforceContextSummaryAuthority({
				summary,
				...(shortSummary ? { shortSummary } : {}),
				summarySource,
				continuationState,
				...(compactionPrep.kind === "needsLlm" && !snapcompactResult
					? {
							repair: () =>
								this.#compactWithFallbackModel(
									preparation,
									COMPACTION_SUMMARY_REPAIR_INSTRUCTIONS,
									compactionAbortController.signal,
									{
										promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
										extraContext: compactionPrep.hookContext,
										remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
										convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
										codexCompaction,
									},
									compactionCandidates,
								),
						}
					: {}),
			});
			summary = authorityResolution.summary;
			shortSummary = authorityResolution.shortSummary;
			const summaryAuthority = authorityResolution.audit;
			summarySource = summaryAuthority.summarySource;
			if (authorityResolution.replacement) {
				const replacement = authorityResolution.replacement;
				firstKeptEntryId = replacement.firstKeptEntryId;
				tokensBefore = replacement.tokensBefore;
				details = replacement.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, replacement.preserveData);
			}
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore,
				...(summarySource ? { summarySource } : {}),
			};

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			if (continuationState) {
				appendActiveContinuationState(this.sessionManager, {
					...continuationState,
					...(summaryAuthority ? { summaryAuthority } : {}),
				});
			}
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore,
				tokensAfter: this.#estimateStoredContextTokens(),
				...(summarySource ? { summarySource } : {}),
			};
			this.#rebasePendingContextSnapshotAfterCompaction();
			// The active request plan may remain available for the next provider
			// call to detect the rewrite, but the idle snapshot is no longer valid.
			this.#contextSteadyLastPlan = undefined;
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (
				probeMaintenanceDecision &&
				this.#contextProbeActiveMaintenanceDecision?.maintenanceId === probeMaintenanceDecision.maintenanceId
			) {
				this.#recordContextMaintenanceProbe(
					this.#contextProbeActiveMaintenanceDecision,
					this.#contextProbeActiveCompaction,
				);
				this.#contextProbeActiveMaintenanceDecision = undefined;
				this.#contextProbeActiveCompaction = undefined;
			}
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.settings, this);
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(reason?: Error): void {
		this.#handoffAbortController?.abort(reason);
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document from the current conversation without switching sessions.
	 *
	 * Used both by the local `/handoff` flow and by cross-session handoff delivery.
	 * The source session remains active and unchanged.
	 */
	async generateHandoffDocument(customInstructions?: string, sourceSignal?: AbortSignal): Promise<string | undefined> {
		// `session_handoff` invokes this method from inside its own tool call. Wait
		// for the fire-and-forget message_end listener, then rebuild from the
		// journal: the normal provider-context builder strips that still-dangling
		// `session_handoff` tool_use while preserving any text in the turn. Using
		// live agent state here would make the side request synthesize a misleading
		// "No result provided" failure for the very handoff being generated.
		await this.#waitForMessageEndPersistence();
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;
		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}
		if (this.#handoffAbortController) {
			throw new Error("Handoff generation is already in progress");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort(sourceSignal?.reason);
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			throwIfHandoffAborted(handoffSignal);

			const model = this.model;
			if (!model) {
				throw new Error("No model selected for handoff");
			}
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = this.sessionId;
			// The loop sends `promptCacheKey` (providerPromptCacheKey) and falls back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from this.sessionId (tan/subagent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
			const handoffPromptCacheKey = this.agent.promptCacheKey ?? this.agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(this.#obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...this.buildDisplaySessionContext().messages,
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffLlmMessages = await this.convertMessagesToLlm(handoffSnapshot, handoffSignal);
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the handoff seeds another session and must not carry prompt-specific
			// hook state. Matches the prompt the old handoff path sent.
			const handoffContext = await this.agent.buildSideRequestContext(handoffLlmMessages, this.#baseSystemPrompt);
			const handoffStreamOptions = this.prepareSimpleStreamOptions(
				{
					apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
					sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
					promptCacheKey: handoffPromptCacheKey,
					preferWebsockets: false,
					serviceTier: this.#effectiveServiceTier(model),
					hideThinkingSummary: this.agent.hideThinkingSummary,
					initiatorOverride: "agent",
					signal: handoffSignal,
				},
				model.provider,
			);
			const rawHandoffText = await generateHandoffFromContext(
				obfuscateProviderContext(this.#obfuscator, handoffContext),
				model,
				{
					streamOptions: handoffStreamOptions,
					completeImpl: async (requestModel, requestContext, requestOptions) => {
						const stream = await this.#sideStreamFn(requestModel, requestContext, requestOptions);
						return stream.result();
					},
					telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
					// Honor the user's /model thinking selection on the handoff path.
					// Clamped per-model inside generateHandoffFromContext via
					// resolveCompactionEffort so unsupported-effort models don't trip
					// requireSupportedEffort.
					thinkingLevel: this.thinkingLevel,
				},
			);
			const handoffText = this.#deobfuscateFromProvider(rawHandoffText);

			throwIfHandoffAborted(handoffSignal);
			return handoffText || undefined;
		} catch (error) {
			throwIfHandoffAborted(handoffSignal);
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const continuationState = buildActiveContinuationState({
			entries,
			sessionId: this.sessionId,
			promptGeneration: this.#promptGeneration,
		});
		const handoffText = await this.generateHandoffDocument(customInstructions, options?.signal);
		if (!handoffText || handoffText.trim().length === 0) {
			logger.warn("Handoff generation produced no content", {
				sessionId: this.sessionId,
				autoTriggered: options?.autoTriggered ?? false,
			});
			// 自动 handoff 是 best-effort：返回 undefined 让既有 maintenance
			// 流程回退到 context-full；手动命令必须显式暴露真实失败。
			if (options?.autoTriggered) return undefined;
			throw new Error("Handoff generation produced no content");
		}

		// Start a new session
		const previousSessionFile = this.sessionFile;
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "handoff",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				options?.onSwitchCancelled?.();
				return undefined;
			}
		}
		await this.#flushPendingBashMessages();
		await this.sessionManager.flush();
		const bashTransition = this.#beginBashSessionTransition();
		this.#cancelOwnAsyncJobs();
		let sessionTransitioned = false;
		try {
			await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);
			this.#markBashSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#finishBashSessionTransition(bashTransition, sessionTransitioned);
		}

		this.#clearCheckpointRuntimeState();
		// agent.reset() clears the core steering/follow-up queues. Preserve any queued
		// steers/follow-ups (RPC/SDK steer()/followUp() issued during the handoff, or a
		// pre-loader TUI steer) so they survive into the post-handoff session instead of
		// being silently dropped. Capture is synchronous immediately before reset and
		// restore is synchronous immediately after — no await gap — so a steer arriving
		// later (during ensureOnDisk/Bun.write below) appends to the restored queue
		// rather than being clobbered.
		const preservedSteering = this.agent.peekSteeringQueue().slice();
		const preservedFollowUp = this.agent.peekFollowUpQueue().slice();
		this.agent.reset();
		this.#resetAnnouncedMounts();
		this.agent.replaceQueues(preservedSteering, preservedFollowUp);
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		await this.#resetMemoryContextForNewTranscript();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.#todoReminderCount = 0;
		this.#todoReminderAwaitingProgress = false;
		this.#mutationsSinceLastTodoTouch = 0;
		this.#midRunNudgeCount = 0;

		// Inject the handoff document as a custom message
		const handoffContent = createHandoffContext(handoffText);
		this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
		if (continuationState) {
			appendActiveContinuationState(
				this.sessionManager,
				rebaseActiveContinuationState(continuationState, {
					sessionId: this.sessionId,
					promptGeneration: this.#promptGeneration,
				}),
			);
		}
		await this.sessionManager.ensureOnDisk();
		let savedPath: string | undefined;
		if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
			const artifactsDir = this.sessionManager.getArtifactsDir();
			if (artifactsDir) {
				const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
				try {
					await Bun.write(handoffFilePath, `${handoffText}\n`);
					savedPath = handoffFilePath;
				} catch (error) {
					logger.warn("Failed to save handoff document to disk", {
						path: handoffFilePath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} else {
				logger.debug("Skipping handoff document save because session is not persisted");
			}
		}

		// Rebuild agent messages from session
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#syncTodoPhasesFromBranch();
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "handoff",
				previousSessionFile,
			});
		}

		return { document: handoffText, savedPath };
	}

	/**
	 * Local token estimate of the stored conversation (plus any pending messages),
	 * independent of provider-reported usage. A `before_provider_request` hook
	 * (e.g. a compression extension such as Headroom) or other on-wire payload
	 * transform can shrink the request below the real stored conversation; the
	 * provider then reports deflated prompt tokens, so anchoring the compaction
	 * decision purely on that usage lets the real history grow unbounded until it
	 * overflows and native compaction can no longer run. This estimate is the
	 * floor the compaction decision respects so on-wire compression can never
	 * suppress it.
	 */
	async #completeSideRequestWithProbe<TApi extends AssistantMessage["api"]>(
		requestKind: Exclude<ContextProbeRequestKind, "agent" | "maintenance">,
		model: Model<TApi>,
		context: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> {
		const stream = await this.#sideStreamFn(model, context, options);
		const assistant = await stream.result();
		if (requestKind === "compaction" && this.#contextProbeActiveCompaction) {
			const usage = assistant.usage;
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				summaryInputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
				summaryOutputTokens: usage.output,
			};
		}
		this.#recordContextProbe(assistant, requestKind, model.contextWindow);
		return assistant;
	}

	#recordContextProbe(
		assistant: AssistantMessage,
		requestKind: Exclude<ContextProbeRequestKind, "maintenance">,
		requestContextWindow?: number | null,
	): void {
		const snapshot = this.#buildContextProbeSnapshot(requestContextWindow);
		if (!snapshot) return;
		const record = buildContextProbeRecord({
			...snapshot.options,
			requestKind,
			assistant,
		});
		this.#queueContextProbeRecord(snapshot.sessionFile, record);
	}

	#buildContextProbeSnapshot(requestContextWindow?: number | null): ContextProbeSnapshot | undefined {
		if (this.settings.get("san.contextSteady.probe.enabled") !== true) return;
		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const branch = this.sessionManager.getBranch();
		const compactionIds = branch.filter(entry => entry.type === "compaction").map(entry => entry.id);
		const segmentIds = collectContextSegmentRefs(branch).map(ref => ref.segment.segmentId);
		const contextWindow = requestContextWindow ?? this.model?.contextWindow ?? 0;
		const activeEstimatedTokens = this.#estimateStoredContextTokens();
		const rawJournalEstimatedTokens =
			computeNonMessageTokens(this) +
			branch.reduce(
				(sum, entry) =>
					entry.type === "message" ? sum + this.#estimateProviderWireMessageTokens(entry.message) : sum,
				0,
			);
		const compactionSettings = this.settings.getGroup("compaction");
		const nativeCompactionThresholdTokens =
			contextWindow > 0 ? resolveThresholdTokens(contextWindow, compactionSettings) : 0;
		const configuredSteadyTarget = Math.floor(this.settings.get("san.contextSteady.qualityWindowTokens") as number);
		const steadyTargetTokens =
			contextWindow > 0 ? Math.min(contextWindow, configuredSteadyTarget > 0 ? configuredSteadyTarget : 240_000) : 0;
		const prefixFingerprint = String(
			Bun.hash(
				JSON.stringify({
					model: this.model ? `${this.model.provider}/${this.model.id}` : "none",
					promptModelKey: this.#promptModelKey,
					baseSystemPrompt: this.#baseSystemPrompt,
					toolSignature: this.#lastAppliedToolSignature,
					contextPlan: this.#contextSteadyRequestPlan?.renderedContent,
					latestCompactionId: compactionIds.at(-1),
				}),
			),
		);
		const authorityState = findLatestActiveContinuationState(branch);
		const options: BuildContextProbeSnapshotOptions = {
			sessionId: this.sessionId,
			sessionFile,
			contextWindow,
			steadyEnabled: this.settings.get("san.contextSteady.enabled") === true,
			activeEstimatedTokens,
			rawJournalEstimatedTokens,
			nativeCompactionStrategy: compactionSettings.strategy,
			nativeCompactionThresholdTokens,
			steadyTargetTokens,
			compactionIds,
			segmentIds,
			prefixFingerprint,
			...(this.#contextProbeActiveMaintenanceDecision
				? { maintenanceDecision: this.#contextProbeActiveMaintenanceDecision }
				: {}),
			...(this.#contextProbeActiveCompaction ? { compaction: this.#contextProbeActiveCompaction } : {}),
			...(authorityState ? { authorityState } : {}),
			...(this.#toolProgressGuard ? { convergence: this.#toolProgressGuard.snapshot() } : {}),
			...(this.#contextProbeLastPrefixFingerprint?.sessionId === this.sessionId
				? { previousPrefixFingerprint: this.#contextProbeLastPrefixFingerprint.value }
				: {}),
		};
		this.#contextProbeLastPrefixFingerprint = { sessionId: this.sessionId, value: prefixFingerprint };
		return { sessionFile, options };
	}

	#recordContextMaintenanceProbe(
		maintenanceDecision: ContextProbeMaintenanceDecision,
		compaction?: ContextProbeCompactionObservation,
	): void {
		const snapshot = this.#buildContextProbeSnapshot();
		if (!snapshot) return;
		const model = this.model;
		const record = buildContextMaintenanceProbeRecord({
			...snapshot.options,
			maintenanceDecision,
			...(compaction ? { compaction } : {}),
			model: model ? { provider: model.provider, id: model.id } : { provider: "none", id: "none" },
		});
		this.#queueContextProbeRecord(snapshot.sessionFile, record);
	}

	#queueContextProbeRecord(sessionFile: string, record: ContextProbeRecord): void {
		const probeFile = contextProbeFilePath(sessionFile);
		const write = this.#contextProbeWrite.then(() => appendContextProbeRecord(sessionFile, record));
		this.#contextProbeWrite = write.catch(error => {
			logger.warn("Failed to append context probe record", {
				sessionId: record.sessionId,
				probeFile,
				error: String(error),
			});
		});
	}

	#estimateStoredContextTokens(pendingMessages: readonly AgentMessage[] = []): number {
		// Exclude encrypted reasoning (thinkingSignature / redactedThinking): its
		// local byte size diverges from what the provider bills, so counting it here
		// would let a thinking-heavy turn falsely trip the floor. The provider usage
		// (the other arm of compactionContextTokens) already accounts for it.
		const opts = { excludeEncryptedReasoning: true } as const;
		const activeMessages = [...this.messages, ...pendingMessages];
		const plan = this.#contextSteadyActivePlan();
		return (
			computeNonMessageTokens(this) +
			(plan
				? estimateContextPlanProjectedTokens(activeMessages, this.sessionManager.getBranch(), plan, message =>
						this.#estimateProviderWireMessageTokens(message, opts),
					)
				: activeMessages.reduce((sum, message) => sum + estimateTokens(message, opts), 0))
		);
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
		const localEstimate = this.#estimateStoredContextTokens(messages);
		// Floor by the local estimate: a payload-shrinking before_provider_request
		// hook deflates the provider-anchored breakdown, which must not suppress
		// pre-prompt compaction (see #estimateStoredContextTokens).
		return compactionContextTokens(breakdown?.usedTokens ?? 0, localEstimate);
	}

	async #runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.settings.getGroup("compaction");
		const contextTokens = this.#estimatePrePromptContextTokens(messages, contextWindow);
		this.#contextSteadyIsActive(contextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact (snapcompact/summary) a session that should have just been promoted.
		if (await this.#promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			phase: "pre_turn",
		});
	}

	#contextSteadySegmentTokenThreshold(): number {
		const configured = Math.max(0, Math.floor(this.settings.get("san.contextSteady.segment.maxTokens") as number));
		if (configured > 0) return configured;

		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return 40_000;
		const compactionSettings = this.settings.getGroup("compaction");
		const nativeThreshold = resolveThresholdTokens(contextWindow, compactionSettings);
		const configuredSteadyTarget = this.settings.get("san.contextSteady.qualityWindowTokens") as number;
		const steadyTarget = Math.max(
			1,
			Math.min(
				contextWindow,
				configuredSteadyTarget > 0 ? configuredSteadyTarget : 240_000,
				this.#contextSteadyBurstWindowTokens(),
			),
		);
		const physicalTarget = Math.min(steadyTarget, nativeThreshold);
		const messageBudget = Math.max(0, physicalTarget - computeNonMessageTokens(this));
		return Math.min(64_000, Math.max(8_000, Math.floor(messageBudget * 0.2)));
	}

	#hasQueuedUserMessage(): boolean {
		return (
			this.#pendingUserMessageEnqueueCount > 0 ||
			this.agent.peekSteeringQueue().some(isUserQueuedMessage) ||
			this.agent.peekFollowUpQueue().some(isUserQueuedMessage)
		);
	}

	#continuationAuthoritySourceMissing(): boolean {
		return isContinuationAuthoritySourceMissing(this.sessionManager.getBranch());
	}

	#contextSteadySegmentMaintenanceHint(): {
		required: boolean;
		tokenHint: boolean;
		durationHint: boolean;
		tokens: number;
		elapsedMs: number;
		boundaryId: string;
	} {
		if (!this.#contextSteadyIsActive() || this.settings.get("san.contextSteady.segment.enabled") !== true) {
			return { required: false, tokenHint: false, durationHint: false, tokens: 0, elapsedMs: 0, boundaryId: "none" };
		}
		const entries = this.sessionManager.getBranch();
		let userIndex = -1;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry && isAuthoritativeUserEntry(entry)) {
				userIndex = index;
				break;
			}
		}
		if (userIndex < 0) {
			return { required: false, tokenHint: false, durationHint: false, tokens: 0, elapsedMs: 0, boundaryId: "none" };
		}

		const latestSegment = collectContextSegmentRefs(entries).at(-1);
		const latestSegmentIndex = latestSegment ? entries.findIndex(entry => entry.id === latestSegment.entryId) : -1;
		const boundaryIndex = latestSegmentIndex > userIndex ? latestSegmentIndex : userIndex - 1;
		const estimates = this.#contextSteadyTokenEstimateByEntryRef(entries);
		let tokens = 0;
		for (const entry of entries.slice(boundaryIndex + 1)) tokens += estimates.get(entry.id) ?? 0;

		const startedAt =
			latestSegmentIndex > userIndex ? latestSegment?.segment.createdAt : entries[userIndex]?.timestamp;
		const parsedStartedAt = startedAt ? Date.parse(startedAt) : Number.NaN;
		const elapsedMs = Number.isFinite(parsedStartedAt) ? Math.max(0, Date.now() - parsedStartedAt) : 0;
		const maxTokens = this.#contextSteadySegmentTokenThreshold();
		const maxDurationMs = Math.max(
			0,
			Math.floor(this.settings.get("san.contextSteady.segment.maxDurationMs") as number),
		);
		const tokenHint = maxTokens > 0 && tokens >= maxTokens;
		const durationHint = maxDurationMs > 0 && elapsedMs >= maxDurationMs;
		return {
			required: tokenHint || durationHint,
			tokenHint,
			durationHint,
			tokens,
			elapsedMs,
			boundaryId: latestSegmentIndex > userIndex ? latestSegment!.entryId : entries[userIndex]!.id,
		};
	}

	#appendContextSteadyCheckpointSegment(
		segmentHint: {
			tokenHint: boolean;
			durationHint: boolean;
			tokens: number;
			elapsedMs: number;
		},
		contextTokens: number,
	): boolean {
		const trigger: "segment_tokens" | "segment_duration" = segmentHint.tokenHint
			? "segment_tokens"
			: "segment_duration";
		const matchedTriggers: ContextMaintenanceTrigger[] = [];
		if (segmentHint.tokenHint) matchedTriggers.push("segment_tokens");
		if (segmentHint.durationHint) matchedTriggers.push("segment_duration");
		const maintenanceId = `maintenance_${crypto.randomUUID().slice(-12)}`;
		const segment = buildContextSegmentCheckpoint({
			entries: this.sessionManager.getBranch(),
			sessionId: this.sessionId,
			promptGeneration: this.#promptGeneration,
			maintenanceId,
			trigger,
			matchedTriggers,
			phase: "mid_turn",
			tokensBefore: contextTokens,
			segmentDeltaTokens: segmentHint.tokens,
			segmentElapsedMs: segmentHint.elapsedMs,
		});
		if (!segment) return false;
		appendContextSegment(this.sessionManager, segment);
		const continuationState = buildActiveContinuationState({
			entries: this.sessionManager.getBranch(),
			sessionId: this.sessionId,
			logicalTurnId: segment.logicalTurnId,
			promptGeneration: this.#promptGeneration,
		});
		if (continuationState) appendActiveContinuationState(this.sessionManager, continuationState);
		logger.debug("Mid-run Segment checkpoint committed without compaction", {
			trigger,
			matchedTriggers,
			segmentId: segment.segmentId,
			segmentDeltaTokens: segmentHint.tokens,
			segmentElapsedMs: segmentHint.elapsedMs,
			contextTokens,
		});
		this.#recordContextMaintenanceProbe({
			maintenanceId,
			primaryTrigger: trigger,
			matchedTriggers,
			action: "checkpoint",
			segmentDeltaTokens: segmentHint.tokens,
			segmentElapsedMs: segmentHint.elapsedMs,
		});
		return true;
	}

	/**
	 * Compact continuing tool-loop runs before the next provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn
	 * are already paired in `activeMessages`, the live array the agent loop reads
	 * before its next model call. Before compacting, the just-finished turn is
	 * synchronously persisted if async message hooks have not reached the normal
	 * append path yet. Mid-run handoff is suppressed because resetting the session
	 * while the loop owns `activeMessages` would race the next request; handoff
	 * strategy falls back to in-place context-full compaction here.
	 */
	async #maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (
			signal?.aborted ||
			this.#isDisposed ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			!context?.willContinue
		)
			return;

		const model = this.model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = this.settings.getGroup("compaction");
		const physicalMaintenanceEnabled =
			compactionSettings.enabled &&
			compactionSettings.strategy !== "off" &&
			compactionSettings.midTurnEnabled !== false;

		const lastAssistant = [...activeMessages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		if (!(await this.#persistTurnMessagesForMidRunCompaction(context))) return;

		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		const contextSteadyActive = this.#contextSteadyIsActive(
			Math.max(calculatePromptTokens(lastAssistant.usage), storedContextTokens),
		);
		// Use the unified budget resolver so the maintenance threshold aligns with
		// the ContextPlan gate's steadyTarget (which accounts for hardInputCeiling).
		// The old independent formula could set a target above the gate's ceiling,
		// causing hard_pressure to fire before maintenance ever triggered.
		const unifiedBudget = resolveContextPlanBudget({
			settings: {
				qualityWindowTokens: this.settings.get("san.contextSteady.qualityWindowTokens") as number,
				reserveRatio: this.settings.get("san.contextSteady.reserveRatio") as number,
				planMaxTokens: this.#contextSteadyPlanMaxTokens(),
				burstWindowTokens: this.#contextSteadyBurstWindowTokens(),
			},
			contextWindow,
			nonMessageTokens: computeNonMessageTokens(this),
		});
		const contextSteadyTarget = contextSteadyActive
			? Math.max(1, unifiedBudget.steadyTarget)
			: Number.POSITIVE_INFINITY;
		const steadyMaintenanceRequired = physicalMaintenanceEnabled && contextTokens > contextSteadyTarget;
		const segmentHint = this.#contextSteadySegmentMaintenanceHint();
		const nativeMaintenanceRequired =
			physicalMaintenanceEnabled && shouldCompact(contextTokens, contextWindow, compactionSettings);
		if (!steadyMaintenanceRequired && !segmentHint.required && !nativeMaintenanceRequired) return;
		const physicalMaintenanceRequired = steadyMaintenanceRequired || nativeMaintenanceRequired;
		if (this.#hasQueuedUserMessage()) {
			logger.debug("Deferring context maintenance so queued user input can preempt it", {
				physicalMaintenanceRequired,
				segmentHint,
			});
			return;
		}
		if (!physicalMaintenanceRequired) {
			this.#appendContextSteadyCheckpointSegment(segmentHint, contextTokens);
			return;
		}

		// Promote to a larger-context sibling before compacting, mirroring the
		// pre-prompt (#runPrePromptCompactionIfNeeded) and post-turn threshold
		// (#checkCompaction) paths. Without this, a long mid-turn tool loop that
		// crosses the threshold compacts the history (and can hit the no-progress
		// dead-end on a single oversized turn) on a model that should have just
		// been promoted to a larger window instead.
		if (await this.#promoteContextModel()) {
			if (segmentHint.required) this.#appendContextSteadyCheckpointSegment(segmentHint, contextTokens);
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		const compactionBefore = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
		const matchedTriggers: ContextMaintenanceTrigger[] = [];
		if (nativeMaintenanceRequired) matchedTriggers.push("native_threshold");
		if (steadyMaintenanceRequired) matchedTriggers.push("steady_target");
		if (segmentHint.tokenHint) matchedTriggers.push("segment_tokens");
		if (segmentHint.durationHint) matchedTriggers.push("segment_duration");
		const trigger: ContextMaintenanceTrigger = nativeMaintenanceRequired ? "native_threshold" : "steady_target";
		const maintenanceResult = await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			suppressContinuation: true,
			suppressHandoff: true,
			triggerContextTokens: contextTokens,
			trigger,
			matchedTriggers,
			segmentDeltaTokens: segmentHint.tokens,
			segmentElapsedMs: segmentHint.elapsedMs,
			phase: "mid_turn",
		});

		if (signal?.aborted) return;
		const compactedMessages = this.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		const compactionAfter = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
		const committed =
			maintenanceResult.historyRewritten === true ||
			(compactionAfter !== undefined && compactionAfter !== compactionBefore);
		logger.debug(committed ? "Mid-run compaction committed between provider calls" : "Mid-run compaction no-op", {
			trigger,
			matchedTriggers,
			contextTokens,
			contextWindow,
			contextSteadyTarget,
			steadyMaintenanceRequired,
			segmentHint,
			strategy: compactionSettings.strategy,
			goalActive: this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
			compactionBefore,
			compactionAfter,
		});
	}
	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Four cases (in order):
	 * 1. Input overflow + promotion: promote to larger model, retry without maintenance.
	 * 2. Input overflow + no promotion target: run context maintenance, auto-retry on same model.
	 * 3. Output incomplete (stopReason === "length", e.g. `response.incomplete`): the
	 *    model burned its output budget without producing an actionable deliverable
	 *    (reasoning-only or truncated). Drop the dead turn, try promotion, otherwise
	 *    run compaction/handoff and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param allowDefer If true, threshold-driven handoff strategy may schedule itself as a
	 *   deferred post-prompt task instead of running inline. Callers running inside the
	 *   `agent_end` handler set this to true so `session.prompt()` resolves cleanly; callers
	 *   on the pre-prompt path (where the next agent turn is about to start) set it to false
	 *   to avoid racing the deferred handoff against the new turn.
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction/recovery scheduled a handoff, retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	#assistantPredatesCompaction(
		assistantMessage: AssistantMessage,
		compactionEntry: CompactionEntry,
		branch: readonly SessionEntry[],
	): boolean {
		const compactionIndex = branch.findIndex(entry => entry.id === compactionEntry.id);
		if (compactionIndex >= 0) {
			const exactIndex = branch.findIndex(entry => entry.type === "message" && entry.message === assistantMessage);
			if (exactIndex >= 0) return exactIndex < compactionIndex;

			const persistenceKey = sessionMessagePersistenceKey(assistantMessage);
			if (persistenceKey) {
				let matchedBefore = false;
				let matchedAfter = false;
				for (let index = 0; index < branch.length; index++) {
					const entry = branch[index];
					if (entry.type !== "message" || entry.message.role !== "assistant") continue;
					if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
					if (!sameMessageContent(entry.message, assistantMessage)) continue;
					if (index < compactionIndex) matchedBefore = true;
					if (index > compactionIndex) matchedAfter = true;
				}
				// Journal 顺序是权威来源；只有旧会话缺少可匹配 entry 时才回退到时间戳。
				if (matchedBefore !== matchedAfter) return matchedBefore;
			}
		}
		return assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
	}

	async #checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		allowDefer = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		if (this.settings.get("san.contextSteady.enabled") === true) {
			this.#contextSteadyIsActive(
				Math.max(calculatePromptTokens(assistantMessage.usage), this.#estimateStoredContextTokens()),
			);
		}
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const branch = this.sessionManager.getBranch();
		const compactionEntry = getLatestCompactionEntry(branch);
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && this.#assistantPredatesCompaction(assistantMessage, compactionEntry, branch);
		if (sameModel && !errorIsFromBeforeCompaction && AIError.isContextOverflow(assistantMessage, contextWindow)) {
			// Clear the failed turn from active context so the retry (or the next
			// user prompt) does not replay it. The persisted branch entry stays
			// for now: when no recovery path runs, the user-facing transcript
			// MUST keep the only assistant message explaining why the turn
			// stopped. The branch entry is dropped further down, but only on the
			// paths that actually schedule a retry/compaction.
			this.#removeAssistantMessageFromActiveContext(assistantMessage);

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#dropPersistedAssistantTurn(assistantMessage);
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
				return await this.#runRecoveryCompactionWithRollback("overflow", assistantMessage, allowDefer, {
					autoContinue,
				});
			}
			return COMPACTION_CHECK_NONE;
		}
		// A context promotion can land while the failing call is already in
		// flight (or on a run whose loop predates the switch): the overflow
		// error then arrives stamped with the pre-promotion model while
		// `this.model` is already the promoted target. The sameModel guard
		// above deliberately ignores stale foreign-model errors, but this
		// state is not stale — recover exactly like the promotion path:
		// drop the dead turn and retry on the already-promoted model. Gated
		// narrowly on "current model IS the failed model's promotion target
		// with a strictly larger window" so genuinely stale errors from
		// old user-switched models keep surfacing untouched.
		if (
			!sameModel &&
			autoContinue &&
			!errorIsFromBeforeCompaction &&
			assistantMessage.stopReason === "error" &&
			this.model &&
			contextWindow > 0 &&
			this.settings.getGroup("contextPromotion").enabled
		) {
			const failedModel = this.#modelRegistry.find(assistantMessage.provider, assistantMessage.model);
			const failedWindow = failedModel?.contextWindow ?? 0;
			const promotionTarget = failedModel
				? this.#resolveContextPromotionConfiguredTarget(failedModel, this.#modelRegistry.getAvailable())
				: undefined;
			if (
				failedModel &&
				failedWindow > 0 &&
				contextWindow > failedWindow &&
				promotionTarget &&
				modelsAreEqual(promotionTarget, this.model) &&
				AIError.isContextOverflow(assistantMessage, failedWindow)
			) {
				this.#removeAssistantMessageFromActiveContext(assistantMessage);
				await this.#dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Overflow on pre-promotion model; retrying on promoted model", {
					failed: `${assistantMessage.provider}/${assistantMessage.model}`,
					current: `${this.model.provider}/${this.model.id}`,
				});
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}
		}

		// Case 3: Output-side incomplete — `response.incomplete` from OpenAI Responses
		// (and Codex) maps to stopReason === "length". The model burned its
		// `max_output_tokens` budget on reasoning/text and emitted no actionable
		// deliverable. Same recovery class as overflow: promotion if available,
		// otherwise compaction/handoff. Unlike overflow, the *input* is fine, so we
		// allow the handoff strategy to actually run.
		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			// Same active-context vs persisted-history split as the overflow path
			// above: clear the dead turn from agent state so it cannot be replayed,
			// but keep it on the branch unless promotion or compaction actually runs.
			this.#removeAssistantMessageFromActiveContext(assistantMessage);

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Context promotion triggered by response.incomplete (length stop)", {
					from: `${assistantMessage.provider}/${assistantMessage.model}`,
				});
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			const incompleteCompactionSettings = this.settings.getGroup("compaction");
			if (incompleteCompactionSettings.enabled && incompleteCompactionSettings.strategy !== "off") {
				logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
					model: `${assistantMessage.provider}/${assistantMessage.model}`,
					strategy: incompleteCompactionSettings.strategy,
				});
				return await this.#runRecoveryCompactionWithRollback("incomplete", assistantMessage, allowDefer, {
					autoContinue,
					triggerContextTokens: calculateContextTokens(assistantMessage.usage),
				});
			}
			// Neither promotion nor compaction is available — surface the dead-end so
			// the user understands why the turn yielded with nothing.
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return COMPACTION_CHECK_NONE;

		// Case 4: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#pruneToolOutputs();
		const maintenanceTokensFreed = (supersedeResult?.tokensSaved ?? 0) + (pruneResult?.tokensSaved ?? 0);
		// `errorIsFromBeforeCompaction` (computed above) is the general
		// "this assistant message predates the latest compaction" predicate here,
		// not just an error-specific one; alias it locally so the threshold intent
		// reads clearly (#3412 review).
		const assistantPredatesCompaction = errorIsFromBeforeCompaction;
		// An assistant that predates the latest compaction carries stale, pre-rewrite
		// `usage`: the scheduled auto-continue re-enters this check with the kept
		// assistant (#promptWithMessage → #checkCompaction), and its old high prompt
		// count would re-trip the threshold on a freshly compacted history. Drop the
		// stale provider number for those messages and let the live stored estimate
		// (the floor applied below) drive the decision instead.
		const assistantUsageContextTokens = assistantPredatesCompaction
			? 0
			: calculateContextTokens(assistantMessage.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		// Pruning frees bytes for the NEXT prompt; it does not change the size of
		// the prompt the LLM just billed for. Earlier revisions subtracted the
		// per-turn supersede/prune `tokensSaved` from the threshold input, which
		// let a long-running `/goal` session sit above `compaction.thresholdTokens`
		// indefinitely whenever per-turn pruning saved enough to drop the
		// post-prune estimate below the user-configured trigger — the visible
		// context (anchored to the same provider billing) still showed >threshold,
		// but `shouldCompact` no-op'd (#3174). Anchor the initial trigger on the
		// last turn's billed context tokens, floored by the post-prune
		// stored-conversation estimate so a payload-compression hook still can't
		// deflate the trigger.
		const contextTokens = compactionContextTokens(assistantUsageContextTokens, storedContextTokens);
		const postMaintenanceContextTokens = compactionContextTokens(
			Math.max(0, assistantUsageContextTokens - maintenanceTokensFreed),
			storedContextTokens,
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const shouldThresholdCompact = shouldCompact(contextTokens, contextWindow, compactionSettings);
		logger.debug("Auto-compaction threshold decision", {
			phase: "post-agent-end",
			goalModeEnabled: this.#goalModeState?.enabled === true,
			goalStatus: this.#goalModeState?.goal.status,
			stopReason: assistantMessage.stopReason,
			sameModel: sameModel === true,
			contextWindow,
			strategy: compactionSettings.strategy,
			thresholdTokens,
			assistantUsageContextTokens,
			storedContextTokens,
			resolvedContextTokens: contextTokens,
			postMaintenanceContextTokens,
			maintenanceTokensFreed,
			shouldCompact: shouldThresholdCompact,
			contextPromotionEnabled: this.settings.get("contextPromotion.enabled") === true,
		});
		if (shouldThresholdCompact) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				return await this.#runAutoCompaction("threshold", false, false, allowDefer, {
					autoContinue,
					triggerContextTokens: postMaintenanceContextTokens,
					phase: "pre_turn",
					terminalTextAnswer: isTerminalTextAssistantAnswer(assistantMessage),
				});
			}
			logger.debug("Auto-compaction threshold satisfied but context promotion took over", {
				contextTokens,
				contextWindow,
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
		}
		return COMPACTION_CHECK_NONE;
	}
	#isTerminalYieldToolResult(event: { toolName: string; isError?: boolean; result?: { details?: unknown } }): boolean {
		if (event.toolName !== "yield" || event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	}

	#markTerminalYieldToolCall(toolCallId: string): void {
		this.#lastSuccessfulYieldToolCallId = toolCallId;
		this.#yieldTerminationPending = true;
	}

	#assistantMessageHasSuccessfulYieldToolCall(assistantMessage: AssistantMessage, toolCallId: string): boolean {
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		return toolCallId ? this.#assistantMessageHasSuccessfulYieldToolCall(assistantMessage, toolCallId) : false;
	}

	#findSuccessfulYieldAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (this.#assistantMessageHasSuccessfulYieldToolCall(message, toolCallId)) return message;
		}
		return undefined;
	}

	#clearPendingRecoveredRetryErrors(): void {
		this.#pendingRecoveredRetryErrors = [];
	}

	async #persistRetryLifecycleErrorMessage(message: AssistantMessage): Promise<void> {
		await this.#waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#sessionMessageAlreadyPersisted(message)) return;
		this.#appendSessionMessage(message);
	}

	#retryRecoveryKind(
		id: number,
		switchedCredential: boolean,
		switchedModel: boolean,
		delayMs: number,
	): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (switchedModel) return "model";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("rate-limited");
		} else if (recovery === "plain") {
			parts.push("error");
		}
		if (recovery === "credential") {
			parts.push("switched account");
		} else if (recovery === "model") {
			parts.push("switched model");
		} else if (recovery === "wait") {
			parts.push("waited");
		}
		parts.push("retried");
		return parts.join("; ");
	}

	async #recordPendingRecoveredRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.#persistRetryLifecycleErrorMessage(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		for (const entry of this.sessionManager.getBranch().slice().reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !this.#isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRecoveredRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRecoveredRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRecoveredRetryErrors(supersedingMessage: AssistantMessage): Promise<RecoveredRetryError[]> {
		if (this.#pendingRecoveredRetryErrors.length === 0) return [];
		const branch = this.sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const recoveredAt = new Date().toISOString();
		const supersededBy: AssistantRetryRecovery["supersededBy"] = {
			timestamp: supersedingMessage.timestamp,
			provider: supersedingMessage.provider,
			model: supersedingMessage.model,
		};
		if (supersedingMessage.responseId) {
			supersededBy.responseId = supersedingMessage.responseId;
		}
		const recoveredErrors: RecoveredRetryError[] = [];
		for (const pending of this.#pendingRecoveredRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const retryRecovery: AssistantRetryRecovery = {
				kind: "auto-retry",
				status: "recovered",
				attempt: pending.attempt,
				recoveredAt,
				recovery: pending.recovery,
				note: pending.note,
				supersededBy,
			};
			entry.message.retryRecovery = retryRecovery;
			recoveredErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (recoveredErrors.length > 0) {
			await this.sessionManager.rewriteEntries();
		}
		return recoveredErrors;
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#isEmptyAssistantStop(assistantMessage)) {
			this.#emptyStopRetryCount = 0;
			return false;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;
			return false;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const finalError = "Assistant returned empty stop after retry cap";
			logger.warn(finalError, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,
				finalError,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#retryAttempt = 0;
			this.#resolveRetry();
			// Tool-use orphans corrupt Anthropic message history (tool_result without
			// matching tool_use). Always remove them even when the retry cap is hit.
			if (assistantMessage.stopReason === "toolUse") {
				this.#discardAssistantTurn(assistantMessage);
			}
			return false;
		}
		this.#discardAssistantTurn(assistantMessage);
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#isEmptyAssistantStop(assistantMessage: AssistantMessage): boolean {
		switch (assistantMessage.stopReason) {
			case "stop":
				// Reasoning/thinking-only turns are not actionable: they do not
				// answer the user and do not give the agent loop a tool call to run.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			case "toolUse":
				// An orphaned toolUse stop (no tool_use block) corrupts Anthropic history:
				// a later tool_result has nothing to anchor to. Thinking alone cannot anchor
				// a tool_result, so it does not rescue a toolUse stop here.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			default:
				return false;
		}
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.settings.get("features.unexpectedStopDetection")) {
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");
		if (!/\S/.test(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await classifyUnexpectedStop(text, {
				settings: this.settings,
				registry: this.#modelRegistry,
				sessionId: this.sessionId,
				metadataResolver: (provider: string) => this.agent.metadataForProvider(provider),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (classification !== true) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	#removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.agent.replaceMessages(messages.slice(0, -1));
			return;
		}
		// A miss means the failed turn is still in active context (or was never
		// there); log just enough to explain why the identity check failed.
		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void> {
		await this.#waitForSessionMessagePersistence(assistantMessage);
		this.#discardAssistantTurn(assistantMessage);
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * {@link #runAutoCompaction} for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.sessionManager.getBranch());
		await this.#dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#runAutoCompaction(reason, true, false, allowDefer, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.sessionManager.getBranch();
		const branchEntry = branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message, assistantMessage),
			);
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		this.#removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.agent.state.messages.at(-1)?.role === "custom") {
			this.agent.replaceMessages(this.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		this.#withBashBranchTransition(() => {
			if (targetParentId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(targetParentId);
			}
		});
		this.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	#discardAssistantTurn(assistantMessage: AssistantMessage): void {
		this.#removeAssistantMessageFromActiveContext(assistantMessage);

		const branchEntry = this.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
			);
		if (!branchEntry) {
			return;
		}
		this.#withBashBranchTransition(() => {
			if (branchEntry.parentId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(branchEntry.parentId);
			}
		});
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason)
		);
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#extractRewindReport(messages: AgentMessage[]): string | undefined {
		if (!this.#checkpointState) return undefined;
		if (this.#pendingRewindReport) return this.#pendingRewindReport;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "toolResult" || message.isError) continue;
			const semanticResult = semanticToolResult(message.toolName, message);
			if (semanticResult?.toolName !== "rewind") continue;
			const details = semanticResult.details;
			const detailReport =
				details && typeof details === "object" && "report" in details && typeof details.report === "string"
					? details.report.trim()
					: "";
			const textReport = message.content.find(part => part.type === "text")?.text.trim() ?? "";
			const report = detailReport || textReport;
			return report.length > 0 ? report : undefined;
		}
		return undefined;
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		await this.#waitForMessageEndPersistence();
		this.#withBashBranchTransition(() => {
			try {
				this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
					startedAt: checkpointState.startedAt,
				});
			} catch (error) {
				logger.warn("Rewind branch checkpoint missing, falling back to root", {
					error: error instanceof Error ? error.message : String(error),
				});
				this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
			}
		});

		const rewoundAt = new Date().toISOString();
		const details = { report, startedAt: checkpointState.startedAt, rewoundAt };
		this.sessionManager.appendCustomMessageEntry(
			"rewind-report",
			prompt.render(rewindReportTemplate, { report }),
			false,
			details,
			"agent",
		);
		this.#lastCompletedRewind = { report, startedAt: checkpointState.startedAt, rewoundAt };

		if (activeMessages) {
			for (const message of activeMessages) {
				if (message.role === "toolResult" && semanticToolResult(message.toolName, message)?.toolName === "rewind") {
					this.#rewoundToolResultIds.add(message.toolCallId);
				}
			}
		}
		this.#resetAnnouncedMounts();
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	/** Plan-mode decision affordances: `ask`, or plan approval via `write xd://propose`. */
	#isPlanDecisionTool(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
		return toolCall.name === "ask" || isProposeToolCall(toolCall);
	}

	async #enforcePlanModeDecisionAtSettle(): Promise<boolean> {
		if (!this.#planModeState?.enabled) {
			return false;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return false;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return false;
		}

		const calledDecisionTool = assistantMessage.content.some(
			content => content.type === "toolCall" && this.#isPlanDecisionTool(content),
		);
		if (calledDecisionTool) {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			return false;
		}

		const hasToolCall = assistantMessage.content.some(content => content.type === "toolCall");
		if (hasToolCall) {
			return false;
		}
		if (this.#planModeReminderAwaitingProgress) {
			return false;
		}
		if (this.#planModeReminderCount >= PLAN_MODE_REMINDER_MAX) {
			logger.debug("Plan mode convergence: reminder cap reached; yielding to user");
			return false;
		}
		const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("write");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/write tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return false;
		}

		this.#planModeReminderCount++;
		this.#planModeReminderAwaitingProgress = true;
		this.#toolChoiceQueue.pushOnce("required", { label: "plan-mode-decision" });
		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({
			generation: this.#promptGeneration,
			// If the continuation never runs (new prompt, dispose, compaction,
			// handoff), the forced choice must not leak onto an unrelated turn.
			onSkip: () => this.#toolChoiceQueue.removeByLabel("plan-mode-decision"),
		});
		return true;
	}

	/**
	 * Render context shared by the eager todo/task preludes. `toolRefs` resolves each
	 * tool's wire name (matching `buildSystemPrompt`'s `toolRefs`) so the reminder names
	 * the tool the model actually sees when an extension renames it; `taskBatch` gates
	 * batch-call guidance that would steer toward a failing call shape when `task.batch`
	 * is off (the flat single-spawn schema rejects `tasks`/`context`).
	 */
	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#toolRegistry.get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName("task"), todo: wireName("todo") },
			taskBatch: this.settings.get("task.batch"),
		};
	}

	#createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (mode === "default" || !todosEnabled) {
			return undefined;
		}

		if (this.#planModeState?.enabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		// When `promptText` is undefined (post-compaction re-injection) there is no fresh
		// user message to gate on, so skip the first-message and prompt-suffix checks.
		if (promptText !== undefined) {
			const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
			if (hasPriorUserMessage) {
				return undefined;
			}

			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
				return undefined;
			}
		}

		// Must check the active tool set, not just the registry: a registered
		// tool can be hidden from the exposed tools (e.g. unmounted under the
		// xd:// transport). Forcing a named tool_choice for an inactive tool makes
		// the provider reject the request (HTTP 400).
		if (!this.getActiveToolNames().includes("todo")) {
			logger.warn("Eager todo enforcement skipped because todo is not active", {
				activeToolNames: this.getActiveToolNames(),
			});
			return undefined;
		}

		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(eagerTodoPrompt, { ...this.#buildEagerPreludeContext(), forced: mode === "always" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		// `preferred` suggests a todo list (reminder only); `always` also forces the
		// `todo` tool on the first turn — the previous boolean-on behavior. Post-compaction
		// re-injection (`promptText === undefined`) is always reminder-only: forcing a tool
		// onto the auto-resumed turn would override the agent's in-flight action.
		if (promptText === undefined || mode === "preferred") {
			return { message };
		}
		const todoToolChoice = buildNamedToolChoice("todo", this.model);
		if (!todoToolChoice) {
			// `always` on a model that can't be forced degrades to reminder-only (no
			// tool_choice). For `todo.eager: true` users migrated to `always`, such
			// models now receive the first-turn reminder where they previously got
			// nothing (see the CHANGELOG entry); `always ⊇ preferred` is preserved.
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: this.model?.api, modelId: this.model?.id },
			);
			return { message };
		}
		return { message, toolChoice: todoToolChoice };
	}

	#createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (this.settings.get("task.eager") !== "always") return undefined;
		// Main agent only: subagents keep `task` active (the parent only filters `todo`),
		// so a salient delegate-reminder there would amplify nested fan-out. Gate on the
		// resolved agent kind, not the id, so a top-level session with a custom `agentId`
		// still gets the reminder.
		if (this.#agentKind === "sub") return undefined;
		if (this.#planModeState?.enabled) return undefined;
		// First-message-only gates are skipped post-compaction (`promptText === undefined`),
		// where there is no fresh user message to suppress the reminder for.
		if (promptText !== undefined) {
			if (this.agent.state.messages.some(m => m.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.getActiveToolNames().includes("task")) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(eagerTaskPrompt, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Build the eager task/todo reminders to re-inject on the auto-continuation turn that
	 * follows a compaction. The first-message preludes are the oldest messages, so
	 * compaction summarizes them away and the agent silently loses the delegate-via-tasks
	 * and phased-todo guidance mid-work; this re-asserts them, reminder-only (the todo
	 * builder drops its forced tool_choice when `promptText` is undefined). Each builder
	 * still applies its own mode / agent-kind / plan-mode / tool-active / surviving-todo
	 * gates, so an empty array means nothing currently warrants a nudge.
	 */
	#buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.#createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.#createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}
	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(message: AssistantMessage): Promise<boolean> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return false;
		}

		// Plan mode owns convergence via #enforcePlanModeDecisionAtSettle (remind →
		// cap → yield). Todo reminders must not re-wake a turn the cap intends to
		// yield to the user. The label is already consumed above, so no leak.
		if (this.#planModeState?.enabled) {
			return false;
		}

		// Suppress within a self-continuation chain: if the agent's last turn was driven by a
		// prior reminder (and the agent took no tool-level action since), do not re-ping.
		// The agent has already acknowledged; further escalation just wastes context and
		// pressures the agent into busy-work or destructive ops (issue #2590).
		if (this.#todoReminderAwaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#todoReminderCount,
			});
			return false;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		const remindersMax = this.settings.get("todo.remindersMax");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return false;
		}

		const phases = this.getTodoPhases();
		if (phases.length === 0) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		if (isAwaitingUserAnswer(message)) {
			logger.debug("Todo completion: assistant is waiting for user input; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		// Background async jobs (bash/task) owned by this agent re-wake the loop
		// when they complete: the result delivery enqueues an async-result
		// follow-up that continues the run, and todos are re-evaluated at that
		// settle. A stop with such a job in flight is a scheduling pause, not
		// abandonment — stay silent instead of nagging.
		if (this.#hasPendingAsyncWake()) {
			logger.debug("Todo completion: async jobs in flight will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		// A stop-time reminder starts a fresh reminder runway. Without resetting
		// the mid-run counter here, a run that stopped just below the threshold
		// would spend its stale pre-reminder count and fire "Mid-run reminder 2/3"
		// after only a little post-reminder work.
		this.#mutationsSinceLastTodoTouch = 0;
		this.#todoReminderAwaitingProgress = true;
		// Inject reminder and persist it so the JSONL transcript matches model context.
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	/**
	 * Build the next mid-run todo reconciliation nudge when the agent has landed
	 * {@link MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD} mutating tool results without
	 * invoking the `todo` tool and incomplete items remain. Returns the hidden
	 * (`display: false`) custom message when it should fire, or `null` to skip.
	 * Called once per turn via the aside provider; mutates internal counters when
	 * it fires so the caller does not need to track delivery state.
	 *
	 * Deliberately a SEPARATE concept from {@link #checkTodoCompletion}'s
	 * stop-time reminder: this is a gentle model-only hint (no `todo_reminder`
	 * event, no TUI render, no escalation counter, own per-cycle budget), while
	 * the stop-time reminder is the user-visible escalation ladder. Without this
	 * nudge, long runs drive the live HUD to `0/N` until the final stop, then
	 * batch-flip to `N/N` (issue #3651).
	 */
	#takeMidRunTodoNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTodoTouch < MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_TODO_NUDGE_MAX_PER_CYCLE) return null;
		if (!this.settings.get("todo.enabled")) return null;
		if (!this.settings.get("todo.reminders")) return null;
		// Plan-mode runs are authoring a plan file, not implementing it; todos
		// don't apply, mirroring {@link #createEagerTodoPrelude}.
		if (this.#planModeState?.enabled) return null;
		// Tool discovery / explicit active-tool lists can hide `todo` from this
		// run while `todo.enabled` remains true (e.g. `setActiveToolsByName`
		// restricting the slate). Mirror {@link #createEagerTodoPrelude}'s
		// guard so we never ask the model to call a tool that is not in its
		// schema — the request would fabricate an unknown tool call.
		if (!this.getActiveToolNames().includes("todo")) return null;

		const incomplete = this.getTodoPhases()
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;

		// Reset the mutation counter so the nudge has another full runway before
		// the next fire; #midRunNudgeCount caps total nudges per prompt cycle.
		this.#mutationsSinceLastTodoTouch = 0;
		this.#midRunNudgeCount++;

		const { toolRefs } = this.#buildEagerPreludeContext();
		const reminder = prompt.render(midRunTodoNudgePrompt, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
		});

		logger.debug("Mid-run todo nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});

		return {
			role: "custom",
			customType: MID_RUN_TODO_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.model;
		if (!currentModel) return false;
		// The overflow/length error may have come from a model the user already
		// switched away from; only promote when the failing turn was this model.
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.#promoteContextModel();
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a
	 * target with a strictly larger window (and a usable key) exists. Returns true
	 * when the model was switched, so the caller can retry without compacting.
	 * Message-independent core shared by the post-turn overflow path
	 * ({@link #tryContextPromotion}) and the pre-prompt threshold path
	 * ({@link #runPrePromptCompactionIfNeeded}).
	 */
	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
			if (!modelsAreEqual(currentModel, model)) {
				this.#clearInheritedProviderPromptCacheKey();
			}
			// Invalidate context-steady budget when the window shrinks so the next
			// provider call rebuilds the plan against the new ceiling instead of
			// tripping hard_pressure with a stale budget.
			const oldWindow = currentModel.contextWindow ?? 0;
			const newWindow = model.contextWindow ?? 0;
			if (oldWindow > 0 && newWindow > 0 && newWindow < oldWindow) {
				this.#contextSteadyRequestPlan = undefined;
				this.#contextSteadyPendingBudgetPressureRebase = true;
				this.#contextSteadyRecoveryAttempt = 0;
			}
		}
		this.agent.setModel(model);
		this.agent.setDialect(resolveDialect(this.settings.get("tools.format"), model));

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#providerSessionState,
			sessionId: this.sessionId,
			compaction,
		});
	}

	#resetCurrentResponsesProviderSession(reason: string): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-responses" && currentModel?.api !== "openai-codex-responses") {
			return;
		}

		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
		this.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: currentModel.provider,
			model: currentModel.id,
			api: currentModel.api,
			reason,
		});
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		// `openai-completions` sessions are keyed `openai-completions:<provider>:<resolvedBaseUrl>:<modelId>`
		// and cache backend-specific decisions (strict-tools disable scopes, reasoning-effort
		// fallbacks). The resolved request base URL can differ from the catalog `model.baseUrl`
		// (Moonshot env override, Alibaba Coding Plan enterprise URL, Azure deployment URL),
		// so evict by provider prefix when the user moves away from that completions backend.
		let completionsPrefixToEvict: string | undefined;
		if (currentModel.api === "openai-completions") {
			const currentScope = `${currentModel.provider}:${currentModel.baseUrl ?? ""}`;
			const nextScope =
				nextModel.api === "openai-completions" ? `${nextModel.provider}:${nextModel.baseUrl ?? ""}` : undefined;
			if (currentScope !== nextScope) {
				completionsPrefixToEvict = `openai-completions:${currentModel.provider}:`;
			}
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}

		if (completionsPrefixToEvict !== undefined) {
			for (const [key, state] of this.#providerSessionState) {
				if (!key.startsWith(completionsPrefixToEvict)) continue;
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close provider session state during model switch", {
						providerKey: key,
						error: String(error),
					});
				}
				this.#providerSessionState.delete(key);
			}
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		if (previousMessages.length !== nextMessages.length) return true;
		return previousMessages.some(
			(message, i) =>
				!Bun.deepEquals(
					this.#normalizeSessionMessageForProviderReplay(message),
					this.#normalizeSessionMessageForProviderReplay(nextMessages[i]),
				),
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings, {
			isLiteralModelId: (provider, id) => this.#modelRegistry.find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveConfiguredModelTarget(
		configuredTarget: string | undefined,
		currentModel: Model,
		availableModels: Model[],
	): Model | undefined {
		const trimmedTarget = configuredTarget?.trim();
		if (!trimmedTarget) return undefined;

		const parsed = parseModelString(trimmedTarget, {
			allowAutoAlias: true,
			allowMaxSuffix: true,
			isLiteralModelId: (provider, id) =>
				availableModels.some(model => model.provider === provider && model.id === id),
		});
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === trimmedTarget);
	}

	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
	}

	#resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: getModelMatchPreferences(this.settings),
			modelRegistry: this.#modelRegistry,
		});
	}

	#getCompactionModelCandidates(availableModels: Model[], filter?: (model: Model) => boolean): Model[] {
		return this.#resolveCompactionModelCandidates(this.model, availableModels, filter);
	}

	/**
	 * Compaction candidates that can actually run — those with a resolvable API
	 * key, matching the per-candidate getApiKey gate the execution loop applies.
	 * Re-expansion reusability (prepareCompaction) must judge remote-preserve
	 * reuse against these, not against candidates the loop would skip at runtime.
	 */
	async #runnableCompactionCandidates(candidates: readonly Model[], sessionId: string | undefined): Promise<Model[]> {
		const keys = await Promise.all(candidates.map(model => this.#modelRegistry.getApiKey(model, sessionId)));
		return candidates.filter((_, index) => keys[index] !== undefined);
	}

	#resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			// `seen` still tracks rejected models so the largest-context fallback
			// scan below doesn't reintroduce them; the filter just suppresses
			// inclusion in this caller's candidate chain.
			if (filter && !filter(model)) return;
			candidates.push(model);
		};

		if (preferredModel) {
			addCandidate(this.#resolveCompactionConfiguredTarget(preferredModel, availableModels));
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
		);
	}

	async #enforceContextSummaryAuthority(options: {
		summary: string;
		shortSummary?: string;
		summarySource: ContextSummarySource;
		continuationState: ActiveContinuationState | undefined;
		repair?: () => Promise<CompactionResult>;
	}): Promise<ContextSummaryAuthorityResolution> {
		const inspection = inspectContextSummary(options.summary, options.continuationState);
		if (!contextSummaryInspectionFailed(inspection)) {
			return {
				summary: options.summary,
				...(options.shortSummary ? { shortSummary: options.shortSummary } : {}),
				audit: buildContextSummaryAuthorityAudit({
					summarySource: options.summarySource,
					inspection,
					repairAttempted: false,
					repairSucceeded: false,
				}),
			};
		}

		logger.warn("Compaction summary violated the historical-evidence protocol", {
			summarySource: options.summarySource,
			forbiddenGoalField: inspection.forbiddenGoalField,
			executionClaimConflictCount: inspection.executionClaimConflictCount,
		});

		let fallbackReason = "repair_unavailable";
		if (options.repair) {
			try {
				const replacement = await options.repair();
				const repairedInspection = inspectContextSummary(replacement.summary, options.continuationState);
				if (!contextSummaryInspectionFailed(repairedInspection)) {
					return {
						summary: replacement.summary,
						...(replacement.shortSummary ? { shortSummary: replacement.shortSummary } : {}),
						replacement,
						audit: buildContextSummaryAuthorityAudit({
							summarySource: options.summarySource,
							inspection,
							repairAttempted: true,
							repairSucceeded: true,
						}),
					};
				}
				fallbackReason = `repair_protocol_violation:forbidden_goal=${repairedInspection.forbiddenGoalField};execution_conflicts=${repairedInspection.executionClaimConflictCount}`;
			} catch (error) {
				fallbackReason = "repair_request_failed";
				logger.warn("Compaction summary repair request failed", {
					summarySource: options.summarySource,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const summary = renderDeterministicHistoricalFallback({
			state: options.continuationState,
			summarySource: options.summarySource,
			failureReason: fallbackReason,
		});
		return {
			summary,
			shortSummary: "Historical summary incomplete",
			audit: buildContextSummaryAuthorityAudit({
				summarySource: "deterministic_fallback",
				inspection,
				repairAttempted: options.repair !== undefined,
				repairSucceeded: false,
				fallbackReason,
			}),
		};
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		precomputedCandidates?: Model[],
	): Promise<CompactionResult> {
		const candidates =
			precomputedCandidates ?? this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;

			try {
				return await compact(
					this.#obfuscatePreparationForProvider(preparation),
					candidate,
					this.#modelRegistry.resolver(candidate, this.sessionId),
					this.#obfuscateTextForProvider(customInstructions),
					signal,
					{
						...options,
						metadata: this.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
						// Honor the user's /model thinking selection (incl. `off`) on
						// the manual `/compact` path. Clamped per-model inside compact()
						// via resolveCompactionEffort so unsupported-effort models
						// (xai-oauth/grok-build) don't trip requireSupportedEffort.
						thinkingLevel: this.thinkingLevel,
						tools: this.agent.state.tools,
						sessionId: this.sessionId,
						promptCacheKey: this.sessionId,
						providerSessionState: this.#providerSessionState,
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// subagents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: (requestModel, requestContext, requestOptions) =>
							this.#completeSideRequestWithProbe("compaction", requestModel, requestContext, requestOptions),
					},
				);
			} catch (error) {
				if (!AIError.is(AIError.classify(error, candidate.api), AIError.Flag.AuthFailed)) {
					throw error;
				}
			}
		}

		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Cap on snapcompact frames the post-compaction context can carry without
	 * busting the model window. Mirrors the per-frame token charge used by the
	 * projection ({@link snapcompact.FRAME_TOKEN_ESTIMATE}, the conservative
	 * high-res Anthropic ceiling), so picking `maxFrames` from this helper makes
	 * {@link #projectSnapcompactContextTokens} succeed by construction.
	 *
	 * Skip vs. cap use different reserves on purpose. The **skip** decision
	 * (return `0`) trips only when kept-recent plus non-message tokens already
	 * eat the entire `ctxWindow − reserve` envelope: at that point no archive
	 * shape — frame-bearing or text-only — can fit, and the caller MUST
	 * shortcut to the LLM summarizer instead of re-running snapcompact to
	 * re-emit the "could not bring the context under the limit" warning every
	 * threshold tick. The **cap** calculation subtracts a shape-aware reserve
	 * (`2 × geometry(shape).capacity` chars worth of text edges, billed at the
	 * tiktoken cl100k baseline, plus a 2k summary-template allowance) sized
	 * from the same `shape` snapcompact will use, so the projection still
	 * passes once frames land — but it MUST NOT gate the skip decision, since
	 * a frame-less archive (`text.length <= 2 * edgeCap` short-circuit in
	 * `planArchive`) typically costs only a few hundred tokens of summary
	 * lead and would fit under residual headroom far smaller than the cap
	 * reserve (chatgpt-codex reviews on #3249).
	 *
	 * Returns `1` when the frame charge would overflow but the text-only path
	 * still has room: snapcompact's planner picks the frame-less layout
	 * automatically when the discarded text fits in the edges, so giving it
	 * the minimum cap lets it succeed instead of being skipped outright.
	 *
	 * Without this cap, the bundled `MAX_FRAMES_DEFAULT = 80` × 5024 tokens =
	 * ~402k frame-token projection always overflows any sub-1M-token window
	 * (issue #3247).
	 */
	#computeSnapcompactMaxFrames(preparation: CompactionPreparation, settings: CompactionSettings): number {
		const ctxWindow = this.model?.contextWindow ?? 0;
		if (ctxWindow <= 0) return Math.min(snapcompact.MAX_FRAMES_DEFAULT, snapcompact.maxFramesForDataBudget());
		const reserve = effectiveReserveTokens(ctxWindow, settings);
		let baseTokens = computeNonMessageTokens(this);
		for (const message of preparation.recentMessages) {
			baseTokens += estimateTokens(message);
		}
		const totalBudget = ctxWindow - reserve;
		// Skip iff there is no headroom whatsoever; a text-only archive costs
		// far less than the cap reserve below, so any positive residual is
		// worth attempting and the projection guard catches actual overflow.
		if (baseTokens >= totalBudget) return 0;
		// Cap reserve mirrors what `estimateTokens(summaryMessage)` will charge
		// when frames > 0: `countTokens(summaryTemplate ‖ textHead ‖ textTail)`
		// plus `numFrames × FRAME_TOKEN_ESTIMATE`. Resolve the shape this
		// snapcompact pass will actually use (matches the `shape` argument
		// passed to `snapcompact.compact` in the auto and manual paths) so the
		// text-edge cost reflects the live frame geometry rather than a fixed
		// approximation. Reviewer (chatgpt-codex on #3249): a 4k reserve
		// undersized the ~7k text-edge cost on the default Anthropic
		// 11on16-bw shape, so the projection then rejected the `maxFrames`
		// the cap had picked and the warning loop reappeared.
		//
		// - `textHead` and `textTail` each consume up to `geometry.capacity`
		//   chars when frames > 0 (one HQ-capacity page per edge: see
		//   `TEXT_EDGE_PAGES = 1` in `planArchive`), so 2 × capacity chars
		//   total. Per-shape capacity: Anthropic 11on16-bw ~13.9k, Opus
		//   1932px ~21k, Gemini 8on22-bw 2048px ~23.8k, OpenAI 1568px ~13.9k.
		// - tiktoken cl100k ≈ 4 chars/token on ASCII (verified empirically
		//   for prose, code, and JSON); a 1.15 multiplier absorbs tokenizer
		//   drift on denser content (e.g. dense JSON / tool-result blobs).
		// - Summary template (intro + FILES section + grid notes) bills
		//   ~2k tokens for typical sessions.
		const shape = snapcompact.resolveShape(this.model, this.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const capReserve = textEdgeTokens + SUMMARY_TEMPLATE_TOKENS;
		const frameBudget = totalBudget - baseTokens - capReserve;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 1;
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
		);
	}

	#snapcompactFramePayloadBytes(result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		return archive ? snapcompact.frameDataBytes(archive.frames) : 0;
	}

	/**
	 * Project the post-compaction context size of a snapcompact result: kept
	 * recent messages + the summary message with its re-attached frames + the
	 * fixed non-message overhead (system prompt + tools). Mirrors how the
	 * compacted context is rebuilt, so the estimate matches the wire shape, and
	 * lets the caller decide whether snapcompact brought the context under the
	 * window or should fall back to an LLM summary.
	 */
	#projectSnapcompactContextTokens(preparation: CompactionPreparation, result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const blocks = archive
			? snapcompact.historyBlocks(archive, { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET })
			: undefined;
		const summaryMessage = createCompactionSummaryMessage(
			result.summary,
			result.tokensBefore,
			new Date().toISOString(),
			result.shortSummary,
			undefined,
			undefined,
			blocks,
		);
		let tokens = computeNonMessageTokens(this) + estimateTokens(summaryMessage);
		for (const message of preparation.recentMessages) {
			tokens += estimateTokens(message);
		}
		return tokens;
	}

	/**
	 * Post-maintenance progress check for the context-full / snapcompact tail.
	 *
	 * After `appendCompaction` rewrote history and `replaceMessages` swapped in the
	 * compacted context, measure the residual context off the live message set and
	 * decide whether maintenance actually created headroom. Mirrors the shake
	 * recovery-band logic (#2275): a session whose single most-recent turn already
	 * blows the threshold cannot be reduced by compaction (findCutPoint keeps that
	 * turn verbatim), so re-firing on the next agent_end just thrashes. We only
	 * report progress when residual context lands at or below
	 * `COMPACTION_RECOVERY_BAND × threshold` — a band that sits strictly under the
	 * compaction threshold, so reaching it guarantees the next turn cannot
	 * re-trip threshold compaction.
	 *
	 * When the model/window is unknown we cannot evaluate the band, so we
	 * optimistically allow the continuation (preserving prior behavior).
	 */
	#compactionCreatedHeadroom(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		// Residual at/below the band is authoritative headroom: the band sits
		// strictly under the compaction threshold, so the next turn cannot
		// re-trip threshold compaction regardless of how little this pass shaved.
		// Don't add a secondary "smaller than the trigger" guard — when stale/
		// tool-output pruning already dropped context under the band before this
		// pass, the trigger is itself sub-band, and requiring a strict reduction
		// would suppress a valid continuation and emit a false no-progress warning
		// even though compaction left the session safe.
		return residualTokens <= recoveryBand;
	}

	/**
	 * Retry-side counterpart to {@link #compactionCreatedHeadroom}. An
	 * overflow/incomplete recovery only needs the rebuilt prompt to *fit* the
	 * window again — it does not have to land under the compaction threshold, let
	 * alone the stricter `COMPACTION_RECOVERY_BAND × threshold` hysteresis the
	 * auto-continue thrash guard uses. Reusing the band here turned recoverable
	 * overflows into manual dead-ends: a 200k-window prompt compacted from
	 * overflow down to ~150k is comfortably retryable, but sits above
	 * `0.8 × 170k = 136k` and was wrongly refused (PR #3412 review).
	 *
	 * Measures residual context against the usable budget (`contextWindow - reserve`).
	 * The default absolute reserve can exceed bundled small-context windows, or
	 * nearly consume a 16k-class window; those known-impossible defaults fall
	 * back to the proportional 15% reserve. Explicit valid reserves still define
	 * the usable prompt budget so retries do not enter headroom the user
	 * intentionally reserved. Callers MUST
	 * invoke this AFTER dropping the failed assistant from `this.messages`, so
	 * the just-failed turn (which the retry prompt will not include) is excluded
	 * from the estimate.
	 *
	 * When the model/window is unknown we cannot evaluate the budget, so we
	 * optimistically allow the retry (preserving prior behavior).
	 */
	#compactionCreatedRetryFit(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, compactionSettings));
		return residualTokens <= fitBudget;
	}

	/**
	 * Last-resort tiered reducer when {@link #runAutoCompaction} would otherwise
	 * dead-end. The summarizer cut at the only available turn boundary, but the
	 * kept tail is still over the recovery band because a single recent turn (a
	 * large tool-result, a heavy fenced/XML block, attached images) is itself
	 * bigger than the band and `findCutPoint` cannot cut inside one message.
	 *
	 * Tier 1 — `shake("elide")` reaches INSIDE that tail: heavy tool-result /
	 * block content is offloaded to one `artifact://` blob behind a recoverable
	 * placeholder. Skipped when this pass already ran a shake (`skipElide`).
	 * Tier 2 — `dropImages()`: the manual `/shake images` remedy, automated.
	 * Image blocks are stripped from the branch; unlike elided text they are NOT
	 * artifact-recoverable, so this tier only runs once elide has failed the
	 * progress re-test.
	 *
	 * Each tier that rewrote history re-anchors the in-flight context snapshot,
	 * then the caller's progress predicate is re-tested; the first tier that
	 * restores progress emits one info notice describing everything freed and
	 * stops. Returns whether progress was restored — `false` falls through to
	 * the dead-end warning.
	 */
	async #rescueCompactionDeadEnd(
		signal: AbortSignal,
		options: { skipElide: boolean; hasProgress: () => boolean },
	): Promise<boolean> {
		if (signal.aborted) return false;
		let elided = 0;
		let elidedTokens = 0;
		let elideSink = "placeholders";
		if (!options.skipElide) {
			try {
				const result = await this.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
				if (elided > 0) {
					// The elide pass rewrote history; re-anchor the in-flight snapshot
					// so the caller's headroom/retry-fit re-test measures the shaken
					// context.
					this.#rebasePendingContextSnapshotAfterCompaction();
				}
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (elided > 0 && options.hasProgress()) {
				this.emitNotice(
					"info",
					`Compaction dead-end recovery: ${this.#describeElideRescue(elided, elidedTokens, elideSink)} so maintenance could make progress.`,
					"compaction",
				);
				return true;
			}
		}
		if (signal.aborted) return false;
		let imagesDropped = 0;
		try {
			imagesDropped = (await this.dropImages()).removed;
			if (imagesDropped > 0) this.#rebasePendingContextSnapshotAfterCompaction();
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (imagesDropped > 0 && options.hasProgress()) {
			const elidedPart = elided > 0 ? `${this.#describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
			this.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${imagesDropped} attached image${imagesDropped === 1 ? "" : "s"} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${elided} heavy block${elided === 1 ? "" : "s"} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 *
	 * @param allowDefer If true (default), threshold-driven handoff strategy is allowed to
	 *   schedule itself as a deferred post-prompt task and return a deferred-handoff result
	 *   immediately. The caller MUST treat that as "compaction will happen async — do not
	 *   also schedule `agent.continue()` for this turn", otherwise the deferred handoff
	 *   races a fresh streaming turn (the symptom: "Auto-handoff" loader + assistant
	 *   message still streaming). Callers on a path that is about to start a new agent
	 *   turn (e.g. the pre-prompt check in `#promptWithMessage`) pass `false` to force
	 *   inline execution so the handoff completes before the new turn begins.
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			trigger?: ContextMaintenanceTrigger;
			matchedTriggers?: readonly ContextMaintenanceTrigger[];
			segmentDeltaTokens?: number;
			segmentElapsedMs?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return COMPACTION_CHECK_NONE;
		if (reason !== "idle" && !compactionSettings.enabled) return COMPACTION_CHECK_NONE;
		const generation = this.#promptGeneration;
		const trigger: ContextMaintenanceTrigger =
			options.trigger ?? (reason === "threshold" ? "native_threshold" : reason === "overflow" ? "overflow" : reason);
		const matchedTriggers = [...(options.matchedTriggers ?? [trigger])];
		const terminalTextAnswer =
			options.terminalTextAnswer ?? isTerminalTextAssistantAnswer(this.#findLastAssistantMessage());
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;
		const suppressHandoff = options.suppressHandoff === true;
		let fallbackFromShake = false;
		// Shake runs inline (cheap, no remote LLM). On overflow recovery, if shake
		// reclaims nothing we fall through to the summary-compaction body below so
		// the oversized input still gets resolved.
		if (compactionSettings.strategy === "shake") {
			const outcome = await this.#runAutoShake(
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				trigger,
				matchedTriggers,
				terminalTextAnswer,
				options.triggerContextTokens,
				suppressContinuation,
			);
			if (outcome !== "fallback") return outcome;
			fallbackFromShake = true;
		}
		// "overflow" and "incomplete" force inline execution because they are recovery
		// paths the caller wants resolved before scheduling the next turn. "idle" is
		// triggered by the idle loop and does its own scheduling.
		if (
			!suppressHandoff &&
			!deferred &&
			allowDefer &&
			reason !== "overflow" &&
			reason !== "incomplete" &&
			reason !== "idle" &&
			compactionSettings.strategy === "handoff"
		) {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true, true, {
						...options,
						trigger,
						matchedTriggers,
						terminalTextAnswer,
					});
				},
				{ generation },
			);
			return {
				...COMPACTION_CHECK_DEFERRED_HANDOFF,
				continuationScheduled: shouldAutoContinue,
			};
		}

		// "overflow" forces context-full because the input itself is broken — a handoff
		// LLM call would hit the same overflow. "incomplete" is an output-side problem,
		// so a handoff request on the existing context is still viable. Snapcompact
		// needs the active model to read its image archive; when the configured model
		// is text-only, use the existing authenticated context-full fallback chain.
		const autoCompactionModel = this.model;
		const snapcompactModelIsTextOnly =
			compactionSettings.strategy === "snapcompact" &&
			autoCompactionModel !== undefined &&
			!autoCompactionModel.input.includes("image");
		if (snapcompactModelIsTextOnly) {
			this.emitNotice(
				"warning",
				`snapcompact needs a vision-capable active model (${autoCompactionModel.id} is text-only); using context-full auto-compaction instead.`,
				"compaction",
			);
		}
		let action: "context-full" | "handoff" | "snapcompact" =
			compactionSettings.strategy === "snapcompact" && !snapcompactModelIsTextOnly
				? "snapcompact"
				: compactionSettings.strategy === "handoff" && reason !== "overflow" && !suppressHandoff
					? "handoff"
					: "context-full";
		if (action === "snapcompact" && this.model && !this.model.input.includes("image")) {
			this.emitNotice(
				"warning",
				`snapcompact needs a vision-capable active model (${this.model.id} is text-only); using context-full auto-compaction instead.`,
				"compaction",
			);
			action = "context-full";
		}
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;
		const maintenanceId = this.#contextSteadyMaintenanceId ?? `maintenance_${crypto.randomUUID().slice(-12)}`;
		let maintenanceDecision: ContextProbeMaintenanceDecision = {
			maintenanceId,
			primaryTrigger: trigger,
			matchedTriggers,
			action,
			...(options.segmentDeltaTokens === undefined ? {} : { segmentDeltaTokens: options.segmentDeltaTokens }),
			...(options.segmentElapsedMs === undefined ? {} : { segmentElapsedMs: options.segmentElapsedMs }),
		};
		const updateMaintenanceDecisionAction = (nextAction: ContextProbeMaintenanceDecision["action"]): void => {
			maintenanceDecision = { ...maintenanceDecision, action: nextAction };
			this.#contextProbeActiveMaintenanceDecision = maintenanceDecision;
		};
		const failMaintenance = (
			failureStage: NonNullable<CompactionCheckResult["failureStage"]>,
			failureReason: string,
		): CompactionCheckResult => {
			maintenanceDecision = {
				...maintenanceDecision,
				action: "none",
				failureStage,
				failureReason,
			};
			this.#contextProbeActiveMaintenanceDecision = maintenanceDecision;
			return { ...COMPACTION_CHECK_NONE, failureStage, failureReason };
		};
		this.#contextProbeActiveMaintenanceDecision = maintenanceDecision;
		this.#contextProbeActiveCompaction =
			options.triggerContextTokens === undefined ? undefined : { tokensBefore: options.triggerContextTokens };
		let terminalFailure: CompactionCheckResult = COMPACTION_CHECK_NONE;

		try {
			// Emit start AFTER the controller is installed so isCompacting is already true
			// for any listener — and for input routed during this emit's event-loop yield:
			// a message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue (which handoff's agent.reset() would wipe).
			await this.#emitSessionEvent({
				type: "auto_compaction_start",
				maintenanceId,
				reason,
				trigger,
				matchedTriggers,
				action,
			});
			if (snapcompactModelIsTextOnly) {
				this.emitNotice(
					"warning",
					`snapcompact needs a vision-capable model (${autoCompactionModel.id} is text-only); using an LLM context-full fallback`,
					"compaction",
				);
			}
			if (action === "handoff") {
				let handoffSwitchCancelled = false;
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: autoCompactionSignal,
					onSwitchCancelled: () => {
						handoffSwitchCancelled = true;
					},
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted || handoffSwitchCancelled;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							maintenanceId,
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return COMPACTION_CHECK_NONE;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
					updateMaintenanceDecisionAction(action);
				}
				if (handoffResult) {
					this.#contextProbeActiveCompaction = {
						...this.#contextProbeActiveCompaction,
						tokensAfter: this.#estimateStoredContextTokens(),
					};
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						maintenanceId,
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					const continuationScheduled =
						!autoCompactionSignal.aborted &&
						(!this.#continuationAuthoritySourceMissing() || this.#hasQueuedUserMessage()) &&
						this.#scheduleCompactionContinuation({
							generation,
							autoContinue: reason !== "idle" && shouldAutoContinue,
							terminalTextAnswer,
							suppressContinuation,
						});
					return {
						...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
						historyRewritten: true,
					};
				}
			}

			if (!this.model) {
				const failure = failMaintenance(
					"model_unavailable",
					"No active model is selected for context maintenance.",
				);
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
					failureStage: failure.failureStage,
					failureReason: failure.failureReason,
				});
				return failure;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				const failure = failMaintenance(
					"model_unavailable",
					"No authenticated model is available for context maintenance.",
				);
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
					failureStage: failure.failureStage,
					failureReason: failure.failureReason,
				});
				return failure;
			}

			const pathEntries = this.sessionManager.getBranch();

			const autoCompactionCandidates = await this.#runnableCompactionCandidates(
				this.#getCompactionModelCandidates(availableModels),
				this.sessionId,
			);
			const preparation = prepareCompaction(pathEntries, compactionSettings, autoCompactionCandidates);
			if (!preparation) {
				const failure = failMaintenance(
					"preparation",
					"Compaction preparation found no settled history that can be rewritten.",
				);
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
					failureStage: failure.failureStage,
					failureReason: failure.failureReason,
				});
				const noProgressDeadEnd = reason !== "idle";
				let continuationScheduled = false;
				if (!suppressContinuation && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					continuationScheduled = true;
				}
				if (noProgressDeadEnd) {
					this.emitNotice(
						"warning",
						compactionDeadEndWarning("shrink it (e.g. clear large tool output)"),
						"compaction",
					);
				}
				if (continuationScheduled) return { ...failure, ...COMPACTION_CHECK_CONTINUATION };
				return noProgressDeadEnd ? { ...COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION, ...failure } : failure;
			}
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore: preparation.tokensBefore,
			};

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;
			let codexCompaction: CodexCompactionContext | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					const failure = failMaintenance(
						"extension_cancelled",
						"A session_before_compact extension cancelled automatic context maintenance.",
					);
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						maintenanceId,
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
						failureStage: failure.failureStage,
						failureReason: failure.failureReason,
					});
					return failure;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
					action = "context-full";
					updateMaintenanceDecisionAction(action);
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let summarySource: ContextSummarySource | undefined;

			// Snapcompact runs locally first. The post-compaction context = kept-recent
			// + a summary message carrying the image archive at FRAME_TOKEN_ESTIMATE per
			// frame. Known local eligibility, payload, and projection blockers downgrade
			// automatic maintenance to context-full so the session keeps running; manual
			// `/compact snapcompact` remains local-only. Unexpected snapcompact execution
			// failures are not converted into fallbacks and retain their original errors.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			let snapcompactBlocker: string | undefined;
			if (action === "snapcompact" && compactionPrep.kind !== "fromHook") {
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				const shapeSetting = this.settings.get("snapcompact.shape");
				const shape = snapcompact.resolveShapeForText(probeText, this.model, shapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					logger.warn("Snapcompact disabled: unsupported characters for selected snapcompact font", {
						model: this.model?.id,
						unrenderableRatio: renderScan.unrenderableRatio,
					});
					this.emitNotice(
						"warning",
						`snapcompact disabled: high non-ASCII rate detected (${percent}%); using an LLM context-full fallback`,
						"compaction",
					);
					snapcompactBlocker = `snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%); using context-full auto-compaction instead.`;
				} else {
					const maxFrames = this.#computeSnapcompactMaxFrames(preparation, compactionSettings);
					if (maxFrames < 1) {
						logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
							model: this.model?.id,
						});
						snapcompactBlocker =
							"snapcompact: kept history alone exceeds the context budget; using context-full auto-compaction instead.";
					} else {
						snapcompactResult = await snapcompact.compact(preparation, {
							convertToLlm,
							model: this.model,
							...(shapeSetting === "auto" ? {} : { shape }),
							maxFrames,
						});
						const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
						if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
							logger.warn("Snapcompact exceeded the per-request frame payload budget", {
								model: this.model?.id,
								framePayloadBytes,
								budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
							});
							snapcompactBlocker =
								"snapcompact produced too much standing image payload; using context-full auto-compaction instead.";
							snapcompactResult = undefined;
						}
						if (snapcompactResult) {
							const ctxWindow = this.model?.contextWindow ?? 0;
							const budget =
								ctxWindow > 0
									? ctxWindow - effectiveReserveTokens(ctxWindow, compactionSettings)
									: Number.POSITIVE_INFINITY;
							const projected = this.#projectSnapcompactContextTokens(preparation, snapcompactResult);
							if (projected > budget) {
								logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
									model: this.model?.id,
									projected,
									budget,
								});
								this.emitNotice(
									"warning",
									"snapcompact could not bring the context under the limit; using an LLM context-full fallback",
									"compaction",
								);
								snapcompactBlocker =
									"snapcompact could not bring the context under the limit; using context-full auto-compaction instead.";
								snapcompactResult = undefined;
							}
						}
					}
				}
				if (snapcompactBlocker) {
					this.emitNotice("warning", snapcompactBlocker, "compaction");
					action = "context-full";
					updateMaintenanceDecisionAction(action);
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(snapcompactResult.preserveData ?? {}) };
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});

				for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#obfuscatePreparationForProvider(preparation),
								candidate,
								this.#modelRegistry.resolver(candidate, this.sessionId),
								undefined,
								autoCompactionSignal,
								{
									promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
									extraContext: compactionPrep.hookContext,
									remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
									metadata: this.agent.metadataForProvider(candidate.provider),
									initiatorOverride: "agent",
									convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
									telemetry,
									// Honor the user's /model thinking selection on the
									// auto-compaction path — the most-fired compaction
									// site. Clamped per-model inside compact() via
									// resolveCompactionEffort.
									thinkingLevel: this.thinkingLevel,
									tools: this.agent.state.tools,
									sessionId: this.sessionId,
									promptCacheKey: this.sessionId,
									providerSessionState: this.#providerSessionState,
									codexCompaction,
									completeImpl: (requestModel, requestContext, requestOptions) =>
										this.#completeSideRequestWithProbe(
											"compaction",
											requestModel,
											requestContext,
											requestOptions,
										),
								},
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							const id = AIError.classify(error, candidate.api);
							if (AIError.is(id, AIError.Flag.AuthFailed)) {
								lastError = this.#buildCompactionAuthError();
								break;
							}
							if (AIError.is(id, AIError.Flag.Timeout)) {
								logger.warn(
									hasMoreCandidates
										? "Auto-compaction summarization timed out, trying next model"
										: "Auto-compaction summarization timed out, not retrying same model",
									{
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									},
								);
								lastError = error;
								break;
							}

							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									AIError.is(id, AIError.Flag.Transient) ||
									AIError.is(id, AIError.Flag.UsageLimit));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = error;
								break; // Exit retry loop, continue to next candidate
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, compactResult.preserveData);
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}

			summarySource = fromExtension
				? "extension"
				: snapcompactResult
					? "snapcompact"
					: compactionSettings.remoteEndpoint || preserveData?.openaiRemoteCompaction
						? "remote"
						: "local";
			const remoteMaintenance = summarySource === "remote";
			if (remoteMaintenance) updateMaintenanceDecisionAction("remote_compaction");
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore,
				summarySource,
			};
			const contextSteadyCompaction = this.#contextSteadyIsActive();
			const authorityEvidenceState = buildActiveContinuationState({
				entries: pathEntries,
				sessionId: this.sessionId,
				promptGeneration: this.#promptGeneration,
			});
			const authorityResolution = await this.#enforceContextSummaryAuthority({
				summary,
				...(shortSummary ? { shortSummary } : {}),
				summarySource,
				continuationState: authorityEvidenceState,
				...(compactionPrep.kind === "needsLlm" && !snapcompactResult
					? {
							repair: () =>
								this.#compactWithFallbackModel(
									preparation,
									COMPACTION_SUMMARY_REPAIR_INSTRUCTIONS,
									autoCompactionSignal,
									{
										promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
										extraContext: compactionPrep.hookContext,
										remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
										convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
										codexCompaction,
									},
									this.#getCompactionModelCandidates(availableModels),
								),
						}
					: {}),
			});
			summary = authorityResolution.summary;
			shortSummary = authorityResolution.shortSummary;
			const summaryAuthority = authorityResolution.audit;
			summarySource = summaryAuthority.summarySource;
			if (authorityResolution.replacement) {
				const replacement = authorityResolution.replacement;
				firstKeptEntryId = replacement.firstKeptEntryId;
				tokensBefore = replacement.tokensBefore;
				details = replacement.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, replacement.preserveData);
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const contextSteadyMidTurn = contextSteadyCompaction && options.phase === "mid_turn";
			let physicalSegment: ContextSegment | undefined;
			let segmentLogicalTurnId: string | undefined;
			if (contextSteadyMidTurn && this.settings.get("san.contextSteady.segment.enabled") === true) {
				const segment = buildContextSegment({
					entries: pathEntries,
					sessionId: this.sessionId,
					firstKeptEntryId,
					promptGeneration: this.#promptGeneration,
					maintenanceId,
					trigger,
					matchedTriggers,
					phase: "mid_turn",
					authority: fromExtension
						? "extension"
						: remoteMaintenance
							? "remote"
							: action === "snapcompact"
								? "snapcompact"
								: "context-full",
					summary,
					...(shortSummary ? { shortSummary } : {}),
					tokensBefore,
				});
				if (segment) {
					physicalSegment = segment;
					segmentLogicalTurnId = segment.logicalTurnId;
				}
			}
			const continuationState = buildActiveContinuationState({
				entries: pathEntries,
				sessionId: this.sessionId,
				promptGeneration: this.#promptGeneration,
				...(segmentLogicalTurnId ? { logicalTurnId: segmentLogicalTurnId } : {}),
				...(summaryAuthority ? { summaryAuthority } : {}),
			});
			if (continuationState) appendActiveContinuationState(this.sessionManager, continuationState);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			const tokensAfter = this.#estimateStoredContextTokens();
			if (physicalSegment) {
				appendContextSegment(this.sessionManager, {
					...physicalSegment,
					maintenance: {
						...physicalSegment.maintenance,
						tokensAfter,
					},
				});
			}
			this.#contextProbeActiveCompaction = {
				...this.#contextProbeActiveCompaction,
				tokensBefore,
				tokensAfter,
				...(summarySource ? { summarySource } : {}),
			};
			this.#rebasePendingContextSnapshotAfterCompaction();
			// Keep the in-flight request plan so the next provider transform can
			// detect the new compaction entry and rebuild against the rewritten branch.
			// The idle snapshot must not continue to describe the discarded history.
			this.#contextSteadyLastPlan = undefined;
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			// Post-maintenance progress guard — evaluated BEFORE emitting
			// auto_compaction_end so the TUI rebuild triggered by that event
			// already reflects any rescue rewrite (elide / image-drop) and the
			// dead-end warning stamped on the compaction entry. Snapcompact can
			// project over budget and fall back to a context-full summary; the
			// summarizer keeps `keepRecentTokens` of recent history verbatim and
			// findCutPoint can only cut at turn boundaries (never tool results),
			// so a single oversized recent turn (e.g. a huge tool result) leaves
			// the rewritten context still above threshold. Scheduling the
			// continuation regardless means the next agent_end re-enters
			// #checkCompaction over the same oversized tail and re-fires forever.
			// The retry and the threshold auto-continue use different progress
			// tests (a recoverable overflow only has to fit; the auto-continue
			// thrash needs the stricter recovery band), so each branch evaluates
			// its own below.
			let continuationScheduled = false;
			// A non-idle pass that wanted to continue (retry or auto-continue) but freed
			// too little for that path to proceed is a dead-end: warn once so the user
			// understands why maintenance paused instead of silently looping.
			let noProgressDeadEnd = false;
			let retryFits = false;
			let hasHeadroom = false;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					// Drop the prior turn before retry when it carries no actionable deliverable:
					// - "error": failure was kept in history but must not re-enter the next turn's prompt.
					// - reason === "incomplete" && stopReason === "length": truncated output (typically
					//   reasoning-only) — re-running it produces the same dead-end.
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) {
						this.agent.replaceMessages(messages.slice(0, -1));
						this.#rebasePendingContextSnapshotAfterCompaction();
					}
				}

				// Retry only needs the rebuilt prompt to fit the window again — measured
				// AFTER the drop above so the just-failed turn (which the retry prompt
				// won't include) is excluded. Reusing the auto-continue recovery band
				// here turned recoverable overflows into manual dead-ends (#3412 review),
				// so use the looser fit budget.
				retryFits = this.#compactionCreatedRetryFit();
				if (!retryFits) {
					retryFits = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedRetryFit(),
					});
				}
				if (!retryFits) {
					noProgressDeadEnd = true;
				}
			} else if (reason !== "idle") {
				// Mirror the shake recovery-band check: only auto-continue when compaction
				// landed residual context under `COMPACTION_RECOVERY_BAND × threshold`.
				// Re-firing on a history that still sits just over the line is the
				// snapcompact thrash, so require genuine headroom, not a bare fit. Even
				// when auto-continue is disabled, a no-headroom threshold pass must still
				// block later automatic continuations (todo reminders/session_stop hooks)
				// from re-entering the same oversized context.
				hasHeadroom = this.#compactionCreatedHeadroom();
				if (!hasHeadroom) {
					hasHeadroom = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedHeadroom(),
					});
				}
				if (!hasHeadroom) {
					noProgressDeadEnd = true;
				}
			}

			const deadEndWarning = noProgressDeadEnd ? compactionDeadEndWarning("clear large tool output") : undefined;
			if (deadEndWarning && savedCompactionEntry) {
				// Stamp the divider: the compaction bar badges the dead-end and
				// carries the full warning in its ctrl+o detail, so the pause
				// stays explained even after the notice row scrolls away.
				savedCompactionEntry.warning = deadEndWarning;
				await this.sessionManager.rewriteEntries();
			}

			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				maintenanceId,
				action,
				result,
				aborted: false,
				willRetry,
			});

			const authoritySourceMissing = this.#continuationAuthoritySourceMissing();
			if (retryFits && !authoritySourceMissing) {
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else {
				if (!authoritySourceMissing || this.#hasQueuedUserMessage()) {
					continuationScheduled = this.#scheduleCompactionContinuation({
						generation,
						autoContinue: hasHeadroom && shouldAutoContinue,
						terminalTextAnswer,
						suppressContinuation,
					});
				}
			}

			if (deadEndWarning) {
				this.emitNotice("warning", deadEndWarning, "compaction");
			}
			if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
			return noProgressDeadEnd || authoritySourceMissing
				? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION
				: COMPACTION_CHECK_NONE;
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const failure = failMaintenance("compaction_failed", errorMessage);
			terminalFailure = failure;
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				maintenanceId,
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				failureStage: failure.failureStage,
				failureReason: failure.failureReason,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: reason === "incomplete"
							? `Incomplete response recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#contextProbeActiveMaintenanceDecision?.maintenanceId === maintenanceId) {
				this.#recordContextMaintenanceProbe(
					this.#contextProbeActiveMaintenanceDecision,
					this.#contextProbeActiveCompaction,
				);
				this.#contextProbeActiveMaintenanceDecision = undefined;
				this.#contextProbeActiveCompaction = undefined;
			}
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
		return terminalFailure;
	}

	/**
	 * Run a shake-strategy auto-maintenance pass. Emits the
	 * `auto_compaction_start`/`auto_compaction_end` pair with a shake `action`,
	 * runs {@link shake} inline against the protect-window config, and schedules
	 * continuation exactly like the context-full tail.
	 *
	 * Returns `"fallback"` only for an overflow recovery where shake reclaimed
	 * nothing (or threw) — the caller then runs the summary-compaction body so
	 * the oversized input still gets resolved. Returns `"handled"` otherwise.
	 */
	async #runAutoShake(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		generation: number,
		autoContinue: boolean,
		trigger: ContextMaintenanceTrigger,
		matchedTriggers: ContextMaintenanceTrigger[],
		terminalTextAnswer: boolean,
		triggerContextTokens?: number,
		suppressContinuation = false,
	): Promise<CompactionCheckResult | "fallback"> {
		const action = "shake";
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		const signal = controller.signal;
		const maintenanceId = this.#contextSteadyMaintenanceId ?? `maintenance_${crypto.randomUUID().slice(-12)}`;
		const maintenanceDecision: ContextProbeMaintenanceDecision = {
			maintenanceId,
			primaryTrigger: trigger,
			matchedTriggers,
			action,
		};
		const tokensBefore = triggerContextTokens ?? this.#estimateStoredContextTokens();
		this.#contextProbeActiveMaintenanceDecision = maintenanceDecision;
		this.#contextProbeActiveCompaction = { tokensBefore };
		try {
			await this.#emitSessionEvent({
				type: "auto_compaction_start",
				maintenanceId,
				reason,
				trigger,
				matchedTriggers,
				action,
			});
			const result = await this.shake("elide", { config: DEFAULT_SHAKE_CONFIG, signal });
			this.#contextProbeActiveCompaction = {
				tokensBefore,
				tokensAfter: this.#estimateStoredContextTokens(),
			};
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const reclaimed = result.toolResultsDropped + result.blocksDropped > 0;
			// Detect the dead-loop reported in issues #2119/#2275: the threshold check
			// fires, shake runs, but residual context is still above the configured
			// threshold. The next agent_end would re-trigger shake, which has nothing
			// new to drop on the second pass, so the loop spins until the user kills it.
			// Same hazard for "incomplete" (the retry would re-hit the length cap) and
			// for the existing "overflow + nothing reclaimed" case. In every recovery
			// reason we hand off to the summarization-driven context-full path so the
			// situation actually resolves; "idle" is exempt because its 60s+ timer
			// re-checks usage before re-firing and cannot dead-loop on its own.
			//
			// #2275: the post-shake check MUST stay provider-anchored when caller
			// usage and local estimates diverge. The local estimator undercounts
			// thinking-signature payloads, so thinking-heavy sessions can read well
			// below the provider usage that fired the threshold. Prefer the caller's
			// context figure when supplied, then subtract shake's own savings and add
			// hysteresis (80% recovery band) so we don't oscillate at the boundary.
			// Threshold callers pass the provider-billed trigger after accounting for
			// any supersede/drop-useless pruning that already rewrote the next prompt;
			// without that pre-shake savings, shake can fall through to context-full
			// even though the post-prune history is already inside the recovery band.
			const contextWindow = this.model?.contextWindow ?? 0;
			const compactionSettings = this.settings.getGroup("compaction");
			let stillOverThreshold = false;
			if (contextWindow > 0) {
				if (typeof triggerContextTokens === "number" && Number.isFinite(triggerContextTokens)) {
					const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
					const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
					const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
					stillOverThreshold = correctedTokens > recoveryBand;
				} else {
					const postShakeTokens = this.getContextUsage({ contextWindow })?.tokens ?? 0;
					stillOverThreshold = shouldCompact(postShakeTokens, contextWindow, compactionSettings);
				}
			}
			const shouldFallBack = reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
			if (shouldFallBack) {
				const errorMessage = reclaimed
					? `Auto-shake reclaimed ~${result.tokensFreed} tokens but context is still above the threshold; falling back to context-full compaction.`
					: "Auto-shake found nothing eligible to drop; falling back to context-full compaction.";
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: !reclaimed,
					errorMessage,
				});
				return "fallback";
			}
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				maintenanceId,
				action,
				result: undefined,
				aborted: false,
				willRetry,
				skipped: !reclaimed,
			});

			let continuationScheduled = false;
			const authoritySourceMissing = this.#continuationAuthoritySourceMissing();
			if (willRetry && !authoritySourceMissing) {
				// The shake rebuild replays every entry, so a trailing error/length
				// assistant from the failed turn re-enters agent state — drop it before
				// retrying, same as the context-full tail.
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) this.agent.replaceMessages(messages.slice(0, -1));
				}
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (!authoritySourceMissing || this.#hasQueuedUserMessage()) {
				continuationScheduled = this.#scheduleCompactionContinuation({
					generation,
					autoContinue: reason !== "idle" && autoContinue,
					terminalTextAnswer,
					suppressContinuation,
				});
			}
			if (!reclaimed) {
				return willRetry && continuationScheduled
					? { ...COMPACTION_CHECK_CONTINUATION, historyRewritten: true }
					: continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: authoritySourceMissing
							? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION
							: COMPACTION_CHECK_NONE;
			}
			if (authoritySourceMissing && !continuationScheduled) {
				return { ...COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION, historyRewritten: true };
			}
			return {
				...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
				historyRewritten: true,
			};
		} catch (error) {
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					maintenanceId,
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const message = error instanceof Error ? error.message : "shake failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				maintenanceId,
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: message,
				skipped: false,
			});
			// Overflow still needs recovery even if shake threw.
			return reason === "overflow" ? "fallback" : COMPACTION_CHECK_NONE;
		} finally {
			if (this.#contextProbeActiveMaintenanceDecision?.maintenanceId === maintenanceId) {
				this.#recordContextMaintenanceProbe(
					this.#contextProbeActiveMaintenanceDecision,
					this.#contextProbeActiveCompaction,
				);
				this.#contextProbeActiveMaintenanceDecision = undefined;
				this.#contextProbeActiveCompaction = undefined;
			}
			if (this.#autoCompactionAbortController === controller) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && this.settings.get("compaction.strategy") === "off") {
			const defaultStrategy = getDefault("compaction.strategy");
			this.settings.set("compaction.strategy", defaultStrategy === "off" ? "context-full" : defaultStrategy);
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off";
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.model;
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	#isGenericAbortSentinel(message: AssistantMessage): boolean {
		return message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
	}

	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort (`#abortInProgress`), a dispose-driven
	 * abort (`#isDisposed`), or a session-induced streaming-edit guard abort
	 * (`#streamingEditAbortTriggered` — auto-generated-file guard or failed-patch
	 * preview) is deliberate and MUST settle the turn instead: routing it through
	 * retry would orphan `#retryPromise` on a continuation the guard skips
	 * (hanging the in-flight `prompt()`) or silently undo the guard's intended
	 * abort. Deliberate user interrupts (`UserInterrupt`) and silent aborts carry
	 * their own marker, not the generic sentinel, so they never match here.
	 */
	#isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#abortInProgress ||
			this.#isDisposed ||
			this.#streamingEditAbortTriggered
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (!this.#isGenericAbortSentinel(message)) return false;

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	/**
	 * 判断错误能否安全重试：瞬态错误、用量上限，以及可轮换兄弟凭证的账号策略拒绝。
	 * 上下文超限由 compaction 处理，已经产生外部可见输出的策略拒绝不能重放。
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;

		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		// 上下文超限由 compaction 处理，不能进入重试链。
		const contextWindow = this.model?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;
		const replayUnsafe = this.#hasReplayUnsafeOutput(message);
		if (AIError.is(id, AIError.Flag.AccountPolicy)) return !replayUnsafe;
		// Auth failures are terminal for the current model even when a provider
		// also stamped a transient or classifier-refusal bit. Credential rotation
		// remains provider-internal; this path must not replay the same model.
		if (AIError.is(id, AIError.Flag.AuthFailed) || AIError.is(id, AIError.Flag.OAuthExpiry)) return false;

		if (replayUnsafe) return false;
		if (this.#isClassifierRefusal(message)) return true;
		return AIError.retriable(id);
	}
	/**
	 * 重试会从 active context 移除失败消息。纯推理、空白文本和尚未写入输出端的
	 * 缓冲文本可以丢弃重放；已提交文本、图片、工具调用以及未来新增的服务端工具
	 * 都可能产生可见输出或副作用，必须视为不可重放。
	 */
	#hasReplayUnsafeOutput(message: AssistantMessage, textOutputCommitted = this.#textOutputCommitted): boolean {
		return message.content.some(block => {
			switch (block.type) {
				case "thinking":
				case "redactedThinking":
				case "fallback":
					return false;
				case "text":
					return textOutputCommitted && block.text.trim().length > 0;
				default:
					return true;
			}
		});
	}

	#isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#classifyModelRouteFailure(
		message: AssistantMessage,
		id: number = this.#classifyRetryMessage(message),
	): RouteFailureCategory | undefined {
		if (message.stopReason !== "error") return undefined;
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return "user_abort";
		if (AIError.isContextOverflow(message, this.model?.contextWindow ?? 0)) return "context_overflow";
		if (this.#isClassifierRefusal(message) || AIError.is(id, AIError.Flag.ContentBlocked)) return "refusal";
		if (AIError.is(id, AIError.Flag.AuthFailed)) return "auth_failed";

		const status = message.errorStatus ?? extractHttpStatusFromError({ message: message.errorMessage });
		if (status === 429) return "rate_limit";
		if (AIError.is(id, AIError.Flag.UsageLimit)) return "quota";
		if (AIError.is(id, AIError.Flag.Timeout)) return "timeout";
		if (status === 404 || AIError.is(id, AIError.Flag.FastModeUnsupported)) {
			return "model_unavailable";
		}
		if (status !== undefined && status >= 500) return "server_error";
		if (
			AIError.is(id, AIError.Flag.ThinkingLoop) ||
			AIError.is(id, AIError.Flag.StaleResponsesItem) ||
			AIError.is(id, AIError.Flag.MalformedFunctionCall) ||
			AIError.is(id, AIError.Flag.ProviderFinishError) ||
			AIError.is(id, AIError.Flag.Grammar)
		) {
			return undefined;
		}
		if (status === 400 || status === 409 || status === 413 || status === 422) return "invalid_request";
		if (AIError.is(id, AIError.Flag.Transient)) return "network";
		return undefined;
	}

	/** True when any registered model belongs to `provider`. */
	#hasProviderModels(provider: string): boolean {
		return this.#modelRegistry.getAll().some(model => model.provider === provider);
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		const chains: RetryFallbackChains = { ...(configuredChains as RetryFallbackChains) };
		const defaultChain = chains.default;
		if (Array.isArray(defaultChain)) {
			for (const role of Object.keys(this.settings.getModelRoles())) {
				if (role !== "default" && chains[role] === undefined) {
					chains[role] = defaultChain;
				}
			}
		}
		return chains;
	}

	#validateRetryFallbackChains(): void {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.";
			logger.warn(msg);
			this.configWarnings.push(msg);
			return;
		}

		for (const key in configuredChains) {
			const chain = (configuredChains as RetryFallbackChains)[key];
			const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
			if (keyKind === "model") {
				if (isRetryFallbackWildcardKey(key)) {
					const { provider } = parseRetryFallbackWildcard(key, p => this.#hasProviderModels(p));
					if (!this.#hasProviderModels(provider)) {
						const msg = `retry.fallbackChains wildcard key references unknown provider: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
				} else {
					const parsedKey = parseRetryFallbackSelector(key, this.#modelRegistry);
					if (!parsedKey) {
						const msg = `Invalid model selector key in retry.fallbackChains: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					} else if (!this.#modelRegistry.find(parsedKey.provider, parsedKey.id)) {
						const msg = `retry.fallbackChains key references unknown model: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
				}
			}
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`;
				logger.warn(msg);
				this.configWarnings.push(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for ${keyKind} '${key}' contains a non-string selector.`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				if (isRetryFallbackWildcardKey(selectorStr)) {
					const { provider } = parseRetryFallbackWildcard(selectorStr, p => this.#hasProviderModels(p));
					if (!this.#hasProviderModels(provider)) {
						const msg = `Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
					continue;
				}
				const logical = resolveModelOverride([selectorStr], this.#modelRegistry, this.settings);
				if (logical.logicalModelId) continue;
				const parsed = parseRetryFallbackSelector(selectorStr, this.#modelRegistry);
				if (!parsed) {
					const msg = `Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const exists = this.#modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
				}
			}
		}
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(role)) return undefined;
		if (isRetryFallbackModelKey(role)) return parseRetryFallbackSelector(role, this.#modelRegistry);
		const configuredSelector = this.settings.getModelRole(role);
		return configuredSelector ? this.#parseRetryFallbackChainEntry(configuredSelector, undefined) : undefined;
	}

	#clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	#isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#modelRegistry.isSelectorSuppressed(selector.raw);
	}

	#noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): number {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		const cooldownUntil = Date.now() + cooldownMs;
		this.#modelRegistry.suppressSelector(currentSelector, cooldownUntil);
		return cooldownUntil;
	}

	/**
	 * Map the failing model selector to the chain key that owns it, by
	 * specificity: an exact model-selector key, then a `provider/*` wildcard,
	 * then a model role whose current assignment matches, then `default`.
	 * Model-oriented keys win over roles so a chain follows the model across
	 * role reassignments.
	 */
	#resolveRetryFallbackRole(
		currentSelector: string,
		currentModel: Model | null | undefined = this.model,
	): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		if (!parsedCurrent) return undefined;
		const chains = this.#getRetryFallbackChains();
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		const currentPlainSelector = currentModel
			? formatModelSelectorValue(formatModelString(currentModel), parsedCurrent.thinkingLevel)
			: undefined;
		const currentPlainBaseSelector =
			currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;

		const exactModelKeys: string[] = [];
		const roleKeys: string[] = [];
		for (const key in chains) {
			if (!isRetryFallbackModelKey(key)) roleKeys.push(key);
			else if (!isRetryFallbackWildcardKey(key)) exactModelKeys.push(key);
		}
		const matchesCurrent = (primary: RetryFallbackSelector | undefined): boolean => {
			if (!primary) return false;
			if (primary.raw === currentSelector || (currentPlainSelector && primary.raw === currentPlainSelector)) {
				return true;
			}
			const base = formatRetryFallbackBaseSelector(primary);
			return base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector);
		};

		// 1. Exact model-selector keys — most specific.
		for (const key of exactModelKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}
		// 2. Provider wildcards — an id-prefixed key (`openrouter/google/*`)
		//    beats the plain `provider/*` key for ids under its prefix.
		let wildcardMatch: string | undefined;
		let wildcardPrefixLength = -1;
		for (const key in chains) {
			if (!isRetryFallbackWildcardKey(key) || !Array.isArray(chains[key])) continue;
			const { provider, idPrefix } = parseRetryFallbackWildcard(key, p => this.#hasProviderModels(p));
			if (provider !== parsedCurrent.provider) continue;
			if (idPrefix !== undefined && !parsedCurrent.id.startsWith(`${idPrefix}/`)) continue;
			const prefixLength = idPrefix === undefined ? 0 : idPrefix.length;
			if (prefixLength > wildcardPrefixLength) {
				wildcardMatch = key;
				wildcardPrefixLength = prefixLength;
			}
		}
		if (wildcardMatch) return wildcardMatch;
		// 3. Role keys — matched by the role's currently-assigned model.
		for (const key of roleKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}
		// 4. The default chain, when default has no explicit role primary.
		const defaultChain = chains.default;
		if (
			Array.isArray(defaultChain) &&
			defaultChain.length > 0 &&
			this.#getRetryFallbackPrimarySelector("default") === undefined
		) {
			return "default";
		}
		return undefined;
	}

	/**
	 * Parse one configured chain entry. A `provider/*` entry keeps the failing
	 * model's id and swaps the provider (google-antigravity/x → google/x); an
	 * id-prefixed `provider/prefix/*` entry re-prefixes the failing model's
	 * bare id instead (openrouter/google/* : google-antigravity/x →
	 * openrouter/google/x). Ids the target provider lacks are skipped by the
	 * candidate loop's registry lookup.
	 */
	#parseRetryFallbackChainEntry(
		entry: string,
		current: RetryFallbackSelector | undefined,
	): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(entry)) {
			if (!current) return undefined;
			const { provider, idPrefix } = parseRetryFallbackWildcard(entry, p => this.#hasProviderModels(p));
			const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
			let id: string;
			if (idPrefix !== undefined) {
				id = `${idPrefix}/${bareId}`;
			} else if (
				bareId !== current.id &&
				!this.#modelRegistry.find(provider, current.id) &&
				this.#modelRegistry.find(provider, bareId)
			) {
				// Aggregator → direct: the failing id carries a vendor prefix the
				// target provider does not use (openrouter/google/x → google-vertex/x).
				id = bareId;
			} else {
				id = current.id;
			}
			return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
		}
		const logical = resolveModelOverride([entry], this.#modelRegistry, this.settings);
		if (logical.logicalModelId && logical.model) {
			return {
				raw: entry.trim(),
				provider: logical.model.provider,
				id: logical.model.id,
				thinkingLevel: concreteThinkingLevel(logical.thinkingLevel),
			};
		}
		return parseRetryFallbackSelector(entry, this.#modelRegistry);
	}

	#getRetryFallbackEffectiveChain(role: string, currentSelector?: string): RetryFallbackSelector[] {
		const parsedCurrent = currentSelector
			? parseRetryFallbackSelector(currentSelector, this.#modelRegistry)
			: undefined;
		const seen = new Set<string>();
		const chain: RetryFallbackSelector[] = [];
		if (isRetryFallbackWildcardKey(role)) {
			// A wildcard key has no fixed primary: the active model is the
			// primary, followed by the configured provider-level fallbacks.
			if (parsedCurrent) {
				chain.push(parsedCurrent);
				seen.add(parsedCurrent.raw);
			}
		} else {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (!primarySelector) return [];
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		}
		for (const selector of this.#getRetryFallbackChains()[role] ?? []) {
			const parsed = this.#parseRetryFallbackChainEntry(selector, parsedCurrent);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel: Model | null | undefined = this.model,
	): RetryFallbackSelector[] {
		let chain = this.#getRetryFallbackEffectiveChain(role, currentSelector);
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		if (chain.length === 0 && role === "default" && parsedCurrent) {
			const chains = this.#getRetryFallbackChains();
			const defaultChain = chains.default;
			if (
				Array.isArray(defaultChain) &&
				defaultChain.length > 0 &&
				this.#getRetryFallbackPrimarySelector("default") === undefined
			) {
				const seen = new Set<string>([parsedCurrent.raw]);
				chain = [parsedCurrent];
				for (const selector of defaultChain) {
					const parsed = this.#parseRetryFallbackChainEntry(selector, parsedCurrent);
					if (!parsed || seen.has(parsed.raw)) continue;
					seen.add(parsed.raw);
					chain.push(parsed);
				}
			}
		}
		if (chain.length <= 1) return [];
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const currentPlainSelector =
			currentModel && parsedCurrent
				? formatModelSelectorValue(formatModelString(currentModel), parsedCurrent.thinkingLevel)
				: undefined;
		const currentPlainBaseSelector =
			parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;
		const exactIndex = chain.findIndex(
			selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
		);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => {
					const selectorBase = formatRetryFallbackBaseSelector(selector);
					return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
				})
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean; requireConcreteModelChange?: boolean },
	): Promise<boolean> {
		const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.configuredThinkingLevel();
		const nextThinkingLevel = resolved.explicitThinkingLevel
			? resolved.thinkingLevel
			: (selector.thinkingLevel ?? currentThinkingLevel);
		const previousEditMode = this.#resolveActiveEditMode();
		const transitionSnapshot = this.#captureModelRouteTransition();
		const originalModelRoute = this.#modelRouteLease.matchesModel(this.model)
			? transitionSnapshot.routeState.active
			: undefined;
		let routeSelection: ModelRouteSelection | undefined;
		let targetModel: Model;
		try {
			if (resolved.logicalModelId) {
				const request = this.#modelRouteResolutionRequest(resolved.logicalModelId, {
					thinkingLevel: nextThinkingLevel,
				});
				routeSelection = this.#modelRouteLease.select(
					resolved.logicalModelId,
					EPHEMERAL_MODEL_CHANGE_ROLE,
					request,
				);
				while (routeSelection) {
					const keyResult = await this.#getRouteApiKeyRejection(routeSelection);
					if (keyResult.available) break;
					routeSelection = this.#modelRouteLease.failover(request);
				}
				if (!routeSelection) {
					this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
					return false;
				}
				targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(routeSelection.model);
			} else {
				const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
				if (!candidate) return false;
				const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
				if (!apiKey) return false;
				this.#modelRouteLease.clear();
				targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(candidate);
			}
			if (options?.requireConcreteModelChange) {
				const currentModel = this.model;
				if (!currentModel) {
					this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
					return false;
				}
				const sameConcreteModel =
					formatModelStringWithRouting(targetModel) === formatModelStringWithRouting(currentModel);
				const sameRoute = routeSelection ? originalModelRoute?.routeId === routeSelection.route.routeId : true;
				if (sameConcreteModel && sameRoute) {
					this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
					return false;
				}
			}
			this.#setModelWithProviderSessionReset(targetModel);
			this.setThinkingLevel(nextThinkingLevel);
			await this.#syncAfterModelChange(previousEditMode);
		} catch (error) {
			this.#restoreModelRouteTransition(transitionSnapshot);
			throw error;
		}

		const candidateSelector = formatModelStringWithRouting(targetModel);
		this.sessionManager.appendModelChange(
			candidateSelector,
			EPHEMERAL_MODEL_CHANGE_ROLE,
			routeSelection
				? { logicalModel: routeSelection.route.logicalModelId, routeId: routeSelection.route.routeId }
				: undefined,
		);
		this.settings.getStorage()?.recordModelUsage(candidateSelector);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				originalModelRoute,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		if (routeSelection) await this.#emitModelRouteResolved(routeSelection);
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
		return true;
	}

	async #tryModelRouteFallback(
		message: AssistantMessage,
		id: number,
		retryAfterMs: number | undefined,
		errorMessage: string,
		skipSameRouteRetry: boolean,
	): Promise<{ switched: boolean; deferCrossModelFallback: boolean }> {
		const routing = this.settings.getGroup("routing");
		const previousRoute = this.#modelRouteLease.snapshot();
		if (
			!routing.enabled ||
			!routing.routeFallback ||
			!previousRoute ||
			!this.#modelRouteLease.matchesModel(this.model) ||
			this.#hasReplayUnsafeOutput(message)
		) {
			return { switched: false, deferCrossModelFallback: false };
		}

		const category = this.#classifyModelRouteFailure(message, id);
		if (!category) return { switched: false, deferCrossModelFallback: false };
		const decision = this.#modelRouteLease.resolveFallbackDecision(category, { skipSameRouteRetry });
		if (decision === "not_allowed") return { switched: false, deferCrossModelFallback: false };
		if (decision === "retry_same_route") return { switched: false, deferCrossModelFallback: true };

		const cooldownUntil = this.#noteRetryFallbackCooldown(previousRoute.modelSelector, retryAfterMs, errorMessage);
		const transitionSnapshot = this.#captureModelRouteTransition();
		const runtimeRejections: ModelRouteRuntimeRejection[] = [
			{
				routeId: previousRoute.routeId,
				code: "provider_failure",
				message: errorMessage,
			},
		];
		const request = this.#modelRouteResolutionRequest(previousRoute.logicalModelId, {
			selectionReason: "failover",
		});
		const resolution = this.#modelRegistry.getModelRouteRegistry().resolve(previousRoute.logicalModelId, request);
		for (;;) {
			const selection = this.#modelRouteLease.failover(request);
			if (!selection) {
				this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
				if (resolution) message.errorMessage = formatLogicalRouteFailure(resolution, runtimeRejections);
				return { switched: false, deferCrossModelFallback: false };
			}
			const keyResult = await this.#getRouteApiKeyRejection(selection);
			if (!keyResult.available) {
				if (keyResult.rejection) runtimeRejections.push(keyResult.rejection);
				continue;
			}

			const previousEditMode = this.#resolveActiveEditMode();
			let targetModel: Model;
			try {
				targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(selection.model);
				this.#setModelWithProviderSessionReset(targetModel);
				this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
				await this.#syncAfterModelChange(previousEditMode);
			} catch (error) {
				this.#restoreModelRouteTransition(transitionSnapshot);
				throw error;
			}

			if (this.#sessionWritesEnabled) {
				this.sessionManager.appendModelRouteChange({
					logicalModel: previousRoute.logicalModelId,
					fromRoute: previousRoute.routeId,
					toRoute: selection.route.routeId,
					reason: category,
					cooldownUntil,
				});
			}
			this.settings.getStorage()?.recordModelUsage(selection.route.modelSelector);
			await this.#emitSessionEvent({
				type: "model_route_changed",
				logicalModel: previousRoute.logicalModelId,
				fromRoute: previousRoute.routeId,
				toRoute: selection.route.routeId,
				trigger: category,
				cooldownUntil,
			});
			return { switched: true, deferCrossModelFallback: false };
		}
	}

	async #tryRetryModelFallback(
		currentSelector: string,
		options?: { pinFallback?: boolean; requireConcreteModelChange?: boolean },
	): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;
		if (options?.requireConcreteModelChange && !this.model) return false;

		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			if (await this.#applyRetryFallbackCandidate(role, selector, currentSelector, options)) return true;
		}

		return false;
	}

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.model;
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	/**
	 * True when the current turn failed on a Fireworks Fast (`-fast`) model in a
	 * way that should degrade to the reliable base (Standard) model. Fast is a
	 * speed-optimized router with no SLA, so any *pre-content* failure — a
	 * transient overload/5xx or a hard "router/model not found / unsupported" —
	 * is worth retrying on the base id. Skips failures the base model shares:
	 * context overflow (compaction's job), usage limits and auth errors (same
	 * account/key), and turns that already emitted a tool call (replaying would
	 * duplicate work). Requires the base model to exist in the registry.
	 */
	#isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (this.#isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed) || AIError.is(id, AIError.Flag.OAuthExpiry)) return false;
		return this.#modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	#isHardErrorModelRouteFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const routing = this.settings.getGroup("routing");
		if (!routing.enabled || !routing.routeFallback) return false;
		if (!this.#modelRouteLease.active || !this.#modelRouteLease.matchesModel(this.model)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.AccountPolicy)) return false;
		return this.#classifyModelRouteFailure(message, id) !== undefined;
	}

	/**
	 * True when a turn failed with a hard (non-retryable) provider error but a
	 * configured `retry.fallbackChains` entry covers the active model: the same
	 * model is not worth retrying, yet a DIFFERENT model is a fresh chance, so
	 * the chain is consulted before the error becomes final. Skips failures a
	 * model switch cannot fix or must not replay: cancellations (abort-flavored
	 * errors are not model faults), context overflow (compaction's job),
	 * classifier refusals (chain consult is handled on the retryable path with
	 * `pinFallback`), and turns that already emitted a tool call (replaying
	 * could duplicate work).
	 */
	#isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const model = this.model;
		if (!model) return false;
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.#isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.AccountPolicy)) return false;
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.thinkingLevel);
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;
		return this.#findRetryFallbackCandidates(role, currentSelector).length > 0;
	}

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
	async #tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#modelRegistry.getApiKey(baseModel, this.sessionId);
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);
		this.#setModelWithProviderSessionReset(baseModel);
		this.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<boolean> {
		if (!this.#activeRetryFallback) return false;
		if (this.#activeRetryFallback.pinned) return false;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return false;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			originalModelRoute,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#modelRegistry);
		if (!originalSelector) {
			this.#clearActiveRetryFallback();
			return false;
		}

		const currentModel = this.model;
		if (!currentModel) return false;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.#clearActiveRetryFallback();
			}
			return false;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return false;

		const currentThinkingLevel = this.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const previousEditMode = this.#resolveActiveEditMode();
		const transitionSnapshot = this.#captureModelRouteTransition();
		let routeSelection: ModelRouteSelection | undefined;
		let primaryModel: Model;
		try {
			if (
				originalModelRoute &&
				this.settings.get("routing.enabled") &&
				this.#modelRegistry.getModelRouteRegistry().has(originalModelRoute.logicalModelId)
			) {
				const request = this.#modelRouteResolutionRequest(originalModelRoute.logicalModelId, {
					affinityRouteId: originalModelRoute.routeId,
					selectionReason: "recovery",
					thinkingLevel: thinkingToApply,
				});
				routeSelection = this.#modelRouteLease.select(
					originalModelRoute.logicalModelId,
					originalModelRoute.role,
					request,
				);
				while (routeSelection) {
					const keyResult = await this.#getRouteApiKeyRejection(routeSelection);
					if (keyResult.available) break;
					routeSelection = this.#modelRouteLease.failover(request);
				}
				if (!routeSelection) {
					this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
					return false;
				}
				primaryModel = await this.#modelRegistry.refreshSelectedModelMetadata(routeSelection.model);
			} else {
				const resolvedPrimary = resolveModelOverride([originalSelector.raw], this.#modelRegistry, this.settings);
				const candidate =
					resolvedPrimary.model ?? this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
				if (!candidate) return false;
				const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
				if (!apiKey) return false;
				this.#modelRouteLease.clear();
				primaryModel = await this.#modelRegistry.refreshSelectedModelMetadata(candidate);
			}
			this.#setModelWithProviderSessionReset(primaryModel);
			this.setThinkingLevel(thinkingToApply);
			await this.#syncAfterModelChange(previousEditMode);
		} catch (error) {
			this.#restoreModelRouteTransition(transitionSnapshot);
			throw error;
		}

		const primarySelector = formatModelStringWithRouting(primaryModel);
		this.sessionManager.appendModelChange(
			primarySelector,
			EPHEMERAL_MODEL_CHANGE_ROLE,
			routeSelection
				? { logicalModel: routeSelection.route.logicalModelId, routeId: routeSelection.route.routeId }
				: undefined,
		);
		this.settings.getStorage()?.recordModelUsage(primarySelector);
		this.#clearActiveRetryFallback();
		if (routeSelection) await this.#emitModelRouteResolved(routeSelection);
		return true;
	}

	async #ensurePromptModelRoute(runtimeRejections: ModelRouteRuntimeRejection[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const activeRoute = this.#modelRouteLease.active;
		if (!activeRoute || !this.#modelRouteLease.matchesModel(model)) {
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}
			return;
		}

		const registry = this.#modelRegistry.getModelRouteRegistry();
		const request = this.#modelRouteResolutionRequest(activeRoute.logicalModelId);

		// LMR-01：配置热更新后，同 route ID 的 modelSelector/policyVersion 已变化时，
		// 旧 active lease 视为 stale，在请求边界用当前 constraints 重绑（保留 role
		// 与已选 harnessProfile）；在途 stream 不切 provider，只在下一请求前生效。
		// LMR-02：同 selector 的 billing override 变化（costRefresh）只切换 effective
		// cost，不关闭 provider session、不重建 transport 状态。
		const rebindSelection = this.#modelRouteLease.reconcile(request);
		let rebindKeyRejected = false;
		if (rebindSelection) {
			if (rebindSelection.costRefresh) {
				const costRefreshTransition = this.#captureModelRouteTransition();
				try {
					const refreshedModel = await this.#modelRegistry.refreshSelectedModelMetadata(rebindSelection.model);
					this.agent.setModel(refreshedModel);
				} catch (error) {
					this.#restoreModelRouteTransition(costRefreshTransition);
					throw error;
				}
				return;
			}
			const rebindTransition = this.#captureModelRouteTransition();
			const rebindKey = await this.#getRouteApiKeyRejection(rebindSelection);
			if (rebindKey.available) {
				const previousEditMode = this.#resolveActiveEditMode();
				let targetModel: Model;
				try {
					targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(rebindSelection.model);
					this.#setModelWithProviderSessionReset(targetModel);
					this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
					await this.#syncAfterModelChange(previousEditMode);
				} catch (error) {
					this.#restoreModelRouteTransition(rebindTransition);
					throw error;
				}
				this.settings.getStorage()?.recordModelUsage(rebindSelection.route.modelSelector);
				await this.#emitModelRouteResolved(rebindSelection);
				return;
			}
			if (rebindKey.rejection) runtimeRejections.push(rebindKey.rejection);
			this.#modelRouteLease.restoreState(rebindTransition.routeState);
			rebindKeyRejected = true;
		}

		const resolution = registry.resolve(activeRoute.logicalModelId, request);
		if (!resolution) {
			throw new Error(`Unknown logical model "${activeRoute.logicalModelId}"`);
		}
		const activeTrace = resolution.trace.find(route => route.routeId === activeRoute.routeId);
		const activeEligible = activeTrace?.eligible === true && !rebindKeyRejected;
		let originalError: Error | undefined;
		if (activeEligible) {
			const keyResult = await this.#getRouteApiKeyRejection({ route: activeRoute, model });
			if (keyResult.available) return;
			if (keyResult.rejection) runtimeRejections.push(keyResult.rejection);
			originalError = keyResult.error;
		}

		const transitionSnapshot = this.#captureModelRouteTransition();
		const excludedRouteIds = new Set(runtimeRejections.map(rejection => rejection.routeId));
		for (;;) {
			const selection = this.#modelRouteLease.failover({ ...request, excludedRouteIds });
			if (!selection) break;
			const keyResult = await this.#getRouteApiKeyRejection(selection);
			if (!keyResult.available) {
				if (keyResult.rejection) {
					runtimeRejections.push(keyResult.rejection);
					excludedRouteIds.add(keyResult.rejection.routeId);
				}
				continue;
			}

			const previousEditMode = this.#resolveActiveEditMode();
			let targetModel: Model;
			try {
				targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(selection.model);
				this.#setModelWithProviderSessionReset(targetModel);
				this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
				await this.#syncAfterModelChange(previousEditMode);
			} catch (error) {
				this.#restoreModelRouteTransition(transitionSnapshot);
				throw error;
			}

			if (this.#sessionWritesEnabled) {
				this.sessionManager.appendModelRouteChange({
					logicalModel: activeRoute.logicalModelId,
					fromRoute: activeRoute.routeId,
					toRoute: selection.route.routeId,
					reason: activeEligible ? "auth_failed" : "recovery",
				});
			}
			this.settings.getStorage()?.recordModelUsage(selection.route.modelSelector);
			if (activeEligible) {
				await this.#emitSessionEvent({
					type: "model_route_changed",
					logicalModel: activeRoute.logicalModelId,
					fromRoute: activeRoute.routeId,
					toRoute: selection.route.routeId,
					trigger: "auth_failed",
				});
			} else {
				await this.#emitModelRouteResolved(selection);
			}
			return;
		}

		this.#restoreModelRouteTransition(transitionSnapshot);
		throw new Error(formatLogicalRouteFailure(resolution, runtimeRejections), {
			...(originalError ? { cause: originalError } : {}),
		});
	}

	async #maybeRecoverModelRoute(runtimeRejections: ModelRouteRuntimeRejection[]): Promise<void> {
		if (!this.settings.get("routing.enabled")) return;
		const previousRoute = this.#modelRouteLease.snapshot();
		if (!previousRoute || !this.#modelRouteLease.matchesModel(this.model)) return;
		const transitionSnapshot = this.#captureModelRouteTransition();
		const request = this.#modelRouteResolutionRequest(previousRoute.logicalModelId, {
			selectionReason: "recovery",
		});
		let selection = this.#modelRouteLease.recover(request);
		if (!selection) return;

		for (;;) {
			const keyResult = await this.#getRouteApiKeyRejection(selection);
			if (keyResult.available) break;
			if (keyResult.rejection) runtimeRejections.push(keyResult.rejection);
			const nextSelection = this.#modelRouteLease.failover(request);
			if (!nextSelection || nextSelection.route.routeId === previousRoute.routeId) {
				this.#modelRouteLease.restoreState(transitionSnapshot.routeState);
				return;
			}
			selection = nextSelection;
		}

		const previousEditMode = this.#resolveActiveEditMode();
		let targetModel: Model;
		try {
			targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(selection.model);
			this.#setModelWithProviderSessionReset(targetModel);
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
			await this.#syncAfterModelChange(previousEditMode);
		} catch (error) {
			this.#restoreModelRouteTransition(transitionSnapshot);
			throw error;
		}

		if (this.#sessionWritesEnabled) {
			this.sessionManager.appendModelRouteChange({
				logicalModel: selection.route.logicalModelId,
				fromRoute: previousRoute.routeId,
				toRoute: selection.route.routeId,
				reason: "recovery",
			});
		}
		this.settings.getStorage()?.recordModelUsage(selection.route.modelSelector);
		await this.#emitModelRouteResolved(selection);
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff, credential rotation, and
	 * model-fallback chains. Also entered for NON-retryable errors when a switch
	 * is the recovery (`fireworksFastFallback`, `hardErrorFallback`): then a
	 * successful model switch retries immediately, and a failed switch surfaces
	 * the error without a same-model backoff retry.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			hardErrorRouteFallback?: boolean;
		},
	): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		// The Fireworks Fast→base degrade is an intrinsic model-selection safety net,
		// not a retry loop, so it runs even when the user disabled retries: it switches
		// the model once and lets the base turn proceed.
		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		// All attempts on the current model are spent. Don't fail yet: the
		// fallback chain below gets one last consult. Credential rotation can
		// consume the entire budget without the fallback branch ever running
		// (every rotation sets switchedCredential and skips it), so without
		// this last resort a provider-wide usage cap never fails over to the
		// configured chain.
		const retryBudgetExhausted = this.#retryAttempt > retrySettings.maxRetries;

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classifyRetryMessage(message);
		const accountPolicyDenial = AIError.is(id, AIError.Flag.AccountPolicy);
		const classifierRefusal = !accountPolicyDenial && this.#isClassifierRefusal(message);
		const rateLimitReason = parseRateLimitReason(errorMessage);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);
		if (
			!staleOpenAIResponsesReplayError &&
			!AIError.is(id, AIError.Flag.UsageLimit) &&
			parsedRetryAfterMs === undefined &&
			(rateLimitReason === "RATE_LIMIT_EXCEEDED" || rateLimitReason === "CONCURRENT_LIMIT")
		) {
			const reasonBackoffMs = calculateRateLimitBackoffMs(rateLimitReason);
			if (reasonBackoffMs > delayMs) delayMs = reasonBackoffMs;
		}
		let switchedCredential = false;
		let switchedModel = false;
		let switchedRoute = false;
		let deferCrossModelFallback = false;
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
		let usageLimitWaitMs: number | undefined;

		if (staleOpenAIResponsesReplayError) {
			this.#resetCurrentResponsesProviderSession("stale replay error");
		}

		if (
			!retryBudgetExhausted &&
			this.model &&
			!staleOpenAIResponsesReplayError &&
			AIError.is(id, AIError.Flag.UsageLimit)
		) {
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(rateLimitReason);
			const outcome = await this.#modelRegistry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
					modelId: this.model.id,
				},
			);
			if (outcome.switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (await this.#maybeAutoRedeemCodexReset()) {
				// A live usage-limit 429 on the active Codex account, with a banked
				// reset and the opt-in setting on: spend the reset and retry
				// immediately instead of waiting out the window. Runs after the
				// free sibling-switch above and before model fallback below.
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the provider's retry-after window for the current
				// account, or the earliest moment a temporarily blocked sibling
				// frees up (e.g. a 60s post-401 block or a 5-min usage-probe
				// block) — the next attempt's getApiKey re-ranks and picks it up.
				// Without this, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
				usageLimitWaitMs = retryAfterMs;
				if (outcome.retryAtMs !== undefined) {
					const siblingWaitMs = Math.max(0, outcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
					if (siblingWaitMs < usageLimitWaitMs) {
						usageLimitWaitMs = siblingWaitMs;
					}
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined;
		if (accountPolicyDenial && this.model) {
			switchedCredential = await this.#modelRegistry.authStorage.rotateSessionCredential(
				this.model.provider,
				this.sessionId,
				{ error: errorMessage, modelId: this.model.id },
			);
			if (switchedCredential) delayMs = 0;
		}
		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			if (allowModelFallback) {
				const routeFallback = await this.#tryModelRouteFallback(
					message,
					id,
					parsedRetryAfterMs,
					errorMessage,
					retryBudgetExhausted,
				);
				switchedRoute = routeFallback.switched;
				deferCrossModelFallback = routeFallback.deferCrossModelFallback;
			}
			// A refusal chain stops at the retry budget: the exhausted-attempt
			// last resort is for provider failures, not classifier decisions.
			if (
				!switchedRoute &&
				!deferCrossModelFallback &&
				allowModelFallback &&
				retrySettings.modelFallback &&
				!(retryBudgetExhausted && classifierRefusal)
			) {
				if (!classifierRefusal) {
					this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, {
					pinFallback: classifierRefusal,
					requireConcreteModelChange:
						options?.hardErrorFallback === true &&
						(AIError.is(id, AIError.Flag.AuthFailed) || AIError.is(id, AIError.Flag.OAuthExpiry)),
				});
			}
			// Auto fallback from a Fireworks Fast variant to its base model. Independent
			// of the role-fallback setting: it's intrinsic to the Fast contract (speed
			// best-effort, degrade to Standard on failure) and triggers on hard router
			// errors the generic retry classifier would otherwise reject.
			if (
				!switchedRoute &&
				!switchedModel &&
				!deferCrossModelFallback &&
				allowModelFallback &&
				options?.fireworksFastFallback
			) {
				switchedModel = await this.#tryFireworksFastFallback(currentSelector);
			}
			if (switchedRoute || switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs !== undefined) {
				delayMs = parsedRetryAfterMs;
			}
		}
		if (retryBudgetExhausted) {
			if (!switchedCredential && !switchedRoute && !switchedModel) {
				await this.#persistRetryLifecycleErrorMessage(message);
				// Max retries exceeded and no fallback model to switch to: emit
				// final failure and reset.
				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: message.errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
				this.#retryAttempt = 0;
				this.#resolveRetry(); // Resolve so waitForRetry() completes
				return false;
			}
			// route/model fallback 获得新的预算；仅凭证轮换继续累计 attempt，
			// 从而先穷尽不同账号，再进入跨模型恢复。
			if (switchedRoute || switchedModel) this.#retryAttempt = 1;
		}
		if (switchedRoute) {
			this.#retryAttempt = 1;
		}
		if ((classifierRefusal || accountPolicyDenial) && !switchedCredential && !switchedRoute && !switchedModel) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}
		// A fallback switch was the whole reason we entered (Fast→base degrade or
		// a hard-error chain consult) but it could not happen (e.g. no candidate
		// has a credential). Don't fall through to backing-off and retrying the
		// failing model for an error the generic classifier wouldn't retry —
		// surface it instead.
		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback || options?.hardErrorRouteFallback) &&
			!switchedRoute &&
			!switchedModel &&
			!this.#isRetryableError(message)
		) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const maxDelayMs = retrySettings.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedRoute && !switchedModel) {
			await this.#persistRetryLifecycleErrorMessage(message);
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#resolveRetry();
			return false;
		}

		await this.#recordPendingRecoveredRetryError(message, id, {
			switchedCredential,
			switchedModel: switchedRoute || switchedModel,
			delayMs,
		});

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		// Remove the failed assistant message from active context before retrying.
		this.#removeAssistantMessageFromActiveContext(message, "auto-retry");

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// Retry via continue() outside the agent_end event callback chain.
		this.#scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.settings.get("model.loopGuard.enabled") !== true) return;
		this.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: thinkingLoopRedirectTemplate,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			thinkingLoopRedirectTemplate,
			false,
			undefined,
			"agent",
		);
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.#resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from agent state and re-attempts with a fresh retry budget.
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;

		const messages = this.agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		// Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
		this.agent.replaceMessages(messages.slice(0, -1));

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async #saveBashOriginalArtifact(target: BashSessionTarget, originalText: string): Promise<string | undefined> {
		try {
			const destination = target.destination ?? (await target.pending);
			return await destination?.manager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	#createBashMessage(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): BashExecutionMessage {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		return {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
	}

	#captureBashSessionTarget(): BashSessionTarget {
		this.#bashSessionTarget.refs++;
		return this.#bashSessionTarget;
	}

	async #releaseBashSessionTarget(target: BashSessionTarget): Promise<void> {
		if (target.refs <= 0) throw new Error("Bash session target released more than once");
		target.refs--;
		if (target.refs === 0 && target.destination?.kind === "detached") {
			await target.destination.manager.close();
		}
	}

	#appendBashMessage(destination: BashAppendDestination, message: BashExecutionMessage): void {
		switch (destination.kind) {
			case "current":
				this.agent.appendMessage(message);
				destination.manager.appendMessage(message);
				break;
			case "detached":
				destination.manager.appendMessage(message);
				break;
			case "branch":
				destination.parentId = destination.manager.appendMessageToBranch(message, destination.parentId);
				break;
		}
	}

	async #appendOwnedBashMessage(target: BashSessionTarget, message: BashExecutionMessage): Promise<void> {
		try {
			const destination = target.destination ?? (await target.pending);
			if (!destination) throw new Error("Bash session target has no append destination");
			this.#appendBashMessage(destination, message);
		} finally {
			await this.#releaseBashSessionTarget(target);
		}
	}

	async #recordBashResultForTarget(
		target: BashSessionTarget,
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): Promise<void> {
		const message = this.#createBashMessage(command, result, options);
		if (this.isStreaming && target === this.#bashSessionTarget) {
			this.#pendingBashMessages.push({ target, message });
			return;
		}
		await this.#appendOwnedBashMessage(target, message);
	}

	/** Run a leaf rewrite while retaining any in-flight bash on its originating branch. */
	#withBashBranchTransition<T>(mutate: () => T): T {
		const bashTransition = this.#beginBashSessionTransition();
		let branchTransitioned = false;
		try {
			const result = mutate();
			this.#markBashSessionTransition(bashTransition);
			branchTransitioned = true;
			return result;
		} finally {
			this.#finishBashSessionTransition(bashTransition, branchTransitioned);
		}
	}

	/**
	 * Snapshot the session/branch that owns any in-flight bash before a transition.
	 * When an owner is still active, its target is detached to a clone so a failed
	 * or intentionally dropped transition never redirects the late result.
	 */
	#beginBashSessionTransition(options?: { persistDetached?: boolean }): BashSessionTransition {
		const oldTarget = this.#bashSessionTarget;
		let detachedManager: SessionManager | undefined;
		let resolveOld: ((destination: BashAppendDestination) => void) | undefined;
		if (oldTarget.refs > 0) {
			detachedManager = this.sessionManager.cloneCurrentSession({ persist: options?.persistDetached });
			const pendingOld = Promise.withResolvers<BashAppendDestination>();
			oldTarget.destination = undefined;
			oldTarget.pending = pendingOld.promise;
			resolveOld = pendingOld.resolve;
		}

		const pendingNew = Promise.withResolvers<BashAppendDestination>();
		return {
			oldTarget,
			newTarget: {
				sessionId: this.sessionManager.getSessionId(),
				refs: 0,
				pending: pendingNew.promise,
			},
			oldSessionId: this.sessionManager.getSessionId(),
			oldSessionFile: this.sessionManager.getSessionFile(),
			oldLeafId: this.sessionManager.getLeafId(),
			detachedManager,
			resolveOld,
			resolveNew: pendingNew.resolve,
		};
	}

	/** Adopt the transition's new target as the live bash owner. */
	#markBashSessionTransition(transition: BashSessionTransition): void {
		transition.newTarget.sessionId = this.sessionManager.getSessionId();
		this.#bashSessionTarget = transition.newTarget;
	}

	/**
	 * Resolve the pending append destinations opened by {@link #beginBashSessionTransition}.
	 * On success the old owner keeps its original session/branch (same file → current or
	 * branch destination; different file → detached clone); on failure both fall back to
	 * the still-current manager and the clone is discarded.
	 */
	#finishBashSessionTransition(transition: BashSessionTransition, success: boolean): void {
		const currentDestination: BashAppendDestination = { kind: "current", manager: this.sessionManager };
		let oldDestination: BashAppendDestination = currentDestination;
		if (success && transition.resolveOld) {
			const currentFile = this.sessionManager.getSessionFile();
			const sameFile =
				transition.oldSessionFile === currentFile ||
				(transition.oldSessionFile !== undefined &&
					currentFile !== undefined &&
					path.resolve(transition.oldSessionFile) === path.resolve(currentFile));
			const sameSession = transition.oldSessionId === this.sessionManager.getSessionId() && sameFile;
			if (sameSession) {
				oldDestination =
					transition.oldLeafId === this.sessionManager.getLeafId()
						? currentDestination
						: { kind: "branch", manager: this.sessionManager, parentId: transition.oldLeafId };
			} else if (transition.detachedManager) {
				oldDestination = { kind: "detached", manager: transition.detachedManager };
			}
		}

		if (transition.resolveOld) {
			transition.oldTarget.pending = undefined;
			transition.oldTarget.destination = oldDestination;
			transition.resolveOld(oldDestination);
		}

		transition.newTarget.pending = undefined;
		transition.newTarget.destination = currentDestination;
		if (!success) transition.newTarget.sessionId = this.sessionManager.getSessionId();
		transition.resolveNew(currentDestination);

		if (transition.detachedManager && (oldDestination.kind !== "detached" || transition.oldTarget.refs === 0)) {
			void transition.detachedManager.close().catch(error => {
				logger.warn("Failed to close detached bash session writer", { error: String(error) });
			});
		}
	}

	/**
	 * Execute a bash command and retain the session/branch that owned its start.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const target = this.#captureBashSessionTarget();
		let targetTransferred = false;
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		try {
			if (this.#extensionRunner?.hasHandlers("user_bash")) {
				const hookResult = await this.#extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd,
				});
				if (hookResult?.result) {
					targetTransferred = true;
					await this.#recordBashResultForTarget(target, command, hookResult.result, options);
					return hookResult.result;
				}
			}

			const abortController = new AbortController();
			this.#bashAbortControllers.add(abortController);
			let result: BashResult;
			try {
				result = await executeBashCommand(command, {
					onChunk,
					signal: abortController.signal,
					sessionKey: target.sessionId,
					cwd,
					timeout: clampTimeout("bash") * 1000,
					onMinimizedSave: originalText => this.#saveBashOriginalArtifact(target, originalText),
					useUserShell: options?.useUserShell,
				});
			} finally {
				this.#bashAbortControllers.delete(abortController);
			}

			targetTransferred = true;
			await this.#recordBashResultForTarget(target, command, result, options);
			return result;
		} finally {
			if (!targetTransferred) await this.#releaseBashSessionTarget(target);
		}
	}

	/** Record a bash result supplied outside executeBash in the current ownership scope. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const target = this.#captureBashSessionTarget();
		const message = this.#createBashMessage(command, result, options);
		if (this.isStreaming && target === this.#bashSessionTarget) {
			this.#pendingBashMessages.push({ target, message });
			return;
		}

		if (target.destination) {
			try {
				this.#appendBashMessage(target.destination, message);
			} finally {
				void this.#releaseBashSessionTarget(target);
			}
			return;
		}

		void this.#appendOwnedBashMessage(target, message).catch(error => {
			logger.error("Failed to record bash result in its owning session", { error: String(error) });
		});
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/** Flush pending bash messages after the active turn without changing their ownership. */
	async #flushPendingBashMessages(): Promise<void> {
		if (this.#pendingBashMessages.length === 0) return;
		const pending = this.#pendingBashMessages;
		this.#pendingBashMessages = [];
		for (const { target, message } of pending) {
			await this.#appendOwnedBashMessage(target, message);
		}
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing.
			const sessionId =
				this.getEvalSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				interpreter: this.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		if (this.#evalExecutionDisposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	async #prepareEvalExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	// =========================================================================
	// IRC Delivery
	// =========================================================================

	/**
	 * Surfaces and consumes pending IRC incoming records before the next model
	 * step can inject them automatically.
	 *
	 * Tool results already expose the formatted body to the model. Leaving the
	 * same record in either pending IRC queue would deliver it a second time at
	 * the next step boundary — including on `peek`, which is why inbox peeks
	 * also drain here.
	 */
	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#pendingIrcInterrupts, remaining: remainingInterrupts },
			{ records: this.#pendingIrcAsides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
			}
		}
		this.#pendingIrcInterrupts = remainingInterrupts;
		this.#pendingIrcAsides = remainingAsides;
		return messages;
	}

	/** Deliver a proactive cross-session handoff as continuation context, not chat. */
	#deliverCrossSessionHandoff(msg: IrcMessage): "injected" | "woken" {
		const record: CustomMessage = {
			role: "custom",
			customType: "cross-session-handoff",
			content: prompt.render(crossSessionHandoffTemplate, {
				from: msg.from,
				document: msg.body,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, document: msg.body, kind: "handoff" },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: record });
		if (this.isStreaming) {
			// A handoff is continuation context, not an interrupt or a reply. Fold it
			// into the current run at the next aside boundary without aborting tools.
			this.#pendingIrcAsides.push(record);
			return "injected";
		}
		if (this.#planModeState?.enabled) {
			// Preserve plan-mode convergence: record the handoff, but leave the next
			// autonomous step to the user's existing plan-mode decision flow.
			this.agent.appendMessage(record);
			this.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			return "injected";
		}
		this.#wakeForIrc([record]);
		return "woken";
	}

	/**
	 * Deliver an IRC message into this session (recipient side; called by the
	 * IrcBus). Emits the `irc_message` session event for UI cards and injects
	 * the rendered message into the model's context as an `irc:incoming`
	 * custom message:
	 *
	 * - mid-turn → queued on the aside channel and folded in at the next step
	 *   boundary (non-interrupting, like async-result deliveries) → "injected";
	 * - idle in plan mode → appended into context without waking an autonomous
	 *   turn (convergence stays user-driven) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes

	 *   → "woken".
	 *
	 * Never blocks on the recipient's turn: the wake turn is fire-and-forget.
	 *
	 * When the sender expects a reply (`send await:true`) and this session
	 * cannot produce a real reply turn in time — mid-turn with async execution
	 * disabled (the next step boundary may be gated on the sender's own batch
	 * finishing), or idle in plan mode (wake turns are suppressed) — an
	 * ephemeral side-channel auto-reply is generated from the current context
	 * (the old `respondAsBackground` path) and sent back over the bus on this
	 * agent's behalf.
	 */
	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#isDisposed) {
			throw new Error("Recipient session is disposed.");
		}
		if (msg.kind === "handoff") {
			return this.#deliverCrossSessionHandoff(msg);
		}
		// Auto-reply eligibility: the sender is blocked on an answer and this
		// session cannot produce a real reply turn in time — either mid-turn with
		// async execution disabled (no step boundary until the sender's own batch
		// ends), or idle in plan mode (autonomous wake turns are suppressed).
		const planModeIdle = !this.isStreaming && this.#planModeState?.enabled === true;
		const autoReply =
			(opts?.expectsReply ?? false) && ((this.isStreaming && !this.settings.get("async.enabled")) || planModeIdle);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: this.isStreaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: record });
		if (this.isStreaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: msg.body }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#pendingIrcInterrupts.push(record);
			}
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}
		// Plan mode: record into context but do not wake an autonomous turn.
		if (this.#planModeState?.enabled) {
			this.agent.appendMessage(record);
			this.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}
		// Idle: wake a real turn so the recipient responds (shared with the stranded-aside resume).
		this.#wakeForIrc([record]);
		return "woken";
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's
	 * behalf: a no-tools side-channel turn over the current history (same
	 * pipeline as `/btw`), recorded into this session as an `irc:autoreply`
	 * aside so the model knows what was said for it, and sent back to the
	 * sender as a regular bus message (`replyTo: msg.id`) so their parked
	 * `wait`/`await:true` resolves. Failures only log — the sender then hits
	 * its normal wait timeout.
	 */
	async #runIrcAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#isDisposed) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#emitSessionEvent({ type: "irc_message", message: record });
			// Asides drain at the next step boundary; anything left over is
			// flushed at the start of the next prompt (#flushPendingIrcAsides).
			this.#pendingIrcAsides.push(record);
			// `from` must be the id the sender addressed (msg.to) so their
			// from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Called by the IrcBus to surface
	 * agent↔agent traffic on the main session.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history. The main turn's tool catalog is sent
	 * to preserve the prompt cache, but the model is reminded not to call
	 * tools and any tool calls are discarded. The side request
	 * does not block on, or interfere with, any in-flight main turn. The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `BtwController` (`/btw`) and `OmfgController` (`/omfg`) to share
	 * the snapshot + stream pipeline. The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage; attemptedToolCall?: boolean }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const cacheSessionId = this.sessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		const options = this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
				// Side-channel turns must not share OpenAI/Codex append-only
				// conversation state with the main agent turn: IRC and /btw can run
				// while the main turn is mid-tool-call. Keep the prompt-cache key
				// stable, but give provider routing a unique request lineage. The
				// shared provider state map is still required so Codex can allocate
				// websocket state under that side-channel session id.
				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: cacheSessionId,
				preferWebsockets: this.#preferWebsockets,
				providerSessionState: this.#providerSessionState,
				reasoning: toReasoningEffort(this.thinkingLevel),
				disableReasoning: shouldDisableReasoning(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.#effectiveServiceTier(model),
				signal: args.signal,
			},
			model.provider,
		);

		let providerReplyText = "";
		let emittedReplyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = await this.#sideStreamFn(model, obfuscateProviderContext(this.#obfuscator, context), options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				providerReplyText += event.delta;
				if (args.onTextDelta) {
					const readyText = this.#deobfuscatedProviderTextReadyForDelta(providerReplyText);
					if (readyText.length > emittedReplyText.length) {
						const delta = readyText.slice(emittedReplyText.length);
						emittedReplyText = readyText;
						args.onTextDelta(delta);
					}
				}
				continue;
			}
			if (event.type === "done") {
				// A well-formed provider "done" event carries `content: AssistantContentBlock[]`,
				// but a proxy/wrapper (custom extension providers, gateway-wrapped OAuth streams,
				// see #4323) can hand back a message whose `content` was dropped or replaced with
				// `undefined`. Downstream `.content.filter` at the sanitize step below would then
				// crash the recap turn with `TypeError: undefined is not an object (evaluating
				// 'H.content.filter')`. Normalize to `[]` so the recap surfaces an empty reply
				// instead of turning a malformed side-channel response into a session-mute crash.
				const rawContent = Array.isArray(event.message.content) ? event.message.content : [];
				assistantMessage = this.#obfuscator?.hasSecrets()
					? { ...event.message, content: deobfuscateAssistantContent(this.#obfuscator, rawContent) }
					: { ...event.message, content: rawContent };
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		const attemptedToolCall = assistantMessage.content.some(block => block.type === "toolCall");
		const replyText = this.#deobfuscateFromProvider(providerReplyText);
		if (args.onTextDelta && replyText.length > emittedReplyText.length) {
			args.onTextDelta(replyText.slice(emittedReplyText.length));
		}
		const sanitizedMessage: AssistantMessage = {
			...assistantMessage,
			content: assistantMessage.content.filter(block => block.type !== "toolCall"),
		};
		return {
			replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
			assistantMessage: sanitizedMessage,
			attemptedToolCall,
		};
	}

	/** Generate an Ad-hoc Workflow descriptor only; no Workflow or tool is executed by this side request. */
	async generateAdHocWorkflowDraft(objective: string, signal?: AbortSignal): Promise<string> {
		const normalized = objective.trim();
		if (!normalized) throw new Error("Ad-hoc Workflow draft objective must not be empty");
		if (normalized.length > 20_000) throw new Error("Ad-hoc Workflow draft objective is too long");
		const result = await this.runEphemeralTurn({
			promptText: prompt.render(adHocWorkflowDraftPrompt, { objective: normalized }),
			signal,
			dedupeReply: false,
		});
		if (result.attemptedToolCall) {
			throw new Error("Ad-hoc Workflow draft generation attempted to call a tool");
		}
		return result.replyText;
	}

	/** Convert a supplied SOP to an inert Managed source draft; never publishes, approves or executes it. */
	async generateManagedSopWorkflowDraft(sop: string, signal?: AbortSignal): Promise<string> {
		const normalized = sop.trim();
		if (!normalized) throw new Error("Managed Workflow SOP must not be empty");
		if (normalized.length > 100_000) throw new Error("Managed Workflow SOP is too long");
		const result = await this.runEphemeralTurn({
			promptText: prompt.render(managedSopWorkflowDraftPrompt, { sop: normalized }),
			signal,
			dedupeReply: false,
		});
		if (result.attemptedToolCall) {
			throw new Error("Managed Workflow draft generation attempted to call a tool");
		}
		return result.replyText;
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
			const preservedBlocks: AssistantMessage["content"] = [];
			// Preserve thinking blocks: DeepSeek-class encoders replay them as
			// `reasoning_content` and reject the request (HTTP 400) when the field
			// goes missing on a turn that previously emitted thinking.
			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "developer",
			content: [{ type: "text", text: sideChannelNoToolsReminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	/**
	 * Persist any IRC asides that missed their step-boundary injection (the
	 * message landed after the turn's last aside drain). Called at the start
	 * of the next prompt so the model still sees them.
	 */
	#flushPendingIrcAsides(): void {
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		const records = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches
			// to all session listeners, which in turn handle TUI rendering and
			// sessionManager persistence via #handleAgentEvent.
			this.agent.emitExternalEvent({ type: "message_start", message: record });
			this.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort({ goalReason: "internal" });

		await this.#flushPendingBashMessages();
		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const bashTransition = this.#beginBashSessionTransition();
		// Only same-session reloads compare against the prior context to detect
		// rollback edits (`#didSessionMessagesChange` below). Building it for a
		// different-session switch is a pure waste — and on huge pre-fix sessions
		// it materializes every persisted snapcompact frame plus the
		// `openaiRemoteCompaction.replacementHistory` payload into messages,
		// blowing the heap before the new session even loads (issue #3846). The
		// error-recovery path rebuilds the context on demand from the restored
		// state instead.
		const previousSessionContext = switchingToDifferentSession ? undefined : this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.agent.peekSteeringQueue()];
		const previousFollowUpMessages = [...this.agent.peekFollowUpQueue()];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousEditMode = this.#resolveActiveEditMode();
		const previousModelRouteState = this.#modelRouteLease.captureState();
		const previousThinkingLevel = this.#thinkingLevel;
		const previousAutoThinking = this.#autoThinking;
		const previousAutoResolvedLevel = this.#autoResolvedLevel;
		const previousServiceTierByFamily = this.#serviceTierByFamily;
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousBaseSystemPromptBeforeMemoryPromotion = this.#baseSystemPromptBeforeMemoryPromotion;
		const previousLastAppliedToolSignature = this.#lastAppliedToolSignature;
		const previousPromptModelKey = this.#promptModelKey;
		const previousFreshProviderSessionId = this.#freshProviderSessionId;
		const previousInheritedProviderPromptCacheKey = this.#inheritedProviderPromptCacheKey;
		const previousAgentPromptCacheKey = this.agent.promptCacheKey;

		// Snapshot the full checkpoint runtime state: the success path calls
		// #rehydrateCheckpointRewindState(), which clears and rebuilds all four
		// fields from the target branch. On rollback every one must be restored,
		// or a failed switch leaks the target session's checkpoint state.
		const previousCheckpointState = this.#checkpointState;
		const previousPendingRewindReport = this.#pendingRewindReport;
		const previousLastCompletedRewind = this.#lastCompletedRewind;
		const previousRewoundToolResultIds = new Set(this.#rewoundToolResultIds);

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			let pendingRouteSelection: ModelRouteSelection | undefined;
			let pendingRouteChange:
				| {
						logicalModel: string;
						fromRoute: string;
						toRoute: string;
				  }
				| undefined;
			await this.sessionManager.setSessionFile(sessionPath);
			this.#markBashSessionTransition(bashTransition);
			if (switchingToDifferentSession) {
				this.#freshProviderSessionId = undefined;
				this.#clearInheritedProviderPromptCacheKey();
				this.#adoptInheritedProviderPromptCacheKey();
			}
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();

			let sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				previousSessionContext !== undefined &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			this.#rehydrateCheckpointRewindState();

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			// 会话切换与分支切换同序：SessionManager 已切到目标会话后，先重同步
			// runtime（按目标分支 entries 重建 ledger/registries），再 replay
			// 目标上下文（agent.replaceMessages）。
			await this.#syncExecutionBranch();

			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAdvisorSessionState();
			this.#syncTodoPhasesFromBranch();
			// ContextPlan epoch must rebase after resume so cache/prefix state cannot leak.
			this.#contextSteadyRequestPlan = undefined;
			this.#contextSteadyLastPlan = undefined;
			this.#contextSteadyActivationScannedSessionId = undefined;
			this.#contextSteadyLastRebaseCheckpointEntryId = undefined;
			this.#contextSteadyPendingResumeRebase = true;
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore Logical Model intent before falling back to the persisted
			// concrete selector. The saved route is affinity only; policy/auth/
			// capability changes may recover onto another route in the same group.
			const lastModelChangeRole = this.sessionManager.getLastModelChangeRole();
			const targetLogicalModelIds = getRestorableSessionLogicalModels(
				sessionContext.logicalModels,
				lastModelChangeRole,
			);
			this.#modelRouteLease.clear();
			let restoredLogicalRoute = false;
			if (this.settings.get("routing.enabled")) {
				const routeRegistry = this.#modelRegistry.getModelRouteRegistry();
				for (const logicalModelId of targetLogicalModelIds) {
					if (!routeRegistry.has(logicalModelId)) continue;
					const role =
						lastModelChangeRole && sessionContext.logicalModels[lastModelChangeRole] === logicalModelId
							? lastModelChangeRole
							: "default";
					const savedRouteId = sessionContext.modelRoutes[logicalModelId];
					const request = this.#modelRouteResolutionRequest(logicalModelId, {
						thinkingLevel:
							parseConfiguredThinkingLevel(sessionContext.configuredThinkingLevel) ??
							parseThinkingLevel(sessionContext.thinkingLevel),
						...(savedRouteId !== undefined && {
							affinityRouteId: savedRouteId,
							selectionReason: "recovery" as const,
						}),
					});
					const selection = this.#modelRouteLease.select(logicalModelId, role, request);
					if (!selection) {
						const resolution = routeRegistry.resolve(logicalModelId, request);
						if (!resolution) throw new Error(`Unknown logical model "${logicalModelId}"`);
						throw new Error(formatLogicalRouteFailure(resolution));
					}

					const currentModel = this.model;
					const match = selection.model;
					const shouldResetProviderState =
						switchingToDifferentSession ||
						(currentModel !== undefined &&
							(currentModel.provider !== match.provider ||
								currentModel.id !== match.id ||
								currentModel.api !== match.api));
					if (shouldResetProviderState) {
						this.#setModelWithProviderSessionReset(match);
					} else {
						this.agent.setModel(match);
						this.agent.setDialect(resolveDialect(this.settings.get("tools.format"), match));
					}
					if (savedRouteId && savedRouteId !== selection.route.routeId) {
						pendingRouteChange = {
							logicalModel: logicalModelId,
							fromRoute: savedRouteId,
							toRoute: selection.route.routeId,
						};
					}
					pendingRouteSelection = selection;
					restoredLogicalRoute = true;
					break;
				}
			}

			if (!restoredLogicalRoute) {
				const targetModelStrings = getRestorableSessionModels(sessionContext.models, lastModelChangeRole);
				if (targetModelStrings.length > 0) {
					const availableModels = this.#modelRegistry.getAvailable();
					let match: Model | undefined;
					for (const targetModelStr of targetModelStrings) {
						const slashIdx = targetModelStr.indexOf("/");
						if (slashIdx <= 0) continue;
						const provider = targetModelStr.slice(0, slashIdx);
						const modelId = targetModelStr.slice(slashIdx + 1);
						match = availableModels.find(m => m.provider === provider && m.id === modelId);
						if (match) break;
					}
					if (match) {
						const currentModel = this.model;
						const shouldResetProviderState =
							switchingToDifferentSession ||
							(currentModel !== undefined &&
								(currentModel.provider !== match.provider ||
									currentModel.id !== match.id ||
									currentModel.api !== match.api));
						if (shouldResetProviderState) {
							this.#setModelWithProviderSessionReset(match);
						} else {
							this.agent.setModel(match);
							this.agent.setDialect(resolveDialect(this.settings.get("tools.format"), match));
						}
					}
				}
			}

			const model = this.model;
			if (model) {
				const interruptedTurnAbort = createInterruptedTurnAbortMessage(this.sessionManager.getBranch(), {
					api: model.api,
					provider: model.provider,
					model: model.id,
				});
				if (interruptedTurnAbort) {
					this.sessionManager.appendMessage(interruptedTurnAbort);
					sessionContext = this.buildDisplaySessionContext();
					this.agent.replaceMessages(sessionContext.messages);
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = parseConfiguredThinkingLevel(this.settings.get("defaultThinkingLevel"));
			const configuredServiceTierByFamily = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			);
			// Restore the thinking selector. Each change persists the configured
			// selector (`auto` or a concrete level), so prefer it: an `auto` session
			// resumes in auto mode (reclassifying the next turn) instead of freezing at
			// the last resolved level. Entries written before the `configured` field
			// existed fall back to the concrete level (legacy pin-on-resume behavior).
			// With no thinking entry, fall back to the global default so fresh sessions
			// still classify their first turn.
			const restoredConfigured = sessionContext.configuredThinkingLevel;
			const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
				hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
					? restoredConfigured === AUTO_THINKING
						? AUTO_THINKING
						: (sessionContext.thinkingLevel as ThinkingLevel | undefined)
					: defaultThinkingLevel;
			if (restoredThinkingLevel === AUTO_THINKING) {
				this.#autoThinking = true;
				// Resume in auto (pending) like a fresh auto session: the next user
				// turn reclassifies. We intentionally do not seed the last resolved
				// effort, so the cold (--continue) and in-app switch paths display
				// identically as `auto` until then.
				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
			} else {
				this.#autoThinking = false;
				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveThinkingLevelForModel(this.model, restoredThinkingLevel);
			}
			this.#applyThinkingLevelToAgent(this.#thinkingLevel);
			this.#serviceTierByFamily = hasServiceTierEntry
				? (sessionContext.serviceTier ?? {})
				: configuredServiceTierByFamily;
			await this.#syncAfterModelChange(previousEditMode);

			if (switchingToDifferentSession) {
				await this.#resetMemoryContextForNewTranscript();
			}
			if (switchingToDifferentSession || didReloadConversationChange) {
				this.#resetAnnouncedMounts();
			}
			if (pendingRouteChange && this.#sessionWritesEnabled) {
				this.sessionManager.appendModelRouteChange({
					...pendingRouteChange,
					reason: "recovery",
				});
			}
			if (pendingRouteSelection) {
				await this.#emitModelRouteResolved(pendingRouteSelection);
			}
			this.#reconnectToAgent();
			try {
				await this.#sessionSwitchReconciler?.();
			} catch (error) {
				logger.warn("Failed to reconcile session mode after switch", {
					targetSessionFile: sessionPath,
					error: String(error),
				});
			}
			this.#finishBashSessionTransition(bashTransition, true);
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			// 回滚同样要重同步 runtime：否则 runtime 仍持有目标会话的分支状态。
			await this.#syncExecutionBranch();
			this.#freshProviderSessionId = previousFreshProviderSessionId;
			this.#syncAgentSessionId(previousSessionState.sessionId);
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			this.agent.setTools(previousTools);
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.#baseSystemPromptBeforeMemoryPromotion = previousBaseSystemPromptBeforeMemoryPromotion;
			this.#lastAppliedToolSignature = previousLastAppliedToolSignature;
			this.#promptModelKey = previousPromptModelKey;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.agent.replaceQueues(previousSteeringMessages, previousFollowUpMessages);
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			this.#inheritedProviderPromptCacheKey = previousInheritedProviderPromptCacheKey;
			this.agent.promptCacheKey = previousAgentPromptCacheKey;
			this.#checkpointState = previousCheckpointState;
			this.#pendingRewindReport = previousPendingRewindReport;
			this.#lastCompletedRewind = previousLastCompletedRewind;
			this.#rewoundToolResultIds = previousRewoundToolResultIds;
			this.#modelRouteLease.restoreState(previousModelRouteState);
			if (previousModel) {
				this.#setModelWithProviderSessionReset(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.#autoThinking = previousAutoThinking;
			this.#autoResolvedLevel = previousAutoResolvedLevel;
			this.#applyThinkingLevelToAgent(previousThinkingLevel);
			this.#serviceTierByFamily = previousServiceTierByFamily;
			this.#syncTodoPhasesFromBranch();
			this.#resetAllAdvisorRuntimes();
			this.#reconnectToAgent();
			this.#finishBashSessionTransition(bashTransition, false);
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		await this.#flushPendingBashMessages();
		// Flush pending writes before branching
		await this.sessionManager.flush();
		const bashTransition = this.#beginBashSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		try {
			if (!selectedEntry.parentId) {
				await this.sessionManager.newSession({ parentSession: previousSessionFile });
			} else {
				this.sessionManager.createBranchedSession(selectedEntry.parentId);
			}
			this.#markBashSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#finishBashSessionTransition(bashTransition, sessionTransitioned);
		}
		this.#resetAnnouncedMounts();
		this.#rehydrateCheckpointRewindState();
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#clearInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		await this.#resetMemoryContextForNewTranscript();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		// SessionManager 已切到新分支：先重同步 execution runtime（ledger/
		// scheduler/registries 依据当前分支 entries 重建），再 replay 新分支
		// 上下文（agent.replaceMessages）。顺序不可颠倒；错误绝不吞掉，直接
		// 上抛由调用方处理。
		await this.#syncExecutionBranch();

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAdvisorSessionState();
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const previousSessionFile = this.sessionFile;
		if (!this.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /btw: session is not persisted");
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot branch /btw: current session has no leaf");
		}

		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId: leafId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { cancelled: true, sessionFile: previousSessionFile };
			}
		}

		await this.#cancelPostPromptTasks();
		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.agent.replaceQueues([], []);
		if (this.isStreaming) {
			await this.abort({ goalReason: "internal", reason: "branching /btw" });
			this.agent.replaceQueues([], []);
		}
		await this.#flushPendingBashMessages();
		await this.sessionManager.flush();
		const bashTransition = this.#beginBashSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		try {
			this.sessionManager.createBranchedSession(leafId);
			this.#markBashSessionTransition(bashTransition);
			sessionTransitioned = true;
		} finally {
			this.#finishBashSessionTransition(bashTransition, sessionTransitioned);
		}
		this.#resetAnnouncedMounts();

		this.#rehydrateCheckpointRewindState();
		this.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		});
		this.sessionManager.appendMessage(sanitizeAssistantForReparentedHistory(assistantMessage));
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		await this.#resetMemoryContextForNewTranscript();

		const sessionContext = this.buildDisplaySessionContext();

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		// /btw 分支切换同样先重同步 runtime 再 replay 新分支上下文。
		await this.#syncExecutionBranch();

		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAdvisorSessionState();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return { cancelled: false, sessionFile: this.sessionFile };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		await this.#flushPendingBashMessages();
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: this.#obfuscateTextForProvider(options.customInstructions),
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
				// Same per-provider concurrency cap rationale as the compaction
				// path above (chatgpt-codex review on #3751).
				completeImpl: async (requestModel, requestContext, requestOptions) => {
					const stream = await this.#sideStreamFn(requestModel, requestContext, requestOptions);
					return stream.result();
				},
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message (or a user-invoked skill-prompt injection): land the
			// leaf on the selected node so it stays on the active branch. Skill
			// prompts are custom_message entries but must not be re-editable — their
			// content is a large expanded body, not a user turn (issue #5374).
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		const bashTransition = this.#beginBashSessionTransition();
		let summaryEntry: BranchSummaryEntry | undefined;
		let branchTransitioned = false;
		try {
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}
			this.#markBashSessionTransition(bashTransition);
			branchTransitioned = true;
		} finally {
			this.#finishBashSessionTransition(bashTransition, branchTransitioned);
		}

		this.#resetAnnouncedMounts();
		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		this.agent.replaceMessages(displayContext.messages);
		this.#rehydrateCheckpointRewindState();
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter(m => m.role === "user").length;
		const assistantMessages = state.messages.filter(m => m.role === "assistant").length;
		const toolResults = state.messages.filter(m => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalReasoning = 0;
		let totalCacheWrite = 0;
		let totalTokens = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;

		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (!details || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (!usage || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalReasoning += assistantMsg.usage.reasoningTokens ?? 0;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			}

			if (message.role === "toolResult" && message.toolName === "task") {
				const usage = getTaskToolUsage(message.details);
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalReasoning += usage.reasoningTokens ?? 0;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalTokens += usage.totalTokens;
					totalPremiumRequests += usage.premiumRequests ?? 0;
					totalCost += usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				reasoning: totalReasoning,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalTokens,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const model = this.model;
		const rawContextWindow = options?.contextWindow ?? model?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;

		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(this);
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const currentNonMessageTokens = computeNonMessageTokens(this);

		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;

		let usedTokens = 0;
		let anchored = false;

		const pendingMessages = options?.pendingMessages ?? [];

		const pending = this.#pendingContextSnapshot;

		// Always locate the latest real assistant-usage anchor after the last
		// compaction. Its provider-reported promptTokens is ground truth for
		// everything up to that point; only the tail after it is estimated.
		let anchorEntry: SessionMessageEntry | undefined;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
					anchorEntry = entry;
					break;
				}
			}
		}

		const activeMessages = [...this.messages, ...pendingMessages];
		const activePlan = this.#contextSteadyActivePlan();
		const resolvedActiveMessages = activePlan
			? materializeContextPlanMessages(activeMessages, branchEntries, activePlan)
			: activeMessages;
		if (activePlan) {
			// ContextPlan is ephemeral per request. A provider usage anchor from the
			// previous turn includes that turn's old plan message, which is absent from
			// the next request and replaced by the current snapshot. Reusing the anchor
			// therefore double-counts the retired plan. Estimate the bounded, fully
			// materialized snapshot directly so status and compaction see the same wire
			// composition as the provider and the persisted audit.
			for (const message of resolvedActiveMessages) {
				usedTokens += this.#estimateProviderWireMessageTokens(message);
			}
			usedTokens += currentNonMessageTokens;
			const messagesTokens = Math.max(0, usedTokens - categoryNonMessageTokens);
			return {
				contextWindow,
				anchored: false,
				usedTokens,
				systemPromptTokens,
				systemToolsTokens: toolsTokens,
				systemContextTokens,
				skillsTokens,
				messagesTokens,
			};
		}
		const resolvedPendingStartIndex = Math.max(0, resolvedActiveMessages.length - pendingMessages.length);
		let resolvedAnchorIndex = -1;
		let anchorAssistant: AssistantMessage | undefined;
		if (anchorEntry) {
			const a = anchorEntry.message as AssistantMessage;
			anchorAssistant = a;
			resolvedAnchorIndex = resolvedActiveMessages.indexOf(a);
			if (resolvedAnchorIndex === -1) {
				resolvedAnchorIndex = resolvedActiveMessages.findIndex(
					msg => msg.role === "assistant" && msg.timestamp === a.timestamp,
				);
			}
		}

		// A real anchor supersedes the in-flight estimate only once a step of the
		// CURRENT turn has produced provider usage — i.e. it resolves at or after
		// the pending cutoff. While the turn's first response is still pending (or
		// the newest real anchor predates this turn) the pending snapshot is the
		// only thing accounting for the just-submitted prompt, so it wins. This
		// keeps a long tool turn from stacking an estimate of the entire tail on
		// top of a stale turn-start prompt.
		const useAnchor =
			anchorAssistant !== undefined &&
			resolvedAnchorIndex !== -1 &&
			(!pending || resolvedAnchorIndex >= pending.cutoffCount);

		if (useAnchor && anchorAssistant) {
			const promptTokens =
				anchorAssistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(anchorAssistant.usage);
			const nonMessageTokens = anchorAssistant.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);
			anchored = true;
			let tailTokens = 0;
			for (let i = resolvedAnchorIndex + 1; i < resolvedActiveMessages.length; i++) {
				tailTokens += estimateTokens(resolvedActiveMessages[i]);
			}
			usedTokens = promptTokens + Math.max(0, currentNonMessageTokens - nonMessageTokens) + tailTokens + 0;
		} else if (pending) {
			anchored = true;
			let tailTokens = 0;
			const pendingCutoffCount = Math.min(pending.cutoffCount, resolvedPendingStartIndex);
			if (resolvedActiveMessages.length > pendingCutoffCount) {
				for (let i = pendingCutoffCount; i < resolvedActiveMessages.length; i++) {
					tailTokens += estimateTokens(resolvedActiveMessages[i]);
				}
			}
			usedTokens =
				pending.promptTokens + Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) + tailTokens;
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			// Fallback: look for the latest assistant message with usage/snapshot in this.messages (for branchless/fake sessions in tests)
			for (let i = resolvedActiveMessages.length - 1; i >= 0; i--) {
				const msg = resolvedActiveMessages[i];
				if (msg.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage) {
					const promptTokens = msg.contextSnapshot?.promptTokens ?? calculatePromptTokens(msg.usage);
					const nonMessageTokens = msg.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);

					let tailTokens = 0;
					for (let j = i + 1; j < resolvedActiveMessages.length; j++) {
						tailTokens += estimateTokens(resolvedActiveMessages[j]);
					}

					usedTokens =
						promptTokens +
						Math.max(0, currentNonMessageTokens - nonMessageTokens) +
						tailTokens +
						pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
					anchored = true;
					break;
				}
			}
		}
		if (!anchored) {
			let messagesTokens = 0;
			for (const msg of resolvedActiveMessages) {
				messagesTokens += estimateTokens(msg);
			}
			usedTokens = currentNonMessageTokens + messagesTokens;
		}

		const messagesTokens = Math.max(0, usedTokens - categoryNonMessageTokens);

		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens,
		};
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const breakdown = this.getContextBreakdown(options);
		if (!breakdown) return undefined;
		return {
			tokens: breakdown.usedTokens,
			contextWindow: breakdown.contextWindow,
			percent: breakdown.contextWindow > 0 ? (breakdown.usedTokens / breakdown.contextWindow) * 100 : 0,
		};
	}

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#contextUsageRevision;
	}

	#setPendingContextSnapshot(
		snapshot: { promptTokens: number; nonMessageTokens: number; cutoffCount: number } | undefined,
	): void {
		this.#pendingContextSnapshot = snapshot;
		this.#contextUsageRevision++;
	}

	/**
	 * Rebase the in-flight pending context snapshot onto the current message
	 * set after a compaction (or its dead-end rescue) rewrote history mid-run.
	 * The snapshot captures the prompt as submitted at run start and lives for
	 * the whole run; once a compaction entry lands, every earlier usage anchor
	 * is hidden from {@link getContextBreakdown}, so the stale run-start figure
	 * would be reported as live context until the next provider response. That
	 * inflated residual is what the post-compaction headroom/retry-fit checks
	 * measure — a run that started above the recovery band then trips the
	 * "freed too little context" dead-end even when compaction genuinely
	 * shrank the context. No-op while no prompt is in flight.
	 */
	#rebasePendingContextSnapshotAfterCompaction(): void {
		if (!this.#pendingContextSnapshot) return;
		const nonMessageTokens = computeNonMessageTokens(this);
		this.#setPendingContextSnapshot({
			promptTokens: nonMessageTokens + this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0),
			nonMessageTokens,
			cutoffCount: this.messages.length,
		});
	}

	#ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		const provider = model?.provider;
		if (!provider) return;
		// No-op for providers whose usage strategy lacks a header parser.
		this.#modelRegistry.authStorage.ingestUsageHeaders(provider, response.headers, {
			sessionId: this.agent.sessionId,
			baseUrl: this.#modelRegistry.getProviderBaseUrl?.(provider),
		});
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = this.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") {
						return "https://daily-cloudcode-pa.sandbox.googleapis.com";
					} else if (mode === "production") {
						return "https://daily-cloudcode-pa.googleapis.com";
					}
				}
				return this.#modelRegistry.getProviderBaseUrl?.(provider);
			},
			signal,
		});
	}

	/**
	 * Redeem one saved Codex rate-limit reset for a specific account, injecting
	 * the provider base URL like {@link AgentSession.fetchUsageReports}. Powers
	 * the `/usage reset` command and auto-redeem. Never throws for business
	 * outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	/**
	 * List saved Codex rate-limit resets per stored account, fetched live from
	 * the dedicated credits endpoint (bypasses the usage cache). Powers the
	 * `/usage reset` account selector.
	 */
	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#modelRegistry.authStorage.listResetCredits({
			sessionId: this.sessionId,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}
	async #confirmCodexAutoRedeem(decision: CodexAutoRedeemRedeemDecision): Promise<boolean> {
		const runner = this.#extensionRunner;
		if (!runner?.hasUI()) {
			this.emitNotice(
				"warning",
				"Codex saved reset is eligible, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
				"codex-auto-reset",
			);
			return false;
		}

		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		const resetLabel = decision.availableCount === 1 ? "reset" : "resets";
		try {
			const choice = await runner
				.getUIContext()
				.select(
					`Do you wanna redeem your reset?\n${who} is blocked by the weekly Codex limit for about ${formatDuration(decision.remainingMs)}. Spend 1 of ${decision.availableCount} saved ${resetLabel}?`,
					[
						{
							label: "Yes",
							description: "Redeem now and remember yes for future eligible Codex weekly blocks.",
						},
						{
							label: "No",
							description: "Do not auto-redeem saved Codex resets.",
						},
					],
				);
			if (choice === "Yes") {
				this.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") {
				this.settings.set("codexResets.autoRedeem", "no");
			}
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: String(error) });
		}
		return false;
	}

	/**
	 * Auto-redeem hook for {@link AgentSession.#handleRetryableError}'s
	 * usage-limit branch. Returns `true` only when a saved Codex reset was
	 * actually spent (so the caller retries immediately). The "unset" mode is
	 * reactive but asks before spending; "yes" skips that prompt, and "no" avoids
	 * the eligibility IO entirely. The decision remains heavily gated — see
	 * `./codex-auto-reset` and the design in `local://autoreset-spec.md`.
	 * Per-account in-flight dedup lets concurrent sessions adopt one redeem
	 * instead of double-spending.
	 */
	async #maybeAutoRedeemCodexReset(coordinator = defaultCodexAutoRedeemCoordinator): Promise<boolean> {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;
		// Cheap exits before any IO.
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;
		// Capture identity BEFORE awaits: markUsageLimitReached leaves the
		// usage-limit session credential sticky, so this names the blocked account.
		const identity = authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = (async (): Promise<boolean> => {
			const reports = await this.fetchUsageReports();
			const decision = evaluateCodexAutoRedeem({
				nowMs: Date.now(),
				provider: model.provider,
				modelId: model.id,
				settings: {
					autoRedeem: true,
					minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
					keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
				},
				identity,
				reports,
				attemptedBlockKeys: coordinator.attemptedBlockKeys,
				lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
			});
			if (!decision.redeem) {
				logger.debug("codex-auto-reset: skipped", { reason: decision.reason, account: accountKey });
				return false;
			}
			if (shouldPromptCodexAutoRedeem(cfg.autoRedeem) && !(await this.#confirmCodexAutoRedeem(decision))) {
				return false;
			}
			// Commit the attempt BEFORE acting so this block can never re-enter.
			coordinator.attemptedBlockKeys.add(decision.blockKey);
			coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
			const who = decision.target.email ?? decision.target.accountId ?? "the active account";
			const outcome = await authStorage.redeemResetCredit({
				target: decision.target,
				baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
				// Not tied to the retry abort controller: aborting a consume
				// mid-flight leaves credit state unknown.
				signal: AbortSignal.timeout(15_000),
			});
			switch (outcome.code) {
				case "reset": {
					const left = Math.max(0, decision.availableCount - 1);
					this.emitNotice(
						"info",
						`Auto-redeemed a saved Codex rate-limit reset for ${who} (${left} left); retrying now.`,
						"codex-auto-reset",
					);
					void this.fetchUsageReports();
					return true;
				}
				case "already_redeemed":
					this.emitNotice(
						"warning",
						"A saved Codex reset was already redeemed elsewhere; waiting for the window.",
						"codex-auto-reset",
					);
					return false;
				case "no_credit":
					logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: accountKey });
					return false;
				case "nothing_to_reset":
					this.emitNotice(
						"warning",
						"Codex reset reported nothing to reset; auto-redeem suppressed for this window.",
						"codex-auto-reset",
					);
					return false;
				default:
					this.emitNotice("warning", `Codex auto-redeem failed (${outcome.code}).`, "codex-auto-reset");
					return false;
			}
		})().finally(() => coordinator.inFlightByAccount.delete(accountKey));
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		if (process.env.SAN_BUILD_PROFILE === "core") {
			throw new Error("HTML export is not included in the San core binary; use the full binary.");
		}
		// Public HTML export ships in the San share/export palette currently matching
		// the legacy my.omp.sh relay — not the host's terminal theme.
		// Callers who want a themed export can pass `palette: "theme"` with
		// `themeName` directly to `exportSessionToHtml`.
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, { outputPath, palette: "web" });
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;
			// Skip aborted messages with no content
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}
	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export: system
	 * prompt, model/thinking config, tool inventory, and the full transcript
	 * rendered with markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
			inlineToolDescriptors: this.#pruneToolDescriptions,
		});
	}

	/**
	 * Dump the current session's LLM-facing request context as JSON to a
	 * auto-named file in `os.tmpdir()`. This is the synchronous
	 * `convertToLlm`-boundary snapshot — system prompt, tools (wire schemas),
	 * thinking/service tier, and converted messages — with no network round-trip
	 * and no arming flag, so advisor/side requests cannot intercept it.
	 *
	 * The file persists on disk and may contain the same raw context/secrets
	 * as `/dump`; treat the path accordingly.
	 *
	 * @returns the written file path, or `undefined` when there are no messages.
	 */
	async dumpLlmRequestToTmpDir(): Promise<string | undefined> {
		const messages = this.messages;
		if (messages.length === 0) return undefined;
		const llmMessages = await this.convertMessagesToLlm(messages);
		const payload = {
			model: this.agent.state.model ?? null,
			thinkingLevel: this.#thinkingLevel ?? null,
			serviceTier: this.#serviceTierEntry(),
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				...(tool.strict !== undefined ? { strict: tool.strict } : {}),
				...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
			})),
			messages: llmMessages,
		};
		const filePath = path.join(os.tmpdir(), `san-llm-request-${Snowflake.next()}.json`);
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return filePath;
	}

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		if (!this.#advisorEnabled) return 0;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
		return this.#advisors.length;
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	/**
	 * Lightweight advisor status for the status line: returns just the configured
	 * flag and per-advisor name/status without computing token/cost breakdowns.
	 * Avoids re-tokenizing the advisor transcript on every render frame.
	 */
	getAdvisorStatusOverview(): { configured: boolean; advisors: { name: string; status: AdvisorRuntimeStatus }[] } {
		// Override stale map entries with live runtime status: failureNotified/quotaExhausted
		// clear on reset() but #advisorStatuses lags until the next build.
		const liveStatusBySlug = new Map<string, AdvisorRuntimeStatus>();
		for (const a of this.#advisors) {
			liveStatusBySlug.set(
				a.slug,
				a.runtime.quotaExhausted ? "quota_exhausted" : a.runtime.failureNotified ? "error" : "running",
			);
		}
		const advisors = [...this.#advisorStatuses.entries()].map(([slug, { name, status }]) => ({
			name,
			status: liveStatusBySlug.get(slug) ?? status,
		}));
		return { configured: this.#advisorEnabled, advisors };
	}
	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const liveAdvisors = this.#advisors.map(a => this.#computeAdvisorStat(a));
		// Build the complete roster from #advisorStatuses, which already has the
		// correct de-duped slugs as keys. Live advisors (from #advisors) carry full
		// token/cost data; disabled/no-model/quota-exhausted advisors appear as
		// skeleton entries with just name + status so the status line renders a dot.
		const liveStatBySlug = new Map(this.#advisors.map((a, i) => [a.slug, liveAdvisors[i]]));
		const roster: PerAdvisorStat[] = [];
		for (const [slug, entry] of this.#advisorStatuses) {
			const live = liveStatBySlug.get(slug);
			if (live) {
				roster.push(live);
			} else {
				roster.push({
					name: entry.name,
					status: entry.status,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					messages: { user: 0, assistant: 0, total: 0 },
				});
			}
		}
		const active = liveAdvisors.length > 0;
		if (liveAdvisors.length === 0) {
			return {
				configured,
				active,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: roster,
			};
		}
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const messages = { user: 0, assistant: 0, total: 0 };
		let cost = 0;
		let contextTokens = 0;
		for (const a of liveAdvisors) {
			tokens.input += a.tokens.input;
			tokens.output += a.tokens.output;
			tokens.reasoning += a.tokens.reasoning;
			tokens.cacheRead += a.tokens.cacheRead;
			tokens.cacheWrite += a.tokens.cacheWrite;
			tokens.total += a.tokens.total;
			messages.user += a.messages.user;
			messages.assistant += a.messages.assistant;
			messages.total += a.messages.total;
			cost += a.cost;
			contextTokens += a.contextTokens;
		}
		// Single-advisor displays read the top-level model/window directly; surface the
		// first advisor's so the legacy status line stays byte-identical.
		return {
			configured,
			active,
			model: liveAdvisors[0].model,
			contextWindow: liveAdvisors[0].contextWindow,
			contextTokens,
			tokens,
			cost,
			messages,
			advisors: roster,
		};
	}

	/** Compute one advisor's stats slice (tokens, cost, context, message counts). */
	#computeAdvisorStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(messages);
		let input = 0;
		let output = 0;
		let reasoning = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let cost = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				reasoning += assistantMsg.usage.reasoningTokens ?? 0;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
				cost += assistantMsg.usage.cost.total;
			}
		}
		return {
			name: advisor.name,
			status: advisor.runtime.quotaExhausted
				? "quota_exhausted"
				: advisor.runtime.failureNotified
					? "error"
					: "running",
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost,
			messages: { user, assistant, total: messages.length },
			sessionId: advisor.agent.sessionId,
		};
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
		if (!stats.active && stats.advisors.length === 0) {
			return stats.configured
				? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
				: "Advisor is disabled.";
		}
		if (stats.advisors.length <= 1) {
			const s = stats.advisors[0];
			if (s && s.status === "no_model") {
				return stats.configured
					? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
					: "Advisor is disabled.";
			}
			const contextLine =
				s.contextWindow > 0
					? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `Context: ${s.contextTokens.toLocaleString()} tokens`;
			const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
			if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
			if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
			const spendLine = `Spend: ${spendParts.join(", ")}, $${s.cost.toFixed(4)}`;
			if (!s.model || s.status !== "running") return `Advisor "${s.name}" is ${s.status.replace("_", " ")}.`;
			return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
		}
		const lines = [`Advisors enabled (${stats.advisors.length}):`];
		for (const s of stats.advisors) {
			const ctx =
				s.contextWindow > 0
					? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `${s.contextTokens.toLocaleString()}`;
			lines.push(
				`  • ${s.name}${s.model && s.status === "running" ? ` (${s.model.provider}/${s.model.id})` : ` [${s.status}]`} — context ${ctx} tokens, $${s.cost.toFixed(4)}`,
			);
		}
		lines.push(
			`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
		);
		return lines.join("\n");
	}

	/**
	 * Estimate the advisor's current context tokens. A successful provider usage
	 * after the latest advisor compaction is ground truth for the prompt plus its
	 * generated output; only messages after that anchor are estimated. Usage from
	 * retained pre-compaction messages is stale and must not immediately retrigger
	 * maintenance on the newly compacted context.
	 */
	#estimateAdvisorContextTokens(messages: AgentMessage[]): number {
		let usageAnchorStartIndex = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "compactionSummary") continue;
			const advisorSummary = message as AdvisorCompactionSummaryMessage;
			// Advisor summaries created before this runtime-only boundary existed have
			// no trustworthy way to distinguish retained from newly appended messages.
			// Conservatively ignore every current assistant until the next compaction.
			usageAnchorStartIndex = advisorSummary.advisorUsageAnchorStartIndex ?? messages.length;
			break;
		}

		let lastUsageIndex: number | undefined;
		let lastUsage: AssistantMessage["usage"] | undefined;
		for (let i = messages.length - 1; i >= usageAnchorStartIndex; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
				lastUsage = assistant.usage;
				lastUsageIndex = i;
				break;
			}
		}

		const estimateOptions = { excludeEncryptedReasoning: true } as const;
		if (!lastUsage || lastUsageIndex === undefined) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateTokens(message, estimateOptions);
			}
			return estimated;
		}
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateTokens(messages[i], estimateOptions);
		}
		return calculateContextTokens(lastUsage) + trailingTokens;
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		if (this.#advisors.length === 0) return null;
		const dump = (a: ActiveAdvisor): string =>
			options?.compact
				? formatSessionHistoryMarkdown(a.agent.state.messages)
				: formatSessionDumpText({
						messages: a.agent.state.messages,
						systemPrompt: a.agent.state.systemPrompt,
						model: a.agent.state.model,
						thinkingLevel: a.agent.state.thinkingLevel,
						tools: a.agent.state.tools,
					});
		if (this.#advisors.length === 1) return dump(this.#advisors[0]);
		return this.#advisors
			.map(a => `### Advisor: ${a.name} (${a.agent.state.model.provider}/${a.agent.state.model.id})\n\n${dump(a)}`)
			.join("\n\n");
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
