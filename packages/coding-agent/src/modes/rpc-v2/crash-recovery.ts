/** RPC v2 lease 与崩溃恢复。Lease 文件跟随 Session 文件，不写入源码目录。 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
import { withFileLock } from "../../config/file-lock";
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

interface StoredRecoveryDescriptor extends RecoveryDescriptor {
	previousLeaseId: string;
	previousRuntimeId: RuntimeId;
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
	await withFileLock(leasePath, async () => {
		if (!(await Bun.file(sessionFile).exists())) throw new Error("SESSION_NOT_FOUND");
		const existing = await readLeaseRecord(leasePath);
		if (existing) {
			if (processAlive(existing.pid) && existing.runtimeId !== record.runtimeId) throw new Error("SESSION_LOCKED");
			if (!stealExpired && existing.runtimeId !== record.runtimeId) throw new Error("SESSION_LOCKED");
		}
		await writeJsonAtomically(leasePath, record);
	});
}

export async function writeLeaseRecord(record: LeaseRecord, sessionFile?: string): Promise<void> {
	if (!sessionFile) throw new Error("writeLeaseRecord requires sessionFile");
	const leasePath = leasePathForSession(sessionFile);
	await fs.mkdir(path.dirname(leasePath), { recursive: true });
	await withFileLock(leasePath, async () => writeJsonAtomically(leasePath, record));
}

export async function updateLeaseHeartbeat(
	sessionFile: string,
	leaseId: string,
	runtimeId: string,
	sequence: number,
): Promise<void> {
	const leasePath = leasePathForSession(sessionFile);
	await withFileLock(leasePath, async () => {
		const record = await readLeaseRecord(leasePath);
		if (!record || record.leaseId !== leaseId || record.runtimeId !== runtimeId) throw new Error("SESSION_LOCKED");
		record.lastHeartbeat = new Date().toISOString();
		record.lastStableSequence = Math.max(record.lastStableSequence ?? 0, sequence);
		await writeJsonAtomically(leasePath, record);
	});
}

export async function removeLeaseRecord(sessionFile: string, leaseId: string, runtimeId: string): Promise<boolean> {
	const leasePath = leasePathForSession(sessionFile);
	return await withFileLock(leasePath, async () => {
		const record = await readLeaseRecord(leasePath);
		if (!record || record.leaseId !== leaseId || record.runtimeId !== runtimeId) return false;
		await fs.rm(leasePath, { force: true });
		return true;
	});
}

/** 放弃尚未确认的恢复写租约，恢复为可再次竞争的过期租约。 */
export async function abandonRecoveryLease(
	sessionFile: string,
	leaseId: string,
	runtimeId: string,
	sessionId: string,
): Promise<boolean> {
	const leasePath = leasePathForSession(sessionFile);
	return await withFileLock(leasePath, async () => {
		const [record, recovery] = await Promise.all([readLeaseRecord(leasePath), readStoredRecovery(sessionFile)]);
		if (!record || !recovery || record.leaseId !== leaseId || record.runtimeId !== runtimeId) return false;
		const now = new Date().toISOString();
		await writeJsonAtomically(leasePath, {
			leaseId: recovery.previousLeaseId,
			runtimeId: recovery.previousRuntimeId,
			pid: 2_147_483_647,
			sessionId,
			acquiredAt: now,
			lastHeartbeat: now,
			lastStableSequence: Math.max(0, recovery.lastStableSequence),
		} satisfies LeaseRecord);
		return true;
	});
}

export async function detectRecovery(
	_sessionId: string,
	currentRuntimeId: RuntimeId,
	sessionFile?: string,
): Promise<RecoveryDescriptor | undefined> {
	if (!sessionFile) return undefined;
	const leasePath = leasePathForSession(sessionFile);
	return await withFileLock(leasePath, async () => {
		const record = await readLeaseRecord(leasePath);
		if (!record || record.runtimeId === currentRuntimeId) return undefined;
		if (processAlive(record.pid)) throw new Error("SESSION_LOCKED");
		const recovery: StoredRecoveryDescriptor = {
			required: true,
			reason: "runtime_crash" satisfies RecoveryReason,
			previousRuntimeId: record.runtimeId as RuntimeId,
			previousLeaseId: record.leaseId,
			lastStableSequence: Math.max(0, record.lastStableSequence ?? 0),
			allowedStrategies: ["continue", "mark_aborted", "read_only"] satisfies RecoveryStrategy[],
		};
		await writeJsonAtomically(recoveryPathForSession(sessionFile), recovery);
		return publicRecoveryDescriptor(recovery);
	});
}

export async function readRecovery(sessionFile: string): Promise<RecoveryDescriptor | undefined> {
	const recovery = await readStoredRecovery(sessionFile);
	return recovery ? publicRecoveryDescriptor(recovery) : undefined;
}

