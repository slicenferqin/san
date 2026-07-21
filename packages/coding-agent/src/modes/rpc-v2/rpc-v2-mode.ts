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
import { readJsonl, VERSION } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import { ApprovalRuleStore } from "./approval-rules";
import { executeRecovery } from "./crash-recovery";
import { EvidenceLedger } from "./evidence-generator";
import { RpcV2HostToolBridge } from "./host-tool-bridge";
import { IdempotencyStore } from "./idempotency";
import type { ClientCapabilities } from "./protocol/capabilities";
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
	type Notification,
	type RpcId,
	type ServerErrorResponse,
	type ServerResult,
} from "./protocol/envelope";
import { createRpcError, internalError, methodNotFound, notInitialized } from "./protocol/errors";
import { type LeaseId, newRunId, newRuntimeId, type RuntimeId } from "./protocol/ids";
import { ResourceUploadManager } from "./resource-upload";
import { RpcV2SessionManager } from "./session-manager";
import { RpcV2UIContext } from "./ui-context";

// ============================================================================
// Protocol constants
// ============================================================================

const PROTOCOL_VERSION = "2.0";
const SERVER_NAME = "san";

/** Methods allowed before initialize completes. */
const PRE_INIT_METHODS = new Set(["initialize", "server.getHealth", "server.shutdown"]);

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
	shutdownRequested: boolean;
}

// ============================================================================
// Output writer
// ============================================================================

type OutputFn = (frame: ServerResult | ServerErrorResponse | Notification | object) => void;

function createOutput(): OutputFn {
	return frame => {
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	};
}

function sendResult(output: OutputFn, id: RpcId, result: unknown): void {
	output({ jsonrpc: "2.0", id, result } satisfies ServerResult);
}

function sendError(output: OutputFn, id: RpcId | null, error: ReturnType<typeof createRpcError>): void {
	output({ jsonrpc: "2.0", id, error } satisfies ServerErrorResponse);
}

function sendNotification(output: OutputFn, method: string, params: unknown): void {
	output({ jsonrpc: "2.0", method, params } satisfies Notification);
}

// ============================================================================
// Method handlers
// ============================================================================

function handleInitialize(state: ServerState, params: unknown): InitializeResult | ReturnType<typeof createRpcError> {
	const p = params as InitializeParams | undefined;
	if (!p || typeof p.protocolVersion !== "string") {
		return createRpcError({
			reason: "INVALID_PARAMS",
			category: "validation",
			message: "initialize requires protocolVersion string",
		});
	}

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

	return {
		protocolVersion: PROTOCOL_VERSION,
		server: { name: SERVER_NAME, version: VERSION },
		runtimeId: state.runtimeId,
		capabilitiesRevision: state.capabilitiesRevision,
		capabilities: state.capabilities,
		limits: state.limits,
	};
}

