import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	abandonRecoveryLease,
	acquireLease,
	assertNoForeignLiveSession,
	detectRecovery,
	executeRecovery,
	leasePathForSession,
	readRecovery,
	recoveryPathForSession,
	withLeaseFileLock,
} from "@san/coding-agent/modes/rpc-v2/crash-recovery";
import type { RuntimeId } from "@san/coding-agent/modes/rpc-v2/protocol/ids";
import { removeWithRetries } from "@san/utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

async function backdate(sessionFile: string, ageMs: number): Promise<void> {
	const atime = new Date(Date.now() - ageMs);
	await fs.utimes(sessionFile, atime, atime);
}

async function staleSessionFile(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-recovery-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await Bun.write(sessionFile, "");
	// 先回溯 mtime 再拿 lease：新鲜的 journal 会被视为外部活跃会话而拒绝接管。
	await backdate(sessionFile, 10 * 60_000);
	await acquireLease(sessionFile, {
		leaseId: "lease_old",
		runtimeId: "runtime_old",
		pid: 2_147_483_647,
		sessionId: "ses_1",
		acquiredAt: "2026-01-01T00:00:00.000Z",
		lastHeartbeat: "2026-01-01T00:00:00.000Z",
		lastStableSequence: 42,
	});
	return sessionFile;
}