export async function executeRecovery(
	sessionId: string,
	strategy: RecoveryStrategy,
	currentRuntimeId: RuntimeId,
	sessionFile?: string,
	leaseId?: string,
	beforeReadOnlyRelease?: () => Promise<void>,
): Promise<{ recovered: boolean; lastStableSequence: number }> {
	if (!sessionFile) return { recovered: true, lastStableSequence: 0 };
	if (strategy !== "read_only" && !leaseId) throw new Error(`${strategy} recovery requires leaseId`);
	const leasePath = leasePathForSession(sessionFile);
	return await withFileLock(leasePath, async () => {
		const recovery = await readStoredRecovery(sessionFile);
		const current = await readLeaseRecord(leasePath);
		if (!recovery || !current) throw new Error("SESSION_LOCKED");
		const ownsPreviousLease =
			current.leaseId === recovery.previousLeaseId &&
			current.runtimeId === recovery.previousRuntimeId &&
			!processAlive(current.pid);
		const ownsStolenLease = current.leaseId === leaseId && current.runtimeId === currentRuntimeId;
		if (!ownsPreviousLease && !ownsStolenLease) throw new Error("SESSION_LOCKED");
		const lastStableSequence = Math.max(0, recovery.lastStableSequence);
		if (strategy === "read_only") {
			await beforeReadOnlyRelease?.();
			await fs.rm(leasePath, { force: true });
		} else {
			const now = new Date().toISOString();
			await writeJsonAtomically(leasePath, {
				leaseId: leaseId as string,
				runtimeId: currentRuntimeId,
				pid: process.pid,
				sessionId,
				acquiredAt: now,
				lastHeartbeat: now,
				lastStableSequence,
			} satisfies LeaseRecord);
		}
		await fs.rm(recoveryPathForSession(sessionFile), { force: true });
		return { recovered: true, lastStableSequence };
	});
}

export function leasePath(sessionFile: string): string {
	return leasePathForSession(sessionFile);
}

/** Run a destructive Session operation under the same lock used by lease acquisition. */
export async function withLeaseFileLock<T>(sessionFile: string, fn: () => Promise<T>): Promise<T> {
	return await withFileLock(leasePathForSession(sessionFile), fn);
}

async function readLeaseRecord(leasePath: string): Promise<LeaseRecord | undefined> {
	try {
		return parseLeaseRecord(await Bun.file(leasePath).json());
	} catch (error: unknown) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Invalid RPC v2 lease ${leasePath}: ${String(error)}`);
	}
}

async function readStoredRecovery(sessionFile: string): Promise<StoredRecoveryDescriptor | undefined> {
	try {
		return parseStoredRecoveryDescriptor(await Bun.file(recoveryPathForSession(sessionFile)).json());
	} catch (error: unknown) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read RPC v2 recovery state for ${sessionFile}: ${String(error)}`);
	}
}

function parseLeaseRecord(value: unknown): LeaseRecord {
	if (!isRecord(value)) throw new Error("expected a JSON object");
	if (!isNonEmptyString(value.leaseId) || !isNonEmptyString(value.runtimeId) || !isNonEmptyString(value.sessionId)) {
		throw new Error("lease identity fields must be non-empty strings");
	}
	if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0)
		throw new Error("pid must be a positive integer");
	if (!isNonEmptyString(value.acquiredAt) || !isNonEmptyString(value.lastHeartbeat)) {
		throw new Error("lease timestamps must be non-empty strings");
	}
	if (!Number.isSafeInteger(value.lastStableSequence) || (value.lastStableSequence as number) < 0) {
		throw new Error("lastStableSequence must be a non-negative safe integer");
	}
	return value as unknown as LeaseRecord;
}

function parseStoredRecoveryDescriptor(value: unknown): StoredRecoveryDescriptor {
	if (!isRecord(value)) throw new Error("expected a JSON object");
	if (value.required !== true) throw new Error("recovery descriptor must be required");
	if (!RECOVERY_REASONS.has(value.reason as RecoveryReason)) throw new Error("invalid recovery reason");
	if (!isNonEmptyString(value.previousLeaseId) || !isNonEmptyString(value.previousRuntimeId)) {
		throw new Error("previous lease identity must be present");
	}
	if (!Number.isSafeInteger(value.lastStableSequence) || (value.lastStableSequence as number) < 0) {
		throw new Error("lastStableSequence must be a non-negative safe integer");
	}
	if (
		!Array.isArray(value.allowedStrategies) ||
		value.allowedStrategies.length === 0 ||
		!value.allowedStrategies.every(strategy => RECOVERY_STRATEGIES.has(strategy as RecoveryStrategy))
	) {
		throw new Error("invalid recovery strategies");
	}
	if (value.interruptedRunId !== undefined && !isNonEmptyString(value.interruptedRunId)) {
		throw new Error("interruptedRunId must be a non-empty string");
	}
	return value as unknown as StoredRecoveryDescriptor;
}

const RECOVERY_REASONS = new Set<RecoveryReason>([
	"runtime_crash",
	"unclean_shutdown",
	"stale_lease",
	"incomplete_run",
	"journal_repair",
]);
const RECOVERY_STRATEGIES = new Set<RecoveryStrategy>(["continue", "mark_aborted", "read_only"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

async function writeJsonAtomically(filePath: string, value: object): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await Bun.write(temporaryPath, `${JSON.stringify(value)}\n`);
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

function publicRecoveryDescriptor(recovery: StoredRecoveryDescriptor): RecoveryDescriptor {
	return {
		required: recovery.required,
		reason: recovery.reason,
		previousRuntimeId: recovery.previousRuntimeId,
		lastStableSequence: recovery.lastStableSequence,
		interruptedRunId: recovery.interruptedRunId,
		allowedStrategies: [...recovery.allowedStrategies],
	};
}
