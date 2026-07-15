import * as path from "node:path";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { loadEntriesFromFile } from "../session/session-loader";
import type { SanBrainStore, SanBrainSyncResult } from "./store";

export interface SanBrainRebuildResult extends SanBrainSyncResult {
	sessionsScanned: number;
	sessionsWithBrainState: number;
}

interface LoadedSessionLedger {
	header: SessionHeader;
	entries: SessionEntry[];
}

export async function rebuildSanBrainStore(store: SanBrainStore, agentDir: string): Promise<SanBrainRebuildResult> {
	const sessionsRoot = path.join(agentDir, "sessions");
	const files = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(sessionsRoot), file =>
		path.join(sessionsRoot, file),
	);
	const ledgers: LoadedSessionLedger[] = [];
	for (const file of files.toSorted()) {
		const loaded = await loadEntriesFromFile(file);
		const header = loaded[0];
		if (header?.type !== "session") continue;
		ledgers.push({ header, entries: loaded.slice(1) as SessionEntry[] });
	}

	store.resetMaterializedState();
	const result: SanBrainRebuildResult = {
		sessionsScanned: ledgers.length,
		sessionsWithBrainState: 0,
		candidatesAdded: 0,
		decisionsAdded: 0,
		decisionsApplied: 0,
		decisionsBlocked: 0,
	};
	for (const ledger of ledgers) {
		const synced = store.syncSessionEntries(ledger.header.id, ledger.entries);
		if (synced.candidatesAdded > 0 || synced.decisionsAdded > 0) result.sessionsWithBrainState++;
		result.candidatesAdded += synced.candidatesAdded;
		result.decisionsAdded += synced.decisionsAdded;
		result.decisionsApplied += synced.decisionsApplied;
		result.decisionsBlocked += synced.decisionsBlocked;
	}
	return result;
}
