import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry } from "../session/session-entries";
import { mergeSanBrainCandidateRecords } from "./consolidate";
import { listSanBrainLedgerEntries } from "./ledger";
import {
	isSanBrainDecision,
	isSanBrainExperienceCandidate,
	isSanBrainProfileCandidate,
	type SanBrainCandidate,
	type SanBrainCandidateKind,
	type SanBrainDecision,
} from "./types";

const BRAIN_DB_SCHEMA_VERSION = 1;
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
	error TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projections_decision_idx ON projections(decision_id, state);
`;

type CandidateStatus = "pending" | "active" | "discarded" | "superseded" | "undone";
type DecisionApplicationState = "pending" | "applied" | "blocked";

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
	target: string;
	state: string;
	attempt_count: number;
	revision: number | null;
	before_hash: string | null;
	after_hash: string | null;
	error: string | null;
	updated_at: string;
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
	target: string;
	state: string;
	attemptCount: number;
	revision?: number;
	beforeHash?: string;
	afterHash?: string;
	error?: string;
	updatedAt: string;
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
		const row = this.#db.query("PRAGMA user_version").get() as { user_version: number } | null;
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
			this.#db.run(BRAIN_SCHEMA_SQL);
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
			.get(candidate.candidateId, entryId) as {
			candidate_id: string;
			kind: string;
			source_entry_id: string;
			payload_json: string;
		} | null;
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
			.get(decision.decisionId, entryId, decision.idempotencyKey) as {
			decision_id: string;
			source_entry_id: string;
			idempotency_key: string;
			payload_json: string;
		} | null;
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

		const updatedAt = decision.createdAt;
		let status: CandidateStatus;
		if (decision.action === "approve") {
			status = "active";
			const consolidatedCandidate = this.#consolidatedCandidate(candidateRow);
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
		return "applied";
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
				`SELECT projection_id, decision_id, target, state, attempt_count, revision, before_hash, after_hash, error, updated_at
				 FROM projections WHERE decision_id IN (SELECT decision_id FROM decisions WHERE owner_id = ?)
				 ORDER BY updated_at, projection_id`,
			)
			.all(candidate.candidate.candidateId) as ProjectionDbRow[];

		return {
			candidate,
			decisions: decisions.map(decisionRecord),
			...(activeRow ? { activeState: activeStateRecord(activeRow) } : {}),
			projections: projectionRows.map(row => ({
				projectionId: row.projection_id,
				decisionId: row.decision_id,
				target: row.target,
				state: row.state,
				attemptCount: row.attempt_count,
				...(row.revision === null ? {} : { revision: row.revision }),
				...(row.before_hash ? { beforeHash: row.before_hash } : {}),
				...(row.after_hash ? { afterHash: row.after_hash } : {}),
				...(row.error ? { error: row.error } : {}),
				updatedAt: row.updated_at,
			})),
		};
	}
}
