import { afterEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { TempDir } from "@san/utils";
import { resolveSessionProjectMeta } from "./session-project-meta";

const temps: TempDir[] = [];

async function runGit(cwd: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
}

async function createRepo(): Promise<string> {
	const temp = await TempDir.create("@san-rpc-meta-");
	temps.push(temp);
	const repo = path.join(temp.path(), "repo");
	await Bun.write(path.join(repo, "a.txt"), "a\n");
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.name", "San Test"]);
	await runGit(repo, ["config", "user.email", "san@example.test"]);
	await runGit(repo, ["add", "a.txt"]);
	await runGit(repo, ["commit", "-qm", "initial"]);
	return repo;
}

afterEach(async () => {
	await Promise.all(temps.splice(0).map(temp => temp.remove()));
});

describe("resolveSessionProjectMeta", () => {
	it("resolves project root, common dir, and branch for a plain repository", async () => {
		const repo = await createRepo();
		const meta = resolveSessionProjectMeta(repo);
		expect(meta?.projectRoot).toBe(realpathSync(repo));
		expect(meta?.gitCommonDir).toBe(path.join(realpathSync(repo), ".git"));
		expect(meta?.branch).toBe("main");
	});

	it("maps a linked worktree cwd back to the primary checkout and shared common dir", async () => {
		const repo = await createRepo();
		const worktreePath = path.join(path.dirname(repo), "wt");
		await runGit(repo, ["worktree", "add", "-q", "-b", "wt-branch", worktreePath]);

		const meta = resolveSessionProjectMeta(worktreePath);
		expect(meta?.projectRoot).toBe(realpathSync(repo));
		expect(meta?.gitCommonDir).toBe(path.join(realpathSync(repo), ".git"));
		expect(meta?.branch).toBe("wt-branch");
	});

	it("returns undefined outside a git repository", async () => {
		const temp = await TempDir.create("@san-rpc-meta-");
		temps.push(temp);
		expect(resolveSessionProjectMeta(temp.path())).toBeUndefined();
	});
});
