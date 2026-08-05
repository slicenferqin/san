/**
 * Managed Worktree lifecycle service（worktree.lifecycle v1）。
 * 方法：create/get/list/setup.start/setup.cancel/apply.prepare/apply/archive
 *
 * 与 dto/worktree 冻结合同同形；禁止 legacy 别名（force/reason、sourcePath、
 * sourceSnapshot 等）。真实 git worktree add/remove 经结构化 Bun.spawn argv。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	buildWorktreePathRef,
	type CreateManagedWorktreeParams,
	canonicalizeAbsolutePath,
	type ManagedWorktree,
	type ManagedWorktreeState,
	WORKTREE_LIFECYCLE_METHODS,
	type WorktreeApplyParams,
	type WorktreeApplyPlan,
	type WorktreeApplyPlanConflict,
	type WorktreeApplyPlanFile,
	type WorktreeApplyPrepareParams,
	type WorktreeApplyStrategy,
	type WorktreeArchiveParams,
	type WorktreeErrorCode,
	type WorktreeEventEnvelope,
	type WorktreeEventMethod,
	type WorktreeFileStatus,
	type WorktreeLifecycleCapabilityDetails,
	type WorktreeLifecycleLimits,
	type WorktreeListFilter,
	type WorktreeMutationResult,
	type WorktreeOperationKind,
	type WorktreeOperationOutcome,
	type WorktreeOperationReceipt,
	type WorktreeSetupCancelParams,
	type WorktreeSetupStartParams,
} from "./dto/worktree";

// ─── 错误 ────────────────────────────────────────────────────────────────────

export class WorktreeError extends Error {
	readonly code: WorktreeErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(code: WorktreeErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
		this.details = details;
	}
}

const WORKTREE_ERROR_CODES: readonly WorktreeErrorCode[] = [
	"INVALID_PARAMS",
	"NOT_FOUND",
	"CONFLICT",
	"IDEMPOTENCY_CONFLICT",
	"OUTCOME_UNKNOWN",
	"CAPABILITY_UNAVAILABLE",
	"PRECONDITION_FAILED",
	"INTERNAL",
];

/** 将 durable failure.code（历史 string）收窄为冻结 WorktreeErrorCode。 */
function coerceWorktreeErrorCode(code: string | undefined): WorktreeErrorCode {
	for (const allowed of WORKTREE_ERROR_CODES) {
		if (allowed === code) return allowed;
	}
	return "INTERNAL";
}

// ─── 注入端口 ────────────────────────────────────────────────────────────────

/** setup 端口：缺省或 !ready 时 setup.start/cancel 返回 CAPABILITY_UNAVAILABLE。 */
export interface WorktreeSetupPort {
	readonly ready: boolean;
	start(input: {
		worktreeId: string;
		environmentId: string;
		pathRef?: string;
		displayPath?: string;
		setupActionId: string;
		operationId: string;
		idempotencyKey: string;
	}): Promise<{ status: string; processId?: string; processRevision?: number }>;
	cancel(input: {
		worktreeId: string;
		operationId?: string;
		processId?: string;
		expectedRevision?: number;
		idempotencyKey: string;
	}): Promise<{ cancelled: boolean; status: string }>;
}

/** apply 端口：缺省或 !ready 时 apply 返回 CAPABILITY_UNAVAILABLE（prepare 仍只读可用）。 */
export interface WorktreeApplyPort {
	readonly ready: boolean;
	/**
	 * 该 port 实际可执行的 mutation strategies。
	 * capability limits.strategies 仅取与服务支持集的交集；
	 * ready 但未声明 / 空数组 => 不广告任何 strategy。
	 */
	readonly strategies: readonly WorktreeApplyStrategy[];
	apply(input: {
		plan: WorktreeApplyPlan;
		worktree: ManagedWorktree;
		expectedWorktreeRevision: number;
		expectedTargetSnapshotId: string;
		operationId: string;
		idempotencyKey: string;
	}): Promise<{ worktree: ManagedWorktree; result?: unknown }>;
}

// ─── 内部记录 / 持久化 ───────────────────────────────────────────────────────

/** 内部 durable 记录（wire 投影为 ManagedWorktree）。 */
interface InternalWorktreeRecord {
	worktreeId: string;
	environmentId: string;
	repoId: string;
	/** 源仓库绝对路径（projectCwd 规范化）。 */
	repositoryPath: string;
	/** 真实 git worktree 绝对路径。 */
	displayPath: string;
	pathRef: string;
	baseOid: string;
	branch?: string;
	headOid: string;
	state: ManagedWorktreeState;
	dirty: boolean;
	revision: number;
	owningSessionId?: string;
	setupActionId?: string;
	/** setup 运行态；processId/revision 必须 durable，供 restart 后 cancel。 */
	setup?: {
		actionId?: string;
		status?: string;
		processId?: string;
		processRevision?: number;
	};
	failure?: { code: string; message: string; details?: Record<string, unknown> };
	/** 活跃绑定会话计数（>0 视为 in_use / 拒 archive）。 */
	activeSessionCount: number;
	createdAt: string;
	updatedAt: string;
	lastOperationId?: string;
}

interface StoredApplyPlan extends WorktreeApplyPlan {
	expectedWorktreeRevision: number;
}

interface EnvironmentIndex {
	version: 1;
	environmentId: string;
	worktrees: Record<string, InternalWorktreeRecord>;
	/** idempotencyKey → operationId */
	idempotencyIndex: Record<string, string>;
	/** planId → plan */
	plans: Record<string, StoredApplyPlan>;
}

interface JournalEntry {
	seq: number;
	at: string;
	operationId: string;
	worktreeId: string;
	kind: WorktreeOperationKind;
	outcome: WorktreeOperationOutcome;
	note?: string;
}

export type WorktreeEventEmitter = (event: WorktreeEventEnvelope) => void;

export interface WorktreeLifecycleServiceOptions {
	/** durable 状态根目录（environment / journal / receipts）。 */
	stateDir: string;
	/**
	 * 显式 pin 的 managed environment 身份（与 rpc runtimeId 分离）。
	 * - 有值：strict pin；reload 不 adopt 磁盘 ID；跨 pin 拒绝 get。
	 * - 省略：未 pin；有 environment.json 则 adopt 既有 ID（兼容历史 rt_*）；
	 *   无文件则生成一次稳定 `env_*` 并在首次 persist 落盘。
	 */
	environmentId?: string;
	/** 事件投递（RPC mode 接到 §6.7 notification）。 */
	emit?: WorktreeEventEmitter;
	emitEvent?: WorktreeEventEmitter;
	now?: () => Date;
	idFactory?: () => string;
	/** 真实 setup 端口；缺省/!ready → CAPABILITY_UNAVAILABLE。 */
	setupPort?: WorktreeSetupPort | null;
	/** 真实 apply 端口；缺省/!ready → CAPABILITY_UNAVAILABLE。 */
	applyPort?: WorktreeApplyPort | null;
	/** 兼容 mode 构造字段（忽略布尔 ready 旗标，以端口 ready 为准）。 */
	processHostReady?: boolean;
	gitMutationReady?: boolean;
	processHost?: unknown;
	gitMutation?: unknown;
	limits?: Partial<WorktreeLifecycleLimits>;
	/** worktree 物理根；默认 stateDir/worktrees。 */
	worktreesRoot?: string;
}

export const WORKTREE_LIFECYCLE_V1_LIMITS: WorktreeLifecycleLimits = Object.freeze({
	maxWorktrees: 32,
	maxConcurrentCreates: 4,
	applyPlanTtlMs: 15 * 60 * 1000,
	strategies: Object.freeze(["patch", "merge_commit"] as const),
});

export const WORKTREE_LIFECYCLE_CAPABILITY = "worktree.lifecycle" as const;
export const WORKTREE_LIFECYCLE_CAPABILITY_VERSION = 1 as const;

// ─── 工具 ────────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashParams(params: unknown): string {
	return createHash("sha256").update(canonicalJson(params)).digest("hex");
}

function defaultId(): string {
	return randomUUID();
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, path);
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw err;
	}
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function spawnGit(argv: string[], cwd?: string): Promise<SpawnResult> {
	try {
		const proc = Bun.spawn(["git", ...argv], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 127, stdout: "", stderr: message };
	}
}

/** 不 trim stdout：保留 porcelain -z / 行尾空格语义。 */
async function spawnGitRaw(argv: string[], cwd?: string): Promise<SpawnResult> {
	try {
		const proc = Bun.spawn(["git", ...argv], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr: stderr.trim() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 127, stdout: "", stderr: message };
	}
}

function mapPorcelainXyToStatus(xy: string): WorktreeFileStatus {
	if (xy.length < 2) return "modified";
	const x = xy[0]!;
	const y = xy[1]!;
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
		return "conflicted";
	}
	if (x === "R" || y === "R") return "renamed";
	if (x === "C" || y === "C") return "copied";
	if (x === "A" || y === "A") return "added";
	if (x === "D" || y === "D") return "deleted";
	if (x === "T" || y === "T") return "typechange";
	if (x === "M" || y === "M") return "modified";
	if (x === "?" || y === "?") return "untracked";
	if (x === "!" || y === "!") return "untracked";
	return "modified";
}

function conflictKindFromXy(xy: string): string {
	if (xy === "DD") return "both_deleted";
	if (xy === "AU") return "added_by_us";
	if (xy === "UA") return "added_by_them";
	if (xy === "DU") return "deleted_by_us";
	if (xy === "UD") return "deleted_by_them";
	if (xy === "AA") return "both_added";
	if (xy === "UU") return "both_modified";
	return "unmerged";
}

