import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { resolveRuntimeScopeIdentity } from "../../src/identity";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-runtime-identity-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) await fs.rm(root, { recursive: true, force: true });
});

describe("runtime scope identity", () => {
	test("keeps non-Git project identity stable across symlinks and directory moves", async () => {
		const root = await tempRoot();
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		const alias = path.join(root, "project-alias");
		const moved = path.join(root, "project-moved");
		await fs.mkdir(project);
		await fs.symlink(project, alias);

		const direct = await resolveRuntimeScopeIdentity({ agentDir, cwd: project, sessionId: "session-1" });
		const throughSymlink = await resolveRuntimeScopeIdentity({ agentDir, cwd: alias, sessionId: "session-1" });
		await fs.rename(project, moved);
		const afterMove = await resolveRuntimeScopeIdentity({ agentDir, cwd: moved, sessionId: "session-1" });

		expect(throughSymlink.projectKey).toBe(direct.projectKey);
		expect(afterMove.projectKey).toBe(direct.projectKey);
		expect(afterMove.projectKey).not.toContain(moved);
		expect(afterMove.repoKey).toBeUndefined();
		expect(afterMove.legacyProjectKeys).toEqual(expect.arrayContaining([project, alias, moved]));
	});

	test("isolates different non-Git projects even when their basenames match", async () => {
		const root = await tempRoot();
		const agentDir = path.join(root, "agent");
		const first = path.join(root, "first", "project");
		const second = path.join(root, "second", "project");
		await fs.mkdir(first, { recursive: true });
		await fs.mkdir(second, { recursive: true });

		const firstIdentity = await resolveRuntimeScopeIdentity({ agentDir, cwd: first, sessionId: "session-1" });
		const secondIdentity = await resolveRuntimeScopeIdentity({ agentDir, cwd: second, sessionId: "session-1" });

		expect(firstIdentity.projectKey).not.toBe(secondIdentity.projectKey);
	});

	test("shares repository identity while isolating linked worktrees", async () => {
		const root = await tempRoot();
		const agentDir = path.join(root, "agent");
		const repository = path.join(root, "repository");
		const worktree = path.join(root, "worktree");
		await fs.mkdir(repository);
		await $`git init ${repository}`.quiet();
		await Bun.write(path.join(repository, "README.md"), "identity test\n");
		await $`git -C ${repository} add README.md`.quiet();
		await $`git -C ${repository} -c user.name=San -c user.email=san@example.invalid commit -m initial`.quiet();
		await $`git -C ${repository} remote add origin git@github.com:example/runtime-identity.git`.quiet();
		await $`git -C ${repository} worktree add -b identity-worktree ${worktree}`.quiet();

		const primary = await resolveRuntimeScopeIdentity({ agentDir, cwd: repository, sessionId: "session-1" });
		const linked = await resolveRuntimeScopeIdentity({ agentDir, cwd: worktree, sessionId: "session-1" });

		expect(linked.repoKey).toBe(primary.repoKey);
		expect(linked.projectKey).not.toBe(primary.projectKey);
		expect(primary.repoKey).toMatch(/^repo_[a-f0-9]{64}$/);
		const canonicalRepository = await fs.realpath(repository);
		expect(primary.legacyProjectKeys).toContain(canonicalRepository);
		expect(primary.legacyRepoKeys).toContain(canonicalRepository);
	});
});
