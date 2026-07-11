import { describe, expect, it } from "bun:test";
import {
	type AdHocWorkflowDraft,
	approvalMatches,
	assertWorkflowArgs,
	canonicalWorkflowJson,
	createAdHocApprovalKey,
	createManagedApprovalKey,
	createWorkflowApproval,
	isWorkflowJsonValue,
	type ManagedWorkflow,
	normalizeWorkflowMeta,
	WorkflowValidationError,
	workflowSourceHash,
	workflowValueHash,
} from "@oh-my-pi/pi-coding-agent/workflows";

function managedWorkflow(): ManagedWorkflow {
	const meta = normalizeWorkflowMeta({
		name: "release-readiness",
		description: "Check a release",
		version: 1,
		argsSchema: {
			type: "object",
			required: ["branch"],
			properties: { branch: { type: "string", minLength: 1 } },
			additionalProperties: false,
		},
	});
	return {
		kind: "managed",
		meta,
		source: { provider: "san", level: "project", scopeKey: "/repo", path: "/repo/.san/workflows/release.js" },
		sourceText: "export const meta = {}; return 'ok';",
		sourceHash: workflowSourceHash("export const meta = {}; return 'ok';"),
		argsSchemaHash: workflowValueHash(meta.argsSchema ?? null),
		permissionManifestHash: workflowValueHash(meta.permissions),
	};
}

function adHocDraft(): AdHocWorkflowDraft {
	const permissions = normalizeWorkflowMeta({ name: "audit", description: "Audit routes" }).permissions;
	return {
		kind: "ad_hoc",
		draftId: "draft-1",
		taskRef: "task-1",
		name: "audit",
		description: "Audit routes",
		humanSummary: "List, inspect and verify routes",
		sourceText: "return await agent('audit');",
		sourceHash: workflowSourceHash("return await agent('audit');"),
		args: { path: "src/routes" },
		argsHash: workflowValueHash({ path: "src/routes" }),
		argsSchemaHash: workflowValueHash(null),
		permissions,
		permissionManifestHash: workflowValueHash(permissions),
		limits: { concurrency: 4, agentLimit: 12, tokenLimit: 100_000, durationMs: 60_000 },
		scopeKey: "/repo",
		createdAt: "2026-07-11T00:00:00.000Z",
		expiresAt: "2026-07-11T01:00:00.000Z",
		status: "draft",
	};
}

describe("workflow v0.4 contracts", () => {
	it("accepts exactly the managed and ad-hoc product kinds at compile time and binds managed approval to every execution boundary", () => {
		const workflow = managedWorkflow();
		const key = createManagedApprovalKey(workflow);
		const approval = createWorkflowApproval(key, new Date("2026-07-11T00:00:00.000Z"));

		expect(approvalMatches(approval, key, new Date("2026-07-12T00:00:00.000Z"))).toBe(true);
		expect(approvalMatches(approval, { ...key, tokenLimit: key.tokenLimit + 1 })).toBe(false);
		expect(approvalMatches(approval, { ...key, sourceHash: workflowSourceHash("changed") })).toBe(false);
		expect(approvalMatches(approval, { ...key, argsSchemaHash: workflowValueHash({ type: "string" }) })).toBe(false);
		expect(approvalMatches(approval, { ...key, scopeKey: "/another-repo" })).toBe(false);
		expect(approvalMatches(approval, { ...key, permissionManifestHash: workflowValueHash({ tools: [] }) })).toBe(
			false,
		);
		expect(approvalMatches(approval, { ...key, concurrencyLimit: key.concurrencyLimit + 1 })).toBe(false);
		expect(approvalMatches(approval, { ...key, agentLimit: key.agentLimit + 1 })).toBe(false);
		expect(approvalMatches(approval, { ...key, durationMs: key.durationMs + 1 })).toBe(false);
		expect(approvalMatches(approval, { ...key, writeMode: "isolated_write" })).toBe(false);
	});

	it("never reuses an ad-hoc approval after consumption or expiration", () => {
		const key = createAdHocApprovalKey(adHocDraft());
		const approval = createWorkflowApproval(key, new Date("2026-07-11T00:10:00.000Z"));

		expect(approvalMatches(approval, key, new Date("2026-07-11T00:20:00.000Z"))).toBe(true);
		expect(approvalMatches({ ...approval, consumedAt: "2026-07-11T00:30:00.000Z" }, key)).toBe(false);
		expect(approvalMatches(approval, key, new Date("2026-07-11T01:00:00.000Z"))).toBe(false);
		expect(approvalMatches(approval, { ...key, draftId: "draft-2" }, new Date("2026-07-11T00:20:00.000Z"))).toBe(
			false,
		);
	});

	it("rejects unsafe read-only manifests and hard-limit overruns", () => {
		expect(() =>
			normalizeWorkflowMeta({
				name: "unsafe",
				description: "Unsafe",
				permissions: { writeMode: "read_only", tools: ["read", "bash"] },
				limits: { concurrency: 17 },
			}),
		).toThrow(WorkflowValidationError);
	});

	it("validates structured arguments at the observable invocation boundary", () => {
		const schema = managedWorkflow().meta.argsSchema;
		expect(() => assertWorkflowArgs({ branch: "main" }, schema)).not.toThrow();
		expect(() => assertWorkflowArgs({ branch: "", extra: true }, schema)).toThrow(
			"args.branch is too short; args.extra is not allowed",
		);
	});

	it("rejects cyclic, oversized and non-plain argument values before hashing or execution", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(isWorkflowJsonValue(cyclic)).toBe(false);
		expect(() => assertWorkflowArgs(cyclic as never, undefined)).toThrow("args must be bounded JSON data");
		expect(() => assertWorkflowArgs("x".repeat(65_537), { type: "string" })).toThrow(
			"args must be bounded JSON data",
		);
		expect(isWorkflowJsonValue(new Date())).toBe(false);
	});

	it("accepts only bounded linear-safe argument patterns", () => {
		expect(() =>
			normalizeWorkflowMeta({
				name: "safe-pattern",
				description: "Safe pattern",
				argsSchema: { type: "string", pattern: "^[a-z0-9-]+$" },
			}),
		).not.toThrow();
		expect(() =>
			normalizeWorkflowMeta({
				name: "unsafe-pattern",
				description: "Unsafe pattern",
				argsSchema: { type: "string", pattern: "^(a+)+$" },
			}),
		).toThrow("linear-safe Workflow pattern");
	});

	it("canonicalizes object keys before hashing approval material", () => {
		expect(workflowValueHash({ a: 1, b: { c: 2 } })).toBe(workflowValueHash({ b: { c: 2 }, a: 1 }));
	});

	it("preserves prototype-named JSON keys in approval fingerprints without mutating object prototypes", () => {
		const value = JSON.parse('{"safe":1,"__proto__":{"approved":true}}');

		expect(canonicalWorkflowJson(value)).toBe('{"__proto__":{"approved":true},"safe":1}');
		expect(workflowValueHash(value)).not.toBe(workflowValueHash({ safe: 1 }));
		expect(Object.hasOwn(Object.prototype, "approved")).toBe(false);
	});
});
