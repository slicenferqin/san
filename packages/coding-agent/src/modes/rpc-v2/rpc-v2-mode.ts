/**
 * San RPC v2 mode entry point.
 *
 * Implements the JSON-RPC 2.0 protocol over stdio NDJSON.
 * Launched via `--mode rpc --rpc-protocol 2`.
 *
 * Protocol lifecycle:
 * 1. Process starts → emits `server.ready` notification
 * 2. Client sends `initialize` → server validates and returns capabilities
 * 3. Normal method dispatch gated on successful initialize
 * 4. `server.shutdown` or stdin close → graceful exit
 */
import * as path from "node:path";
import type { Api, ImageContent } from "@san/ai";
import { getAgentDir, logger, prompt, readLines, VERSION } from "@san/utils";
import { collectContextCheckpoints } from "../../context-steady/checkpoint";
import { listTurnDigests } from "../../context-steady/session";
import type { ContextCheckpoint, TurnDigest } from "../../context-steady/types";
import resourceInputTemplate from "../../prompts/rpc-v2/resource-input.md" with { type: "text" };
import { normalizeSanLoopMode } from "../../san-loop/types";
import type { AgentSession } from "../../session/agent-session";
import type { CompactMode } from "../../session/compact-modes";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { parseConfiguredThinkingLevel } from "../../thinking";
import type { TodoPhase, TodoStatus } from "../../tools/todo";
import type { EventBus } from "../../utils/event-bus";
import {
	type ApprovalPolicyContext,
	ApprovalPolicyRevisionError,
	type ApprovalPolicyScope,
	ApprovalRuleStore,
} from "./approval-rules";
import { inferArtifactMediaType, RpcArtifactError, RpcArtifactStore } from "./artifact-store";
import { AuthLoginManager } from "./auth-login-manager";
import {
	BackpressureWriter,
	installStdoutPurityGuard,
	type RpcWritable,
	type WriteFrameOptions,
} from "./backpressure-writer";
import type { ApprovalScope, PermissionRule } from "./dto/approval";
import type { EvidenceKind, EvidenceVerdict } from "./dto/evidence";
import type { ContentPart } from "./dto/run";
import type { StreamPolicy } from "./dto/session";
import type {
	CreateManagedWorktreeParams,
	WorktreeEventEnvelope as WireWorktreeEventEnvelope,
	WorktreeApplyParams,
	WorktreeApplyPrepareParams,
	WorktreeArchiveParams,
	WorktreeLifecycleCapabilityDetails,
	WorktreeListFilter,
	WorktreeSetupCancelParams,
	WorktreeSetupStartParams,
} from "./dto/worktree";
import { WORKTREE_EVENT_METHODS } from "./dto/worktree";
import { type HostToolDefinition, type HostUriSchemeDefinition, RpcV2HostToolBridge } from "./host-tool-bridge";
import {
	IdempotencyConflictError,
	IdempotencyInProgressError,
	IdempotencyOutcomeUnknownError,
	IdempotencyStore,
	SessionCreateReceiptStore,
	type SessionCreateReservation,
} from "./idempotency";
import { IntegrationRevisionError, RpcV2IntegrationCatalog } from "./integration-catalog";
import { validateInteractionResponse } from "./interaction-validation";
import type { CapabilityDescriptor, ClientCapabilities } from "./protocol/capabilities";
import {
	buildServerCapabilities,
	DEFAULT_LIMITS,
	type ProtocolLimits,
	type ServerCapabilities,
} from "./protocol/capabilities";
import {
	type ClientRequest,
	isClientErrorResponse,
	isClientRequest,
	isClientResult,
	isNotification,
	type Notification,
	type RpcErrorBody,
	type RpcId,
	type ServerErrorResponse,
	type ServerResult,
} from "./protocol/envelope";
import {
	createRpcError,
	failRpc,
	internalError,
	methodNotFound,
	notInitialized,
	RpcMethodError,
} from "./protocol/errors";
import { type LeaseId, newRuntimeId, type RuntimeId, type SessionId, type UploadId } from "./protocol/ids";
import { RPC_V2_METHOD_BY_NAME } from "./protocol/methods";
import { validateRpcV2Params } from "./protocol/validate";
import { sanitizeRpcError } from "./redaction";
import { ResourceUploadError, ResourceUploadManager } from "./resource-upload";
import { RuntimeSettingsRevisionError } from "./runtime-settings-store";
import {
	type ResolvedRunContent,
	type RpcV2CustomModelInput,
	type RpcV2CustomProviderInput,
	type RpcV2SessionFactory,
	RpcV2SessionManager,
	type SessionMutationReceipt,
} from "./session-manager";
import { DesktopActionSetupHost } from "./setup-host-bridge";
import { RpcV2SubagentController } from "./subagent-controller";
import { RpcV2UIContext } from "./ui-context";
import { buildUsageAnalytics } from "./usage-analytics";
import { WorktreeError, WorktreeLifecycleService } from "./worktree-lifecycle";

// ============================================================================
// Protocol constants
// ============================================================================
const IDEMPOTENCY_EXEMPT_METHODS = new Set(["server.shutdown", "stream.configure", "host.capabilities.update"]);
const ATOMIC_SESSION_RECEIPT_METHODS = new Set(["run.start", "approval.decide", "queue.cancel"]);
const RUNTIME_ONLY_IDEMPOTENCY_METHODS = new Set(["provider.config.create", "provider.model.add"]);
/** Durable receipts owned by WorktreeLifecycleService — skip outer IdempotencyStore. */
const WORKTREE_SERVICE_IDEMPOTENCY_METHODS = new Set([
	"worktree.create",
	"worktree.setup.start",
	"worktree.setup.cancel",
	"worktree.apply",
	"worktree.archive",
]);
/**
 * 嵌套控制面 mutation：可在另一 mutation 等待 UI/审批时并行执行。
 * 不得进入 mutationTail，否则 worktree.setup.start → approval.decide 死锁。
 * 普通业务 mutation 仍串行，防竞态。
 */
const NESTED_CONTROL_MUTATION_METHODS = new Set(["approval.decide", "interaction.respond", "interaction.cancel"]);

/** 是否应挂到外层 mutation 串行队列（嵌套控制面除外）。 */
export function shouldSerializeRpcMutation(method: string): boolean {
	const definition = RPC_V2_METHOD_BY_NAME.get(method);
	if (!definition?.mutation) return false;
	return !NESTED_CONTROL_MUTATION_METHODS.has(method);
}
const WORKTREE_EVENT_METHOD_SET = new Set<string>(WORKTREE_EVENT_METHODS);
const PROTOCOL_VERSION = "2.0";
const SERVER_NAME = "san";

// ============================================================================
// Initialize types
// ============================================================================

interface InitializeParams {
	protocolVersion: string;
	client: { name: string; version: string };
	locale?: string;
	host?: { platform: string; arch: string };
	capabilities?: ClientCapabilities;
}

interface InitializeResult {
	protocolVersion: string;
	server: { name: string; version: string; build?: string };
	runtimeId: RuntimeId;
	capabilitiesRevision: number;
	capabilities: ServerCapabilities;
	limits: ProtocolLimits;
}

// ============================================================================
// Server state
// ============================================================================

interface ServerState {
	initialized: boolean;
	runtimeId: RuntimeId;
	startedAt: number;
	capabilitiesRevision: number;
	capabilities: ServerCapabilities;
	limits: ProtocolLimits;
	clientInfo?: { name: string; version: string };
	clientCapabilities?: ClientCapabilities;
	locale?: string;
	host?: { platform: string; arch: string };
	shutdownRequested: boolean;
	shutdownMode: "graceful" | "force";
	shutdownTimeoutMs?: number;
	recentErrors: Array<{ reason: string; category: string; correlationId: string; at: string }>;
}

// ============================================================================
// Output writer
// ============================================================================

type OutputFrame = ServerResult | ServerErrorResponse | Notification | object;
type OutputFn = (frame: OutputFrame, options?: WriteFrameOptions) => Promise<void>;

function createOutput(writer: BackpressureWriter): OutputFn {
	return (frame, options) => writer.write(frame, options);
}

function sendResult(output: OutputFn, id: RpcId, result: unknown): Promise<void> {
	return output({ jsonrpc: "2.0", id, result } satisfies ServerResult);
}

function sendError(output: OutputFn, id: RpcId | null, error: RpcErrorBody): Promise<void> {
	return output({ jsonrpc: "2.0", id, error } satisfies ServerErrorResponse);
}

function sendNotification(output: OutputFn, method: string, params: unknown): Promise<void> {
	return output({ jsonrpc: "2.0", method, params } satisfies Notification);
}

// ============================================================================
// Method handlers
// ============================================================================

function handleInitialize(
	state: ServerState,
	hostToolBridge: RpcV2HostToolBridge,
	worktrees: WorktreeLifecycleService,
	setupHost: DesktopActionSetupHost,
	params: unknown,
): InitializeResult | RpcErrorBody {
	if (state.initialized)
		return createRpcError({
			reason: "INVALID_REQUEST",
			category: "protocol",
			message: "Runtime is already initialized",
		});
	const parsed = parseInitializeParams(params);
	if (isRpcError(parsed)) return parsed;
	const p = parsed;

	// Major version check: only "2.x" is acceptable
	const major = p.protocolVersion.split(".")[0];
	if (major !== "2") {
		return createRpcError({
			reason: "VERSION_INCOMPATIBLE",
			category: "protocol",
			message: `Protocol version ${p.protocolVersion} is incompatible. Server supports 2.x.`,
			suggestedActions: ["Use protocolVersion 2.0"],
		});
	}

	state.initialized = true;
	state.clientInfo = p.client;
	state.clientCapabilities = p.capabilities;
	state.locale = p.locale;
	state.host = p.host;
	const uriSchemes = p.capabilities?.["host.uri"]?.schemes ?? [];
	hostToolBridge.setUriSchemes(uriSchemes.map(scheme => ({ scheme })));
	state.capabilitiesRevision++;
	state.capabilities = buildServerCapabilities({
		"host.tools": p.capabilities?.["host.tools"]
			? { version: 1, status: "available" }
			: unavailableCapability("CLIENT_HOST_TOOLS_MISSING", "Client did not declare host.tools"),
		"host.uri":
			uriSchemes.length > 0
				? { version: 1, status: "available", details: { schemes: uriSchemes } }
				: unavailableCapability("CLIENT_HOST_URI_MISSING", "Client did not declare any host URI scheme"),
		"worktree.lifecycle": resolveWorktreeCapability(worktrees, setupHost),
	});

	return {
		protocolVersion: PROTOCOL_VERSION,
		server: { name: SERVER_NAME, version: VERSION },
		runtimeId: state.runtimeId,
		capabilitiesRevision: state.capabilitiesRevision,
		capabilities: state.capabilities,
		limits: state.limits,
	};
}

function parseInitializeParams(params: unknown): InitializeParams | RpcErrorBody {
	if (!isRecord(params)) return initializeFieldError("params", "Expected an object");
	if (typeof params.protocolVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(params.protocolVersion)) {
		return initializeFieldError("protocolVersion", "Expected a dotted protocol version string");
	}
	if (!isRecord(params.client)) return initializeFieldError("client", "Expected client information");
	if (typeof params.client.name !== "string" || !params.client.name.trim())
		return initializeFieldError("client.name", "Expected a non-empty string");
	if (typeof params.client.version !== "string" || !params.client.version.trim())
		return initializeFieldError("client.version", "Expected a non-empty string");
	if (params.locale !== undefined && (typeof params.locale !== "string" || !params.locale.trim())) {
		return initializeFieldError("locale", "Expected a non-empty string");
	}
	let host: InitializeParams["host"];
	if (params.host !== undefined) {
		if (!isRecord(params.host)) return initializeFieldError("host", "Expected an object");
		if (typeof params.host.platform !== "string" || !params.host.platform.trim())
			return initializeFieldError("host.platform", "Expected a non-empty string");
		if (typeof params.host.arch !== "string" || !params.host.arch.trim())
			return initializeFieldError("host.arch", "Expected a non-empty string");
		host = { platform: params.host.platform, arch: params.host.arch };
	}
	const capabilities = parseClientCapabilities(params.capabilities);
	if (isRpcError(capabilities)) return capabilities;
	return {
		protocolVersion: params.protocolVersion,
		client: { name: params.client.name, version: params.client.version },
		...(typeof params.locale === "string" ? { locale: params.locale } : {}),
		...(host ? { host } : {}),
		...(capabilities ? { capabilities } : {}),
	};
}

function parseClientCapabilities(value: unknown): ClientCapabilities | undefined | RpcErrorBody {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return initializeFieldError("capabilities", "Expected an object");
	const capabilities: ClientCapabilities = {};
	for (const key of ["ui.interaction", "host.tools", "ui.openUrl", "ui.notifications"] as const) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (!isRecord(raw) || !Number.isSafeInteger(raw.version) || (raw.version as number) < 1) {
			return initializeFieldError(`capabilities.${key}.version`, "Expected a positive integer");
		}
		capabilities[key] = { version: raw.version as number };
	}
	const rawHostUri = value["host.uri"];
	if (rawHostUri !== undefined) {
		if (!isRecord(rawHostUri) || !Number.isSafeInteger(rawHostUri.version) || (rawHostUri.version as number) < 1) {
			return initializeFieldError("capabilities.host.uri.version", "Expected a positive integer");
		}
		if (!Array.isArray(rawHostUri.schemes))
			return initializeFieldError("capabilities.host.uri.schemes", "Expected an array");
		const schemes: string[] = [];
		for (const [index, scheme] of rawHostUri.schemes.entries()) {
			if (typeof scheme !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
				return initializeFieldError(`capabilities.host.uri.schemes[${index}]`, "Expected a valid URI scheme");
			}
			const normalized = scheme.toLowerCase();
			if (!schemes.includes(normalized)) schemes.push(normalized);
		}
		capabilities["host.uri"] = { version: rawHostUri.version as number, schemes };
	}
	return capabilities;
}

function initializeFieldError(path: string, message: string): RpcErrorBody {
	return createRpcError({
		reason: "INVALID_PARAMS",
		category: "validation",
		message: `Invalid initialize params at ${path}: ${message}`,
		fieldErrors: [{ path, reason: "invalid", message }],
	});
}

