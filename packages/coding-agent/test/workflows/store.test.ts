import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type AdHocWorkflowDraft,
	createAdHocApprovalKey,
	type DiscoveredWorkflowSource,
	hashWorkflowApprovalKey,
	type ManagedWorkflow,
	normalizeWorkflowMeta,
	parseManagedWorkflow,
	WorkflowStore,
	WorkflowStoreConflictError,
	workflowSourceHash,
	workflowValueHash,
} from "@san/coding-agent/workflows";
import { TempDir } from "@san/utils";

let tempDir: TempDir | null = null;
const stores = new Set<WorkflowStore>();

function createStore(dbPath?: string): WorkflowStore {
	if (!tempDir) throw new Error("Test temp directory is not initialized.");
	const store = new WorkflowStore(dbPath ?? tempDir.join("workflows.sqlite"));
	stores.add(store);
	return store;
}

function closeStore(store: WorkflowStore): void {
	store.close();
	stores.delete(store);
}

function managedSource(version = "1", description = "Audit a release"): string {
	return `export const meta = {
	name: "release-audit",
	description: ${JSON.stringify(description)},
	version: ${JSON.stringify(version)},
	argsSchema: {
		type: "object",
		required: ["branch"],
		properties: { branch: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 4, agentLimit: 12, tokenLimit: 100000, durationMs: 60000 },
};

const result = await agent({ prompt: "Audit the release", allowedTools: meta.permissions.tools });
return result;
`;
}

function managedWorkflow(
	overrides: { version?: string; description?: string; scopeKey?: string } = {},
): ManagedWorkflow {
	const sourceText = managedSource(overrides.version, overrides.description);
	const source: DiscoveredWorkflowSource = {
		name: "release-audit",
		path: "/repo/.san/workflows/release-audit.js",
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		provider: "san",
		level: "project",
		scopeKey: overrides.scopeKey ?? "/repo",
		directoryDepth: 0,
	};
	return parseManagedWorkflow(source);
}

function adHocDraft(overrides: Partial<AdHocWorkflowDraft> = {}): AdHocWorkflowDraft {
	const permissions = { writeMode: "read_only" as const, tools: ["grep", "read", "yield"] };
	const limits = { concurrency: 4, agentLimit: 12, tokenLimit: 80_000, durationMs: 60_000 };
	const args = { path: "src/routes" };
	const sourceText = "const routes = await agent({ prompt: 'Audit routes' }); return routes;";
	const meta = normalizeWorkflowMeta({
		name: "audit-routes",
		description: "Audit routes for this task",
		permissions,
		limits,
	});
	return {
		kind: "ad_hoc",
		draftId: "draft-1",
		taskRef: "task-1",
		name: "audit-routes",
		description: "Audit routes for this task",
		humanSummary: "List and inspect the routes once.",
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		args,
		argsHash: workflowValueHash(args),
		argsSchemaHash: workflowValueHash(null),
		permissions: meta.permissions,
		permissionManifestHash: workflowValueHash(meta.permissions),
		limits: meta.limits,
		scopeKey: "/repo",
		createdAt: "2026-07-11T00:00:00.000Z",
		expiresAt: "2026-07-11T01:00:00.000Z",
		status: "draft",
		...overrides,
	};
}

beforeEach(() => {
	tempDir = TempDir.createSync("@san-workflow-store-");
});

afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("WorkflowStore Managed versions", () => {
	it("persists an immutable published version and its exact human approval across sessions", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("workflows.sqlite");
		const workflow = managedWorkflow();
		const first = createStore(dbPath);

		expect(first.schemaVersion).toBe(2);
		expect(first.findManagedApproval(workflow)).toBeUndefined();
		expect(first.publishManagedVersion(workflow, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
			workflow: { kind: "managed", sourceHash: workflow.sourceHash },
			publishedAt: "2026-07-11T00:00:00.000Z",
		});
		const approval = first.approveManagedVersion(workflow, new Date("2026-07-11T00:01:00.000Z"));
		expect(approval.approvedBy).toBe("user");
		closeStore(first);

		const resumed = createStore(dbPath);
		expect(resumed.getManagedVersion("release-audit", "1", "/repo")?.workflow.sourceHash).toBe(workflow.sourceHash);
		expect(resumed.findManagedApproval(workflow)?.approvalId).toBe(approval.approvalId);
	});

	it("does not let the same name and version inherit approval after any bound content changes", () => {
		const store = createStore();
		const approved = managedWorkflow();
		store.publishManagedVersion(approved);
		store.approveManagedVersion(approved);

		const changed = managedWorkflow({ description: "A changed release audit" });
		expect(() => store.publishManagedVersion(changed)).toThrow(WorkflowStoreConflictError);
		expect(store.findManagedApproval(changed)).toBeUndefined();
		expect(store.findManagedApproval(approved)).toBeDefined();
	});

	it("revokes a version and its approval without deleting its audit record", () => {
		const store = createStore();
		const workflow = managedWorkflow();
		store.publishManagedVersion(workflow);
		const approval = store.approveManagedVersion(workflow);

		expect(store.revokeManagedVersion(workflow, new Date("2026-07-11T00:10:00.000Z"))).toBe(true);
		expect(store.findManagedApproval(workflow)).toBeUndefined();
		expect(store.getApproval(approval.approvalId)?.revokedAt).toBe("2026-07-11T00:10:00.000Z");
		expect(store.listManagedVersions()).toEqual([]);
		expect(store.listManagedVersions({ includeRevoked: true })[0]?.revokedAt).toBe("2026-07-11T00:10:00.000Z");
	});
});

