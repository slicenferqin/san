import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@san/utils";
import type { ManagedWorktree, WorktreeApplyPlan, WorktreeApplyStrategy } from "./dto/worktree";
import { GitWorktreeApplyPort } from "./worktree-apply-port";
import { WorktreeError } from "./worktree-lifecycle";

const temps: TempDir[] = [];

async function runGit(cwd: string, args: string[]): Promise<string> {
	const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	return stdout;
}

async function createRepoWithWorktree(): Promise<{ repo: string; worktreePath: string; baseOid: string }> {
	const temp = await TempDir.create("@san-rpc-apply-");
	temps.push(temp);
	const repo = path.join(temp.path(), "repo");
	await Bun.write(path.join(repo, "tracked.txt"), "first\nsecond\n");
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.name", "San Test"]);
	await runGit(repo, ["config", "user.email", "san@example.test"]);
	await runGit(repo, ["add", "tracked.txt"]);
	await runGit(repo, ["commit", "-qm", "initial"]);
	const baseOid = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
	const worktreePath = path.join(temp.path(), "wt");
	await runGit(repo, ["worktree", "add", "-q", "-b", "wt-branch", worktreePath]);
	return { repo, worktreePath, baseOid };
}

function buildInput(
	worktreePath: string,
	baseOid: string,
	targetHead: string,
	strategy: WorktreeApplyStrategy,
): {
	plan: WorktreeApplyPlan;
	worktree: ManagedWorktree;
	expectedWorktreeRevision: number;
	expectedTargetSnapshotId: string;
	operationId: string;
	idempotencyKey: string;
} {
	return {
		plan: {
			planId: "plan-1",
			worktreeId: "wt-1",
			sourceSnapshotId: `wt:wt-1@${baseOid}`,
			targetRepoId: "repo-1",
			targetSnapshotId: targetHead,
			strategy,
			files: [],
			conflicts: [],
			warnings: [],
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
		worktree: {
			worktreeId: "wt-1",
			environmentId: "env-1",
			repoId: "repo-1",
			pathRef: "wtp:env-1/00",
			displayPath: worktreePath,
			baseOid,
			branch: "wt-branch",
			headOid: baseOid,
			state: "ready",
			dirty: true,
			revision: 1,
		},
		expectedWorktreeRevision: 1,
		expectedTargetSnapshotId: targetHead,
		operationId: "op-1",
		idempotencyKey: "idem-1",
	};
}

afterEach(async () => {
	await Promise.all(temps.splice(0).map(temp => temp.remove()));
});

describe("GitWorktreeApplyPort", () => {
	it("patch strategy lands tracked edits and untracked files in the target working tree", async () => {
		const { repo, worktreePath, baseOid } = await createRepoWithWorktree();
		await Bun.write(path.join(worktreePath, "tracked.txt"), "first\nchanged\n");
		await Bun.write(path.join(worktreePath, "new.txt"), "new\n");
		const targetHead = (await runGit(repo, ["rev-parse", "HEAD"])).trim();

		const port = new GitWorktreeApplyPort();
		const result = await port.apply(buildInput(worktreePath, baseOid, targetHead, "patch"));

		expect(result.worktree.state).toBe("ready");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("first\nchanged\n");
		expect(await Bun.file(path.join(repo, "new.txt")).text()).toBe("new\n");
		// patch 只写工作区：目标 HEAD 不动、改动保持未提交
		expect((await runGit(repo, ["rev-parse", "HEAD"])).trim()).toBe(targetHead);
		const targetStatus = await runGit(repo, ["status", "--porcelain"]);
		expect(targetStatus).toContain("tracked.txt");
		expect(targetStatus).toContain("new.txt");
		// worktree 侧无 intent-to-add 残留：new.txt 仍是纯未跟踪
		const worktreeStatus = await runGit(worktreePath, ["status", "--porcelain"]);
		expect(worktreeStatus).toContain("?? new.txt");
	});

	it("patch strategy conflicts when the target snapshot moved since prepare", async () => {
		const { repo, worktreePath, baseOid } = await createRepoWithWorktree();
		await Bun.write(path.join(worktreePath, "tracked.txt"), "changed\n");
		const staleHead = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
		await Bun.write(path.join(repo, "other.txt"), "moved\n");
		await runGit(repo, ["add", "other.txt"]);
		await runGit(repo, ["commit", "-qm", "target moved"]);

		const port = new GitWorktreeApplyPort();
		try {
			await port.apply(buildInput(worktreePath, baseOid, staleHead, "patch"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("CONFLICT");
		}
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("first\nsecond\n");
	});

	it("merge_commit rejects a dirty worktree and merges a clean branch into the target", async () => {
		const { repo, worktreePath, baseOid } = await createRepoWithWorktree();
		const targetHead = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
		const port = new GitWorktreeApplyPort();

		await Bun.write(path.join(worktreePath, "tracked.txt"), "dirty\n");
		try {
			await port.apply(buildInput(worktreePath, baseOid, targetHead, "merge_commit"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("PRECONDITION_FAILED");
		}

		await runGit(worktreePath, ["add", "tracked.txt"]);
		await runGit(worktreePath, ["commit", "-qm", "worktree change"]);
		const result = await port.apply(buildInput(worktreePath, baseOid, targetHead, "merge_commit"));

		expect(result.worktree.state).toBe("ready");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("dirty\n");
		expect((await runGit(repo, ["rev-parse", "HEAD"])).trim()).not.toBe(targetHead);
	});

	it("merge_commit conflict aborts and restores the target checkout", async () => {
		const { repo, worktreePath, baseOid } = await createRepoWithWorktree();
		await Bun.write(path.join(worktreePath, "tracked.txt"), "from-worktree\n");
		await runGit(worktreePath, ["add", "tracked.txt"]);
		await runGit(worktreePath, ["commit", "-qm", "worktree change"]);
		await Bun.write(path.join(repo, "tracked.txt"), "from-main\n");
		await runGit(repo, ["add", "tracked.txt"]);
		await runGit(repo, ["commit", "-qm", "main change"]);
		const targetHead = (await runGit(repo, ["rev-parse", "HEAD"])).trim();

		const port = new GitWorktreeApplyPort();
		try {
			await port.apply(buildInput(worktreePath, baseOid, targetHead, "merge_commit"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("CONFLICT");
		}
		// abort 恢复：HEAD 不变、工作区无冲突残留
		expect((await runGit(repo, ["rev-parse", "HEAD"])).trim()).toBe(targetHead);
		expect((await runGit(repo, ["status", "--porcelain"])).trim()).toBe("");
	});
});
