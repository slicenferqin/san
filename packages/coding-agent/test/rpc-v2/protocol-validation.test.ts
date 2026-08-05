import { describe, expect, test } from "bun:test";
import { RPC_V2_METHODS } from "@san/coding-agent/modes/rpc-v2/protocol/methods";
import { paramsSchemaForMethod, RPC_V2_SCHEMA } from "@san/coding-agent/modes/rpc-v2/protocol/schema";
import { validateRpcV2Params } from "@san/coding-agent/modes/rpc-v2/protocol/validate";

describe("RPC v2 schema contract", () => {
	test("publishes params schemas for every routed method", () => {
		for (const method of RPC_V2_METHODS) expect(paramsSchemaForMethod(method), method).toBeDefined();
	});

	test("rejects missing, mistyped, and unknown fields from the shared schema", () => {
		expect(validateRpcV2Params("session.sync", { sessionId: "ses_1", leaseId: "lease_1" })).toEqual([]);
		expect(validateRpcV2Params("session.sync", { sessionId: "ses_1" })).toContainEqual({
			path: "params.leaseId",
			reason: "required",
			message: "Required field is missing",
		});
		expect(validateRpcV2Params("session.list", { limit: 0 })).toContainEqual({
			path: "params.limit",
			reason: "out_of_range",
			message: "Expected a value greater than or equal to 1",
		});
		expect(validateRpcV2Params("server.getHealth", { prompt: "must not be accepted" })).toContainEqual({
			path: "params.prompt",
			reason: "unknown_field",
			message: "Unknown field is not allowed",
		});
	});

	test("accepts auth interaction responses without a Session lease", () => {
		expect(
			validateRpcV2Params("interaction.respond", {
				interactionId: "int_1",
				response: { kind: "confirmed", value: true },
				meta: { idempotencyKey: "auth-response-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("interaction.cancel", {
				interactionId: "int_1",
				meta: { idempotencyKey: "auth-cancel-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("interaction.respond", {
				sessionId: "ses_1",
				interactionId: "int_1",
				response: { kind: "confirmed", value: true },
				meta: { idempotencyKey: "session-response-1" },
			}),
		).toContainEqual({
			path: "params.leaseId",
			reason: "required",
			message: "Required field is missing",
		});
		expect(
			validateRpcV2Params("interaction.respond", {
				interactionId: "int_1",
				meta: { idempotencyKey: "auth-response-2" },
			}),
		).toEqual([
			{
				path: "params.response",
				reason: "required",
				message: "Required field is missing",
			},
		]);
	});

	test("worktree.lifecycle params reject missing unknown wrong-type and legacy fields", () => {
		const validCreate = {
			projectCwd: "/repo",
			repoId: "repo-1",
			base: { kind: "branch", value: "main", resolvedOid: "abc123" },
			purpose: "session",
			meta: { idempotencyKey: "create-1" },
		};
		expect(validateRpcV2Params("worktree.create", validCreate)).toEqual([]);
		expect(
			validateRpcV2Params("worktree.create", {
				...validCreate,
				base: { kind: "commit", value: "abc123", resolvedOid: "abc123" },
			}),
		).toEqual([]);

		// missing required
		expect(validateRpcV2Params("worktree.create", { projectCwd: "/repo" })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "params.repoId", reason: "required" }),
				expect.objectContaining({ path: "params.base", reason: "required" }),
				expect.objectContaining({ path: "params.purpose", reason: "required" }),
				expect.objectContaining({ path: "params.meta", reason: "required" }),
			]),
		);

		// legacy sourcePath rejected
		expect(
			validateRpcV2Params("worktree.create", {
				...validCreate,
				sourcePath: "/legacy-must-reject",
			}),
		).toContainEqual({
			path: "params.sourcePath",
			reason: "unknown_field",
			message: "Unknown field is not allowed",
		});

		// base.kind: tag/ref/blob 均非法（仅 branch|commit）
		for (const kind of ["tag", "ref", "blob"]) {
			expect(
				validateRpcV2Params("worktree.create", {
					...validCreate,
					base: { kind, value: "x", resolvedOid: "y" },
				}),
			).toContainEqual(
				expect.objectContaining({
					path: "params.base.kind",
					reason: "invalid_enum",
				}),
			);
		}

		expect(validateRpcV2Params("worktree.get", { worktreeId: "wt_1" })).toEqual([]);
		expect(validateRpcV2Params("worktree.list", { state: "ready" })).toEqual([]);
		expect(validateRpcV2Params("worktree.list", { states: ["ready", "archived"] })).toEqual([]);

		// archive 冻结：expectedRevision + retainChanges；拒绝 force/reason
		expect(
			validateRpcV2Params("worktree.archive", {
				worktreeId: "wt_1",
				expectedRevision: 9,
				retainChanges: true,
				meta: { idempotencyKey: "arch-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.archive", {
				worktreeId: "wt_1",
				expectedRevision: 1,
				meta: { idempotencyKey: "arch-2" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.archive", {
				worktreeId: "wt_1",
				force: true,
				reason: "cleanup",
				meta: { idempotencyKey: "arch-legacy" },
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "params.expectedRevision", reason: "required" }),
				expect.objectContaining({ path: "params.force", reason: "unknown_field" }),
				expect.objectContaining({ path: "params.reason", reason: "unknown_field" }),
			]),
		);

		// apply.prepare 冻结字段
		expect(
			validateRpcV2Params("worktree.apply.prepare", {
				worktreeId: "wt_1",
				expectedWorktreeRevision: 4,
				expectedTargetSnapshotId: "snap-target",
				strategy: "patch",
				meta: { idempotencyKey: "prep-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.apply.prepare", {
				worktreeId: "wt_1",
				sourceSnapshot: "old",
				targetSnapshot: "old",
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "params.expectedWorktreeRevision", reason: "required" }),
				expect.objectContaining({ path: "params.expectedTargetSnapshotId", reason: "required" }),
				expect.objectContaining({ path: "params.strategy", reason: "required" }),
				expect.objectContaining({ path: "params.meta", reason: "required" }),
				expect.objectContaining({ path: "params.sourceSnapshot", reason: "unknown_field" }),
				expect.objectContaining({ path: "params.targetSnapshot", reason: "unknown_field" }),
			]),
		);

		// apply：无 worktreeId；强制 planId + expectedWorktreeRevision + expectedTargetSnapshotId + meta
		expect(
			validateRpcV2Params("worktree.apply", {
				planId: "plan_1",
				expectedWorktreeRevision: 4,
				expectedTargetSnapshotId: "snap-target",
				meta: { idempotencyKey: "apply-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.apply", {
				worktreeId: "wt_1",
				planId: "plan_1",
				expectedRevision: 1,
				targetSnapshot: "old",
				meta: { idempotencyKey: "apply-legacy" },
			}),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "params.expectedWorktreeRevision", reason: "required" }),
				expect.objectContaining({ path: "params.expectedTargetSnapshotId", reason: "required" }),
				expect.objectContaining({ path: "params.worktreeId", reason: "unknown_field" }),
				expect.objectContaining({ path: "params.expectedRevision", reason: "unknown_field" }),
				expect.objectContaining({ path: "params.targetSnapshot", reason: "unknown_field" }),
			]),
		);

		expect(
			validateRpcV2Params("worktree.setup.start", {
				worktreeId: "wt_1",
				setupActionId: "setup-a",
				meta: { idempotencyKey: "setup-1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.setup.start", {
				worktreeId: "wt_1",
				params: { x: 1 },
				meta: { idempotencyKey: "setup-legacy" },
			}),
		).toContainEqual({
			path: "params.params",
			reason: "unknown_field",
			message: "Unknown field is not allowed",
		});
	});

	test("worktree methods are registered on the method catalog", () => {
		for (const method of [
			"worktree.create",
			"worktree.get",
			"worktree.list",
			"worktree.setup.start",
			"worktree.setup.cancel",
			"worktree.apply.prepare",
			"worktree.apply",
			"worktree.archive",
		]) {
			expect(RPC_V2_METHODS).toContain(method);
			expect(paramsSchemaForMethod(method)).toBeDefined();
			expect(paramsSchemaForMethod(method)?.additionalProperties).toBe(false);
		}
	});

	test("keeps the generated schema artifact byte-equivalent to the runtime schema", async () => {
		const generated = await Bun.file(new URL("../../src/modes/rpc-v2/rpc-v2.schema.json", import.meta.url)).json();
		expect(generated).toEqual(RPC_V2_SCHEMA);
	});
});