describe("WorkflowStore Ad-hoc approvals", () => {
	it("requires a distinct approval for every draft even when the names match", () => {
		const store = createStore();
		const first = store.saveAdHocDraft(adHocDraft());
		const second = store.saveAdHocDraft(
			adHocDraft({
				draftId: "draft-2",
				taskRef: "task-2",
				createdAt: "2026-07-11T00:05:00.000Z",
				expiresAt: "2026-07-11T01:05:00.000Z",
			}),
		);
		const firstApproval = store.approveAdHocDraft(first, new Date("2026-07-11T00:10:00.000Z"));

		expect(store.findAdHocApproval(first, new Date("2026-07-11T00:20:00.000Z"))?.approvalId).toBe(
			firstApproval.approvalId,
		);
		expect(store.listApprovals({ workflowKind: "ad_hoc", now: new Date("2026-07-11T00:20:00.000Z") })).toHaveLength(
			1,
		);
		expect(store.findAdHocApproval(second, new Date("2026-07-11T00:20:00.000Z"))).toBeUndefined();
		expect(hashWorkflowApprovalKey(createAdHocApprovalKey(first))).not.toBe(
			hashWorkflowApprovalKey(createAdHocApprovalKey(second)),
		);
	});

	it("atomically consumes an approval once and keeps it consumed after reopening", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("workflows.sqlite");
		const firstStore = createStore(dbPath);
		const draft = firstStore.saveAdHocDraft(adHocDraft());
		const approval = firstStore.approveAdHocDraft(draft, new Date("2026-07-11T00:10:00.000Z"));
		const consumed = firstStore.consumeAdHocApproval(
			draft,
			approval.approvalId,
			new Date("2026-07-11T00:20:00.000Z"),
		);

		expect(consumed.consumedAt).toBe("2026-07-11T00:20:00.000Z");
		expect(firstStore.getAdHocDraft(draft.draftId)?.status).toBe("consumed");
		expect(() =>
			firstStore.consumeAdHocApproval(draft, approval.approvalId, new Date("2026-07-11T00:21:00.000Z")),
		).toThrow("cannot run from consumed");
		closeStore(firstStore);

		const resumed = createStore(dbPath);
		expect(resumed.getApproval(approval.approvalId)?.consumedAt).toBe("2026-07-11T00:20:00.000Z");
		expect(resumed.findAdHocApproval(draft, new Date("2026-07-11T00:30:00.000Z"))).toBeUndefined();
	});

	it("removes terminal one-time draft content and its approval instead of retaining a reusable plan", () => {
		const store = createStore();
		const consumedDraft = store.saveAdHocDraft(adHocDraft());
		const approval = store.approveAdHocDraft(consumedDraft, new Date("2026-07-11T00:10:00.000Z"));
		store.consumeAdHocApproval(consumedDraft, approval.approvalId, new Date("2026-07-11T00:20:00.000Z"));

		expect(store.deleteAdHocDraft(consumedDraft.draftId, ["consumed"])).toBe(true);
		expect(store.getAdHocDraft(consumedDraft.draftId)).toBeUndefined();
		expect(store.getApproval(approval.approvalId)).toBeUndefined();

		const liveDraft = store.saveAdHocDraft(adHocDraft({ draftId: "still-live" }));
		expect(() => store.deleteAdHocDraft(liveDraft.draftId, ["consumed", "rejected"])).toThrow(
			"cannot be removed from draft",
		);
	});

	it("rejects changed approval material and persists expiration without creating an approval", () => {
		const store = createStore();
		const draft = store.saveAdHocDraft(adHocDraft());
		const changed = { ...draft, argsHash: workflowValueHash({ path: "src/other" }) };

		expect(() => store.approveAdHocDraft(changed, new Date("2026-07-11T00:10:00.000Z"))).toThrow();
		expect(() => store.approveAdHocDraft(draft, new Date("2026-07-11T01:00:00.000Z"))).toThrow("has expired");
		expect(store.getAdHocDraft(draft.draftId)?.status).toBe("expired");
		expect(store.listApprovals({ workflowKind: "ad_hoc", includeInactive: true })).toEqual([]);
	});

	it("records an explicit rejection and never creates an execution approval", () => {
		const store = createStore();
		const draft = store.saveAdHocDraft(adHocDraft());

		expect(store.rejectAdHocDraft(draft.draftId, new Date("2026-07-11T00:10:00.000Z")).status).toBe("rejected");
		expect(() => store.approveAdHocDraft(draft, new Date("2026-07-11T00:20:00.000Z"))).toThrow(
			"cannot be approved from rejected",
		);
		expect(store.listApprovals({ includeInactive: true })).toEqual([]);
	});

	it("revokes a one-time approval when an approved draft is rejected before it runs", () => {
		const store = createStore();
		const draft = store.saveAdHocDraft(adHocDraft());
		const approval = store.approveAdHocDraft(draft, new Date("2026-07-11T00:10:00.000Z"));

		expect(store.rejectAdHocDraft(draft.draftId, new Date("2026-07-11T00:20:00.000Z")).status).toBe("rejected");
		expect(store.getApproval(approval.approvalId)?.revokedAt).toBe("2026-07-11T00:20:00.000Z");
		expect(store.findAdHocApproval(draft, new Date("2026-07-11T00:21:00.000Z"))).toBeUndefined();
		expect(store.deleteAdHocDraft(draft.draftId, ["rejected"])).toBe(true);
		expect(store.getApproval(approval.approvalId)).toBeUndefined();
	});
});

describe("WorkflowStore corruption boundaries", () => {
	it("rejects a database schema newer than this runtime", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("future.sqlite");
		const db = new Database(dbPath);
		db.run("PRAGMA user_version = 99");
		db.close();

		expect(() => createStore(dbPath)).toThrow("Workflow database schema 99 is newer than supported version 2");
	});

	it("validates persisted JSON and hashes again when durable state is read", () => {
		if (!tempDir) throw new Error("Test temp directory is not initialized.");
		const dbPath = tempDir.join("corrupt.sqlite");
		const store = createStore(dbPath);
		const workflow = managedWorkflow();
		store.publishManagedVersion(workflow);
		closeStore(store);

		const db = new Database(dbPath);
		db.prepare("UPDATE managed_versions SET payload_json = ?").run('{"kind":"managed"}');
		db.close();

		const reopened = createStore(dbPath);
		expect(() => reopened.getManagedVersion("release-audit", "1", "/repo")).toThrow("invalid metadata");
	});
});