function derivePlanFileChangeId(sourceSnapshotId: string, status: string, pathText: string, oldPath?: string): string {
	return createHash("sha256")
		.update(["file", sourceSnapshotId, status, oldPath ?? "", pathText].join("\0"))
		.digest("hex");
}

interface ApplyInventory {
	files: WorktreeApplyPlanFile[];
	conflicts: WorktreeApplyPlanConflict[];
	warnings: string[];
	dirty: boolean;
	headOid?: string;
}

/**
 * 从真实 worktree 路径读取 git status，生成 apply.prepare inventory。
 * 禁止固定空成功：路径缺失 / git 失败返回 typed 错误；干净树才可空 files。
 */
async function collectApplyInventory(displayPath: string, sourceSnapshotId: string): Promise<ApplyInventory> {
	if (!existsSync(displayPath)) {
		throw new WorktreeError("PRECONDITION_FAILED", "worktree path does not exist for apply.prepare", {
			feature: "apply.prepare",
		});
	}

	// porcelain=v1 行协议：稳定、无 shell；覆盖 staged/unstaged/untracked/unmerged。
	const status = await spawnGitRaw(["status", "--porcelain=v1", "--untracked-files=all", "-z"], displayPath);
	// 任何非零 exit 一律 fail-closed：禁止 partial inventory 当成功计划。
	if (status.exitCode !== 0) {
		throw new WorktreeError("CAPABILITY_UNAVAILABLE", "unable to read worktree git status for apply.prepare", {
			feature: "apply.prepare",
			available: false,
			exitCode: status.exitCode,
		});
	}
	const files: WorktreeApplyPlanFile[] = [];
	const conflicts: WorktreeApplyPlanConflict[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();

	// porcelain=v1 -z：记录以 NUL 分隔；rename/copy 为 "XY newpath\0oldpath\0"
	// （不是单字段内 "old -> new"）。必须 lookahead 消费第二字段。
	const parts = status.stdout.split("\0");
	for (let i = 0; i < parts.length; ) {
		const record = parts[i]!;
		if (!record) {
			i += 1;
			continue;
		}

		// untracked / ignored：单字段
		if (record.startsWith("?? ") || record.startsWith("! ")) {
			const pathText = record.slice(3);
			i += 1;
			if (!pathText) continue;
			const statusName: WorktreeFileStatus = "untracked";
			const fileChangeId = derivePlanFileChangeId(sourceSnapshotId, statusName, pathText);
			if (seen.has(fileChangeId)) continue;
			seen.add(fileChangeId);
			files.push({ fileChangeId, status: statusName });
			continue;
		}

		if (record.length < 3 || record[2] !== " ") {
			warnings.push(`unparsed status record: ${record.slice(0, 80)}`);
			i += 1;
			continue;
		}
		const xy = record.slice(0, 2);
		const pathText = record.slice(3);
		const isRenameOrCopy = xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C";
		let oldPath: string | undefined;
		if (isRenameOrCopy) {
			// 下一 NUL 字段为原始路径；缺失时仍前进一格避免死循环
			const next = parts[i + 1];
			if (
				typeof next === "string" &&
				next.length > 0 &&
				!/^[ MADRCU?!]{2} /.test(next) &&
				!next.startsWith("?? ") &&
				!next.startsWith("! ")
			) {
				oldPath = next;
				i += 2;
			} else {
				i += 1;
				warnings.push(`rename/copy missing original path for ${pathText.slice(0, 80)}`);
			}
		} else {
			i += 1;
		}
		if (!pathText) continue;

		const mapped = mapPorcelainXyToStatus(xy);
		const fileChangeId = derivePlanFileChangeId(sourceSnapshotId, mapped, pathText, oldPath);
		if (!seen.has(fileChangeId)) {
			seen.add(fileChangeId);
			files.push({ fileChangeId, status: mapped });
		}
		if (mapped === "conflicted") {
			conflicts.push({ path: pathText, kind: conflictKindFromXy(xy) });
		}
	}

	files.sort((a, b) => a.fileChangeId.localeCompare(b.fileChangeId));
	conflicts.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));

	return {
		files,
		conflicts,
		warnings,
		dirty: files.length > 0,
	};
}

