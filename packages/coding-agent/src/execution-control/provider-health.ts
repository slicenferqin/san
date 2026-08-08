import type { AssistantMessageEvent, Model } from "@san/ai";
import * as AIError from "@san/ai/error";
import { AssistantMessageEventStream } from "@san/ai/utils/event-stream";
import { ProviderCircuitOpenError, ProviderHealthError } from "./errors";
import type { ExecutionLedger } from "./execution-ledger";
import type {
	ExecutionAssignmentRef,
	ExecutionLedgerRecord,
	ExecutionScopeSnapshot,
	ObjectiveContractRef,
	ProviderHealthRef,
	ProviderHealthState,
} from "./types";

const SENSITIVE_QUERY_KEY =
	/(?:api[-_]?key|access[-_]?token|authorization|auth|bearer|credential|password|secret|token)/iu;
const ABORT_TEXT =
	/(?:abort(?:ed|ing)?|cancel(?:led|ed|ing)?|user interrupt|client backpressure|backpressure|local watchdog)/iu;
const STALL_TEXT =
	/(?:stall|timed? out|timeout|stream read|connection reset|socket hang|fetch failed|network error|upstream)/iu;
const RETRY_AFTER_TEXT = /(?:retry[- ]after|too many requests|rate limit|\b429\b)/iu;

export interface ProviderHealthKey {
	readonly provider: string;
	/** Canonical credential-free endpoint identity. Empty means provider default endpoint. */
	readonly normalizedUrl: string;
	readonly modelId?: string;
}

export interface ProviderHealthKeyInput {
	readonly provider: string;
	readonly baseUrl?: string;
	readonly normalizedUrl?: string;
	readonly modelId?: string;
}

export type ProviderHealthKeyLike = ProviderHealthKey | ProviderHealthKeyInput;

export type ProviderHealthReceiptKind =
	| "auth_unavailable"
	| "stream_stalled"
	| "retry_after"
	| "provider_error"
	| "abort";

/** Bounded, replayable terminal evidence. Raw errors/messages are never persisted. */
export interface ProviderTerminalReceipt {
	readonly kind: ProviderHealthReceiptKind;
	readonly receiptRef: string;
	readonly sessionId?: string;
	readonly assignmentId?: string;
	/** Provider request identity; repeated observations of one request do not exhaust a route. */
	readonly requestId?: string;
	/** Provider error identity; distinct errors count toward route exhaustion. */
	readonly errorId?: string;
	readonly occurredAt?: number;
	readonly evidenceRefs?: readonly string[];
	readonly credentialsExhausted?: boolean;
	readonly routeSwitched?: boolean;
	readonly noTerminal?: boolean;
	readonly noHeartbeat?: boolean;
	readonly retryAfterMs?: number;
	readonly retryAt?: number;
	readonly status?: number;
	readonly error?: unknown;
}

export interface ProviderHealthSnapshot {
	readonly key: ProviderHealthKey;
	readonly provider: string;
	readonly normalizedUrl: string;
	readonly modelId?: string;
	readonly endpoint: string;
	readonly providerKey: string;
	readonly modelKey?: string;
	readonly state: ProviderHealthState;
	readonly healthRevision: number;
	readonly generation: number;
	readonly retryAt?: number;
	readonly lastSuccess?: number;
	readonly terminalReceiptRef?: string;
	readonly evidenceRefs: readonly string[];
}

export type ProviderHealthEventType =
	| "opened"
	| "half_open"
	| "closed"
	| "provider_health_wake"
	| "parked"
	| "resumed"
	| "heartbeat"
	| "request_completed"
	| "request_failed"
	| "request_interrupted"
	| "cleared"
	| "reset";

export interface ParkedProviderAssignment {
	readonly assignmentId: string;
	readonly contractRef?: ObjectiveContractRef;
	readonly assignmentRevision: number;
	readonly providerKey: ProviderHealthKey;
	readonly retryAt?: number;
	readonly replaySafety: "safe" | "unsafe" | "unknown";
	readonly status: "parked" | "resumed";
	readonly parkedAt: number;
	readonly resumedAt?: number;
}

export interface ProviderHealthEvent {
	readonly type: ProviderHealthEventType;
	/**
	 * cleared/reset 是注册表级生命周期事件，不携带任何单一路由，因此 key/snapshot
	 * 仅在路由级事件上存在。
	 */
	readonly key?: ProviderHealthKey;
	readonly snapshot?: ProviderHealthSnapshot;
	/** 已捕获 requestId 的请求终结事件携带该身份，供宿主路由到捕获 scope。 */
	readonly requestId?: string;
	readonly assignment?: ParkedProviderAssignment;
}

export interface ProviderHealthAssignmentInput {
	readonly assignmentId: string;
	readonly contractRef?: ObjectiveContractRef;
	readonly assignmentRevision?: number;
	readonly replaySafety?: "safe" | "unsafe" | "unknown";
}

export interface ProviderHealthRequest {
	readonly key: ProviderHealthKeyLike;
	readonly sessionId?: string;
	readonly assignment?: ProviderHealthAssignmentInput;
	/** Stable provider request identity used for distinct-failure accounting. */
	readonly requestId?: string;
	/** Stable provider error identity used for distinct-failure accounting. */
	readonly errorId?: string;
	readonly signal?: AbortSignal;
	readonly routeSwitched?: boolean;
	readonly receipt?: ProviderTerminalReceipt;
}

export interface ProviderHealthAdmission {
	readonly key: ProviderHealthKey;
	readonly snapshot: ProviderHealthSnapshot;
	readonly generation: number;
	readonly probe: boolean;
	/** 登记时的分支 epoch；reset/clear 后晚到 terminal 无任何副作用。 */
	readonly branchEpoch: number;
}

export interface ProviderHealthRegistryOptions {
	readonly now?: () => number;
	readonly authCooldownMs?: number;
	readonly defaultRetryAfterMs?: number;
	readonly stallWindowMs?: number;
	readonly stallThreshold?: number;
	readonly sameSessionStallThreshold?: number;
	readonly minDistinctStallSessions?: number;
	/** Minimum distinct request/error identities before a provider is exhausted. */
	readonly failureThreshold?: number;
	readonly ledger?: ExecutionLedger;
	readonly initialHealth?: readonly ProviderHealthSnapshot[];
	readonly onEvent?: (event: ProviderHealthEvent) => void;
}

