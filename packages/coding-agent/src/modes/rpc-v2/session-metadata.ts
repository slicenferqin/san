import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@san/utils";
import { withFileLock } from "../../config/file-lock";

/** 桌面端跨端会话元数据；与 ApprovalRuleStore 同一套锁 + 原子写约定。 */
export interface SessionMetadataEntry {
	pinned?: boolean;
	archived?: boolean;
	unread?: boolean;
	updatedAt: string;
}

export interface SessionMetadataPatch {
	pinned?: boolean;
	archived?: boolean;
	unread?: boolean;
}

interface StoredSessionMetadata {
	schemaVersion: 1;
	sessions: Record<string, SessionMetadataEntry>;
}

const METADATA_KEYS = ["pinned", "archived", "unread"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionMetadataEntry(value: unknown): value is SessionMetadataEntry {
	if (!isRecord(value)) return false;
	if (typeof value.updatedAt !== "string") return false;
	for (const key of METADATA_KEYS) {
		const flag = value[key];
		if (flag !== undefined && typeof flag !== "boolean") return false;
	}
	return true;
}

/** San 持有的会话级用户元数据（置顶/归档/未读）；写入采用同目录临时文件加 rename。 */
export class SessionMetadataStore {
	readonly #storagePath: string;
	#metadata: StoredSessionMetadata = { schemaVersion: 1, sessions: {} };
	#loaded = false;
	#operationTail: Promise<void> = Promise.resolve();

	constructor(storagePath = path.join(getAgentDir(), "rpc-v2", "session-metadata.json")) {
		this.#storagePath = storagePath;
	}

	async load(): Promise<void> {
		if (this.#loaded) return;
		await this.refresh();
	}

	/** 重新读取共享元数据文件，让长驻 Runtime 看到其他进程提交的更新。 */
	async refresh(): Promise<void> {
		await this.#exclusive(async () => {
			this.#metadata = await this.#loadFromDisk();
			this.#loaded = true;
		});
	}

	get(sessionId: string): SessionMetadataEntry | undefined {
		this.#assertLoaded();
		const entry = this.#metadata.sessions[sessionId];
		return entry ? structuredClone(entry) : undefined;
	}

	/** 合并 patch 中已定义的键；不传的键保持原值。 */
	async update(sessionId: string, patch: SessionMetadataPatch): Promise<SessionMetadataEntry> {
		this.#assertLoaded();
		return await this.#mutate(async () => {
			const previous = this.#metadata.sessions[sessionId] ?? { updatedAt: new Date(0).toISOString() };
			const next: SessionMetadataEntry = { ...previous };
			for (const key of METADATA_KEYS) {
				const value = patch[key];
				if (value !== undefined) next[key] = value;
			}
			next.updatedAt = new Date().toISOString();
			this.#metadata.sessions[sessionId] = next;
			return structuredClone(next);
		});
	}

	async #loadFromDisk(): Promise<StoredSessionMetadata> {
		try {
			const value = (await Bun.file(this.#storagePath).json()) as Partial<StoredSessionMetadata>;
			if (value.schemaVersion !== 1 || !isRecord(value.sessions)) {
				throw new Error("expected schemaVersion 1 and sessions object");
			}
			const sessions: Record<string, SessionMetadataEntry> = {};
			for (const [sessionId, raw] of Object.entries(value.sessions)) {
				if (!isSessionMetadataEntry(raw)) continue;
				sessions[sessionId] = structuredClone(raw);
			}
			return { schemaVersion: 1, sessions };
		} catch (error: unknown) {
			if (!isEnoent(error))
				throw new Error(`Failed to load session metadata ${this.#storagePath}: ${String(error)}`);
			return { schemaVersion: 1, sessions: {} };
		}
	}

	async #mutate<T>(mutation: () => Promise<T>): Promise<T> {
		return await this.#exclusive(async () => {
			await fs.mkdir(path.dirname(this.#storagePath), { recursive: true });
			return await withFileLock(this.#storagePath, async () => {
				this.#metadata = await this.#loadFromDisk();
				const result = await mutation();
				await this.#save();
				return result;
			});
		});
	}

	async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#operationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#operationTail = previous.then(() => promise);
		await previous;
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	async #save(): Promise<void> {
		const tempPath = `${this.#storagePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await Bun.write(tempPath, `${JSON.stringify(this.#metadata)}\n`);
			await fs.rename(tempPath, this.#storagePath);
		} finally {
			await fs.rm(tempPath, { force: true });
		}
	}

	#assertLoaded(): void {
		if (!this.#loaded) throw new Error("SessionMetadataStore.load() must complete before use");
	}
}
