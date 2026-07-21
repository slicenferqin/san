/**
 * San RPC v2 Crash Recovery.
 *
 * Detects stale leases and interrupted runs after process restart.
 * Provides recovery strategies: continue, mark_aborted, read_only.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RecoveryDescriptor } from "./dto/session";
import type { RuntimeId } from "./protocol/ids";
import type { RecoveryReason, RecoveryStrategy } from "./protocol/lifecycle";

interface LeaseRecord {
	leaseId: string;
	runtimeId: string;
	pid: number;
	sessionId: string;
	acquiredAt: string;
	lastHeartbeat: string;
}

const LEASE_DIR = path.join(import.meta.dir, ".leases");

/** Write a lease record to disk for crash detection. */
export async function writeLeaseRecord(record: LeaseRecord): Promise<void> {
	await fs.mkdir(LEASE_DIR, { recursive: true });
	const leasePath = path.join(LEASE_DIR, `${record.sessionId}.lease.json`);
	await fs.writeFile(leasePath, JSON.stringify(record, null, 2));
}

/** Remove a lease record (clean shutdown). */
export async function removeLeaseRecord(sessionId: string): Promise<void> {
	const leasePath = path.join(LEASE_DIR, `${sessionId}.lease.json`);
	await fs.rm(leasePath, { force: true }).catch(() => {});
}

/** Check if a process is still alive. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect recovery state for a session.
 * Returns a RecoveryDescriptor if recovery is needed, undefined otherwise.
 */
export async function detectRecovery(
	sessionId: string,
	currentRuntimeId: RuntimeId,
): Promise<RecoveryDescriptor | undefined> {
	const leasePath = path.join(LEASE_DIR, `${sessionId}.lease.json`);

	let record: LeaseRecord;
	try {
		record = JSON.parse(await fs.readFile(leasePath, "utf-8")) as LeaseRecord;
	} catch {
		return undefined; // No lease file — no recovery needed
	}

	// If the lease belongs to this runtime, no recovery needed
	if (record.runtimeId === currentRuntimeId) return undefined;

	// Check if the previous process is still alive
	if (isProcessAlive(record.pid)) {
		// Process is alive — session is locked by another runtime
		return undefined; // Caller should return SESSION_LOCKED
	}

	// Previous process is dead — recovery needed
	const reason: RecoveryReason = "runtime_crash";
	const allowedStrategies: RecoveryStrategy[] = ["continue", "mark_aborted", "read_only"];

	return {
		required: true,
		reason,
		previousRuntimeId: record.runtimeId as RuntimeId,
		lastStableSequence: 0, // Would be read from journal watermark
		allowedStrategies,
	};
}

/**
 * Execute a recovery strategy.
 */
export async function executeRecovery(
	sessionId: string,
	strategy: RecoveryStrategy,
	currentRuntimeId: RuntimeId,
): Promise<{ recovered: boolean; lastStableSequence: number }> {
	switch (strategy) {
		case "continue": {
			// Take over the lease and continue
			await writeLeaseRecord({
				leaseId: `lease_recovery_${Date.now()}`,
				runtimeId: currentRuntimeId,
				pid: process.pid,
				sessionId,
				acquiredAt: new Date().toISOString(),
				lastHeartbeat: new Date().toISOString(),
			});
			return { recovered: true, lastStableSequence: 0 };
		}
		case "mark_aborted": {
			// Mark the interrupted run as aborted, release lease
			await removeLeaseRecord(sessionId);
			return { recovered: true, lastStableSequence: 0 };
		}
		case "read_only": {
			// Open in read-only mode, don't take lease
			return { recovered: true, lastStableSequence: 0 };
		}
	}
}
