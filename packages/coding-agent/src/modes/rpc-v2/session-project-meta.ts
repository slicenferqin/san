/**
 * SessionSummary 的项目分组元数据（P-3）。
 * 同步纯磁盘解析（.git/commondir/HEAD 文件行走，无子进程），
 * 供 session.list / session.get 摘要投影；非 git cwd 或解析失败返回 undefined。
 * 输入先 realpath 规范化，保证 worktree 与主 checkout 分组键一致（macOS /var 符号链接）。
 */

import { realpathSync } from "node:fs";

import { head, repo } from "../../utils/git";

export interface SessionProjectMeta {
	/** 主 checkout 根目录；bare 仓库回退为 common dir。 */
	projectRoot: string;
	/** 共享 git common dir 绝对路径（跨 worktree 稳定）。 */
	gitCommonDir: string;
	/** 当前分支名；detached HEAD 时省略。 */
	branch?: string;
}

export function resolveSessionProjectMeta(cwd: string): SessionProjectMeta | undefined {
	try {
		const canonical = realpathSync(cwd);
		const repository = repo.resolveSync(canonical);
		if (!repository) return undefined;
		const headState = head.resolveSync(canonical);
		const branch = headState?.kind === "ref" ? (headState.branchName ?? undefined) : undefined;
		return {
			projectRoot: repo.primaryRootSync(canonical) ?? repository.repoRoot,
			gitCommonDir: repository.commonDir,
			...(branch ? { branch } : {}),
		};
	} catch {
		return undefined;
	}
}
