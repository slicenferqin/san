import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@san/utils";
import { diffStats, listSessionChanges, readChangeFile, revertSessionChanges } from "./session-changes";

const workspaces: TempDir[] = [];

async function runGit(cwd: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
}

async function createWorkspace(): Promise<string> {
	const temp = await TempDir.create("@san-rpc-changes-");
	workspaces.push(temp);
	const cwd = temp.path();
	await runGit(cwd, ["init", "-q"]);
	await runGit(cwd, ["config", "user.name", "San Test"]);
	await runGit(cwd, ["config", "user.email", "san@example.test"]);
	await Bun.write(path.join(cwd, "tracked.txt"), "first\nsecond\n");
	await runGit(cwd, ["add", "tracked.txt"]);
	await runGit(cwd, ["commit", "-qm", "initial"]);
	return cwd;
}

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map(temp => temp.remove()));
});

describe("session changes", () => {
	it("lists one coherent revision for stats and structured file hunks", async () => {
		const cwd = await createWorkspace();
		await Bun.write(path.join(cwd, "tracked.txt"), "first\nchanged\nthird\n");
		await Bun.write(path.join(cwd, "new.txt"), "new\n");

		const listed = await listSessionChanges(cwd);
		const stats = diffStats(listed);
		const file = await readChangeFile(cwd, "tracked.txt");

		expect(listed.source).toBe("git");
		expect(listed.changes.map(change => change.path).sort()).toEqual(["new.txt", "tracked.txt"]);
		expect(stats.revision).toBe(listed.revision);
		expect(stats.totalAdds).toBe(3);
		expect(stats.totalDels).toBe(1);
		expect(file.baseRef).toBe(listed.baseRef);
		expect(file.hunks).toEqual([expect.objectContaining({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 })]);
		expect(file.hunks[0]?.lines).toContain("-second");
		expect(file.hunks[0]?.lines).toContain("+changed");
	});

	it("restores tracked content and removes an untracked file", async () => {
		const cwd = await createWorkspace();
		await Bun.write(path.join(cwd, "tracked.txt"), "changed\n");
		await Bun.write(path.join(cwd, "new.txt"), "new\n");
		const before = await listSessionChanges(cwd);
		const expected = Object.fromEntries(before.changes.map(change => [change.path, change.currentHash ?? ""]));

		const result = await revertSessionChanges(cwd, ["tracked.txt", "new.txt"], expected, before.revision);

		expect(result.skipped).toEqual([]);
		expect(result.reverted.map(item => item.path).sort()).toEqual(["new.txt", "tracked.txt"]);
		expect(await Bun.file(path.join(cwd, "tracked.txt")).text()).toBe("first\nsecond\n");
		expect(await Bun.file(path.join(cwd, "new.txt")).exists()).toBe(false);
	});

	it("does not overwrite a file changed after the caller observed it", async () => {
		const cwd = await createWorkspace();
		await Bun.write(path.join(cwd, "tracked.txt"), "agent change\n");
		const before = await listSessionChanges(cwd);
		const observed = before.changes.find(change => change.path === "tracked.txt");
		if (!observed?.currentHash) throw new Error("expected tracked change hash");
		await Bun.write(path.join(cwd, "tracked.txt"), "external change\n");

		const result = await revertSessionChanges(
			cwd,
			["tracked.txt"],
			{ "tracked.txt": observed.currentHash },
			before.revision,
		);

		expect(result.reverted).toEqual([]);
		expect(result.skipped).toEqual([{ path: "tracked.txt", reason: "external_edit" }]);
		expect(await Bun.file(path.join(cwd, "tracked.txt")).text()).toBe("external change\n");
	});

	it("rejects stale revisions before touching files", async () => {
		const cwd = await createWorkspace();
		await Bun.write(path.join(cwd, "tracked.txt"), "changed\n");

		const result = await revertSessionChanges(cwd, ["tracked.txt"], {}, "stale");

		expect(result.reverted).toEqual([]);
		expect(result.skipped).toEqual([{ path: "tracked.txt", reason: "revision_changed" }]);
		expect(await Bun.file(path.join(cwd, "tracked.txt")).text()).toBe("changed\n");
	});
});
