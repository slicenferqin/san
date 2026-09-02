import * as os from "node:os";
import { sanitizeText } from "@san/utils";
import { registerWorkflowManager, unregisterWorkflowManager } from "../../coordination/workflow-registry";
import { getWorkflowToolSession } from "../../session/workflow-host";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import {
	EvalWorkflowAgentBridge,
	WorkflowCommandService,
	WorkflowManager,
	type WorkflowRunHandle,
	WorkflowStore,
} from "../../workflows";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";
import { commandConsumed } from "./parse";

interface WorkflowSessionRuntime {
	sessionId: string;
	service: WorkflowCommandService;
	manager: WorkflowManager;
	store: WorkflowStore;
	policy: { allowIsolatedWrite: boolean };
	unregisterIdentityListener: () => void;
}

const WORKFLOW_SESSIONS = new WeakMap<object, WorkflowSessionRuntime>();

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const home = os.homedir();
	const safe = sanitizeText(message);
	return replaceTabs(home ? safe.replaceAll(home, "~") : safe)
		.split("\n")
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE))
		.join("\n");
}

function workflowTaskRef(runtime: SlashCommandRuntime): string {
	const userEntry = runtime.sessionManager
		.getBranch()
		.findLast(entry => entry.type === "message" && entry.message.role === "user" && !entry.message.synthetic);
	return userEntry
		? `${runtime.sessionManager.getSessionId()}:user:${userEntry.id}`
		: `${runtime.sessionManager.getSessionId()}:root`;
}

export function handoffApprovedPlan(
	runtime: TuiSlashCommandRuntime,
	planContent: string,
	title: string,
	model?: string,
): WorkflowRunHandle {
	const ctx = runtime.ctx;
	const state = workflowSession({
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: text => {
			ctx.showStatus(text, { dim: false });
		},
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: async () => ctx.refreshSlashCommandState(),
	});
	return state.service.startApprovedPlanHandoff(planContent, title, {
		cwd: ctx.sessionManager.getCwd(),
		taskRef: workflowTaskRef({
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		}),
		allowIsolatedWrite: ctx.settings.get("san.workflows.allowIsolatedWrite"),
		allowAdHoc: ctx.settings.get("san.workflows.adHocEnabled"),
		model,
		observeRun: handle =>
			observeRun(handle, state.service, text => {
				ctx.showStatus(text, { dim: false });
				ctx.refreshCoordinationActivities?.();
			}),
	});
}

function workflowSession(runtime: SlashCommandRuntime): WorkflowSessionRuntime {
	const key = runtime.sessionManager;
	const existing = WORKFLOW_SESSIONS.get(key);
	const sessionId = runtime.sessionManager.getSessionId();
	if (existing?.sessionId === sessionId) return existing;
	if (existing) {
		existing.manager.suspendLiveRuns("Workflow suspended because the user switched sessions");
		existing.unregisterIdentityListener();
		unregisterWorkflowManager(key, existing.manager);
		WORKFLOW_SESSIONS.delete(key);
		void existing.manager.waitForLiveRunsToSettle().then(() => existing.store.close());
	}

	const policy = { allowIsolatedWrite: runtime.settings.get("san.workflows.allowIsolatedWrite") };
	const toolSession = getWorkflowToolSession(runtime.session);
	if (!toolSession) {
		throw new Error("Workflow execution is unavailable because this session has no host tool capability context.");
	}
	const store = WorkflowStore.open(runtime.settings.getAgentDir());
	const manager = new WorkflowManager({
		store,
		sessionManager: runtime.sessionManager,
		bridgeFactory: context =>
			new EvalWorkflowAgentBridge({
				session: toolSession,
				approvedPermissions: context.permissions,
				approvedScopeKey: context.scopeKey,
				allowIsolatedWrite: policy.allowIsolatedWrite,
			}),
	});
	registerWorkflowManager(key, manager);
	const state: WorkflowSessionRuntime = {
		sessionId,
		service: new WorkflowCommandService({ store, manager }),
		manager,
		store,
		policy,
		unregisterIdentityListener: () => {},
	};
	state.unregisterIdentityListener = runtime.sessionManager.onSessionIdentityChanged(change => {
		if (change.previousSessionId !== state.sessionId) return;
		state.manager.suspendLiveRuns("Workflow suspended because the user switched sessions");
		WORKFLOW_SESSIONS.delete(key);
		unregisterWorkflowManager(key, state.manager);
		state.unregisterIdentityListener();
		void state.manager.waitForLiveRunsToSettle().then(() => state.store.close());
	});
	WORKFLOW_SESSIONS.set(key, state);
	return state;
}

function observeRun(
	handle: WorkflowRunHandle,
	service: WorkflowCommandService,
	output: SlashCommandRuntime["output"],
): void {
	void handle.completion
		.then(async () => {
			const prepared = service.prepareCompletedRunDelivery(handle.runId);
			await output(prepared.text);
			if (prepared.receipt) service.acknowledgeDeliveryReceipt(prepared.receipt);
		})
		.catch(async error => {
			await output(`Workflow ${handle.runId} completion error: ${sanitizeError(error)}`);
		});
}

export async function handleWorkflowCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!runtime.settings.get("san.workflows.enabled")) {
		await runtime.output(
			"San v0.4 Workflows are disabled. Enable san.workflows.enabled before publishing, approving or running a Workflow.",
		);
		return commandConsumed();
	}

	const state = workflowSession(runtime);
	state.policy.allowIsolatedWrite = runtime.settings.get("san.workflows.allowIsolatedWrite");
	try {
		const prepared = await state.service.prepareCommandOutput(command.name === "workflows" ? "list" : command.args, {
			cwd: runtime.cwd,
			taskRef: workflowTaskRef(runtime),
			allowIsolatedWrite: state.policy.allowIsolatedWrite,
			allowAdHoc: runtime.settings.get("san.workflows.adHocEnabled"),
			generateAdHocDescriptor: objective => runtime.session.generateAdHocWorkflowDraft(objective),
			generateManagedDescriptor: sop => runtime.session.generateManagedSopWorkflowDraft(sop),
			observeRun: handle => observeRun(handle, state.service, runtime.output),
		});
		await runtime.output(prepared.text);
		state.service.acknowledgeDeliveryReceipts(prepared.deliveryReceipts);
	} catch (error) {
		await runtime.output(`Workflow error: ${sanitizeError(error)}`);
	}
	return commandConsumed();
}

export async function handleWorkflowTuiCommand(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): Promise<void> {
	const ctx = runtime.ctx;
	await handleWorkflowCommand(command, {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: text => ctx.showStatus(text, { dim: false }),
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: async () => ctx.refreshSlashCommandState(),
	});
	ctx.refreshCoordinationActivities?.();
	ctx.editor.setText("");
}
