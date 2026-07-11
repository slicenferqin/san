import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry } from "../session/session-entries";
import { mergeSanBrainCandidateRecords } from "./consolidate";
import { listSanBrainLedgerEntries } from "./ledger";
import { buildSanBrainProjectionPlans } from "./projection-plan";
import {
	isSanBrainDecision,
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	type SanBrainCandidate,
	type SanBrainCandidateKind,
	type SanBrainDecision,
	type SanBrainProjection,
	type SanBrainProjectionErrorCode,
	type SanBrainProjectionNotification,
	type SanBrainProjectionState,
	type SanBrainProjectionTarget,
} from "./types";

const BRAIN_DB_SCHEMA_VERSION = 2;
const DEFAULT_LIST_LIMIT = 20;

const BRAIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candidates (
	candidate_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('profile', 'experience')),
	source_session_id TEXT NOT NULL,
	source_entry_id TEXT NOT NULL UNIQUE,
	scope_kind TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	claim_key TEXT NOT NULL,
	dedupe_key TEXT NOT NULL,
	conflict_key TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	revision INTEGER NOT NULL DEFAULT 0,
	confidence REAL NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS candidates_status_created_idx ON candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS candidates_scope_idx ON candidates(scope_kind, scope_key, status);
CREATE INDEX IF NOT EXISTS candidates_claim_idx ON candidates(claim_key, status);

