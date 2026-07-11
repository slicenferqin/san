import * as path from "node:path";
import {
	type EvalAgentBridgeOptions,
	type EvalAgentExecutionResult,
	runEvalAgentExecution,
} from "../eval/agent-bridge";
import type { JsStatusEvent } from "../eval/js/shared/types";
import type { ToolSession } from "../tools";
import { isWorkflowJsonValue, WORKFLOW_READ_ONLY_TOOLS } from "./schema";
import type {
	WorkflowAgentBridge,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowJsonValue,
	WorkflowPermissionManifest,
} from "./types";

export class WorkflowAgentBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowAgentBridgeError";
	}
}

export type WorkflowEvalAgentInvoker = (
	args: unknown,
	options: EvalAgentBridgeOptions,
) => Promise<EvalAgentExecutionResult>;

export interface EvalWorkflowAgentBridgeOptions {
	session: ToolSession;
	approvedPermissions: WorkflowPermissionManifest;
	/** Exact absolute execution directory shown in the approval review. */
	approvedScopeKey: string;
	/** Separate opt-in for the v0.4 isolated-write review and delivery gate. */
	allowIsolatedWrite?: boolean;
	emitStatus?: (event: JsStatusEvent) => void;
	/** Test/integration seam; production uses the neutralized Eval spawn backend. */
	invokeAgent?: WorkflowEvalAgentInvoker;
}

function parseStructuredValue(text: string): WorkflowJsonValue {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkflowAgentBridgeError(`Workflow agent returned invalid JSON: ${message}`);
	}
	if (!isWorkflowJsonValue(value)) {
		throw new WorkflowAgentBridgeError("Workflow agent returned a non-JSON structured value.");
	}
	return value;
}

/**
 * Workflow-facing adapter for the existing programmatic subagent backend.
 *
 * Authorization remains host-owned: the request can only narrow the approved
 * manifest, the Eval backend intersects it with the live session and selected
 * agent, and strict executor mode prevents implicit task/IRC/MCP/extension
 * tools from being added back.
 */
export class EvalWorkflowAgentBridge implements WorkflowAgentBridge {
	#session: ToolSession;
	#approvedTools: Set<string>;
	#writeMode: WorkflowPermissionManifest["writeMode"];
	#allowIsolatedWrite: boolean;
	#approvedScopeKey: string;
	#emitStatus: ((event: JsStatusEvent) => void) | undefined;
	#invokeAgent: WorkflowEvalAgentInvoker;

	constructor(options: EvalWorkflowAgentBridgeOptions) {
		this.#session = options.session;
		this.#approvedTools = new Set(options.approvedPermissions.tools);
		this.#writeMode = options.approvedPermissions.writeMode;
		this.#approvedScopeKey = options.approvedScopeKey;
		this.#allowIsolatedWrite = options.allowIsolatedWrite === true;
		this.#emitStatus = options.emitStatus;
		this.#invokeAgent = options.invokeAgent ?? runEvalAgentExecution;
		if (!path.isAbsolute(this.#approvedScopeKey)) {
			throw new WorkflowAgentBridgeError("Workflow approval scope must be an absolute directory.");
		}

		if (!this.#approvedTools.has("yield")) {
			throw new WorkflowAgentBridgeError("Workflow approval must include the yield completion tool.");
		}
		if (this.#writeMode === "read_only") {
			const readOnly = new Set(WORKFLOW_READ_ONLY_TOOLS);
			const unsafe = [...this.#approvedTools].filter(name => !readOnly.has(name));
			if (unsafe.length > 0) {
				throw new WorkflowAgentBridgeError(
					`Read-only Workflow approval contains unsafe tools: ${unsafe.sort().join(", ")}`,
				);
			}
		}
	}

	async run(request: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
		if (request.scopeKey !== this.#approvedScopeKey) {
			throw new WorkflowAgentBridgeError("Workflow agent request does not match the approved execution scope.");
		}
		const requestedTools = [...new Set(request.allowedTools.map(name => name.trim()).filter(Boolean))];
		if (!requestedTools.includes("yield")) {
			throw new WorkflowAgentBridgeError("Workflow agent requests must include the yield completion tool.");
		}
		const unapproved = requestedTools.filter(name => !this.#approvedTools.has(name));
		if (unapproved.length > 0) {
			throw new WorkflowAgentBridgeError(
				`Workflow agent requested tools outside the approved manifest: ${unapproved.sort().join(", ")}`,
			);
		}
		if (request.writeMode === "read_only") {
			const readOnly = new Set(WORKFLOW_READ_ONLY_TOOLS);
			const unsafe = requestedTools.filter(name => !readOnly.has(name));
			if (unsafe.length > 0) {
				throw new WorkflowAgentBridgeError(
					`Read-only Workflow agent requested unsafe tools: ${unsafe.sort().join(", ")}`,
				);
			}
		}
		if (request.writeMode === "isolated_write") {
			if (this.#writeMode !== "isolated_write") {
				throw new WorkflowAgentBridgeError("Workflow agent requested writes from a read-only approval.");
			}
			if (!this.#allowIsolatedWrite) {
				throw new WorkflowAgentBridgeError(
					"Isolated Workflow writes are unavailable until the separate delivery gate is enabled.",
				);
			}
		}

		const execution = await this.#invokeAgent(
			{
				prompt: request.prompt,
				agent: request.agent,
				model: request.model,
				label: request.label,
				...(request.schema ? { schema: request.schema } : {}),
				isolated: request.writeMode === "isolated_write" || undefined,
				apply: request.writeMode === "isolated_write" ? false : undefined,
				merge: request.writeMode === "isolated_write" ? false : undefined,
			},
			{
				session: this.#session,
				signal: request.signal,
				emitStatus: this.#emitStatus,
				toolPolicy: {
					allowedTools: requestedTools,
					pathScope: this.#approvedScopeKey,
					requireSessionActivation: true,
					hardTokenLimit: request.remainingTokenBudget,
				},
			},
		);
		let writeArtifact: WorkflowAgentResult["writeArtifact"];
		if (request.writeMode === "isolated_write") {
			if (execution.result.details.changesApplied !== null) {
				throw new WorkflowAgentBridgeError("Isolated Workflow changes were not preserved for explicit review.");
			}
			if (execution.result.details.branchName) {
				throw new WorkflowAgentBridgeError("Isolated Workflow writes must produce a patch, not a merge branch.");
			}
			if (!execution.result.details.patchPath || !execution.isolation) {
				throw new WorkflowAgentBridgeError("Isolated Workflow agent did not return a reviewable patch artifact.");
			}
			writeArtifact = {
				repoRoot: execution.isolation.context.repoRoot,
				artifactRoot: execution.isolation.artifactsDir,
				patchPath: execution.result.details.patchPath,
				scopeKey: request.scopeKey,
				baseline: structuredClone(execution.isolation.context.baseline),
				nestedPatches: structuredClone(execution.result.details.nestedPatches ?? []),
			};
		}
		const value = request.schema ? parseStructuredValue(execution.result.text) : execution.result.text;
		return {
			agentId: execution.result.details.id,
			value,
			text: execution.result.text,
			usage: execution.usage,
			durationMs: execution.durationMs,
			patchPath: execution.result.details.patchPath,
			branchName: execution.result.details.branchName,
			changesApplied: execution.result.details.changesApplied,
			...(writeArtifact ? { writeArtifact } : {}),
		};
	}
}
