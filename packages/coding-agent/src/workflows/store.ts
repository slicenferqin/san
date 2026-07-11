import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	approvalMatches,
	createAdHocApprovalKey,
	createManagedApprovalKey,
	createWorkflowApproval,
	hashWorkflowApprovalKey,
} from "./approval";
import { canonicalWorkflowJson, workflowSourceHash, workflowValueHash } from "./fingerprint";
import { isWorkflowJsonValue, normalizeWorkflowMeta, WORKFLOW_HARD_LIMITS, type WorkflowMetaInput } from "./schema";
import { parseWorkflowSource } from "./source-parser";
import type {
	AdHocDraftStatus,
	AdHocWorkflowApprovalKey,
	AdHocWorkflowDraft,
	ManagedWorkflow,
	ManagedWorkflowApprovalKey,
	WorkflowApprovalKey,
	WorkflowApprovalRecord,
	WorkflowJsonValue,
	WorkflowWriteMode,
} from "./types";

const WORKFLOW_STORE_SCHEMA_VERSION = 1;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

const WORKFLOW_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS managed_versions (
	version_id INTEGER PRIMARY KEY,
	scope_key TEXT NOT NULL,
	name TEXT NOT NULL,
	version TEXT NOT NULL,
	source_hash TEXT NOT NULL,
	approval_key_hash TEXT NOT NULL,
	published_at TEXT NOT NULL,
	revoked_at TEXT,
	payload_json TEXT NOT NULL,
	UNIQUE(scope_key, name, version)
);

CREATE INDEX IF NOT EXISTS managed_versions_name_idx
	ON managed_versions(scope_key, name, published_at DESC);
CREATE INDEX IF NOT EXISTS managed_versions_active_idx
	ON managed_versions(revoked_at, published_at DESC);

