/**
 * Wire-only focused tests for worktree.lifecycle v1（Desktop 冻结合同）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWorktreePathRef,
	decodeWorktreePathRef,
	MANAGED_WORKTREE_STATES,
	parseWorktreePathRef,
	WORKTREE_EVENT_METHODS,
	WORKTREE_LIFECYCLE_METHODS,
	WORKTREE_PATH_REF_PREFIX,
	type WorktreeLifecycleCapabilityDetails,
} from "../../src/modes/rpc-v2/dto/worktree";
import { buildServerCapabilities } from "../../src/modes/rpc-v2/protocol/capabilities";
import {
	RPC_V2_METHOD_BY_NAME,
	RPC_V2_METHODS,
	RPC_V2_MUTATION_METHODS,
} from "../../src/modes/rpc-v2/protocol/methods";
import { paramsSchemaForMethod, RPC_V2_SCHEMA } from "../../src/modes/rpc-v2/protocol/schema";
import { validateRpcV2Params } from "../../src/modes/rpc-v2/protocol/validate";
import { resolveWorktreeCapability } from "../../src/modes/rpc-v2/rpc-v2-mode";
import { WorktreeLifecycleService } from "../../src/modes/rpc-v2/worktree-lifecycle";

describe("worktree wire surface", () => {
	test("pathRef freeze round-trips absolute UTF-8 path", () => {
		const absolutePath = "/Users/example/proj/repo with space";
		const ref = buildWorktreePathRef("env-abc", absolutePath);
		expect(ref.startsWith(WORKTREE_PATH_REF_PREFIX)).toBe(true);
		expect(ref).toContain("env-abc/");
		const parsed = parseWorktreePathRef(ref);
		expect(parsed).not.toBeNull();
		expect(parsed!.environmentId).toBe("env-abc");
		expect(parsed!.schemeVersion).toBe("v1");
		const decoded = decodeWorktreePathRef(ref);
		expect(decoded).toEqual({ environmentId: "env-abc", absolutePath });
		expect(parseWorktreePathRef("workspace://managed/worktree-1")).toBeNull();
		expect(parseWorktreePathRef("http://nope")).toBeNull();
	});

	test("managed states and 8 methods are frozen", () => {
		expect(MANAGED_WORKTREE_STATES).toEqual([
			"creating",
			"setup_pending",
			"ready",
			"in_use",
			"dirty",
			"applying",
			"conflicted",
			"archiving",
			"archived",
			"failed",
		]);
		expect([...WORKTREE_LIFECYCLE_METHODS]).toEqual([
			"worktree.create",
			"worktree.get",
			"worktree.list",
			"worktree.setup.start",
			"worktree.setup.cancel",
			"worktree.apply.prepare",
			"worktree.apply",
			"worktree.archive",
		]);
		for (const method of WORKTREE_LIFECYCLE_METHODS) {
			expect(RPC_V2_METHODS).toContain(method);
			const def = RPC_V2_METHOD_BY_NAME.get(method);
			expect(def?.capability).toBe("worktree.lifecycle");
			expect(paramsSchemaForMethod(method)?.additionalProperties).toBe(false);
		}
		expect(RPC_V2_MUTATION_METHODS.has("worktree.create")).toBe(true);
		expect(RPC_V2_MUTATION_METHODS.has("worktree.archive")).toBe(true);
		// prepare 只读，不得进入 mutation 集合
		expect(RPC_V2_MUTATION_METHODS.has("worktree.apply.prepare")).toBe(false);
		expect(RPC_V2_MUTATION_METHODS.has("worktree.get")).toBe(false);
		expect(RPC_V2_MUTATION_METHODS.has("worktree.list")).toBe(false);
	});

	test("§6.7 multi notification methods replace single worktree.lifecycle event", () => {
		expect([...WORKTREE_EVENT_METHODS]).toEqual([
			"worktree.created",
			"worktree.state.changed",
			"worktree.setup.started",
			"worktree.setup.completed",
			"worktree.apply.started",
			"worktree.apply.completed",
			"worktree.apply.conflicted",
			"worktree.archived",
		]);
		const eventTypes = (RPC_V2_SCHEMA.meta as { eventTypes: string[] }).eventTypes;
		for (const method of WORKTREE_EVENT_METHODS) {
			expect(eventTypes).toContain(method);
		}
		// 禁止旧单一 notification
		expect(eventTypes).not.toContain("worktree.lifecycle");
		// capability 名仍为 worktree.lifecycle（方法目录 capability key）
		expect(RPC_V2_METHOD_BY_NAME.get("worktree.create")?.capability).toBe("worktree.lifecycle");
	});

	test("default server capability is unavailable until mode overrides with recoveryReady", () => {
		const caps = buildServerCapabilities();
		expect(caps["worktree.lifecycle"].status).toBe("unavailable");
		expect(caps["worktree.lifecycle"].reasonCode).toBe("WORKTREE_SERVICE_NOT_READY");
	});

	test("stub core must not advertise setup/apply features true", () => {
		const service = new WorktreeLifecycleService({
			stateDir: `/tmp/san-wt-wire-cap-${Date.now()}`,
		});
		const cap = service.capabilityDescriptor();
		expect(cap.setupAvailable).toBe(false);
		expect(cap.applyAvailable).toBe(false);
		expect(cap.limits.strategies).toEqual([]);
		const recoveryReady = cap && typeof cap === "object" && "recoveryReady" in cap ? cap.recoveryReady : undefined;
		// ensureLoaded 前 recoveryReady 为 false；不得在无端口时宣称 setup/apply
		expect(recoveryReady).not.toBe(true);
		expect(cap.setupAvailable).toBe(false);
		expect(cap.applyAvailable).toBe(false);
	});

	test("resolveWorktreeCapability maps real recovery/apply/setup without true override", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "san-wt-wire-resolve-"));
		try {
			const service = new WorktreeLifecycleService({ stateDir });
			// 未 ensureLoaded：不得 available；禁止 true override 路径
			const before = resolveWorktreeCapability(service);
			expect(before.status).toBe("unavailable");
			expect(before.reasonCode).toBe("WORKTREE_SERVICE_NOT_READY");
			expect((before.details as { recoveryReady?: boolean } | undefined)?.recoveryReady).not.toBe(true);
			expect((before.details as { applyAvailable?: boolean } | undefined)?.applyAvailable).toBe(false);
			expect((before.details as { setupAvailable?: boolean } | undefined)?.setupAvailable).toBe(false);
			expect(
				(before.details as { limits?: { strategies?: string[] } } | undefined)?.limits?.strategies ?? [],
			).toEqual([]);

			await service.ensureLoaded();
			const after = resolveWorktreeCapability(service, { ready: false, hasRequiredTools: () => false });
			expect(after.status).toBe("available");
			const details = after.details as {
				recoveryReady?: boolean;
				applyAvailable?: boolean;
				setupAvailable?: boolean;
				limits?: { strategies?: string[] };
			};
			expect(details.recoveryReady).toBe(true);
			// 无 ready applyPort / setupHost → false（不得硬编码 applyAvailable 或 true override）
			expect(details.applyAvailable).toBe(false);
			expect(details.setupAvailable).toBe(false);
			expect(details.limits?.strategies).toEqual([]);

			const withApply = new WorktreeLifecycleService({
				stateDir: join(stateDir, "with-apply"),
				applyPort: {
					ready: true,
					strategies: ["patch"],
					async apply() {
						return { worktree: {} as never };
					},
				},
			});
			await withApply.ensureLoaded();
			const mapped = resolveWorktreeCapability(withApply, {
				ready: true,
				hasRequiredTools: () => true,
			});
			const mappedDetails = mapped.details as {
				applyAvailable?: boolean;
				setupAvailable?: boolean;
				recoveryReady?: boolean;
				limits?: { strategies?: string[] };
			};
			expect(mappedDetails.recoveryReady).toBe(true);
			expect(mappedDetails.applyAvailable).toBe(true);
			expect(mappedDetails.setupAvailable).toBe(true);
			expect(mappedDetails.limits?.strategies).toEqual(["patch"]);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	test("resolveWorktreeCapability preserves unresolved degraded recovery", () => {
		const unresolved = {
			operationId: "op_unknown",
			kind: "setup.start" as const,
			worktreeId: "wt_unknown",
		};
		const degradedService = {
			capabilityDescriptor: (): WorktreeLifecycleCapabilityDetails => ({
				name: "worktree.lifecycle",
				version: 1,
				methods: [...WORKTREE_LIFECYCLE_METHODS],
				setupAvailable: true,
				applyAvailable: false,
				recoveryReady: true,
				limits: {
					maxWorktrees: 32,
					maxConcurrentCreates: 4,
					applyPlanTtlMs: 15 * 60 * 1000,
					strategies: [],
				},
				status: "degraded",
				unresolvedUnknownOperations: [unresolved],
			}),
		} as unknown as WorktreeLifecycleService;

		const mapped = resolveWorktreeCapability(degradedService);
		expect(mapped.status).toBe("degraded");
		expect(mapped.reasonCode).toBe("WORKTREE_RECOVERY_DEGRADED");
		expect((mapped.details as unknown as WorktreeLifecycleCapabilityDetails).unresolvedUnknownOperations).toEqual([
			unresolved,
		]);
	});

	test("create/archive/apply freeze contracts", () => {
		expect(
			validateRpcV2Params("worktree.create", {
				projectCwd: "/repo",
				repoId: "repo-1",
				base: { kind: "branch", value: "main", resolvedOid: "deadbeef" },
				purpose: "session",
				meta: { idempotencyKey: "k1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.archive", {
				worktreeId: "wt_1",
				expectedRevision: 3,
				retainChanges: false,
				meta: { idempotencyKey: "a1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.apply", {
				planId: "p1",
				expectedWorktreeRevision: 2,
				expectedTargetSnapshotId: "tgt",
				meta: { idempotencyKey: "ap1" },
			}),
		).toEqual([]);
		expect(
			validateRpcV2Params("worktree.apply.prepare", {
				worktreeId: "wt_1",
				expectedWorktreeRevision: 2,
				expectedTargetSnapshotId: "tgt",
				strategy: "merge_commit",
				meta: { idempotencyKey: "pr1" },
			}),
		).toEqual([]);
	});
});