function handleGetHealth(state: ServerState): object {
	return {
		status: "ok",
		runtimeId: state.runtimeId,
		uptimeMs: Date.now() - state.startedAt,
		initialized: state.initialized,
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
	return { accepted: true, mode: p?.mode ?? "graceful" };
}

// ============================================================================
// Method router
// ============================================================================

interface DispatchContext {
	state: ServerState;
	sessionManager: RpcV2SessionManager;
	session: AgentSession;
	output: OutputFn;
	uiContext: RpcV2UIContext;
	hostToolBridge: RpcV2HostToolBridge;
	idempotency: IdempotencyStore;
	evidence: EvidenceLedger;
	resources: ResourceUploadManager;
	approvalRules: ApprovalRuleStore;
}

function dispatchMethod(ctx: DispatchContext, method: string, params: unknown): unknown {
	const { state, sessionManager, session } = ctx;

	// Pre-initialize gate
	if (!state.initialized && !PRE_INIT_METHODS.has(method)) {
		return notInitialized();
	}

	switch (method) {
		// Server methods
		case "initialize":
			return handleInitialize(state, params);
		case "server.getHealth":
			return handleGetHealth(state);
		case "server.getCapabilities":
			return handleGetCapabilities(state, params);
		case "server.shutdown":
			return handleShutdown(state, params);

		// Session methods
		case "session.list":
			return sessionManager.listSessions(params as { cwd?: string; limit?: number; cursor?: string });
		case "session.open": {
			const p = params as { access?: "read_write" | "read_only" } | undefined;
			const result = sessionManager.openCurrentSession(p?.access ?? "read_write");
			return { ...result, runtimeId: state.runtimeId };
		}
		case "session.sync": {
			const p = params as { leaseId: LeaseId; afterSequence?: number | null; stream?: unknown } | undefined;
			if (!p?.leaseId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.sync requires leaseId",
				});
			}
			return sessionManager.sync({ leaseId: p.leaseId, afterSequence: p.afterSequence });
		}
		case "session.close":
			sessionManager.close();
			return { closed: true };

		// Run methods
		case "run.start": {
			const p = params as { content?: Array<{ type: string; text?: string }> } | undefined;
			const text =
				p?.content
					?.filter(c => c.type === "text")
					.map(c => c.text ?? "")
					.join("\n") ?? "";
			if (!text) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "run.start requires text content",
				});
			}
			const runId = newRunId();
			const adapterCtx = sessionManager.adapterContext;
			if (adapterCtx) adapterCtx.currentRunId = runId;
			// Fire and forget — events stream via subscription
			void session.prompt(text).catch(() => {});
			return { runId, operationId: `op_${runId}`, acceptedAt: new Date().toISOString() };
		}
		case "run.abort": {
			void session.abort({ reason: "user" });
			return { accepted: true };
		}
		case "run.steer": {
			const p = params as { content?: Array<{ type: string; text?: string }> } | undefined;
			const text =
				p?.content
					?.filter(c => c.type === "text")
					.map(c => c.text ?? "")
					.join("\n") ?? "";
			if (!text) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "run.steer requires text content",
				});
			}
			void session.steer(text);
			return { accepted: true };
		}
		case "run.followUp": {
			const p = params as { content?: Array<{ type: string; text?: string }> } | undefined;
			const text =
				p?.content
					?.filter(c => c.type === "text")
					.map(c => c.text ?? "")
					.join("\n") ?? "";
			if (!text) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "run.followUp requires text content",
				});
			}
			void session.followUp(text);
			return { accepted: true, queued: true };
		}

		// Model / Thinking
		case "model.list": {
			const models = session.getAvailableModels();
			return {
				models: models.map(m => ({
					provider: m.provider,
					modelId: m.id,
					displayName: m.name,
					contextWindow: m.contextWindow,
				})),
			};
		}
		case "model.select": {
			const p = params as { provider?: string; modelId?: string } | undefined;
			if (!p?.provider || !p?.modelId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "model.select requires provider and modelId",
				});
			}
			const models = session.getAvailableModels();
			const model = models.find(m => m.provider === p.provider && m.id === p.modelId);
			if (!model) {
				return createRpcError({
					reason: "MODEL_UNAVAILABLE",
					category: "not_found",
					message: `Model not found: ${p.provider}/${p.modelId}`,
				});
			}
			void session.setModel(model);
			return { provider: model.provider, modelId: model.id, displayName: model.name };
		}
		case "thinking.set": {
			const p = params as { level?: string } | undefined;
			if (p?.level) {
				session.setThinkingLevel(p.level as never);
			}
			return { configured: session.thinkingLevel, effective: session.thinkingLevel };
		}

		// Settings / Profiles
		case "settings.get": {
			return {
				schemaVersion: 1,
				revision: 1,
				executionProfile: { effective: "solo", source: "builtin", mutable: false, restartRequired: false },
				autoRetry: {
					effective: {
						enabled: session.autoRetryEnabled,
						maxAttempts: 3,
						baseDelayMs: 1000,
						maxDelayMs: 30000,
						cancellable: true,
					},
					source: "builtin",
					mutable: true,
					restartRequired: false,
				},
				contextMaintenance: {
					effective: { mode: session.autoCompactionEnabled ? "automatic" : "disabled" },
					source: "session",
					mutable: true,
					restartRequired: false,
				},
			};
		}
		case "settings.update": {
			const p = params as { autoRetry?: { enabled?: boolean }; contextMaintenance?: { mode?: string } } | undefined;
			if (p?.autoRetry?.enabled !== undefined) session.setAutoRetryEnabled(p.autoRetry.enabled);
			if (p?.contextMaintenance?.mode !== undefined)
				session.setAutoCompactionEnabled(p.contextMaintenance.mode === "automatic");
			return { updated: true };
		}
		case "execution.profile.list": {
			return {
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
				],
			};
		}

		// Todo
		case "todo.set": {
			const p = params as
				| { phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> }
				| undefined;
			if (p?.phases) {
				session.setTodoPhases(p.phases as never);
			}
			return { todoPhases: session.getTodoPhases() };
		}

		// Context
		case "context.get": {
			const usage = session.getContextUsage();
			return {
				schemaVersion: 1,
				status: "stable",
				usage: {
					tokens: usage?.tokens ?? null,
					contextWindow: usage?.contextWindow ?? null,
					percent: usage?.percent ?? null,
				},
				recentDigestRefs: [],
				counters: { digests: 0, checkpoints: 0, evidence: 0, retries: 0 },
			};
		}

		// Approval
		case "approval.list": {
			return { approvals: [], pending: ctx.uiContext.pendingApprovalCount };
		}
		case "approval.decide": {
			const p = params as { approvalId?: string; decision?: "allow" | "deny"; scope?: string } | undefined;
			if (!p?.approvalId || !p?.decision) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "approval.decide requires approvalId and decision",
				});
			}
			const resolved = ctx.uiContext.resolveApproval(p.approvalId, {
				allowed: p.decision === "allow",
				scope: (p.scope ?? "once") as "once" | "session" | "workspace" | "global",
			});
			if (!resolved) {
				return createRpcError({
					reason: "APPROVAL_NOT_PENDING",
					category: "conflict",
					message: `Approval ${p.approvalId} is not pending`,
				});
			}
			return { resolved: true, approvalId: p.approvalId, decision: p.decision };
		}

		// Interaction
		case "interaction.list": {
			return { interactions: [], pending: ctx.uiContext.pendingInteractionCount };
		}
		case "interaction.respond": {
			const p = params as { interactionId?: string; response?: unknown } | undefined;
			if (!p?.interactionId) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "interaction.respond requires interactionId",
				});
			}
			const resolved = ctx.uiContext.resolveInteraction(p.interactionId, p.response);
			if (!resolved) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "conflict",
					message: `Interaction ${p.interactionId} is not pending`,
				});
			}
			return { resolved: true, interactionId: p.interactionId };
		}

		// Host Tools
		case "host.capabilities.update": {
			const p = params as
				| {
						tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
						uriSchemes?: Array<{ scheme: string; description?: string; writable?: boolean }>;
				  }
				| undefined;
			const toolNames = p?.tools ? ctx.hostToolBridge.setTools(p.tools) : ctx.hostToolBridge.registeredTools;
			const schemes = p?.uriSchemes
				? ctx.hostToolBridge.setUriSchemes(p.uriSchemes)
				: ctx.hostToolBridge.registeredSchemes;
			return { tools: toolNames, uriSchemes: schemes };
		}

		// Subagent / Evidence / Context extras
		case "subagent.list":
			return { subagents: [] };
		case "evidence.list": {
			const p = params as { kinds?: string[]; verdicts?: string[]; limit?: number; cursor?: string } | undefined;
			const result = ctx.evidence.list({
				kinds: p?.kinds as never,
				verdicts: p?.verdicts as never,
				limit: p?.limit,
				offset: p?.cursor ? Number.parseInt(p.cursor, 10) : undefined,
			});
			return { evidence: result.evidence, total: result.total, nextCursor: null };
		}
		case "context.digests.list":
			return { digests: [], nextCursor: null };
		case "context.checkpoints.list":
			return { checkpoints: [], nextCursor: null };
		case "context.compact": {
			void session.compact();
			return { accepted: true };
		}

		// Session extras
		case "session.stats":
			return session.getSessionStats();
		case "session.rename": {
			const p = params as { name?: string } | undefined;
			if (!p?.name?.trim()) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "session.rename requires non-empty name",
				});
			}
			void session.setSessionName(p.name.trim(), "user");
			return { renamed: true, title: p.name.trim() };
		}
		case "session.recover": {
			const p = params as { strategy?: string } | undefined;
			const strategy = (p?.strategy ?? "continue") as "continue" | "mark_aborted" | "read_only";
			return executeRecovery(session.sessionId, strategy, state.runtimeId);
		}

		// Resource upload
		case "resource.upload.begin": {
			const p = params as
				| { mediaType?: string; fileName?: string; byteLength?: number; sha256?: string }
				| undefined;
			if (!p?.mediaType || !p?.byteLength || !p?.sha256) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.upload.begin requires mediaType, byteLength, sha256",
				});
			}
			return ctx.resources.begin({
				sessionId: session.sessionId as never,
				mediaType: p.mediaType,
				fileName: p.fileName,
				byteLength: p.byteLength,
				sha256: p.sha256,
			});
		}
		case "resource.upload.chunk": {
			const p = params as { uploadId?: string; offset?: number; dataBase64?: string } | undefined;
			if (!p?.uploadId || p?.offset === undefined || !p?.dataBase64) {
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.upload.chunk requires uploadId, offset, dataBase64",
				});
			}
			return ctx.resources.chunk({ uploadId: p.uploadId as never, offset: p.offset, dataBase64: p.dataBase64 });
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
			return ctx.resources.commit({ uploadId: p.uploadId as never, sha256: p.sha256 });
		}
		case "resource.release": {
			const p = params as { resourceId?: string } | undefined;
			if (!p?.resourceId)
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "resource.release requires resourceId",
				});
			const released = ctx.resources.release(p.resourceId);
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
			const p = params as { scope?: string } | undefined;
			return ctx.approvalRules.getPolicy((p?.scope ?? "session") as "session" | "workspace" | "global");
		}
		case "approval.rules.revoke": {
			const p = params as { ruleId?: string } | undefined;
			if (!p?.ruleId)
				return createRpcError({
					reason: "INVALID_PARAMS",
					category: "validation",
					message: "approval.rules.revoke requires ruleId",
				});
			const revoked = ctx.approvalRules.revoke(p.ruleId);
			return revoked
				? { revoked: true, revision: ctx.approvalRules.revision }
				: createRpcError({
						reason: "INVALID_PARAMS",
						category: "conflict",
						message: `Rule ${p.ruleId} not found or immutable`,
					});
		}
		case "approval.policy.get": {
			const p = params as { scope?: string } | undefined;
			return ctx.approvalRules.getPolicy((p?.scope ?? "session") as "session" | "workspace" | "global");
		}

		// Integration catalog (populated from session skills)
		case "integration.list": {
			const skills = session.skills ?? [];
			const integrations = skills.map((s: { name: string; description?: string }) => ({
				integrationId: `skill_${s.name}`,
				kind: "skill",
				name: s.name,
				displayName: s.name,
				source: "user",
				enabled: true,
				mutable: true,
				revision: 1,
				effect: "immediate",
				health: { status: "healthy" },
				auth: { status: "not_required" },
			}));
			return { integrations, revision: 1 };
		}
		case "integration.get": {
			const p = params as { integrationId?: string } | undefined;
			return createRpcError({
				reason: "INTEGRATION_UNAVAILABLE",
				category: "not_found",
				message: `Integration not found: ${p?.integrationId ?? "unknown"}`,
			});
		}

		// Stream / Diagnostics / Misc
		case "stream.configure": {
			const p = params as
				| { thinkingDeltas?: boolean; subagents?: string; maxTransientEventsPerSecond?: number }
				| undefined;
			return {
				thinkingDeltas: p?.thinkingDeltas ?? false,
				subagents: p?.subagents ?? "progress",
				maxTransientEventsPerSecond: p?.maxTransientEventsPerSecond ?? 200,
			};
		}
		case "server.getDiagnostics":
			return {
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				redaction: { profile: "strict", version: 1, removedFieldCount: 0 },
				runtime: { version: VERSION, protocolVersion: PROTOCOL_VERSION, uptimeMs: Date.now() - state.startedAt },
				capabilities: {
					revision: state.capabilitiesRevision,
					enabled: Object.keys(state.capabilities),
					unavailable: [],
				},
				sessions: { activeCount: 1, lockedCount: 0, lastSequences: {} },
				integrations: [],
				recentErrors: [],
			};
		case "auth.provider.list":
			return { providers: [] };
		case "command.list":
			return { commands: [], revision: 1 };

		default:
			return methodNotFound(method);
	}
}

