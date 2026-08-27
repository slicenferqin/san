import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type StreamFn,
	type ThinkingLevel,
} from "@san/agent";
import type {
	Context,
	CredentialDisabledEvent,
	Message,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@san/ai";
import { getOpenAICodexTransportDetails, prewarmOpenAICodexResponses } from "@san/ai/providers/openai-codex-responses";
import type { Component } from "@san/tui";
import { $env, $flag, getAgentDir, getProjectDir, logger, postmortem, prompt, Snowflake } from "@san/utils";
import { INTENT_FIELD } from "@san/wire";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import { type AsyncJob, AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import { filterCodeGraphServerInstructions, filterPresentedCodeGraphTools } from "./code-intelligence";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { isAuthenticated, kNoAuth, ModelRegistry } from "./config/model-registry";
import {
	formatLogicalRouteFailure,
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { resolveDialect } from "./config/tool-dialect";
import { CursorExecHandlers } from "./cursor";
import { createExecutionRuntime, type ExecutionRuntime } from "./execution-control";
import { ProviderHealthRegistry, providerHealthKeyFromModel } from "./execution-control/provider-health";
import { TaskContractRegistry } from "./execution-control/task-contract";
import "./discovery";
import { initializeWithSettings } from "./discovery";
import { disposeAllJuliaKernelSessions, disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeAllRubyKernelSessions, disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { IrcBus } from "./irc/bus";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	discoverAndLoadMCPTools,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import type { MnemopiSessionState } from "./mnemopi/state";
import { InteractiveSessionPublisher } from "./modes/rpc-v2/interactive-session-publisher";
import { type CrossSessionClient, createCrossSessionClient } from "./peer";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	collectEnvSecrets,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./secrets";
import { AgentSession, type AgentSessionDisposeOptions, type PlanYolo, type Prewalk } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { type ActiveModelRoute, activeModelRouteFromResolution } from "./session/model-route-lease";
import { clampProviderContextImages } from "./session/provider-image-budget";
import { getRestorableSessionLogicalModels, getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import { registerWorkflowToolSession } from "./session/workflow-host";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	createVibeTools,
	type DeferredDiagnosticsEntry,
	defaultLoadModeForToolName,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isImageProviderPreference,
	isMountableUnderXdev,
	isSearchProviderId,
	isSearchProviderPreference,
	type LspStartupServerInfo,
	ReadTool,
	setExcludedSearchProviders,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { isMCPToolName, normalizeToolNames } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { isIrcEnabled } from "./tools/hub";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { authorizeToolArgumentsWithinPathScope } from "./tools/path-scope";
import { isAutoQaEnabled } from "./tools/report-tool-issue";
import { queueResolveHandler } from "./tools/resolve";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { type GitHeadState, head as gitHead } from "./utils/git";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type AsyncResultEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(lateDiagnosticTemplate, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write",
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

function collectPendingMCPToolNames(explicitToolNames: readonly string[] | undefined): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.san/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/** 可选的 root 级 Provider 健康熔断注册表，由所有 Provider 派发共享。 */
	providerHealthRegistry?: ProviderHealthRegistry;
	/** 可选的共享执行运行时。根会话未传入时自行创建，子会话继承父实例。 */
	executionRuntime?: ExecutionRuntime;
	/** 从父会话继承的固定且不可变的执行 Scope（供子会话使用）。 */
	executionScopeId?: string;
	/** 嵌套会话共享的 root 级 Task 准入注册表。 */
	taskContractRegistry?: TaskContractRegistry;
	/** 为当前会话创建注册表时使用的根会话身份。 */
	rootSessionId?: string;
	/** 仅保存在内存中的额外敏感值；传入后即使全局开关关闭也会启用出站脱敏。 */
	additionalSecretEntries?: readonly SecretEntry[];

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Logical Model route lease corresponding to `model`, when the caller already resolved one. */
	initialModelRoute?: ActiveModelRoute;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from canonical `.san/tools/`, legacy `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.san/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];
	/**
	 * Keep `toolNames` exact for an approved programmatic runtime. Disables
	 * automatic activation of extension/custom helpers and other convenience
	 * tools that are normally added to interactive or task sessions.
	 *
	 * @internal
	 */
	strictToolNames?: boolean;
	/** Absolute host-approved filesystem root enforced before strict tool execution. */
	toolPathScope?: string;
	/** 宿主明确豁免路径转换的受控自定义工具；工具实现本身不得接收文件系统路径。 */
	toolPathScopeExemptToolNames?: string[];
	/** Hard provider output cap for every request in an approved programmatic child. */
	maxOutputTokens?: number;
	/** 已审批程序化子任务的输入与输出累计硬上限。 */
	maxTotalTokens?: number;
	/** 已审批程序化子任务的累计估算成本硬上限（美元）。 */
	maxTotalCost?: number;

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent Hindsight state to alias for subagent memory tools. */
	parentHindsightSessionState?: HindsightSessionState;
	/** Parent Mnemopi state to alias for subagent memory tools. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;
	/** Inherited eval executor session id for subagents sharing parent eval state. */
	parentEvalSessionId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;
	/** RPC 历史浏览使用；禁止启动阶段修复或追加 Session journal。 */
	sessionAccess?: "read_write" | "read_only";
	/** Enable the interactive runtime's durable RPC v2 event projection. */
	publishInteractiveRpcEvents?: boolean;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export { type DialectFormat, resolveDialect } from "./config/tool-dialect";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	HIDDEN_TOOLS,
	ReadTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

// Helper Functions

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `SAN_AUTH_BROKER_URL` is set (or legacy `OMP_AUTH_BROKER_URL`), credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Delegates to {@link ./session/auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir);
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
		agentDir,
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	agentDir?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		agentDir: options.agentDir,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames: options.tools?.map(tool => tool.name),
		tools: toolMap ? buildSystemPromptToolMetadata(toolMap) : undefined,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__ompLegacyBuiltinTool" in tool && tool.__ompLegacyBuiltinTool === true;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_start",
					maintenanceId: event.maintenanceId,
					trigger: event.trigger,
					matchedTriggers: event.matchedTriggers,
					action: event.action,
				},
				ctx,
			),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					maintenanceId: event.maintenanceId,
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					recoveredErrors: event.recoveredErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

/** Dependencies used to construct an isolated auto-learn capture agent. */
export interface AutoLearnCaptureRunnerOptions {
	sourceAgent: Agent;
	captureTools: AgentTool[];
	createAgent: (options: AgentOptions) => Agent;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	createSessionId?: () => string;
}

/** Build a private capture runner over a detached message snapshot and provider session. */
export function createAutoLearnCaptureRunner(
	options: AutoLearnCaptureRunnerOptions,
): (content: string, signal?: AbortSignal) => Promise<void> {
	return async (content, signal) => {
		if (options.captureTools.length === 0 || signal?.aborted) return;
		const captureModel = options.sourceAgent.state.model;
		if (!captureModel) return;

		const captureSessionId = options.createSessionId?.() ?? Bun.randomUUIDv7();
		const captureProviderSessionState = new Map<string, ProviderSessionState>();
		const captureMessages = options.sourceAgent.state.messages.map((message): AgentMessage => {
			if (message.role === "assistant") {
				return { ...message, responseId: undefined, providerPayload: undefined };
			}
			if (message.role === "user" || message.role === "developer") {
				return { ...message, providerPayload: undefined };
			}
			return message;
		});
		const captureAgent = options.createAgent({
			initialState: {
				systemPrompt: [...options.sourceAgent.state.systemPrompt],
				model: captureModel,
				thinkingLevel: options.sourceAgent.state.thinkingLevel,
				disableReasoning: options.sourceAgent.state.disableReasoning,
				tools: options.captureTools,
				messages: captureMessages,
			},
			sessionId: captureSessionId,
			promptCacheKey: captureSessionId,
			providerSessionState: captureProviderSessionState,
			getApiKey: requestModel => options.sourceAgent.getApiKey?.(requestModel),
			onPayload: options.onPayload,
			onResponse: options.onResponse,
		});
		captureAgent.setMetadataResolver(provider => options.sourceAgent.metadataForProvider(provider));
		const captureMessage: CustomMessage = {
			role: "custom",
			customType: "autolearn-nudge",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const abortCapture = () => captureAgent.abort(signal?.reason);
		signal?.addEventListener("abort", abortCapture, { once: true });
		try {
			if (signal?.aborted) {
				abortCapture();
				return;
			}
			await captureAgent.prompt(captureMessage);
		} catch (error) {
			if (!signal?.aborted) throw error;
		} finally {
			signal?.removeEventListener("abort", abortCapture);
			for (const [providerKey, state] of captureProviderSessionState) {
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close auto-learn capture provider state", {
						providerKey,
						error: String(error),
					});
				}
			}
			captureProviderSessionState.clear();
		}
	};
}

function assertInitialModelRouteMatchesModel(model: Model | undefined, route: ActiveModelRoute | undefined): void {
	if (!route) return;
	if (!model) {
		throw new Error(
			`initialModelRoute "${route.logicalModelId}/${route.routeId}" requires model, but model was not provided`,
		);
	}
	const modelSelector = `${model.provider}/${model.id}`;
	if (route.modelSelector !== modelSelector) {
		throw new Error(
			`initialModelRoute "${route.logicalModelId}/${route.routeId}" selects "${route.modelSelector}", but model is "${modelSelector}"`,
		);
	}
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@san/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	assertInitialModelRouteMatchesModel(options.model, options.initialModelRoute);
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(
			options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)),
			path.join(agentDir, "models.yml"),
		);
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	// Subscribe before any getApiKey() call so startup model probes can't fire a
	// credential_disabled event past us. An embedder's constructor handler makes the
	// listener set non-empty from construction, which defeats AuthStorage's no-listener
	// buffer — so we can't rely on it to catch startup events for the extension runner.
	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void credentialDisabledTarget.emitCredentialDisabled(event);
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});
	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	// Kick off workspace tree discovery early. The native workspace scan returns
	// both the rendered-tree input and the AGENTS.md directory-context index, so
	// startup does not perform a second recursive filesystem search. Subagents
	// inherit the parent's resolved values via options.
	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
	const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: includeWorkspaceTree
			? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
			: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] });
	workspaceTreePromise.catch(() => {});

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
	contextFilesPromise.catch(() => {});
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", async () => {
		try {
			return await resolveActiveRepoContext(cwd);
		} catch (err) {
			logger.debug("Failed to resolve active repo context", { err: String(err) });
			return null;
		}
	});
	activeRepoContextPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const advisorConfigsPromise = logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir));
	advisorConfigsPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	// Initialize provider preferences from settings
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}

	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (isImageProviderPreference(imageProvider)) {
		setPreferredImageProvider(imageProvider);
	}

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	// Registry 身份：被采纳的 execution runtime 是共享 task/provider
	// registry 的唯一事实来源。一旦提供 runtime，其 registry 优先；调用方
	// 若同时传入不同的 registry 实例则快速失败，绝不静默割裂控制面。
	const adoptedRuntime = options.executionRuntime;
	if (adoptedRuntime) {
		if (options.providerHealthRegistry && options.providerHealthRegistry !== adoptedRuntime.providerRegistry) {
			throw new Error(
				"options.providerHealthRegistry must be the execution runtime's providerRegistry when both are provided",
			);
		}
		if (options.taskContractRegistry && options.taskContractRegistry !== adoptedRuntime.taskRegistry) {
			throw new Error(
				"options.taskContractRegistry must be the execution runtime's taskRegistry when both are provided",
			);
		}
	}
	const providerHealthRegistry = adoptedRuntime
		? adoptedRuntime.providerRegistry
		: (options.providerHealthRegistry ?? new ProviderHealthRegistry());
	const taskContractRegistry = adoptedRuntime
		? adoptedRuntime.taskRegistry
		: (options.taskContractRegistry ??
			new TaskContractRegistry({
				rootSessionId: options.rootSessionId ?? sessionManager.getSessionId(),
			}));
	// Execution runtime：根会话每个 root 恰好创建一个（并拥有）实例；
	// 子会话采纳父的共享 runtime 与固定 scope，绝不 start/sync/dispose。
	// runtime 经 session manager 持久化其 ledger，并共享上述解析出的
	// task/provider registry。
	const executionRuntime =
		adoptedRuntime ??
		createExecutionRuntime({
			rootSessionId: options.rootSessionId ?? sessionManager.getSessionId(),
			branchEntries: sessionManager.getBranch(),
			sessionManager,
			taskRegistry: taskContractRegistry,
			providerRegistry: providerHealthRegistry,
		});
	const ownedExecutionRuntime = adoptedRuntime ? undefined : executionRuntime;
	const executionScopeId = options.executionScopeId;
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined;
	const inheritedPromptCacheKey = forkCacheShapeChanged
		? undefined
		: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;
	// Startup model *selection* only needs to know whether auth is configured for
	// a candidate's provider — never the resolved key bytes. Use the synchronous,
	// side-effect-free probe (`hasConfiguredAuth`): it refreshes no OAuth tokens,
	// executes no `!command` keys, and issues no auth-broker requests. Resolving the
	// real key here (`getApiKey`) blocks resume on those network paths — a slow or
	// unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh
	// timeout per candidate (observed as a hang in `restoreSessionModel`). The real
	// key is resolved lazily per request via ModelRegistry.resolver.
	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	// Load and create secret obfuscator early so resumed session state and prompt warnings
	// reflect actual loaded secrets, not just the setting toggle.
	let obfuscator: SecretObfuscator | undefined;
	const additionalSecretEntries = options.additionalSecretEntries ?? [];
	if (settings.get("secrets.enabled") || additionalSecretEntries.length > 0) {
		const fileEntries = settings.get("secrets.enabled")
			? await logger.time("loadSecrets", loadSecrets, cwd, agentDir)
			: [];
		const envEntries = settings.get("secrets.enabled") ? collectEnvSecrets() : [];
		const allEntries = [...envEntries, ...fileEntries, ...additionalSecretEntries];
		if (allEntries.length > 0) obfuscator = new SecretObfuscator(allEntries);
	}
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	// An abnormal process exit after a non-terminal message tail is durable
	// evidence that the old process can no longer finish that turn. Preserve the
	// partial transcript and append one terminal aborted assistant record before
	// rebuilding runtime context. The helper is idempotent once that record exists.
	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort =
		options.sessionAccess === "read_only" ? undefined : createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	let existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
			modelRegistry,
		}),
	);
	let model = options.model;
	let initialModelRoute = options.initialModelRoute;
	let modelFallbackMessage: string | undefined;
	let logicalModelFailureMessage: string | undefined;
	const lastModelChangeRole = sessionManager.getLastModelChangeRole();
	const startupRouteThinkingLevel =
		options.thinkingLevel ??
		(hasExistingSession && hasThinkingEntry
			? (parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel))
			: undefined);
	const resolveStartupLogicalRoute = (
		logicalModelId: string,
		role: string,
		affinityRouteId?: string,
		routeThinkingLevel: ConfiguredThinkingLevel | undefined = startupRouteThinkingLevel,
	) => {
		const registry = modelRegistry.getModelRouteRegistry();
		const group = registry.get(logicalModelId);
		if (!group) return { kind: "unknown" as const };
		const suppressedRouteIds = new Set<string>();
		for (const route of group.routes) {
			if (modelRegistry.isSelectorSuppressed(route.modelSelector)) {
				suppressedRouteIds.add(route.id);
			}
		}
		const resolution = registry.resolve(logicalModelId, {
			...(affinityRouteId !== undefined && { affinityRouteId, selectionReason: "recovery" as const }),
			thinkingLevel: routeThinkingLevel,
			isAvailable: route =>
				modelRegistry.isProviderEnabled(route.model.provider) &&
				modelRegistry.find(route.model.provider, route.model.id) !== undefined,
			hasAuth: route => modelRegistry.hasConfiguredAuth(route.model),
			...(suppressedRouteIds.size > 0 && { suppressedRouteIds }),
		});
		const route = activeModelRouteFromResolution(resolution, role);
		// LMR-02：startup/default/resume 必须使用 resolution 的 route-local effective
		// model（携带 billing override），而不是 catalog 条目——后者会丢掉 route-local
		// cost。availability 检查已由上方 `isAvailable`（catalog find 存在性）承担。
		return route && resolution?.route
			? { kind: "selected" as const, model: resolution.route.model, route, resolution }
			: { kind: "unavailable" as const, resolution };
	};
	// Identify session model strings to restore in fallback order. We do an
	// initial pass here so model-dependent setup (thinking-level resolution,
	// host preconnect) can use the restored model; extension-registered
	// providers aren't visible yet, so we retry the preferred candidates once
	// extensions register below.
	const sessionLogicalModelIds =
		!hasExplicitModel && hasExistingSession && settings.get("routing.enabled")
			? getRestorableSessionLogicalModels(existingSession.logicalModels, lastModelChangeRole)
			: [];
	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, lastModelChangeRole)
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
	let pendingRestoredModelRouteChange: { logicalModel: string; fromRoute: string; toRoute: string } | undefined;
	if (!hasExplicitModel && !model && sessionLogicalModelIds.length > 0) {
		logger.time("restoreSessionLogicalModel", () => {
			let failedLogicalModelMessage: string | undefined;
			for (let i = 0; i < sessionLogicalModelIds.length; i++) {
				const logicalModelId = sessionLogicalModelIds[i];
				const role =
					lastModelChangeRole && existingSession.logicalModels[lastModelChangeRole] === logicalModelId
						? lastModelChangeRole
						: "default";
				const savedRouteId = existingSession.modelRoutes[logicalModelId];
				const restored = resolveStartupLogicalRoute(logicalModelId, role, savedRouteId);
				if (restored.kind !== "selected") {
					if (restored.kind === "unavailable") {
						failedLogicalModelMessage ??= restored.resolution
							? formatLogicalRouteFailure(restored.resolution)
							: `Logical model "${logicalModelId}" has no eligible route`;
					}
					continue;
				}
				model = restored.model;
				initialModelRoute = restored.route;
				if (savedRouteId && savedRouteId !== restored.route.routeId) {
					pendingRestoredModelRouteChange = {
						logicalModel: logicalModelId,
						fromRoute: savedRouteId,
						toRoute: restored.route.routeId,
					};
				}
				break;
			}
			if (failedLogicalModelMessage) {
				modelFallbackMessage = failedLogicalModelMessage;
			}
		});
	}
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowAutoAlias: true,
					allowMaxSuffix: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) {
					failedSessionModel ??= sessionModelStr;
					continue;
				}

				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					initialModelRoute = undefined;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
			initialModelRoute = activeModelRouteFromResolution(defaultRoleSpec.routeResolution, "default");
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	// Resolves the session/agent thinking level using the same precedence we
	// apply at startup: explicit option → persisted session entry → restored
	// model selector suffix → default role's explicit selector → selected
	// model's defaultLevel → global settings default. Run again after extension
	// role reclaim so the final model's own defaults aren't masked by an earlier
	// fallback model's.
	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
		let level = options.thinkingLevel;
		if (level === undefined && hasExistingSession && hasThinkingEntry) {
			level =
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel);
		}
		if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			level = restoredSessionThinkingLevel;
		}
		if (level === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
			level = defaultRoleSpec.thinkingLevel;
		}
		if (level === undefined && selectedModel?.thinking?.defaultLevel !== undefined) {
			level = selectedModel.thinking.defaultLevel;
		}
		if (level === undefined) {
			level = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
		}
		return level;
	};
	let thinkingLevel = pickInitialThinkingLevel(model);
	let autoThinking = thinkingLevel === AUTO_THINKING;
	// Concrete level the agent/session start with. With `auto` this is the
	// provisional level shown until the first per-turn classification resolves;
	// `auto` itself stays a session-only concept handled by AgentSession.
	let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			autoThinking
				? resolveProvisionalAutoLevel(resolvedModel)
				: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
		);
		// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
		// with the rest of session setup (extension/skill load, tool registry,
		// system prompt build). Without this, the first `fetch(...)` pays the
		// full handshake serially — 100–300 ms transcontinental for
		// api.anthropic.com from a residential IP. Every mode benefits
		// (interactive, print, rpc, acp).
		preconnectModelHost(model.baseUrl);
	}
	const applyStartupRouteSelection = (selection: { model: Model; route: ActiveModelRoute }): void => {
		model = selection.model;
		initialModelRoute = selection.route;
		thinkingLevel = pickInitialThinkingLevel(selection.model);
		autoThinking = thinkingLevel === AUTO_THINKING;
		effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			autoThinking
				? resolveProvisionalAutoLevel(selection.model)
				: resolveThinkingLevelForModel(selection.model, effectiveThinkingLevel),
		);
		preconnectModelHost(selection.model.baseUrl);
	};

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
		"discoverTtsrRules",
		async () => {
			const { TtsrManager } = await import("./export/ttsr");
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: ttsrSettings.disabledRules,
			});
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
		},
	);

	// Resolve contextFiles up-front (it's needed before tool creation). The
	// workspace tree scan is slow on large repos and we MUST NOT block startup on
	// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
	// will re-race the same promise through its own withDeadline path. Background
	// work continues so caches still warm.
	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const result = await Promise.race([
			work,
			Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
				timedOut = true;
				return undefined;
			}),
		]);
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};
	const [contextFiles, resolvedWorkspaceTree, watchdogFiles, activeRepoContext, discoveredAdvisors] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
			watchdogFilesPromise,
			activeRepoContextPromise,
			advisorConfigsPromise,
		]);

	let agent: Agent;
	let session!: AgentSession;
	let interactiveSessionPublisher: InteractiveSessionPublisher | undefined;
	let hasSession = false;
	let hasRegistered = false;
	const enableLsp = options.enableLsp ?? true;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	// Only the first top-level session in a process owns an AsyncJobManager.
	// Subagents inherit the parent's manager via `AsyncJobManager.instance()`
	// (set below), and any additional top-level session spun up in-process
	// (e.g. the agent-creation architect in `agent-dashboard.ts`) must share
	// the live singleton — otherwise its dispose path would clobber the
	// owning session's manager and break the `task`/`bash` async paths
	// (issue #1923). The `instance()` guard means later sessions also skip
	// constructing an orphaned manager that nothing would ever route to.
	const asyncJobManager =
		!options.parentTaskPrefix && !AsyncJobManager.instance()
			? new AsyncJobManager({
					maxRunningJobs: asyncMaxJobs,
					onJobComplete: async (jobId, result, job) => {
						if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
						const formattedResult = await formatAsyncResultForFollowUp(result);
						if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

						const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
						session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
							jobId,
							result: formattedResult,
							job,
							durationMs,
						});
					},
				})
			: undefined;

	const scopedAsyncJobManager = asyncJobManager ?? (options.parentTaskPrefix ? AsyncJobManager.instance() : undefined);

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
	// The registry generation this construction owns: the ref it registered, or
	// the parked ref it refreshed in place on same-generation re-entry. Teardown
	// below only unregisters while THIS generation still owns the id — a
	// superseding construction may have replaced the ref (abandoned quiescent
	// main), and a late dispose of the old session must not unregister the new
	// generation out from under it.
	let ourGenerationRef: AgentRef | undefined;
	/**
	 * Forget the agent ref on teardown — unless the agent is being parked (or is
	 * already parked). Parking disposes the session but keeps the ref addressable
	 * (history://, revive); only process teardown / explicit kill unregisters.
	 */
	const unregisterUnlessParked = (): void => {
		if (agentRegistry.get(resolvedAgentId)?.status === "parked") return;
		// Parking state belongs to the lifecycle that manages THIS registry; a
		// custom registry may not be the global manager's, whose isParking would
		// consult unrelated park state.
		const lifecycle = AgentLifecycleManager.global();
		if (lifecycle.manages(agentRegistry) && lifecycle.isParking(resolvedAgentId)) return;
		// Generation CAS: only remove the ref this construction registered. If a
		// newer generation owns the id now, leave its ref alone.
		if (ourGenerationRef && agentRegistry.get(resolvedAgentId) !== ourGenerationRef) return;
		agentRegistry.unregister(resolvedAgentId);
	};
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		const getActiveHarnessProfile = (): string | undefined => {
			const activeModel = agent?.state.model ?? model;
			if (!activeModel) return undefined;
			const activeRoute = session ? session.activeModelRoute : initialModelRoute;
			if (activeRoute?.modelSelector === `${activeModel.provider}/${activeModel.id}`) {
				return activeRoute.harnessProfile;
			}
			return formatModelString(activeModel);
		};
		// Per-path mutation counter shared across edit/write tools. Late-diagnostics
		// entries capture it at fetch time and are dropped at injection if a newer
		// mutation (any tool) bumped it in the meantime.
		const fileMutationVersions = new Map<string, number>();
		const activeToolNames = new Set<string>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			getRootSessionId: () => taskContractRegistry.rootSessionId ?? sessionManager.getSessionId(),
			taskContractRegistry,
			providerHealthRegistry,
			executionRuntime: executionRuntime,
			getExecutionScopeId: () => executionScopeId ?? session?.getActiveExecutionScopeId(),
			isToolActive: name => activeToolNames.has(name),
			setActiveToolNames,
			hasUI: options.hasUI ?? false,
			strictToolNames: options.strictToolNames,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.refreshSkills(),
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			prewalkArmed: options.prewalk !== undefined,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			generateSessionHandoff: (focus, signal) => session.generateHandoffDocument(focus, signal),
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getSubagentModelOverride: () => session?.getSubagentModelOverride(),
			getActiveModel: () => agent?.state.model ?? model,
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getPlanModeState: () => session?.getPlanModeState(),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? "local://PLAN.md",
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			queueDeferredDiagnostics: entry => session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekPlanProposalHandler: () => session.peekPlanProposalHandler(),
			setPlanProposalHandler: handler => session.setPlanProposalHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch (error) {
					logger.warn("Failed to allocate tool output artifact", { toolType, error });
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Subagents inherit the singleton (the parent's manager) so their bash/task
			// completions still flow into the spawning conversation's yieldQueue.
			// Secondary in-process top-level sessions (no parentTaskPrefix, no
			// constructed manager because the singleton was already installed) leave
			// this undefined so tools and session job snapshots refuse async work
			// instead of silently routing into the owning session (issue #1923).
			asyncJobManager: scopedAsyncJobManager,
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Discover MCP tools from .mcp.json files
		let mcpManager: MCPManager | undefined = options.mcpManager;
		toolSession.mcpManager = mcpManager;
		const enableMCP = options.enableMCP ?? true;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		let startDeferredMCPDiscovery: ((liveSession: AgentSession) => void) | undefined;
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP servers when builtin browser tool is active
			filterBrowser: settings.get("browser.enabled") ?? false,
		};
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}

				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = liveSession => {
					void (async () => {
						try {
							const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
								deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
							);
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
							// Connected MCP tools are enabled and mounted under xd:// devices.
							await liveSession.refreshMCPTools(mcpResult.tools);
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
				};
			} else {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
					...mcpDiscoverOptions,
					cacheStorage: settings.getStorage(),
					authStorage,
				});
				mcpManager = mcpResult.manager;
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				// Log MCP errors
				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				if (mcpResult.tools.length > 0) {
					// MCP tools are LoadedCustomTool, extract the tool property
					customTools.push(
						...filterPresentedCodeGraphTools(
							mcpResult.tools.map(loaded => loaded.tool),
							settings.get("san.codeIntelligence.enabled"),
						),
					);
				}
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		// Add image tools when generation is enabled and either no explicit tool
		// whitelist was given or it names `generate_image`. Image gen is a
		// discoverable custom tool: once it enters the registry the common
		// partition presents it under xd:// (or routes it to BM25 discovery), so no
		// source-specific force-activation is needed — only this eligibility gate.
		const imageGenRequested = !options.toolNames || options.toolNames.includes("generate_image");
		if (settings.get("generate_image.enabled") && imageGenRequested) {
			const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
			if (imageGenTools.length > 0) {
				customTools.push(...(imageGenTools as unknown as CustomTool[]));
			}
		}

		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			customTools.push(...getSearchTools());
		}

		// Discover custom tools from canonical `.san/tools/`, legacy `.omp/tools/`, `.claude/tools/`, plugins, etc.
		// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
		// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
		// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
		// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
		// execution back through the parent — wrong for isolated tasks and for
		// pending-action queueing.
		const builtInToolNames = builtinTools.map(t => t.name);
		const customToolPaths: ToolPathWithSource[] =
			options.preloadedCustomToolPaths ??
			(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd)));
		const customToolsLoadResult = await logger.time("loadCustomTools", () =>
			loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
		);
		for (const { path, error } of customToolsLoadResult.errors) {
			logger.error("Custom tool load failed", { path, error });
		}
		if (customToolsLoadResult.tools.length > 0) {
			customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}

		// Load extensions. Three paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedExtensionPaths` (subagent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   3. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
			};
			// Capture paths for downstream forwarding; filter inline-factory
			// entries (`<inline-N>`) — those are per-session, not source paths.
			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
		} else if (options.preloadedExtensionPaths) {
			extensionPaths = options.preloadedExtensionPaths;
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, settings),
			);
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;

		// Load inline extensions from factories
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}
		// Hydrate cached runtime (extension) provider catalogs before model
		// resolution. Dynamic-only providers have no synchronous registration side
		// effect, so a cold --model/provider resume must see the same fresh SQLite
		// cache that `san models find` uses before the online refresh continues in
		// the background.
		await modelRegistry.refreshRuntimeProviders("offline");
		// Continue runtime discovery in the background (cache-aware) so startup is
		// only blocked on local cache reads, not provider network fetches.
		void modelRegistry.refreshRuntimeProviders().catch(error => {
			logger.warn("runtime provider discovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		if (initialModelRoute && sessionLogicalModelIds.length === 0) {
			const previousRoute = initialModelRoute;
			const routeThinkingLevel = options.initialModelRoute
				? options.thinkingLevel
				: defaultRoleSpec.explicitThinkingLevel
					? defaultRoleSpec.thinkingLevel
					: undefined;
			const refreshedRoute = resolveStartupLogicalRoute(
				previousRoute.logicalModelId,
				previousRoute.role,
				previousRoute.routeId,
				routeThinkingLevel,
			);
			if (refreshedRoute.kind === "selected") {
				applyStartupRouteSelection(refreshedRoute);
			} else {
				model = undefined;
				initialModelRoute = undefined;
				logicalModelFailureMessage =
					refreshedRoute.kind === "unavailable" && refreshedRoute.resolution
						? formatLogicalRouteFailure(refreshedRoute.resolution)
						: `Logical model "${previousRoute.logicalModelId}" is no longer configured`;
				modelFallbackMessage = logicalModelFailureMessage;
			}
		}

		// Retry persisted Logical Model intent first now that extension providers
		// are registered. The saved route id is affinity, not a hard pin: if that
		// route is no longer eligible, the resolver selects the next valid route
		// while preserving the logical model and records the recovery below.
		if (!hasExplicitModel && sessionLogicalModelIds.length > 0) {
			let restoredLogicalModel = false;
			let persistedLogicalFailureMessage: string | undefined;
			for (let i = 0; i < sessionLogicalModelIds.length; i++) {
				const logicalModelId = sessionLogicalModelIds[i];
				const role =
					lastModelChangeRole && existingSession.logicalModels[lastModelChangeRole] === logicalModelId
						? lastModelChangeRole
						: "default";
				const savedRouteId = existingSession.modelRoutes[logicalModelId];
				const restored = resolveStartupLogicalRoute(logicalModelId, role, savedRouteId);
				if (restored.kind !== "selected") {
					if (restored.kind === "unavailable") {
						persistedLogicalFailureMessage ??= restored.resolution
							? formatLogicalRouteFailure(restored.resolution)
							: `Logical model "${logicalModelId}" has no eligible route`;
					}
					continue;
				}

				applyStartupRouteSelection(restored);
				logicalModelFailureMessage = undefined;
				modelFallbackMessage = undefined;
				restoredSessionModelIndex = -1;
				pendingRestoredModelRouteChange =
					savedRouteId && savedRouteId !== restored.route.routeId
						? {
								logicalModel: logicalModelId,
								fromRoute: savedRouteId,
								toRoute: restored.route.routeId,
							}
						: undefined;
				restoredLogicalModel = true;
				break;
			}
			if (!restoredLogicalModel && persistedLogicalFailureMessage) {
				logicalModelFailureMessage = persistedLogicalFailureMessage;
				modelFallbackMessage = persistedLogicalFailureMessage;
				initialModelRoute = undefined;
				model = undefined;
				restoredSessionModelIndex = -1;
			} else if (!restoredLogicalModel) {
				// Logical Model 已删除或改名时，保留具体模型作为旧 session 的恢复路径，
				// 但不能继续投影已经失效的 route。
				initialModelRoute = undefined;
			}
		}

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && !logicalModelFailureMessage && !initialModelRoute && sessionRetryLimit > 0) {
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowAutoAlias: true,
					allowMaxSuffix: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) continue;
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					initialModelRoute = undefined;
					modelFallbackMessage = undefined;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					// Recompute thinking-level from scratch against the reclaimed
					// model: any value derived from the earlier fallback model's
					// `thinking.defaultLevel` must not become sticky.
					thinkingLevel = pickInitialThinkingLevel(restoredModel);
					autoThinking = thinkingLevel === AUTO_THINKING;
					effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(restoredModel)
							: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
					);
					preconnectModelHost(restoredModel.baseUrl);
					break;
				}
			}
		}
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Expand role aliases (`@smol`) and comma chains to concrete
		// selectors first so deferred resolution accepts everything the immediate
		// path (resolveModelOverride → resolveModelRoleValue) accepts.
		if (!model && deferredModelPatterns.length > 0) {
			const expandedModelPatterns = resolveConfiguredModelPatterns(deferredModelPatterns, settings);
			let resolutionWarning: string | undefined;
			for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
				const pattern = expandedModelPatterns[patternIndex];
				const primary = resolveModelOverride([pattern], modelRegistry, settings);
				if (!primary.model) {
					resolutionWarning ??= primary.warning;
					continue;
				}
				let selectedModel = primary.model;
				let selectedThinkingLevel = primary.thinkingLevel;
				let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;
				let selectedModelRoute = activeModelRouteFromResolution(primary.routeResolution, "default");
				let authFallbackUsed = false;
				if (options.modelPatternAuthFallback) {
					const primaryKey = await modelRegistry.getApiKey(primary.model);
					if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
						const fallback = resolveModelOverride([options.modelPatternAuthFallback], modelRegistry, settings);
						if (fallback.model) {
							const fallbackKey = await modelRegistry.getApiKey(fallback.model);
							if (fallbackKey === kNoAuth || isAuthenticated(fallbackKey)) {
								selectedModel = fallback.model;
								selectedThinkingLevel = fallback.thinkingLevel;
								selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
								selectedModelRoute = activeModelRouteFromResolution(fallback.routeResolution, "default");
								authFallbackUsed = true;
							}
						}
					}
				}
				if (!authFallbackUsed && options.modelPatternFallbackRole) {
					const primarySelector = formatModelSelectorValue(
						primary.logicalModelId ?? formatModelStringWithRouting(primary.model),
						primary.thinkingLevel,
					);
					const seenSelectors = new Set<string>([primarySelector]);
					const fallbackSelectors: string[] = [];
					for (const fallbackPattern of expandedModelPatterns.slice(patternIndex + 1)) {
						const fallback = resolveModelOverride([fallbackPattern], modelRegistry, settings);
						if (!fallback.model) continue;
						const fallbackSelector = formatModelSelectorValue(
							fallback.logicalModelId ?? formatModelStringWithRouting(fallback.model),
							fallback.thinkingLevel,
						);
						if (seenSelectors.has(fallbackSelector)) continue;
						seenSelectors.add(fallbackSelector);
						fallbackSelectors.push(fallbackSelector);
					}
					if (fallbackSelectors.length > 0) {
						const modelRoles: Record<string, string> = {};
						const existingRoles = settings.getModelRoles();
						for (const role in existingRoles) {
							const selector = existingRoles[role];
							if (selector) {
								modelRoles[role] = selector;
							}
						}
						modelRoles[options.modelPatternFallbackRole] = primarySelector;
						settings.override("modelRoles", modelRoles);
						const fallbackChains: Record<string, string[]> = {
							[options.modelPatternFallbackRole]: fallbackSelectors,
						};
						const existingFallbackChains = settings.get("retry.fallbackChains");
						for (const role in existingFallbackChains) {
							if (role !== options.modelPatternFallbackRole) {
								fallbackChains[role] = existingFallbackChains[role];
							}
						}
						settings.override("retry.fallbackChains", fallbackChains);
					}
				}
				model = selectedModel;
				initialModelRoute = selectedModelRoute;
				modelFallbackMessage = undefined;
				if (selectedExplicitThinkingLevel) {
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(selectedModel)
						: resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
				);
				preconnectModelHost(selectedModel.baseUrl);
				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				modelFallbackMessage = resolutionWarning ?? `Model ${requested} not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && !hasExplicitModel && deferredModelPatterns.length === 0) {
			// Re-resolve the allowed set: extension factories above may have
			// registered providers/models that weren't visible at startup.
			const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);

			// Retry the default-role lookup against the post-extension allowed
			// set. Extension factories register providers AFTER the early
			// `defaultRoleSpec` resolution, so a role pointing at an extension
			// model (e.g. an openai-compat plugin's `posthog/claude-opus-4-8`)
			// returned `undefined` there. Without this retry the next step's
			// `pickDefaultAvailableModel` happily replaces the user's configured
			// default with a bundled provider's default whenever a stray
			// `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issue #3569)
			const canRefreshSelectedDefaultRole =
				sessionLogicalModelIds.length === 0 &&
				sessionModelStrings.length === 0 &&
				defaultRoleSpec.logicalModelId !== undefined;
			if (
				!logicalModelFailureMessage &&
				!hasExplicitModel &&
				(!defaultRoleSpec.model || canRefreshSelectedDefaultRole)
			) {
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
					modelRegistry,
				});
				if (reResolvedRoleSpec.logicalModelId) {
					const refreshedDefaultRoute = resolveStartupLogicalRoute(
						reResolvedRoleSpec.logicalModelId,
						"default",
						reResolvedRoleSpec.routeId,
						reResolvedRoleSpec.explicitThinkingLevel ? reResolvedRoleSpec.thinkingLevel : undefined,
					);
					if (refreshedDefaultRoute.kind === "selected") {
						defaultRoleSpec = {
							...reResolvedRoleSpec,
							model: refreshedDefaultRoute.model,
							routeId: refreshedDefaultRoute.route.routeId,
							routeReason: refreshedDefaultRoute.resolution.reason,
							routeResolution: refreshedDefaultRoute.resolution,
						};
						applyStartupRouteSelection(refreshedDefaultRoute);
						logicalModelFailureMessage = undefined;
						modelFallbackMessage = undefined;
					} else if (refreshedDefaultRoute.kind === "unavailable") {
						logicalModelFailureMessage = refreshedDefaultRoute.resolution
							? formatLogicalRouteFailure(refreshedDefaultRoute.resolution)
							: `Logical model "${reResolvedRoleSpec.logicalModelId}" has no eligible route`;
						modelFallbackMessage = logicalModelFailureMessage;
					}
				} else if (reResolvedRoleSpec.model) {
					defaultRoleSpec = reResolvedRoleSpec;
					const resolvedDefaultModel = reResolvedRoleSpec.model;
					model = resolvedDefaultModel;
					initialModelRoute = undefined;
					modelFallbackMessage = undefined;
					// Recompute the thinking level against the now-real model.
					// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
					// so the role's explicit selector (e.g. `:max`) now applies.
					thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
					autoThinking = thinkingLevel === AUTO_THINKING;
					effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(resolvedDefaultModel)
							: resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
					);
					preconnectModelHost(resolvedDefaultModel.baseUrl);
				}
			}

			if (!model && !logicalModelFailureMessage) {
				const defaultModel = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));
				if (defaultModel) {
					model = defaultModel;
					initialModelRoute = undefined;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					logicalModelFailureMessage ??
					(patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No models available. Use /login or set an API key environment variable. Then use /model to select a model.");
			}
		}

		if (model) {
			const selectedModel = model;
			const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
				modelRegistry.refreshSelectedModelMetadata(selectedModel),
			);
			if (refreshedModel !== selectedModel) {
				model = refreshedModel;
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(refreshedModel)
						: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}
		assertInitialModelRouteMatchesModel(model, initialModelRoute);

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model && options.sessionAccess !== "read_only") {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () =>
					deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
				);
			}
		}

		// Discover custom commands (TypeScript slash commands)
		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// The runner is created unconditionally — even with zero extensions loaded — because the
		// `ExtensionToolWrapper` installed below is the only place the per-tool approval gate runs.
		// A conditional runner means the approval system silently disappears for users with no
		// extensions, contradicting non-yolo `tools.approvalMode` settings without feedback.
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			() => (hasSession ? createSessionMemoryRuntimeContext(session, agentDir, cwd) : undefined),
			settings,
			localProtocolOptions,
		);

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void extensionRunner.emitCredentialDisabled(event);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = extensionRunner.getAllRegisteredTools();
		const sdkCustomTools = options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? [];
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}),
		];
		// `wrapToolWithMetaNotice` runs the centralized large-output → artifact spill.
		// Built-in tools get it in `createTools`; extension, SDK-custom, image-gen,
		// and startup (non-deferred) MCP tools all funnel through here, so apply it
		// once at this adapter boundary (idempotent — a no-op if already wrapped).
		const wrappedExtensionTools: Tool[] = wrapRegisteredTools(allCustomTools, extensionRunner).map(
			wrapToolWithMetaNotice,
		);

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const builtInRegistryToolNames = new Set<string>();
		const toolRegistry = new Map<string, Tool>();
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.add(tool.name);
		}
		if (!toolRegistry.has("goal") && settings.get("goal.enabled")) {
			const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
			if (goalTool) {
				toolRegistry.set(goalTool.name, wrapToolWithMetaNotice(goalTool));
				builtInRegistryToolNames.add(goalTool.name);
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.delete(tool.name);
		}
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
			builtInRegistryToolNames.delete("edit");
		}

		let writeRegistration: Promise<boolean> | undefined;
		const ensureWriteRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("write")) return Promise.resolve(builtInRegistryToolNames.has("write"));
			writeRegistration ??= (async () => {
				const writeTool = await logger.time("createTools:write:session", BUILTIN_TOOLS.write, toolSession);
				if (!writeTool || toolRegistry.has("write")) return builtInRegistryToolNames.has("write");
				toolRegistry.set(
					writeTool.name,
					new ExtensionToolWrapper(wrapToolWithMetaNotice(writeTool), extensionRunner) as Tool,
				);
				builtInRegistryToolNames.add(writeTool.name);
				return true;
			})().finally(() => {
				writeRegistration = undefined;
			});
			return writeRegistration;
		};

		// Existing staged/device paths need write registered before active-set assembly.
		// Deferred MCP also registers it now, but refresh activates it only after a server connects.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const planModeAvailable = settings.get("plan.enabled");
		if (!options.strictToolNames && (hasDeferrableTools || planModeAvailable || deferMCPDiscoveryForUI)) {
			await ensureWriteRegistered();
		}

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		// Built-in xd:// devices (ast_edit, debug, browser, lsp, web_search) are
		// mounted in createTools BEFORE this loop wraps registry entries in
		// ExtensionToolWrapper, so the registry holds them unwrapped. The normal
		// `write xd://<tool>` path runs approval through the wrapped `write` tool's
		// tier gate, but Cursor invokes advertised devices via `tool.execute()`
		// directly — so wrap unwrapped devices here to keep the approval/deny/prompt
		// gate. Dynamic mounts (custom/MCP) already come from the wrapped registry.
		const resolveCursorDevice = (name: string): AgentTool | undefined => {
			const device = toolSession.xdevRegistry?.get(name);
			if (!device) return undefined;
			return device instanceof ExtensionToolWrapper ? device : new ExtensionToolWrapper(device, extensionRunner);
		};
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getTool: resolveCursorDevice,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		// Resolve the inline-descriptors setting against the session-start model.
		// `auto` enforces the per-model policy (inline for Gemini, off otherwise);
		// like the rest of the prune machinery this is fixed for the session, so a
		// mid-session model switch keeps the start-time decision.
		const inlineToolDescriptors = shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), model?.id);
		const eagerTasks = settings.get("task.eager") !== "default";
		const eagerTasksAlways = settings.get("task.eager") === "always";
		const intentField = $flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
		): Promise<BuildSystemPromptResult> => {
			toolContextStore.setToolNames(toolNames);
			const promptTools = buildSystemPromptToolMetadata(tools);
			const memoryBackend = await resolveMemoryBackend(settings);
			const memoryInstructions = await memoryBackend.buildDeveloperInstructions(agentDir, settings, session);

			// Build combined append prompt: memory instructions + auto-learn guidance
			// + MCP server instructions. For UI sessions MCP discovery is deferred, so
			// `getServerInstructions()` is empty until the background connect completes;
			// the rebuild that `refreshMCPTools` triggers post-discovery then picks up
			// the now-connected servers' instructions, so they join the prompt for the
			// rest of the session.
			const serverInstructions = filterCodeGraphServerInstructions(
				mcpManager?.getServerInstructions(),
				mcpManager?.getTools() ?? [],
				settings.get("san.codeIntelligence.enabled"),
			);
			// Drive guidance off the auto-learn BUILTINS that createTools actually built
			// (provenance, not just an active name): `builtInToolNames` excludes a
			// custom/extension tool that merely shares the name, and reflects the
			// session-start build — so a subagent that filtered them out, a mid-session
			// enable that never built them, or a same-named custom tool while auto-learn
			// is off all get no guidance.
			const autoLearnInstructions = buildAutoLearnInstructions({
				manageSkill: builtInToolNames.includes("manage_skill"),
				learn: builtInToolNames.includes("learn"),
			});
			const appendParts: string[] = [];
			if (memoryInstructions) appendParts.push(memoryInstructions);
			if (autoLearnInstructions) appendParts.push(autoLearnInstructions);
			let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			if (serverInstructions && serverInstructions.size > 0) {
				const parts: string[] = [];
				if (appendPrompt) parts.push(appendPrompt);
				parts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					parts.push(`### ${srvName}\n${truncated}`);
				}
				appendPrompt = parts.join("\n\n");
			}
			// Owned/in-band tool dialects (non-native) require the catalog as `# Tool:`
			// sections; native tool calling lets the compact name list suffice.
			const nativeTools = resolveDialect(settings.get("tools.format"), agent?.state.model ?? model) === undefined;
			if (options.appendSystemPrompt) {
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd,
				agentDir,
				xdevTools: toolSession.xdevRegistry?.entries() ?? [],
				xdevDocs:
					toolSession.xdevRegistry?.docsAll(
						settings.get("tools.xdevDocs"),
						settings.get("tools.xdevInlineDevices"),
					) ?? "",
				autoQaEnabled: isAutoQaEnabled(settings),
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: session?.skills ?? skills,
				contextFiles,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				inlineToolDescriptors,
				nativeTools,
				intentField,
				eagerTasks,
				eagerTasksAlways,
				taskBatch: settings.get("task.batch"),
				taskMaxConcurrency: settings.get("task.maxConcurrency"),
				taskIrcEnabled: isIrcEnabled(settings, options.taskDepth ?? 0),
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				includeWorkspaceTree,
				memoryRootEnabled: memoryBackend.id === "local",
				model: getActiveHarnessProfile(),
				includeModelInPrompt: settings.get("includeModelInPrompt"),
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
				renderMermaid: settings.get("tui.renderMermaid"),
				activeRepoContext,
			});

			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			const customPrompt =
				typeof options.systemPrompt === "function"
					? options.systemPrompt(defaultPrompt.systemPrompt)
					: options.systemPrompt;
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the subagent's prompts and idle-reminders demand a
		// `yield` call to terminate. The tool registry already includes `yield` (see
		// `createTools`), but an explicit `toolNames` list would otherwise drop it from the
		// active set — leaving the model unable to satisfy the contract. Mirror the same
		// invariant `parseAgentFields` enforces on frontmatter `tools`.
		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes("yield")
		) {
			explicitlyRequestedToolNames.push("yield");
		}
		// Auto-learn builtins are force-included into the registry by `createTools`
		// for enabled top-level sessions (tools/index.ts), but — like `yield` above —
		// an explicit `toolNames` list would otherwise drop them from the ACTIVE set,
		// leaving the nudge/guidance pointing at tools the model cannot call. Activate
		// exactly the builtins createTools built (`builtInToolNames` — provenance, so a
		// same-named custom/extension tool is never force-activated when auto-learn is
		// off) to keep guidance, controller, and the active set consistent.
		if (explicitlyRequestedToolNames && !options.strictToolNames) {
			for (const name of ["manage_skill", "learn"]) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const explicitlyRequestedToolNameSet = explicitlyRequestedToolNames
			? new Set(explicitlyRequestedToolNames)
			: undefined;
		const xdevReadAvailable =
			builtInRegistryToolNames.has("read") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("read"));
		const xdevWriteAvailable =
			builtInRegistryToolNames.has("write") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("write"));
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		let initialToolNames = [...initialRequestedActiveToolNames];

		// Custom tools and extension-registered tools are always included regardless of toolNames filter
		const alwaysInclude: string[] = options.strictToolNames
			? []
			: [
					...sdkCustomTools.map(t => (isCustomTool(t) ? t.name : t.name)),
					...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
				];
		for (const name of alwaysInclude) {
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		const incomingSessionFile = sessionManager.getSessionFile() ?? null;
		const existingRef = agentRegistry.get(resolvedAgentId);
		let sameGenerationReentry = false;
		let reclaimedCorpse = false;
		if (existingRef) {
			// Same-generation re-entry (lifecycle revive, subtask resume): the same
			// agent re-constructs over its own parked ref — refresh it in place
			// (identity and createdAt preserved) instead of registering a new
			// generation over it.
			sameGenerationReentry =
				existingRef.status === "parked" &&
				existingRef.session === null &&
				existingRef.sessionFile !== null &&
				existingRef.sessionFile === incomingSessionFile &&
				incomingSessionFile !== null;
			if (sameGenerationReentry) {
				ourGenerationRef = existingRef;
				agentRegistry.refreshForReentry(resolvedAgentId, incomingSessionFile);
			} else {
				// Fresh construction colliding with an existing generation: never
				// silently overwrite it. A provably dead parked corpse may be
				// reclaimed (identity/CAS-checked, cold-revivable refs preserved);
				// anything else fails the construction with the collision intact.
				// Ownership: reclaim consults the lifecycle's adopt/park/revive
				// state AND its persisted reviver factory — both describe the
				// registry the lifecycle manages. For a custom registry the
				// global manager owns neither, so reclaiming through it could
				// misread unrelated state; fail closed instead.
				const lifecycle = AgentLifecycleManager.global();
				if (lifecycle.manages(agentRegistry)) {
					reclaimedCorpse = await lifecycle.reclaimParkedCorpse(resolvedAgentId, existingRef);
				}
			}
		}
		let supersededAbandoned = false;
		if (existingRef && !sameGenerationReentry && !reclaimedCorpse) {
			// The guard stops a fresh construction from silently clobbering a
			// generation that is still live: a ref with no session object yet
			// (its own construction is still in flight — superseding would
			// cross-wire the two constructions), a live non-main generation
			// (subagents are lifecycle-owned and messageable), or a main with
			// in-flight work (streaming, compacting, generating a handoff).
			// Those fail closed with the collision intact.
			// One state is provably not live and is superseded instead, matching
			// the long-standing SDK contract where a later same-id construction
			// replaces an earlier one: a main the caller abandoned without
			// disposing — quiescent (and therefore also already-disposed, whose
			// registry cleanup somehow missed).
			const existingSession = existingRef.session;
			supersededAbandoned =
				existingRef.kind === "main" &&
				existingSession !== null &&
				!existingSession.isStreaming &&
				!existingSession.isCompacting &&
				!existingSession.isGeneratingHandoff;
			if (supersededAbandoned) {
				logger.warn(
					`createAgentSession: superseding an abandoned quiescent main generation for agent id "${resolvedAgentId}"`,
				);
			} else {
				throw new Error(
					`Agent id "${resolvedAgentId}" is already registered as a ${existingRef.status} ${existingRef.kind} and cannot be reclaimed — refusing to overwrite an existing generation. Revive the existing agent, release it, or use a fresh id.`,
				);
			}
		}
		// A same-generation re-entry keeps its ref (refreshForReentry above);
		// every other path registers: fresh ids, fresh constructions over a
		// reclaimed corpse or an abandoned quiescent main (the old generation
		// is gone, so a brand-new ref with a new identity and createdAt is
		// correct).
		if (!existingRef || reclaimedCorpse || supersededAbandoned) {
			ourGenerationRef = agentRegistry.register({
				id: resolvedAgentId,
				displayName: resolvedAgentDisplayName,
				kind: agentKind,
				parentId: options.parentAgentId,
				session: null,
				sessionFile: incomingSessionFile,
				status: "running",
			});
		}
		hasRegistered = true;

		// Partition the initial enabled set for the xd:// transport: ambient
		// discoverable tools become mounted devices, while explicitly requested
		// tools keep their top-level presentation. The registry already holds the
		// default-set built-in devices from createTools; this reconciles dynamic
		// mounts (image-gen, startup MCP, active extension tools).
		let initialMountedXdevToolNames: string[] = [];
		if (toolSession.xdevRegistry) {
			const topLevelToolNames: string[] = [];
			const mountedTools: Tool[] = [];
			for (const name of initialToolNames) {
				const tool = toolRegistry.get(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				if (tool && xdevReadAvailable && xdevWriteAvailable && !explicitlyRequested && isMountableUnderXdev(tool))
					mountedTools.push(tool);
				else topLevelToolNames.push(name);
			}
			toolSession.xdevRegistry.reconcile(mountedTools);
			initialMountedXdevToolNames = mountedTools.map(tool => tool.name);
			initialToolNames = topLevelToolNames;
			if (initialMountedXdevToolNames.length > 0 && !initialToolNames.includes("write"))
				initialToolNames.push("write");
		}

		setActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Keep image blocks off the wire when they'd be rejected: either the user
		// disabled images (`images.blockImages`) or the active model has no vision
		// support. The latter covers switching from a vision model to a text-only
		// one mid-session — historical image blocks would otherwise be replayed to
		// a provider that 400s on them (#5400). Read both dynamically so a `/model`
		// switch or setting change takes effect on the next turn.
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (settings.get("images.blockImages")) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !activeModel.input.includes("image")) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};

		// Final convertToLlm: live provider replay drops API-level refusal errors,
		// then applies secret obfuscation to the remaining outbound context.
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = filterProviderReplayMessages(convertToLlmWithBlockImages(messages));
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};
		// Per-request provider-context transforms. Obfuscate FIRST so secrets are
		// redacted from text before snapcompact rasterizes it into PNG frames, then
		// clamp images to the active provider budget before the request is sent.
		const snapcompactSystemPromptMode = settings.get("snapcompact.systemPrompt");
		const snapcompactInline =
			snapcompactSystemPromptMode !== "none" || settings.get("snapcompact.toolResults")
				? new SnapcompactInlineTransformer(
						{
							renderSystemPrompt: snapcompactSystemPromptMode,
							renderToolResults: settings.get("snapcompact.toolResults"),
							shape: settings.get("snapcompact.shape"),
						},
						// Journal the tokens each imaged tool result keeps off the wire
						// (frames never reach session.jsonl, so this is their only trace).
						createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
					)
				: undefined;
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			if (snapcompactInline) transformed = await snapcompactInline.transform(transformed, transformModel);
			return clampProviderContextImages(transformed, transformModel);
		};
		const onPayload = async (payload: unknown, _model?: Model) => {
			return await extensionRunner.emitBeforeProviderRequest(payload);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		const autoLearnCaptureTools = initialTools.filter(tool => tool.name === "manage_skill" || tool.name === "learn");

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const initialServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps OpenRouter sticky-routing variants, antigravity endpoint routing,
		// in-flight caps, and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(
			settings,
			createSettingsAwareStreamFn(settings),
		);
		const dispatchStreamFn: StreamFn = (...args) => {
			if (notifyFirstChatDispatch) {
				const cb = notifyFirstChatDispatch;
				notifyFirstChatDispatch = undefined;
				try {
					cb();
				} catch (err) {
					logger.warn("onFirstChatDispatch hook threw", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return settingsAwareStreamFn(...args);
		};
		const providerHealthStreamFn: StreamFn = (...args) => {
			const [streamModel, _context, streamOptions] = args;
			// 每次 provider 派发都用 Snowflake 生成唯一 requestId：先解析当前
			// 固定/active scope 并向 runtime 登记（任何 provider/network 工作
			// 之前；登记失败——终态 scope、scheduler gate 拒绝——即零网络抛错），
			// 再进入 ProviderHealthRegistry.dispatchStream 并同步传入 requestId。
			// 未登记的请求结果绝不猜测进任何 scope。
			const requestId = Snowflake.next();
			const dispatchScopeId = executionScopeId ?? executionRuntime.activeScopeId();
			if (executionRuntime && dispatchScopeId !== undefined) {
				executionRuntime.registerProviderDispatch(dispatchScopeId, requestId);
			}
			return providerHealthRegistry.dispatchStream(
				{
					key: providerHealthKeyFromModel(streamModel),
					sessionId: providerSessionId,
					signal: streamOptions?.signal,
					requestId,
				},
				() => dispatchStreamFn(...args),
			);
		};
		const transformToolCallArguments = (args: Record<string, unknown>, toolName: string): Record<string, unknown> => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = deobfuscateToolArguments(obfuscator, result);
			}
			if (options.toolPathScope) {
				result = authorizeToolArgumentsWithinPathScope({
					args: result,
					toolName,
					cwd,
					scopeRoot: options.toolPathScope,
					exemptToolNames: new Set(options.toolPathScopeExemptToolNames),
				});
			}
			return result;
		};
		let strictUsageTokens = 0;
		let strictUsageCost = 0;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			maxTokens: options.maxOutputTokens,
			maxTokensResolver:
				options.maxOutputTokens === undefined &&
				options.maxTotalTokens === undefined &&
				options.maxTotalCost === undefined
					? undefined
					: () => {
							const outputRemaining =
								options.maxOutputTokens === undefined ? Number.POSITIVE_INFINITY : options.maxOutputTokens;
							const estimatedInputTokens = session?.getContextUsage()?.tokens ?? 0;
							const totalRemaining =
								options.maxTotalTokens === undefined
									? Number.POSITIVE_INFINITY
									: options.maxTotalTokens - strictUsageTokens - estimatedInputTokens;
							let costRemaining = Number.POSITIVE_INFINITY;
							if (options.maxTotalCost !== undefined) {
								const activeModel = agent?.state.model ?? model;
								if (!activeModel) {
									throw new Error("Hard total cost budget requires a resolved model before provider request");
								}
								const tierMultiplier =
									activeModel.provider === "openai" || activeModel.provider === "openai-codex" ? 2.5 : 1;
								const inputPrice =
									Math.max(activeModel.cost.input, activeModel.cost.cacheRead, activeModel.cost.cacheWrite) *
									tierMultiplier;
								const outputPrice = activeModel.cost.output * tierMultiplier;
								const estimatedInputCost = (inputPrice / 1_000_000) * estimatedInputTokens;
								const availableCost = options.maxTotalCost - strictUsageCost - estimatedInputCost;
								if (availableCost <= 0) {
									throw new Error(
										`Hard total cost budget exhausted before provider request (${strictUsageCost.toFixed(6)} used, ${estimatedInputCost.toFixed(6)} estimated input, ${options.maxTotalCost.toFixed(6)} limit)`,
									);
								}
								if (outputPrice > 0) costRemaining = (availableCost * 1_000_000) / outputPrice;
							}
							const remaining = Math.floor(Math.min(outputRemaining, totalRemaining, costRemaining));
							if (!Number.isFinite(remaining)) return undefined;
							if (remaining < 1) {
								throw new Error(
									`Hard total budget exhausted before provider request (${strictUsageTokens} tokens and ${strictUsageCost.toFixed(6)} USD used)`,
								);
							}
							return remaining;
						},
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: requestModel => modelRegistry.resolver(requestModel, agent.sessionId),
			streamFn: providerHealthStreamFn,
			cursorExecHandlers,
			getCursorTools: () => [...(toolSession.xdevRegistry?.list() ?? [])],
			transformToolCallArguments,
			intentTracing: !!intentField,
			pruneToolDescriptions: inlineToolDescriptors,
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});
		if (
			options.maxOutputTokens !== undefined ||
			options.maxTotalTokens !== undefined ||
			options.maxTotalCost !== undefined
		) {
			agent.subscribe(event => {
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				strictUsageTokens += event.message.usage.totalTokens;
				strictUsageCost += event.message.usage.cost.total;
			});
		}

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
			if (pendingRestoredModelRouteChange && options.sessionAccess !== "read_only") {
				sessionManager.appendModelRouteChange({
					...pendingRestoredModelRouteChange,
					reason: "recovery",
				});
			}
		} else if (options.sessionAccess !== "read_only") {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				sessionManager.appendModelChange(
					`${model.provider}/${model.id}`,
					initialModelRoute?.role,
					initialModelRoute
						? {
								logicalModel: initialModelRoute.logicalModelId,
								routeId: initialModelRoute.routeId,
							}
						: undefined,
				);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			}
			if (Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(initialServiceTierByFamily);
			}
		}

		// Full toolset for the advisor, built unconditionally so it can be toggled at
		// runtime. Bound to a DISTINCT ToolSession (its own `-advisor` session id +
		// agent id) so the advisor's tool state — snapshot, seen-lines, conflict, and
		// summary caches, all keyed on session identity — stays isolated from the
		// primary, while edit/bash/write stay fully functional: the advisor is a full
		// agent and its config's `tools` selects which of these it actually gets
		// (defaulting to read/grep/glob).
		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			hasEditTool: true,
			requireYieldTool: false,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			getAgentId: () => "advisor",
		};
		const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
		for (const name in BUILTIN_TOOLS) {
			advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
		}
		const built = await Promise.all(advisorToolBuilds);
		const advisorTools: Tool[] = built.filter((tool): tool is Tool => tool != null).map(wrapToolWithMetaNotice);

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (activeRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(activeRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the user's standing project rules instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		session = new AgentSession({
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			agent,
			pruneToolDescriptions: inlineToolDescriptors,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			initialModelRoute,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			sessionAccess: options.sessionAccess,
			settings,
			autoApprove: options.autoApprove,
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			executionRuntime,
			ownedExecutionRuntime,
			executionScopeId,
			taskContractRegistry,
			toolRegistry,
			createVibeTools:
				(options.taskDepth ?? 0) === 0 && !options.parentTaskPrefix
					? () => createVibeTools(toolSession)
					: undefined,
			builtInToolNames: builtInRegistryToolNames,
			transformContext,
			transformProviderContext,
			onPayload,
			onResponse,
			sideStreamFn: providerHealthStreamFn,
			advisorStreamFn: providerHealthStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getXdevToolEntries: () => toolSession.xdevRegistry?.entries() ?? [],
			xdevRegistry: toolSession.xdevRegistry,
			initialMountedXdevToolNames,
			presentationPinnedToolNames: explicitlyRequestedToolNameSet,
			setActiveToolNames,
			ensureWriteRegistered,
			getMcpServerInstructions: mcpManager
				? () => {
						const raw = filterCodeGraphServerInstructions(
							mcpManager.getServerInstructions(),
							mcpManager.getTools(),
							settings.get("san.codeIntelligence.enabled"),
						);
						if (!raw || raw.size === 0) return raw;
						const out = new Map<string, string>();
						for (const [name, text] of raw) {
							out.set(
								name,
								text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
							);
						}
						return out;
					}
				: undefined,
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorTools,
			titleSystemPrompt: options.titleSystemPrompt,
		});
		registerWorkflowToolSession(session, toolSession);
		hasSession = true;
		if (options.publishInteractiveRpcEvents && agentKind === "main" && options.sessionAccess !== "read_only") {
			interactiveSessionPublisher = new InteractiveSessionPublisher(session, {
				recoverAfterLeaseTakeover: () => {
					session.enableSessionWrites();
					session.repairInterruptedTurnAfterRecovery();
				},
			});
		}
		if (asyncJobManager) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => asyncJobManager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
			});
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
			isStale: entry => entry.isStale(),
			build: buildLateDiagnosticsBatchMessage,
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		// Generation CAS: a superseding construction may have replaced our ref
		// while this construction was awaiting prompt/tool setup — never attach
		// this session onto a newer generation's ref.
		if (agentRegistry.get(resolvedAgentId) === ourGenerationRef) {
			agentRegistry.attachSession(resolvedAgentId, session, sessionManager.getSessionFile() ?? null);
		}
		// Cross-session client (created right after the dispose wrapper below):
		// closed by that wrapper, so it is declared here, before it.
		let crossSessionClient: CrossSessionClient | undefined;
		let unregisterExternalSender: (() => void) | undefined;
		let unsubscribePeerMetadata: (() => void) | undefined;
		let unsubscribePeerActivity: (() => void) | undefined;
		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async (disposeOptions: AgentSessionDisposeOptions = {}) => {
				try {
					// Reject new session work (eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					if (crossSessionClient) {
						// Stop inbound traffic first: unregister the bus outbound
						// fallback (only if this client is still the installed one —
						// a newer root's route must survive), then drop the
						// transport connection.
						unregisterExternalSender?.();
						unregisterExternalSender = undefined;
						// Stop metadata refresh pushes before dropping the socket.
						unsubscribePeerMetadata?.();
						unsubscribePeerMetadata = undefined;
						unsubscribePeerActivity?.();
						unsubscribePeerActivity = undefined;
						try {
							await crossSessionClient.close();
						} catch (error) {
							// A failed transport close must never strand core
							// session teardown — log and continue disposing.
							logger.warn("Cross-session client close failed during dispose", {
								error: error instanceof Error ? error.message : String(error),
							});
						}
						crossSessionClient = undefined;
					}
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose(disposeOptions);
				} finally {
					await interactiveSessionPublisher?.stop().catch(error => {
						logger.warn("Failed to stop interactive RPC event publisher", {
							error: error instanceof Error ? error.message : String(error),
						});
					});
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
				}
			};
		}
		if (interactiveSessionPublisher) await interactiveSessionPublisher.start();

		// Same-machine cross-session hub: only a root main session registers with
		// the peer broker. Interactive TUI sessions opt in by default; headless
		// SDK/ACP roots stay local-only unless they explicitly configure
		// `crossSession.enabled` — the default `true` must never spawn a broker
		// for every test/script root. Registration happens after the live session
		// is attached so the broker metadata can describe a real session.
		if (
			agentKind === "main" &&
			settings.get("crossSession.enabled") &&
			(options.hasUI === true || settings.isConfigured("crossSession.enabled"))
		) {
			try {
				crossSessionClient = await createCrossSessionClient({
					metadata: () => {
						let headState: GitHeadState | null = null;
						try {
							headState = gitHead.resolveSync(sessionManager.getCwd());
						} catch {
							headState = null;
						}
						// The registering ref is *this* root (resolvedAgentId) — a
						// custom agentId is still kind "main" and must advertise its
						// own status, not the default Main ref's.
						const mainRef = agentRegistry.get(resolvedAgentId);
						return {
							sessionId: sessionManager.getSessionId() ?? "unknown",
							displayName: sessionManager.getSessionName() ?? resolvedAgentDisplayName,
							cwd: sessionManager.getCwd(),
							branch: headState?.kind === "ref" ? (headState.branchName ?? undefined) : undefined,
							status: mainRef?.status === "running" ? ("running" as const) : ("idle" as const),
							activity: mainRef?.activity,
						};
					},
					deliver: (message, options) =>
						IrcBus.global().deliverExternal(
							{
								id: message.id,
								from: message.from,
								to: resolvedAgentId,
								body: message.body,
								ts: message.ts,
								...(message.kind ? { kind: message.kind } : {}),
								replyTo: message.replyTo,
							},
							{ expectsReply: options.expectsReply },
						),
				});
				// Auto-reply legs (`bus.send` to a san:* id from a busy/plan-mode
				// recipient) route through the transport so remote `await:true`
				// still resolves. The captured disposer is ownership-safe: a
				// newer root's install is never cleared by this session's dispose.
				unregisterExternalSender = IrcBus.global().setExternalSender(crossSessionClient);
				// Keep the broker's peer record fresh: best-effort refresh when
				// THIS root's status changes (the transport only calls
				// metadata() at registration/refresh). Subscription is
				// ownership-safe — cleared before the client closes above.
				const refreshPeerRecord = (): void => {
					void crossSessionClient?.refresh().catch(() => {
						// Best effort: a stale peer row is preferable to noisy
						// retries; the next status or activity change refreshes again.
					});
				};
				unsubscribePeerMetadata = agentRegistry.onChange(event => {
					if (event.ref.id !== resolvedAgentId) return;
					refreshPeerRecord();
				});
				// Activity gists emit on their own (change-only) listener path so
				// live work reaches the broker too — status flips to running
				// before the first activity gist lands, and that later update
				// would otherwise never refresh the peer record.
				unsubscribePeerActivity = agentRegistry.onActivity(ref => {
					if (ref.id !== resolvedAgentId) return;
					refreshPeerRecord();
				});
				toolSession.crossSessionClient = crossSessionClient;
			} catch (error) {
				// Transport startup failure must never take down the local hub:
				// log and continue with local-only messaging.
				logger.warn("Cross-session peer discovery unavailable; local hub stays active", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (model?.api === "openai-codex-responses") {
			// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
			const codexModel = model as Model<"openai-codex-responses">;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the lsp tool or an edit/write
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && options.hasUI && settings.get("lsp.lazy")) {
			lspServers = discoverStartupLspServers(cwd, "available");
		} else if (enableLsp && options.hasUI) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		const startMemoryBackend = async () => {
			const memoryBackend = await resolveMemoryBackend(settings);
			await memoryBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
			});
		};

		const runAutoLearnCapture = createAutoLearnCaptureRunner({
			sourceAgent: agent,
			captureTools: autoLearnCaptureTools,
			onPayload,
			onResponse,
			createAgent: captureOptions => {
				const captureModel = captureOptions.initialState?.model;
				const captureSessionId = captureOptions.sessionId;
				if (!captureModel || !captureSessionId) throw new Error("Auto-learn capture identity is incomplete");
				return new Agent({
					...captureOptions,
					cwd: sessionManager.getCwd(),
					cwdResolver: () => sessionManager.getCwd(),
					convertToLlm: convertToLlmFinal,
					transformContext: async messages => wrapSteeringForModel(messages),
					transformProviderContext: async (context, transformModel) => {
						const transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
						return clampProviderContextImages(transformed, transformModel);
					},
					thinkingBudgets: agent.thinkingBudgets,
					temperature: agent.temperature,
					topP: agent.topP,
					topK: agent.topK,
					minP: agent.minP,
					presencePenalty: agent.presencePenalty,
					repetitionPenalty: agent.repetitionPenalty,
					serviceTierResolver: agent.serviceTierResolver,
					hideThinkingSummary: agent.hideThinkingSummary,
					maxRetryDelayMs: agent.maxRetryDelayMs,
					kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
					preferWebsockets: preferOpenAICodexWebsockets,
					getToolContext: toolCall => toolContextStore.getContext(toolCall),
					streamFn: providerHealthStreamFn,
					transformToolCallArguments,
					intentTracing: !!intentField,
					pruneToolDescriptions: inlineToolDescriptors,
					dialect: resolveDialect(settings.get("tools.format"), captureModel),
					abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
					appendOnlyContext: shouldEnableAppendOnlyContext(
						settings.get("provider.appendOnlyContext"),
						captureModel,
					)
						? new AppendOnlyContextManager()
						: undefined,
				});
			},
		});

		// Auto-learn can immediately trigger a private capture after the first real
		// stop. When a memory backend is selected, install that backend's
		// per-session state first so the capture turn's `learn` tool observes the
		// same initialized state as normal memory tools. Other sessions keep memory
		// startup in the background to preserve the existing startup profile.
		//
		// Gated on `autolearn.enabled` to match the tools: `createTools` builds the
		// `learn`/`manage_skill` registry ONCE at session start and no settings
		// change rebuilds it, so installing the controller while disabled would let a
		// mid-session enable fire a nudge pointing at tools the session never built.
		// Activation is therefore a session-start decision for BOTH the controller
		// and the tools; the fire-time re-check in `#onAgentEnd` still handles a
		// mid-session DISABLE. The subscription lives for the session's lifetime; the
		// reference is intentionally discarded (the listener retains it).
		if (settings.get("autolearn.enabled") && taskDepth === 0) {
			await logger.time("startMemoryStartupTask", startMemoryBackend);
			new AutoLearnController({
				session,
				settings,
				capture: content => session.runAutolearnCapture(signal => runAutoLearnCapture(content, signal)),
			});
		} else {
			void logger.time("startMemoryStartupTask", startMemoryBackend);
		}

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(tools => {
				void (async () => {
					try {
						await session.refreshMCPTools(tools);
					} catch (error) {
						logger.warn("MCP tool refresh failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		startDeferredMCPDiscovery?.(session);

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership. Idempotent with dispose() — Set.delete is a no-op
		// for already-removed listeners.
		unsubscribeCredentialDisabled?.();
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeRubyKernelSessionsByOwner(evalKernelOwnerId);
				await disposeJuliaKernelSessionsByOwner(evalKernelOwnerId);
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}
