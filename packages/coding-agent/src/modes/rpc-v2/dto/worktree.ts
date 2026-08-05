/**
 * Managed Worktree lifecycle wire DTOs（worktree.lifecycle v1）。
 *
 * 与 Desktop `san_bridge` / `san_protocol` / M3 engineering contract 同形。
 * 本文件是 RPC 线协议权威源；禁止旧别名（force/reason、tag/ref、sourceSnapshot 等）。
 */

import { resolve } from "node:path";

// ─── pathRef 冻结格式 ─────────────────────────────────────────────────────────
// san-worktree-path://v1/{environmentId}/{lowercaseHex(canonicalAbsoluteUtf8Path)}

export const WORKTREE_PATH_REF_PREFIX = "san-worktree-path://v1/" as const;

/** Wire pathRef 字符串（冻结 scheme；禁止 workspace:// 等 legacy）。 */
export type WorktreePathRef = string;

/** 规范化绝对路径：resolve 后作为 canonicalAbsoluteUtf8Path 的输入。 */
export function canonicalizeAbsolutePath(absolutePath: string): string {
	if (typeof absolutePath !== "string" || absolutePath.length === 0) {
		throw new TypeError("canonicalizeAbsolutePath requires a non-empty path string");
	}
	return resolve(absolutePath);
}

/** 将 UTF-8 路径字节编码为小写 hex。 */
export function pathToLowercaseHex(canonicalAbsoluteUtf8Path: string): string {
	return Buffer.from(canonicalAbsoluteUtf8Path, "utf8").toString("hex").toLowerCase();
}

/** 构造冻结 pathRef。 */
export function buildWorktreePathRef(environmentId: string, absolutePath: string): WorktreePathRef {
	if (typeof environmentId !== "string" || environmentId.length === 0) {
		throw new TypeError("buildWorktreePathRef requires environmentId");
	}
	const canonical = canonicalizeAbsolutePath(absolutePath);
	const hex = pathToLowercaseHex(canonical);
	return `${WORKTREE_PATH_REF_PREFIX}${environmentId}/${hex}`;
}

/** 解析 pathRef；非法格式（含 legacy workspace://）返回 null。 */
export function parseWorktreePathRef(
	pathRef: string,
): { environmentId: string; pathHex: string; schemeVersion: "v1" } | null {
	if (typeof pathRef !== "string" || !pathRef.startsWith(WORKTREE_PATH_REF_PREFIX)) return null;
	const rest = pathRef.slice(WORKTREE_PATH_REF_PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash <= 0 || slash === rest.length - 1) return null;
	const environmentId = rest.slice(0, slash);
	const pathHex = rest.slice(slash + 1);
	if (!/^[0-9a-f]+$/.test(pathHex) || pathHex.length % 2 !== 0) return null;
	if (!environmentId || environmentId.includes("/")) return null;
	return { environmentId, pathHex, schemeVersion: "v1" };
}

/** 从 pathRef 还原 canonical 绝对路径（UTF-8）。 */
export function decodeWorktreePathRef(pathRef: string): { environmentId: string; absolutePath: string } | null {
	const parsed = parseWorktreePathRef(pathRef);
	if (!parsed) return null;
	try {
		const absolutePath = Buffer.from(parsed.pathHex, "hex").toString("utf8");
		if (!absolutePath) return null;
		return { environmentId: parsed.environmentId, absolutePath };
	} catch {
		return null;
	}
}

// ─── 状态机（冻结） ──────────────────────────────────────────────────────────

export type ManagedWorktreeState =
	| "creating"
	| "setup_pending"
	| "ready"
	| "in_use"
	| "dirty"
	| "applying"
	| "conflicted"
	| "archiving"
	| "archived"
	| "failed";

export const MANAGED_WORKTREE_STATES: readonly ManagedWorktreeState[] = Object.freeze([
	"creating",
	"setup_pending",
	"ready",
	"in_use",
	"dirty",
	"applying",
	"conflicted",
	"archiving",
	"archived",
	"failed",
]);

// ─── Create / record ─────────────────────────────────────────────────────────

/** Desktop 冻结：仅 commit | branch。 */
export type ManagedWorktreeBaseKind = "branch" | "commit";

