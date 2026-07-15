import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { remote, repo } from "../utils/git";

const IDENTITY_SCHEMA_VERSION = 1;

interface IdentityRecordRow {
	uuid: string;
	canonical_path: string;
}

interface IdentityAliasRow {
	path: string;
}

export interface RuntimeScopeIdentity {
	userKey: "user:local";
	sessionKey: string;
	projectKey: string;
	repoKey?: string;
	canonicalCwd: string;
	repoRoot?: string;
	legacyProjectKeys: string[];
	legacyRepoKeys: string[];
}

export interface ResolveRuntimeScopeIdentityOptions {
	agentDir: string;
	cwd: string;
	sessionId: string;
	signal?: AbortSignal;
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function filesystemIdentity(stat: { dev: number; ino: number }): string {
	return `${stat.dev}:${stat.ino}`;
}

function normalizeRemoteUrl(value: string): string {
	const trimmed = value.trim();
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
	const candidate = scp ? `ssh://${scp[1]}/${scp[2]}` : trimmed;
	try {
		const url = new URL(candidate);
		if (url.protocol === "file:") return `file:${path.resolve(decodeURIComponent(url.pathname))}`;
		const host = url.hostname.toLowerCase();
		const port = url.port ? `:${url.port}` : "";
		const pathname = decodeURIComponent(url.pathname)
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/i, "");
		return `${host}${port}/${pathname}`;
	} catch (error) {
		throw new Error(`Cannot normalize Git remote URL ${JSON.stringify(value)}: ${String(error)}`);
	}
}

async function primaryRemoteUrl(repoRoot: string, signal?: AbortSignal): Promise<string | undefined> {
	const origin = await remote.url(repoRoot, "origin", signal);
	if (origin) return origin;
	const names = await remote.list(repoRoot, signal);
	for (const name of names.toSorted()) {
		const url = await remote.url(repoRoot, name, signal);
		if (url) return url;
	}
	return undefined;
}

async function openIdentityDatabase(agentDir: string): Promise<Database> {
	const dbPath = path.join(agentDir, "brain", "scope-identities.sqlite");
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { strict: true });
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS identity_records (
			kind TEXT NOT NULL,
			filesystem_id TEXT NOT NULL,
			uuid TEXT NOT NULL,
			canonical_path TEXT NOT NULL,
			PRIMARY KEY (kind, filesystem_id),
			UNIQUE (kind, uuid)
		);
		CREATE TABLE IF NOT EXISTS identity_aliases (
			kind TEXT NOT NULL,
			path TEXT NOT NULL,
			filesystem_id TEXT NOT NULL,
			PRIMARY KEY (kind, path)
		);
		PRAGMA user_version = ${IDENTITY_SCHEMA_VERSION};
	`);
	return db;
}

function resolvePersistentUuid(
	db: Database,
	kind: "repo" | "project",
	fsIdentity: string,
	canonicalPath: string,
): string {
	const generated = Bun.randomUUIDv7();
	const write = db.transaction(() => {
		db.query(
			"INSERT OR IGNORE INTO identity_records (kind, filesystem_id, uuid, canonical_path) VALUES (?, ?, ?, ?)",
		).run(kind, fsIdentity, generated, canonicalPath);
		const record = db
			.query<IdentityRecordRow, [string, string]>(
				"SELECT uuid, canonical_path FROM identity_records WHERE kind = ? AND filesystem_id = ?",
			)
			.get(kind, fsIdentity);
		if (!record) {
			throw new Error(`Cannot resolve persistent ${kind} identity for filesystem id ${fsIdentity}.`);
		}
		if (record.canonical_path !== canonicalPath) {
			db.query("INSERT OR REPLACE INTO identity_aliases (kind, path, filesystem_id) VALUES (?, ?, ?)").run(
				kind,
				record.canonical_path,
				fsIdentity,
			);
			db.query("UPDATE identity_records SET canonical_path = ? WHERE kind = ? AND filesystem_id = ?").run(
				canonicalPath,
				kind,
				fsIdentity,
			);
		}
		db.query("INSERT OR REPLACE INTO identity_aliases (kind, path, filesystem_id) VALUES (?, ?, ?)").run(
			kind,
			canonicalPath,
			fsIdentity,
		);
		return record.uuid;
	});
	return write();
}

function recordIdentityAlias(db: Database, kind: "repo" | "project", fsIdentity: string, aliasPath: string): void {
	db.query("INSERT OR REPLACE INTO identity_aliases (kind, path, filesystem_id) VALUES (?, ?, ?)").run(
		kind,
		path.resolve(aliasPath),
		fsIdentity,
	);
}

function listIdentityAliases(db: Database, kind: "repo" | "project", fsIdentity: string): string[] {
	return db
		.query<IdentityAliasRow, [string, string]>(
			"SELECT path FROM identity_aliases WHERE kind = ? AND filesystem_id = ? ORDER BY path",
		)
		.all(kind, fsIdentity)
		.map(row => row.path);
}

export async function resolveRuntimeScopeIdentity(
	options: ResolveRuntimeScopeIdentityOptions,
): Promise<RuntimeScopeIdentity> {
	options.signal?.throwIfAborted();
	const canonicalCwd = await fs.realpath(path.resolve(options.cwd));
	const repository = await repo.resolve(canonicalCwd);
	const db = await openIdentityDatabase(options.agentDir);
	try {
		if (!repository) {
			const projectFsIdentity = filesystemIdentity(await fs.stat(canonicalCwd));
			const projectUuid = resolvePersistentUuid(db, "project", projectFsIdentity, canonicalCwd);
			recordIdentityAlias(db, "project", projectFsIdentity, options.cwd);
			return {
				userKey: "user:local",
				sessionKey: options.sessionId,
				projectKey: `project_${projectUuid}`,
				canonicalCwd,
				legacyProjectKeys: listIdentityAliases(db, "project", projectFsIdentity),
				legacyRepoKeys: [],
			};
		}

		const repoRoot = await fs.realpath(repository.repoRoot);
		const commonDir = await fs.realpath(repository.commonDir);
		const gitDir = await fs.realpath(repository.gitDir);
		const commonDirIdentity = filesystemIdentity(await fs.stat(commonDir));
		const remoteUrl = await primaryRemoteUrl(repoRoot, options.signal);
		const repoSeed = remoteUrl
			? `${normalizeRemoteUrl(remoteUrl)}\0${commonDirIdentity}`
			: `uuid:${resolvePersistentUuid(db, "repo", commonDirIdentity, commonDir)}`;
		const repoKey = `repo_${sha256(repoSeed)}`;
		const worktreeIdentity = filesystemIdentity(await fs.stat(gitDir));
		const projectKey = `project_${sha256(`${repoKey}\0${worktreeIdentity}`)}`;
		recordIdentityAlias(db, "repo", commonDirIdentity, repoRoot);
		recordIdentityAlias(db, "project", worktreeIdentity, canonicalCwd);
		recordIdentityAlias(db, "project", worktreeIdentity, options.cwd);
		return {
			userKey: "user:local",
			sessionKey: options.sessionId,
			projectKey,
			repoKey,
			canonicalCwd,
			repoRoot,
			legacyProjectKeys: listIdentityAliases(db, "project", worktreeIdentity),
			legacyRepoKeys: listIdentityAliases(db, "repo", commonDirIdentity),
		};
	} finally {
		db.close();
	}
}