interface MutableHealth {
	key: ProviderHealthKey;
	state: ProviderHealthState;
	healthRevision: number;
	generation: number;
	retryAt?: number;
	lastSuccess?: number;
	terminalReceiptRef?: string;
	evidenceRefs: string[];
}

interface StallEvidence {
	at: number;
	sessionId?: string;
	receiptRef: string;
}

interface PendingProbe {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	readonly generation: number;
}

interface PendingWake {
	readonly key: ProviderHealthKey;
	readonly promise: Promise<ProviderHealthSnapshot>;
	readonly resolve: (snapshot: ProviderHealthSnapshot) => void;
	readonly reject: (error: unknown) => void;
}

function asFiniteTimestamp(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/**
 * 脱敏 home 目录路径段：`/Users/<name>` 与 `/home/<name>` 的用户名段不得进入
 * 路由身份或持久化 ref；`://home/` 形式的 host 段不属于 home 路径，予以保留。
 * 普通 HTTP API 的 pathname（如 `/v1/chat/completions`）不含这些前缀，路由身份完整保留。
 */
function redactHomePath(value: string): string {
	return value.replace(/(?<!:)\/(?:Users|home)\/[^/]+/u, "/_");
}
/** 归一化 endpoint：不保留凭据、敏感 query 与用户名/home 路径。 */
export function normalizeProviderBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim() ?? "";
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key);
		}
		if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
			url.port = "";
		}
		url.pathname = redactHomePath(url.pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "")) || "/";
		const serialized = url.toString();
		return serialized.endsWith("/") && url.pathname === "/" && !url.search ? serialized.slice(0, -1) : serialized;
	} catch {
		// 自定义 provider 可能使用非 URL endpoint（例如 `mock://`）；同样剥离
		// 明显的 userinfo/敏感 query/home 路径，同时保留稳定身份。
		return redactHomePath(
			trimmed
				.replace(/:\/\/[^/@]+@/u, "://")
				.replace(
					/([?&](?:api[-_]?key|access[-_]?token|authorization|auth|bearer|credential|password|secret|token)=[^&]*)/giu,
					"",
				)
				.replace(/\/{2,}$/u, ""),
		);
	}
}

export function createProviderHealthKey(input: ProviderHealthKeyInput): ProviderHealthKey {
	const provider = input.provider.trim().toLowerCase();
	if (!provider) throw new ProviderHealthError("Provider health keys require a provider id.");
	const normalizedUrl = normalizeProviderBaseUrl(input.normalizedUrl ?? input.baseUrl);
	const modelId = input.modelId?.trim() || undefined;
	return Object.freeze({ provider, normalizedUrl, ...(modelId ? { modelId } : {}) });
}

/** Build a key from the model route at the provider-dispatch boundary. */
export function providerHealthKeyFromModel(model: Pick<Model, "provider" | "baseUrl" | "id">): ProviderHealthKey {
	return createProviderHealthKey({ provider: model.provider, baseUrl: model.baseUrl, modelId: model.id });
}

export function providerHealthKeyId(keyLike: ProviderHealthKeyLike): string {
	const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
	return `${key.provider}\u0000${key.normalizedUrl}\u0000${key.modelId ?? ""}`;
}

function isProviderHealthKey(value: ProviderHealthKeyLike): value is ProviderHealthKey {
	return "normalizedUrl" in value && typeof value.normalizedUrl === "string" && !("baseUrl" in value);
}

function errorStatus(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null && "errorStatus" in error) {
		const value = (error as { errorStatus?: unknown }).errorStatus;
		if (typeof value === "number") return value;
	}
	if (typeof error === "object" && error !== null && "status" in error) {
		const value = (error as { status?: unknown }).status;
		if (typeof value === "number") return value;
	}
	return AIError.status(error);
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as { message?: unknown }).message === "string"
	) {
		return (error as { message: string }).message;
	}
	return "";
}

/** Abort/user interruption/backpressure must never be turned into provider health debt. */
export function isProviderHealthExcludedFailure(errorOrReceipt: unknown): boolean {
	if (typeof errorOrReceipt === "object" && errorOrReceipt !== null && "kind" in errorOrReceipt) {
		const kind = (errorOrReceipt as { kind?: unknown }).kind;
		if (kind === "abort") return true;
	}
	const status = AIError.classify(errorOrReceipt);
	if (
		AIError.is(status, AIError.Flag.Abort) ||
		AIError.is(status, AIError.Flag.UserInterrupt) ||
		AIError.is(status, AIError.Flag.SilentAbort)
	)
		return true;
	const name = errorOrReceipt instanceof Error ? errorOrReceipt.name : "";
	return name === "AbortError" || name === "CanceledError" || ABORT_TEXT.test(errorText(errorOrReceipt));
}

function isAuthFailure(errorOrReceipt: unknown): boolean {
	const status = AIError.classify(errorOrReceipt);
	if (AIError.is(status, AIError.Flag.AuthFailed)) return true;
	const code = errorStatus(errorOrReceipt);
	return (
		code === 401 ||
		code === 403 ||
		/\b(?:unauthorized|forbidden|auth(?:entication)?[_ -]?unavailable|no api key)\b/iu.test(errorText(errorOrReceipt))
	);
}

function isRetryAfterFailure(errorOrReceipt: unknown): boolean {
	const code = errorStatus(errorOrReceipt);
	return code === 429 || RETRY_AFTER_TEXT.test(errorText(errorOrReceipt));
}

function isStallFailure(errorOrReceipt: unknown): boolean {
	const status = AIError.classify(errorOrReceipt);
	if (AIError.is(status, AIError.Flag.Timeout)) return true;
	return STALL_TEXT.test(errorText(errorOrReceipt));
}