function unavailableCapability(reasonCode: string, message: string): ServerCapabilities["host.tools"] {
	return { version: 1, status: "unavailable", reasonCode, message };
}

interface ParsedHostCapabilities {
	revision?: number;
	tools?: HostToolDefinition[];
	uriSchemes?: HostUriSchemeDefinition[];
}

function parseHostCapabilities(value: unknown): ParsedHostCapabilities | RpcErrorBody {
	if (!isRecord(value)) return invalidParamsError("host.capabilities.update requires an object");
	if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)) {
		return invalidParamsError("host.capabilities.update revision must be a non-negative integer", "revision");
	}
	let tools: HostToolDefinition[] | undefined;
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools))
			return invalidParamsError("host.capabilities.update tools must be an array", "tools");
		tools = [];
		const names = new Set<string>();
		for (const [index, raw] of value.tools.entries()) {
			if (!isRecord(raw))
				return invalidParamsError(`Host Tool at index ${index} must be an object`, `tools[${index}]`);
			const name = typeof raw.name === "string" ? raw.name.trim() : "";
			if (!name || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) {
				return invalidParamsError(`Host Tool at index ${index} has an invalid name`, `tools[${index}].name`);
			}
			if (names.has(name)) return invalidParamsError(`Duplicate Host Tool name: ${name}`, `tools[${index}].name`);
			names.add(name);
			const description = typeof raw.description === "string" ? raw.description.trim() : "";
			if (!description)
				return invalidParamsError(`Host Tool ${name} requires a description`, `tools[${index}].description`);
			if (!isRecord(raw.parameters))
				return invalidParamsError(`Host Tool ${name} requires a JSON Schema object`, `tools[${index}].parameters`);
			if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label.trim())) {
				return invalidParamsError(`Host Tool ${name} label must be a non-empty string`, `tools[${index}].label`);
			}
			if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
				return invalidParamsError(`Host Tool ${name} hidden must be a boolean`, `tools[${index}].hidden`);
			}
			tools.push({
				name,
				label: typeof raw.label === "string" ? raw.label.trim() : name,
				description,
				parameters: structuredClone(raw.parameters),
				...(raw.hidden === true ? { hidden: true } : {}),
			});
		}
	}
	let uriSchemes: HostUriSchemeDefinition[] | undefined;
	if (value.uriSchemes !== undefined) {
		if (!Array.isArray(value.uriSchemes))
			return invalidParamsError("host.capabilities.update uriSchemes must be an array", "uriSchemes");
		uriSchemes = [];
		const names = new Set<string>();
		for (const [index, raw] of value.uriSchemes.entries()) {
			if (!isRecord(raw) || typeof raw.scheme !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(raw.scheme)) {
				return invalidParamsError(`Host URI scheme at index ${index} is invalid`, `uriSchemes[${index}].scheme`);
			}
			const scheme = raw.scheme.toLowerCase();
			if (names.has(scheme))
				return invalidParamsError(`Duplicate Host URI scheme: ${scheme}`, `uriSchemes[${index}].scheme`);
			names.add(scheme);
			if (raw.description !== undefined && typeof raw.description !== "string") {
				return invalidParamsError(
					`Host URI scheme ${scheme} description must be a string`,
					`uriSchemes[${index}].description`,
				);
			}
			if (raw.writable !== undefined && typeof raw.writable !== "boolean") {
				return invalidParamsError(
					`Host URI scheme ${scheme} writable must be a boolean`,
					`uriSchemes[${index}].writable`,
				);
			}
			if (raw.immutable !== undefined && typeof raw.immutable !== "boolean") {
				return invalidParamsError(
					`Host URI scheme ${scheme} immutable must be a boolean`,
					`uriSchemes[${index}].immutable`,
				);
			}
			uriSchemes.push({
				scheme,
				...(typeof raw.description === "string" ? { description: raw.description } : {}),
				...(typeof raw.writable === "boolean" ? { writable: raw.writable } : {}),
				...(typeof raw.immutable === "boolean" ? { immutable: raw.immutable } : {}),
			});
		}
	}
	if (!tools && !uriSchemes) return invalidParamsError("host.capabilities.update requires tools or uriSchemes");
	return {
		...(typeof value.revision === "number" ? { revision: value.revision } : {}),
		...(tools ? { tools } : {}),
		...(uriSchemes ? { uriSchemes } : {}),
	};
}

function handleGetHealth(state: ServerState, sessionManager: RpcV2SessionManager): object {
	return {
		status: state.shutdownRequested ? "shutting_down" : "ok",
		runtimeId: state.runtimeId,
		uptimeMs: Date.now() - state.startedAt,
		initialized: state.initialized,
		capabilitiesRevision: state.capabilitiesRevision,
		...(sessionManager.currentSessionId
			? {
					activeSession: {
						sessionId: sessionManager.currentSessionId,
						revision: sessionManager.currentRevision,
						lastSequence: sessionManager.currentLastSequence,
					},
				}
			: {}),
	};
}

function handleGetCapabilities(state: ServerState, params: unknown): object {
	const p = params as { knownRevision?: number } | undefined;
	if (p?.knownRevision === state.capabilitiesRevision) {
		return { unchanged: true, revision: state.capabilitiesRevision };
	}
	return {
		unchanged: false,
		revision: state.capabilitiesRevision,
		capabilities: state.capabilities,
	};
}

function handleShutdown(state: ServerState, params: unknown): object {
	const p = params as { mode?: "graceful" | "force"; timeoutMs?: number } | undefined;
	state.shutdownRequested = true;
	state.shutdownMode = p?.mode ?? "graceful";
	if (p?.timeoutMs === undefined) delete state.shutdownTimeoutMs;
	else state.shutdownTimeoutMs = p.timeoutMs;
	return {
		accepted: true,
		mode: state.shutdownMode,
		...(state.shutdownTimeoutMs !== undefined ? { timeoutMs: state.shutdownTimeoutMs } : {}),
	};
}

// ============================================================================
// Method router
// ============================================================================

interface DispatchContext {
	state: ServerState;
	sessionManager: RpcV2SessionManager;
	output: OutputFn;
	outputDiagnostics: () => {
		pendingFrames: number;
		queuedTransientFrames: number;
		coalescedFrames: number;
		blockedStdoutWrites: number;
		droppedTransientFrames: number;
		droppedTransientEvents: number;
	};
	getUIContext: () => RpcV2UIContext | undefined;
	hostToolBridge: RpcV2HostToolBridge;
	idempotency: IdempotencyStore;
	sessionCreateReceipts: SessionCreateReceiptStore;
	resources: ResourceUploadManager;
	artifacts: RpcArtifactStore;
	approvalRules: ApprovalRuleStore;
	auth: AuthLoginManager;
	subagents: RpcV2SubagentController;
	integrations: RpcV2IntegrationCatalog;
	worktrees: WorktreeLifecycleService;
	/** 真实 setup host-action 桥；缺工具/未 recovery 时 ready=false。 */
	setupHost: DesktopActionSetupHost;
}

async function resolveRunContent(
	ctx: Pick<DispatchContext, "hostToolBridge" | "resources" | "state">,
	session: AgentSession,
	sessionId: SessionId,
	value: unknown,
): Promise<{ content: ContentPart[]; resolved: ResolvedRunContent }> {
	if (!Array.isArray(value) || value.length === 0) {
		failRpc({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: "content must be a non-empty ContentPart array",
			fieldErrors: [{ path: "content", reason: "required", message: "Expected at least one content part" }],
		});
	}

	const content: ContentPart[] = [];
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	const resourceIds = new Set<string>();
	let resourceCount = 0;
	let totalResourceBytes = 0;
	let inlineTextBytes = 0;

	for (const [index, rawPart] of value.entries()) {
		const partPath = `content[${index}]`;
		if (!isRecord(rawPart) || typeof rawPart.type !== "string") {
			failResourceField(partPath, "invalid_type", "Expected a ContentPart object");
		}
		if (rawPart.type === "text") {
			if (typeof rawPart.text !== "string") failResourceField(`${partPath}.text`, "invalid_type", "Expected string");
			inlineTextBytes += Buffer.byteLength(rawPart.text, "utf8");
			if (inlineTextBytes > ctx.state.limits.maxInlineTextBytes) {
				failRpc({
					reason: "PAYLOAD_TOO_LARGE",
					category: "validation",
					message: `Inline text exceeds ${ctx.state.limits.maxInlineTextBytes} bytes`,
					fieldErrors: [
						{ path: `${partPath}.text`, reason: "too_large", message: "Use an uploaded resource for large text" },
					],
				});
			}
			content.push({ type: "text", text: rawPart.text });
			textParts.push(rawPart.text);
			continue;
		}

		if (rawPart.type !== "image" && rawPart.type !== "resource") {
			failResourceField(`${partPath}.type`, "unsupported", `Unsupported content type: ${rawPart.type}`);
		}
		if (!isRecord(rawPart.resource) || typeof rawPart.resource.resourceId !== "string") {
			failResourceField(`${partPath}.resource.resourceId`, "required", "Expected a resourceId");
		}
		const resource = ctx.resources.getResource(rawPart.resource.resourceId, sessionId);
		if (resource?.state !== "committed") {
			failRpc({
				reason: "RESOURCE_NOT_FOUND",
				category: "not_found",
				message: `Committed resource not found: ${rawPart.resource.resourceId}`,
				sessionId,
				fieldErrors: [
					{
						path: `${partPath}.resource.resourceId`,
						reason: "not_found",
						message: "Resource is missing, released, or belongs to another Session",
					},
				],
			});
		}
		if (rawPart.resource.sessionId !== sessionId) {
			failResourceField(
				`${partPath}.resource.sessionId`,
				"session_mismatch",
				"Resource must belong to the active Session",
			);
		}
		for (const key of ["mediaType", "byteLength", "sha256"] as const) {
			if (rawPart.resource[key] !== resource[key]) {
				failResourceField(
					`${partPath}.resource.${key}`,
					"metadata_mismatch",
					"Resource metadata does not match the committed resource",
				);
			}
		}
		if (resource.expiresAt && Date.parse(resource.expiresAt) <= Date.now()) {
			failRpc({
				reason: "RESOURCE_NOT_FOUND",
				category: "not_found",
				message: `Resource expired: ${resource.resourceId}`,
				sessionId,
				fieldErrors: [{ path: `${partPath}.resource`, reason: "expired", message: "Resource has expired" }],
			});
		}

		resourceCount++;
		resourceIds.add(resource.resourceId);
		totalResourceBytes += resource.byteLength;
		if (resourceCount > ctx.state.limits.resources.maxResourcesPerRun) {
			failResourceField(
				partPath,
				"too_many",
				`A Run accepts at most ${ctx.state.limits.resources.maxResourcesPerRun} resources`,
			);
		}
		if (
			resource.byteLength > ctx.state.limits.resources.maxResourceBytes ||
			totalResourceBytes > ctx.state.limits.resources.maxTotalBytesPerRun
		) {
			failRpc({
				reason: "PAYLOAD_TOO_LARGE",
				category: "validation",
				message: "Run resources exceed negotiated limits",
				fieldErrors: [
					{
						path: `${partPath}.resource.byteLength`,
						reason: "too_large",
						message: "Resource or aggregate size exceeds negotiated limits",
					},
				],
			});
		}

		const bytes = await readResourceBytes(ctx, resource.resourceId, sessionId, resource.source, resource.hostUri);
		if (bytes.byteLength !== resource.byteLength) {
			failResourceField(
				`${partPath}.resource.byteLength`,
				"length_mismatch",
				`Read ${bytes.byteLength} bytes, expected ${resource.byteLength}`,
			);
		}
		const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		if (hash !== resource.sha256) {
			failResourceField(`${partPath}.resource.sha256`, "hash_mismatch", `Computed ${hash}`);
		}

		if (rawPart.type === "image") {
			if (!resource.mediaType.startsWith("image/")) {
				failResourceField(
					`${partPath}.resource.mediaType`,
					"not_image",
					"Image content requires an image media type",
				);
			}
			if (!session.model?.input.includes("image")) {
				failRpc({
					reason: "MODEL_UNAVAILABLE",
					category: "conflict",
					message: "The selected model does not accept image input",
					sessionId,
					fieldErrors: [
						{ path: partPath, reason: "model_incompatible", message: "Select a vision-capable model" },
					],
				});
			}
			const detail = rawPart.detail;
			if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
				failResourceField(`${partPath}.detail`, "invalid_enum", "Expected auto, low, or high");
			}
			const image: ImageContent = {
				type: "image",
				data: Buffer.from(bytes).toString("base64"),
				mimeType: resource.mediaType,
				...(detail ? { detail } : {}),
			};
			images.push(image);
			content.push({
				type: "image",
				resource,
				...(detail ? { detail } : {}),
				...(typeof rawPart.alt === "string" ? { alt: rawPart.alt } : {}),
			});
			continue;
		}

		if (rawPart.purpose !== "input" && rawPart.purpose !== "reference") {
			failResourceField(`${partPath}.purpose`, "invalid_enum", "Expected input or reference");
		}
		if (resource.mediaType !== "text/plain" && resource.mediaType !== "application/json") {
			failResourceField(
				`${partPath}.resource.mediaType`,
				"model_incompatible",
				"Only text and JSON resources can be passed as generic model input",
			);
		}
		let resourceText: string;
		try {
			resourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			failResourceField(`${partPath}.resource`, "invalid_utf8", "Text resources must contain valid UTF-8");
		}
		textParts.push(
			prompt.render(resourceInputTemplate, {
				fileName: resource.fileName ?? resource.resourceId,
				mediaType: resource.mediaType,
				content: resourceText,
			}),
		);
		content.push({ type: "resource", resource, purpose: rawPart.purpose });
	}

	if (textParts.every(text => text.length === 0) && images.length === 0) {
		failResourceField("content", "empty", "Content must contain text or at least one image");
	}
	return { content, resolved: { text: textParts.join("\n\n"), images, resourceIds: [...resourceIds] } };
}