function isRpcError(result: unknown): result is ReturnType<typeof createRpcError> {
	return typeof result === "object" && result !== null && "code" in result && "message" in result;
}

// ============================================================================
// Main entry
// ============================================================================

export async function runRpcV2Mode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	_eventBus?: EventBus,
): Promise<never> {
	// Suppress terminal notifications that corrupt stdout
	process.env.PI_NOTIFICATIONS = "off";

	const output = createOutput();
	const state: ServerState = {
		initialized: false,
		runtimeId: newRuntimeId(),
		startedAt: Date.now(),
		capabilitiesRevision: 1,
		capabilities: buildServerCapabilities(),
		limits: DEFAULT_LIMITS,
		shutdownRequested: false,
	};

	const sessionManager = new RpcV2SessionManager(session);
	sessionManager.setOutput(frame => output(frame));

	const uiContext = new RpcV2UIContext({ output: frame => output(frame), sessionId: session.sessionId });
	setToolUIContext?.(uiContext, true);

	const hostToolBridge = new RpcV2HostToolBridge(frame => output(frame));
	const idempotency = new IdempotencyStore();
	const evidence = new EvidenceLedger();
	const resources = new ResourceUploadManager();
	const approvalRules = new ApprovalRuleStore();

	const dispatchCtx: DispatchContext = {
		state,
		sessionManager,
		session,
		output,
		uiContext,
		hostToolBridge,
		idempotency,
		evidence,
		resources,
		approvalRules,
	};

	// Emit server.ready notification immediately
	sendNotification(output, "server.ready", {
		server: { name: SERVER_NAME, version: VERSION },
		protocol: { supported: [PROTOCOL_VERSION] },
		runtimeId: state.runtimeId,
		pid: process.pid,
	});

	// Input loop: read NDJSON from stdin
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		if (state.shutdownRequested) break;

		// Handle client results/errors for server-initiated requests (host tools)
		if (isClientResult(parsed)) {
			hostToolBridge.handleResult(parsed.id, parsed.result);
			continue;
		}
		if (isClientErrorResponse(parsed)) {
			hostToolBridge.handleError(String(parsed.id), parsed.error);
			continue;
		}
		if (!isClientRequest(parsed)) {
			continue;
		}

		const request = parsed as ClientRequest;
		const { id, method, params } = request;

		try {
			const result = await dispatchMethod(dispatchCtx, method, params);

			if (isRpcError(result)) {
				sendError(output, id, result);
			} else {
				sendResult(output, id, result);
			}

			// Post-shutdown: exit after sending the response
			if (method === "server.shutdown" && state.shutdownRequested) {
				sessionManager.close();
				process.exit(0);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			sendError(output, id, internalError(message));
		}
	}

	// stdin closed — client disconnected
	uiContext.rejectAll("RPC client disconnected");
	hostToolBridge.close("RPC client disconnected");
	sessionManager.close();
	process.exit(0);
}
