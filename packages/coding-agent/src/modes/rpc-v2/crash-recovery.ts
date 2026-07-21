/** RPC v2 lease 与崩溃恢复。Lease 文件跟随 Session 文件，不写入源码目录。 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { RecoveryDescriptor } from "./dto/session";
import type { RuntimeId } from "./protocol/ids";
import type { RecoveryReason, RecoveryStrategy } from "./protocol/lifecycle";

export interface LeaseRecord {
	leaseId: string;
	runtimeId: string;
	pid: number;
	sessionId: string;
	acquiredAt: string;
	lastHeartbeat: string;
	lastStableSequence: number;
}

export function leasePathForSession(sessionFile: string): string {
	return `${sessionFile}.rpc-v2.lease.json`;
}

export function recoveryPathForSession(sessionFile: string): string {
	return `${sessionFile}.rpc-v2.recovery.json`;
}

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 原子创建 lease；已有活跃进程时返回 SESSION_LOCKED 语义的错误。 */
export async function acquireLease(sessionFile: string, record: LeaseRecord, stealExpired = false): Promise<void> {
	const leasePath = leasePathForSession(sessionFile);
	await fs.mkdir(path.dirname(leasePath), { recursive: true });
	try {
		const handle = await fs.open(leasePath, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}

	let existing: LeaseRecord;
	try {
		existing = JSON.parse(await Bun.file(leasePath).text()) as LeaseRecord;
	} catch (error: unknown) {
		throw new Error(`Invalid RPC v2 lease ${leasePath}: ${String(error)}`);
	}
	if (processAlive(existing.pid) && existing.runtimeId !== record.runtimeId) throw new Error("SESSION_LOCKED");
	if (!stealExpired && existing.runtimeId !== record.runtimeId) throw new Error("SESSION_LOCKED");
	await fs.rm(leasePath, { force: true });
	await acquireLease(sessionFile, record, false);
}

export async function writeLeaseRecord(record: LeaseRecord, sessionFile?: string): Promise<void> {
	if (!sessionFile) throw new Error("writeLeaseRecord requires sessionFile");
	const leasePath = leasePathForSession(sessionFile);
	await Bun.write(leasePath, `${JSON.stringify(record)}\n`);
}

export async function updateLeaseHeartbeat(sessionFile: string, sequence: number): Promise<void> {
	const leasePath = leasePathForSession(sessionFile);
	try {
		const record = JSON.parse(await Bun.file(leasePath).text()) as LeaseRecord;
		record.lastHeartbeat = new Date().toISOString();
		record.lastStableSequence = Math.max(record.lastStableSequence ?? 0, sequence);
		const temporaryPath = `${leasePath}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(temporaryPath, `${JSON.stringify(record)}\n`);
		await fs.rename(temporaryPath, leasePath);
	} catch (error: unknown) {
		throw new Error(`Failed to update RPC v2 lease ${leasePath}: ${String(error)}`);
	}
}

export async function removeLeaseRecord(sessionFile: string): Promise<void> {
	await fs.rm(leasePathForSession(sessionFile), { force: true });
}

export async function detectRecovery(
	_sessionId: string,
	currentRuntimeId: RuntimeId,
	sessionFile?: string,
): Promise<RecoveryDescriptor | undefined> {
	if (!sessionFile) return undefined;
	const leasePath = leasePathForSession(sessionFile);
	let record: LeaseRecord;
	try {
		record = JSON.parse(await Bun.file(leasePath).text()) as LeaseRecord;
	} catch (error: unknown) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read RPC v2 lease ${leasePath}: ${String(error)}`);
	}
	if (record.runtimeId === currentRuntimeId) return undefined;
	if (processAlive(record.pid)) throw new Error("SESSION_LOCKED");
	const recovery: RecoveryDescriptor = {
		required: true,
		reason: "runtime_crash" satisfies RecoveryReason,
		previousRuntimeId: record.runtimeId as RuntimeId,
		lastStableSequence: Math.max(0, record.lastStableSequence ?? 0),
		allowedStrategies: ["continue", "mark_aborted", "read_only"] satisfies RecoveryStrategy[],
	};
	await Bun.write(recoveryPathForSession(sessionFile), `${JSON.stringify(recovery)}\n`);
	return recovery;
}

export async function readRecovery(sessionFile: string): Promise<RecoveryDescriptor | undefined> {
	try {
		return (await Bun.file(recoveryPathForSession(sessionFile)).json()) as RecoveryDescriptor;
	} catch (error: unknown) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read RPC v2 recovery state for ${sessionFile}: ${String(error)}`);
	}
}

export async function executeRecovery(
	sessionId: string,
	strategy: RecoveryStrategy,
	currentRuntimeId: RuntimeId,
	sessionFile?: string,
	leaseId?: string,
): Promise<{ recovered: boolean; lastStableSequence: number }> {
	const lastStableSequence = sessionFile ? ((await readRecovery(sessionFile))?.lastStableSequence ?? 0) : 0;
	if (!sessionFile) return { recovered: true, lastStableSequence };
	if (strategy === "read_only") {
		await fs.rm(leasePathForSession(sessionFile), { force: true });
		await fs.rm(recoveryPathForSession(sessionFile), { force: true });
		return { recovered: true, lastStableSequence };
	}
	if (!leaseId) throw new Error(`${strategy} recovery requires leaseId`);
	await fs.rm(leasePathForSession(sessionFile), { force: true });
	await acquireLease(
		sessionFile,
		{
			leaseId,
			runtimeId: currentRuntimeId,
			pid: process.pid,
			sessionId,
			acquiredAt: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
			lastStableSequence,
		},
		false,
	);
	await fs.rm(recoveryPathForSession(sessionFile), { force: true });
	return { recovered: true, lastStableSequence };
}

export function leasePath(sessionFile: string): string {
	return leasePathForSession(sessionFile);
}