CREATE TABLE IF NOT EXISTS decisions (
	decision_id TEXT PRIMARY KEY,
	source_session_id TEXT NOT NULL,
	source_entry_id TEXT NOT NULL UNIQUE,
	owner_id TEXT NOT NULL,
	action TEXT NOT NULL,
	previous_revision INTEGER,
	next_revision INTEGER NOT NULL,
	idempotency_key TEXT NOT NULL UNIQUE,
	application_state TEXT NOT NULL DEFAULT 'pending' CHECK (application_state IN ('pending', 'applied', 'blocked')),
	application_error TEXT,
	created_at TEXT NOT NULL,
	payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_owner_created_idx ON decisions(owner_id, created_at);
CREATE INDEX IF NOT EXISTS decisions_state_created_idx ON decisions(application_state, created_at);

CREATE TABLE IF NOT EXISTS active_states (
	owner_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('profile', 'experience')),
	scope_kind TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	revision INTEGER NOT NULL,
	decision_id TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS active_states_scope_idx ON active_states(scope_kind, scope_key, kind);

CREATE TABLE IF NOT EXISTS projections (
	projection_id TEXT PRIMARY KEY,
	decision_id TEXT NOT NULL,
	target TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed', 'compensating', 'compensated', 'blocked')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	revision INTEGER,
	before_hash TEXT,
	after_hash TEXT,
	error_code TEXT,
	error TEXT,
	duration_ms INTEGER,
	receipt_id TEXT,
	notified_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projections_decision_idx ON projections(decision_id, state);
`;

type CandidateStatus = "pending" | "active" | "discarded" | "superseded" | "undone";
type DecisionApplicationState = "pending" | "applied" | "blocked";

interface SchemaVersionDbRow {
	user_version: number;
}

interface CandidateDbRow {
	candidate_id: string;
	kind: SanBrainCandidateKind;
	source_session_id: string;
	source_entry_id: string;
	status: CandidateStatus;
	revision: number;
	updated_at: string;
	payload_json: string;
}

interface DecisionDbRow {
	decision_id: string;
	owner_id: string;
	application_state: DecisionApplicationState;
	application_error: string | null;
	payload_json: string;
}

interface CandidateCollisionDbRow {
	candidate_id: string;
	kind: string;
	source_entry_id: string;
	payload_json: string;
}

interface DecisionCollisionDbRow {
	decision_id: string;
	source_entry_id: string;
	idempotency_key: string;
	payload_json: string;
}

interface ActiveStateDbRow {
	owner_id: string;
	kind: SanBrainCandidateKind;
	revision: number;
	decision_id: string;
	updated_at: string;
	payload_json: string;
}

interface ProjectionDbRow {
	projection_id: string;
	decision_id: string;
	target: SanBrainProjectionTarget;
	state: SanBrainProjectionState;
	attempt_count: number;
	revision: number | null;
	before_hash: string | null;
	after_hash: string | null;
	error_code: SanBrainProjectionErrorCode | null;
	error: string | null;
	duration_ms: number | null;
	receipt_id: string | null;
	notified_at: string | null;
	updated_at: string;
}

interface ProjectionDebugDbRow extends ProjectionDbRow {
	owner_id: string | null;
	idempotency_key: string | null;
	owner_kind: SanBrainCandidateKind | null;
	owner_status: CandidateStatus | null;
}

interface ProjectionStateCountDbRow {
	state: SanBrainProjectionState;
	count: number;
}

export interface SanBrainCandidateRecord {
	kind: SanBrainCandidateKind;
	candidate: SanBrainCandidate;
	status: CandidateStatus;
	revision: number;
	sourceSessionId: string;
	sourceEntryId: string;
	updatedAt: string;
}

export interface SanBrainDecisionRecord {
	decision: SanBrainDecision;
	applicationState: DecisionApplicationState;
	applicationError?: string;
}

export interface SanBrainActiveStateRecord {
	kind: SanBrainCandidateKind;
	candidate: SanBrainCandidate;
	revision: number;
	decisionId: string;
	updatedAt: string;
}

export interface SanBrainProjectionRecord {
	projectionId: string;
	decisionId: string;
	target: SanBrainProjectionTarget;
	state: SanBrainProjectionState;
	attemptCount: number;
	revision?: number;
	beforeHash?: string;
	afterHash?: string;
	errorCode?: SanBrainProjectionErrorCode;
	error?: string;
	durationMs?: number;
	receiptId?: string;
	notifiedAt?: string;
	updatedAt: string;
}

export type SanBrainProjectionDebugFilter = "pending" | "failed" | "blocked" | "all";

export interface SanBrainProjectionDebugRecord extends SanBrainProjectionRecord {
	ownerId?: string;
	idempotencyKey?: string;
	ownerKind?: SanBrainCandidateKind;
	ownerStatus?: CandidateStatus;
}

export interface SanBrainProjectionDebugReadModel {
	filter: SanBrainProjectionDebugFilter;
	total: number;
	stateCounts: Partial<Record<SanBrainProjectionState, number>>;
	records: SanBrainProjectionDebugRecord[];
}

export interface SanBrainExplanation {
	candidate: SanBrainCandidateRecord;
	decisions: SanBrainDecisionRecord[];
	activeState?: SanBrainActiveStateRecord;
	projections: SanBrainProjectionRecord[];
}

export interface SanBrainSyncResult {
	candidatesAdded: number;
	decisionsAdded: number;
	decisionsApplied: number;
	decisionsBlocked: number;
}

function parseCandidate(kind: SanBrainCandidateKind, payload: string): SanBrainCandidate {
	const value: unknown = JSON.parse(payload);
	if (kind === "profile" && isSanBrainProfileCandidate(value)) return value;
	if (kind === "experience" && isSanBrainExperienceCandidate(value)) return value;
	throw new Error(`Invalid ${kind} Brain candidate payload in durable store.`);
}

function parseDecision(payload: string): SanBrainDecision {
	const value: unknown = JSON.parse(payload);
	if (isSanBrainDecision(value)) return value;
	throw new Error("Invalid Brain decision payload in durable store.");
}

function candidateRecord(row: CandidateDbRow): SanBrainCandidateRecord {
	return {
		kind: row.kind,
		candidate: parseCandidate(row.kind, row.payload_json),
		status: row.status,
		revision: row.revision,
		sourceSessionId: row.source_session_id,
		sourceEntryId: row.source_entry_id,
		updatedAt: row.updated_at,
	};
}

function decisionRecord(row: DecisionDbRow): SanBrainDecisionRecord {
	return {
		decision: parseDecision(row.payload_json),
		applicationState: row.application_state,
		...(row.application_error ? { applicationError: row.application_error } : {}),
	};
}

function activeStateRecord(row: ActiveStateDbRow): SanBrainActiveStateRecord {
	return {
		kind: row.kind,
		candidate: parseCandidate(row.kind, row.payload_json),
		revision: row.revision,
		decisionId: row.decision_id,
		updatedAt: row.updated_at,
	};
}

function projectionRecord(row: ProjectionDbRow): SanBrainProjectionRecord {
	return {
		projectionId: row.projection_id,
		decisionId: row.decision_id,
		target: row.target,
		state: row.state,
		attemptCount: row.attempt_count,
		...(row.revision === null ? {} : { revision: row.revision }),
		...(row.before_hash ? { beforeHash: row.before_hash } : {}),
		...(row.after_hash ? { afterHash: row.after_hash } : {}),
		...(row.error_code ? { errorCode: row.error_code } : {}),
		...(row.error ? { error: row.error } : {}),
		...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
		...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
		...(row.notified_at ? { notifiedAt: row.notified_at } : {}),
		updatedAt: row.updated_at,
	};
}

function projectionDebugRecord(row: ProjectionDebugDbRow): SanBrainProjectionDebugRecord {
	return {
		...projectionRecord(row),
		...(row.owner_id ? { ownerId: row.owner_id } : {}),
		...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
		...(row.owner_kind ? { ownerKind: row.owner_kind } : {}),
		...(row.owner_status ? { ownerStatus: row.owner_status } : {}),
	};
}

export function getSanBrainDbPath(agentDir: string): string {
	return path.join(agentDir, "brain", "brain.sqlite");
}

export class SanBrainStore {
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

	static open(agentDir: string): SanBrainStore {
		return new SanBrainStore(getSanBrainDbPath(agentDir));
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
		if (currentVersion > BRAIN_DB_SCHEMA_VERSION) {
			throw new Error(
				`Brain database schema ${currentVersion} is newer than supported version ${BRAIN_DB_SCHEMA_VERSION}.`,
			);
		}
		if (currentVersion === BRAIN_DB_SCHEMA_VERSION) return;
		const migrate = this.#db.transaction(() => {
			if (currentVersion === 0) {
				this.#db.run(BRAIN_SCHEMA_SQL);
			} else if (currentVersion === 1) {
				this.#db.run("ALTER TABLE projections ADD COLUMN error_code TEXT");
				this.#db.run("ALTER TABLE projections ADD COLUMN duration_ms INTEGER");
				this.#db.run("ALTER TABLE projections ADD COLUMN receipt_id TEXT");
				this.#db.run("ALTER TABLE projections ADD COLUMN notified_at TEXT");
			}
			this.#db.run(`PRAGMA user_version = ${BRAIN_DB_SCHEMA_VERSION}`);
		});
		migrate();
	}

	syncSessionEntries(sessionId: string, entries: readonly SessionEntry[]): SanBrainSyncResult {
		if (!sessionId.trim()) throw new Error("Brain ledger sync requires a non-empty session id.");
		const ledger = listSanBrainLedgerEntries(entries);
		const result: SanBrainSyncResult = {
			candidatesAdded: 0,
			decisionsAdded: 0,
			decisionsApplied: 0,
			decisionsBlocked: 0,
		};
		const sync = this.#db.transaction(() => {
			for (const entry of ledger.profileCandidates) {
				if (this.#insertCandidate("profile", sessionId, entry.entryId, entry.data)) result.candidatesAdded++;
			}
			for (const entry of ledger.experienceCandidates) {
				if (this.#insertCandidate("experience", sessionId, entry.entryId, entry.data)) result.candidatesAdded++;
			}
			for (const entry of ledger.decisions) {
				if (this.#insertDecision(sessionId, entry.entryId, entry.data)) result.decisionsAdded++;
			}
			const pending = this.#db
				.query(
					"SELECT decision_id FROM decisions WHERE application_state = 'pending' ORDER BY created_at, decision_id",
				)
				.all() as Array<{ decision_id: string }>;
			for (const row of pending) {
				const state = this.#applyDecision(row.decision_id);
				if (state === "applied") result.decisionsApplied++;
				if (state === "blocked") result.decisionsBlocked++;
			}
			for (const entry of ledger.projections) this.#applyProjectionAudit(entry.data);
			for (const entry of ledger.projectionNotifications) this.#applyProjectionNotification(entry.data);
		});
		sync();
		return result;
	}

	#insertCandidate(
		kind: SanBrainCandidateKind,
		sessionId: string,
		entryId: string,
		candidate: SanBrainCandidate,
	): boolean {
		const payload = JSON.stringify(candidate);
		const conflictKey =
			kind === "experience" && isSanBrainExperienceCandidate(candidate) ? candidate.conflictKey : null;
		const result = this.#db
			.prepare(
				`INSERT OR IGNORE INTO candidates (
					candidate_id, kind, source_session_id, source_entry_id,
					scope_kind, scope_key, claim_key, dedupe_key, conflict_key,
					confidence, created_at, updated_at, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				candidate.candidateId,
				kind,
				sessionId,
				entryId,
				candidate.scope.kind,
				candidate.scope.key,
				candidate.claimKey,
				candidate.dedupeKey,
				conflictKey,
				candidate.confidence,
				candidate.createdAt,
				candidate.createdAt,
				payload,
			);
		if (result.changes > 0) return true;

		const existing = this.#db
			.query(
				"SELECT candidate_id, kind, source_entry_id, payload_json FROM candidates WHERE candidate_id = ? OR source_entry_id = ?",
			)
			.get(candidate.candidateId, entryId) as CandidateCollisionDbRow | null;
		if (
			existing?.candidate_id === candidate.candidateId &&
			existing.kind === kind &&
			existing.source_entry_id === entryId &&
			existing.payload_json === payload
		) {
			return false;
		}
		throw new Error(`Brain candidate collision for ${candidate.candidateId} or source entry ${entryId}.`);
	}

	#insertDecision(sessionId: string, entryId: string, decision: SanBrainDecision): boolean {
		const payload = JSON.stringify(decision);
		const result = this.#db
			.prepare(
				`INSERT OR IGNORE INTO decisions (
					decision_id, source_session_id, source_entry_id, owner_id, action,
					previous_revision, next_revision, idempotency_key, created_at, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				decision.decisionId,
				sessionId,
				entryId,
				decision.ownerId,
				decision.action,
				decision.previousRevision ?? null,
				decision.nextRevision,
				decision.idempotencyKey,
				decision.createdAt,
				payload,
			);
		if (result.changes > 0) return true;

		const existing = this.#db
			.query(
				"SELECT decision_id, source_entry_id, idempotency_key, payload_json FROM decisions WHERE decision_id = ? OR source_entry_id = ? OR idempotency_key = ?",
			)
			.get(decision.decisionId, entryId, decision.idempotencyKey) as DecisionCollisionDbRow | null;
		if (
			existing?.decision_id === decision.decisionId &&
			existing.source_entry_id === entryId &&
			existing.idempotency_key === decision.idempotencyKey &&
			existing.payload_json === payload
		) {
			return false;
		}
		throw new Error(
			`Brain decision collision for ${decision.decisionId} or idempotency key ${decision.idempotencyKey}.`,
		);
	}

	#consolidatedCandidate(candidateRow: CandidateDbRow): SanBrainCandidate {
		const candidate = parseCandidate(candidateRow.kind, candidateRow.payload_json);
		const rows = this.#db
			.query(
				`SELECT candidate_id, kind, source_session_id, source_entry_id, status, revision, updated_at, payload_json
				 FROM candidates
				 WHERE kind = ? AND scope_kind = ? AND scope_key = ? AND dedupe_key = ?
				   AND status IN ('pending', 'active')
				 ORDER BY created_at, candidate_id`,
			)
			.all(candidateRow.kind, candidate.scope.kind, candidate.scope.key, candidate.dedupeKey) as CandidateDbRow[];
		const records = rows.map(candidateRecord);
		const canonical = records.find(record => record.candidate.candidateId === candidate.candidateId);
		return mergeSanBrainCandidateRecords(canonical ?? candidateRecord(candidateRow), records);
	}

	#applyDecision(decisionId: string): DecisionApplicationState {
		const decisionRow = this.#db
			.query(
				"SELECT decision_id, owner_id, application_state, application_error, payload_json FROM decisions WHERE decision_id = ?",
			)
			.get(decisionId) as DecisionDbRow | null;
		if (!decisionRow) throw new Error(`Brain decision ${decisionId} disappeared during reconciliation.`);
		if (decisionRow.application_state !== "pending") return decisionRow.application_state;

		const decision = parseDecision(decisionRow.payload_json);
		const candidateRow = this.#db
			.query(
				"SELECT candidate_id, kind, source_session_id, source_entry_id, status, revision, updated_at, payload_json FROM candidates WHERE candidate_id = ?",
			)
			.get(decision.ownerId) as CandidateDbRow | null;
		if (!candidateRow) return "pending";

		const expectedRevision = decision.previousRevision ?? 0;
		if (candidateRow.revision !== expectedRevision) {
			return this.#blockDecision(
				decisionId,
				`Expected candidate revision ${expectedRevision}, found ${candidateRow.revision}.`,
			);
		}
		if (decision.nextRevision !== expectedRevision + 1) {
			return this.#blockDecision(
				decisionId,
				`Decision nextRevision ${decision.nextRevision} must equal ${expectedRevision + 1}.`,
			);
		}
		if (decision.action === "reduce_scope" || decision.action === "reduce_confidence") {
			return this.#blockDecision(
				decisionId,
				`Decision action ${decision.action} is not materialized until Brain M3.`,
			);
		}

		const materializedCandidate =
			decision.action === "approve"
				? this.#consolidatedCandidate(candidateRow)
				: parseCandidate(candidateRow.kind, candidateRow.payload_json);
		const projectionPlans = buildSanBrainProjectionPlans(materializedCandidate, decision);
		const expectedProjectionIds = projectionPlans.map(plan => plan.projectionId);
		if (
			decision.projectionIds.length > 0 &&
			(decision.projectionIds.length !== expectedProjectionIds.length ||
				decision.projectionIds.some((projectionId, index) => projectionId !== expectedProjectionIds[index]))
		) {
			return this.#blockDecision(
				decisionId,
				"Decision projection IDs do not match the deterministic Brain M5 plan.",
			);
		}

		const updatedAt = decision.createdAt;
		let status: CandidateStatus;
		if (decision.action === "approve") {
			status = "active";
			const consolidatedCandidate = materializedCandidate;
			this.#db
				.prepare(
					`INSERT INTO active_states (
						owner_id, kind, scope_kind, scope_key, revision, decision_id, updated_at, payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(owner_id) DO UPDATE SET
						kind = excluded.kind,
						scope_kind = excluded.scope_kind,
						scope_key = excluded.scope_key,
						revision = excluded.revision,
						decision_id = excluded.decision_id,
						updated_at = excluded.updated_at,
						payload_json = excluded.payload_json`,
				)
				.run(
					candidateRow.candidate_id,
					candidateRow.kind,
					consolidatedCandidate.scope.kind,
					consolidatedCandidate.scope.key,
					decision.nextRevision,
					decision.decisionId,
					updatedAt,
					JSON.stringify(consolidatedCandidate),
				);
		} else {
			status =
				decision.action === "discard" ? "discarded" : decision.action === "supersede" ? "superseded" : "undone";
			this.#db.prepare("DELETE FROM active_states WHERE owner_id = ?").run(candidateRow.candidate_id);
		}

		this.#db
			.prepare("UPDATE candidates SET status = ?, revision = ?, updated_at = ? WHERE candidate_id = ?")
			.run(status, decision.nextRevision, updatedAt, candidateRow.candidate_id);
		this.#db
			.prepare("UPDATE decisions SET application_state = 'applied', application_error = NULL WHERE decision_id = ?")
			.run(decisionId);
		if (decision.projectionIds.length > 0) {
			for (const plan of projectionPlans) {
				this.#db
					.prepare(
						`INSERT OR IGNORE INTO projections (
							projection_id, decision_id, target, state, attempt_count, revision, updated_at
						) VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
					)
					.run(plan.projectionId, decision.decisionId, plan.target, decision.nextRevision, updatedAt);
			}
		}
		return "applied";
	}

	#applyProjectionAudit(projection: SanBrainProjection): void {
		this.#db
			.prepare(
				`UPDATE projections SET
					state = ?, attempt_count = ?, revision = ?, before_hash = ?, after_hash = ?,
					error_code = ?, error = ?, duration_ms = ?, receipt_id = ?, updated_at = ?
				 WHERE projection_id = ? AND decision_id = ? AND target = ? AND updated_at <= ?`,
			)
			.run(
				projection.state,
				projection.attemptCount,
				projection.revision ?? null,
				projection.beforeHash ?? null,
				projection.afterHash ?? null,
				projection.errorCode ?? null,
				projection.error ?? null,
				projection.durationMs ?? null,
				projection.receiptId ?? null,
				projection.updatedAt,
				projection.projectionId,
				projection.decisionId,
				projection.target,
				projection.updatedAt,
			);
	}

	#applyProjectionNotification(notification: SanBrainProjectionNotification): void {
		this.#db
			.prepare(
				`UPDATE projections SET notified_at = ?
				 WHERE projection_id = ? AND (notified_at IS NULL OR notified_at <= ?)`,
			)
			.run(notification.notifiedAt, notification.projectionId, notification.notifiedAt);
	}

	#blockDecision(decisionId: string, error: string): "blocked" {
		this.#db
			.prepare("UPDATE decisions SET application_state = 'blocked', application_error = ? WHERE decision_id = ?")
			.run(error, decisionId);
		return "blocked";
	}

	listCandidates(limit = DEFAULT_LIST_LIMIT): SanBrainCandidateRecord[] {
		const rows = this.#db
			.query(
				`SELECT candidate_id, kind, source_session_id, source_entry_id, status, revision, updated_at, payload_json
				 FROM candidates ORDER BY created_at DESC, candidate_id LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as CandidateDbRow[];
		return rows.map(candidateRecord);
	}

	listPendingCandidates(limit = DEFAULT_LIST_LIMIT): SanBrainCandidateRecord[] {
		const rows = this.#db
			.query(
				`SELECT candidate_id, kind, source_session_id, source_entry_id, status, revision, updated_at, payload_json
				 FROM candidates WHERE status = 'pending' ORDER BY created_at DESC, candidate_id LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as CandidateDbRow[];
		return rows.map(candidateRecord);
	}

	listActiveStates(limit = DEFAULT_LIST_LIMIT): SanBrainActiveStateRecord[] {
		const rows = this.#db
			.query(
				`SELECT owner_id, kind, revision, decision_id, updated_at, payload_json
				 FROM active_states ORDER BY updated_at DESC, owner_id LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as ActiveStateDbRow[];
		return rows.map(activeStateRecord);
	}

	getCandidate(candidateId: string): SanBrainCandidateRecord | undefined {
		const row = this.#db
			.query(
				`SELECT candidate_id, kind, source_session_id, source_entry_id, status, revision, updated_at, payload_json
				 FROM candidates WHERE candidate_id = ?`,
			)
			.get(candidateId) as CandidateDbRow | null;
		return row ? candidateRecord(row) : undefined;
	}

	getDecision(decisionId: string): SanBrainDecisionRecord | undefined {
		const row = this.#db
			.query(
				"SELECT decision_id, owner_id, application_state, application_error, payload_json FROM decisions WHERE decision_id = ?",
			)
			.get(decisionId) as DecisionDbRow | null;
		return row ? decisionRecord(row) : undefined;
	}

	getProjection(projectionId: string): SanBrainProjectionRecord | undefined {
		const row = this.#db
			.query(
				`SELECT projection_id, decision_id, target, state, attempt_count, revision, before_hash, after_hash,
					error_code, error, duration_ms, receipt_id, notified_at, updated_at
				 FROM projections WHERE projection_id = ?`,
			)
			.get(projectionId) as ProjectionDbRow | null;
		return row ? projectionRecord(row) : undefined;
	}

	listProjections(
		states: readonly SanBrainProjectionState[] = ["pending", "failed", "applying", "compensating"],
		limit = DEFAULT_LIST_LIMIT,
	): SanBrainProjectionRecord[] {
		if (states.length === 0) return [];
		const placeholders = states.map(() => "?").join(", ");
		const rows = this.#db
			.query(
				`SELECT projection_id, decision_id, target, state, attempt_count, revision, before_hash, after_hash,
					error_code, error, duration_ms, receipt_id, notified_at, updated_at
				 FROM projections WHERE state IN (${placeholders}) ORDER BY updated_at, projection_id LIMIT ?`,
			)
			.all(...states, Math.max(1, Math.trunc(limit))) as ProjectionDbRow[];
		return rows.map(projectionRecord);
	}

	findPreviousAppliedProjection(
		ownerId: string,
		target: SanBrainProjectionTarget,
		excludeDecisionId: string,
	): SanBrainProjectionRecord | undefined {
		const row = this.#db
			.query(
				`SELECT p.projection_id, p.decision_id, p.target, p.state, p.attempt_count, p.revision,
					p.before_hash, p.after_hash, p.error_code, p.error, p.duration_ms, p.receipt_id, p.notified_at, p.updated_at
				 FROM projections p
				 JOIN decisions d ON d.decision_id = p.decision_id
				 WHERE d.owner_id = ? AND p.target = ? AND p.decision_id <> ? AND p.state = 'applied'
				 ORDER BY p.updated_at DESC, p.projection_id DESC LIMIT 1`,
			)
			.get(ownerId, target, excludeDecisionId) as ProjectionDbRow | null;
		return row ? projectionRecord(row) : undefined;
	}

	explain(id: string): SanBrainExplanation | undefined {
		const directCandidate = this.getCandidate(id);
		const decisionById = directCandidate
			? undefined
			: (this.#db
					.query(
						"SELECT decision_id, owner_id, application_state, application_error, payload_json FROM decisions WHERE decision_id = ?",
					)
					.get(id) as DecisionDbRow | null);
		const candidate = directCandidate ?? (decisionById ? this.getCandidate(decisionById.owner_id) : undefined);
		if (!candidate) return undefined;

		const decisions = this.#db
			.query(
				`SELECT decision_id, owner_id, application_state, application_error, payload_json
				 FROM decisions WHERE owner_id = ? ORDER BY created_at, decision_id`,
			)
			.all(candidate.candidate.candidateId) as DecisionDbRow[];
		const activeRow = this.#db
			.query(
				"SELECT owner_id, kind, revision, decision_id, updated_at, payload_json FROM active_states WHERE owner_id = ?",
			)
			.get(candidate.candidate.candidateId) as ActiveStateDbRow | null;
		const projectionRows = this.#db
			.query(
				`SELECT projection_id, decision_id, target, state, attempt_count, revision, before_hash, after_hash,
					error_code, error, duration_ms, receipt_id, notified_at, updated_at
				 FROM projections WHERE decision_id IN (SELECT decision_id FROM decisions WHERE owner_id = ?)
				 ORDER BY updated_at, projection_id`,
			)
			.all(candidate.candidate.candidateId) as ProjectionDbRow[];

		return {
			candidate,
			decisions: decisions.map(decisionRecord),
			...(activeRow ? { activeState: activeStateRecord(activeRow) } : {}),
			projections: projectionRows.map(projectionRecord),
		};
	}

	readProjectionDebug(
		filter: SanBrainProjectionDebugFilter = "pending",
		limit = 50,
	): SanBrainProjectionDebugReadModel {
		const states: SanBrainProjectionState[] =
			filter === "pending"
				? ["pending", "applying", "compensating"]
				: filter === "all"
					? ["pending", "applying", "applied", "failed", "compensating", "compensated", "blocked"]
					: [filter];
		const placeholders = states.map(() => "?").join(", ");
		const countRows = this.#db
			.query(`SELECT state, COUNT(*) AS count FROM projections WHERE state IN (${placeholders}) GROUP BY state`)
			.all(...states) as ProjectionStateCountDbRow[];
		const stateCounts: Partial<Record<SanBrainProjectionState, number>> = {};
		let total = 0;
		for (const row of countRows) {
			stateCounts[row.state] = row.count;
			total += row.count;
		}
		const rows = this.#db
			.query(
				`SELECT p.projection_id, p.decision_id, p.target, p.state, p.attempt_count, p.revision,
					p.before_hash, p.after_hash, p.error_code, p.error, p.duration_ms, p.receipt_id,
					p.notified_at, p.updated_at, d.owner_id, d.idempotency_key,
					c.kind AS owner_kind, c.status AS owner_status
				 FROM projections p
				 LEFT JOIN decisions d ON d.decision_id = p.decision_id
				 LEFT JOIN candidates c ON c.candidate_id = d.owner_id
				 WHERE p.state IN (${placeholders})
				 ORDER BY p.updated_at DESC, p.projection_id DESC LIMIT ?`,
			)
			.all(...states, Math.max(1, Math.trunc(limit))) as ProjectionDebugDbRow[];
		return { filter, total, stateCounts, records: rows.map(projectionDebugRecord) };
	}
}
