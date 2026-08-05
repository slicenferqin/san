/**
 * Contract tests for Managed Worktree lifecycle (worktree.lifecycle v1)。
 * 覆盖真实 create→list→archive、幂等、跨 environment、dirty/active 拒绝、
 * path escape、revision conflict、缺 setup/apply 端口、journal/restart 恢复、冻结事件。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateManagedWorktreeParams } from "../../src/modes/rpc-v2/dto/worktree";
import {
	hashParams,
	WORKTREE_LIFECYCLE_V1_LIMITS,
	WorktreeError,
	type WorktreeEventEnvelope,
	WorktreeLifecycleService,
} from "../../src/modes/rpc-v2/worktree-lifecycle";

async function tempStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "san-wt-lifecycle-"));
}

async function initGitRepo(repoPath: string): Promise<string> {
	await mkdir(repoPath, { recursive: true });
	await writeFile(join(repoPath, "README.md"), "# source\n", "utf8");
	const run = async (argv: string[]) => {
		const proc = Bun.spawn(["git", ...argv], {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) {
			throw new Error(`git ${argv.join(" ")} failed: ${stderr || stdout}`);
		}
		return stdout.trim();
	};
	await run(["init"]);
	await run(["config", "user.email", "test@example.com"]);
	await run(["config", "user.name", "Test"]);
	await run(["add", "README.md"]);
	await run(["commit", "-m", "init"]);
	const oid = await run(["rev-parse", "HEAD"]);
	// 确保有 main/master 分支名
	try {
		await run(["branch", "-M", "main"]);
	} catch {
		// ignore
	}
	return oid;
}

function createParams(
	projectCwd: string,
	oid: string,
	idempotencyKey: string,
	extra?: Partial<CreateManagedWorktreeParams>,
): CreateManagedWorktreeParams {
	return {
		projectCwd,
		repoId: "repo-1",
		base: { kind: "commit", value: oid, resolvedOid: oid },
		purpose: "session",
		meta: { idempotencyKey },
		...extra,
	};
}

describe("worktree.lifecycle v1", () => {
	let stateDir: string;
	let sourcePath: string;
	let baseOid: string;
	let events: WorktreeEventEnvelope[];
	let service: WorktreeLifecycleService;
	let idSeq: number;

	beforeEach(async () => {
		stateDir = await tempStateDir();
		sourcePath = join(stateDir, "source-repo");
		baseOid = await initGitRepo(sourcePath);
		events = [];
		idSeq = 0;
		service = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed"),
			environmentId: "env-test",
			emit: e => events.push(e),
			idFactory: () => `id-${++idSeq}`,
		});
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	test("create → list → archive in real temp git repo", async () => {
		const first = await service.create(createParams(sourcePath, baseOid, "create-real-1"));
		expect(first.replayed).toBe(false);
		expect(first.worktree.state).toBe("ready");
		expect(first.worktree.environmentId).toBe("env-test");
		expect(first.worktree.repoId).toBe("repo-1");
		expect(first.worktree.baseOid).toBe(baseOid);
		expect(first.worktree.pathRef).toContain("san-worktree-path://v1/env-test/");
		expect(first.worktree.displayPath).toContain(join(stateDir, "managed", "worktrees"));

		const listed = await service.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.worktreeId).toBe(first.worktree.worktreeId);

		const archived = await service.archive({
			worktreeId: first.worktree.worktreeId,
			expectedRevision: first.worktree.revision,
			meta: { idempotencyKey: "arch-real-1" },
		});
		expect(archived.worktree.state).toBe("archived");
		expect(archived.replayed).toBe(false);

		const createdEvents = events.filter(e => e.method === "worktree.created");
		expect(createdEvents.length).toBeGreaterThanOrEqual(1);
		expect(createdEvents[0]!.params.terminal).toBe(true);
		expect(createdEvents[0]!.params.worktreeId).toBe(first.worktree.worktreeId);
		expect(createdEvents[0]!.params.operationId).toBe(first.operationId);
		expect(typeof createdEvents[0]!.params.revision).toBe("number");
		expect(typeof createdEvents[0]!.params.timestamp).toBe("string");

		const archivedEvents = events.filter(e => e.method === "worktree.archived");
		expect(archivedEvents.length).toBeGreaterThanOrEqual(1);
		expect(archivedEvents[0]!.params.terminal).toBe(true);
		expect(archivedEvents[0]!.params.state).toBe("archived");
	});

	test("create retry with same idempotency key + params returns same worktree", async () => {
		const key = "create-key-1";
		const params = createParams(sourcePath, baseOid, key);
		const first = await service.create(params);
		const second = await service.create(params);

		expect(second.replayed).toBe(true);
		expect(second.operationId).toBe(first.operationId);
		expect(second.worktree.worktreeId).toBe(first.worktree.worktreeId);
		expect(second.worktree.state).toBe("ready");

		const listed = await service.list();
		const nonArchived = listed.filter(w => w.state !== "archived");
		expect(nonArchived).toHaveLength(1);
		expect(nonArchived[0]!.worktreeId).toBe(first.worktree.worktreeId);
	});

	test("event failure cannot downgrade completed create/archive receipts", async () => {
		const state = join(stateDir, "managed-event-failure");
		let rejectedMethod: WorktreeEventEnvelope["method"] | undefined;
		const withFailingEvents = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-ef-${++idSeq}`,
			emit: event => {
				if (event.method === rejectedMethod) {
					throw new Error(`event sink rejected ${event.method}`);
				}
			},
		});
		const params = createParams(sourcePath, baseOid, "create-event-failure");

		rejectedMethod = "worktree.created";
		await expect(withFailingEvents.create(params)).rejects.toThrow("event sink rejected worktree.created");

		rejectedMethod = undefined;
		const created = await withFailingEvents.create(params);
		expect(created.replayed).toBe(true);
		expect(created.worktree.state).toBe("ready");
		expect(existsSync(created.worktree.displayPath)).toBe(true);

		const archiveParams = {
			worktreeId: created.worktree.worktreeId,
			expectedRevision: created.worktree.revision,
			meta: { idempotencyKey: "archive-event-failure" },
		};
		rejectedMethod = "worktree.archived";
		await expect(withFailingEvents.archive(archiveParams)).rejects.toThrow("event sink rejected worktree.archived");
		expect(existsSync(created.worktree.displayPath)).toBe(false);

		rejectedMethod = undefined;
		const archived = await withFailingEvents.archive(archiveParams);
		expect(archived.replayed).toBe(true);
		expect(archived.worktree.state).toBe("archived");
	});

	test("same idempotency key with different params conflicts", async () => {
		const key = "create-key-conflict";
		await service.create(createParams(sourcePath, baseOid, key, { repoId: "repo-a" }));
		let err: unknown;
		try {
			await service.create(createParams(sourcePath, baseOid, key, { repoId: "repo-b" }));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("IDEMPOTENCY_CONFLICT");
	});

	test("restart recovers environment and idempotent create receipt", async () => {
		const key = "create-key-restart";
		const first = await service.create(createParams(sourcePath, baseOid, key));

		const reloaded = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed"),
			environmentId: "env-test",
			idFactory: () => `id-reloaded-${++idSeq}`,
		});
		await reloaded.reloadFromDisk();

		const got = await reloaded.get(first.worktree.worktreeId);
		expect(got.worktreeId).toBe(first.worktree.worktreeId);
		expect(got.state).toBe("ready");
		expect(got.repoId).toBe("repo-1");

		const replay = await reloaded.create(createParams(sourcePath, baseOid, key));
		expect(replay.replayed).toBe(true);
		expect(replay.worktree.worktreeId).toBe(first.worktree.worktreeId);
		expect(replay.operationId).toBe(first.operationId);

		const listed = await reloaded.list();
		expect(listed.filter(w => w.state !== "archived")).toHaveLength(1);
	});

	test("archive blocked when active session or dirty without retainChanges", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-busy"));
		const id = created.worktree.worktreeId;

		const active = await service.setActiveSessionCount(id, 1);
		let err: unknown;
		try {
			await service.archive({
				worktreeId: id,
				expectedRevision: active.revision,
				meta: { idempotencyKey: "arch-active" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((err as WorktreeError).message).toMatch(/active sessions/i);

		const cleared = await service.setActiveSessionCount(id, 0);
		// 真实文件系统 dirty（setDirty 仅元数据，git remove 仍会成功）
		await writeFile(join(cleared.displayPath, "README.md"), "# dirty on disk\n", "utf8");
		const dirty = await service.setDirty(id, true);
		err = undefined;
		try {
			await service.archive({
				worktreeId: id,
				expectedRevision: dirty.revision,
				meta: { idempotencyKey: "arch-dirty" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((err as WorktreeError).message).toMatch(/dirty/i);

		// dirty + retainChanges：git worktree remove 无 --force 失败 → fail-closed 保留目录
		err = undefined;
		try {
			await service.archive({
				worktreeId: id,
				expectedRevision: dirty.revision,
				retainChanges: true,
				meta: { idempotencyKey: "arch-retain-dirty" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((err as WorktreeError).message).toMatch(/retainChanges|preserved|remove failed/i);
		const afterFail = await service.get(id);
		expect(afterFail.state).toBe("failed");
		expect(existsSync(afterFail.displayPath)).toBe(true);
		// dirty 内容仍在
		const kept = await Bun.file(join(afterFail.displayPath, "README.md")).text();
		expect(kept).toContain("dirty on disk");
	});

	test("archive retainChanges=true on clean worktree succeeds without force rm", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-retain-clean"));
		const id = created.worktree.worktreeId;
		const archived = await service.archive({
			worktreeId: id,
			expectedRevision: created.worktree.revision,
			retainChanges: true,
			meta: { idempotencyKey: "arch-retain-clean" },
		});
		expect(archived.worktree.state).toBe("archived");
		expect(archived.replayed).toBe(false);

		const replay = await service.archive({
			worktreeId: id,
			expectedRevision: created.worktree.revision,
			retainChanges: true,
			meta: { idempotencyKey: "arch-retain-clean" },
		});
		expect(replay.replayed).toBe(true);
		expect(replay.worktree.state).toBe("archived");
	});

	test("setup.start/cancel CAPABILITY_UNAVAILABLE without setup port", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-setup"));
		const id = created.worktree.worktreeId;

		for (const fn of [
			() =>
				service.setupStart({
					worktreeId: id,
					setupActionId: "action-1",
					meta: { idempotencyKey: "setup-1" },
				}),
			() =>
				service.setupCancel({
					worktreeId: id,
					meta: { idempotencyKey: "setup-c1" },
				}),
		]) {
			let err: unknown;
			try {
				await fn();
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("CAPABILITY_UNAVAILABLE");
			expect((err as WorktreeError).details?.feature).toBe("setup");
			expect((err as WorktreeError).details?.available).toBe(false);
		}
	});

	test("setup.cancel durable idempotency: first cancel, same-process replay, conflict, restart replay", async () => {
		let cancelCalls = 0;
		const setupPort = {
			ready: true,
			async start() {
				return { status: "running", processId: "proc-1" };
			},
			async cancel(input: { worktreeId: string; idempotencyKey: string }) {
				cancelCalls += 1;
				expect(input.worktreeId).toBeTruthy();
				expect(input.idempotencyKey).toBeTruthy();
				return { cancelled: true, status: "cancelled" };
			},
		};

		const withPort = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed"),
			environmentId: "env-test",
			emit: e => events.push(e),
			idFactory: () => `id-${++idSeq}`,
			setupPort,
		});

		const created = await withPort.create(
			createParams(sourcePath, baseOid, "k-setup-cancel-create", { setupActionId: "action-setup" }),
		);
		const worktreeId = created.worktree.worktreeId;

		const started = await withPort.setupStart({
			worktreeId,
			setupActionId: "action-setup",
			meta: { idempotencyKey: "setup-start-for-cancel" },
		});
		expect(started.setup.status).toBe("running");

		const first = await withPort.setupCancel({
			worktreeId,
			meta: { idempotencyKey: "setup-cancel-key" },
		});
		expect(first.cancelled).toBe(true);
		expect(first.status).toBe("cancelled");
		expect(first.worktreeId).toBe(worktreeId);
		expect(typeof first.operationId).toBe("string");
		expect(typeof first.revision).toBe("number");
		expect(first.replayed).toBe(false);
		expect(cancelCalls).toBe(1);

		const after = await withPort.get(worktreeId);
		expect(after.setup?.status).toBe("cancelled");
		expect(after.revision).toBe(first.revision);

		// 同进程同 key + 同 params 回放，不二次调用 port
		const replay = await withPort.setupCancel({
			worktreeId,
			meta: { idempotencyKey: "setup-cancel-key" },
		});
		expect(replay.replayed).toBe(true);
		expect(replay.operationId).toBe(first.operationId);
		expect(replay.cancelled).toBe(true);
		expect(replay.status).toBe("cancelled");
		expect(replay.revision).toBe(first.revision);
		expect(cancelCalls).toBe(1);

		// 同 key、不同 worktree → IDEMPOTENCY_CONFLICT
		const other = await withPort.create(
			createParams(sourcePath, baseOid, "k-setup-cancel-other", { setupActionId: "action-other" }),
		);
		let conflictErr: unknown;
		try {
			await withPort.setupCancel({
				worktreeId: other.worktree.worktreeId,
				meta: { idempotencyKey: "setup-cancel-key" },
			});
		} catch (e) {
			conflictErr = e;
		}
		expect(conflictErr).toBeInstanceOf(WorktreeError);
		expect((conflictErr as WorktreeError).code).toBe("IDEMPOTENCY_CONFLICT");
		expect(cancelCalls).toBe(1);

		// 重建 service 后 completed receipt 可 replay，不二次调用 cancel port
		const reloaded = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed"),
			environmentId: "env-test",
			idFactory: () => `id-reloaded-${++idSeq}`,
			setupPort,
		});
		await reloaded.reloadFromDisk();
		const afterRestart = await reloaded.setupCancel({
			worktreeId,
			meta: { idempotencyKey: "setup-cancel-key" },
		});
		expect(afterRestart.replayed).toBe(true);
		expect(afterRestart.operationId).toBe(first.operationId);
		expect(afterRestart.cancelled).toBe(true);
		expect(afterRestart.status).toBe("cancelled");
		expect(cancelCalls).toBe(1);
	});

	test("setup.start persists processId; restart cancel uses durable binding", async () => {
		const seenCancels: Array<{
			worktreeId: string;
			processId?: string;
			expectedRevision?: number;
			idempotencyKey: string;
		}> = [];
		const setupPort = {
			ready: true,
			async start() {
				return { status: "running", processId: "proc-durable", processRevision: 11 };
			},
			async cancel(input: {
				worktreeId: string;
				processId?: string;
				expectedRevision?: number;
				idempotencyKey: string;
			}) {
				seenCancels.push({
					worktreeId: input.worktreeId,
					...(input.processId ? { processId: input.processId } : {}),
					...(typeof input.expectedRevision === "number" ? { expectedRevision: input.expectedRevision } : {}),
					idempotencyKey: input.idempotencyKey,
				});
				return { cancelled: true, status: "cancelled" };
			},
		};

		const withPort = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-durable-proc"),
			environmentId: "env-test",
			idFactory: () => `id-dp-${++idSeq}`,
			setupPort,
		});
		const created = await withPort.create(
			createParams(sourcePath, baseOid, "k-durable-proc-create", { setupActionId: "act-d" }),
		);
		const worktreeId = created.worktree.worktreeId;
		const started = await withPort.setupStart({
			worktreeId,
			setupActionId: "act-d",
			meta: { idempotencyKey: "start-durable-proc" },
		});
		expect(started.setup.processId).toBe("proc-durable");

		const live = await withPort.get(worktreeId);
		expect(live.setup?.processId).toBe("proc-durable");
		expect(live.setup?.processRevision).toBe(11);
		expect(live.setup?.status).toBe("running");

		// 新 process 模拟 crash 后内存 #bound 丢失；仅靠 durable rec.setup
		const reloaded = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-durable-proc"),
			environmentId: "env-test",
			idFactory: () => `id-dp2-${++idSeq}`,
			setupPort,
		});
		await reloaded.reloadFromDisk();
		const afterReload = await reloaded.get(worktreeId);
		expect(afterReload.setup?.processId).toBe("proc-durable");
		expect(afterReload.setup?.processRevision).toBe(11);

		const cancelled = await reloaded.setupCancel({
			worktreeId,
			meta: { idempotencyKey: "cancel-after-restart" },
		});
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.processId).toBe("proc-durable");
		expect(cancelled.replayed).toBe(false);
		expect(seenCancels).toEqual([
			{
				worktreeId,
				processId: "proc-durable",
				expectedRevision: 11,
				idempotencyKey: "cancel-after-restart",
			},
		]);

		const cleared = await reloaded.get(worktreeId);
		expect(cleared.setup?.status).toBe("cancelled");
		expect(cleared.setup?.processId).toBeUndefined();
		expect(cleared.setup?.processRevision).toBeUndefined();
	});

	test("setup.cancel outcome_unknown blocks blind retry", async () => {
		let cancelCalls = 0;
		const enteredCancel = Promise.withResolvers<void>();
		const setupPort = {
			ready: true,
			async start() {
				return { status: "running", processId: "proc-hang" };
			},
			async cancel() {
				cancelCalls += 1;
				// 外部 mutation 已开始；outcome_unknown 已在调用前落盘。
				// 永不 resolve 以模拟 crash / 未知结果，禁止盲重试。
				enteredCancel.resolve();
				const hang = Promise.withResolvers<never>();
				return hang.promise;
			},
		};

		const withPort = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-unknown"),
			environmentId: "env-test",
			idFactory: () => `id-u-${++idSeq}`,
			setupPort,
		});

		const created = await withPort.create(
			createParams(sourcePath, baseOid, "k-cancel-unknown-create", { setupActionId: "act" }),
		);
		const worktreeId = created.worktree.worktreeId;
		await withPort.setupStart({
			worktreeId,
			setupActionId: "act",
			meta: { idempotencyKey: "start-before-unknown" },
		});

		const hanging = withPort.setupCancel({
			worktreeId,
			meta: { idempotencyKey: "cancel-unknown-key" },
		});
		// 等到 port.cancel 入口：此时 outcome_unknown receipt 必已 durable
		await enteredCancel.promise;
		expect(cancelCalls).toBe(1);

		const peer = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-unknown"),
			environmentId: "env-test",
			idFactory: () => `id-u2-${++idSeq}`,
			setupPort: {
				ready: true,
				async start() {
					return { status: "running" };
				},
				async cancel() {
					cancelCalls += 1;
					return { cancelled: true, status: "cancelled" };
				},
			},
		});
		await peer.reloadFromDisk();

		let unknownErr: unknown;
		try {
			await peer.setupCancel({
				worktreeId,
				meta: { idempotencyKey: "cancel-unknown-key" },
			});
		} catch (e) {
			unknownErr = e;
		}
		expect(unknownErr).toBeInstanceOf(WorktreeError);
		expect((unknownErr as WorktreeError).code).toBe("OUTCOME_UNKNOWN");
		// 不得盲重试外部 cancel
		expect(cancelCalls).toBe(1);
		void hanging;
	});

	test("setup.cancel port failure writes failed receipt and replays error", async () => {
		let cancelCalls = 0;
		const setupPort = {
			ready: true,
			async start() {
				return { status: "running", processId: "proc-fail" };
			},
			async cancel() {
				cancelCalls += 1;
				throw new WorktreeError("PRECONDITION_FAILED", "setup process not bound", {
					feature: "setup",
				});
			},
		};

		const withPort = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-fail"),
			environmentId: "env-test",
			idFactory: () => `id-f-${++idSeq}`,
			setupPort,
		});

		const created = await withPort.create(
			createParams(sourcePath, baseOid, "k-cancel-fail-create", { setupActionId: "act-fail" }),
		);
		const worktreeId = created.worktree.worktreeId;

		let firstErr: unknown;
		try {
			await withPort.setupCancel({
				worktreeId,
				meta: { idempotencyKey: "cancel-fail-key" },
			});
		} catch (e) {
			firstErr = e;
		}
		expect(firstErr).toBeInstanceOf(WorktreeError);
		expect((firstErr as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect(cancelCalls).toBe(1);

		// 同 key 回放 failed，不再调用 port
		let replayErr: unknown;
		try {
			await withPort.setupCancel({
				worktreeId,
				meta: { idempotencyKey: "cancel-fail-key" },
			});
		} catch (e) {
			replayErr = e;
		}
		expect(replayErr).toBeInstanceOf(WorktreeError);
		expect((replayErr as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((replayErr as WorktreeError).details?.replayed).toBe(true);
		expect(cancelCalls).toBe(1);
	});

	test("event failure cannot downgrade completed setup receipts", async () => {
		let startCalls = 0;
		let cancelCalls = 0;
		let rejectedReason: string | undefined;
		const setupPort = {
			ready: true,
			async start() {
				startCalls += 1;
				return { status: "running", processId: "proc-event", processRevision: 4 };
			},
			async cancel() {
				cancelCalls += 1;
				return { cancelled: true, status: "cancelled" };
			},
		};
		const withFailingEvents = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-setup-event-failure"),
			environmentId: "env-test",
			idFactory: () => `id-sef-${++idSeq}`,
			setupPort,
			emit: event => {
				if (event.params.reason === rejectedReason) {
					throw new Error(`event sink rejected ${event.params.reason}`);
				}
			},
		});
		const created = await withFailingEvents.create(
			createParams(sourcePath, baseOid, "setup-event-create", { setupActionId: "bootstrap" }),
		);
		const startParams = {
			worktreeId: created.worktree.worktreeId,
			setupActionId: "bootstrap",
			meta: { idempotencyKey: "setup-event-start" },
		};

		rejectedReason = "setup.started";
		await expect(withFailingEvents.setupStart(startParams)).rejects.toThrow("event sink rejected setup.started");
		rejectedReason = undefined;
		const started = await withFailingEvents.setupStart(startParams);
		expect(started.replayed).toBe(true);
		expect(started.setup.processId).toBe("proc-event");
		expect(startCalls).toBe(1);

		const cancelParams = {
			worktreeId: created.worktree.worktreeId,
			meta: { idempotencyKey: "setup-event-cancel" },
		};
		rejectedReason = "setup.cancelled";
		await expect(withFailingEvents.setupCancel(cancelParams)).rejects.toThrow("event sink rejected setup.cancelled");
		rejectedReason = undefined;
		const cancelled = await withFailingEvents.setupCancel(cancelParams);
		expect(cancelled.replayed).toBe(true);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelCalls).toBe(1);
	});

	test("reload reconciles setup terminal state when receipt stayed outcome_unknown", async () => {
		const state = join(stateDir, "managed-setup-terminal-reconcile");
		let startCalls = 0;
		let cancelCalls = 0;
		const setupPort = {
			ready: true,
			async start() {
				startCalls += 1;
				return { status: "running", processId: "proc-reconcile", processRevision: 7 };
			},
			async cancel() {
				cancelCalls += 1;
				return { cancelled: true, status: "cancelled" };
			},
		};
		const forceReceiptUnknown = async (operationId: string): Promise<void> => {
			const receiptPath = join(state, "receipts", `${operationId}.json`);
			const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
			receipt.outcome = "outcome_unknown";
			delete receipt.result;
			delete receipt.error;
			await writeFile(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
		};

		const first = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-str-${++idSeq}`,
			setupPort,
		});
		const created = await first.create(
			createParams(sourcePath, baseOid, "setup-reconcile-create", { setupActionId: "bootstrap" }),
		);
		const startParams = {
			worktreeId: created.worktree.worktreeId,
			setupActionId: "bootstrap",
			meta: { idempotencyKey: "setup-reconcile-start" },
		};
		const started = await first.setupStart(startParams);
		await forceReceiptUnknown(started.operationId);

		const afterStartCrash = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-str2-${++idSeq}`,
			setupPort,
		});
		await afterStartCrash.reloadFromDisk();
		expect(afterStartCrash.capabilityDescriptor().status).toBe("available");
		const replayedStart = await afterStartCrash.setupStart(startParams);
		expect(replayedStart.replayed).toBe(true);
		expect(replayedStart.setup.processId).toBe("proc-reconcile");
		expect(startCalls).toBe(1);

		const cancelParams = {
			worktreeId: created.worktree.worktreeId,
			meta: { idempotencyKey: "setup-reconcile-cancel" },
		};
		const cancelled = await afterStartCrash.setupCancel(cancelParams);
		await forceReceiptUnknown(cancelled.operationId);

		const afterCancelCrash = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-str3-${++idSeq}`,
			setupPort,
		});
		await afterCancelCrash.reloadFromDisk();
		expect(afterCancelCrash.capabilityDescriptor().status).toBe("available");
		const replayedCancel = await afterCancelCrash.setupCancel(cancelParams);
		expect(replayedCancel.replayed).toBe(true);
		expect(replayedCancel.status).toBe("cancelled");
		expect(cancelCalls).toBe(1);
	});

	test("setup OUTCOME_UNKNOWN degrades capability without blind retry", async () => {
		let startCalls = 0;
		const withUnknownSetup = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-setup-explicit-unknown"),
			environmentId: "env-test",
			idFactory: () => `id-seu-${++idSeq}`,
			setupPort: {
				ready: true,
				async start() {
					startCalls += 1;
					throw new WorktreeError("OUTCOME_UNKNOWN", "desktop response was lost");
				},
				async cancel() {
					return { cancelled: true, status: "cancelled" };
				},
			},
		});
		const created = await withUnknownSetup.create(
			createParams(sourcePath, baseOid, "setup-explicit-unknown-create", {
				setupActionId: "bootstrap",
			}),
		);
		const params = {
			worktreeId: created.worktree.worktreeId,
			setupActionId: "bootstrap",
			meta: { idempotencyKey: "setup-explicit-unknown-start" },
		};

		await expect(withUnknownSetup.setupStart(params)).rejects.toMatchObject({
			code: "OUTCOME_UNKNOWN",
		});
		const capability = withUnknownSetup.capabilityDescriptor() as {
			status?: string;
			unresolvedUnknownOperations?: Array<{ operationId: string; kind: string }>;
		};
		expect(capability.status).toBe("degraded");
		expect(capability.unresolvedUnknownOperations).toHaveLength(1);
		expect(capability.unresolvedUnknownOperations?.[0]?.kind).toBe("setup.start");

		await expect(withUnknownSetup.setupStart(params)).rejects.toMatchObject({
			code: "OUTCOME_UNKNOWN",
		});
		expect(startCalls).toBe(1);
	});

	test("apply.prepare is read-only with TTL; apply CAPABILITY_UNAVAILABLE without apply port", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-apply"));
		const id = created.worktree.worktreeId;
		const plan = await service.prepare({
			worktreeId: id,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-snap-1",
			strategy: "merge_commit",
			meta: { idempotencyKey: "prep-1" },
		});
		expect(plan.worktreeId).toBe(id);
		expect(plan.sourceSnapshotId).toContain(id);
		expect(plan.targetSnapshotId).toBe("tgt-snap-1");
		expect(plan.targetRepoId).toBe("repo-1");
		expect(plan.strategy).toBe("merge_commit");
		expect(Date.parse(plan.expiresAt)).toBeGreaterThan(Date.now());
		expect(Array.isArray(plan.files)).toBe(true);
		expect(Array.isArray(plan.conflicts)).toBe(true);
		// 干净 worktree：空 inventory 合法（真实 status），不是固定 synthetic success
		expect(plan.files).toEqual([]);
		expect(plan.conflicts).toEqual([]);

		let err: unknown;
		try {
			await service.apply({
				planId: plan.planId,
				expectedWorktreeRevision: created.worktree.revision,
				expectedTargetSnapshotId: "tgt-snap-1",
				meta: { idempotencyKey: "apply-1" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CAPABILITY_UNAVAILABLE");
		expect((err as WorktreeError).details?.feature).toBe("apply");
		expect((err as WorktreeError).details?.available).toBe(false);

		// 仍 ready — 无伪造成功；prepare 不 revision++
		const got = await service.get(id);
		expect(got.state).toBe("ready");
		expect(got.revision).toBe(created.worktree.revision);
	});

	test("apply.prepare returns real non-empty inventory from dirty worktree", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-apply-dirty"));
		const id = created.worktree.worktreeId;
		const wtPath = created.worktree.displayPath;
		const revBefore = created.worktree.revision;

		await writeFile(join(wtPath, "README.md"), "# dirty source\n", "utf8");
		await writeFile(join(wtPath, "new-file.txt"), "added\n", "utf8");

		const plan = await service.prepare({
			worktreeId: id,
			expectedWorktreeRevision: revBefore,
			expectedTargetSnapshotId: "tgt-dirty",
			strategy: "patch",
			meta: { idempotencyKey: "prep-dirty" },
		});

		expect(plan.files.length).toBeGreaterThan(0);
		expect(plan.files.every(f => typeof f.fileChangeId === "string" && f.fileChangeId.length === 64)).toBe(true);
		expect(plan.files.every(f => typeof f.status === "string" && f.status.length > 0)).toBe(true);
		const statuses = new Set(plan.files.map(f => f.status));
		expect(statuses.has("modified") || statuses.has("untracked") || statuses.has("added")).toBe(true);
		// 不得固定空成功
		expect(plan.files).not.toEqual([]);
		// prepare 绑定的 expectedWorktreeRevision 仍为 prepare 前 revision
		expect(plan.sourceSnapshotId).toMatch(new RegExp(`^wt:${id}@[0-9a-f]+$`));

		const after = await service.get(id);
		expect(after.dirty).toBe(true);
		expect(after.state === "dirty" || after.state === "ready" || after.state === "conflicted").toBe(true);
		// git 只读投影：dirty 更新不 revision++，CAS 合同保持
		expect(after.revision).toBe(revBefore);
	});

	test("apply.prepare missing worktree path is typed precondition failure not empty success", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-apply-missing"));
		const id = created.worktree.worktreeId;
		const wtPath = created.worktree.displayPath;
		await rm(wtPath, { recursive: true, force: true });

		let err: unknown;
		try {
			await service.prepare({
				worktreeId: id,
				expectedWorktreeRevision: created.worktree.revision,
				expectedTargetSnapshotId: "tgt-missing",
				strategy: "patch",
				meta: { idempotencyKey: "prep-missing" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((err as WorktreeError).message).toMatch(/does not exist|apply\.prepare/i);
	});

	test("applyPort.ready maps applyAvailable and strategies; !ready stays unavailable empty strategies", async () => {
		const withApply = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-apply-cap"),
			environmentId: "env-test",
			idFactory: () => `id-ap-${++idSeq}`,
			applyPort: {
				ready: true,
				strategies: ["patch"],
				async apply() {
					throw new WorktreeError("INTERNAL", "apply port should not be invoked in this test");
				},
			},
		});
		await withApply.ensureLoaded();
		const cap = withApply.capabilityDescriptor();
		expect(cap.recoveryReady).toBe(true);
		expect(cap.applyAvailable).toBe(true);
		expect(cap.setupAvailable).toBe(false);
		expect(cap.limits.strategies).toEqual(["patch"]);

		const readyNoStrategies = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-apply-ready-empty"),
			environmentId: "env-test",
			idFactory: () => `id-ape-${++idSeq}`,
			applyPort: {
				ready: true,
				strategies: [],
				async apply() {
					return { worktree: {} as never };
				},
			},
		});
		await readyNoStrategies.ensureLoaded();
		expect(readyNoStrategies.capabilityDescriptor().applyAvailable).toBe(true);
		// ready 但未声明策略 => 不得默认广告 patch/merge_commit
		expect(readyNoStrategies.capabilityDescriptor().limits.strategies).toEqual([]);

		const notReady = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-apply-not-ready"),
			environmentId: "env-test",
			idFactory: () => `id-apn-${++idSeq}`,
			applyPort: {
				ready: false,
				strategies: ["patch", "merge_commit"],
				async apply() {
					return { worktree: {} as never };
				},
			},
		});
		await notReady.ensureLoaded();
		expect(notReady.capabilityDescriptor().applyAvailable).toBe(false);
		expect(notReady.capabilityDescriptor().limits.strategies).toEqual([]);

		const created = await notReady.create(createParams(sourcePath, baseOid, "k-apply-nr"));
		const plan = await notReady.prepare({
			worktreeId: created.worktree.worktreeId,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-nr",
			strategy: "patch",
			meta: { idempotencyKey: "prep-nr" },
		});
		let err: unknown;
		try {
			await notReady.apply({
				planId: plan.planId,
				expectedWorktreeRevision: created.worktree.revision,
				expectedTargetSnapshotId: "tgt-nr",
				meta: { idempotencyKey: "apply-nr" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CAPABILITY_UNAVAILABLE");
	});

	test("event failure cannot downgrade a completed apply receipt", async () => {
		let applyCalls = 0;
		let rejectApplyCompleted = false;
		const withApply = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-apply-event-failure"),
			environmentId: "env-test",
			idFactory: () => `id-aef-${++idSeq}`,
			emit: event => {
				if (rejectApplyCompleted && event.method === "worktree.apply.completed") {
					throw new Error("event sink rejected worktree.apply.completed");
				}
			},
			applyPort: {
				ready: true,
				strategies: ["patch"],
				async apply(input) {
					applyCalls += 1;
					return {
						worktree: { ...input.worktree, state: "ready" as const, dirty: false },
					};
				},
			},
		});
		const created = await withApply.create(createParams(sourcePath, baseOid, "apply-event-create"));
		const plan = await withApply.prepare({
			worktreeId: created.worktree.worktreeId,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "target-event-failure",
			strategy: "patch",
			meta: { idempotencyKey: "apply-event-prepare" },
		});
		const applyParams = {
			planId: plan.planId,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "target-event-failure",
			meta: { idempotencyKey: "apply-event-run" },
		};

		rejectApplyCompleted = true;
		await expect(withApply.apply(applyParams)).rejects.toThrow("event sink rejected worktree.apply.completed");
		rejectApplyCompleted = false;
		const replayed = await withApply.apply(applyParams);
		expect(replayed.replayed).toBe(true);
		expect(replayed.worktree.state).toBe("ready");
		expect(applyCalls).toBe(1);
	});

	test("apply validates plan revision/snapshot mismatch", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-apply-val"));
		const id = created.worktree.worktreeId;
		const plan = await service.prepare({
			worktreeId: id,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-ok",
			strategy: "patch",
			meta: { idempotencyKey: "prep-val" },
		});

		let err: unknown;
		try {
			await service.apply({
				planId: plan.planId,
				expectedWorktreeRevision: created.worktree.revision + 99,
				expectedTargetSnapshotId: "tgt-ok",
				meta: { idempotencyKey: "apply-bad-rev" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CONFLICT");

		err = undefined;
		try {
			await service.apply({
				planId: plan.planId,
				expectedWorktreeRevision: created.worktree.revision,
				expectedTargetSnapshotId: "wrong-snapshot",
				meta: { idempotencyKey: "apply-bad-snap" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CONFLICT");
	});

	test("archive expectedRevision conflict", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-rev-conflict"));
		let err: unknown;
		try {
			await service.archive({
				worktreeId: created.worktree.worktreeId,
				expectedRevision: created.worktree.revision + 5,
				meta: { idempotencyKey: "arch-bad-rev" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("CONFLICT");
	});

	test("unpinned service adopts durable environment across process restarts", async () => {
		// 模拟主探针修复后：mode 不传 runtimeId；process1 空盘生成稳定 ID，
		// process2 完全新进程（未 pin）必须 adopt 并 replay，不得 IDEMPOTENCY_CONFLICT。
		const key = "create-cross-runtime-replay";
		const process1 = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-rt"),
			idFactory: () => `id-rt1-${++idSeq}`,
		});
		const first = await process1.create(createParams(sourcePath, baseOid, key));
		expect(first.replayed).toBe(false);
		const durableEnv = process1.environmentId;
		expect(durableEnv.startsWith("env_")).toBe(true);
		expect(first.worktree.environmentId).toBe(durableEnv);

		const process2 = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-rt"),
			idFactory: () => `id-rt2-${++idSeq}`,
		});
		await process2.reloadFromDisk();
		expect(process2.environmentId).toBe(durableEnv);

		const got = await process2.get(first.worktree.worktreeId);
		expect(got.worktreeId).toBe(first.worktree.worktreeId);
		expect(got.environmentId).toBe(durableEnv);
		expect(got.state).toBe("ready");

		const listed = await process2.list();
		expect(listed.map(w => w.worktreeId)).toContain(first.worktree.worktreeId);

		const replay = await process2.create(createParams(sourcePath, baseOid, key));
		expect(replay.replayed).toBe(true);
		expect(replay.operationId).toBe(first.operationId);
		expect(replay.worktree.worktreeId).toBe(first.worktree.worktreeId);

		const archived = await process2.archive({
			worktreeId: first.worktree.worktreeId,
			expectedRevision: got.revision,
			meta: { idempotencyKey: "arch-cross-rt" },
		});
		expect(archived.worktree.state).toBe("archived");
		expect(archived.worktree.worktreeId).toBe(first.worktree.worktreeId);
	});

	test("unpinned adopts legacy rt_* environment.json from prior runtime-bound writes", async () => {
		// 旧 mode 曾把 runtimeId 写入 environment.json；新 mode 未 pin 必须 adopt。
		const process1 = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-legacy"),
			environmentId: "rt_legacy_abc",
			idFactory: () => `id-leg1-${++idSeq}`,
		});
		const created = await process1.create(createParams(sourcePath, baseOid, "k-legacy-env"));
		expect(created.worktree.environmentId).toBe("rt_legacy_abc");

		const process2 = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-legacy"),
			idFactory: () => `id-leg2-${++idSeq}`,
		});
		await process2.reloadFromDisk();
		expect(process2.environmentId).toBe("rt_legacy_abc");
		const got = await process2.get(created.worktree.worktreeId);
		expect(got.worktreeId).toBe(created.worktree.worktreeId);
		const listed = await process2.list();
		expect(listed).toHaveLength(1);

		const replay = await process2.create(createParams(sourcePath, baseOid, "k-legacy-env"));
		expect(replay.replayed).toBe(true);
		expect(replay.operationId).toBe(created.operationId);
	});

	test("explicit environmentId pin keeps cross-environment rejection on get", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-cross-env"));
		expect(created.worktree.environmentId).toBe("env-test");
		const other = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed"),
			environmentId: "env-other",
			idFactory: () => `id-other-${++idSeq}`,
		});
		await other.reloadFromDisk();
		// pin 不被磁盘 adopt 覆盖
		expect(other.environmentId).toBe("env-other");
		let err: unknown;
		try {
			await other.get(created.worktree.worktreeId);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		expect((err as WorktreeError).message).toMatch(/different environment/i);
	});

	test("distinct stateDirs remain isolated environments", async () => {
		const a = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-a"),
			environmentId: "env-a",
			idFactory: () => `id-a-${++idSeq}`,
		});
		const created = await a.create(createParams(sourcePath, baseOid, "k-iso-a"));

		const b = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-b"),
			environmentId: "env-b",
			idFactory: () => `id-b-${++idSeq}`,
		});
		await b.reloadFromDisk();
		expect(b.environmentId).toBe("env-b");
		let err: unknown;
		try {
			await b.get(created.worktree.worktreeId);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("NOT_FOUND");
		expect(await b.list()).toEqual([]);
	});

	test("path escape via worktreeId traversal is rejected on create target", async () => {
		// idFactory 返回含 path traversal 的 id → resolveTargetPath 必须拒绝
		const evil = new WorktreeLifecycleService({
			stateDir: join(stateDir, "managed-evil"),
			environmentId: "env-test",
			idFactory: (() => {
				let n = 0;
				return () => {
					n += 1;
					// operationId 正常；worktreeId 逃逸
					return n === 1 ? "op-evil" : join("..", "..", "escape-target");
				};
			})(),
		});
		let err: unknown;
		try {
			await evil.create(createParams(sourcePath, baseOid, "k-escape"));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("INVALID_PARAMS");
		expect((err as WorktreeError).message).toMatch(/escapes managed root/i);
	});

	test("get/list and capability descriptor never advertises setup/apply ready without ports", async () => {
		const a = await service.create(createParams(sourcePath, baseOid, "list-a", { repoId: "r1" }));
		const b = await service.create(createParams(sourcePath, baseOid, "list-b", { repoId: "r2" }));
		await service.archive({
			worktreeId: b.worktree.worktreeId,
			expectedRevision: b.worktree.revision,
			meta: { idempotencyKey: "list-arch-b" },
		});

		const all = await service.list();
		expect(all.length).toBe(2);
		const ready = await service.list({ state: "ready" });
		expect(ready.map(w => w.worktreeId)).toEqual([a.worktree.worktreeId]);

		const got = await service.get(a.worktree.worktreeId);
		expect(got.repoId).toBe("r1");

		const cap = service.capabilityDescriptor();
		expect(cap.name).toBe("worktree.lifecycle");
		expect(cap.version).toBe(1);
		expect(cap.limits.maxWorktrees).toBe(WORKTREE_LIFECYCLE_V1_LIMITS.maxWorktrees);
		expect(cap.setupAvailable).toBe(false);
		expect(cap.applyAvailable).toBe(false);
		// 无 ready applyPort：strategies 必须为空，不可广告 mutation
		expect(cap.limits.strategies).toEqual([]);
		expect(cap.recoveryReady).toBe(true);
		expect(cap.methods).toContain("worktree.create");
		expect(cap.methods).toContain("worktree.apply.prepare");
	});

	test("hashParams is stable for canonical keying", () => {
		const h1 = hashParams({ a: 1, b: { z: 2, y: 3 } });
		const h2 = hashParams({ b: { y: 3, z: 2 }, a: 1 });
		expect(h1).toBe(h2);
	});

	test("frozen event envelope uses method not legacy type", async () => {
		await service.create(createParams(sourcePath, baseOid, "k-event-shape"));
		expect(events.length).toBeGreaterThan(0);
		for (const e of events) {
			expect(e).toHaveProperty("method");
			expect(e).toHaveProperty("params");
			expect(typeof e.method).toBe("string");
			expect(e.method.startsWith("worktree.")).toBe(true);
			// 禁止旧单一 worktree.lifecycle type 字段作为 method
			expect(e.method).not.toBe("worktree.lifecycle");
			expect(e.params).toHaveProperty("worktreeId");
			expect(e.params).toHaveProperty("revision");
			expect(e.params).toHaveProperty("operationId");
			expect(e.params).toHaveProperty("state");
			expect(e.params).toHaveProperty("reason");
			expect(e.params).toHaveProperty("timestamp");
		}
	});

	test("apply.prepare parses porcelain -z rename/copy with NUL oldPath lookahead", async () => {
		const created = await service.create(createParams(sourcePath, baseOid, "k-rename-prep"));
		const id = created.worktree.worktreeId;
		const wtPath = created.worktree.displayPath;

		const run = async (argv: string[]) => {
			const proc = Bun.spawn(["git", ...argv], {
				cwd: wtPath,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) throw new Error(`git ${argv.join(" ")}: ${stderr || stdout}`);
			return stdout.trim();
		};

		await writeFile(join(wtPath, "old-name.txt"), "rename-me\n", "utf8");
		await run(["add", "old-name.txt"]);
		await run(["commit", "-m", "add old-name"]);
		await run(["mv", "old-name.txt", "new-name.txt"]);

		const plan = await service.prepare({
			worktreeId: id,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-rename",
			strategy: "patch",
			meta: { idempotencyKey: "prep-rename" },
		});

		expect(plan.files.length).toBeGreaterThan(0);
		const renamed = plan.files.filter(f => f.status === "renamed" || f.status === "copied");
		expect(renamed.length).toBeGreaterThanOrEqual(1);
		// fileChangeId 必须纳入 oldPath；同 snapshot 下稳定 64-hex
		expect(renamed.every(f => typeof f.fileChangeId === "string" && f.fileChangeId.length === 64)).toBe(true);
		// 不得把 old path 当成独立 untracked/added 误解析为第二条目主导
		const ids = new Set(plan.files.map(f => f.fileChangeId));
		expect(ids.size).toBe(plan.files.length);
	});

	test("reload degrades on setup.start outcome_unknown without silent clear or blind retry", async () => {
		const state = join(stateDir, "managed-unknown-setup");
		let startCalls = 0;
		const enteredStart = Promise.withResolvers<void>();
		const setupPort = {
			ready: true,
			async start() {
				startCalls += 1;
				// 外部 mutation 已开始；outcome_unknown 已在调用前落盘
				enteredStart.resolve();
				const hang = Promise.withResolvers<never>();
				return hang.promise;
			},
			async cancel() {
				return { cancelled: true, status: "cancelled" };
			},
		};

		const withPort = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-su-${++idSeq}`,
			setupPort,
		});
		const created = await withPort.create(
			createParams(sourcePath, baseOid, "k-su-create", { setupActionId: "act-su" }),
		);
		const worktreeId = created.worktree.worktreeId;

		const hanging = withPort.setupStart({
			worktreeId,
			setupActionId: "act-su",
			meta: { idempotencyKey: "setup-unknown-key" },
		});
		await enteredStart.promise;
		expect(startCalls).toBe(1);

		const reloaded = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-su2-${++idSeq}`,
			setupPort: {
				ready: true,
				async start() {
					startCalls += 1;
					return { status: "running", processId: "should-not-run" };
				},
				async cancel() {
					return { cancelled: true, status: "cancelled" };
				},
			},
		});
		await reloaded.reloadFromDisk();
		const cap = reloaded.capabilityDescriptor() as {
			status?: string;
			recoveryReady?: boolean;
			unresolvedUnknownOperations?: Array<{ kind: string; worktreeId: string }>;
		};
		expect(cap.recoveryReady).toBe(true);
		expect(cap.status).toBe("degraded");
		expect(cap.unresolvedUnknownOperations?.some(o => o.kind === "setup.start")).toBe(true);

		// 同 key 不得盲重试 port
		let err: unknown;
		try {
			await reloaded.setupStart({
				worktreeId,
				setupActionId: "act-su",
				meta: { idempotencyKey: "setup-unknown-key" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("OUTCOME_UNKNOWN");
		expect(startCalls).toBe(1);
		void hanging;
	});

	test("reload degrades on apply outcome_unknown while still applying", async () => {
		const state = join(stateDir, "managed-unknown-apply");
		const enteredApply = Promise.withResolvers<void>();
		let applyCalls = 0;
		const withApply = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-au-${++idSeq}`,
			applyPort: {
				ready: true,
				strategies: ["patch"],
				async apply() {
					applyCalls += 1;
					enteredApply.resolve();
					const hang = Promise.withResolvers<never>();
					return hang.promise;
				},
			},
		});
		const created = await withApply.create(createParams(sourcePath, baseOid, "k-au-create"));
		const plan = await withApply.prepare({
			worktreeId: created.worktree.worktreeId,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-au",
			strategy: "patch",
			meta: { idempotencyKey: "prep-au" },
		});

		const hanging = withApply.apply({
			planId: plan.planId,
			expectedWorktreeRevision: created.worktree.revision,
			expectedTargetSnapshotId: "tgt-au",
			meta: { idempotencyKey: "apply-unknown-key" },
		});
		await enteredApply.promise;
		expect(applyCalls).toBe(1);
		expect((await withApply.get(created.worktree.worktreeId)).state).toBe("applying");

		const reloaded = new WorktreeLifecycleService({
			stateDir: state,
			environmentId: "env-test",
			idFactory: () => `id-au2-${++idSeq}`,
			applyPort: {
				ready: true,
				strategies: ["patch"],
				async apply() {
					applyCalls += 1;
					throw new Error("must not blind retry apply");
				},
			},
		});
		await reloaded.reloadFromDisk();
		const cap = reloaded.capabilityDescriptor() as {
			status?: string;
			unresolvedUnknownOperations?: Array<{ kind: string }>;
		};
		expect(cap.status).toBe("degraded");
		expect(cap.unresolvedUnknownOperations?.some(o => o.kind === "apply")).toBe(true);

		let err: unknown;
		try {
			await reloaded.apply({
				planId: plan.planId,
				expectedWorktreeRevision: created.worktree.revision,
				expectedTargetSnapshotId: "tgt-au",
				meta: { idempotencyKey: "apply-unknown-key" },
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WorktreeError);
		expect((err as WorktreeError).code).toBe("OUTCOME_UNKNOWN");
		expect(applyCalls).toBe(1);
		void hanging;
	});
});
