import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireLease,
	detectRecovery,
	executeRecovery,
	leasePathForSession,
	recoveryPathForSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/crash-recovery";
import type { RuntimeId } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/ids";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

async function staleSessionFile(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-recovery-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await Bun.write(sessionFile, "");
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
});