export interface ManagedWorktreeBase {
	kind: ManagedWorktreeBaseKind;
	value: string;
	/** 创建时已解析的 object id（完整 oid）。 */
	resolvedOid: string;
}

export interface WorktreeIdempotencyMeta {
	idempotencyKey: string;
}

/**
 * worktree.create 冻结参数（= Desktop WorktreeCreateParams）。
 * mutation 幂等仅由 service 对 meta.idempotencyKey 的 canonical receipt 裁决。
 */
export interface CreateManagedWorktreeParams {
	projectCwd: string;
	repoId: string;
	base: ManagedWorktreeBase;
	branchName?: string;
	purpose: "session";
	setupActionId?: string;
	meta: WorktreeIdempotencyMeta;
}

export interface ManagedWorktreeSetupInfo {
	actionId?: string;
	status?: string;
	/** Desktop ProcessHost processId；setup.start 成功后 durable，供 cancel/recovery。 */
	processId?: string;
	/** 绑定 process 的 revision；cancel stop 的 expectedRevision。 */
	processRevision?: number;
}

export interface ManagedWorktreeFailure {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/** Managed worktree 公共记录（get/list/create/archive 结果）。 */
export interface ManagedWorktree {
	worktreeId: string;
	environmentId: string;
	repoId: string;
	pathRef: WorktreePathRef;
	displayPath: string;
	baseOid: string;
	branch?: string;
	headOid: string;
	state: ManagedWorktreeState;
	dirty: boolean;
	revision: number;
	owningSessionId?: string;
	setup?: ManagedWorktreeSetupInfo;
	failure?: ManagedWorktreeFailure;
}

// ─── Apply plan / params（与 san_bridge / contract §6.5 同形） ───────────────

export type WorktreeApplyStrategy = "patch" | "merge_commit";

export type WorktreeFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked"
	| "typechange"
	| "conflicted";

export interface WorktreeApplyPlanFile {
	fileChangeId: string;
	status: WorktreeFileStatus | string;
}

export interface WorktreeApplyPlanConflict {
	path: string;
	kind: string;
}

/**
 * apply.prepare 只读计划结果。
 * 字段名冻结为 sourceSnapshotId / targetRepoId / targetSnapshotId（禁止 sourceSnapshot 等旧名）。
 */
export interface WorktreeApplyPlan {
	planId: string;
	worktreeId: string;
	sourceSnapshotId: string;
	targetRepoId: string;
	targetSnapshotId: string;
	strategy: WorktreeApplyStrategy;
	files: WorktreeApplyPlanFile[];
	conflicts: WorktreeApplyPlanConflict[];
	warnings: string[];
	expiresAt: string;
}

/** worktree.apply.prepare 请求参数（san_bridge WorktreeApplyPrepareParams）。 */
export interface WorktreeApplyPrepareParams {
	worktreeId: string;
	expectedWorktreeRevision: number;
	expectedTargetSnapshotId: string;
	strategy: WorktreeApplyStrategy;
	meta: WorktreeIdempotencyMeta;
}

/**
 * worktree.apply 请求参数（san_bridge WorktreeApplyParams）。
 * 不含 worktreeId：由 planId 绑定。
 */
export interface WorktreeApplyParams {
	planId: string;
	expectedWorktreeRevision: number;
	expectedTargetSnapshotId: string;
	meta: WorktreeIdempotencyMeta;
}

/**
 * worktree.archive 请求参数。
 * 禁止 force/reason；用 expectedRevision + retainChanges。
 */
export interface WorktreeArchiveParams {
	worktreeId: string;
	expectedRevision: number;
	/** 显式保留未应用变更；默认 false（缺省时由 schema optional）。 */
	retainChanges?: boolean;
	meta: WorktreeIdempotencyMeta;
}

/** setup.start：setupActionId 可选覆盖 create 时的 action。 */
export interface WorktreeSetupStartParams {
	worktreeId: string;
	setupActionId?: string;
	meta: WorktreeIdempotencyMeta;
}

export interface WorktreeSetupCancelParams {
	worktreeId: string;
	meta: WorktreeIdempotencyMeta;
}

// ─── 操作 / 事件 / capability ────────────────────────────────────────────────

export type WorktreeOperationKind = "create" | "setup.start" | "setup.cancel" | "apply.prepare" | "apply" | "archive";

export type WorktreeOperationOutcome = "completed" | "failed" | "outcome_unknown";

export type WorktreeErrorCode =
	| "INVALID_PARAMS"
	| "NOT_FOUND"
	| "CONFLICT"
	| "IDEMPOTENCY_CONFLICT"
	| "OUTCOME_UNKNOWN"
	| "CAPABILITY_UNAVAILABLE"
	| "PRECONDITION_FAILED"
	| "INTERNAL";

/** 服务侧 durable 操作回执（wire 原样返回，不在 mode 层再裁决幂等）。 */
export interface WorktreeOperationReceipt {
	operationId: string;
	worktreeId: string;
	kind: WorktreeOperationKind;
	idempotencyKey: string;
	paramsHash: string;
	outcome: WorktreeOperationOutcome;
	result?: unknown;
	error?: { code: WorktreeErrorCode; message: string; details?: Record<string, unknown> };
	createdAt: string;
	updatedAt: string;
}

/** create / archive 等 mutation 的 wire 结果。 */
export interface WorktreeMutationResult {
	worktree: ManagedWorktree;
	operationId: string;
	/** true 表示命中 service 幂等 receipt 回放。 */
	replayed: boolean;
}

/**
 * §6.7 冻结通知 method（RPC notification method 名，非单一 worktree.lifecycle）。
 * capability 名仍为 worktree.lifecycle。
 */
export const WORKTREE_EVENT_METHODS = Object.freeze([
	"worktree.created",
	"worktree.state.changed",
	"worktree.setup.started",
	"worktree.setup.completed",
	"worktree.apply.started",
	"worktree.apply.completed",
	"worktree.apply.conflicted",
	"worktree.archived",
] as const);

export type WorktreeEventMethod = (typeof WORKTREE_EVENT_METHODS)[number];

/**
 * worktree 事件 params（各 notification method 共用最小承重字段）。
 * RPC 帧：{ jsonrpc:"2.0", method: WorktreeEventMethod, params: WorktreeEventParams }
 */
export interface WorktreeEventParams {
	worktreeId: string;
	revision: number;
	operationId: string;
	state: ManagedWorktreeState;
	reason: string;
	/** ISO-8601 时间戳。 */
	timestamp: string;
	/** durable 终态迁移为 true。 */
	terminal?: boolean;
	previousState?: ManagedWorktreeState;
	worktree?: ManagedWorktree;
}

/** 服务 → mode 的事件投递：method 为冻结 notification 名。 */
export interface WorktreeEventEnvelope {
	method: WorktreeEventMethod;
	params: WorktreeEventParams;
}

export interface WorktreeLifecycleLimits {
	maxWorktrees: number;
	maxConcurrentCreates?: number;
	applyPlanTtlMs: number;
	strategies: readonly WorktreeApplyStrategy[];
}

/** 8 个 wire method（与 protocol/methods 目录一致）。 */
export const WORKTREE_LIFECYCLE_METHODS = Object.freeze([
	"worktree.create",
	"worktree.get",
	"worktree.list",
	"worktree.setup.start",
	"worktree.setup.cancel",
	"worktree.apply.prepare",
	"worktree.apply",
	"worktree.archive",
] as const);

export type WorktreeLifecycleMethod = (typeof WORKTREE_LIFECYCLE_METHODS)[number];

/**
 * capability.details 形状。
 * setup/apply 仅在真实 bridge 接入后可为 true；wire 在未接线时强制 false。
 */
export interface WorktreeLifecycleCapabilityDetails {
	name: "worktree.lifecycle";
	version: 1;
	methods: readonly string[];
	setupAvailable: boolean;
	applyAvailable: boolean;
	/** durable recovery（ensureLoaded/open）就绪后为 true。 */
	recoveryReady: boolean;
	limits: WorktreeLifecycleLimits;
	status?: "available" | "degraded" | "unavailable";
	/** 重启后无法安全判定终态的副作用；客户端必须先 get/reconcile，禁止盲重试。 */
	unresolvedUnknownOperations?: readonly {
		operationId: string;
		kind: WorktreeOperationKind;
		worktreeId: string;
	}[];
}

/** list 过滤参数。 */
export interface WorktreeListFilter {
	state?: ManagedWorktreeState | ManagedWorktreeState[];
	states?: ManagedWorktreeState[];
	repoId?: string;
	environmentId?: string;
}
