import type { WorkflowManager } from "../workflows/manager";

const WORKFLOW_MANAGERS = new WeakMap<object, WorkflowManager>();

export function registerWorkflowManager(owner: object, manager: WorkflowManager): void {
	WORKFLOW_MANAGERS.set(owner, manager);
}

export function unregisterWorkflowManager(owner: object, manager: WorkflowManager): void {
	if (WORKFLOW_MANAGERS.get(owner) === manager) WORKFLOW_MANAGERS.delete(owner);
}

export function getWorkflowManager(owner: object): WorkflowManager | undefined {
	return WORKFLOW_MANAGERS.get(owner);
}