async function readResourceBytes(
	ctx: Pick<DispatchContext, "hostToolBridge" | "resources">,
	resourceId: string,
	sessionId: SessionId,
	source: "upload" | "host_uri" | "san_artifact",
	hostUri: string | undefined,
): Promise<Uint8Array> {
	if (source === "upload") return await ctx.resources.readResource(resourceId, sessionId);
	if (source !== "host_uri" || !hostUri) {
		failRpc({
			reason: "RESOURCE_INVALID",
			category: "validation",
			message: `Resource ${resourceId} cannot be read as input`,
			sessionId,
		});
	}
	const result = await ctx.hostToolBridge.invokeUri("read", hostUri);
	if (
		!isRecord(result) ||
		typeof result.data !== "string" ||
		(result.encoding !== "utf-8" && result.encoding !== "base64")
	) {
		failRpc({
			reason: "HOST_TOOL_FAILED",
			category: "io",
			message: `host.uri.read returned an invalid result for ${resourceId}`,
			sessionId,
		});
	}
	if (result.encoding === "utf-8") return new TextEncoder().encode(result.data);
	if (!isCanonicalBase64(result.data)) {
		failRpc({
			reason: "HOST_TOOL_FAILED",
			category: "io",
			message: `host.uri.read returned invalid base64 for ${resourceId}`,
			sessionId,
		});
	}
	return Buffer.from(result.data, "base64");
}

function failResourceField(path: string, reason: string, message: string): never {
	failRpc({
		reason: "RESOURCE_INVALID",
		category: "validation",
		message: `Invalid input resource at ${path}: ${message}`,
		fieldErrors: [{ path, reason, message }],
	});
}

function isCanonicalBase64(value: string): boolean {
	return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

async function selectModel(
	session: AgentSession,
	provider: string | undefined,
	modelId: string | undefined,
): Promise<object> {
	if (!provider || !modelId)
		failRpc({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: "model selection requires provider and modelId",
			fieldErrors: [
				...(!provider ? [{ path: "provider", reason: "required", message: "Expected a provider id" }] : []),
				...(!modelId ? [{ path: "modelId", reason: "required", message: "Expected a model id" }] : []),
			],
		});
	const model = session
		.getAvailableModels()
		.find(candidate => candidate.provider === provider && candidate.id === modelId);
	if (!model)
		failRpc({
			reason: "MODEL_UNAVAILABLE",
			category: "not_found",
			message: `Model not found or not authenticated: ${provider}/${modelId}`,
			details: { provider, modelId },
		});
	await session.setModel(model);
	return {
		provider: model.provider,
		modelId: model.id,
		displayName: model.name,
		contextWindow: model.contextWindow,
		input: model.input,
		thinking: session.thinkingLevel,
	};
}

function setThinkingLevel(session: AgentSession, value: string): object {
	const level = parseConfiguredThinkingLevel(value);
	if (!level)
		failRpc({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: `Unsupported thinking level: ${value}`,
			fieldErrors: [{ path: "level", reason: "invalid_enum", message: "Expected a supported thinking level" }],
		});
	session.setThinkingLevel(level);
	return { configured: session.configuredThinkingLevel(), effective: session.thinkingLevel };
}

function invalidParamsError(message: string, path?: string): RpcErrorBody {
	return createRpcError({
		reason: "INVALID_PARAMS",
		category: "validation",
		message,
		...(path ? { fieldErrors: [{ path, reason: "required", message }] } : {}),
	});
}

async function dispatchMethod(ctx: DispatchContext, method: string, params: unknown): Promise<unknown> {
	const definition = RPC_V2_METHOD_BY_NAME.get(method);
	if (!definition) return methodNotFound(method);
	if (!ctx.state.initialized && !definition.preInitialize) return notInitialized();
	const fieldErrors = validateRpcV2Params(method, params);
	if (fieldErrors.length > 0) {
		return createRpcError({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: `${method} params do not match the RPC v2 schema`,
			fieldErrors,
		});
	}
	if (definition.capability) {
		const capability = ctx.state.capabilities[definition.capability];
		if (capability.status === "unavailable") {
			return createRpcError({
				reason: "CAPABILITY_UNAVAILABLE",
				category: "conflict",
				message: capability.message ?? `Capability ${definition.capability} is unavailable`,
				details: { capability: definition.capability, reasonCode: capability.reasonCode },
			});
		}
	}

	const record = isRecord(params) ? params : undefined;
	const mutationMeta = record && isRecord(record.meta) ? record.meta : undefined;
	let idempotencyKey: string | undefined;
	let idempotencyInput: { method: string; params: unknown } | undefined;
	let createReservation: SessionCreateReservation | undefined;
	if (definition.mutation && !IDEMPOTENCY_EXEMPT_METHODS.has(method)) {
		idempotencyKey =
			typeof mutationMeta?.idempotencyKey === "string" ? mutationMeta.idempotencyKey.trim() : undefined;
		if (!idempotencyKey) {
			return createRpcError({
				reason: "INVALID_PARAMS",
				category: "validation",
				message: `${method} requires meta.idempotencyKey`,
				fieldErrors: [{ path: "meta.idempotencyKey", reason: "required", message: "Expected a non-empty string" }],
			});
		}
		try {
			idempotencyInput = { method, params };
			if (WORKTREE_SERVICE_IDEMPOTENCY_METHODS.has(method)) {
				// Durable receipts + conflict detection live in WorktreeLifecycleService.
			} else if (method === "session.create") {
				const createReceipt = await ctx.sessionCreateReceipts.begin(idempotencyKey, idempotencyInput);
				if (createReceipt.cached) return await ctx.sessionManager.replayCreatedSession(createReceipt.sessionId);
				createReservation = createReceipt.reservation;
			} else {
				const runtimeReceipt = ctx.idempotency.check(idempotencyKey, idempotencyInput);
				if (runtimeReceipt.cached) return runtimeReceipt.result;
				if (ctx.sessionManager.currentSession) {
					const sessionReceipt = ctx.sessionManager.checkIdempotency(idempotencyKey, idempotencyInput);
					if (sessionReceipt.cached) return sessionReceipt.result;
				}
			}
		} catch (error: unknown) {
			if (error instanceof IdempotencyConflictError) return idempotencyConflict(error.key);
			if (error instanceof IdempotencyInProgressError || error instanceof IdempotencyOutcomeUnknownError) {
				return createRpcError({
					reason: "SESSION_STATE_CONFLICT",
					category: "conflict",
					message: error.message,
					retryable: error instanceof IdempotencyInProgressError,
					details: {
						idempotencyKey: error.key,
						idempotencyState: error instanceof IdempotencyInProgressError ? "in_progress" : "outcome_unknown",
					},
					suggestedActions: ["Use session.list to locate the original Session before retrying with a new key"],
				});
			}
			throw error;
		}
	}

	try {
		if (definition.requiresSession) {
			const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
			ctx.sessionManager.assertSession(sessionId);
		}
		if (definition.requiresWriteLease) {
			const sessionId = typeof record?.sessionId === "string" ? record.sessionId : "";
			const leaseId = typeof record?.leaseId === "string" ? record.leaseId : "";
			if (!sessionId || !leaseId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: `${method} requires sessionId and leaseId`,
				});
			}
			const active = ctx.sessionManager.assertLease(sessionId, leaseId, true);
			ctx.sessionManager.assertRevision(
				active,
				typeof mutationMeta?.expectedRevision === "number" ? mutationMeta.expectedRevision : undefined,
			);
		}

		const receipt =
			idempotencyKey && idempotencyInput && ATOMIC_SESSION_RECEIPT_METHODS.has(method)
				? { key: idempotencyKey, params: idempotencyInput }
				: undefined;
		const result = await dispatchKnownMethod(ctx, method, params, receipt);
		if (isRpcError(result)) {
			if (createReservation) await ctx.sessionCreateReceipts.cancel(createReservation);
			return result;
		}
		if (idempotencyKey && !isRpcError(result) && !WORKTREE_SERVICE_IDEMPOTENCY_METHODS.has(method)) {
			const completedInput = idempotencyInput ?? { method, params };
			if (method === "session.create" && createReservation) {
				if (!isRecord(result) || typeof result.sessionId !== "string") {
					throw new Error("session.create completed without a sessionId");
				}
				await ctx.sessionCreateReceipts.complete(createReservation, result.sessionId);
			} else {
				ctx.idempotency.record(idempotencyKey, completedInput, result);
				if (
					ctx.sessionManager.currentSession &&
					!ATOMIC_SESSION_RECEIPT_METHODS.has(method) &&
					!RUNTIME_ONLY_IDEMPOTENCY_METHODS.has(method)
				) {
					await ctx.sessionManager.recordIdempotency(idempotencyKey, completedInput, result);
				}
			}
		}
		return result;
	} catch (error: unknown) {
		if (createReservation) await ctx.sessionCreateReceipts.cancel(createReservation);
		if (error instanceof RpcMethodError) return error.rpcError;
		if (error instanceof IdempotencyConflictError) return idempotencyConflict(error.key);
		if (error instanceof ApprovalPolicyRevisionError) {
			return createRpcError({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: error.message,
				details: { currentRevision: error.currentRevision, expectedRevision: error.expectedRevision },
				suggestedActions: ["Read the current approval policy and retry"],
			});
		}
		if (error instanceof IntegrationRevisionError) {
			return createRpcError({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: error.message,
				details: { currentRevision: error.currentRevision, expectedRevision: error.expectedRevision },
			});
		}
		if (error instanceof ResourceUploadError) {
			return createRpcError({
				reason: error.reason === "not_found" ? "RESOURCE_NOT_FOUND" : "RESOURCE_INVALID",
				category: error.reason === "not_found" ? "not_found" : "validation",
				message: error.message,
			});
		}
		if (error instanceof RpcArtifactError) {
			return createRpcError({
				reason: error.reason === "not_found" ? "RESOURCE_NOT_FOUND" : "RESOURCE_INVALID",
				category: error.reason === "not_found" ? "not_found" : "validation",
				message: error.message,
			});
		}
		throw error;
	}
}

