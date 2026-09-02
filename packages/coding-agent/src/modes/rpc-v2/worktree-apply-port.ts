/**
 * Git-backed WorktreeApplyPort —— worktree.apply 的真实 mutation 端口。
 *
 * 策略语义：
 * - patch：worktree 相对 baseOid 的全部变化（已提交 + 未提交 + 未跟踪）
 *   生成单个 binary patch，应用到主 checkout 工作区（不进 index、不提交）。
 * - merge_commit：worktree 必须干净且有 branch；在主 checkout 执行
 *   `git merge --no-ff --no-edit <branch>`，冲突时 abort 恢复后报 CONFLICT。
 *
 * CAS：apply 前校验主 checkout 活 HEAD === expectedTargetSnapshotId，
 * 不一致即 CONFLICT（prepare 之后目标已移动）。git apply 本身全量或全不写；
 * merge 失败且 abort 失败才报 OUTCOME_UNKNOWN（禁止盲重试，交给 recovery）。
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import { $which, logger } from "@oh-my-pi/pi-utils";

import { GitCommandError, patch, repo, withRepoLock } from "../../utils/git";
import type { ManagedWorktree, WorktreeApplyPlan, WorktreeApplyStrategy } from "./dto/worktree";
import { spawnGitRaw, type WorktreeApplyPort, WorktreeError } from "./worktree-lifecycle";

const STDERR_PREVIEW_LIMIT = 2000;

const preview = (text: string): string => text.trim().slice(0, STDERR_PREVIEW_LIMIT);

export class GitWorktreeApplyPort implements WorktreeApplyPort {
	readonly ready: boolean;
	readonly strategies: readonly WorktreeApplyStrategy[] = ["patch", "merge_commit"];

	constructor(gitPath: string | null = $which("git")) {
		this.ready = gitPath !== null;
	}

	async apply(input: {
		plan: WorktreeApplyPlan;
		worktree: ManagedWorktree;
		expectedWorktreeRevision: number;
		expectedTargetSnapshotId: string;
		operationId: string;
		idempotencyKey: string;
	}): Promise<{ worktree: ManagedWorktree; result?: unknown }> {
		if (!this.ready) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "git binary is not available for worktree apply", {
				feature: "apply",
				available: false,
			});
		}
		const { plan, worktree } = input;
		const worktreePath = worktree.displayPath;
		if (!existsSync(worktreePath)) {
			throw new WorktreeError("PRECONDITION_FAILED", "worktree path does not exist for apply", {
				feature: "apply",
				worktreeId: worktree.worktreeId,
			});
		}

		const targetRoot = await repo.primaryRoot(worktreePath);
		if (!targetRoot || path.resolve(targetRoot) === path.resolve(worktreePath)) {
			throw new WorktreeError("PRECONDITION_FAILED", "cannot resolve the primary checkout for this worktree", {
				feature: "apply",
				worktreeId: worktree.worktreeId,
			});
		}
		const bare = await spawnGitRaw(["rev-parse", "--is-bare-repository"], targetRoot);
		if (bare.exitCode !== 0 || bare.stdout.trim() === "true") {
			throw new WorktreeError("PRECONDITION_FAILED", "target repository has no primary checkout to apply into", {
				feature: "apply",
				worktreeId: worktree.worktreeId,
			});
		}

		// 目标快照 CAS：prepare 之后主 checkout HEAD 必须未动。
		const targetHeadBefore = await this.headOid(targetRoot);
		if (!targetHeadBefore) {
			throw new WorktreeError("CAPABILITY_UNAVAILABLE", "unable to resolve target repository HEAD", {
				feature: "apply",
				available: false,
			});
		}
		if (targetHeadBefore !== input.expectedTargetSnapshotId) {
			throw new WorktreeError("CONFLICT", "target repository moved since apply.prepare", {
				feature: "apply",
				expectedTargetSnapshotId: input.expectedTargetSnapshotId,
				liveTargetHead: targetHeadBefore,
			});
		}

		if (plan.strategy === "patch") {
			await this.applyPatch(worktree, worktreePath, targetRoot);
		} else if (plan.strategy === "merge_commit") {
			await this.applyMergeCommit(worktree, worktreePath, targetRoot);
		} else {
			throw new WorktreeError("INVALID_PARAMS", `unsupported apply strategy: ${plan.strategy}`, {
				feature: "apply",
				strategy: plan.strategy,
			});
		}

		const liveHead = (await this.headOid(worktreePath)) ?? worktree.headOid;
		const dirty = await this.isDirty(worktreePath);
		const targetHeadAfter = await this.headOid(targetRoot);
		return {
			worktree: { ...worktree, state: "ready", headOid: liveHead, dirty },
			result: {
				strategy: plan.strategy,
				appliedFiles: plan.files.length,
				targetHeadBefore,
				targetHeadAfter,
			},
		};
	}

	/**
	 * patch 策略：`git diff baseOid` 覆盖已提交/已暂存/未暂存的跟踪文件；
	 * 未跟踪文件经 intent-to-add（add -N）纳入同一 diff，生成后立即 reset 还原。
	 */
	private async applyPatch(worktree: ManagedWorktree, worktreePath: string, targetRoot: string): Promise<void> {
		const untracked = await this.listUntracked(worktreePath);
		let intentAdded = false;
		try {
			if (untracked.length > 0) {
				const add = await spawnGitRaw(["add", "-N", "--", ...untracked], worktreePath);
				if (add.exitCode !== 0) {
					throw new WorktreeError("CAPABILITY_UNAVAILABLE", "unable to snapshot untracked files for patch", {
						feature: "apply",
						available: false,
						stderr: preview(add.stderr),
					});
				}
				intentAdded = true;
			}
			const diffResult = await spawnGitRaw(["diff", "--binary", "--full-index", worktree.baseOid], worktreePath);
			if (diffResult.exitCode !== 0) {
				throw new WorktreeError("CAPABILITY_UNAVAILABLE", "unable to generate worktree patch", {
					feature: "apply",
					available: false,
					stderr: preview(diffResult.stderr),
				});
			}
			const patchText = diffResult.stdout;
			if (!patchText.trim()) return;
			await withRepoLock(targetRoot, async () => {
				if (!(await patch.canApplyText(targetRoot, patchText))) {
					throw new WorktreeError("CONFLICT", "worktree patch does not apply cleanly to the target checkout", {
						feature: "apply",
						strategy: "patch",
					});
				}
				try {
					await patch.applyText(targetRoot, patchText);
				} catch (err) {
					// git apply 失败即全不写；precheck 已过仍失败属内部异常（磁盘/锁）。
					throw new WorktreeError("INTERNAL", "git apply failed after a successful precheck", {
						feature: "apply",
						strategy: "patch",
						detail: err instanceof GitCommandError ? preview(err.message) : String(err),
					});
				}
			});
		} finally {
			if (intentAdded) {
				const reset = await spawnGitRaw(["reset", "-q", "--", ...untracked], worktreePath);
				if (reset.exitCode !== 0) {
					logger.warn("worktree apply: intent-to-add reset failed; index retains -N entries", {
						worktreePath,
						stderr: preview(reset.stderr),
					});
				}
			}
		}
	}

	/**
	 * merge_commit 策略：worktree 干净且有 branch 才可合；
	 * merge 失败先 abort 恢复目标，abort 再失败才报 OUTCOME_UNKNOWN。
	 */
	private async applyMergeCommit(worktree: ManagedWorktree, worktreePath: string, targetRoot: string): Promise<void> {
		const branchName = worktree.branch;
		if (!branchName) {
			throw new WorktreeError("PRECONDITION_FAILED", "merge_commit strategy requires a worktree branch", {
				feature: "apply",
				strategy: "merge_commit",
			});
		}
		if (await this.isDirty(worktreePath)) {
			throw new WorktreeError(
				"PRECONDITION_FAILED",
				"worktree has uncommitted changes; commit them or use the patch strategy",
				{ feature: "apply", strategy: "merge_commit" },
			);
		}
		const refCheck = await spawnGitRaw(["rev-parse", "--verify", "--quiet", branchName], targetRoot);
		if (refCheck.exitCode !== 0) {
			throw new WorktreeError(
				"PRECONDITION_FAILED",
				`worktree branch not found in target repository: ${branchName}`,
				{
					feature: "apply",
					strategy: "merge_commit",
				},
			);
		}
		await withRepoLock(targetRoot, async () => {
			const merge = await spawnGitRaw(["merge", "--no-ff", "--no-edit", branchName], targetRoot);
			if (merge.exitCode === 0) return;
			const abort = await spawnGitRaw(["merge", "--abort"], targetRoot);
			if (abort.exitCode !== 0) {
				throw new WorktreeError("OUTCOME_UNKNOWN", "merge failed and --abort did not restore the target checkout", {
					feature: "apply",
					strategy: "merge_commit",
					mergeStderr: preview(merge.stderr),
					abortStderr: preview(abort.stderr),
				});
			}
			throw new WorktreeError("CONFLICT", "merge_commit could not be completed cleanly; target checkout restored", {
				feature: "apply",
				strategy: "merge_commit",
				stderr: preview(merge.stderr),
			});
		});
	}

	private async headOid(cwd: string): Promise<string | null> {
		const result = await spawnGitRaw(["rev-parse", "HEAD"], cwd);
		if (result.exitCode !== 0) return null;
		return result.stdout.trim() || null;
	}

	private async isDirty(cwd: string): Promise<boolean> {
		const result = await spawnGitRaw(["status", "--porcelain"], cwd);
		if (result.exitCode !== 0) return true;
		return result.stdout.trim().length > 0;
	}

	private async listUntracked(cwd: string): Promise<string[]> {
		const result = await spawnGitRaw(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
		if (result.exitCode !== 0) return [];
		return result.stdout.split("\0").filter(entry => entry.length > 0);
	}
}