function parseRetryAfter(error: unknown, explicitMs?: number): number | undefined {
	if (explicitMs !== undefined && Number.isFinite(explicitMs) && explicitMs >= 0) return explicitMs;
	if (typeof error === "object" && error !== null && "headers" in error) {
		const headers = (error as { headers?: unknown }).headers;
		if (headers instanceof Headers) {
			const value = headers.get("retry-after");
			if (value) return parseRetryAfterValue(value);
		}
		if (typeof headers === "object" && headers !== null) {
			const value =
				(headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"];
			if (typeof value === "string") return parseRetryAfterValue(value);
		}
	}
	return undefined;
}

function parseRetryAfterValue(value: string): number | undefined {
	const trimmed = value.trim();
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(trimmed);
	if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	return undefined;
}

function cloneSnapshot(entry: MutableHealth): ProviderHealthSnapshot {
	const key = Object.freeze({ ...entry.key });
	return Object.freeze({
		key,
		provider: key.provider,
		normalizedUrl: key.normalizedUrl,
		...(key.modelId ? { modelId: key.modelId } : {}),
		endpoint: key.normalizedUrl,
		providerKey: key.provider,
		...(key.modelId ? { modelKey: key.modelId } : {}),
		state: entry.state,
		healthRevision: entry.healthRevision,
		generation: entry.generation,
		...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
		...(entry.lastSuccess === undefined ? {} : { lastSuccess: entry.lastSuccess }),
		...(entry.terminalReceiptRef ? { terminalReceiptRef: entry.terminalReceiptRef } : {}),
		evidenceRefs: Object.freeze([...entry.evidenceRefs]),
	});
}

function mutableFromSnapshot(snapshot: ProviderHealthSnapshot): MutableHealth {
	return {
		key: createProviderHealthKey(snapshot.key),
		state: snapshot.state,
		healthRevision: snapshot.healthRevision,
		generation: snapshot.generation,
		retryAt: snapshot.retryAt,
		lastSuccess: snapshot.lastSuccess,
		terminalReceiptRef: snapshot.terminalReceiptRef,
		evidenceRefs: [...snapshot.evidenceRefs],
	};
}

export function providerHealthRefFromSnapshot(snapshot: ProviderHealthSnapshot): ProviderHealthRef {
	return {
		providerKey: snapshot.providerKey,
		endpoint: snapshot.endpoint,
		normalizedUrl: snapshot.normalizedUrl,
		...(snapshot.modelKey ? { modelKey: snapshot.modelKey } : {}),
		state: snapshot.state,
		healthRevision: snapshot.healthRevision,
		generation: snapshot.generation,
		...(snapshot.terminalReceiptRef ? { terminalReceiptRef: snapshot.terminalReceiptRef } : {}),
		...(snapshot.retryAt === undefined ? {} : { retryAt: snapshot.retryAt }),
		...(snapshot.lastSuccess === undefined ? {} : { lastSuccess: snapshot.lastSuccess }),
		...(snapshot.evidenceRefs.length === 0 ? {} : { evidenceRefs: snapshot.evidenceRefs }),
	};
}

export function providerHealthSnapshotFromRef(health: ProviderHealthRef): ProviderHealthSnapshot {
	return cloneSnapshot({
		key: createProviderHealthKey({
			provider: health.providerKey,
			normalizedUrl: health.normalizedUrl,
			modelId: health.modelKey,
		}),
		state: health.state,
		healthRevision: health.healthRevision,
		generation: health.generation,
		retryAt: health.retryAt,
		lastSuccess: health.lastSuccess,
		terminalReceiptRef: health.terminalReceiptRef,
		evidenceRefs: [...(health.evidenceRefs ?? [])],
	});
}

/** 分支恢复比较：entries 集合与每个 route 的可观察健康状态完全一致才算 equal。 */
function branchHealthEqual(left: Map<string, MutableHealth>, right: Map<string, MutableHealth>): boolean {
	if (left.size !== right.size) return false;
	for (const [id, entry] of left) {
		const other = right.get(id);
		if (!other) return false;
		if (entry.state !== other.state) return false;
		if (entry.healthRevision !== other.healthRevision) return false;
		if (entry.generation !== other.generation) return false;
		if (entry.retryAt !== other.retryAt) return false;
		if (entry.lastSuccess !== other.lastSuccess) return false;
		if (entry.terminalReceiptRef !== other.terminalReceiptRef) return false;
		if (entry.evidenceRefs.length !== other.evidenceRefs.length) return false;
		if (!entry.evidenceRefs.every((ref, index) => ref === other.evidenceRefs[index])) return false;
	}
	return true;
}

/**
 * Per-provider endpoint/model circuit registry. It is intentionally not a
 * process-global singleton: each SDK root can supply its own shared registry.
 */
export class ProviderHealthRegistry {
	readonly #now: () => number;
	readonly #authCooldownMs: number;
	readonly #defaultRetryAfterMs: number;
	readonly #stallWindowMs: number;
	readonly #stallThreshold: number;
	readonly #sameSessionStallThreshold: number;
	readonly #minDistinctStallSessions: number;
	readonly #failureThreshold: number;
	readonly #ledger?: ExecutionLedger;
	readonly #entries = new Map<string, MutableHealth>();
	readonly #stalls = new Map<string, StallEvidence[]>();
	readonly #failureIds = new Map<string, Set<string>>();
	readonly #probes = new Map<string, PendingProbe>();
	readonly #wakes = new Map<string, Set<PendingWake>>();
	readonly #parked = new Map<string, ParkedProviderAssignment>();
	/** 已发布终结事件的 requestId（按 route 分表）；保证每个请求恰好一次 terminal。 */
	readonly #requestTerminals = new Set<string>();
	readonly #subscribers = new Set<(event: ProviderHealthEvent) => void>();
	#ledgerSequence = 0;
	#replayingLedger = false;
	/** 分支 epoch：reset/clear 递增；旧 epoch 的 admit 请求晚到 terminal 无副作用。 */
	#branchEpoch = 0;
	readonly #unsubscribeLedger?: () => void;

	constructor(options: ProviderHealthRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#authCooldownMs = Math.max(0, options.authCooldownMs ?? 30_000);
		this.#defaultRetryAfterMs = Math.max(0, options.defaultRetryAfterMs ?? 1_000);
		this.#stallWindowMs = Math.max(1, options.stallWindowMs ?? 60_000);
		this.#stallThreshold = Math.max(2, options.stallThreshold ?? 2);
		this.#sameSessionStallThreshold = Math.max(this.#stallThreshold, options.sameSessionStallThreshold ?? 3);
		this.#minDistinctStallSessions = Math.max(1, options.minDistinctStallSessions ?? 2);
		this.#failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 2));
		this.#ledger = options.ledger;
		for (const snapshot of options.initialHealth ?? [])
			this.#entries.set(providerHealthKeyId(snapshot.key), mutableFromSnapshot(snapshot));
		if (this.#ledger) {
			for (const health of this.#ledger.getSnapshot().providerHealth as readonly ProviderHealthRef[]) {
				this.#hydrateLedgerHealth(health);
			}
			this.#unsubscribeLedger = this.#ledger.subscribe(record => {
				if (record.type !== "provider_health_recorded") return;
				this.#hydrateLedgerHealth(record.health as ProviderHealthRef);
			});
		}
		if (options.onEvent) this.#subscribers.add(options.onEvent);
	}

	dispose(): void {
		this.#unsubscribeLedger?.();
		this.#subscribers.clear();
		for (const pending of this.#wakes.values()) {
			for (const waiter of pending) waiter.resolve(this.getSnapshot(waiter.key));
		}
		this.#wakes.clear();
	}

	subscribe(listener: (event: ProviderHealthEvent) => void): () => void {
		this.#subscribers.add(listener);
		return () => this.#subscribers.delete(listener);
	}

	getSnapshot(keyLike: ProviderHealthKeyLike): ProviderHealthSnapshot {
		const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
		const id = providerHealthKeyId(key);
		const existing = this.#entries.get(id);
		if (existing) return cloneSnapshot(existing);
		const initial: MutableHealth = { key, state: "closed", healthRevision: 0, generation: 0, evidenceRefs: [] };
		this.#entries.set(id, initial);
		return cloneSnapshot(initial);
	}

	status(keyLike: ProviderHealthKeyLike): ProviderHealthSnapshot {
		return this.getSnapshot(keyLike);
	}

	all(): readonly ProviderHealthSnapshot[] {
		return [...this.#entries.values()].map(cloneSnapshot);
	}

	/**
	 * 无副作用可用性查询：任一 route 当前可 dispatch（按注入 clock 判定）。
	 * - closed：可 dispatch。
	 * - open：仅 retryAt 已到期（可放行一次 probe）才可 dispatch。
	 * - half_open：已有在途 probe 时新请求只会排队，不视为可 dispatch；
	 *   无在途 probe 才可 dispatch。
	 * 空 entries 返回 false，由调用方用 all().length 区分“尚无观测”与
	 * “观测过但全部不可用”。
	 */
	hasDispatchableRoute(): boolean {
		const now = this.#now();
		for (const [id, entry] of this.#entries) {
			if (entry.state === "closed") return true;
			if (entry.state === "open") {
				if (entry.retryAt !== undefined && entry.retryAt <= now) return true;
				continue;
			}
			if (entry.state === "half_open" && !this.#probes.has(id)) return true;
		}
		return false;
	}

	/**
	 * 用分支 journal 恢复出的 snapshots 整体替换注册表状态。
	 * 默认（force=false）时 snapshots 与当前 entries 完全相等则严格 no-op：
	 * waiter/probe/debt/in-flight 请求全部保留且不 publish；不同则视为分支切换，
	 * 原子清旧分支状态并单次 reset。force=true 是真实 branch cutover：即使
	 * snapshots 相同也清 stalls/failureIds/probes/wakes/parked、reject 旧 waiter
	 * 与在途请求（epoch 失效），并单次 reset。
	 */
	reset(snapshots: readonly ProviderHealthSnapshot[] = [], options: { readonly force?: boolean } = {}): void {
		const next = new Map<string, MutableHealth>();
		for (const snapshot of snapshots) {
			const entry = mutableFromSnapshot(snapshot);
			next.set(providerHealthKeyId(entry.key), entry);
		}
		if (!options.force && branchHealthEqual(this.#entries, next)) return;
		// 分支切换：旧 epoch 的 probe/waiter 必须明确失效（reject），不得把旧分支
		// 的 unhealthy snapshot 当作“成功”resolve；随后原子替换 entries 并清全部债务。
		this.#branchEpoch++;
		for (const probe of this.#probes.values()) {
			probe.reject(new ProviderHealthError("Provider health registry was reset."));
		}
		this.#probes.clear();
		for (const pending of this.#wakes.values()) {
			for (const waiter of pending) {
				waiter.reject(new ProviderHealthError("Provider health registry was reset."));
			}
		}
		this.#wakes.clear();
		this.#stalls.clear();
		this.#failureIds.clear();
		this.#requestTerminals.clear();
		this.#parked.clear();
		this.#entries.clear();
		for (const [id, entry] of next) this.#entries.set(id, entry);
		this.#publish("reset");
	}

	/** 清空全部健康状态与行为债务（含 parked）；无状态时严格 no-op，仅单次 publish cleared。 */
	clear(): void {
		if (
			this.#entries.size === 0 &&
			this.#stalls.size === 0 &&
			this.#failureIds.size === 0 &&
			this.#probes.size === 0 &&
			this.#wakes.size === 0 &&
			this.#requestTerminals.size === 0
		)
			return;
		this.#branchEpoch++;
		for (const probe of this.#probes.values()) {
			probe.reject(new ProviderHealthError("Provider health registry was cleared."));
		}
		this.#probes.clear();
		for (const pending of this.#wakes.values()) {
			for (const waiter of pending) {
				waiter.reject(new ProviderHealthError("Provider health registry was cleared."));
			}
		}
		this.#wakes.clear();
		this.#stalls.clear();
		this.#failureIds.clear();
		this.#requestTerminals.clear();
		this.#parked.clear();
		this.#entries.clear();
		this.#publish("cleared");
	}

	/** Admit a request, waiting behind a single half-open probe when necessary. */
	async admit(request: ProviderHealthRequest): Promise<ProviderHealthAdmission> {
		const key = isProviderHealthKey(request.key) ? request.key : createProviderHealthKey(request.key);
		const id = providerHealthKeyId(key);
		if (request.assignment) this.#ensureParkedAssignment(request.assignment, key, this.getSnapshot(key).retryAt);
		for (;;) {
			const entry = this.#entry(key);
			const now = this.#now();
			if (entry.state === "open") {
				if (entry.retryAt === undefined || entry.retryAt > now) {
					throw new ProviderCircuitOpenError(cloneSnapshot(entry));
				}
				this.#transitionHalfOpen(entry);
			}
			if (entry.state === "half_open") {
				const existingProbe = this.#probes.get(id);
				if (existingProbe) {
					await this.#raceAbort(existingProbe.promise, request.signal);
					continue;
				}
				const pending = Promise.withResolvers<void>();
				const probe: PendingProbe = {
					promise: pending.promise,
					resolve: pending.resolve,
					reject: pending.reject,
					generation: entry.generation,
				};
				// 零消费者场景（无人排队等待 probe）下，拒绝必须被观察，否则会成为
				// unhandled rejection 并可能崩溃进程；排队请求仍通过 race 收到拒绝。
				void pending.promise.catch(() => undefined);
				this.#probes.set(id, probe);
				return {
					key,
					snapshot: cloneSnapshot(entry),
					generation: probe.generation,
					probe: true,
					branchEpoch: this.#branchEpoch,
				};
			}
			return {
				key,
				snapshot: cloneSnapshot(entry),
				generation: entry.generation,
				probe: false,
				branchEpoch: this.#branchEpoch,
			};
		}
	}

	async dispatch<T>(request: ProviderHealthRequest, operation: () => Promise<T>): Promise<T> {
		const admission = await this.admit(request);
		try {
			const result = await operation();
			// requestId terminal claim 先于任何 health mutation：同 requestId 的
			// 二次 terminal 对 snapshot/debt/event 均严格 no-op。
			if (this.#claimRequestTerminal(admission, request)) {
				this.recordSuccess(admission.key, {
					generation: admission.probe ? admission.generation : undefined,
					sessionId: request.sessionId,
				});
				this.#publishRequestTerminal(admission, request, "request_completed");
			}
			return result;
		} catch (error) {
			const status = isProviderHealthExcludedFailure(error) ? "request_interrupted" : "request_failed";
			if (this.#claimRequestTerminal(admission, request)) {
				if (admission.probe) this.#failProbe(admission.key, admission.generation, error, request);
				else this.#recordThrownFailure(admission.key, error, request);
				this.#publishRequestTerminal(admission, request, status);
			}
			throw error;
		}
	}

	/**
	 * Dispatch and observe a streaming provider call. The circuit only closes on
	 * a real assistant terminal (`done`), never on headers or an arbitrary stream
	 * promise resolving.
	 */
	async dispatchStream(
		request: ProviderHealthRequest,
		dispatch: () => Promise<AssistantMessageEventStream> | AssistantMessageEventStream,
	): Promise<AssistantMessageEventStream> {
		const admission = await this.admit(request);
		let source: AssistantMessageEventStream;
		try {
			source = await dispatch();
		} catch (error) {
			const status = isProviderHealthExcludedFailure(error) ? "request_interrupted" : "request_failed";
			if (this.#claimRequestTerminal(admission, request)) {
				if (admission.probe) this.#failProbe(admission.key, admission.generation, error, request);
				else this.#recordThrownFailure(admission.key, error, request);
				this.#publishRequestTerminal(admission, request, status);
			}
			throw error;
		}
		const observed = new AssistantMessageEventStream();
		void this.#observeStream(source, observed, admission, request);
		return observed;
	}

	recordSuccess(
		keyLike: ProviderHealthKeyLike,
		options: { generation?: number; sessionId?: string; receiptRef?: string } = {},
	): ProviderHealthSnapshot {
		const entry = this.#entry(keyLike);
		if (options.generation !== undefined && entry.generation !== options.generation) return cloneSnapshot(entry);
		const now = this.#now();
		this.#failureIds.delete(providerHealthKeyId(entry.key));
		if (entry.state === "closed" && entry.lastSuccess !== undefined) return cloneSnapshot(entry);
		entry.lastSuccess = now;
		entry.healthRevision++;
		if (entry.state === "half_open" || entry.state === "open") {
			entry.state = "closed";
			entry.retryAt = undefined;
			const id = providerHealthKeyId(entry.key);
			const probe = this.#probes.get(id);
			if (probe) {
				this.#probes.delete(id);
				probe.resolve();
			}
			this.#wakeParked(entry.key);
			this.#publish("closed", entry);
			this.#publish("provider_health_wake", entry);
		}
		this.#persist(entry);
		return cloneSnapshot(entry);
	}

	recordAuthUnavailable(keyLike: ProviderHealthKeyLike, receipt: ProviderTerminalReceipt): ProviderHealthSnapshot {
		if (isProviderHealthExcludedFailure(receipt)) return this.getSnapshot(keyLike);
		if (receipt.routeSwitched === true || receipt.credentialsExhausted === false) {
			const entry = this.#entry(keyLike);
			this.#failureIds.delete(providerHealthKeyId(entry.key));
			return cloneSnapshot(entry);
		}
		const entry = this.#entry(keyLike);
		if (!this.#hasReachedFailureThreshold(entry, receipt)) return cloneSnapshot(entry);
		return this.#open(entry, "auth_unavailable", receipt, this.#now() + this.#authCooldownMs);
	}

	recordRetryAfter(keyLike: ProviderHealthKeyLike, receipt: ProviderTerminalReceipt): ProviderHealthSnapshot {
		if (isProviderHealthExcludedFailure(receipt)) return this.getSnapshot(keyLike);
		const retryAfterMs = parseRetryAfter(receipt.error, receipt.retryAfterMs) ?? this.#defaultRetryAfterMs;
		const retryAt = receipt.retryAt ?? this.#now() + retryAfterMs;
		return this.#open(this.#entry(keyLike), "retry_after", receipt, retryAt);
	}

	recordStreamStall(keyLike: ProviderHealthKeyLike, receipt: ProviderTerminalReceipt): ProviderHealthSnapshot {
		if (isProviderHealthExcludedFailure(receipt) || receipt.noTerminal === false || receipt.noHeartbeat === false)
			return this.getSnapshot(keyLike);
		const entry = this.#entry(keyLike);
		const id = providerHealthKeyId(entry.key);
		const now = asFiniteTimestamp(receipt.occurredAt, this.#now());
		const evidence = this.#stalls.get(id) ?? [];
		evidence.push({ at: now, sessionId: receipt.sessionId, receiptRef: receipt.receiptRef });
		const cutoff = now - this.#stallWindowMs;
		while (evidence.length > 0 && evidence[0].at < cutoff) evidence.shift();
		this.#stalls.set(id, evidence);
		const distinctSessions = new Set(
			evidence.map(item => item.sessionId).filter((value): value is string => Boolean(value)),
		).size;
		const sameSessionCount = receipt.sessionId
			? evidence.filter(item => item.sessionId === receipt.sessionId).length
			: 0;
		if (evidence.length < this.#stallThreshold) return cloneSnapshot(entry);
		if (distinctSessions < this.#minDistinctStallSessions && sameSessionCount < this.#sameSessionStallThreshold)
			return cloneSnapshot(entry);
		return this.#open(entry, "stream_stalled", receipt, now + this.#defaultRetryAfterMs);
	}

	recordTerminalReceipt(keyLike: ProviderHealthKeyLike, receipt: ProviderTerminalReceipt): ProviderHealthSnapshot {
		if (receipt.kind === "abort" || isProviderHealthExcludedFailure(receipt)) return this.getSnapshot(keyLike);
		if (
			receipt.kind === "auth_unavailable" ||
			receipt.status === 401 ||
			receipt.status === 403 ||
			(receipt.credentialsExhausted === true && isAuthFailure(receipt.error))
		) {
			return this.recordAuthUnavailable(keyLike, { ...receipt, kind: "auth_unavailable" });
		}
		if (receipt.kind === "retry_after" || receipt.status === 429 || isRetryAfterFailure(receipt.error)) {
			return this.recordRetryAfter(keyLike, { ...receipt, kind: "retry_after" });
		}
		if (
			receipt.kind === "stream_stalled" ||
			(isStallFailure(receipt.error) && receipt.noTerminal !== false && receipt.noHeartbeat !== false)
		) {
			return this.recordStreamStall(keyLike, { ...receipt, kind: "stream_stalled" });
		}
		return this.recordProviderError(keyLike, receipt);
	}

	recordProviderError(
		keyLike: ProviderHealthKeyLike,
		receipt: Omit<ProviderTerminalReceipt, "kind">,
	): ProviderHealthSnapshot {
		const entry = this.#entry(keyLike);
		const normalized = { ...receipt, kind: "provider_error" as const };
		if (
			isProviderHealthExcludedFailure(normalized) ||
			isProviderHealthExcludedFailure(normalized.error) ||
			!this.#hasReachedFailureThreshold(entry, normalized)
		) {
			return cloneSnapshot(entry);
		}
		return this.#open(entry, "provider_error", normalized, this.#now() + this.#defaultRetryAfterMs);
	}

	recordHeartbeat(keyLike: ProviderHealthKeyLike, sessionId?: string): ProviderHealthSnapshot {
		const entry = this.#entry(keyLike);
		void sessionId;
		this.#publish("heartbeat", entry);
		return cloneSnapshot(entry);
	}

	park(
		input: ProviderHealthAssignmentInput,
		keyLike: ProviderHealthKeyLike,
		options: { retryAt?: number } = {},
	): ParkedProviderAssignment {
		const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
		return this.#ensureParkedAssignment(input, key, options.retryAt);
	}

	resume(assignmentId: string): ParkedProviderAssignment | undefined {
		const existing = this.#parked.get(assignmentId);
		if (!existing) return undefined;
		if (existing.status === "resumed") return existing;
		const resumed = Object.freeze({ ...existing, status: "resumed" as const, resumedAt: this.#now() });
		this.#parked.set(assignmentId, resumed);
		this.#publish("resumed", this.#entry(existing.providerKey), resumed);
		return resumed;
	}

	parkedAssignments(keyLike?: ProviderHealthKeyLike): readonly ParkedProviderAssignment[] {
		const id = keyLike === undefined ? undefined : providerHealthKeyId(keyLike);
		return [...this.#parked.values()].filter(
			item => (id === undefined || providerHealthKeyId(item.providerKey) === id) && item.status === "parked",
		);
	}

	allAssignments(): readonly ParkedProviderAssignment[] {
		return [...this.#parked.values()];
	}

	waitForHealthy(keyLike: ProviderHealthKeyLike, signal?: AbortSignal): Promise<ProviderHealthSnapshot> {
		const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
		const entry = this.#entry(key);
		if (entry.state === "closed") return Promise.resolve(cloneSnapshot(entry));
		const pending = Promise.withResolvers<ProviderHealthSnapshot>();
		const id = providerHealthKeyId(key);
		const waiters = this.#wakes.get(id) ?? new Set<PendingWake>();
		const wake: PendingWake = { key, promise: pending.promise, resolve: pending.resolve, reject: pending.reject };
		waiters.add(wake);
		this.#wakes.set(id, waiters);
		return this.#raceAbort(pending.promise, signal).finally(() => {
			waiters.delete(wake);
			if (waiters.size === 0) this.#wakes.delete(id);
		});
	}

	#entry(keyLike: ProviderHealthKeyLike): MutableHealth {
		const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
		const id = providerHealthKeyId(key);
		const existing = this.#entries.get(id);
		if (existing) return existing;
		const created: MutableHealth = { key, state: "closed", healthRevision: 0, generation: 0, evidenceRefs: [] };
		this.#entries.set(id, created);
		return created;
	}

	#hasReachedFailureThreshold(entry: MutableHealth, receipt: ProviderTerminalReceipt): boolean {
		const requestId = receipt.requestId?.trim();
		const errorId = receipt.errorId?.trim();
		// Explicit credential rotation exhaustion is stronger than one request failure.
		if (!requestId && !errorId && receipt.kind === "auth_unavailable" && receipt.credentialsExhausted === true)
			return true;
		const identity = requestId
			? `request:${requestId}`
			: errorId
				? `error:${errorId}`
				: `receipt:${receipt.receiptRef}`;
		const key = providerHealthKeyId(entry.key);
		const ids = this.#failureIds.get(key) ?? new Set<string>();
		ids.add(identity);
		this.#failureIds.set(key, ids);
		return ids.size >= this.#failureThreshold;
	}

	#transitionHalfOpen(entry: MutableHealth): void {
		if (entry.state !== "open") return;
		entry.state = "half_open";
		entry.healthRevision++;
		this.#persist(entry);
		this.#publish("half_open", entry);
	}

	#open(
		entry: MutableHealth,
		_reason: ProviderHealthReceiptKind,
		receipt: ProviderTerminalReceipt,
		retryAt: number,
	): ProviderHealthSnapshot {
		if (isProviderHealthExcludedFailure(receipt)) return cloneSnapshot(entry);
		const changed =
			entry.state !== "open" || entry.retryAt !== retryAt || entry.terminalReceiptRef !== receipt.receiptRef;
		if (!changed) return cloneSnapshot(entry);
		entry.state = "open";
		entry.generation++;
		entry.healthRevision++;
		entry.retryAt = retryAt;
		entry.terminalReceiptRef = receipt.receiptRef;
		for (const ref of receipt.evidenceRefs ?? [])
			if (typeof ref === "string" && !entry.evidenceRefs.includes(ref)) entry.evidenceRefs.push(ref);
		this.#persist(entry);
		this.#publish("opened", entry);
		return cloneSnapshot(entry);
	}

	#failProbe(
		keyLike: ProviderHealthKeyLike,
		generation: number,
		error: unknown,
		request: ProviderHealthRequest,
	): void {
		const key = isProviderHealthKey(keyLike) ? keyLike : createProviderHealthKey(keyLike);
		const id = providerHealthKeyId(key);
		const probe = this.#probes.get(id);
		if (!probe || probe.generation !== generation) return;
		this.#probes.delete(id);
		const receipt = request.receipt ?? this.#receiptFromError(error, request);
		const snapshot = this.recordTerminalReceipt(key, receipt);
		probe.reject(
			isProviderHealthExcludedFailure(error)
				? error
				: new ProviderCircuitOpenError(this.getSnapshot(key) ?? snapshot),
		);
	}

	#recordThrownFailure(keyLike: ProviderHealthKeyLike, error: unknown, request: ProviderHealthRequest): void {
		if (request.receipt) {
			this.recordTerminalReceipt(keyLike, {
				...request.receipt,
				requestId: request.receipt.requestId ?? request.requestId,
				errorId: request.receipt.errorId ?? request.errorId,
			});
			return;
		}
		if (isProviderHealthExcludedFailure(error)) return;
		if (isAuthFailure(error)) {
			this.recordAuthUnavailable(keyLike, {
				kind: "auth_unavailable",
				receiptRef: this.#receiptRef("auth_unavailable"),
				requestId: request.requestId,
				errorId: request.errorId,
				sessionId: request.sessionId,
				credentialsExhausted: true,
				routeSwitched: request.routeSwitched,
				error,
			});
		} else if (isRetryAfterFailure(error)) {
			this.recordRetryAfter(keyLike, {
				kind: "retry_after",
				receiptRef: this.#receiptRef("retry_after"),
				requestId: request.requestId,
				errorId: request.errorId,
				sessionId: request.sessionId,
				error,
				retryAfterMs: parseRetryAfter(error),
			});
		} else if (isStallFailure(error)) {
			this.recordStreamStall(keyLike, {
				kind: "stream_stalled",
				receiptRef: this.#receiptRef("stream_stalled"),
				requestId: request.requestId,
				errorId: request.errorId,
				sessionId: request.sessionId,
				noTerminal: true,
				noHeartbeat: true,
				error,
			});
		} else {
			this.recordProviderError(keyLike, {
				receiptRef: this.#receiptRef("provider_error"),
				requestId: request.requestId,
				errorId: request.errorId,
				sessionId: request.sessionId,
				error,
			});
		}
	}

	#receiptFromError(
		error: unknown,
		request: Pick<ProviderHealthRequest, "sessionId" | "requestId" | "errorId">,
	): ProviderTerminalReceipt {
		const kind: ProviderHealthReceiptKind = isProviderHealthExcludedFailure(error)
			? "abort"
			: isAuthFailure(error)
				? "auth_unavailable"
				: isRetryAfterFailure(error)
					? "retry_after"
					: isStallFailure(error)
						? "stream_stalled"
						: "provider_error";
		return {
			kind,
			receiptRef: this.#receiptRef(kind),
			sessionId: request.sessionId,
			requestId: request.requestId,
			errorId: request.errorId,
			credentialsExhausted: kind === "auth_unavailable",
			noTerminal: kind === "stream_stalled",
			noHeartbeat: kind === "stream_stalled",
			error,
		};
	}

	async #observeStream(
		source: AssistantMessageEventStream,
		observed: AssistantMessageEventStream,
		admission: ProviderHealthAdmission,
		request: ProviderHealthRequest,
	): Promise<void> {
		let sawHeartbeat = false;
		try {
			for await (const event of source as AsyncIterable<AssistantMessageEvent>) {
				// 旧分支 cutover 后的晚到流事件：仅转发给消费者，注册表零副作用。
				if (!this.#isCurrentBranch(admission)) {
					observed.push(event);
					continue;
				}
				if (event.type !== "done" && event.type !== "error") {
					sawHeartbeat = true;
					this.recordHeartbeat(admission.key, request.sessionId);
				} else if (event.type === "done") {
					if (this.#claimRequestTerminal(admission, request)) {
						this.recordSuccess(admission.key, {
							generation: admission.probe ? admission.generation : undefined,
							sessionId: request.sessionId,
						});
						this.#publishRequestTerminal(admission, request, "request_completed");
					}
				} else {
					const receipt = {
						...this.#receiptFromError(event.error, request),
						noTerminal: true,
						noHeartbeat: !sawHeartbeat,
					};
					if (this.#claimRequestTerminal(admission, request)) {
						if (admission.probe) {
							this.#failProbe(admission.key, admission.generation, event.error, { ...request, receipt });
						} else if (!isProviderHealthExcludedFailure(event.error)) {
							this.recordTerminalReceipt(admission.key, receipt);
						}
						this.#publishRequestTerminal(
							admission,
							request,
							isProviderHealthExcludedFailure(event.error) ? "request_interrupted" : "request_failed",
						);
					}
				}
				observed.push(event);
			}
			if (!observed.done) {
				const result = await source.result();
				observed.end(result);
			}
		} catch (error) {
			if (this.#claimRequestTerminal(admission, request)) {
				if (admission.probe) {
					this.#failProbe(admission.key, admission.generation, error, {
						...request,
						receipt: {
							...this.#receiptFromError(error, request),
							noTerminal: true,
							noHeartbeat: !sawHeartbeat,
						},
					});
				} else {
					this.recordTerminalReceipt(admission.key, {
						...this.#receiptFromError(error, request),
						noTerminal: true,
						noHeartbeat: !sawHeartbeat,
					});
				}
				this.#publishRequestTerminal(
					admission,
					request,
					isProviderHealthExcludedFailure(error) ? "request_interrupted" : "request_failed",
				);
			}
			if (!observed.done) observed.fail(error);
		}
	}

	/** 分支 epoch 校验：旧分支的 admit 请求晚到 terminal 不得产生任何副作用。 */
	#isCurrentBranch(admission: Pick<ProviderHealthAdmission, "branchEpoch">): boolean {
		return admission.branchEpoch === this.#branchEpoch;
	}

	/**
	 * 请求终结声明：必须在任何 health mutation 之前调用。无 requestId 的请求
	 * 不参与去重（健康统计照常）；有 requestId 时仅首个 terminal 获得 claim，
	 * 后续同 requestId terminal 对 snapshot/debt/event 均严格 no-op。
	 */
	#claimRequestTerminal(admission: ProviderHealthAdmission, request: ProviderHealthRequest): boolean {
		if (!this.#isCurrentBranch(admission)) return false;
		const requestId = request.requestId?.trim();
		if (!requestId) return true;
		const terminalKey = `${providerHealthKeyId(admission.key)}\u0000${requestId}`;
		if (this.#requestTerminals.has(terminalKey)) return false;
		this.#requestTerminals.add(terminalKey);
		return true;
	}

	#receiptRef(kind: ProviderHealthReceiptKind): string {
		return `provider-health:${kind}:${++this.#ledgerSequence}`;
	}

	#ensureParkedAssignment(
		input: ProviderHealthAssignmentInput,
		key: ProviderHealthKey,
		retryAt?: number,
	): ParkedProviderAssignment {
		const existing = this.#parked.get(input.assignmentId);
		if (existing) return existing;
		const assignment: ParkedProviderAssignment = Object.freeze({
			assignmentId: input.assignmentId,
			...(input.contractRef ? { contractRef: input.contractRef } : {}),
			assignmentRevision: input.assignmentRevision ?? 0,
			providerKey: key,
			...(retryAt === undefined ? {} : { retryAt }),
			replaySafety: input.replaySafety ?? "unknown",
			status: "parked",
			parkedAt: this.#now(),
		});
		this.#parked.set(input.assignmentId, assignment);
		this.#publish("parked", this.#entry(key), assignment);
		return assignment;
	}

	#wakeParked(key: ProviderHealthKey): void {
		for (const assignment of this.#parked.values()) {
			if (
				assignment.status === "parked" &&
				assignment.replaySafety === "safe" &&
				providerHealthKeyId(assignment.providerKey) === providerHealthKeyId(key)
			)
				this.resume(assignment.assignmentId);
		}
		const waiters = this.#wakes.get(providerHealthKeyId(key));
		if (waiters) {
			const snapshot = this.getSnapshot(key);
			for (const waiter of waiters) waiter.resolve(snapshot);
		}
	}

	#publish(
		type: ProviderHealthEventType,
		entry?: MutableHealth,
		assignment?: ParkedProviderAssignment,
		requestId?: string,
	): void {
		const event: ProviderHealthEvent = Object.freeze({
			type,
			...(entry ? { key: entry.key, snapshot: cloneSnapshot(entry) } : {}),
			...(assignment ? { assignment } : {}),
			...(requestId ? { requestId } : {}),
		});
		for (const listener of [...this.#subscribers]) {
			try {
				listener(event);
			} catch {
				// 健康通知是建议性的，绝不能破坏派发。
			}
		}
	}

	/** 每个已捕获 requestId 的请求恰好发布一次 terminal（claim 已先行去重）。 */
	#publishRequestTerminal(
		admission: ProviderHealthAdmission,
		request: ProviderHealthRequest,
		status: "request_completed" | "request_failed" | "request_interrupted",
	): void {
		const requestId = request.requestId?.trim();
		if (!requestId) return;
		this.#publish(status, this.#entry(admission.key), undefined, requestId);
	}

	#persist(entry: MutableHealth): void {
		if (!this.#ledger || this.#replayingLedger) return;
		const snapshot = cloneSnapshot(entry);
		try {
			this.#ledger.append({
				type: "provider_health_recorded",
				recordId: `provider-health:${providerHealthKeyId(entry.key)}:${snapshot.healthRevision}`,
				health: providerHealthRefFromSnapshot(snapshot),
			});
		} catch {
			// A health cache must not turn a provider request into a ledger failure.
		}
	}

	#hydrateLedgerHealth(health: ProviderHealthRef): void {
		const snapshot = providerHealthSnapshotFromRef(health);
		const id = providerHealthKeyId(snapshot.key);
		const existing = this.#entries.get(id);
		if (existing && existing.healthRevision >= snapshot.healthRevision) return;
		this.#replayingLedger = true;
		try {
			this.#entries.set(id, mutableFromSnapshot(snapshot));
		} finally {
			this.#replayingLedger = false;
		}
	}

	async #raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
		const aborted = Promise.withResolvers<never>();
		const onAbort = () =>
			aborted.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

export type ProviderHealthLedgerSnapshot = Pick<ExecutionScopeSnapshot, "providerHealth" | "revision">;
export type ProviderHealthExecutionRecord = Extract<ExecutionLedgerRecord, { type: "provider_health_recorded" }>;
export type ProviderHealthAssignmentRef = ExecutionAssignmentRef;

export { ProviderCircuitOpenError, ProviderHealthError } from "./errors";