CREATE TABLE IF NOT EXISTS ad_hoc_drafts (
	draft_id TEXT PRIMARY KEY,
	task_ref TEXT NOT NULL,
	name TEXT NOT NULL,
	source_hash TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'expired', 'consumed')),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ad_hoc_drafts_task_idx
	ON ad_hoc_drafts(task_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_hoc_drafts_expiry_idx
	ON ad_hoc_drafts(status, expires_at);

CREATE TABLE IF NOT EXISTS approvals (
	approval_id TEXT PRIMARY KEY,
	workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('managed', 'ad_hoc')),
	key_hash TEXT NOT NULL UNIQUE,
	key_json TEXT NOT NULL,
	approved_at TEXT NOT NULL,
	approved_by TEXT NOT NULL CHECK (approved_by = 'user'),
	revoked_at TEXT,
	consumed_at TEXT,
	managed_version_id INTEGER REFERENCES managed_versions(version_id),
	ad_hoc_draft_id TEXT UNIQUE REFERENCES ad_hoc_drafts(draft_id),
	CHECK (
		(workflow_kind = 'managed' AND managed_version_id IS NOT NULL AND ad_hoc_draft_id IS NULL) OR
		(workflow_kind = 'ad_hoc' AND managed_version_id IS NULL AND ad_hoc_draft_id IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS approvals_managed_idx
	ON approvals(managed_version_id, revoked_at);
CREATE INDEX IF NOT EXISTS approvals_active_idx
	ON approvals(workflow_kind, revoked_at, consumed_at, approved_at DESC);
`;

interface SchemaVersionDbRow {
	user_version: number;
}

interface ManagedVersionDbRow {
	version_id: number;
	scope_key: string;
	name: string;
	version: string;
	source_hash: string;
	approval_key_hash: string;
	published_at: string;
	revoked_at: string | null;
	payload_json: string;
}

interface AdHocDraftDbRow {
	draft_id: string;
	task_ref: string;
	name: string;
	source_hash: string;
	args_hash: string;
	scope_key: string;
	status: AdHocDraftStatus;
	created_at: string;
	expires_at: string;
	payload_json: string;
}

interface ApprovalDbRow {
	approval_id: string;
	workflow_kind: "managed" | "ad_hoc";
	key_hash: string;
	key_json: string;
	approved_at: string;
	approved_by: "user";
	revoked_at: string | null;
	consumed_at: string | null;
	managed_version_id: number | null;
	ad_hoc_draft_id: string | null;
}

export interface ManagedWorkflowVersionRecord {
	workflow: ManagedWorkflow;
	publishedAt: string;
	revokedAt?: string;
}

export interface ManagedWorkflowListOptions {
	scopeKey?: string;
	name?: string;
	includeRevoked?: boolean;
	limit?: number;
}

export interface AdHocWorkflowListOptions {
	taskRef?: string;
	scopeKey?: string;
	status?: AdHocDraftStatus;
	limit?: number;
}

export interface WorkflowApprovalListOptions {
	workflowKind?: "managed" | "ad_hoc";
	includeInactive?: boolean;
	limit?: number;
	now?: Date;
}

export class WorkflowStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStoreError";
	}
}

export class WorkflowStoreConflictError extends WorkflowStoreError {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStoreConflictError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new WorkflowStoreError(`${label} must be a non-empty string.`);
	return value;
}

function isoTimestamp(value: unknown, label: string): string {
	const timestamp = nonEmptyString(value, label);
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
		throw new WorkflowStoreError(`${label} must be a canonical ISO timestamp.`);
	}
	return timestamp;
}

function nowTimestamp(now: Date): string {
	if (!Number.isFinite(now.getTime())) throw new WorkflowStoreError("Workflow store time must be valid.");
	return now.toISOString();
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new WorkflowStoreError(`${label} must be a positive integer no greater than ${maximum}.`);
	}
	return value;
}

function listLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(value)));
}

function parseJson(payload: string, label: string): unknown {
	try {
		return JSON.parse(payload);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkflowStoreError(`${label} contains invalid JSON: ${message}`);
	}
}

function writeMode(value: unknown, label: string): WorkflowWriteMode {
	if (value !== "read_only" && value !== "isolated_write") {
		throw new WorkflowStoreError(`${label} must be read_only or isolated_write.`);
	}
	return value;
}

function assertHash(actual: unknown, expected: string, label: string): string {
	const hash = nonEmptyString(actual, label);
	if (hash !== expected) throw new WorkflowStoreError(`${label} does not match the persisted Workflow content.`);
	return hash;
}

function parseManagedWorkflow(value: unknown): ManagedWorkflow {
	if (!isRecord(value) || value.kind !== "managed") {
		throw new WorkflowStoreError("Managed Workflow payload has an invalid product kind.");
	}
	if (!isRecord(value.meta)) throw new WorkflowStoreError("Managed Workflow payload has invalid metadata.");
	const meta = normalizeWorkflowMeta(value.meta as WorkflowMetaInput);
	if (!isRecord(value.source)) throw new WorkflowStoreError("Managed Workflow payload has an invalid source.");
	const provider = value.source.provider;
	const level = value.source.level;
	if (provider !== "san" && provider !== "claude" && provider !== "session") {
		throw new WorkflowStoreError("Managed Workflow source provider is invalid.");
	}
	if (level !== "user" && level !== "project" && level !== "session") {
		throw new WorkflowStoreError("Managed Workflow source level is invalid.");
	}
	const scopeKey = nonEmptyString(value.source.scopeKey, "Managed Workflow scopeKey");
	const sourcePath = value.source.path;
	if (sourcePath !== undefined && (typeof sourcePath !== "string" || !sourcePath)) {
		throw new WorkflowStoreError("Managed Workflow source path must be a non-empty string when present.");
	}
	const sourceText = nonEmptyString(value.sourceText, "Managed Workflow sourceText");
	const parsed = parseWorkflowSource(sourceText);
	if (parsed.violations.length > 0) {
		throw new WorkflowStoreError(`Managed Workflow source is unsafe: ${parsed.violations.join("; ")}`);
	}
	if (workflowValueHash(parsed.meta) !== workflowValueHash(meta)) {
		throw new WorkflowStoreError("Managed Workflow metadata does not match its source text.");
	}
	const sourceHash = assertHash(value.sourceHash, workflowSourceHash(sourceText), "Managed Workflow sourceHash");
	const argsSchemaHash = assertHash(
		value.argsSchemaHash,
		workflowValueHash(meta.argsSchema ?? null),
		"Managed Workflow argsSchemaHash",
	);
	const permissionManifestHash = assertHash(
		value.permissionManifestHash,
		workflowValueHash(meta.permissions),
		"Managed Workflow permissionManifestHash",
	);
	return {
		kind: "managed",
		meta,
		source: {
			provider,
			level,
			...(typeof sourcePath === "string" ? { path: sourcePath } : {}),
			scopeKey,
		},
		sourceText,
		sourceHash,
		argsSchemaHash,
		permissionManifestHash,
	};
}

function parseAdHocDraft(value: unknown): AdHocWorkflowDraft {
	if (!isRecord(value) || value.kind !== "ad_hoc") {
		throw new WorkflowStoreError("Ad-hoc Workflow payload has an invalid product kind.");
	}
	const name = nonEmptyString(value.name, "Ad-hoc Workflow name");
	const description = nonEmptyString(value.description, "Ad-hoc Workflow description");
	const meta = normalizeWorkflowMeta({
		name,
		description,
		version: "1",
		argsSchema: value.argsSchema,
		permissions: value.permissions,
		limits: value.limits,
	});
	const status = value.status;
	if (
		status !== "draft" &&
		status !== "approved" &&
		status !== "rejected" &&
		status !== "expired" &&
		status !== "consumed"
	) {
		throw new WorkflowStoreError("Ad-hoc Workflow status is invalid.");
	}
	const args = value.args;
	if (args !== undefined && !isWorkflowJsonValue(args)) {
		throw new WorkflowStoreError("Ad-hoc Workflow args must be JSON-compatible.");
	}
	const sourceText = nonEmptyString(value.sourceText, "Ad-hoc Workflow sourceText");
	const createdAt = isoTimestamp(value.createdAt, "Ad-hoc Workflow createdAt");
	const expiresAt = isoTimestamp(value.expiresAt, "Ad-hoc Workflow expiresAt");
	if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
		throw new WorkflowStoreError("Ad-hoc Workflow expiresAt must be after createdAt.");
	}
	const sourceHash = assertHash(value.sourceHash, workflowSourceHash(sourceText), "Ad-hoc Workflow sourceHash");
	const argsHash = assertHash(value.argsHash, workflowValueHash(args ?? null), "Ad-hoc Workflow argsHash");
	const argsSchemaHash = assertHash(
		value.argsSchemaHash,
		workflowValueHash(meta.argsSchema ?? null),
		"Ad-hoc Workflow argsSchemaHash",
	);
	const permissionManifestHash = assertHash(
		value.permissionManifestHash,
		workflowValueHash(meta.permissions),
		"Ad-hoc Workflow permissionManifestHash",
	);
	return {
		kind: "ad_hoc",
		draftId: nonEmptyString(value.draftId, "Ad-hoc Workflow draftId"),
		taskRef: nonEmptyString(value.taskRef, "Ad-hoc Workflow taskRef"),
		name,
		description,
		humanSummary: nonEmptyString(value.humanSummary, "Ad-hoc Workflow humanSummary"),
		sourceText,
		sourceHash,
		...(args === undefined ? {} : { args: args as WorkflowJsonValue }),
		argsHash,
		...(meta.argsSchema ? { argsSchema: meta.argsSchema } : {}),
		argsSchemaHash,
		permissions: meta.permissions,
		permissionManifestHash,
		limits: meta.limits,
		scopeKey: nonEmptyString(value.scopeKey, "Ad-hoc Workflow scopeKey"),
		createdAt,
		expiresAt,
		status,
	};
}

function parseManagedApprovalKey(value: Record<string, unknown>): ManagedWorkflowApprovalKey {
	return {
		workflowKind: "managed",
		name: nonEmptyString(value.name, "Managed approval name"),
		version: nonEmptyString(value.version, "Managed approval version"),
		sourceHash: nonEmptyString(value.sourceHash, "Managed approval sourceHash"),
		argsSchemaHash: nonEmptyString(value.argsSchemaHash, "Managed approval argsSchemaHash"),
		scopeKey: nonEmptyString(value.scopeKey, "Managed approval scopeKey"),
		permissionManifestHash: nonEmptyString(value.permissionManifestHash, "Managed approval permissionManifestHash"),
		concurrencyLimit: positiveInteger(
			value.concurrencyLimit,
			"Managed approval concurrencyLimit",
			WORKFLOW_HARD_LIMITS.concurrency,
		),
		agentLimit: positiveInteger(value.agentLimit, "Managed approval agentLimit", WORKFLOW_HARD_LIMITS.agentLimit),
		tokenLimit: positiveInteger(value.tokenLimit, "Managed approval tokenLimit", WORKFLOW_HARD_LIMITS.tokenLimit),
		durationMs: positiveInteger(value.durationMs, "Managed approval durationMs", WORKFLOW_HARD_LIMITS.durationMs),
		writeMode: writeMode(value.writeMode, "Managed approval writeMode"),
	};
}

function parseAdHocApprovalKey(value: Record<string, unknown>): AdHocWorkflowApprovalKey {
	const common = parseManagedApprovalKey({
		...value,
		workflowKind: "managed",
		name: "ad-hoc-placeholder",
		version: "1",
	});
	return {
		workflowKind: "ad_hoc",
		draftId: nonEmptyString(value.draftId, "Ad-hoc approval draftId"),
		taskRef: nonEmptyString(value.taskRef, "Ad-hoc approval taskRef"),
		sourceHash: common.sourceHash,
		argsHash: nonEmptyString(value.argsHash, "Ad-hoc approval argsHash"),
		argsSchemaHash: common.argsSchemaHash,
		scopeKey: common.scopeKey,
		permissionManifestHash: common.permissionManifestHash,
		concurrencyLimit: common.concurrencyLimit,
		agentLimit: common.agentLimit,
		tokenLimit: common.tokenLimit,
		durationMs: common.durationMs,
		writeMode: common.writeMode,
		expiresAt: isoTimestamp(value.expiresAt, "Ad-hoc approval expiresAt"),
	};
}

function parseApprovalKey(value: unknown): WorkflowApprovalKey {
	if (!isRecord(value)) throw new WorkflowStoreError("Workflow approval key must be an object.");
	if (value.workflowKind === "managed") return parseManagedApprovalKey(value);
	if (value.workflowKind === "ad_hoc") return parseAdHocApprovalKey(value);
	throw new WorkflowStoreError("Workflow approval key has an invalid product kind.");
}

function approvalRecord(row: ApprovalDbRow): WorkflowApprovalRecord {
	const key = parseApprovalKey(parseJson(row.key_json, `Workflow approval ${row.approval_id}`));
	if (key.workflowKind !== row.workflow_kind) {
		throw new WorkflowStoreError(`Workflow approval ${row.approval_id} kind does not match its database row.`);
	}
	const keyHash = hashWorkflowApprovalKey(key);
	if (row.key_hash !== keyHash) {
		throw new WorkflowStoreError(`Workflow approval ${row.approval_id} key hash is corrupt.`);
	}
	const approvedAt = isoTimestamp(row.approved_at, `Workflow approval ${row.approval_id} approvedAt`);
	const revokedAt = row.revoked_at
		? isoTimestamp(row.revoked_at, `Workflow approval ${row.approval_id} revokedAt`)
		: undefined;
	const consumedAt = row.consumed_at
		? isoTimestamp(row.consumed_at, `Workflow approval ${row.approval_id} consumedAt`)
		: undefined;
	return {
		approvalId: nonEmptyString(row.approval_id, "Workflow approval id"),
		keyHash,
		key,
		approvedAt,
		approvedBy: "user",
		...(revokedAt ? { revokedAt } : {}),
		...(consumedAt ? { consumedAt } : {}),
	};
}

function managedVersionRecord(row: ManagedVersionDbRow): ManagedWorkflowVersionRecord {
	const workflow = parseManagedWorkflow(parseJson(row.payload_json, `Managed Workflow ${row.name}@${row.version}`));
	if (
		workflow.source.scopeKey !== row.scope_key ||
		workflow.meta.name !== row.name ||
		workflow.meta.version !== row.version ||
		workflow.sourceHash !== row.source_hash
	) {
		throw new WorkflowStoreError(`Managed Workflow ${row.name}@${row.version} database index is corrupt.`);
	}
	const approvalKeyHash = hashWorkflowApprovalKey(createManagedApprovalKey(workflow));
	if (approvalKeyHash !== row.approval_key_hash) {
		throw new WorkflowStoreError(`Managed Workflow ${row.name}@${row.version} approval key is corrupt.`);
	}
	return {
		workflow,
		publishedAt: isoTimestamp(row.published_at, `Managed Workflow ${row.name}@${row.version} publishedAt`),
		...(row.revoked_at
			? { revokedAt: isoTimestamp(row.revoked_at, `Managed Workflow ${row.name}@${row.version} revokedAt`) }
			: {}),
	};
}

function adHocDraftRecord(row: AdHocDraftDbRow): AdHocWorkflowDraft {
	const draft = parseAdHocDraft(parseJson(row.payload_json, `Ad-hoc Workflow ${row.draft_id}`));
	if (
		draft.draftId !== row.draft_id ||
		draft.taskRef !== row.task_ref ||
		draft.name !== row.name ||
		draft.sourceHash !== row.source_hash ||
		draft.argsHash !== row.args_hash ||
		draft.scopeKey !== row.scope_key ||
		draft.createdAt !== row.created_at ||
		draft.expiresAt !== row.expires_at
	) {
		throw new WorkflowStoreError(`Ad-hoc Workflow ${row.draft_id} database index is corrupt.`);
	}
	return { ...draft, status: row.status };
}

export function getWorkflowStoreDbPath(agentDir: string): string {
	return path.join(agentDir, "workflows", "workflows.sqlite");
}

export class WorkflowStore {
	#db: Database;
	#dbPath: string;

	constructor(dbPath: string) {
		this.#dbPath = dbPath;
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath, { strict: true });
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA synchronous = NORMAL");
		this.#migrate();
	}

	static open(agentDir: string): WorkflowStore {
		return new WorkflowStore(getWorkflowStoreDbPath(agentDir));
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	get schemaVersion(): number {
		const row = this.#db.query("PRAGMA user_version").get() as SchemaVersionDbRow | null;
		return row?.user_version ?? 0;
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		const currentVersion = this.schemaVersion;
		if (currentVersion > WORKFLOW_STORE_SCHEMA_VERSION) {
			throw new WorkflowStoreError(
				`Workflow database schema ${currentVersion} is newer than supported version ${WORKFLOW_STORE_SCHEMA_VERSION}.`,
			);
		}
		if (currentVersion === WORKFLOW_STORE_SCHEMA_VERSION) return;
		const migrate = this.#db.transaction(() => {
			this.#db.run(WORKFLOW_STORE_SCHEMA_SQL);
			this.#db.run(`PRAGMA user_version = ${WORKFLOW_STORE_SCHEMA_VERSION}`);
		});
		migrate();
	}

	publishManagedVersion(workflowInput: ManagedWorkflow, now = new Date()): ManagedWorkflowVersionRecord {
		const workflow = parseManagedWorkflow(workflowInput);
		const publishedAt = nowTimestamp(now);
		const approvalKeyHash = hashWorkflowApprovalKey(createManagedApprovalKey(workflow));
		const publish = this.#db.transaction(() => {
			const existing = this.#getManagedVersionRow(
				workflow.meta.name,
				workflow.meta.version,
				workflow.source.scopeKey,
			);
			if (existing) {
				if (existing.approval_key_hash !== approvalKeyHash) {
					throw new WorkflowStoreConflictError(
						`Managed Workflow ${workflow.meta.name}@${workflow.meta.version} is already published with different approval boundaries.`,
					);
				}
				return managedVersionRecord(existing);
			}
			this.#db
				.prepare(
					`INSERT INTO managed_versions (
						scope_key, name, version, source_hash, approval_key_hash, published_at, payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					workflow.source.scopeKey,
					workflow.meta.name,
					workflow.meta.version,
					workflow.sourceHash,
					approvalKeyHash,
					publishedAt,
					canonicalWorkflowJson(workflow),
				);
			const inserted = this.#getManagedVersionRow(
				workflow.meta.name,
				workflow.meta.version,
				workflow.source.scopeKey,
			);
			if (!inserted) throw new WorkflowStoreError("Managed Workflow disappeared after publication.");
			return managedVersionRecord(inserted);
		});
		return publish();
	}

	getManagedVersion(name: string, version: string, scopeKey: string): ManagedWorkflowVersionRecord | undefined {
		const row = this.#getManagedVersionRow(name, version, scopeKey);
		return row ? managedVersionRecord(row) : undefined;
	}

	listManagedVersions(options: ManagedWorkflowListOptions = {}): ManagedWorkflowVersionRecord[] {
		const rows = this.#db
			.query(
				`SELECT version_id, scope_key, name, version, source_hash, approval_key_hash,
					published_at, revoked_at, payload_json
				 FROM managed_versions
				 WHERE (? IS NULL OR scope_key = ?)
				   AND (? IS NULL OR name = ?)
				   AND (? = 1 OR revoked_at IS NULL)
				 ORDER BY published_at DESC, version_id DESC
				 LIMIT ?`,
			)
			.all(
				options.scopeKey ?? null,
				options.scopeKey ?? null,
				options.name ?? null,
				options.name ?? null,
				options.includeRevoked === true ? 1 : 0,
				listLimit(options.limit),
			) as ManagedVersionDbRow[];
		return rows.map(managedVersionRecord);
	}

	approveManagedVersion(workflowInput: ManagedWorkflow, now = new Date()): WorkflowApprovalRecord {
		const workflow = parseManagedWorkflow(workflowInput);
		const approvedAt = nowTimestamp(now);
		const key = createManagedApprovalKey(workflow);
		const keyHash = hashWorkflowApprovalKey(key);
		const approve = this.#db.transaction(() => {
			const version = this.#getManagedVersionRow(
				workflow.meta.name,
				workflow.meta.version,
				workflow.source.scopeKey,
			);
			if (!version || version.approval_key_hash !== keyHash) {
				throw new WorkflowStoreConflictError(
					"Managed Workflow must be published unchanged before it can be approved.",
				);
			}
			if (version.revoked_at)
				throw new WorkflowStoreConflictError("A revoked Managed Workflow version cannot be approved.");
			const existing = this.#getApprovalByKeyHash(keyHash);
			if (existing) {
				const record = approvalRecord(existing);
				if (record.revokedAt) {
					throw new WorkflowStoreConflictError("This exact Managed Workflow approval was revoked.");
				}
				return record;
			}
			const record = createWorkflowApproval(key, new Date(approvedAt));
			this.#insertApproval(record, version.version_id, null);
			return record;
		});
		return approve();
	}

	findManagedApproval(workflowInput: ManagedWorkflow, now = new Date()): WorkflowApprovalRecord | undefined {
		const workflow = parseManagedWorkflow(workflowInput);
		const key = createManagedApprovalKey(workflow);
		const version = this.#getManagedVersionRow(workflow.meta.name, workflow.meta.version, workflow.source.scopeKey);
		if (!version || version.revoked_at || version.approval_key_hash !== hashWorkflowApprovalKey(key))
			return undefined;
		const row = this.#getApprovalByKeyHash(hashWorkflowApprovalKey(key));
		if (!row) return undefined;
		const record = approvalRecord(row);
		return approvalMatches(record, key, now) ? record : undefined;
	}

	revokeManagedVersion(workflowInput: ManagedWorkflow, now = new Date()): boolean {
		const workflow = parseManagedWorkflow(workflowInput);
		const revokedAt = nowTimestamp(now);
		const keyHash = hashWorkflowApprovalKey(createManagedApprovalKey(workflow));
		const revoke = this.#db.transaction(() => {
			const row = this.#getManagedVersionRow(workflow.meta.name, workflow.meta.version, workflow.source.scopeKey);
			if (!row || row.approval_key_hash !== keyHash) return false;
			if (row.revoked_at) return false;
			this.#db
				.prepare("UPDATE managed_versions SET revoked_at = ? WHERE version_id = ? AND revoked_at IS NULL")
				.run(revokedAt, row.version_id);
			this.#db
				.prepare("UPDATE approvals SET revoked_at = ? WHERE managed_version_id = ? AND revoked_at IS NULL")
				.run(revokedAt, row.version_id);
			return true;
		});
		return revoke();
	}

	saveAdHocDraft(draftInput: AdHocWorkflowDraft): AdHocWorkflowDraft {
		const draft = parseAdHocDraft(draftInput);
		if (draft.status !== "draft")
			throw new WorkflowStoreConflictError("A new Ad-hoc Workflow must be saved as a draft.");
		this.#db
			.prepare(
				`INSERT OR IGNORE INTO ad_hoc_drafts (
					draft_id, task_ref, name, source_hash, args_hash, scope_key,
					status, created_at, expires_at, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
			)
			.run(
				draft.draftId,
				draft.taskRef,
				draft.name,
				draft.sourceHash,
				draft.argsHash,
				draft.scopeKey,
				draft.createdAt,
				draft.expiresAt,
				canonicalWorkflowJson(draft),
			);
		const row = this.#getAdHocDraftRow(draft.draftId);
		if (!row) throw new WorkflowStoreError("Ad-hoc Workflow disappeared after saving its draft.");
		const stored = adHocDraftRecord(row);
		if (
			hashWorkflowApprovalKey(createAdHocApprovalKey(stored)) !==
			hashWorkflowApprovalKey(createAdHocApprovalKey(draft))
		) {
			throw new WorkflowStoreConflictError(
				`Ad-hoc Workflow draft ${draft.draftId} already exists with different content.`,
			);
		}
		return stored;
	}

	getAdHocDraft(draftId: string): AdHocWorkflowDraft | undefined {
		const row = this.#getAdHocDraftRow(draftId);
		return row ? adHocDraftRecord(row) : undefined;
	}

	listAdHocDrafts(options: AdHocWorkflowListOptions = {}): AdHocWorkflowDraft[] {
		const rows = this.#db
			.query(
				`SELECT draft_id, task_ref, name, source_hash, args_hash, scope_key,
					status, created_at, expires_at, payload_json
				 FROM ad_hoc_drafts
					 WHERE (? IS NULL OR task_ref = ?)
					   AND (? IS NULL OR scope_key = ?)
					   AND (? IS NULL OR status = ?)
				 ORDER BY created_at DESC, draft_id DESC
				 LIMIT ?`,
			)
			.all(
				options.taskRef ?? null,
				options.taskRef ?? null,
				options.scopeKey ?? null,
				options.scopeKey ?? null,
				options.status ?? null,
				options.status ?? null,
				listLimit(options.limit),
			) as AdHocDraftDbRow[];
		return rows.map(adHocDraftRecord);
	}

	/** Removes one-time draft content after rejection, expiry or consumption. */
	deleteAdHocDraft(draftId: string, allowedStatuses: readonly AdHocDraftStatus[]): boolean {
		if (allowedStatuses.length === 0) {
			throw new WorkflowStoreError("Ad-hoc Workflow deletion requires an allowed terminal state.");
		}
		const placeholders = allowedStatuses.map(() => "?").join(", ");
		const remove = this.#db.transaction(() => {
			const row = this.#getAdHocDraftRow(draftId);
			if (!row) return false;
			if (!allowedStatuses.includes(row.status)) {
				throw new WorkflowStoreConflictError(
					`Ad-hoc Workflow draft ${draftId} cannot be removed from ${row.status}.`,
				);
			}
			this.#db.prepare("DELETE FROM approvals WHERE ad_hoc_draft_id = ?").run(draftId);
			const result = this.#db
				.prepare(`DELETE FROM ad_hoc_drafts WHERE draft_id = ? AND status IN (${placeholders})`)
				.run(draftId, ...allowedStatuses);
			return result.changes === 1;
		});
		return remove();
	}

	rejectAdHocDraft(draftId: string, now = new Date()): AdHocWorkflowDraft {
		const rejectedAt = nowTimestamp(now);
		if (this.#expireAdHocDraft(draftId, rejectedAt)) {
			throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${draftId} has expired.`);
		}
		const reject = this.#db.transaction(() => {
			const row = this.#requiredAdHocDraftRow(draftId);
			if (row.status === "rejected") return adHocDraftRecord(row);
			if (row.status !== "draft" && row.status !== "approved") {
				throw new WorkflowStoreConflictError(
					`Ad-hoc Workflow draft ${draftId} cannot be rejected from ${row.status}.`,
				);
			}
			if (row.status === "approved") {
				this.#db
					.prepare(
						"UPDATE approvals SET revoked_at = ? WHERE ad_hoc_draft_id = ? AND revoked_at IS NULL AND consumed_at IS NULL",
					)
					.run(rejectedAt, draftId);
			}
			this.#setAdHocStatus(draftId, "rejected", ["draft", "approved"]);
			return adHocDraftRecord(this.#requiredAdHocDraftRow(draftId));
		});
		return reject();
	}

	expireAdHocDrafts(now = new Date()): number {
		const expiresAt = nowTimestamp(now);
		const expire = this.#db.transaction(() => {
			const result = this.#db
				.prepare(
					"UPDATE ad_hoc_drafts SET status = 'expired' WHERE status IN ('draft', 'approved') AND expires_at <= ?",
				)
				.run(expiresAt);
			return result.changes;
		});
		return expire();
	}

	expireAdHocDraft(draftId: string, now = new Date()): AdHocWorkflowDraft | undefined {
		const expiredAt = nowTimestamp(now);
		if (!this.#expireAdHocDraft(draftId, expiredAt)) return undefined;
		return adHocDraftRecord(this.#requiredAdHocDraftRow(draftId));
	}

	approveAdHocDraft(draftInput: AdHocWorkflowDraft, now = new Date()): WorkflowApprovalRecord {
		const expectedDraft = parseAdHocDraft(draftInput);
		const approvedAt = nowTimestamp(now);
		if (this.#expireAdHocDraft(expectedDraft.draftId, approvedAt)) {
			throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${expectedDraft.draftId} has expired.`);
		}
		const approve = this.#db.transaction(() => {
			const row = this.#requiredAdHocDraftRow(expectedDraft.draftId);
			const draft = adHocDraftRecord(row);
			const key = createAdHocApprovalKey(draft);
			const expectedKeyHash = hashWorkflowApprovalKey(createAdHocApprovalKey(expectedDraft));
			const keyHash = hashWorkflowApprovalKey(key);
			if (keyHash !== expectedKeyHash) {
				throw new WorkflowStoreConflictError("Ad-hoc Workflow changed after it was presented for approval.");
			}
			const existing = this.#getApprovalByKeyHash(keyHash);
			if (existing) {
				const record = approvalRecord(existing);
				if (draft.status !== "approved" || !approvalMatches(record, key, new Date(approvedAt))) {
					throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${draft.draftId} has no reusable approval.`);
				}
				return record;
			}
			if (draft.status !== "draft") {
				throw new WorkflowStoreConflictError(
					`Ad-hoc Workflow draft ${draft.draftId} cannot be approved from ${draft.status}.`,
				);
			}
			const record = createWorkflowApproval(key, new Date(approvedAt));
			this.#insertApproval(record, null, draft.draftId);
			this.#setAdHocStatus(draft.draftId, "approved", ["draft"]);
			return record;
		});
		return approve();
	}

	findAdHocApproval(draftInput: AdHocWorkflowDraft, now = new Date()): WorkflowApprovalRecord | undefined {
		const expectedDraft = parseAdHocDraft(draftInput);
		const row = this.#getAdHocDraftRow(expectedDraft.draftId);
		if (row?.status !== "approved") return undefined;
		const stored = adHocDraftRecord(row);
		const key = createAdHocApprovalKey(stored);
		if (hashWorkflowApprovalKey(key) !== hashWorkflowApprovalKey(createAdHocApprovalKey(expectedDraft)))
			return undefined;
		const approval = this.#getApprovalByKeyHash(hashWorkflowApprovalKey(key));
		if (!approval) return undefined;
		const record = approvalRecord(approval);
		return approvalMatches(record, key, now) ? record : undefined;
	}

	consumeAdHocApproval(draftInput: AdHocWorkflowDraft, approvalId: string, now = new Date()): WorkflowApprovalRecord {
		const expectedDraft = parseAdHocDraft(draftInput);
		const consumedAt = nowTimestamp(now);
		if (this.#expireAdHocDraft(expectedDraft.draftId, consumedAt)) {
			throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${expectedDraft.draftId} has expired.`);
		}
		const consume = this.#db.transaction(() => {
			const row = this.#requiredAdHocDraftRow(expectedDraft.draftId);
			const draft = adHocDraftRecord(row);
			const key = createAdHocApprovalKey(draft);
			if (hashWorkflowApprovalKey(key) !== hashWorkflowApprovalKey(createAdHocApprovalKey(expectedDraft))) {
				throw new WorkflowStoreConflictError("Ad-hoc Workflow changed after approval.");
			}
			if (draft.status !== "approved") {
				throw new WorkflowStoreConflictError(
					`Ad-hoc Workflow draft ${draft.draftId} cannot run from ${draft.status}.`,
				);
			}
			const approvalRow = this.#getApprovalRow(approvalId);
			if (!approvalRow) throw new WorkflowStoreConflictError(`Workflow approval ${approvalId} does not exist.`);
			const record = approvalRecord(approvalRow);
			if (!approvalMatches(record, key, new Date(consumedAt))) {
				throw new WorkflowStoreConflictError("Ad-hoc Workflow approval is invalid, expired, revoked or consumed.");
			}
			const approvalUpdate = this.#db
				.prepare(
					"UPDATE approvals SET consumed_at = ? WHERE approval_id = ? AND revoked_at IS NULL AND consumed_at IS NULL",
				)
				.run(consumedAt, approvalId);
			if (approvalUpdate.changes !== 1) {
				throw new WorkflowStoreConflictError("Ad-hoc Workflow approval was already consumed.");
			}
			this.#setAdHocStatus(draft.draftId, "consumed", ["approved"]);
			const consumed = this.#getApprovalRow(approvalId);
			if (!consumed) throw new WorkflowStoreError("Ad-hoc Workflow approval disappeared after consumption.");
			return approvalRecord(consumed);
		});
		return consume();
	}

	getApproval(approvalId: string): WorkflowApprovalRecord | undefined {
		const row = this.#getApprovalRow(approvalId);
		return row ? approvalRecord(row) : undefined;
	}

	listApprovals(options: WorkflowApprovalListOptions = {}): WorkflowApprovalRecord[] {
		const now = nowTimestamp(options.now ?? new Date());
		const rows = this.#db
			.query(
				`SELECT a.approval_id, a.workflow_kind, a.key_hash, a.key_json, a.approved_at, a.approved_by,
					a.revoked_at, a.consumed_at, a.managed_version_id, a.ad_hoc_draft_id
				 FROM approvals a
				 LEFT JOIN ad_hoc_drafts d ON d.draft_id = a.ad_hoc_draft_id
				 WHERE (? IS NULL OR a.workflow_kind = ?)
				   AND (
					? = 1 OR (
						a.revoked_at IS NULL AND a.consumed_at IS NULL AND
						(a.workflow_kind = 'managed' OR (d.status = 'approved' AND d.expires_at > ?))
					)
				   )
				 ORDER BY a.approved_at DESC, a.approval_id DESC
				 LIMIT ?`,
			)
			.all(
				options.workflowKind ?? null,
				options.workflowKind ?? null,
				options.includeInactive === true ? 1 : 0,
				now,
				listLimit(options.limit),
			) as ApprovalDbRow[];
		return rows.map(approvalRecord);
	}

	revokeApproval(approvalId: string, now = new Date()): WorkflowApprovalRecord | undefined {
		const revokedAt = nowTimestamp(now);
		const revoke = this.#db.transaction(() => {
			const row = this.#getApprovalRow(approvalId);
			if (!row) return undefined;
			if (!row.revoked_at && !row.consumed_at) {
				this.#db
					.prepare("UPDATE approvals SET revoked_at = ? WHERE approval_id = ? AND revoked_at IS NULL")
					.run(revokedAt, approvalId);
				if (row.workflow_kind === "ad_hoc" && row.ad_hoc_draft_id) {
					const draft = this.#getAdHocDraftRow(row.ad_hoc_draft_id);
					if (draft?.status === "approved") {
						this.#setAdHocStatus(row.ad_hoc_draft_id, "rejected", ["approved"]);
					}
				}
			}
			const updated = this.#getApprovalRow(approvalId);
			return updated ? approvalRecord(updated) : undefined;
		});
		return revoke();
	}

	#getManagedVersionRow(name: string, version: string, scopeKey: string): ManagedVersionDbRow | undefined {
		return (
			(this.#db
				.query(
					`SELECT version_id, scope_key, name, version, source_hash, approval_key_hash,
						published_at, revoked_at, payload_json
					 FROM managed_versions WHERE scope_key = ? AND name = ? AND version = ?`,
				)
				.get(scopeKey, name, version) as ManagedVersionDbRow | null) ?? undefined
		);
	}

	#getAdHocDraftRow(draftId: string): AdHocDraftDbRow | undefined {
		return (
			(this.#db
				.query(
					`SELECT draft_id, task_ref, name, source_hash, args_hash, scope_key,
						status, created_at, expires_at, payload_json
					 FROM ad_hoc_drafts WHERE draft_id = ?`,
				)
				.get(draftId) as AdHocDraftDbRow | null) ?? undefined
		);
	}

	#requiredAdHocDraftRow(draftId: string): AdHocDraftDbRow {
		const row = this.#getAdHocDraftRow(draftId);
		if (!row) throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${draftId} does not exist.`);
		return row;
	}

	#getApprovalRow(approvalId: string): ApprovalDbRow | undefined {
		return (
			(this.#db
				.query(
					`SELECT approval_id, workflow_kind, key_hash, key_json, approved_at, approved_by,
						revoked_at, consumed_at, managed_version_id, ad_hoc_draft_id
					 FROM approvals WHERE approval_id = ?`,
				)
				.get(approvalId) as ApprovalDbRow | null) ?? undefined
		);
	}

	#getApprovalByKeyHash(keyHash: string): ApprovalDbRow | undefined {
		return (
			(this.#db
				.query(
					`SELECT approval_id, workflow_kind, key_hash, key_json, approved_at, approved_by,
						revoked_at, consumed_at, managed_version_id, ad_hoc_draft_id
					 FROM approvals WHERE key_hash = ?`,
				)
				.get(keyHash) as ApprovalDbRow | null) ?? undefined
		);
	}

	#insertApproval(record: WorkflowApprovalRecord, managedVersionId: number | null, adHocDraftId: string | null): void {
		this.#db
			.prepare(
				`INSERT INTO approvals (
					approval_id, workflow_kind, key_hash, key_json, approved_at, approved_by,
					managed_version_id, ad_hoc_draft_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.approvalId,
				record.key.workflowKind,
				record.keyHash,
				canonicalWorkflowJson(record.key),
				record.approvedAt,
				record.approvedBy,
				managedVersionId,
				adHocDraftId,
			);
	}

	#setAdHocStatus(draftId: string, status: AdHocDraftStatus, from: readonly AdHocDraftStatus[]): void {
		if (from.length === 0) throw new WorkflowStoreError("Ad-hoc Workflow status update requires a source state.");
		const placeholders = from.map(() => "?").join(", ");
		const result = this.#db
			.prepare(`UPDATE ad_hoc_drafts SET status = ? WHERE draft_id = ? AND status IN (${placeholders})`)
			.run(status, draftId, ...from);
		if (result.changes !== 1) {
			throw new WorkflowStoreConflictError(`Ad-hoc Workflow draft ${draftId} changed state concurrently.`);
		}
	}

	#expireAdHocDraft(draftId: string, now: string): boolean {
		const result = this.#db
			.prepare(
				"UPDATE ad_hoc_drafts SET status = 'expired' WHERE draft_id = ? AND status IN ('draft', 'approved') AND expires_at <= ?",
			)
			.run(draftId, now);
		return result.changes === 1;
	}
}