describe("RPC v2 crash recovery", () => {
	test("serializes deletion with lease acquisition and rejects an orphan lease", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-delete-lock-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		await Bun.write(sessionFile, "");
		const deletionStarted = Promise.withResolvers<void>();
		const allowDeletion = Promise.withResolvers<void>();
		const deletion = withLeaseFileLock(sessionFile, async () => {
			deletionStarted.resolve();
			await allowDeletion.promise;
			await fs.rm(sessionFile);
		});
		await deletionStarted.promise;

		let acquisitionSettled = false;
		const acquisition = acquireLease(sessionFile, {
			leaseId: "lease_racing",
			runtimeId: "runtime_racing",
			pid: process.pid,
			sessionId: "ses_racing",
			acquiredAt: "2026-07-24T00:00:00.000Z",
			lastHeartbeat: "2026-07-24T00:00:00.000Z",
			lastStableSequence: 0,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		void acquisition.finally(() => {
			acquisitionSettled = true;
		});
		await Bun.sleep(25);
		expect(acquisitionSettled).toBe(false);
		expect(await Bun.file(leasePathForSession(sessionFile)).exists()).toBe(false);

		allowDeletion.resolve();
		await deletion;
		const acquisitionError = await acquisition;
		expect(acquisitionError).toBeInstanceOf(Error);
		expect((acquisitionError as Error).message).toBe("SESSION_NOT_FOUND");
		expect(await Bun.file(leasePathForSession(sessionFile)).exists()).toBe(false);
	});

	test("detects a stale lease and continue installs the new runtime lease", async () => {
		const sessionFile = await staleSessionFile();
		const runtimeId = "runtime_new" as RuntimeId;
		const recovery = await detectRecovery("ses_1", runtimeId, sessionFile);
		expect(recovery).toMatchObject({ required: true, reason: "runtime_crash", lastStableSequence: 42 });
		await executeRecovery("ses_1", "continue", runtimeId, sessionFile, "lease_new");
		const lease = JSON.parse(await Bun.file(leasePathForSession(sessionFile)).text()) as Record<string, unknown>;
		expect(lease).toMatchObject({
			leaseId: "lease_new",
			runtimeId: "runtime_new",
			pid: process.pid,
			lastStableSequence: 42,
		});
		expect(await Bun.file(recoveryPathForSession(sessionFile)).exists()).toBe(false);
	});

	test("mark_aborted also acquires a live write lease instead of leaving the Session unlocked", async () => {
		const sessionFile = await staleSessionFile();
		const runtimeId = "runtime_mark" as RuntimeId;
		await detectRecovery("ses_1", runtimeId, sessionFile);
		await executeRecovery("ses_1", "mark_aborted", runtimeId, sessionFile, "lease_mark");
		const lease = JSON.parse(await Bun.file(leasePathForSession(sessionFile)).text()) as Record<string, unknown>;
		expect(lease).toMatchObject({ leaseId: "lease_mark", runtimeId: "runtime_mark" });
	});

	test("read_only recovery clears stale ownership", async () => {
		const sessionFile = await staleSessionFile();
		const runtimeId = "runtime_read" as RuntimeId;
		await detectRecovery("ses_1", runtimeId, sessionFile);
		await executeRecovery("ses_1", "read_only", runtimeId, sessionFile);
		expect(await Bun.file(leasePathForSession(sessionFile)).exists()).toBe(false);
		expect(await Bun.file(recoveryPathForSession(sessionFile)).exists()).toBe(false);
	});

	test("read_only recovery retains stale ownership when sidecar persistence fails", async () => {
		const sessionFile = await staleSessionFile();
		const runtimeId = "runtime_read_failure" as RuntimeId;
		await detectRecovery("ses_1", runtimeId, sessionFile);
		await expect(
			executeRecovery("ses_1", "read_only", runtimeId, sessionFile, undefined, async () => {
				throw new Error("sidecar unavailable");
			}),
		).rejects.toThrow("sidecar unavailable");
		expect(await Bun.file(leasePathForSession(sessionFile)).exists()).toBe(true);
		expect(await Bun.file(recoveryPathForSession(sessionFile)).exists()).toBe(true);
	});

	test("a stale recovery cannot remove a lease acquired by another Runtime", async () => {
		const sessionFile = await staleSessionFile();
		const firstRuntime = "runtime_first" as RuntimeId;
		const secondRuntime = "runtime_second" as RuntimeId;
		await detectRecovery("ses_1", firstRuntime, sessionFile);
		await detectRecovery("ses_1", secondRuntime, sessionFile);

		await executeRecovery("ses_1", "continue", firstRuntime, sessionFile, "lease_first");
		await expect(executeRecovery("ses_1", "continue", secondRuntime, sessionFile, "lease_second")).rejects.toThrow(
			"SESSION_LOCKED",
		);

		const lease = JSON.parse(await Bun.file(leasePathForSession(sessionFile)).text()) as Record<string, unknown>;
		expect(lease).toMatchObject({ leaseId: "lease_first", runtimeId: "runtime_first" });
	});

	test("abandoning a preclaimed recovery lease keeps the Session recoverable", async () => {
		const sessionFile = await staleSessionFile();
		const runtimeId = "runtime_preclaimed" as RuntimeId;
		await detectRecovery("ses_1", runtimeId, sessionFile);
		await acquireLease(
			sessionFile,
			{
				leaseId: "lease_preclaimed",
				runtimeId,
				pid: process.pid,
				sessionId: "ses_1",
				acquiredAt: new Date().toISOString(),
				lastHeartbeat: new Date().toISOString(),
				lastStableSequence: 42,
			},
			true,
		);

		expect(await abandonRecoveryLease(sessionFile, "lease_preclaimed", runtimeId, "ses_1")).toBe(true);
		expect(await detectRecovery("ses_1", "runtime_later" as RuntimeId, sessionFile)).toMatchObject({
			required: true,
			lastStableSequence: 42,
		});
	});
	test("rejects malformed lease and recovery sidecars", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-invalid-recovery-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(
			leasePathForSession(sessionFile),
			JSON.stringify({
				leaseId: "lease_bad",
				runtimeId: "runtime_bad",
				sessionId: "ses_1",
				pid: "not-a-pid",
				acquiredAt: "2026-07-26T00:00:00.000Z",
				lastHeartbeat: "2026-07-26T00:00:00.000Z",
				lastStableSequence: 0,
			}),
		);
		await expect(detectRecovery("ses_1", "runtime_new" as RuntimeId, sessionFile)).rejects.toThrow(
			"pid must be a positive integer",
		);

		await Bun.write(
			recoveryPathForSession(sessionFile),
			JSON.stringify({
				required: true,
				reason: "runtime_crash",
				previousLeaseId: "lease_old",
				previousRuntimeId: "runtime_old",
				lastStableSequence: 0,
				allowedStrategies: ["delete_everything"],
			}),
		);
		await expect(readRecovery(sessionFile)).rejects.toThrow("invalid recovery strategies");
	});
});

describe("foreign live session detection", () => {
	test("assertNoForeignLiveSession rejects a freshly written journal", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-foreign-live-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		// 交互式 CLI 运行时不写 rpc-v2 lease，但活跃运行会持续追加 journal。
		await Bun.write(sessionFile, "");
		await expect(assertNoForeignLiveSession(sessionFile)).rejects.toThrow("SESSION_LOCKED");
	});

	test("assertNoForeignLiveSession accepts stale or missing journals", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-foreign-stale-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "session.jsonl");
		await Bun.write(sessionFile, "");
		await backdate(sessionFile, 10 * 60_000);
		await assertNoForeignLiveSession(sessionFile);
		await assertNoForeignLiveSession(path.join(directory, "missing.jsonl"));
	});

	test("a crashed runtime unlocks after the freshness window", async () => {
		const sessionFile = await staleSessionFile();
		// journal 停写超过窗口（staleSessionFile 已回溯 10 分钟）：按崩溃恢复接管。
		const recovery = await detectRecovery("ses_1", "runtime_new" as RuntimeId, sessionFile);
		expect(recovery).toMatchObject({ required: true, reason: "runtime_crash" });
	});
});