async function dispatchKnownMethod(
	ctx: DispatchContext,
	method: string,
	params: unknown,
	receipt?: SessionMutationReceipt,
): Promise<unknown> {
	const { state, sessionManager } = ctx;

	const session = sessionManager.currentSession;
	const methodsWithoutSession = new Set([
		"initialize",
		"server.getHealth",
		"server.getCapabilities",
		"server.shutdown",
		"session.list",
		"session.get",
		"session.create",
		"session.open",
		"session.delete",
		"session.unsync",
		"stream.configure",
		"server.getDiagnostics",
		"model.list",
		"settings.get",
		"settings.update",
		"execution.profile.list",
		"auth.provider.list",
		"auth.login.start",
		"auth.login.cancel",
		"provider.config.create",
		"provider.model.add",
		"usage.stats",
		"approval.rules.list",
		"approval.rules.revoke",
		"approval.policy.get",
		"approval.policy.update",
		"interaction.respond",
		"interaction.cancel",
		"host.capabilities.update",
		"worktree.create",
		"worktree.get",
		"worktree.list",
		"worktree.setup.start",
		"worktree.setup.cancel",
		"worktree.apply.prepare",
		"worktree.apply",
		"worktree.archive",
	]);
	if (!session && !methodsWithoutSession.has(method)) {
		return createRpcError({
			reason: "SESSION_NOT_FOUND",
			category: "not_found",
			message: "No Session is open in this Runtime",
		});
	}
	const activeSession = session as AgentSession;

	switch (method) {
		// Server methods
		case "initialize":
			return handleInitialize(state, ctx.hostToolBridge, ctx.worktrees, ctx.setupHost, params);
		case "server.getHealth":
			return handleGetHealth(state, sessionManager);
		case "server.getCapabilities":
			return handleGetCapabilities(state, params);
		case "server.shutdown":
			return handleShutdown(state, params);

		// Session methods
		case "session.list":
			return sessionManager.listSessions(
				params as {
					query?: string;
					cwd?: string;
					statuses?: string[];
					sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
					limit?: number;
					cursor?: string;
				},
			);
		case "session.get": {
			const p = params as { sessionId?: string } | undefined;
			if (!p?.sessionId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.get requires sessionId",
				});
			}
			return sessionManager.getSession(p.sessionId);
		}
		case "session.create": {
			const p = params as
				| { cwd?: string; title?: string; parentSessionId?: string; executionProfileId?: string }
				| undefined;
			if (!p?.cwd) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.create requires cwd",
				});
			}
			if (p.executionProfileId !== undefined && !normalizeSanLoopMode(p.executionProfileId)) {
				return invalidParamsError(`Unknown execution profile: ${p.executionProfileId}`, "executionProfileId");
			}
			return sessionManager.create({
				cwd: p.cwd,
				title: p.title,
				parentSessionId: p.parentSessionId,
				executionProfileId: p.executionProfileId,
			});
		}
		case "session.open": {
			const p = params as
				| { sessionId?: string; access?: "read_write" | "read_only"; stealExpiredLease?: boolean }
				| undefined;
			if (!p?.sessionId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.open requires sessionId",
				});
			}
			return sessionManager.open({
				sessionId: p.sessionId,
				access: p.access ?? "read_write",
				stealExpiredLease: p.stealExpiredLease,
			});
		}
		case "session.sync": {
			const p = params as
				| { sessionId?: string; leaseId: LeaseId; afterSequence?: number | null; stream?: Record<string, unknown> }
				| undefined;
			if (!p?.sessionId || !p.leaseId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.sync requires sessionId and leaseId",
				});
			}
			return sessionManager.sync({
				sessionId: p.sessionId,
				leaseId: p.leaseId,
				afterSequence: p.afterSequence,
				stream: parseStreamPolicy(p.stream),
			});
		}
		case "session.unsync": {
			const p = params as { subscriptionId?: string } | undefined;
			if (!p?.subscriptionId) return invalidParamsError("session.unsync requires subscriptionId", "subscriptionId");
			return await sessionManager.unsync(p.subscriptionId);
		}
		case "session.events.list": {
			const p = params as
				| {
						sessionId?: string;
						afterSequence?: number;
						beforeSequence?: number;
						cursor?: string;
						limit?: number;
						types?: string[];
				  }
				| undefined;
			if (!p?.sessionId) return invalidParamsError("session.events.list requires sessionId", "sessionId");
			return await sessionManager.listEvents({
				sessionId: p.sessionId,
				afterSequence: p.afterSequence,
				beforeSequence: p.beforeSequence,
				cursor: p.cursor,
				limit: p.limit,
				types: p.types,
			});
		}
		case "session.messages.list": {
			const p = params as { sessionId?: string; cursor?: string; limit?: number } | undefined;
			if (!p?.sessionId) return invalidParamsError("session.messages.list requires sessionId", "sessionId");
			return await sessionManager.listMessages({
				sessionId: p.sessionId,
				cursor: p.cursor,
				limit: p.limit,
			});
		}
		case "session.delete": {
			const p = params as
				| { sessionId?: string; mode?: "trash" | "permanent"; expectedRevision?: number }
				| undefined;
			if (!p?.sessionId) return invalidParamsError("session.delete requires sessionId", "sessionId");
			if (p.mode !== undefined && p.mode !== "trash" && p.mode !== "permanent") {
				return invalidParamsError("session.delete mode must be trash or permanent", "mode");
			}
			return await sessionManager.deleteSession(p.sessionId, p.mode ?? "trash", p.expectedRevision);
		}
		case "session.close":
			await sessionManager.close({
				abortRunning: (params as { runningBehavior?: string } | undefined)?.runningBehavior === "abort",
			});
			return { closed: true };

		// Run methods
		case "run.start": {
			const p = params as
				| { content?: unknown; model?: { provider?: string; modelId?: string }; thinking?: string; goal?: string }
				| undefined;
			if (p?.model) await selectModel(activeSession, p.model.provider, p.model.modelId);
			if (p?.thinking !== undefined) setThinkingLevel(activeSession, p.thinking);
			if (p?.goal !== undefined) {
				const objective = p.goal.trim();
				if (!objective) return invalidParamsError("run.start goal must be non-empty", "goal");
				const existingGoal = activeSession.getGoalModeState()?.goal;
				if (!existingGoal || existingGoal.status === "dropped" || existingGoal.status === "complete") {
					await activeSession.goalRuntime.createGoal({ objective });
				} else if (existingGoal.objective !== objective) {
					return createRpcError({
						reason: "SESSION_STATE_CONFLICT",
						category: "conflict",
						message: "run.start goal conflicts with the Session's active goal",
						details: { activeGoalId: existingGoal.id },
					});
				}
			}
			const active = sessionManager.assertSession();
			const { resolved } = await resolveRunContent(ctx, activeSession, active.sessionId, p?.content);
			const accepted = await sessionManager.startRun(active, resolved, undefined, receipt);
			return { runId: accepted.runId, operationId: accepted.operationId, acceptedAt: accepted.acceptedAt };
		}
		case "run.abort": {
			const p = params as { runId?: string; reason?: "user" | "close" | "shutdown" } | undefined;
			if (!p?.runId) return invalidParamsError("run.abort requires runId", "runId");
			return await sessionManager.abortRun(sessionManager.assertSession(), p.runId, p.reason ?? "user");
		}
		case "run.steer": {
			const p = params as { runId?: string; content?: unknown; delivery?: string } | undefined;
			if (!p?.runId) return invalidParamsError("run.steer requires runId", "runId");
			if (p.delivery !== undefined && p.delivery !== "immediate" && p.delivery !== "next_safe_point") {
				return invalidParamsError("run.steer delivery must be immediate or next_safe_point", "delivery");
			}
			const active = sessionManager.assertSession();
			const { resolved } = await resolveRunContent(ctx, activeSession, active.sessionId, p.content);
			return await sessionManager.steerRun(active, p.runId, resolved);
		}
		case "run.followUp": {
			const p = params as { content?: unknown } | undefined;
			const active = sessionManager.assertSession();
			const { content } = await resolveRunContent(ctx, activeSession, active.sessionId, p?.content);
			const item = await sessionManager.addQueueItem(active, content);
			await sessionManager.promoteQueueIfIdle(active);
			return { item, revision: sessionManager.currentRevision };
		}
		case "run.replace": {
			const p = params as { expectedRunId?: string; content?: unknown } | undefined;
			if (!p?.expectedRunId) return invalidParamsError("run.replace requires expectedRunId", "expectedRunId");
			const active = sessionManager.assertSession();
			const { resolved } = await resolveRunContent(ctx, activeSession, active.sessionId, p.content);
			return await sessionManager.replaceRun(active, p.expectedRunId, resolved);
		}
		case "retry.cancel": {
			const p = params as { runId?: string } | undefined;
			const active = sessionManager.assertSession();
			if (!p?.runId) return invalidParamsError("retry.cancel requires runId", "runId");
			if (!active.activeRun || active.activeRun.runId !== p.runId || !activeSession.isRetrying) {
				return createRpcError({
					reason: "RUN_STATE_CONFLICT",
					category: "conflict",
					message: `Run ${p.runId} is not waiting for a retry`,
					runId: p.runId,
					details: { activeRunId: active.activeRun?.runId, retrying: activeSession.isRetrying },
				});
			}
			activeSession.abortRetry();
			await sessionManager.emitCustom(
				active,
				"retry.cancelled",
				{ runId: p.runId },
				{ runId: active.activeRun.runId },
			);
			return { cancelled: true, runId: p.runId };
		}
		case "queue.list": {
			const active = sessionManager.assertSession();
			return { items: active.queue.map(item => ({ ...item })), revision: sessionManager.currentRevision };
		}
		case "queue.cancel": {
			const p = params as { queueItemId?: string; expectedStatus?: string } | undefined;
			if (!p?.queueItemId) return invalidParamsError("queue.cancel requires queueItemId", "queueItemId");
			return await sessionManager.cancelQueueItem(
				sessionManager.assertSession(),
				p.queueItemId,
				p.expectedStatus,
				undefined,
				receipt,
			);
		}

		// Model / Thinking
		case "model.list": {
			const p = params as { provider?: string; includeUnavailable?: boolean } | undefined;
			const catalog = sessionManager.runtimeCatalog;
			if (!catalog)
				return createRpcError({
					reason: "CAPABILITY_UNAVAILABLE",
					category: "conflict",
					message: "Runtime model catalog is unavailable",
				});
			const availableKeys = new Set(catalog.getAvailableModels().map(model => `${model.provider}\0${model.id}`));
			const source = p?.includeUnavailable ? catalog.getAllModels() : catalog.getAvailableModels();
			const models = source.filter(model => !p?.provider || model.provider === p.provider);
			return {
				models: models.map(m => ({
					provider: m.provider,
					modelId: m.id,
					displayName: m.name,
					contextWindow: m.contextWindow,
					input: m.input,
					reasoning: m.reasoning,
					available: availableKeys.has(`${m.provider}\0${m.id}`),
					authenticated: catalog.hasModelAuth(m.provider, m.id),
				})),
			};
		}
		case "model.select": {
			const p = params as { provider?: string; modelId?: string } | undefined;
			const selected = await selectModel(activeSession, p?.provider, p?.modelId);
			return { ...selected, revision: sessionManager.currentRevision };
		}
		case "thinking.set": {
			const p = params as { level?: string } | undefined;
			if (!p?.level) return invalidParamsError("thinking.set requires level", "level");
			return setThinkingLevel(activeSession, p.level);
		}

		// Settings / Profiles
		case "settings.get": {
			const p = params as
				| { scope?: "session" | "workspace" | "global"; sessionId?: string; cwd?: string }
				| undefined;
			if (p?.scope === "session") return sessionManager.getSettings(sessionManager.assertSession(p.sessionId));
			if (p?.scope === "workspace") {
				if (!p.cwd || !path.isAbsolute(p.cwd)) {
					return invalidParamsError("settings.get workspace scope requires an absolute cwd", "cwd");
				}
				return await sessionManager.getScopedSettings("workspace", p.cwd);
			}
			return await sessionManager.getScopedSettings("global");
		}
		case "settings.update": {
			const p = params as
				| {
						scope?: "session" | "workspace" | "global";
						sessionId?: string;
						leaseId?: string;
						cwd?: string;
						patch?: unknown;
						meta?: { expectedRevision?: number };
				  }
				| undefined;
			if (!isRecord(p?.patch)) return invalidParamsError("settings.update requires a typed patch", "patch");
			const patch = parseSettingsPatch(p.patch);
			if (p.scope === "session") {
				if (!p.sessionId)
					return invalidParamsError("settings.update session scope requires sessionId", "sessionId");
				if (!p.leaseId) return invalidParamsError("settings.update session scope requires leaseId", "leaseId");
				const active = sessionManager.assertLease(p.sessionId, p.leaseId, true);
				sessionManager.assertRevision(active, p.meta?.expectedRevision);
				return await sessionManager.updateSettings(active, patch);
			}
			if (p.scope === "workspace" && (!p.cwd || !path.isAbsolute(p.cwd))) {
				return invalidParamsError("settings.update workspace scope requires an absolute cwd", "cwd");
			}
			try {
				return await sessionManager.updateScopedSettings(
					p.scope === "workspace" ? "workspace" : "global",
					p.cwd,
					patch,
					p.meta?.expectedRevision,
				);
			} catch (error: unknown) {
				if (error instanceof RuntimeSettingsRevisionError) {
					failRpc({
						reason: "SESSION_STATE_CONFLICT",
						category: "conflict",
						message: error.message,
						details: { currentRevision: error.currentRevision },
						suggestedActions: ["settings.get"],
					});
				}
				throw error;
			}
		}
		case "execution.profile.list": {
			return {
				defaultProfileId: "team",
				profiles: [
					{
						profileId: "solo",
						name: "Solo",
						description: "Single agent execution",
						availability: "available",
						capabilities: ["run", "tools", "subagent"],
						recommendedFor: ["general"],
					},
					{
						profileId: "team",
						name: "Team",
						description: "Multi-agent team execution",
						availability: "available",
						capabilities: ["run", "tools", "subagent", "parallel"],
						recommendedFor: ["complex-tasks"],
					},
					{
						profileId: "council",
						name: "Council",
						description: "Multi-agent execution with independent oracle review",
						availability: "available",
						capabilities: ["run", "tools", "subagent", "parallel", "oracle"],
						recommendedFor: ["high-risk", "architecture", "release-gates"],
					},
				],
			};
		}

		// Todo
		case "todo.set": {
			const p = params as { phases?: unknown } | undefined;
			const phases = parseTodoPhases(p?.phases);
			activeSession.setTodoPhases(phases);
			const active = sessionManager.assertSession();
			await sessionManager.emitCustom(active, "todo.changed", { phases });
			return { todoPhases: activeSession.getTodoPhases(), revision: sessionManager.currentRevision };
		}

		// Context
		case "context.get": {
			return sessionManager.buildCurrentContinuitySnapshot();
		}

		// Approval
		case "approval.list": {
			return { approvals: sessionManager.pendingApprovals, pending: ctx.getUIContext()?.pendingApprovalCount ?? 0 };
		}
		case "approval.decide": {
			const p = params as
				| { approvalId?: string; decision?: "allow" | "deny"; scope?: string; persistRule?: boolean }
				| undefined;
			if (!p?.approvalId || !p?.decision) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "approval.decide requires approvalId and decision",
				});
			}
			const approval = sessionManager.pendingApprovals.find(item => item.approvalId === p.approvalId);
			if (!approval) {
				return createRpcError({
					reason: "APPROVAL_NOT_PENDING",
					category: "conflict",
					message: `Approval ${p.approvalId} is not pending`,
				});
			}
			const scope = parseApprovalScope(p.scope ?? "once");
			if (!scope || !approval.allowedScopes.includes(scope)) {
				return createRpcError({
					reason: "APPROVAL_SCOPE_NOT_ALLOWED",
					category: "validation",
					message: `Approval ${p.approvalId} does not allow scope ${p.scope ?? "once"}`,
					details: { allowedScopes: approval.allowedScopes },
				});
			}
			if (p.persistRule && (scope === "once" || !approval.policySnapshot.canPersistRule)) {
				return createRpcError({
					reason: "APPROVAL_SCOPE_NOT_ALLOWED",
					category: "validation",
					message: `Approval ${p.approvalId} cannot persist this decision`,
				});
			}
			let persistedRule: PermissionRule | undefined;
			if (p.persistRule) {
				if (scope === "once") throw new Error("Persisted approval scope invariant violated");
				const active = sessionManager.assertSession();
				persistedRule = await ctx.approvalRules.addRule({
					scope,
					context: approvalPolicyContext(activeSession),
					decision: p.decision,
					fingerprint: approval.fingerprint,
					toolName: approval.tool?.name,
					operationKind: approval.tool?.operationKind,
					riskCeiling: approval.risk.level === "critical" ? "high" : approval.risk.level,
					sourceApprovalId: approval.approvalId,
				});
				await sessionManager.emitCustom(active, "approval.rule.changed", {
					rule: persistedRule,
					action: "created",
					scope,
				});
			}
			const resolution = {
				resolved: true,
				approvalId: p.approvalId,
				decision: p.decision,
				scope,
				...(persistedRule ? { persistedRule } : {}),
			};
			await sessionManager.resolveApproval(
				sessionManager.assertSession(),
				p.approvalId,
				p.decision,
				scope,
				Boolean(p.persistRule),
				receipt ? { ...receipt, result: resolution } : undefined,
			);
			ctx.getUIContext()?.resolveApproval(p.approvalId, { allowed: p.decision === "allow", scope });
			return resolution;
		}

		// Interaction
		case "interaction.list": {
			return {
				interactions: sessionManager.pendingInteractions,
				pending: ctx.getUIContext()?.pendingInteractionCount ?? 0,
			};
		}
		case "interaction.respond": {
			const p = params as
				| { sessionId?: string; leaseId?: string; interactionId?: string; response?: unknown }
				| undefined;
			if (!p?.interactionId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "interaction.respond requires interactionId",
				});
			}
			const interaction = sessionManager.pendingInteractions.find(item => item.interactionId === p.interactionId);
			if (interaction) {
				if (!p.sessionId || !p.leaseId)
					return invalidParamsError("Session Interaction response requires sessionId and leaseId", "leaseId");
				const active = sessionManager.assertLease(p.sessionId, p.leaseId, true);
				const response = validateInteractionResponse(interaction, p.response);
				await sessionManager.resolveInteraction(active, p.interactionId, response);
				ctx.getUIContext()?.resolveInteraction(p.interactionId, response);
				return { resolved: true, interactionId: p.interactionId, interaction };
			}
			const authInteraction = ctx.auth.respond(p.interactionId, p.response);
			if (!authInteraction) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "conflict",
					message: `Interaction ${p.interactionId} is not pending`,
				});
			}
			return { resolved: true, interactionId: p.interactionId, interaction: authInteraction };
		}
		case "interaction.cancel": {
			const p = params as
				| { sessionId?: string; leaseId?: string; interactionId?: string; reason?: string }
				| undefined;
			if (!p?.interactionId) return invalidParamsError("interaction.cancel requires interactionId", "interactionId");
			const interaction = sessionManager.pendingInteractions.find(item => item.interactionId === p.interactionId);
			if (interaction) {
				if (!p.sessionId || !p.leaseId)
					return invalidParamsError("Session Interaction cancellation requires sessionId and leaseId", "leaseId");
				const active = sessionManager.assertLease(p.sessionId, p.leaseId, true);
				const cancelled = await sessionManager.cancelInteraction(
					active,
					p.interactionId,
					p.reason ?? "client_cancelled",
				);
				ctx.getUIContext()?.cancelInteraction(p.interactionId);
				return { cancelled: true, interaction: cancelled };
			}
			const cancelled = ctx.auth.cancelInteraction(p.interactionId, p.reason ?? "client_cancelled");
			return cancelled
				? { cancelled: true, interaction: cancelled }
				: createRpcError({
						reason: "SESSION_STATE_CONFLICT",
						category: "conflict",
						message: `Interaction ${p.interactionId} is not pending`,
					});
		}

		// Host Tools
		case "host.capabilities.update": {
			const p = parseHostCapabilities(params);
			if (isRpcError(p)) return p;
			const expectedRevision = p.revision;
			if (expectedRevision !== undefined && expectedRevision !== state.capabilitiesRevision) {
				return createRpcError({
					reason: "SESSION_STATE_CONFLICT",
					category: "conflict",
					message: `Host capability revision conflict: expected ${expectedRevision}, current ${state.capabilitiesRevision}`,
					details: { expectedRevision, currentRevision: state.capabilitiesRevision },
				});
			}
			if (p.tools) {
				const agentTools = ctx.hostToolBridge.setTools(p.tools);
				if (session) await session.refreshRpcHostTools(agentTools);
			}
			if (p.uriSchemes) ctx.hostToolBridge.setUriSchemes(p.uriSchemes);
			state.capabilitiesRevision++;
			state.capabilities = buildServerCapabilities({
				...state.capabilities,
				"host.tools":
					ctx.hostToolBridge.registeredTools.length > 0
						? { version: 1, status: "available", details: { tools: ctx.hostToolBridge.registeredTools } }
						: unavailableCapability("HOST_TOOLS_EMPTY", "No Host Tools are registered"),
				"host.uri":
					ctx.hostToolBridge.registeredSchemes.length > 0
						? { version: 1, status: "available", details: { schemes: ctx.hostToolBridge.registeredSchemes } }
						: unavailableCapability("HOST_URI_EMPTY", "No Host URI schemes are registered"),
				// setup/apply/recovery 随真实端口与 ensureLoaded 状态，禁止 true override
				"worktree.lifecycle": resolveWorktreeCapability(ctx.worktrees, ctx.setupHost),
			});
			await sendNotification(ctx.output, "server.capabilities.changed", {
				revision: state.capabilitiesRevision,
				changed: ["host.tools", "host.uri", "worktree.lifecycle"],
				capabilities: state.capabilities,
			});
			return {
				revision: state.capabilitiesRevision,
				tools: ctx.hostToolBridge.registeredTools,
				uriSchemes: ctx.hostToolBridge.registeredSchemes,
			};
		}

		// Subagent / Evidence / Context extras
		case "subagent.list":
			return { subagents: ctx.subagents.list() };
		case "subagent.messages.list": {
			const p = params as { subagentId?: string; cursor?: string; limit?: number } | undefined;
			if (!p?.subagentId) return invalidParamsError("subagent.messages.list requires subagentId", "subagentId");
			try {
				return await ctx.subagents.messages({ subagentId: p.subagentId, cursor: p.cursor, limit: p.limit });
			} catch (error: unknown) {
				return createRpcError({
					reason: "RESOURCE_NOT_FOUND",
					category: "not_found",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "subagent.send": {
			const p = params as { subagentId?: string; message?: string } | undefined;
			if (!p?.subagentId || !p.message?.trim())
				return invalidParamsError("subagent.send requires subagentId and non-empty message", "message");
			try {
				return ctx.subagents.send(p.subagentId, p.message);
			} catch (error: unknown) {
				return createRpcError({
					reason: "SESSION_STATE_CONFLICT",
					category: "conflict",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "subagent.abort": {
			const p = params as { subagentId?: string; reason?: string } | undefined;
			if (!p?.subagentId) return invalidParamsError("subagent.abort requires subagentId", "subagentId");
			try {
				return await ctx.subagents.abort(p.subagentId, p.reason);
			} catch (error: unknown) {
				return createRpcError({
					reason: "SESSION_STATE_CONFLICT",
					category: "conflict",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "evidence.list": {
			const p = params as
				| { runId?: string; kinds?: string[]; verdicts?: string[]; limit?: number; cursor?: string }
				| undefined;
			const ledger = sessionManager.currentEvidence;
			if (!ledger)
				return createRpcError({
					reason: "SESSION_NOT_FOUND",
					category: "not_found",
					message: "No Session evidence ledger is open",
				});
			const offset = decodePageCursor(p?.cursor);
			const result = ledger.list({
				runId: p?.runId,
				kinds: p?.kinds as EvidenceKind[] | undefined,
				verdicts: p?.verdicts as EvidenceVerdict[] | undefined,
				limit: p?.limit,
				offset,
			});
			const consumed = offset + result.evidence.length;
			return {
				evidence: result.evidence,
				total: result.total,
				nextCursor: consumed < result.total ? encodePageCursor(consumed) : null,
			};
		}
		case "evidence.get": {
			const p = params as { evidenceId?: string } | undefined;
			if (!p?.evidenceId) return invalidParamsError("evidence.get requires evidenceId", "evidenceId");
			const evidence = sessionManager.currentEvidence?.get(p.evidenceId);
			return (
				evidence ??
				createRpcError({
					reason: "RESOURCE_NOT_FOUND",
					category: "not_found",
					message: `Evidence not found: ${p.evidenceId}`,
				})
			);
		}
		case "context.digests.list": {
			const p = params as { cursor?: string; limit?: number } | undefined;
			const all = listTurnDigests(activeSession.sessionManager.getEntries()).reverse();
			const offset = decodePageCursor(p?.cursor);
			const limit = clampPageSize(p?.limit);
			const page = all
				.slice(offset, offset + limit)
				.map(digest => projectTurnDigest(digest, activeSession.sessionManager.getCwd()));
			return {
				digests: page,
				nextCursor: offset + page.length < all.length ? encodePageCursor(offset + page.length) : null,
			};
		}
		case "context.checkpoints.list": {
			const p = params as { cursor?: string; limit?: number } | undefined;
			const all = collectContextCheckpoints(activeSession.sessionManager.getEntries()).reverse();
			const offset = decodePageCursor(p?.cursor);
			const limit = clampPageSize(p?.limit);
			const page = all.slice(offset, offset + limit).map(item => projectCheckpoint(item.checkpoint));
			return {
				checkpoints: page,
				nextCursor: offset + page.length < all.length ? encodePageCursor(offset + page.length) : null,
			};
		}
		case "context.compact": {
			const p = params as { instructions?: string; strategy?: string } | undefined;
			const mode = parseCompactMode(p?.strategy);
			return await sessionManager.startContextMaintenance(sessionManager.assertSession(), {
				instructions: p?.instructions,
				mode,
			});
		}
		case "context.maintenance.cancel": {
			const p = params as { maintenanceId?: string } | undefined;
			if (!p?.maintenanceId)
				return invalidParamsError("context.maintenance.cancel requires maintenanceId", "maintenanceId");
			return await sessionManager.cancelContextMaintenance(sessionManager.assertSession(), p.maintenanceId);
		}

		// Session extras
		case "session.stats":
			return activeSession.getSessionStats();
		case "usage.stats": {
			const p = params as { days?: number; sessionLimit?: number } | undefined;
			return await buildUsageAnalytics({
				...(p?.days !== undefined ? { days: p.days } : {}),
				...(p?.sessionLimit !== undefined ? { sessionLimit: p.sessionLimit } : {}),
				...(session
					? {
							activeSession: {
								sessionId: sessionManager.currentSessionId!,
								title: activeSession.sessionName,
								cwd: activeSession.sessionManager.getCwd(),
								messages: activeSession.messages,
							},
						}
					: {}),
			});
		}
		case "session.rename": {
			const p = params as { name?: string } | undefined;
			if (!p?.name?.trim()) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.rename requires non-empty name",
				});
			}
			return await sessionManager.rename(sessionManager.assertSession(), p.name);
		}
		case "session.branch": {
			const p = params as { entryId?: string; title?: string } | undefined;
			if (!p?.entryId) return invalidParamsError("session.branch requires entryId", "entryId");
			return await sessionManager.branch(sessionManager.assertSession(), p.entryId, p.title);
		}
		case "session.handoff": {
			const p = params as { instructions?: string } | undefined;
			const result = await sessionManager.handoff(sessionManager.assertSession(), p?.instructions);
			const artifact = await ctx.artifacts.saveText(result.document, {
				mediaType: "text/markdown",
				fileName: "handoff.md",
				kind: "rpc-v2-handoff",
			});
			await sessionManager.replaceArtifacts(ctx.artifacts.entries());
			return { ...result, document: undefined, artifact };
		}
		case "session.export": {
			const p = params as { format?: "html" | "jsonl"; destination?: "artifact" | "hostPath" } | undefined;
			if (p?.format !== "html" && p?.format !== "jsonl")
				return invalidParamsError("session.export requires format html or jsonl", "format");
			if (p.destination !== undefined && p.destination !== "artifact") {
				return createRpcError({
					reason: "HOST_CAPABILITY_UNAVAILABLE",
					category: "conflict",
					message: "session.export hostPath requires a host-mediated approved destination",
				});
			}
			let exportText: string;
			let fileName: string;
			if (p.format === "html") {
				const exportPath = await activeSession.exportToHtml();
				exportText = await Bun.file(exportPath).text();
				fileName = path.basename(exportPath);
			} else {
				const sessionFile = activeSession.sessionFile;
				if (!sessionFile)
					return createRpcError({
						reason: "SESSION_STATE_CONFLICT",
						category: "conflict",
						message: "Session is not persisted",
					});
				exportText = await Bun.file(sessionFile).text();
				fileName = path.basename(sessionFile);
			}
			const artifact = await ctx.artifacts.saveText(exportText, {
				mediaType: inferArtifactMediaType(fileName),
				fileName,
				kind: `rpc-v2-export-${p.format}`,
			});
			await sessionManager.replaceArtifacts(ctx.artifacts.entries());
			return { artifact };
		}
		case "session.recover": {
			const p = params as { sessionId?: string; leaseId?: string; strategy?: string } | undefined;
			const strategy = p?.strategy ?? "continue";
			if (strategy !== "continue" && strategy !== "mark_aborted" && strategy !== "read_only") {
				return invalidParamsError(
					"session.recover strategy must be continue, mark_aborted, or read_only",
					"strategy",
				);
			}
			if (!p?.sessionId || !p.leaseId)
				return invalidParamsError("session.recover requires sessionId and leaseId", "leaseId");
			const active = sessionManager.assertLease(p.sessionId, p.leaseId, false);
			if (active.lease?.access !== "read_write") {
				return createRpcError({
					reason: "SESSION_STATE_CONFLICT",
					category: "conflict",
					message: "Session recovery requires a read_write lease",
					sessionId: p.sessionId,
				});
			}
			return await sessionManager.recover(active, strategy);
		}

		case "artifact.read": {
			const p = params as { artifactId?: string; offset?: number; limit?: number } | undefined;
			if (!p?.artifactId) return invalidParamsError("artifact.read requires artifactId", "artifactId");
			return await ctx.artifacts.read({
				artifactId: p.artifactId,
				offset: p.offset ?? 0,
				limit: p.limit ?? ctx.state.limits.maxInlineTextBytes,
				maxChunkBytes: Math.min(ctx.state.limits.maxInlineTextBytes, ctx.state.limits.maxFrameBytes / 2),
			});
		}

		// Resource upload
		case "resource.upload.begin": {
			const p = params as
				| { mediaType?: string; fileName?: string; byteLength?: number; sha256?: string }
				| undefined;
			if (!p?.mediaType || typeof p.byteLength !== "number" || !p.sha256) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.upload.begin requires mediaType, byteLength, sha256",
				});
			}
			return await ctx.resources.begin({
				sessionId: sessionManager.assertSession().sessionId,
				mediaType: p.mediaType,
				fileName: p.fileName,
				byteLength: p.byteLength,
				sha256: p.sha256,
			});
		}
		case "resource.upload.chunk": {
			const p = params as
				| { uploadId?: string; offset?: number; dataBase64?: string; chunkSha256?: string }
				| undefined;
			if (!p?.uploadId || p?.offset === undefined || !p?.dataBase64) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.upload.chunk requires uploadId, offset, dataBase64",
				});
			}
			return await ctx.resources.chunk({
				uploadId: p.uploadId as UploadId,
				offset: p.offset,
				dataBase64: p.dataBase64,
				chunkSha256: p.chunkSha256,
			});
		}
		case "resource.upload.commit": {
			const p = params as { uploadId?: string; sha256?: string } | undefined;
			if (!p?.uploadId || !p?.sha256) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.upload.commit requires uploadId, sha256",
				});
			}
			const resource = await ctx.resources.commit({ uploadId: p.uploadId as UploadId, sha256: p.sha256 });
			await sessionManager.replaceResources(ctx.resources.entries);
			return resource;
		}
		case "resource.registerHostUri": {
			const p = params as
				| {
						uri?: string;
						access?: "read" | "read_write";
						metadata?: { mediaType?: string; fileName?: string; byteLength?: number; sha256?: string };
				  }
				| undefined;
			if (!p?.uri) return invalidParamsError("resource.registerHostUri requires uri", "uri");
			const access = p.access ?? "read";
			let scheme: string;
			try {
				scheme = new URL(p.uri).protocol.slice(0, -1).toLowerCase();
			} catch {
				return invalidParamsError("resource.registerHostUri requires an absolute URI", "uri");
			}
			if (!ctx.hostToolBridge.supportsUriScheme(scheme, access === "read_write" ? "write" : "read")) {
				return createRpcError({
					reason: "HOST_CAPABILITY_UNAVAILABLE",
					category: "conflict",
					message: `Host URI scheme ${scheme} is not registered for ${access} access`,
					details: { scheme, access },
				});
			}
			const resource = await ctx.resources.registerHostUri({
				sessionId: sessionManager.assertSession().sessionId,
				uri: p.uri,
				metadata: p.metadata,
				allowedSchemes: ctx.hostToolBridge.registeredSchemes,
			});
			await sessionManager.replaceResources(ctx.resources.entries);
			return resource;
		}
		case "resource.release": {
			const p = params as { resourceId?: string } | undefined;
			if (!p?.resourceId)
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.release requires resourceId",
				});
			const active = sessionManager.assertSession();
			if (await sessionManager.deferResourceRelease(active, p.resourceId)) {
				return { released: false, deferred: true };
			}
			const released = await ctx.resources.release(p.resourceId, active.sessionId);
			if (released) await sessionManager.replaceResources(ctx.resources.entries);
			return released
				? { released: true }
				: createRpcError({
						reason: "RESOURCE_NOT_FOUND",
						category: "not_found",
						message: `Resource ${p.resourceId} not found`,
					});
		}

		// Approval rules
		case "approval.rules.list": {
			const p = params as
				| { scope?: string; sessionId?: string; cwd?: string; includeInherited?: boolean }
				| undefined;
			const scope = parseApprovalPolicyScope(p?.scope ?? "session");
			if (!scope)
				return invalidParamsError("approval.rules.list scope must be session, workspace, or global", "scope");
			await ctx.approvalRules.refresh();
			return ctx.approvalRules.getPolicy(
				scope,
				approvalPolicyContextFromParams(sessionManager, p),
				p?.includeInherited ?? true,
			);
		}
		case "approval.rules.revoke": {
			const p = params as
				| { scope?: string; sessionId?: string; cwd?: string; ruleId?: string; expectedRevision?: number }
				| undefined;
			if (!p?.ruleId)
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "approval.rules.revoke requires ruleId",
				});
			const scope = parseApprovalPolicyScope(p.scope ?? "session");
			if (!scope)
				return invalidParamsError("approval.rules.revoke scope must be session, workspace, or global", "scope");
			const context = approvalPolicyContextFromParams(sessionManager, p);
			const revoked = await ctx.approvalRules.revoke({
				scope,
				context,
				ruleId: p.ruleId,
				expectedRevision: p.expectedRevision,
			});
			return revoked
				? { revoked: true, policy: ctx.approvalRules.getPolicy(scope, context, true) }
				: createRpcError({
						reason: "INVALID_PARAMS",
						category: "conflict",
						message: `Rule ${p.ruleId} not found or immutable`,
					});
		}
		case "approval.policy.get": {
			const p = params as { scope?: string; sessionId?: string; cwd?: string } | undefined;
			const scope = parseApprovalPolicyScope(p?.scope ?? "session");
			if (!scope)
				return invalidParamsError("approval.policy.get scope must be session, workspace, or global", "scope");
			await ctx.approvalRules.refresh();
			return ctx.approvalRules.getPolicy(scope, approvalPolicyContextFromParams(sessionManager, p), true);
		}
		case "approval.policy.update": {
			const p = params as
				| { scope?: string; sessionId?: string; cwd?: string; patch?: unknown; expectedRevision?: number }
				| undefined;
			const scope = parseApprovalPolicyScope(p?.scope ?? "session");
			if (!scope)
				return invalidParamsError("approval.policy.update scope must be session, workspace, or global", "scope");
			if (!isRecord(p?.patch)) return invalidParamsError("approval.policy.update requires a typed patch", "patch");
			const defaults = isRecord(p.patch.defaults) ? p.patch.defaults : p.patch;
			return await ctx.approvalRules.updateDefaults({
				scope,
				context: approvalPolicyContextFromParams(sessionManager, p),
				patch: defaults,
				expectedRevision: p.expectedRevision,
			});
		}

		// Integration catalog
		case "integration.list": {
			const p = params as { kinds?: string[]; statuses?: string[]; cursor?: string; limit?: number } | undefined;
			try {
				return ctx.integrations.list(p);
			} catch (error: unknown) {
				return invalidParamsError(sanitizeRpcError(error, { maxChars: 500 }), "cursor");
			}
		}
		case "integration.get": {
			const p = params as { integrationId?: string } | undefined;
			if (!p?.integrationId) return invalidParamsError("integration.get requires integrationId", "integrationId");
			return (
				ctx.integrations.get(p.integrationId) ??
				createRpcError({
					reason: "INTEGRATION_UNAVAILABLE",
					category: "not_found",
					message: `Integration not found: ${p.integrationId}`,
				})
			);
		}
		case "integration.setEnabled": {
			const p = params as { integrationId?: string; enabled?: boolean; expectedRevision?: number } | undefined;
			if (!p?.integrationId || typeof p.enabled !== "boolean")
				return invalidParamsError("integration.setEnabled requires integrationId and enabled", "enabled");
			try {
				return await ctx.integrations.setEnabled({
					integrationId: p.integrationId,
					enabled: p.enabled,
					expectedRevision: p.expectedRevision,
				});
			} catch (error: unknown) {
				if (error instanceof IntegrationRevisionError) throw error;
				return createRpcError({
					reason: "INTEGRATION_UNAVAILABLE",
					category: "conflict",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "integration.refresh": {
			const p = params as { integrationId?: string } | undefined;
			try {
				return await ctx.integrations.refresh(p?.integrationId);
			} catch (error: unknown) {
				return createRpcError({
					reason: "INTEGRATION_UNAVAILABLE",
					category: "not_found",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}

		// Stream / Diagnostics / Misc
		case "stream.configure": {
			const p = params as
				| { thinkingDeltas?: boolean; subagents?: string; maxTransientEventsPerSecond?: number }
				| undefined;
			const policy = {
				thinkingDeltas: p?.thinkingDeltas ?? false,
				subagents: parseSubagentStreamLevel(p?.subagents),
				maxTransientEventsPerSecond: p?.maxTransientEventsPerSecond ?? 200,
			} satisfies StreamPolicy;
			ctx.subagents.configure(policy.subagents ?? "progress");
			return await sessionManager.configureStream(policy);
		}
		case "server.getDiagnostics": {
			const enabled: string[] = [];
			const unavailable: string[] = [];
			for (const [name, capability] of Object.entries(state.capabilities)) {
				if (capability.status === "unavailable") unavailable.push(name);
				else enabled.push(name);
			}
			const integrations = ctx.integrations.list({ limit: 100 }).integrations.map(integration => ({
				integrationId: integration.integrationId,
				kind: integration.kind,
				health: integration.health.status,
				enabled: integration.enabled,
				...(integration.health.reasonCode ? { lastErrorReason: integration.health.reasonCode } : {}),
			}));
			logger.info("RPC v2 strict diagnostics exported", {
				runtimeId: state.runtimeId,
				sessionId: sessionManager.currentSessionId,
			});
			return {
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				redaction: { profile: "strict", version: 1, removedFieldCount: 0 },
				runtime: {
					version: VERSION,
					protocolVersion: PROTOCOL_VERSION,
					uptimeMs: Date.now() - state.startedAt,
					...(state.shutdownRequested ? { exitState: "shutdown_requested" } : {}),
				},
				capabilities: {
					revision: state.capabilitiesRevision,
					enabled,
					unavailable,
				},
				sessions: {
					activeCount: sessionManager.currentSessionId ? 1 : 0,
					lockedCount: 0,
					lastSequences: sessionManager.currentSessionId
						? { [sessionManager.currentSessionId]: sessionManager.currentLastSequence }
						: {},
				},
				output: ctx.outputDiagnostics(),
				integrations,
				recentErrors: state.recentErrors.slice(-20),
			};
		}
		case "auth.provider.list": {
			const catalog = sessionManager.runtimeCatalog;
			const providers = ctx.auth.listProviders().map(provider => ({ ...provider, custom: false }));
			if (catalog) {
				for (const configuration of await catalog.listCustomProviders()) {
					const details = {
						baseUrl: configuration.baseUrl,
						...(configuration.api ? { api: configuration.api } : {}),
						auth: configuration.auth,
						...(configuration.discoveryType ? { discoveryType: configuration.discoveryType } : {}),
						modelCount: configuration.modelCount,
						custom: true,
					};
					const existing = providers.find(provider => provider.providerId === configuration.providerId);
					if (existing) Object.assign(existing, details);
					else {
						providers.push({
							providerId: configuration.providerId,
							name: configuration.providerId,
							available: true,
							authenticated: catalog.hasProviderAuth(configuration.providerId),
							...details,
						});
					}
				}
			}
			return { providers, logins: ctx.auth.listLogins() };
		}
		case "auth.login.start": {
			const p = params as { providerId?: string } | undefined;
			if (!p?.providerId) return invalidParamsError("auth.login.start requires providerId", "providerId");
			const provider = ctx.auth.listProviders().find(item => item.providerId === p.providerId);
			if (!provider?.available)
				return createRpcError({
					reason: "PROVIDER_AUTH_REQUIRED",
					category: "auth",
					message: `Provider login is unavailable: ${p.providerId}`,
				});
			return ctx.auth.start(p.providerId);
		}
		case "auth.login.cancel": {
			const p = params as { loginId?: string } | undefined;
			if (!p?.loginId) return invalidParamsError("auth.login.cancel requires loginId", "loginId");
			try {
				return ctx.auth.cancel(p.loginId);
			} catch (error: unknown) {
				return createRpcError({
					reason: "RESOURCE_NOT_FOUND",
					category: "not_found",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "provider.config.create": {
			const catalog = sessionManager.runtimeCatalog;
			if (!catalog) return invalidParamsError("Runtime model catalog is unavailable");
			const p = params as
				| {
						providerId?: string;
						baseUrl?: string;
						api?: Api;
						auth?: RpcV2CustomProviderInput["auth"];
						discovery?: RpcV2CustomProviderInput["discovery"];
						apiKey?: string;
				  }
				| undefined;
			if (!p?.providerId?.trim())
				return invalidParamsError("provider.config.create requires providerId", "providerId");
			if (!p.baseUrl?.trim()) return invalidParamsError("provider.config.create requires baseUrl", "baseUrl");
			if (!p.auth) return invalidParamsError("provider.config.create requires auth", "auth");
			try {
				return await catalog.createCustomProvider({
					providerId: p.providerId,
					baseUrl: p.baseUrl,
					...(p.api ? { api: p.api } : {}),
					auth: p.auth,
					...(p.discovery ? { discovery: p.discovery } : {}),
					...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
				});
			} catch (error: unknown) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "provider.model.add": {
			const catalog = sessionManager.runtimeCatalog;
			if (!catalog) return invalidParamsError("Runtime model catalog is unavailable");
			const p = params as
				| {
						providerId?: string;
						modelId?: string;
						displayName?: string;
						api?: Api;
						contextWindow?: number;
						maxTokens?: number;
						reasoning?: boolean;
						supportsImage?: boolean;
						supportsTools?: boolean;
				  }
				| undefined;
			if (!p?.providerId?.trim()) return invalidParamsError("provider.model.add requires providerId", "providerId");
			if (!p.modelId?.trim()) return invalidParamsError("provider.model.add requires modelId", "modelId");
			const input: RpcV2CustomModelInput = {
				providerId: p.providerId,
				modelId: p.modelId,
				...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
				...(p.api ? { api: p.api } : {}),
				...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
				...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
				...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
				...(p.supportsImage !== undefined ? { supportsImage: p.supportsImage } : {}),
				...(p.supportsTools !== undefined ? { supportsTools: p.supportsTools } : {}),
			};
			try {
				return await catalog.addCustomModel(input);
			} catch (error: unknown) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: sanitizeRpcError(error, { maxChars: 500 }),
				});
			}
		}
		case "command.list": {
			const { commands, revision } = await buildCommandCatalog(activeSession);
			const knownRevision = (params as { knownRevision?: number } | undefined)?.knownRevision;
			return knownRevision === revision ? { unchanged: true, revision } : { unchanged: false, commands, revision };
		}

		// Worktree lifecycle — params 已由 validateRpcV2Params 按冻结 schema 校验；
		// mutation 幂等仅由 WorktreeLifecycleService canonical receipt 裁决。
		case "worktree.create": {
			const p = params as CreateManagedWorktreeParams;
			try {
				return await ctx.worktrees.create(p);
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.get": {
			const p = params as { worktreeId: string };
			try {
				return { worktree: await ctx.worktrees.get(p.worktreeId) };
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.list": {
			const p = (params ?? {}) as WorktreeListFilter;
			try {
				const filter: WorktreeListFilter = {};
				if (p.state !== undefined) filter.state = p.state;
				if (p.states !== undefined) filter.states = p.states;
				if (p.repoId !== undefined) filter.repoId = p.repoId;
				if (p.environmentId !== undefined) filter.environmentId = p.environmentId;
				const worktrees = await callWorktreeList(ctx.worktrees, filter);
				return { worktrees };
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.setup.start": {
			const p = params as WorktreeSetupStartParams;
			try {
				return await ctx.worktrees.setupStart(p);
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.setup.cancel": {
			const p = params as WorktreeSetupCancelParams;
			try {
				return await ctx.worktrees.setupCancel(p);
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.apply.prepare": {
			const p = params as WorktreeApplyPrepareParams;
			try {
				const plan = await ctx.worktrees.prepare(p);
				return { plan };
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.apply": {
			const p = params as WorktreeApplyParams;
			try {
				return await ctx.worktrees.apply(p);
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}
		case "worktree.archive": {
			const p = params as WorktreeArchiveParams;
			try {
				return await ctx.worktrees.archive(p);
			} catch (error: unknown) {
				return mapWorktreeError(error);
			}
		}

		default:
			return createRpcError({
				reason: "CAPABILITY_UNAVAILABLE",
				category: "conflict",
				message: `Method ${method} is known but not implemented by this San build`,
				details: { method },
			});
	}
}

function idempotencyConflict(key: string): RpcErrorBody {
	return createRpcError({
		reason: "IDEMPOTENCY_CONFLICT",
		category: "conflict",
		message: `Idempotency key ${key} was already used with different parameters`,
		details: { idempotencyKey: key },
	});
}

/**
 * 将 service capabilityDescriptor 映射为 ServerCapabilities 条目。
 * recoveryReady 只来自 service ensureLoaded/recovery，禁止 true override 提前宣称；
 * applyAvailable 来自真实 applyPort.ready；setupAvailable 仅当 setupHost.ready（工具+recovery）。
 */
export function resolveWorktreeCapability(
	worktrees: WorktreeLifecycleService,
	setupHost?: Pick<DesktopActionSetupHost, "ready" | "hasRequiredTools">,
): CapabilityDescriptor {
	const raw = worktrees.capabilityDescriptor();
	const recoveryReady = raw.recoveryReady === true;
	const recoveryStatus = !recoveryReady ? "unavailable" : raw.status === "degraded" ? "degraded" : "available";
	// setupHost 优先：ready 已要求 recovery+tools；无 host 时回退 service setupPort.ready
	const setupAvailable = recoveryReady && (setupHost ? setupHost.ready === true : raw.setupAvailable === true);
	const applyAvailable = recoveryReady && raw.applyAvailable === true;
	const details: WorktreeLifecycleCapabilityDetails = {
		name: "worktree.lifecycle",
		version: 1,
		methods: [...raw.methods],
		setupAvailable,
		applyAvailable,
		recoveryReady,
		limits: raw.limits,
		status: recoveryStatus,
		...(raw.unresolvedUnknownOperations?.length
			? {
					unresolvedUnknownOperations: raw.unresolvedUnknownOperations.map(operation => ({
						...operation,
					})),
				}
			: {}),
	};
	if (!recoveryReady) {
		return {
			version: 1,
			status: "unavailable",
			reasonCode: "WORKTREE_SERVICE_NOT_READY",
			message: "Managed worktree lifecycle service is not ready (durable recovery pending)",
			details: details as unknown as Record<string, unknown>,
		};
	}
	if (recoveryStatus === "degraded") {
		return {
			version: 1,
			status: "degraded",
			reasonCode: "WORKTREE_RECOVERY_DEGRADED",
			message: "Managed worktree recovery has unresolved operation outcomes",
			details: details as unknown as Record<string, unknown>,
		};
	}
	return {
		version: 1,
		status: "available",
		details: details as unknown as Record<string, unknown>,
	};
}

async function callWorktreeList(service: WorktreeLifecycleService, filter: WorktreeListFilter): Promise<unknown> {
	const list = service.list.bind(service) as (filter?: WorktreeListFilter) => Promise<unknown>;
	if (
		filter.state === undefined &&
		filter.states === undefined &&
		filter.repoId === undefined &&
		filter.environmentId === undefined
	) {
		return list();
	}
	return list(filter);
}

function mapWorktreeError(error: unknown): RpcErrorBody {
	if (!(error instanceof WorktreeError)) {
		return createRpcError({
			reason: "INTERNAL_ERROR",
			category: "internal",
			message: sanitizeRpcError(error, { maxChars: 500 }),
		});
	}
	const details = error.details ? { ...error.details } : undefined;
	switch (error.code) {
		case "INVALID_PARAMS":
			return createRpcError({
				reason: "INVALID_PARAMS",
				category: "validation",
				message: error.message,
				...(details ? { details } : {}),
			});
		case "NOT_FOUND":
			return createRpcError({
				reason: "RESOURCE_NOT_FOUND",
				category: "not_found",
				message: error.message,
				...(details ? { details } : {}),
			});
		case "CONFLICT":
		case "PRECONDITION_FAILED":
			return createRpcError({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: error.message,
				...(details ? { details } : {}),
			});
		case "IDEMPOTENCY_CONFLICT":
			return createRpcError({
				reason: "IDEMPOTENCY_CONFLICT",
				category: "conflict",
				message: error.message,
				...(details ? { details } : {}),
			});
		case "OUTCOME_UNKNOWN":
			return createRpcError({
				reason: "SESSION_STATE_CONFLICT",
				category: "conflict",
				message: error.message,
				retryable: false,
				details: { ...(details ?? {}), idempotencyState: "outcome_unknown" },
				suggestedActions: ["Call worktree.get or worktree.list to reconcile before retrying with a new key"],
			});
		case "CAPABILITY_UNAVAILABLE":
			return createRpcError({
				reason: "CAPABILITY_UNAVAILABLE",
				category: "conflict",
				message: error.message,
				...(details ? { details } : {}),
			});
		default:
			return createRpcError({
				reason: "INTERNAL_ERROR",
				category: "internal",
				message: error.message,
				...(details ? { details } : {}),
			});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcError(result: unknown): result is RpcErrorBody {
	return typeof result === "object" && result !== null && "code" in result && "message" in result;
}

// ============================================================================
// Main entry
// ============================================================================

export async function runRpcV2Mode(factory: RpcV2SessionFactory, _eventBus?: EventBus): Promise<void> {
	// stdout 是协议专用通道。先捕获原始方法，再安装 purity guard，避免 guard
	// 同时拦截 BackpressureWriter 自己的合法协议帧。
	process.env.PI_NOTIFICATIONS = "off";
	const rawWrite = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
	const rawOnce = process.stdout.once.bind(process.stdout) as (event: "drain", listener: () => void) => unknown;
	const protocolStream: RpcWritable = { write: rawWrite, once: rawOnce };
	const writer = new BackpressureWriter({ stream: protocolStream, maxQueueSize: 4096 });
	const purityGuard = installStdoutPurityGuard();
	const output = createOutput(writer);
	let asynchronousOutputError: Error | undefined;
	const enqueueOutput = (frame: object): void => {
		void output(frame).catch(error => {
			asynchronousOutputError = error instanceof Error ? error : new Error(String(error));
		});
	};

	const state: ServerState = {
		initialized: false,
		runtimeId: newRuntimeId(),
		startedAt: Date.now(),
		capabilitiesRevision: 1,
		capabilities: buildServerCapabilities(),
		limits: DEFAULT_LIMITS,
		shutdownRequested: false,
		shutdownMode: "graceful",
		recentErrors: [],
	};

	const sessionManager = new RpcV2SessionManager({ runtimeId: state.runtimeId, factory });
	sessionManager.setOutput((frame, options) => output(frame, options));
	const hostToolBridge = new RpcV2HostToolBridge(
		enqueueOutput,
		() => ({
			...(sessionManager.currentSessionId ? { sessionId: sessionManager.currentSessionId } : {}),
			...(sessionManager.currentAdapter?.currentRunId ? { runId: sessionManager.currentAdapter.currentRunId } : {}),
		}),
		{
			maxPayloadBytes: state.limits.maxInlineTextBytes,
			// 普通 Host tool/URI 默认绑定 dispatch 时 current revision；更新后新请求读新值。
			getCapabilityRevision: () => state.capabilitiesRevision,
		},
	);
	const resources = new ResourceUploadManager();
	sessionManager.setResourceReleaseHandler(async (resourceIds, sessionId) => {
		if (sessionManager.currentSessionId !== sessionId) {
			throw new Error(`Cannot release resources for inactive Session ${sessionId}`);
		}
		for (const resourceId of resourceIds) await resources.release(resourceId, sessionId);
		await sessionManager.replaceResources(resources.entries);
	});
	const artifacts = new RpcArtifactStore();
	const subagents = new RpcV2SubagentController();
	const integrations = new RpcV2IntegrationCatalog();
	const worktreeEmit = (event: WireWorktreeEventEnvelope | Record<string, unknown>): void => {
		// §6.7：notification method 为 worktree.created 等；禁止单一 worktree.lifecycle
		const method =
			event && typeof event === "object" && "method" in event && typeof event.method === "string"
				? event.method
				: null;
		const params = event && typeof event === "object" && "params" in event ? event.params : event;
		if (!method || !WORKTREE_EVENT_METHOD_SET.has(method)) {
			// core 过渡期若仍发旧 envelope，降级为 state.changed 而非假 lifecycle method
			enqueueOutput({
				jsonrpc: "2.0",
				method: "worktree.state.changed",
				params: params ?? event,
			});
			return;
		}
		enqueueOutput({
			jsonrpc: "2.0",
			method,
			params,
		});
	};
	// setupHost 先于 service：闭包捕获 uiContext/recoveryReady；service 以 setupPort 注入为唯一 mutation 出口
	// recoveryReady 初始 false，仅 ensureLoaded 成功后从 service.capabilityDescriptor 读取
	let worktreeRecoveryReady = false;
	let uiContext: RpcV2UIContext | undefined;
	const setupHost = new DesktopActionSetupHost({
		hostToolBridge,
		getUIContext: () => uiContext,
		resolveIdentity: () => {
			const sessionId = sessionManager.currentSessionId;
			const runId = sessionManager.currentAdapter?.currentRunId ?? sessionId;
			return {
				...(sessionId ? { sessionId } : {}),
				...(runId ? { runId } : {}),
			};
		},
		getCapabilityRevision: () => state.capabilitiesRevision,
		isRecoveryReady: () => worktreeRecoveryReady,
	});
	const worktrees = new WorktreeLifecycleService({
		stateDir: path.join(getAgentDir(), "rpc-v2", "worktrees"),
		// 不传 environmentId：与 ephemeral runtimeId 解耦。
		// 未 pin → 有 environment.json 则 adopt（兼容历史 rt_*）；空盘生成稳定 env_* 并落盘。
		emit: worktreeEmit,
		emitEvent: worktreeEmit,
		setupPort: setupHost,
	});
	await worktrees.ensureLoaded();
	worktreeRecoveryReady = worktrees.capabilityDescriptor().recoveryReady === true;
	// 不可 silent available：仅 recoveryReady 时发布 available；setup/apply 仅真实端口 ready
	state.capabilities = buildServerCapabilities({
		"worktree.lifecycle": resolveWorktreeCapability(worktrees, setupHost),
	});

	const approvalRules = new ApprovalRuleStore();
	await approvalRules.load();
	const runtimeCatalog = sessionManager.runtimeCatalog;
	if (!runtimeCatalog) throw new Error("RPC v2 requires a runtime model and provider catalog");
	const auth = new AuthLoginManager({ runtimeId: state.runtimeId, catalog: runtimeCatalog, output: enqueueOutput });

	// uiContext 已在上方声明，供 setupHost 审批绑定
	await sessionManager.setSessionBinder(async active => {
		uiContext?.rejectAll("RPC Session changed");
		await resources.bind({
			sessionId: active.sessionId,
			sessionFile: active.sessionFile,
			persistedResources: active.state.resources,
			readOnly: active.lease?.access === "read_only" || active.state.snapshot?.lifecycle === "recovering",
		});
		artifacts.bind({
			session: active.session,
			sessionId: active.sessionId,
			persistedArtifacts: active.state.artifacts,
		});
		uiContext = new RpcV2UIContext({
			output: enqueueOutput,
			sessionId: active.sessionId,
			runId: () => active.adapter.currentRunId,
			registerApproval: approval => sessionManager.registerApproval(active, approval),
			resolveRegisteredApproval: (approvalId, decision, scope) =>
				sessionManager.resolveApproval(active, approvalId, decision, scope, false).then(() => undefined),
			resolveApprovalPolicy: async params => {
				await approvalRules.refresh();
				return approvalRules.resolve({ ...params, context: approvalPolicyContext(active.session) });
			},
			registerInteraction: interaction => sessionManager.registerInteraction(active, interaction),
		});
		active.handle.setToolUIContext?.(uiContext, true);
		await active.session.refreshRpcHostTools(hostToolBridge.agentTools);
		subagents.bind(active.handle.eventBus, (type, data, durability) => {
			sessionManager.enqueueExternalEvent(type, data, durability);
		});
		integrations.bind(active.handle, (type, data) => sessionManager.enqueueExternalEvent(type, data, "durable"));
	});
	sessionManager.setSubagentSnapshotProvider(() => subagents.list());
	sessionManager.setCommandCatalogRevisionProvider(async session => (await buildCommandCatalog(session)).revision);

	const idempotency = new IdempotencyStore();
	const sessionCreateReceipts = new SessionCreateReceiptStore();

	const dispatchCtx: DispatchContext = {
		state,
		sessionManager,
		output,
		outputDiagnostics: () => ({
			pendingFrames: writer.pendingCount,
			queuedTransientFrames: writer.queuedTransientCount,
			coalescedFrames: writer.coalescedCount,
			blockedStdoutWrites: purityGuard.violations(),
			droppedTransientFrames: writer.droppedCoalescedCount,
			droppedTransientEvents: sessionManager.droppedTransientEventCount,
		}),
		getUIContext: () => uiContext,
		hostToolBridge,
		idempotency,
		sessionCreateReceipts,
		resources,
		artifacts,
		approvalRules,
		auth,
		subagents,
		integrations,
		worktrees,
		setupHost,
	};
	sessionManager.setContentResolver(async ({ session, sessionId, content }) => {
		const resolved = await resolveRunContent(dispatchCtx, session, sessionId, content);
		return resolved.resolved;
	});

	try {
		await sendNotification(output, "server.ready", {
			server: { name: SERVER_NAME, version: VERSION },
			protocol: { supported: [PROTOCOL_VERSION] },
			runtimeId: state.runtimeId,
			pid: process.pid,
		});

		const decoder = new TextDecoder("utf-8", { fatal: true });
		const pendingRequests = new Set<Promise<void>>();
		let mutationTail = Promise.resolve();
		const scheduleRequest = (request: ClientRequest): Promise<void> => {
			const execute = () => processClientRequest(dispatchCtx, output, request);
			// approval.decide / interaction.* 必须可在 setup.start 等 mutation 等待期间执行。
			const serializeMutation = shouldSerializeRpcMutation(request.method);
			const task = serializeMutation ? mutationTail.then(execute) : execute();
			// pendingRequests 观察原 task 的失败；mutationTail 只是排序 gate，失败后必须恢复，
			// 否则一个已回包的 mutation 会永久毒化后续所有 mutation。
			if (serializeMutation) mutationTail = task.catch(() => undefined);
			pendingRequests.add(task);
			void task.then(
				() => pendingRequests.delete(task),
				error => {
					pendingRequests.delete(task);
					asynchronousOutputError = error instanceof Error ? error : new Error(String(error));
				},
			);
			return task;
		};
		for await (const line of readLines(Bun.stdin.stream())) {
			if (state.shutdownRequested) break;
			if (asynchronousOutputError) throw asynchronousOutputError;
			if (line.byteLength === 0 || isWhitespaceOnly(line)) continue;
			if (line.byteLength > state.limits.maxFrameBytes) {
				const error = createRpcError({
					reason: "PAYLOAD_TOO_LARGE",
					category: "validation",
					message: `RPC frame exceeds ${state.limits.maxFrameBytes} bytes`,
				});
				recordRpcError(state, error);
				await sendError(output, null, error);
				break;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(decoder.decode(line));
			} catch (error: unknown) {
				const rpcError = createRpcError({
					reason: "PARSE_ERROR",
					category: "protocol",
					message: "Invalid UTF-8 or JSON in RPC frame",
				});
				recordRpcError(state, rpcError);
				await sendError(output, null, rpcError);
				logger.warn("RPC v2 frame parse failed", { error: sanitizeRpcError(error, { maxChars: 500 }) });
				break;
			}

			if (isClientResult(parsed)) {
				hostToolBridge.handleResult(parsed.id, parsed.result);
				continue;
			}
			if (isClientErrorResponse(parsed) && typeof parsed.id === "string") {
				hostToolBridge.handleError(parsed.id, parsed.error);
				continue;
			}
			if (isNotification(parsed)) {
				if (parsed.method === "host.tool.progress" && isRecord(parsed.params)) {
					const requestId = parsed.params.requestId;
					const message = parsed.params.message;
					if (typeof requestId === "string" && typeof message === "string") {
						hostToolBridge.handleProgress(requestId, message);
					}
				}
				continue;
			}
			if (!isValidClientRequest(parsed)) {
				const rpcError = createRpcError({
					reason: "INVALID_REQUEST",
					category: "protocol",
					message: "Expected a JSON-RPC 2.0 request with non-empty string id, method, and params",
				});
				recordRpcError(state, rpcError);
				await sendError(output, requestIdOrNull(parsed), rpcError);
				continue;
			}

			const request: ClientRequest = parsed;
			const task = scheduleRequest(request);
			if (request.method === "initialize" || request.method === "server.shutdown") await task;
			if (request.method === "server.shutdown" && state.shutdownRequested) break;
		}
		const settled = await Promise.allSettled([...pendingRequests]);
		const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected) throw rejected.reason;
		if (asynchronousOutputError) throw asynchronousOutputError;
	} finally {
		uiContext?.rejectAll("RPC client disconnected");
		hostToolBridge.close("RPC client disconnected");
		try {
			await auth.close();
			await resources.close();
			await sessionManager.shutdown({
				force: state.shutdownMode === "force",
				...(state.shutdownTimeoutMs !== undefined ? { timeoutMs: state.shutdownTimeoutMs } : {}),
			});
			await subagents.close();
			await writer.close();
		} finally {
			purityGuard.restore();
		}
	}
}

async function processClientRequest(ctx: DispatchContext, output: OutputFn, request: ClientRequest): Promise<void> {
	const { id, method, params } = request;
	try {
		const result = await dispatchMethod(ctx, method, params);
		if (isRpcError(result)) {
			recordRpcError(ctx.state, result);
			await sendError(output, id, result);
		} else if (method === "session.sync" && isSyncDispatchResult(result)) {
			await sendResult(output, id, result.result);
			await ctx.sessionManager.finishSync(result.subscriptionId);
		} else {
			await sendResult(output, id, result);
		}
	} catch (error: unknown) {
		const message = sanitizeRpcError(error, { cwd: ctx.sessionManager.currentSession?.sessionManager.getCwd() });
		logger.error("RPC v2 method failed", { method, error: message });
		const rpcError = internalError("RPC v2 request failed");
		recordRpcError(ctx.state, rpcError);
		await sendError(output, id, rpcError);
	}
}

function recordRpcError(state: ServerState, error: RpcErrorBody): void {
	if (!error.data) return;
	state.recentErrors.push({
		reason: error.data.reason,
		category: error.data.category,
		correlationId: error.data.correlationId,
		at: new Date().toISOString(),
	});
	if (state.recentErrors.length > 50) state.recentErrors.splice(0, state.recentErrors.length - 50);
}

function isWhitespaceOnly(line: Uint8Array): boolean {
	for (const byte of line) {
		if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
	}
	return true;
}

function isValidClientRequest(frame: unknown): frame is ClientRequest {
	if (!isClientRequest(frame)) return false;
	return frame.id.trim().length > 0 && frame.method.trim().length > 0;
}

function requestIdOrNull(frame: unknown): RpcId | null {
	if (typeof frame !== "object" || frame === null) return null;
	const id = (frame as Record<string, unknown>).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

function isSyncDispatchResult(value: unknown): value is { result: Record<string, unknown>; subscriptionId: string } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.subscriptionId === "string" && typeof record.result === "object" && record.result !== null;
}

function parseStreamPolicy(value: Record<string, unknown> | undefined): StreamPolicy | undefined {
	if (!value) return undefined;
	const policy: StreamPolicy = {};
	if (value.thinkingDeltas !== undefined) {
		if (typeof value.thinkingDeltas !== "boolean") invalidParamsField("stream.thinkingDeltas", "Expected a boolean");
		policy.thinkingDeltas = value.thinkingDeltas;
	}
	if (value.subagents !== undefined) policy.subagents = parseSubagentStreamLevel(value.subagents);
	if (value.maxTransientEventsPerSecond !== undefined) {
		if (
			typeof value.maxTransientEventsPerSecond !== "number" ||
			!Number.isSafeInteger(value.maxTransientEventsPerSecond) ||
			value.maxTransientEventsPerSecond < 1
		) {
			invalidParamsField("stream.maxTransientEventsPerSecond", "Expected a positive integer");
		}
		policy.maxTransientEventsPerSecond = value.maxTransientEventsPerSecond;
	}
	return policy;
}

function parseSubagentStreamLevel(value: unknown): "off" | "progress" | "events" {
	if (value === undefined) return "progress";
	if (value === "off" || value === "progress" || value === "events") return value;
	invalidParamsField("subagents", "Expected off, progress, or events");
}

function parseSettingsPatch(value: Record<string, unknown>): {
	executionProfile?: string;
	autoRetry?: { enabled?: boolean };
	contextMaintenance?: { mode?: "automatic" | "manual" | "disabled" };
} {
	const patch: {
		executionProfile?: string;
		autoRetry?: { enabled?: boolean };
		contextMaintenance?: { mode?: "automatic" | "manual" | "disabled" };
	} = {};
	if (value.executionProfile !== undefined) {
		if (typeof value.executionProfile !== "string" || !value.executionProfile.trim()) {
			invalidParamsField("patch.executionProfile", "Expected a non-empty profile ID");
		}
		if (!normalizeSanLoopMode(value.executionProfile)) {
			invalidParamsField("patch.executionProfile", `Unknown execution profile: ${value.executionProfile}`);
		}
		patch.executionProfile = value.executionProfile;
	}
	if (value.autoRetry !== undefined) {
		if (!isRecord(value.autoRetry)) invalidParamsField("patch.autoRetry", "Expected an object");
		if (value.autoRetry.enabled !== undefined && typeof value.autoRetry.enabled !== "boolean") {
			invalidParamsField("patch.autoRetry.enabled", "Expected a boolean");
		}
		patch.autoRetry = {
			...(typeof value.autoRetry.enabled === "boolean" ? { enabled: value.autoRetry.enabled } : {}),
		};
	}
	if (value.contextMaintenance !== undefined) {
		if (!isRecord(value.contextMaintenance)) invalidParamsField("patch.contextMaintenance", "Expected an object");
		const mode = value.contextMaintenance.mode;
		if (mode !== undefined && mode !== "automatic" && mode !== "manual" && mode !== "disabled") {
			invalidParamsField("patch.contextMaintenance.mode", "Expected automatic, manual, or disabled");
		}
		patch.contextMaintenance = { ...(mode ? { mode } : {}) };
	}
	const known = new Set(["executionProfile", "autoRetry", "contextMaintenance"]);
	for (const key of Object.keys(value))
		if (!known.has(key)) invalidParamsField(`patch.${key}`, "Unknown settings field");
	return patch;
}

function parseTodoPhases(value: unknown): TodoPhase[] {
	if (!Array.isArray(value)) invalidParamsField("phases", "Expected an array of Todo phases");
	return value.map((rawPhase, phaseIndex) => {
		if (
			!isRecord(rawPhase) ||
			typeof rawPhase.name !== "string" ||
			!rawPhase.name.trim() ||
			!Array.isArray(rawPhase.tasks)
		) {
			invalidParamsField(`phases[${phaseIndex}]`, "Expected name and tasks");
		}
		return {
			name: rawPhase.name.trim(),
			tasks: rawPhase.tasks.map((rawTask, taskIndex) => {
				if (!isRecord(rawTask) || typeof rawTask.content !== "string" || !rawTask.content.trim()) {
					invalidParamsField(`phases[${phaseIndex}].tasks[${taskIndex}]`, "Expected non-empty task content");
				}
				const status = parseTodoStatus(rawTask.status, `phases[${phaseIndex}].tasks[${taskIndex}].status`);
				return { content: rawTask.content.trim(), status };
			}),
		};
	});
}

function parseTodoStatus(value: unknown, field: string): TodoStatus {
	if (value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned") return value;
	invalidParamsField(field, "Expected pending, in_progress, completed, or abandoned");
}

function parseCompactMode(value: string | undefined): CompactMode | undefined {
	if (value === undefined || value === "default") return undefined;
	if (value === "soft" || value === "remote" || value === "snapcompact") return value;
	invalidParamsField("strategy", "Expected default, soft, remote, or snapcompact");
}

function projectTurnDigest(digest: TurnDigest, cwd: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		turnId: digest.turnId,
		sessionId: digest.sessionId,
		createdAt: digest.createdAt,
		...(digest.model ? { model: digest.model } : {}),
		userIntent: digest.userIntent,
		actionsTaken: [...digest.actionsTaken],
		decisions: [...digest.decisions],
		filesTouched: digest.filesTouched.map(file => ({ path: safeWorkspacePath(file.path, cwd), action: file.action })),
		toolEvidence: digest.toolEvidence.map(item => ({ tool: item.tool, summary: item.summary })),
		factsLearned: [...digest.factsLearned],
		openQuestions: [...digest.openQuestions],
		risks: [...digest.risks],
		nextSteps: [...digest.nextSteps],
		fallback: digest.fallback,
		...(digest.fallbackReason ? { fallbackReason: digest.fallbackReason } : {}),
	};
}

function projectCheckpoint(checkpoint: ContextCheckpoint): Record<string, unknown> {
	return {
		checkpointId: checkpoint.checkpointId,
		createdAt: checkpoint.createdAt,
		digestCount: checkpoint.digestCount,
		summary: structuredClone(checkpoint.summary),
		sourceRefs: [...(checkpoint.coveredSourceEntryRefs ?? checkpoint.entryRefs)],
		tokenEstimate: checkpoint.tokenEstimate,
		tokenBudget: checkpoint.tokenBudget,
		stability: checkpoint.stability,
	};
}

function safeWorkspacePath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) return filePath;
	const relative = path.relative(cwd, filePath);
	if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		return relative;
	return path.basename(filePath);
}

function stableCatalogRevision(value: readonly Record<string, unknown>[]): number {
	const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
	return Number.parseInt(digest.slice(0, 8), 16);
}

async function buildCommandCatalog(session: AgentSession): Promise<{
	commands: Record<string, unknown>[];
	revision: number;
}> {
	const commands = (await buildAvailableSlashCommands(session)).map(command => ({
		commandId: command.name,
		name: command.name,
		description: command.description,
		source: command.source,
		...(command.aliases?.length ? { aliases: command.aliases } : {}),
		...(command.input ? { input: command.input } : {}),
		...(command.subcommands?.length ? { subcommands: command.subcommands } : {}),
	}));
	return { commands, revision: stableCatalogRevision(commands) };
}

function clampPageSize(value: number | undefined): number {
	if (value === undefined) return 50;
	if (!Number.isSafeInteger(value) || value < 1 || value > 100)
		invalidParamsField("limit", "Expected an integer from 1 to 100");
	return value;
}

function invalidParamsField(field: string, message: string): never {
	failRpc({
		reason: "INVALID_PARAMS",
		category: "validation",
		message: `Invalid ${field}: ${message}`,
		fieldErrors: [{ path: field, reason: "invalid_value", message }],
	});
}

function parseApprovalScope(value: string): ApprovalScope | undefined {
	return value === "once" || value === "session" || value === "workspace" || value === "global" ? value : undefined;
}

function parseApprovalPolicyScope(value: string): ApprovalPolicyScope | undefined {
	return value === "session" || value === "workspace" || value === "global" ? value : undefined;
}

function approvalPolicyContext(session: AgentSession): ApprovalPolicyContext {
	return { sessionId: session.sessionId, cwd: session.sessionManager.getCwd() };
}

function approvalPolicyContextFromParams(
	sessionManager: RpcV2SessionManager,
	params: { sessionId?: string; cwd?: string } | undefined,
): ApprovalPolicyContext {
	const session = sessionManager.currentSession;
	return {
		...(params?.sessionId ? { sessionId: params.sessionId } : session ? { sessionId: session.sessionId } : {}),
		...(params?.cwd ? { cwd: params.cwd } : session ? { cwd: session.sessionManager.getCwd() } : {}),
	};
}

function encodePageCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			!isRecord(value) ||
			typeof value.offset !== "number" ||
			!Number.isSafeInteger(value.offset) ||
			value.offset < 0
		) {
			throw new Error("invalid offset");
		}
		return value.offset;
	} catch (error: unknown) {
		failRpc({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: `Invalid pagination cursor: ${sanitizeRpcError(error, { maxChars: 500 })}`,
			fieldErrors: [
				{ path: "cursor", reason: "invalid_cursor", message: "Expected an opaque cursor returned by San" },
			],
		});
	}
}