function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function realPathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class WorktreeLifecycleService {
	readonly stateDir: string;
	readonly limits: WorktreeLifecycleLimits;
	/**
	 * Managed environment 身份（≠ rpc runtimeId）。
	 * 未 pin：reload adopt 磁盘；空盘用构造时生成的稳定 env_*。
	 * 已 pin：保持构造值，assertEnvironment 做跨环境拒绝。
	 */
	environmentId: string;
	/** 构造时是否显式传入 environmentId（strict pin）。 */
	private readonly environmentPinned: boolean;
	private readonly emitEvent: WorktreeEventEmitter;
	private readonly now: () => Date;
	private readonly idFactory: () => string;
	private readonly setupPort: WorktreeSetupPort | null;
	private readonly applyPort: WorktreeApplyPort | null;
	private readonly worktreesRoot: string;

	private env: EnvironmentIndex;
	private journal: JournalEntry[] = [];
	private journalSeq = 0;
	private loaded = false;
	private loadPromise: Promise<void> | null = null;
	private recoveryReady = false;
	/** setup/apply outcome_unknown 在重启后无法安全终态时降级，禁止盲重试。 */
	private recoveryDegraded = false;
	private unresolvedUnknownOps: Array<{
		operationId: string;
		kind: WorktreeOperationKind;
		worktreeId: string;
	}> = [];

	constructor(options: WorktreeLifecycleServiceOptions) {
		this.stateDir = resolve(options.stateDir);
		const pinned = options.environmentId?.trim();
		this.environmentPinned = Boolean(pinned);
		// 未 pin：先生成稳定 env_*；reload 若发现磁盘 ID 再 adopt。
		// 已 pin：严格使用调用方身份（测试/多环境隔离）。
		this.environmentId = pinned && pinned.length > 0 ? pinned : `env_${randomUUID()}`;
		this.limits = {
			...WORKTREE_LIFECYCLE_V1_LIMITS,
			...options.limits,
			strategies: options.limits?.strategies
				? Object.freeze([...options.limits.strategies] as WorktreeApplyStrategy[])
				: WORKTREE_LIFECYCLE_V1_LIMITS.strategies,
		};
		this.emitEvent = options.emitEvent ?? options.emit ?? (() => {});
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? defaultId;
		this.setupPort = options.setupPort ?? null;
		this.applyPort = options.applyPort ?? null;
		this.worktreesRoot = resolve(options.worktreesRoot ?? join(this.stateDir, "worktrees"));
		this.env = {
			version: 1,
			environmentId: this.environmentId,
			worktrees: {},
			idempotencyIndex: {},
			plans: {},
		};
	}

	private envPath(): string {
		return join(this.stateDir, "environment.json");
	}
	private journalPath(): string {
		return join(this.stateDir, "journal.jsonl");
	}
	private receiptsDir(): string {
		return join(this.stateDir, "receipts");
	}
	private receiptPath(operationId: string): string {
		return join(this.receiptsDir(), `${operationId}.json`);
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.reloadFromDisk();
		await this.loadPromise;
	}

	/** 公开 reload：重启 / 对账测试。 */
	async reloadFromDisk(): Promise<void> {
		await ensureDir(this.stateDir);
		await ensureDir(this.receiptsDir());
		await ensureDir(this.worktreesRoot);
		const env = await readJsonIfExists<EnvironmentIndex>(this.envPath());
		if (env && env.version === 1) {
			const diskId =
				typeof env.environmentId === "string" && env.environmentId.trim().length > 0
					? env.environmentId.trim()
					: undefined;
			if (!this.environmentPinned) {
				// 未 pin：adopt 既有 durable ID（兼容历史落盘的 rt_* / env_*）
				if (diskId) this.environmentId = diskId;
			}
			// 已 pin：保持构造 pin；磁盘记录仍加载，assertEnvironment 拒绝跨环境
			this.env = {
				version: 1,
				// 索引上保留磁盘 environmentId（未 pin 时已与 this.environmentId 对齐）
				environmentId: diskId ?? this.environmentId,
				worktrees: env.worktrees ?? {},
				idempotencyIndex: env.idempotencyIndex ?? {},
				plans: env.plans ?? {},
			};
			if (!this.environmentPinned) {
				this.env.environmentId = this.environmentId;
			}
		} else {
			// 空盘：使用构造时 pin 或生成的稳定 env_*，首次 persist 落盘
			this.env = {
				version: 1,
				environmentId: this.environmentId,
				worktrees: {},
				idempotencyIndex: {},
				plans: {},
			};
		}

		this.journal = [];
		this.journalSeq = 0;
		try {
			const raw = await readFile(this.journalPath(), "utf8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const entry = JSON.parse(trimmed) as JournalEntry;
				this.journal.push(entry);
				if (entry.seq > this.journalSeq) this.journalSeq = entry.seq;
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}

		await this.reconcileUnknownOutcomes();
		this.loaded = true;
		// recovery 完成加载；若仍有 setup/apply unknown 则为 degraded 而非 silent ready-all
		this.recoveryReady = true;
		this.loadPromise = null;
	}

	private async persistEnv(): Promise<void> {
		await ensureDir(this.stateDir);
		await atomicWriteJson(this.envPath(), this.env);
	}

	private async appendJournal(entry: Omit<JournalEntry, "seq" | "at">): Promise<JournalEntry> {
		await ensureDir(this.stateDir);
		const full: JournalEntry = {
			seq: ++this.journalSeq,
			at: this.now().toISOString(),
			...entry,
		};
		this.journal.push(full);
		await writeFile(this.journalPath(), `${JSON.stringify(full)}\n`, { flag: "a" });
		return full;
	}

	private async writeReceipt(receipt: WorktreeOperationReceipt): Promise<void> {
		await ensureDir(this.receiptsDir());
		await atomicWriteJson(this.receiptPath(receipt.operationId), receipt);
	}

	private async readReceipt(operationId: string): Promise<WorktreeOperationReceipt | undefined> {
		return readJsonIfExists<WorktreeOperationReceipt>(this.receiptPath(operationId));
	}

	private async reconcileUnknownOutcomes(): Promise<void> {
		let changed = false;
		this.unresolvedUnknownOps = [];
		this.recoveryDegraded = false;

		for (const [, opId] of Object.entries(this.env.idempotencyIndex)) {
			const receipt = await this.readReceipt(opId);
			if (receipt?.outcome !== "outcome_unknown") continue;
			const existing = this.env.worktrees[receipt.worktreeId];

			if (receipt.kind === "create") {
				if (!existing) continue;
				if (existing.state !== "creating" && existing.state !== "failed") {
					receipt.outcome = "completed";
					receipt.result = this.toPublic(existing);
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else if (existing.state === "failed") {
					receipt.outcome = "failed";
					receipt.error = {
						code: "INTERNAL",
						message: existing.failure?.message ?? "create failed",
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				}
				continue;
			}

			if (receipt.kind === "archive") {
				if (!existing) continue;
				if (existing.state === "archived") {
					receipt.outcome = "completed";
					receipt.result = this.toPublic(existing);
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else if (existing.state === "failed" && existing.lastOperationId === receipt.operationId) {
					receipt.outcome = "failed";
					receipt.error = {
						code: coerceWorktreeErrorCode(existing.failure?.code),
						message: existing.failure?.message ?? "archive failed",
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else if (existing.state === "archiving") {
					// 重启时仍 archiving：无法安全判定，保持 unknown + degraded
					this.unresolvedUnknownOps.push({
						operationId: receipt.operationId,
						kind: receipt.kind,
						worktreeId: receipt.worktreeId,
					});
				}
				continue;
			}

			if (receipt.kind === "setup.start") {
				if (
					existing &&
					existing.lastOperationId === receipt.operationId &&
					existing.setup?.status &&
					existing.setup.status !== "pending"
				) {
					// 端口已回报 status 并落盘 setup 字段：可安全 completed
					receipt.outcome = "completed";
					receipt.result = {
						worktreeId: existing.worktreeId,
						operationId: receipt.operationId,
						setup: {
							actionId: existing.setup.actionId ?? existing.setupActionId ?? "",
							status: existing.setup.status,
							...(existing.setup.processId ? { processId: existing.setup.processId } : {}),
							...(typeof existing.setup.processRevision === "number"
								? { processRevision: existing.setup.processRevision }
								: {}),
						},
						revision: existing.revision,
						replayed: true,
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else {
					// 无证据完成/失败：保持 unknown，禁止盲重试；标记 degraded
					this.unresolvedUnknownOps.push({
						operationId: receipt.operationId,
						kind: receipt.kind,
						worktreeId: receipt.worktreeId,
					});
				}
				continue;
			}

			if (receipt.kind === "setup.cancel") {
				if (
					existing &&
					existing.lastOperationId === receipt.operationId &&
					existing.setup?.status === "cancelled"
				) {
					receipt.outcome = "completed";
					receipt.result = {
						worktreeId: existing.worktreeId,
						operationId: receipt.operationId,
						cancelled: true,
						status: "cancelled",
						...(existing.setup.processId ? { processId: existing.setup.processId } : {}),
						revision: existing.revision,
						replayed: true,
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else {
					this.unresolvedUnknownOps.push({
						operationId: receipt.operationId,
						kind: receipt.kind,
						worktreeId: receipt.worktreeId,
					});
				}
				continue;
			}

			if (receipt.kind === "apply") {
				if (!existing) {
					this.unresolvedUnknownOps.push({
						operationId: receipt.operationId,
						kind: receipt.kind,
						worktreeId: receipt.worktreeId,
					});
					continue;
				}
				if (existing.lastOperationId === receipt.operationId && existing.state === "conflicted") {
					receipt.outcome = "failed";
					receipt.error = {
						code: "CONFLICT",
						message: existing.failure?.message ?? "apply conflicted",
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else if (existing.lastOperationId === receipt.operationId && existing.state === "failed") {
					receipt.outcome = "failed";
					receipt.error = {
						code: coerceWorktreeErrorCode(existing.failure?.code),
						message: existing.failure?.message ?? "apply failed",
					};
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else if (
					existing.lastOperationId === receipt.operationId &&
					(existing.state === "ready" || existing.state === "dirty")
				) {
					// 已离开 applying 且无 failure：视为 completed（状态权威）
					receipt.outcome = "completed";
					receipt.result = this.toPublic(existing);
					receipt.updatedAt = this.now().toISOString();
					await this.writeReceipt(receipt);
					changed = true;
				} else {
					// 仍 applying 或证据不足：保持 unknown
					this.unresolvedUnknownOps.push({
						operationId: receipt.operationId,
						kind: receipt.kind,
						worktreeId: receipt.worktreeId,
					});
				}
				continue;
			}

			// 其他 kind：不静默清除
			this.unresolvedUnknownOps.push({
				operationId: receipt.operationId,
				kind: receipt.kind,
				worktreeId: receipt.worktreeId,
			});
		}

		if (this.unresolvedUnknownOps.length > 0) {
			this.recoveryDegraded = true;
		}
		if (changed) await this.persistEnv();
	}

	private toPublic(rec: InternalWorktreeRecord): ManagedWorktree {
		const out: ManagedWorktree = {
			worktreeId: rec.worktreeId,
			environmentId: rec.environmentId,
			repoId: rec.repoId,
			pathRef: rec.pathRef,
			displayPath: rec.displayPath,
			baseOid: rec.baseOid,
			headOid: rec.headOid,
			state: rec.state,
			dirty: rec.dirty,
			revision: rec.revision,
		};
		if (rec.branch) out.branch = rec.branch;
		if (rec.owningSessionId) out.owningSessionId = rec.owningSessionId;
		if (rec.setup) out.setup = { ...rec.setup };
		if (rec.failure)
			out.failure = { ...rec.failure, details: rec.failure.details ? { ...rec.failure.details } : undefined };
		return out;
	}

	private emit(
		method: WorktreeEventMethod,
		rec: InternalWorktreeRecord,
		operationId: string,
		reason: string,
		opts?: { terminal?: boolean; previousState?: ManagedWorktreeState; includeWorktree?: boolean },
	): void {
		const params: WorktreeEventEnvelope["params"] = {
			worktreeId: rec.worktreeId,
			revision: rec.revision,
			operationId,
			state: rec.state,
			reason,
			timestamp: this.now().toISOString(),
		};
		if (opts?.terminal) params.terminal = true;
		if (opts?.previousState) params.previousState = opts.previousState;
		if (opts?.includeWorktree !== false) params.worktree = this.toPublic(rec);
		this.emitEvent({ method, params });
	}

	private markUnresolvedUnknown(operationId: string, kind: WorktreeOperationKind, worktreeId: string): void {
		if (!this.unresolvedUnknownOps.some(operation => operation.operationId === operationId)) {
			this.unresolvedUnknownOps.push({ operationId, kind, worktreeId });
		}
		this.recoveryDegraded = true;
	}

	private activeNonArchivedCount(): number {
		return Object.values(this.env.worktrees).filter(w => w.state !== "archived").length;
	}

	private assertEnvironment(rec: InternalWorktreeRecord): void {
		if (rec.environmentId !== this.environmentId) {
			throw new WorktreeError("PRECONDITION_FAILED", "worktree belongs to a different environment", {
				worktreeId: rec.worktreeId,
				recordEnvironmentId: rec.environmentId,
				serviceEnvironmentId: this.environmentId,
			});
		}
	}

	private requireWorktree(worktreeId: string): InternalWorktreeRecord {
		if (!worktreeId) throw new WorktreeError("INVALID_PARAMS", "worktreeId is required");
		const rec = this.env.worktrees[worktreeId];
		if (!rec) throw new WorktreeError("NOT_FOUND", `worktree not found: ${worktreeId}`, { worktreeId });
		this.assertEnvironment(rec);
		return rec;
	}

	private resolveTargetPath(worktreeId: string): string {
		const target = resolve(join(this.worktreesRoot, worktreeId));
		if (!isPathInside(this.worktreesRoot, target)) {
			throw new WorktreeError("INVALID_PARAMS", "worktree path escapes managed root", {
				worktreeId,
				worktreesRoot: this.worktreesRoot,
				target,
			});
		}
		return target;
	}

	/** 创建后与重启后：拒绝 symlink escape managed root。 */
	private recheckSymlinkBoundary(displayPath: string, worktreeId: string): void {
		const rootReal = realPathOrSelf(this.worktreesRoot);
		const pathReal = realPathOrSelf(displayPath);
		if (!isPathInside(rootReal, pathReal)) {
			throw new WorktreeError("PRECONDITION_FAILED", "worktree path escapes managed root after resolve", {
				worktreeId,
				displayPath,
				resolved: pathReal,
				worktreesRoot: rootReal,
			});
		}
		// 若 displayPath 自身是 symlink，目标也必须落在 root 内
		try {
			const st = lstatSync(displayPath);
			if (st.isSymbolicLink()) {
				const linkTarget = realPathOrSelf(displayPath);
				if (!isPathInside(rootReal, linkTarget)) {
					throw new WorktreeError("PRECONDITION_FAILED", "worktree symlink target escapes managed root", {
						worktreeId,
						displayPath,
						linkTarget,
						worktreesRoot: rootReal,
					});
				}
			}
		} catch (err) {
			if (err instanceof WorktreeError) throw err;
			// 路径不存在时由调用方处理
		}
	}

	private async replayMutation(idempotencyKey: string, paramsHash: string): Promise<WorktreeMutationResult | null> {
		const existingOpId = this.env.idempotencyIndex[idempotencyKey];
		if (!existingOpId) return null;
		const receipt = await this.readReceipt(existingOpId);
		if (!receipt) {
			throw new WorktreeError("OUTCOME_UNKNOWN", "idempotent operation receipt missing", {
				idempotencyKey,
				operationId: existingOpId,
			});
		}
		if (receipt.paramsHash !== paramsHash) {
			throw new WorktreeError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different params", {
				idempotencyKey,
				operationId: existingOpId,
			});
		}
		if (receipt.outcome === "outcome_unknown") {
			const wt = this.env.worktrees[receipt.worktreeId];
			if (receipt.kind === "create" && wt && wt.state !== "creating" && wt.state !== "failed") {
				receipt.outcome = "completed";
				receipt.result = this.toPublic(wt);
				receipt.updatedAt = this.now().toISOString();
				await this.writeReceipt(receipt);
				return {
					worktree: this.toPublic(wt),
					operationId: receipt.operationId,
					replayed: true,
				};
			}
			if (receipt.kind === "archive" && wt && wt.state === "archived") {
				receipt.outcome = "completed";
				receipt.result = this.toPublic(wt);
				receipt.updatedAt = this.now().toISOString();
				await this.writeReceipt(receipt);
				return {
					worktree: this.toPublic(wt),
					operationId: receipt.operationId,
					replayed: true,
				};
			}
			throw new WorktreeError(
				"OUTCOME_UNKNOWN",
				"previous operation outcome is unknown; reconcile via get/list before retry",
				{ idempotencyKey, operationId: receipt.operationId, worktreeId: receipt.worktreeId },
			);
		}
		if (receipt.outcome === "failed") {
			throw new WorktreeError(
				receipt.error?.code ?? "INTERNAL",
				receipt.error?.message ?? "previous operation failed",
				{ ...(receipt.error?.details ?? {}), operationId: receipt.operationId, replayed: true },
			);
		}
		const live = this.env.worktrees[receipt.worktreeId];
		const result = live != null ? this.toPublic(live) : (receipt.result as ManagedWorktree | undefined);
		if (!result) {
			throw new WorktreeError("OUTCOME_UNKNOWN", "completed receipt missing worktree result", {
				operationId: receipt.operationId,
			});
		}
		return {
			worktree: result,
			operationId: receipt.operationId,
			replayed: true,
		};
	}

	// ── create ───────────────────────────────────────────────────────────────

	async create(params: CreateManagedWorktreeParams): Promise<WorktreeMutationResult> {
		await this.ensureLoaded();

		if (!params?.meta?.idempotencyKey || typeof params.meta.idempotencyKey !== "string") {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}
		if (!params.projectCwd || typeof params.projectCwd !== "string") {
			throw new WorktreeError("INVALID_PARAMS", "projectCwd is required");
		}
		if (!params.repoId || typeof params.repoId !== "string") {
			throw new WorktreeError("INVALID_PARAMS", "repoId is required");
		}
		if (!params.base || (params.base.kind !== "branch" && params.base.kind !== "commit")) {
			throw new WorktreeError("INVALID_PARAMS", "base.kind must be branch|commit");
		}
		if (!params.base.value || !params.base.resolvedOid) {
			throw new WorktreeError("INVALID_PARAMS", "base.value and base.resolvedOid are required");
		}
		if (params.purpose !== "session") {
			throw new WorktreeError("INVALID_PARAMS", "purpose must be session");
		}

		const repositoryPath = canonicalizeAbsolutePath(params.projectCwd);
		if (!existsSync(repositoryPath)) {
			throw new WorktreeError("INVALID_PARAMS", "projectCwd does not exist", { projectCwd: repositoryPath });
		}

		const idempotencyKey = params.meta.idempotencyKey;
		const paramsHash = hashParams({
			projectCwd: repositoryPath,
			repoId: params.repoId,
			base: {
				kind: params.base.kind,
				value: params.base.value,
				resolvedOid: params.base.resolvedOid,
			},
			branchName: params.branchName ?? null,
			purpose: params.purpose,
			setupActionId: params.setupActionId ?? null,
			environmentId: this.environmentId,
		});

		const replay = await this.replayMutation(idempotencyKey, paramsHash);
		if (replay) return replay;

		if (this.activeNonArchivedCount() >= this.limits.maxWorktrees) {
			throw new WorktreeError("PRECONDITION_FAILED", "max worktrees limit reached", {
				maxWorktrees: this.limits.maxWorktrees,
			});
		}

		const operationId = this.idFactory();
		const worktreeId = this.idFactory();
		const displayPath = this.resolveTargetPath(worktreeId);
		const pathRef = buildWorktreePathRef(this.environmentId, displayPath);
		const ts = this.now().toISOString();
		const initialState: ManagedWorktreeState = params.setupActionId ? "setup_pending" : "ready";

		const receipt: WorktreeOperationReceipt = {
			operationId,
			worktreeId,
			kind: "create",
			idempotencyKey,
			paramsHash,
			outcome: "outcome_unknown",
			createdAt: ts,
			updatedAt: ts,
		};
		this.env.idempotencyIndex[idempotencyKey] = operationId;

		const creating: InternalWorktreeRecord = {
			worktreeId,
			environmentId: this.environmentId,
			repoId: params.repoId,
			repositoryPath,
			displayPath,
			pathRef,
			baseOid: params.base.resolvedOid,
			headOid: params.base.resolvedOid,
			branch: params.branchName,
			state: "creating",
			dirty: false,
			revision: 1,
			setupActionId: params.setupActionId,
			setup: params.setupActionId ? { actionId: params.setupActionId, status: "pending" } : undefined,
			activeSessionCount: 0,
			createdAt: ts,
			updatedAt: ts,
			lastOperationId: operationId,
		};
		this.env.worktrees[worktreeId] = creating;
		await this.writeReceipt(receipt);
		await this.persistEnv();
		await this.appendJournal({
			operationId,
			worktreeId,
			kind: "create",
			outcome: "outcome_unknown",
			note: "create started",
		});
		this.emit("worktree.state.changed", creating, operationId, "create.started", {
			previousState: undefined,
			includeWorktree: true,
		});

		let sideEffectCompleted = false;
		try {
			await ensureDir(this.worktreesRoot);
			// 真实 git worktree add：结构化 argv，无 shell。
			const addArgv: string[] = ["worktree", "add"];
			if (params.branchName) {
				// 基于 base.resolvedOid 新建分支并 checkout
				addArgv.push("-b", params.branchName, displayPath, params.base.resolvedOid);
			} else if (params.base.kind === "commit") {
				addArgv.push("--detach", displayPath, params.base.resolvedOid);
			} else {
				// branch base：尽量 checkout 同名分支；若本地无则 detach 到 resolvedOid
				addArgv.push(displayPath, params.base.value);
			}

			let result = await spawnGit(addArgv, repositoryPath);
			if (result.exitCode !== 0 && !params.branchName && params.base.kind === "branch") {
				// 回退：detach 到已解析 oid
				result = await spawnGit(
					["worktree", "add", "--detach", displayPath, params.base.resolvedOid],
					repositoryPath,
				);
			}
			if (result.exitCode !== 0) {
				throw new Error(result.stderr || result.stdout || `git worktree add failed (${result.exitCode})`);
			}

			this.recheckSymlinkBoundary(displayPath, worktreeId);

			const head = await spawnGit(["rev-parse", "HEAD"], displayPath);
			const headOid = head.exitCode === 0 && head.stdout ? head.stdout : params.base.resolvedOid;
			sideEffectCompleted = true;

			const prev = creating.state;
			creating.state = initialState;
			creating.headOid = headOid;
			creating.revision += 1;
			creating.updatedAt = this.now().toISOString();
			creating.lastOperationId = operationId;
			this.env.worktrees[worktreeId] = creating;

			receipt.outcome = "completed";
			receipt.result = this.toPublic(creating);
			receipt.updatedAt = creating.updatedAt;
			// env 权威态先落盘，再写 terminal receipt；crash 后 receipt 仍 unknown 可 reconcile
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId,
				kind: "create",
				outcome: "completed",
				note: "create completed",
			});
			this.emit("worktree.created", creating, operationId, "create.completed", {
				terminal: true,
				previousState: prev,
			});

			return {
				worktree: this.toPublic(creating),
				operationId,
				replayed: false,
			};
		} catch (err) {
			if (sideEffectCompleted) throw err;
			const message = err instanceof Error ? err.message : String(err);
			const prev = creating.state;
			creating.state = "failed";
			creating.revision += 1;
			creating.updatedAt = this.now().toISOString();
			creating.failure = { code: "INTERNAL", message };
			creating.lastOperationId = operationId;
			this.env.worktrees[worktreeId] = creating;

			// 尽力清理半成品路径
			try {
				if (existsSync(displayPath)) {
					await spawnGit(["worktree", "remove", "--force", displayPath], repositoryPath);
					await rm(displayPath, { recursive: true, force: true });
				}
			} catch {
				// ignore cleanup errors
			}

			receipt.outcome = "failed";
			receipt.error = { code: "INTERNAL", message };
			receipt.updatedAt = creating.updatedAt;
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId,
				kind: "create",
				outcome: "failed",
				note: message,
			});
			this.emit("worktree.state.changed", creating, operationId, "create.failed", {
				terminal: true,
				previousState: prev,
			});
			throw new WorktreeError("INTERNAL", message, { operationId, worktreeId });
		}
	}

	// ── get / list ───────────────────────────────────────────────────────────

	async get(worktreeId: string): Promise<ManagedWorktree> {
		await this.ensureLoaded();
		const rec = this.requireWorktree(worktreeId);

		if (rec.state === "creating") {
			if (existsSync(rec.displayPath)) {
				this.recheckSymlinkBoundary(rec.displayPath, rec.worktreeId);
				const prev = rec.state;
				const next: ManagedWorktreeState = rec.setupActionId ? "setup_pending" : "ready";
				rec.state = next;
				rec.revision += 1;
				rec.updatedAt = this.now().toISOString();
				this.env.worktrees[worktreeId] = rec;
				await this.persistEnv();
				const opId = rec.lastOperationId ?? "reconcile";
				const receipt = rec.lastOperationId ? await this.readReceipt(rec.lastOperationId) : undefined;
				if (receipt && receipt.outcome === "outcome_unknown") {
					receipt.outcome = "completed";
					receipt.result = this.toPublic(rec);
					receipt.updatedAt = rec.updatedAt;
					await this.writeReceipt(receipt);
				}
				this.emit("worktree.state.changed", rec, opId, "reconcile.ready", {
					terminal: true,
					previousState: prev,
				});
			}
		}

		return this.toPublic(rec);
	}

	async list(filter?: WorktreeListFilter): Promise<ManagedWorktree[]> {
		await this.ensureLoaded();
		let items = Object.values(this.env.worktrees).map(r => this.toPublic(r));

		if (filter?.environmentId && filter.environmentId !== this.environmentId) {
			return [];
		}
		// 默认仅本 environment
		items = items.filter(w => w.environmentId === this.environmentId);

		const stateFilter =
			filter?.states ??
			(filter?.state != null ? (Array.isArray(filter.state) ? filter.state : [filter.state]) : undefined);
		if (stateFilter && stateFilter.length > 0) {
			const set = new Set(stateFilter);
			items = items.filter(w => set.has(w.state));
		}
		if (filter?.repoId) {
			items = items.filter(w => w.repoId === filter.repoId);
		}
		items.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId));
		// 有界 list
		if (items.length > this.limits.maxWorktrees) {
			items = items.slice(0, this.limits.maxWorktrees);
		}
		return items;
	}

	// ── setup ────────────────────────────────────────────────────────────────

	async setupStart(params: WorktreeSetupStartParams): Promise<{
		worktreeId: string;
		operationId: string;
		setup: { actionId: string; status: string; processId?: string; processRevision?: number };
		revision: number;
		replayed?: boolean;
	}> {
		await this.ensureLoaded();
		if (!params?.meta?.idempotencyKey) {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}
		const rec = this.requireWorktree(params.worktreeId);
		if (rec.state === "archived" || rec.state === "failed") {
			throw new WorktreeError("PRECONDITION_FAILED", `worktree state ${rec.state} cannot start setup`, {
				worktreeId: rec.worktreeId,
				state: rec.state,
			});
		}

		const setupActionId = params.setupActionId ?? rec.setupActionId ?? rec.setup?.actionId;
		if (!setupActionId) {
			throw new WorktreeError("INVALID_PARAMS", "setupActionId is required (create-time or setup.start override)", {
				worktreeId: params.worktreeId,
			});
		}

		if (!this.setupPort?.ready) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "setup.start requires an injected ready setup port", {
				feature: "setup",
				available: false,
				worktreeId: params.worktreeId,
			});
		}

		const idempotencyKey = params.meta.idempotencyKey;
		const paramsHash = hashParams({
			worktreeId: params.worktreeId,
			setupActionId,
		});
		const existingOpId = this.env.idempotencyIndex[idempotencyKey];
		if (existingOpId) {
			const existingReceipt = await this.readReceipt(existingOpId);
			if (existingReceipt) {
				if (existingReceipt.paramsHash !== paramsHash) {
					throw new WorktreeError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different params", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
				if (existingReceipt.outcome === "completed" && existingReceipt.result) {
					const stored = existingReceipt.result as {
						worktreeId: string;
						operationId: string;
						setup: {
							actionId: string;
							status: string;
							processId?: string;
							processRevision?: number;
						};
						revision: number;
						replayed?: boolean;
					};
					return { ...stored, replayed: true };
				}
				if (existingReceipt.outcome === "failed" && existingReceipt.error) {
					throw new WorktreeError(existingReceipt.error.code, existingReceipt.error.message, {
						...(existingReceipt.error.details ?? {}),
						operationId: existingOpId,
						replayed: true,
					});
				}
				if (existingReceipt.outcome === "outcome_unknown") {
					throw new WorktreeError("OUTCOME_UNKNOWN", "previous setup.start outcome is unknown", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
			}
		}

		const operationId = this.idFactory();
		const ts = this.now().toISOString();
		const receipt: WorktreeOperationReceipt = {
			operationId,
			worktreeId: rec.worktreeId,
			kind: "setup.start",
			idempotencyKey,
			paramsHash,
			outcome: "outcome_unknown",
			createdAt: ts,
			updatedAt: ts,
		};
		this.env.idempotencyIndex[idempotencyKey] = operationId;
		await this.writeReceipt(receipt);
		await this.persistEnv();
		await this.appendJournal({
			operationId,
			worktreeId: rec.worktreeId,
			kind: "setup.start",
			outcome: "outcome_unknown",
			note: "setup.start started",
		});
		let sideEffectCompleted = false;

		try {
			const startResult = await this.setupPort.start({
				worktreeId: rec.worktreeId,
				environmentId: rec.environmentId,
				pathRef: rec.pathRef,
				displayPath: rec.displayPath,
				setupActionId,
				operationId,
				idempotencyKey,
			});
			sideEffectCompleted = true;

			const prev = rec.state;
			rec.setup = {
				actionId: setupActionId,
				status: startResult.status,
				...(startResult.processId ? { processId: startResult.processId } : {}),
				...(typeof startResult.processRevision === "number"
					? { processRevision: startResult.processRevision }
					: {}),
			};
			rec.setupActionId = setupActionId;
			if (rec.state === "setup_pending" || rec.state === "ready") {
				// 保持 setup_pending 或进入 in_use 语义由 host 决定；此处标 setup 运行中
				rec.state = "setup_pending";
			}
			rec.revision += 1;
			rec.updatedAt = this.now().toISOString();
			rec.lastOperationId = operationId;
			this.env.worktrees[rec.worktreeId] = rec;

			const result = {
				worktreeId: rec.worktreeId,
				operationId,
				setup: {
					actionId: setupActionId,
					status: startResult.status,
					...(startResult.processId ? { processId: startResult.processId } : {}),
					...(typeof startResult.processRevision === "number"
						? { processRevision: startResult.processRevision }
						: {}),
				},
				revision: rec.revision,
				replayed: false as boolean,
			};
			receipt.outcome = "completed";
			receipt.result = result;
			receipt.updatedAt = rec.updatedAt;
			// env（含 process binding）先于 completed receipt
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "setup.start",
				outcome: "completed",
				note: "setup.start completed",
			});
			this.emit("worktree.setup.started", rec, operationId, "setup.started", { previousState: prev });
			return result;
		} catch (err) {
			if (sideEffectCompleted) throw err;
			if (err instanceof WorktreeError && err.code === "OUTCOME_UNKNOWN") {
				this.markUnresolvedUnknown(operationId, "setup.start", rec.worktreeId);
				throw new WorktreeError(err.code, err.message, {
					...(err.details ?? {}),
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof WorktreeError ? err.code : ("INTERNAL" as WorktreeErrorCode);
			const details = err instanceof WorktreeError ? err.details : undefined;
			receipt.outcome = "failed";
			receipt.error = {
				code,
				message,
				...(details ? { details } : {}),
			};
			receipt.updatedAt = this.now().toISOString();
			// env 先于 failed receipt；crash 后 failed 可原样 replay
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "setup.start",
				outcome: "failed",
				note: message,
			});
			if (err instanceof WorktreeError) {
				throw new WorktreeError(err.code, err.message, {
					...(err.details ?? {}),
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			throw new WorktreeError("INTERNAL", message, {
				operationId,
				worktreeId: rec.worktreeId,
			});
		}
	}

	async setupCancel(params: WorktreeSetupCancelParams): Promise<{
		worktreeId: string;
		operationId: string;
		cancelled: boolean;
		status: string;
		processId?: string;
		revision: number;
		replayed?: boolean;
	}> {
		await this.ensureLoaded();
		if (!params?.meta?.idempotencyKey) {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}
		const rec = this.requireWorktree(params.worktreeId);

		if (!this.setupPort?.ready) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "setup.cancel requires an injected ready setup port", {
				feature: "setup",
				available: false,
				worktreeId: params.worktreeId,
			});
		}

		const idempotencyKey = params.meta.idempotencyKey;
		// canonical params：worktreeId + environmentId（cancel 无其它语义字段）
		const paramsHash = hashParams({
			worktreeId: params.worktreeId,
			environmentId: this.environmentId,
		});

		const existingOpId = this.env.idempotencyIndex[idempotencyKey];
		if (existingOpId) {
			const existing = await this.readReceipt(existingOpId);
			if (existing) {
				if (existing.paramsHash !== paramsHash) {
					throw new WorktreeError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different params", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
				if (existing.outcome === "completed" && existing.result) {
					const stored = existing.result as {
						worktreeId: string;
						operationId: string;
						cancelled: boolean;
						status: string;
						processId?: string;
						revision: number;
						replayed?: boolean;
					};
					return { ...stored, replayed: true };
				}
				if (existing.outcome === "failed" && existing.error) {
					throw new WorktreeError(existing.error.code, existing.error.message, {
						...(existing.error.details ?? {}),
						operationId: existingOpId,
						replayed: true,
					});
				}
				if (existing.outcome === "outcome_unknown") {
					// 禁止对外部 cancel mutation 盲重试
					throw new WorktreeError("OUTCOME_UNKNOWN", "previous setup.cancel outcome is unknown", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
			}
		}

		const operationId = this.idFactory();
		const ts = this.now().toISOString();
		const receipt: WorktreeOperationReceipt = {
			operationId,
			worktreeId: rec.worktreeId,
			kind: "setup.cancel",
			idempotencyKey,
			paramsHash,
			outcome: "outcome_unknown",
			createdAt: ts,
			updatedAt: ts,
		};
		// 外部 mutation 前先 durable 写 outcome_unknown
		this.env.idempotencyIndex[idempotencyKey] = operationId;
		await this.writeReceipt(receipt);
		await this.persistEnv();
		await this.appendJournal({
			operationId,
			worktreeId: rec.worktreeId,
			kind: "setup.cancel",
			outcome: "outcome_unknown",
			note: "setup.cancel started",
		});

		let sideEffectCompleted = false;
		try {
			const cancelResult = await this.setupPort.cancel({
				worktreeId: rec.worktreeId,
				operationId,
				idempotencyKey,
				// durable binding：restart 后 setupHost 内存丢失，必须从 rec.setup 恢复
				...(rec.setup?.processId ? { processId: rec.setup.processId } : {}),
				...(typeof rec.setup?.processRevision === "number" ? { expectedRevision: rec.setup.processRevision } : {}),
			});
			sideEffectCompleted = true;

			const prev = rec.state;
			const previousProcessId = rec.setup?.processId;
			if (rec.setup) {
				// cancel 成功后清除 process 绑定，避免对已终态进程二次 stop
				const { processId: _clearedId, processRevision: _clearedRev, ...rest } = rec.setup;
				rec.setup = { ...rest, status: cancelResult.status };
			} else {
				rec.setup = { status: cancelResult.status };
			}
			rec.revision += 1;
			rec.updatedAt = this.now().toISOString();
			rec.lastOperationId = operationId;
			this.env.worktrees[rec.worktreeId] = rec;

			const result = {
				worktreeId: rec.worktreeId,
				operationId,
				cancelled: cancelResult.cancelled,
				status: cancelResult.status,
				...(previousProcessId ? { processId: previousProcessId } : {}),
				revision: rec.revision,
				replayed: false as boolean,
			};
			receipt.outcome = "completed";
			receipt.result = result;
			receipt.updatedAt = rec.updatedAt;
			// env（已清 process binding）先于 completed receipt
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "setup.cancel",
				outcome: "completed",
				note: "setup.cancel completed",
			});
			this.emit("worktree.state.changed", rec, operationId, "setup.cancelled", {
				previousState: prev,
			});
			return result;
		} catch (err) {
			if (sideEffectCompleted) throw err;
			if (err instanceof WorktreeError && err.code === "OUTCOME_UNKNOWN") {
				this.markUnresolvedUnknown(operationId, "setup.cancel", rec.worktreeId);
				throw new WorktreeError(err.code, err.message, {
					...(err.details ?? {}),
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof WorktreeError ? err.code : ("INTERNAL" as WorktreeErrorCode);
			const details = err instanceof WorktreeError ? err.details : undefined;
			receipt.outcome = "failed";
			receipt.error = {
				code,
				message,
				...(details ? { details } : {}),
			};
			receipt.updatedAt = this.now().toISOString();
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "setup.cancel",
				outcome: "failed",
				note: message,
			});
			if (err instanceof WorktreeError) {
				throw new WorktreeError(err.code, err.message, {
					...(err.details ?? {}),
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			throw new WorktreeError("INTERNAL", message, {
				operationId,
				worktreeId: rec.worktreeId,
			});
		}
	}

	// ── apply.prepare / apply ────────────────────────────────────────────────

	/** 冻结签名：整包 WorktreeApplyPrepareParams。 */
	async prepare(params: WorktreeApplyPrepareParams): Promise<WorktreeApplyPlan> {
		return this.applyPrepare(params);
	}

	async applyPrepare(params: WorktreeApplyPrepareParams): Promise<WorktreeApplyPlan> {
		await this.ensureLoaded();
		if (!params?.worktreeId) throw new WorktreeError("INVALID_PARAMS", "worktreeId is required");
		if (typeof params.expectedWorktreeRevision !== "number") {
			throw new WorktreeError("INVALID_PARAMS", "expectedWorktreeRevision is required");
		}
		if (!params.expectedTargetSnapshotId) {
			throw new WorktreeError("INVALID_PARAMS", "expectedTargetSnapshotId is required");
		}
		if (params.strategy !== "patch" && params.strategy !== "merge_commit") {
			throw new WorktreeError("INVALID_PARAMS", "strategy must be patch|merge_commit");
		}
		if (!params.meta?.idempotencyKey) {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}

		const rec = this.requireWorktree(params.worktreeId);
		if (rec.state === "archived" || rec.state === "failed" || rec.state === "creating" || rec.state === "archiving") {
			throw new WorktreeError("PRECONDITION_FAILED", `worktree state ${rec.state} cannot prepare apply`, {
				worktreeId: rec.worktreeId,
				state: rec.state,
			});
		}
		if (rec.revision !== params.expectedWorktreeRevision) {
			throw new WorktreeError("CONFLICT", "expectedWorktreeRevision does not match current revision", {
				expectedWorktreeRevision: params.expectedWorktreeRevision,
				currentRevision: rec.revision,
				worktreeId: rec.worktreeId,
			});
		}

		const ts = this.now();
		const planId = this.idFactory();
		// 先校验路径存在，避免 spawn ENOENT 泄漏为未分类型错误
		if (!existsSync(rec.displayPath)) {
			throw new WorktreeError("PRECONDITION_FAILED", "worktree path does not exist for apply.prepare", {
				feature: "apply.prepare",
				worktreeId: rec.worktreeId,
			});
		}
		const liveHead = await spawnGit(["rev-parse", "HEAD"], rec.displayPath);
		// 不得沿用 stale rec.headOid：仅 live HEAD 成功才构造 sourceSnapshotId
		if (liveHead.exitCode !== 0 || !liveHead.stdout) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "unable to resolve live worktree HEAD for apply.prepare", {
				feature: "apply.prepare",
				available: false,
				exitCode: liveHead.exitCode,
				worktreeId: rec.worktreeId,
			});
		}
		rec.headOid = liveHead.stdout;
		const sourceSnapshotId = `wt:${rec.worktreeId}@${rec.headOid}`;
		const inventory = await collectApplyInventory(rec.displayPath, sourceSnapshotId);
		// prepare 是 git 只读：不改 worktree 文件/索引。
		// dirty/conflicted 仅为本地投影，**不** revision++，以保持
		// expectedWorktreeRevision CAS（客户端用 prepare 前 revision 调 apply/archive 仍有效）。
		if (inventory.dirty !== rec.dirty) {
			rec.dirty = inventory.dirty;
			if (inventory.dirty && (rec.state === "ready" || rec.state === "setup_pending")) {
				rec.state = "dirty";
			} else if (!inventory.dirty && rec.state === "dirty") {
				rec.state = "ready";
			}
			rec.updatedAt = ts.toISOString();
			this.env.worktrees[rec.worktreeId] = rec;
		}
		if (inventory.conflicts.length > 0 && rec.state !== "conflicted" && rec.state !== "applying") {
			rec.state = "conflicted";
			rec.updatedAt = ts.toISOString();
			this.env.worktrees[rec.worktreeId] = rec;
		}
		const plan: StoredApplyPlan = {
			planId,
			worktreeId: rec.worktreeId,
			sourceSnapshotId,
			targetRepoId: rec.repoId,
			targetSnapshotId: params.expectedTargetSnapshotId,
			strategy: params.strategy,
			files: inventory.files,
			conflicts: inventory.conflicts,
			warnings: inventory.warnings,
			expiresAt: new Date(ts.getTime() + this.limits.applyPlanTtlMs).toISOString(),
			expectedWorktreeRevision: rec.revision,
		};
		this.env.plans[planId] = plan;
		await this.persistEnv();
		return {
			planId: plan.planId,
			worktreeId: plan.worktreeId,
			sourceSnapshotId: plan.sourceSnapshotId,
			targetRepoId: plan.targetRepoId,
			targetSnapshotId: plan.targetSnapshotId,
			strategy: plan.strategy,
			files: [...plan.files],
			conflicts: [...plan.conflicts],
			warnings: [...plan.warnings],
			expiresAt: plan.expiresAt,
		};
	}

	/** 冻结签名：整包 WorktreeApplyParams（无 top-level worktreeId）。 */
	async apply(params: WorktreeApplyParams): Promise<WorktreeMutationResult> {
		await this.ensureLoaded();
		if (!params?.planId) throw new WorktreeError("INVALID_PARAMS", "planId is required");
		if (typeof params.expectedWorktreeRevision !== "number") {
			throw new WorktreeError("INVALID_PARAMS", "expectedWorktreeRevision is required");
		}
		if (!params.expectedTargetSnapshotId) {
			throw new WorktreeError("INVALID_PARAMS", "expectedTargetSnapshotId is required");
		}
		if (!params.meta?.idempotencyKey) {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}

		const plan = this.env.plans[params.planId];
		if (!plan) {
			throw new WorktreeError("NOT_FOUND", `apply plan not found: ${params.planId}`, {
				planId: params.planId,
			});
		}

		const idempotencyKey = params.meta.idempotencyKey;
		const paramsHash = hashParams({
			planId: params.planId,
			expectedWorktreeRevision: params.expectedWorktreeRevision,
			expectedTargetSnapshotId: params.expectedTargetSnapshotId,
		});
		// outcome_unknown 必须先于 revision CAS：禁止盲重试外部 mutation
		const existingOpId = this.env.idempotencyIndex[idempotencyKey];
		if (existingOpId) {
			const receipt = await this.readReceipt(existingOpId);
			if (receipt) {
				if (receipt.paramsHash !== paramsHash) {
					throw new WorktreeError("IDEMPOTENCY_CONFLICT", "idempotency key reused with different params", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
				if (receipt.outcome === "outcome_unknown") {
					throw new WorktreeError("OUTCOME_UNKNOWN", "previous apply outcome is unknown; do not blind retry", {
						idempotencyKey,
						operationId: existingOpId,
					});
				}
				if (receipt.outcome === "failed" && receipt.error) {
					throw new WorktreeError(receipt.error.code, receipt.error.message, {
						...receipt.error.details,
						operationId: existingOpId,
						replayed: true,
					});
				}
				if (receipt.outcome === "completed") {
					const live = this.env.worktrees[receipt.worktreeId];
					return {
						worktree: live ? this.toPublic(live) : (receipt.result as ManagedWorktree),
						operationId: receipt.operationId,
						replayed: true,
					};
				}
			}
		}

		const rec = this.requireWorktree(plan.worktreeId);

		if (Date.parse(plan.expiresAt) <= this.now().getTime()) {
			throw new WorktreeError("PRECONDITION_FAILED", "apply plan expired", { planId: plan.planId });
		}
		if (params.expectedWorktreeRevision !== plan.expectedWorktreeRevision) {
			throw new WorktreeError("CONFLICT", "expectedWorktreeRevision does not match plan", {
				expected: plan.expectedWorktreeRevision,
				got: params.expectedWorktreeRevision,
			});
		}
		if (params.expectedTargetSnapshotId !== plan.targetSnapshotId) {
			throw new WorktreeError("CONFLICT", "expectedTargetSnapshotId does not match plan", {
				expected: plan.targetSnapshotId,
				got: params.expectedTargetSnapshotId,
			});
		}
		if (rec.revision !== plan.expectedWorktreeRevision) {
			throw new WorktreeError("CONFLICT", "worktree revision changed since prepare", {
				expectedRevision: plan.expectedWorktreeRevision,
				currentRevision: rec.revision,
			});
		}

		if (!this.applyPort?.ready) {
			// 显式能力错误 — 绝不 silent success。
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "apply requires an injected ready apply/git mutation port", {
				feature: "apply",
				available: false,
				worktreeId: rec.worktreeId,
				planId: params.planId,
			});
		}

		const operationId = this.idFactory();
		const ts = this.now().toISOString();
		const receipt: WorktreeOperationReceipt = {
			operationId,
			worktreeId: rec.worktreeId,
			kind: "apply",
			idempotencyKey,
			paramsHash,
			outcome: "outcome_unknown",
			createdAt: ts,
			updatedAt: ts,
		};
		this.env.idempotencyIndex[idempotencyKey] = operationId;
		await this.writeReceipt(receipt);
		await this.persistEnv();
		await this.appendJournal({
			operationId,
			worktreeId: rec.worktreeId,
			kind: "apply",
			outcome: "outcome_unknown",
			note: "apply started",
		});

		const prev = rec.state;
		rec.state = "applying";
		rec.revision += 1;
		rec.updatedAt = this.now().toISOString();
		rec.lastOperationId = operationId;
		this.env.worktrees[rec.worktreeId] = rec;
		await this.persistEnv();
		this.emit("worktree.apply.started", rec, operationId, "apply.started", { previousState: prev });

		let sideEffectCompleted = false;
		try {
			const applied = await this.applyPort.apply({
				plan,
				worktree: this.toPublic(rec),
				expectedWorktreeRevision: params.expectedWorktreeRevision,
				expectedTargetSnapshotId: params.expectedTargetSnapshotId,
				operationId,
				idempotencyKey,
			});
			sideEffectCompleted = true;
			const next = this.env.worktrees[rec.worktreeId] ?? rec;
			Object.assign(next, {
				...next,
				state: applied.worktree.state ?? "ready",
				dirty: applied.worktree.dirty ?? false,
				headOid: applied.worktree.headOid ?? next.headOid,
				revision: next.revision + 1,
				updatedAt: this.now().toISOString(),
				lastOperationId: operationId,
			});
			this.env.worktrees[next.worktreeId] = next;
			receipt.outcome = "completed";
			receipt.result = this.toPublic(next);
			receipt.updatedAt = next.updatedAt;
			// env 权威态先落盘，再写 terminal receipt
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: next.worktreeId,
				kind: "apply",
				outcome: "completed",
			});
			this.emit("worktree.apply.completed", next, operationId, "apply.completed", {
				terminal: true,
				previousState: "applying",
			});
			return {
				worktree: this.toPublic(next),
				operationId,
				replayed: false,
			};
		} catch (err) {
			if (sideEffectCompleted) throw err;
			if (err instanceof WorktreeError && err.code === "OUTCOME_UNKNOWN") {
				this.markUnresolvedUnknown(operationId, "apply", rec.worktreeId);
				throw new WorktreeError(err.code, err.message, {
					...(err.details ?? {}),
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof WorktreeError ? err.code : ("INTERNAL" as WorktreeErrorCode);
			rec.state = code === "CONFLICT" ? "conflicted" : "failed";
			rec.failure = { code, message };
			rec.revision += 1;
			rec.updatedAt = this.now().toISOString();
			this.env.worktrees[rec.worktreeId] = rec;
			receipt.outcome = "failed";
			receipt.error = { code, message };
			receipt.updatedAt = rec.updatedAt;
			await this.persistEnv();
			await this.writeReceipt(receipt);
			if (rec.state === "conflicted") {
				this.emit("worktree.apply.conflicted", rec, operationId, "apply.conflicted", {
					terminal: true,
					previousState: "applying",
				});
			} else {
				this.emit("worktree.state.changed", rec, operationId, "apply.failed", {
					terminal: true,
					previousState: "applying",
				});
			}
			if (err instanceof WorktreeError) throw err;
			throw new WorktreeError("INTERNAL", message, { operationId, worktreeId: rec.worktreeId });
		}
	}

	// ── archive ──────────────────────────────────────────────────────────────

	async archive(params: WorktreeArchiveParams): Promise<WorktreeMutationResult> {
		await this.ensureLoaded();
		if (!params?.worktreeId) throw new WorktreeError("INVALID_PARAMS", "worktreeId is required");
		if (typeof params.expectedRevision !== "number") {
			throw new WorktreeError("INVALID_PARAMS", "expectedRevision is required");
		}
		if (!params.meta?.idempotencyKey) {
			throw new WorktreeError("INVALID_PARAMS", "meta.idempotencyKey is required");
		}

		const retainChanges = params.retainChanges === true;
		const idempotencyKey = params.meta.idempotencyKey;
		const paramsHash = hashParams({
			worktreeId: params.worktreeId,
			expectedRevision: params.expectedRevision,
			retainChanges,
		});

		const replay = await this.replayMutation(idempotencyKey, paramsHash);
		if (replay) return replay;

		const rec = this.requireWorktree(params.worktreeId);

		if (rec.revision !== params.expectedRevision) {
			throw new WorktreeError("CONFLICT", "expectedRevision does not match current revision", {
				expectedRevision: params.expectedRevision,
				currentRevision: rec.revision,
				worktreeId: rec.worktreeId,
			});
		}

		if (rec.state === "archived") {
			const operationId = this.idFactory();
			const ts = this.now().toISOString();
			const receipt: WorktreeOperationReceipt = {
				operationId,
				worktreeId: rec.worktreeId,
				kind: "archive",
				idempotencyKey,
				paramsHash,
				outcome: "completed",
				result: this.toPublic(rec),
				createdAt: ts,
				updatedAt: ts,
			};
			this.env.idempotencyIndex[idempotencyKey] = operationId;
			await this.writeReceipt(receipt);
			await this.persistEnv();
			return { worktree: this.toPublic(rec), operationId, replayed: false };
		}

		// Dirty / active：类型化拒绝（禁止 force 旁路）
		if (rec.activeSessionCount > 0 || rec.state === "in_use" || rec.owningSessionId) {
			throw new WorktreeError("PRECONDITION_FAILED", "cannot archive worktree with active sessions", {
				worktreeId: rec.worktreeId,
				activeSessionCount: rec.activeSessionCount,
				state: rec.state,
				owningSessionId: rec.owningSessionId,
			});
		}
		if (rec.dirty || rec.state === "dirty") {
			if (!retainChanges) {
				throw new WorktreeError("PRECONDITION_FAILED", "cannot archive dirty worktree without retainChanges", {
					worktreeId: rec.worktreeId,
					dirty: true,
					state: rec.state,
				});
			}
		}

		const operationId = this.idFactory();
		const ts = this.now().toISOString();
		const receipt: WorktreeOperationReceipt = {
			operationId,
			worktreeId: rec.worktreeId,
			kind: "archive",
			idempotencyKey,
			paramsHash,
			outcome: "outcome_unknown",
			createdAt: ts,
			updatedAt: ts,
		};
		this.env.idempotencyIndex[idempotencyKey] = operationId;

		const prev = rec.state;
		rec.state = "archiving";
		rec.revision += 1;
		rec.updatedAt = this.now().toISOString();
		rec.lastOperationId = operationId;
		this.env.worktrees[rec.worktreeId] = rec;
		await this.writeReceipt(receipt);
		await this.persistEnv();
		await this.appendJournal({
			operationId,
			worktreeId: rec.worktreeId,
			kind: "archive",
			outcome: "outcome_unknown",
			note: "archive started",
		});
		this.emit("worktree.state.changed", rec, operationId, "archive.started", { previousState: prev });

		let sideEffectCompleted = false;
		try {
			// 真实 git worktree remove
			if (existsSync(rec.displayPath)) {
				const removeArgv = retainChanges
					? ["worktree", "remove", rec.displayPath]
					: ["worktree", "remove", "--force", rec.displayPath];
				const result = await spawnGit(removeArgv, rec.repositoryPath);
				if (result.exitCode !== 0) {
					if (retainChanges) {
						// fail-closed：保留 dirty/目录，禁止 rm -rf 丢变更
						throw new WorktreeError(
							"PRECONDITION_FAILED",
							"git worktree remove failed while retainChanges=true; worktree directory preserved",
							{
								worktreeId: rec.worktreeId,
								exitCode: result.exitCode,
								retainChanges: true,
								feature: "archive",
							},
						);
					}
					// 非 retain：允许 force 清理半成品
					await rm(rec.displayPath, { recursive: true, force: true });
					await spawnGit(["worktree", "prune"], rec.repositoryPath);
				}
			}
			sideEffectCompleted = true;

			rec.state = "archived";
			rec.dirty = false;
			rec.revision += 1;
			rec.updatedAt = this.now().toISOString();
			rec.lastOperationId = operationId;
			this.env.worktrees[rec.worktreeId] = rec;
			for (const [pid, plan] of Object.entries(this.env.plans)) {
				if (plan.worktreeId === rec.worktreeId) delete this.env.plans[pid];
			}

			receipt.outcome = "completed";
			receipt.result = this.toPublic(rec);
			receipt.updatedAt = rec.updatedAt;
			// env 权威态（archived）先落盘，再写 terminal receipt
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "archive",
				outcome: "completed",
			});
			this.emit("worktree.archived", rec, operationId, "archive.completed", {
				terminal: true,
				previousState: "archiving",
			});
			return { worktree: this.toPublic(rec), operationId, replayed: false };
		} catch (err) {
			if (sideEffectCompleted) throw err;
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof WorktreeError ? err.code : ("INTERNAL" as WorktreeErrorCode);
			const details = err instanceof WorktreeError ? err.details : undefined;
			// 失败时保留目录与 dirty 语义；从 archiving 落到 failed，不删路径
			rec.state = "failed";
			rec.failure = { code, message, ...(details ? { details } : {}) };
			rec.revision += 1;
			rec.updatedAt = this.now().toISOString();
			this.env.worktrees[rec.worktreeId] = rec;
			receipt.outcome = "failed";
			receipt.error = { code, message, ...(details ? { details } : {}) };
			receipt.updatedAt = rec.updatedAt;
			await this.persistEnv();
			await this.writeReceipt(receipt);
			await this.appendJournal({
				operationId,
				worktreeId: rec.worktreeId,
				kind: "archive",
				outcome: "failed",
				note: message,
			});
			if (err instanceof WorktreeError) {
				throw new WorktreeError(code, message, {
					...details,
					operationId,
					worktreeId: rec.worktreeId,
				});
			}
			throw new WorktreeError("INTERNAL", message, { operationId, worktreeId: rec.worktreeId });
		}
	}

	// ── 测试 / 会话绑定辅助 ──────────────────────────────────────────────────

	/** 绑定活跃会话（阻塞 archive）。 */
	async setActiveSessionCount(worktreeId: string, count: number): Promise<ManagedWorktree> {
		await this.ensureLoaded();
		const rec = this.requireWorktree(worktreeId);
		rec.activeSessionCount = Math.max(0, count | 0);
		if (rec.activeSessionCount > 0) {
			rec.state = rec.state === "archived" || rec.state === "failed" ? rec.state : "in_use";
			rec.owningSessionId = rec.owningSessionId ?? `session-bound-${rec.worktreeId}`;
		} else {
			if (rec.state === "in_use") rec.state = rec.dirty ? "dirty" : "ready";
			rec.owningSessionId = undefined;
		}
		rec.revision += 1;
		rec.updatedAt = this.now().toISOString();
		this.env.worktrees[worktreeId] = rec;
		await this.persistEnv();
		return this.toPublic(rec);
	}

	/** 标记 dirty。 */
	async setDirty(worktreeId: string, dirty: boolean): Promise<ManagedWorktree> {
		await this.ensureLoaded();
		const rec = this.requireWorktree(worktreeId);
		rec.dirty = dirty;
		if (dirty && (rec.state === "ready" || rec.state === "setup_pending")) {
			rec.state = "dirty";
		} else if (!dirty && rec.state === "dirty") {
			rec.state = "ready";
		}
		rec.revision += 1;
		rec.updatedAt = this.now().toISOString();
		this.env.worktrees[worktreeId] = rec;
		await this.persistEnv();
		return this.toPublic(rec);
	}

	/** 绑定 owningSessionId（跨 session 拒绝辅助）。 */
	async bindOwningSession(worktreeId: string, sessionId: string | undefined): Promise<ManagedWorktree> {
		await this.ensureLoaded();
		const rec = this.requireWorktree(worktreeId);
		rec.owningSessionId = sessionId;
		if (sessionId) {
			rec.activeSessionCount = Math.max(1, rec.activeSessionCount);
			if (rec.state === "ready" || rec.state === "setup_pending") rec.state = "in_use";
		}
		rec.revision += 1;
		rec.updatedAt = this.now().toISOString();
		this.env.worktrees[worktreeId] = rec;
		await this.persistEnv();
		return this.toPublic(rec);
	}

	capabilityDescriptor(): WorktreeLifecycleCapabilityDetails {
		const setupAvailable = Boolean(this.setupPort?.ready);
		const applyAvailable = Boolean(this.applyPort?.ready);
		// limits.strategies = 实际 mutation 支持项；无 ready port => []
		const strategies = this.mutationStrategies();
		const status: "available" | "degraded" | "unavailable" = !this.recoveryReady
			? "unavailable"
			: this.recoveryDegraded
				? "degraded"
				: "available";
		return {
			name: WORKTREE_LIFECYCLE_CAPABILITY,
			version: WORKTREE_LIFECYCLE_CAPABILITY_VERSION,
			methods: [...WORKTREE_LIFECYCLE_METHODS],
			setupAvailable,
			applyAvailable,
			recoveryReady: this.recoveryReady,
			limits: {
				...this.limits,
				strategies,
			},
			status,
			...(this.recoveryDegraded
				? {
						// 供测试/诊断：未解决的 outcome_unknown（不静默清除）
						unresolvedUnknownOperations: this.unresolvedUnknownOps.map(o => ({ ...o })),
					}
				: {}),
		};
	}

	/**
	 * mutation strategies 广告：仅 ready applyPort 声明的策略 ∩ 服务冻结集。
	 * ready:true 但未声明/空 => []（不可默认 patch|merge_commit）。
	 */
	private mutationStrategies(): WorktreeApplyStrategy[] {
		if (!this.applyPort?.ready) return [];
		const declared = this.applyPort.strategies;
		if (!Array.isArray(declared) || declared.length === 0) return [];
		const allowed = new Set<string>(WORKTREE_LIFECYCLE_V1_LIMITS.strategies as readonly string[]);
		const out: WorktreeApplyStrategy[] = [];
		const seen = new Set<string>();
		for (const s of declared) {
			if (typeof s !== "string" || !allowed.has(s) || seen.has(s)) continue;
			seen.add(s);
			out.push(s as WorktreeApplyStrategy);
		}
		return out;
	}
}

// 兼容旧测试导入名
export type WorktreeRecord = ManagedWorktree;
export type { WorktreeApplyPlan, WorktreeEventEnvelope, WorktreeOperationReceipt };
