import { stableValueFingerprint } from "./progress-classifier";

/** Version for the host-owned task admission contract. */
export const TASK_CONTRACT_SCHEMA_VERSION = 1 as const;

export type TaskContractStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "rejected";

/** Explicit identity fields accepted by the task tool. */
export interface TaskContractInput {
	readonly contractId?: string;
	readonly scopeId?: string;
	readonly workKey?: string;
	readonly strategyKey?: string;
	readonly taskId?: string;
}

/** Inputs used to deterministically derive omitted contract identity fields. */
export interface TaskContractDerivationInput extends TaskContractInput {
	readonly rootSessionId?: string;
	readonly task?: string;
	readonly agent?: string;
	/** Semantic task text alias for SDK callers that do not use the task tool shape. */
	readonly semantic?: string;
}

export interface TaskContractIdentity {
	readonly contractId: string;
	readonly scopeId: string;
	readonly workKey: string;
	readonly strategyKey: string;
	readonly taskId: string;
}

export interface TaskContractSnapshot extends TaskContractIdentity {
	readonly schemaVersion: typeof TASK_CONTRACT_SCHEMA_VERSION;
	readonly status: TaskContractStatus;
	/** Host observation timestamp of the most recent task heartbeat. */
	readonly heartbeatAt: number;
	/** Monotonic task-local change cursor. */
	readonly cursor: number;
	/** Monotonic snapshot revision. */
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly jobId?: string;
}

export type TaskContractRef = Pick<
	TaskContractIdentity,
	"contractId" | "scopeId" | "workKey" | "strategyKey" | "taskId"
>;

export type TaskContractAdmissionKind = "admitted" | "reused" | "rejected";

export interface TaskContractAdmission {
	readonly kind: TaskContractAdmissionKind;
	readonly accepted: boolean;
	readonly reused: boolean;
	readonly contract: Readonly<TaskContractSnapshot>;
	readonly existing?: Readonly<TaskContractSnapshot>;
	readonly reason?: "duplicate" | "invalid";
}

export interface TaskContractChange {
	readonly type: "admitted" | "updated" | "removed";
	readonly snapshot: Readonly<TaskContractSnapshot>;
}

export interface TaskContractRegistryOptions {
	/** Root session identity used when callers omit `scopeId`/`rootSessionId`. */
	readonly rootSessionId?: string;
	readonly now?: () => number;
	readonly initialContracts?: readonly TaskContractSnapshot[];
}

export interface TaskContractUpdate {
	readonly status?: TaskContractStatus;
	readonly heartbeatAt?: number;
	readonly jobId?: string;
}

export interface TaskContractWaitCursor {
	readonly cursor?: number;
	readonly revision?: number;
	readonly heartbeatAt?: number;
}

interface MutableTaskContract
	extends Omit<TaskContractSnapshot, "status" | "heartbeatAt" | "cursor" | "revision" | "updatedAt" | "jobId"> {
	status: TaskContractStatus;
	heartbeatAt: number;
	cursor: number;
	revision: number;
	updatedAt: number;
	jobId?: string;
}
interface PendingWait {
	readonly key: string;
	readonly cursor: TaskContractWaitCursor;
	readonly resolve: (snapshot: Readonly<TaskContractSnapshot>) => void;
	readonly reject: (error: unknown) => void;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.normalize("NFKC").trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeIdentity(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\u0000\s]+/gu, " ")
		.trim()
		.toLowerCase();
}

function stableTaskText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\u0000\s]+/gu, " ")
		.trim();
}

function identityKey(identity: Pick<TaskContractIdentity, "scopeId" | "workKey" | "strategyKey">): string {
	return `${identity.scopeId}\u0000${identity.workKey}\u0000${identity.strategyKey}`;
}

function taskIdFor(identity: Pick<TaskContractIdentity, "scopeId" | "workKey" | "strategyKey">): string {
	return `task:${stableValueFingerprint(identity)}`;
}

function contractIdFor(identity: Pick<TaskContractIdentity, "scopeId" | "workKey" | "strategyKey">): string {
	return `contract:${stableValueFingerprint(identity)}`;
}

/**
 * Derive the stable identity used by task admission. Presentation-only names
 * and generated agent ids are intentionally excluded: two calls with the same
 * semantic work and strategy therefore address one contract.
 */
export function deriveTaskContractIdentity(input: TaskContractDerivationInput): TaskContractIdentity {
	const rootSessionId = nonEmpty(input.rootSessionId);
	const scopeId = nonEmpty(input.scopeId) ?? rootSessionId ?? "scope:unknown";
	const semantic = stableTaskText(input.semantic ?? input.task ?? "unknown task");
	const workKey = nonEmpty(input.workKey) ?? `work:${stableValueFingerprint({ semantic })}`;
	const strategyKey =
		nonEmpty(input.strategyKey) ?? `strategy:${normalizeIdentity(nonEmpty(input.agent) ?? "default") || "default"}`;
	const derivedTaskId = taskIdFor({ scopeId, workKey, strategyKey });
	const taskId = nonEmpty(input.taskId) ?? derivedTaskId;
	const derivedContractId = contractIdFor({ scopeId, workKey, strategyKey });
	return Object.freeze({
		contractId: nonEmpty(input.contractId) ?? derivedContractId,
		scopeId,
		workKey,
		strategyKey,
		taskId,
	});
}

