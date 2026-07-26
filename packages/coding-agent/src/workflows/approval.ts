import { Snowflake } from "@san/utils";
import { workflowValueHash } from "./fingerprint";
import type {
	AdHocWorkflowApprovalKey,
	AdHocWorkflowDraft,
	ManagedWorkflow,
	ManagedWorkflowApprovalKey,
	WorkflowApprovalKey,
	WorkflowApprovalRecord,
} from "./types";

export function createManagedApprovalKey(workflow: ManagedWorkflow): ManagedWorkflowApprovalKey {
	return {
		workflowKind: "managed",
		name: workflow.meta.name,
		version: workflow.meta.version,
		sourceHash: workflow.sourceHash,
		argsSchemaHash: workflow.argsSchemaHash,
		scopeKey: workflow.source.scopeKey,
		permissionManifestHash: workflow.permissionManifestHash,
		concurrencyLimit: workflow.meta.limits.concurrency,
		agentLimit: workflow.meta.limits.agentLimit,
		tokenLimit: workflow.meta.limits.tokenLimit,
		durationMs: workflow.meta.limits.durationMs,
		writeMode: workflow.meta.permissions.writeMode,
	};
}

export function createAdHocApprovalKey(draft: AdHocWorkflowDraft): AdHocWorkflowApprovalKey {
	return {
		workflowKind: "ad_hoc",
		draftId: draft.draftId,
		taskRef: draft.taskRef,
		sourceHash: draft.sourceHash,
		argsHash: draft.argsHash,
		argsSchemaHash: draft.argsSchemaHash,
		scopeKey: draft.scopeKey,
		permissionManifestHash: draft.permissionManifestHash,
		concurrencyLimit: draft.limits.concurrency,
		agentLimit: draft.limits.agentLimit,
		tokenLimit: draft.limits.tokenLimit,
		durationMs: draft.limits.durationMs,
		writeMode: draft.permissions.writeMode,
		expiresAt: draft.expiresAt,
	};
}

export function hashWorkflowApprovalKey(key: WorkflowApprovalKey): string {
	return workflowValueHash(key);
}

export function createWorkflowApproval(key: WorkflowApprovalKey, now = new Date()): WorkflowApprovalRecord {
	return {
		approvalId: `workflow-approval-${Snowflake.next()}`,
		keyHash: hashWorkflowApprovalKey(key),
		key,
		approvedAt: now.toISOString(),
		approvedBy: "user",
	};
}

export function approvalMatches(record: WorkflowApprovalRecord, key: WorkflowApprovalKey, now = new Date()): boolean {
	if (record.revokedAt || record.keyHash !== hashWorkflowApprovalKey(key)) return false;
	if (key.workflowKind === "ad_hoc") {
		if (record.consumedAt) return false;
		return now.getTime() < Date.parse(key.expiresAt);
	}
	return true;
}