/** Short alias for SDK callers and tests. */
export const deriveTaskContract = deriveTaskContractIdentity;

function cloneSnapshot(snapshot: TaskContractSnapshot): Readonly<TaskContractSnapshot> {
	return Object.freeze({ ...snapshot });
}

function changedSince(snapshot: TaskContractSnapshot, cursor: TaskContractWaitCursor): boolean {
	return (
		(cursor.cursor !== undefined && snapshot.cursor > cursor.cursor) ||
		(cursor.revision !== undefined && snapshot.revision > cursor.revision) ||
		(cursor.heartbeatAt !== undefined && snapshot.heartbeatAt > cursor.heartbeatAt)
	);
}

function signalError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/**
 * Root-scoped task contract registry. A child session receives the same object
 * through the SDK runtime wiring; independent roots receive separate objects.
 */
export class TaskContractRegistry {
	readonly #rootSessionId?: string;
	readonly #now: () => number;
	readonly #contracts = new Map<string, MutableTaskContract>();
	readonly #keyByJobId = new Map<string, string>();
	readonly #waiters = new Set<PendingWait>();
	readonly #listeners = new Set<(change: TaskContractChange) => void>();

	constructor(options: TaskContractRegistryOptions = {}) {
		this.#rootSessionId = nonEmpty(options.rootSessionId);
		this.#now = options.now ?? Date.now;
		for (const initial of options.initialContracts ?? []) {
			const snapshot = cloneSnapshot(initial);
			this.#contracts.set(identityKey(snapshot), { ...snapshot });
			if (snapshot.jobId) this.#keyByJobId.set(snapshot.jobId, identityKey(snapshot));
		}
	}

	get rootSessionId(): string | undefined {
		return this.#rootSessionId;
	}

	/** Resolve a caller-provided identity into the registry's canonical fields. */
	derive(input: TaskContractDerivationInput): TaskContractIdentity {
		return deriveTaskContractIdentity({ ...input, rootSessionId: input.rootSessionId ?? this.#rootSessionId });
	}

	/** Admit once per scope/work/strategy; duplicate admissions are observable and side-effect free. */
	admit(input: TaskContractDerivationInput): TaskContractAdmission {
		const identity = this.derive(input);
		const key = identityKey(identity);
		const existing = this.#contracts.get(key);
		if (existing) {
			const snapshot = cloneSnapshot(existing);
			return {
				kind: "reused",
				accepted: false,
				reused: true,
				contract: snapshot,
				existing: snapshot,
				reason: "duplicate",
			};
		}
		const now = this.#now();
		const created: MutableTaskContract = {
			...identity,
			schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
			status: "queued",
			heartbeatAt: now,
			cursor: 0,
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.#contracts.set(key, created);
		const snapshot = cloneSnapshot(created);
		this.#publish({ type: "admitted", snapshot });
		return { kind: "admitted", accepted: true, reused: false, contract: snapshot };
	}

	/** Register a contract without treating a prior one as an error. */
	register(input: TaskContractDerivationInput): Readonly<TaskContractSnapshot> {
		return this.admit(input).contract;
	}

	get(input: TaskContractDerivationInput | TaskContractRef): Readonly<TaskContractSnapshot> | undefined {
		const identity = this.derive(input);
		const snapshot = this.#contracts.get(identityKey(identity));
		return snapshot ? cloneSnapshot(snapshot) : undefined;
	}

	getByJobId(jobId: string): Readonly<TaskContractSnapshot> | undefined {
		const key = this.#keyByJobId.get(jobId);
		if (!key) return undefined;
		const snapshot = this.#contracts.get(key);
		return snapshot ? cloneSnapshot(snapshot) : undefined;
	}

	snapshotForJob(jobId: string): Readonly<TaskContractSnapshot> | undefined {
		return this.getByJobId(jobId);
	}
	setStatusByJobId(jobId: string, status: TaskContractStatus): Readonly<TaskContractSnapshot> | undefined {
		const snapshot = this.getByJobId(jobId);
		return snapshot ? this.setStatus(snapshot, status) : undefined;
	}

	list(scopeId?: string): readonly Readonly<TaskContractSnapshot>[] {
		return [...this.#contracts.values()]
			.filter(contract => scopeId === undefined || contract.scopeId === scopeId)
			.map(cloneSnapshot);
	}

	subscribe(listener: (change: TaskContractChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Associate a task job id and advance the snapshot cursor. */
	bindJob(input: TaskContractDerivationInput | TaskContractRef, jobId: string): Readonly<TaskContractSnapshot> {
		const snapshot = this.#require(input);
		return this.update(snapshot, { jobId });
	}

	/** Update status/heartbeat and advance both monotonic counters. */
	update(
		input: TaskContractDerivationInput | TaskContractRef | Readonly<TaskContractSnapshot>,
		patch: TaskContractUpdate = {},
	): Readonly<TaskContractSnapshot> {
		const current = this.#require(input);
		const key = identityKey(current);
		const entry = this.#contracts.get(key);
		if (!entry) throw new Error(`Task contract ${current.contractId} is not registered.`);
		if (patch.jobId !== undefined && entry.jobId !== undefined && entry.jobId !== patch.jobId) {
			throw new Error(`Task contract ${entry.contractId} is already bound to job ${entry.jobId}.`);
		}
		if (patch.jobId !== undefined) {
			const oldKey = this.#keyByJobId.get(patch.jobId);
			if (oldKey && oldKey !== key) throw new Error(`Job ${patch.jobId} is already bound to another task contract.`);
			this.#keyByJobId.set(patch.jobId, key);
		}
		const now = this.#now();
		entry.status = patch.status ?? entry.status;
		entry.heartbeatAt = patch.heartbeatAt ?? now;
		entry.updatedAt = now;
		entry.cursor += 1;
		entry.revision += 1;
		if (patch.jobId !== undefined) entry.jobId = patch.jobId;
		const snapshot = cloneSnapshot(entry);
		this.#publish({ type: "updated", snapshot });
		return snapshot;
	}

	setStatus(
		input: TaskContractDerivationInput | TaskContractRef,
		status: TaskContractStatus,
	): Readonly<TaskContractSnapshot> {
		return this.update(input, { status });
	}

	heartbeat(
		input: TaskContractDerivationInput | TaskContractRef,
		heartbeatAt = this.#now(),
	): Readonly<TaskContractSnapshot> {
		return this.update(input, { heartbeatAt });
	}

	heartbeatForJob(jobId: string, heartbeatAt = this.#now()): Readonly<TaskContractSnapshot> | undefined {
		const snapshot = this.getByJobId(jobId);
		return snapshot ? this.update(snapshot, { heartbeatAt }) : undefined;
	}

	/** Wait until any requested monotonic field advances. */
	waitForChange(
		input: TaskContractDerivationInput | TaskContractRef | Readonly<TaskContractSnapshot>,
		cursor: TaskContractWaitCursor = {},
		signal?: AbortSignal,
	): Promise<Readonly<TaskContractSnapshot>> {
		const current = this.get(input);
		if (!current) return Promise.reject(new Error("Task contract is not registered."));
		if (changedSince(current, cursor)) return Promise.resolve(current);
		if (signal?.aborted) return Promise.reject(signalError(signal));
		const pending = Promise.withResolvers<Readonly<TaskContractSnapshot>>();
		const waiter: PendingWait = {
			key: identityKey(current),
			cursor,
			resolve: pending.resolve,
			reject: pending.reject,
		};
		this.#waiters.add(waiter);
		const onAbort = signal
			? () => {
					this.#waiters.delete(waiter);
					pending.reject(signalError(signal));
				}
			: undefined;
		if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
		return pending.promise.finally(() => {
			this.#waiters.delete(waiter);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		});
	}

	remove(input: TaskContractDerivationInput | TaskContractRef): boolean {
		const identity = this.derive(input);
		const key = identityKey(identity);
		const existing = this.#contracts.get(key);
		if (!existing) return false;
		this.#contracts.delete(key);
		if (existing.jobId) this.#keyByJobId.delete(existing.jobId);
		this.#publish({ type: "removed", snapshot: cloneSnapshot(existing) });
		return true;
	}

	dispose(): void {
		for (const waiter of this.#waiters) waiter.reject(new Error("Task contract registry is disposed."));
		this.#waiters.clear();
		this.#listeners.clear();
		this.#keyByJobId.clear();
		this.#contracts.clear();
	}

	#require(
		input: TaskContractDerivationInput | TaskContractRef | Readonly<TaskContractSnapshot>,
	): Readonly<TaskContractSnapshot> {
		const identity = this.derive(input);
		const snapshot = this.#contracts.get(identityKey(identity));
		if (!snapshot) throw new Error(`Task contract ${identity.contractId} is not registered.`);
		return cloneSnapshot(snapshot);
	}

	#publish(change: TaskContractChange): void {
		for (const waiter of [...this.#waiters]) {
			const current = this.#contracts.get(waiter.key);
			if (!current) continue;
			const snapshot = cloneSnapshot(current);
			if (!changedSince(snapshot, waiter.cursor)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(snapshot);
		}
		for (const listener of [...this.#listeners]) {
			try {
				listener(change);
			} catch {
				// Contract observers are advisory and cannot break admission.
			}
		}
	}
}

export function createTaskContractRegistry(options?: TaskContractRegistryOptions): TaskContractRegistry {
	return new TaskContractRegistry(options);
}

export function taskContractIdentityKey(
	identity: Pick<TaskContractIdentity, "scopeId" | "workKey" | "strategyKey">,
): string {
	return identityKey(identity);
}
