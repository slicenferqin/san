import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bindSanLoopChecks,
	discoverSanLoopChecks,
	renderSanLoopChecks,
	type SanLoopCheck,
	selectSanLoopChecks,
} from "../../src/san-loop";

let tmpDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tmpDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tmpDirs = [];
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "san-loop-checks-"));
	tmpDirs.push(dir);
	return dir;
}

async function writeCheck(root: string, relativePath: string, content: string): Promise<void> {
	const target = path.join(root, relativePath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, content);
}

describe("San loop checks", () => {
	test("discovers project checks before bundled checks with first-wins names", async () => {
		const cwd = await tempDir();
		await writeCheck(
			cwd,
			".san/checks/supervisor-gate.md",
			`---
name: supervisor-gate
severity: blocker
appliesTo: ["supervisor"]
---

- Project override gate.
`,
		);

		const checks = await discoverSanLoopChecks({ cwd });

		expect(checks[0]).toMatchObject({
			name: "supervisor-gate",
			source: "project",
			severity: "blocker",
			appliesTo: ["supervisor"],
		});
		expect(checks.filter(check => check.name === "supervisor-gate")).toHaveLength(1);
		expect(checks.some(check => check.name === "project-typescript-contracts" && check.source === "bundled")).toBe(
			true,
		);
	});

	test("filters checks by role and path scope", async () => {
		const cwd = await tempDir();
		await writeCheck(
			cwd,
			".san/checks/coding-agent-only.md",
			`---
name: coding-agent-only
scope:
  paths: ["**/checks.ts"]
severity: error
appliesTo: ["worker", "supervisor"]
---

- Applies only to coding-agent files.
`,
		);
		const checks = await discoverSanLoopChecks({ cwd, includeBuiltins: false });

		expect(
			selectSanLoopChecks(checks, { role: "worker", paths: ["packages/coding-agent/src/san-loop/checks.ts"] }),
		).toHaveLength(1);
		expect(
			selectSanLoopChecks(checks, { role: "commander", paths: ["packages/coding-agent/src/san-loop/checks.ts"] }),
		).toHaveLength(0);
		expect(selectSanLoopChecks(checks, { role: "worker", paths: ["packages/ai/src/index.ts"] })).toHaveLength(0);
	});

	test("renders selected checks for supervisor prompts", async () => {
		const checks = await discoverSanLoopChecks({ cwd: await tempDir(), includeBuiltins: true });
		const selected = selectSanLoopChecks(checks, { role: "supervisor", paths: ["packages/coding-agent/src/foo.ts"] });
		const rendered = renderSanLoopChecks(selected);

		expect(rendered).toContain("San checks:");
		expect(rendered).toContain("## project-typescript-contracts");
		expect(rendered).toContain("Severity: error");
		expect(rendered).toContain("## supervisor-gate");
		expect(rendered).toContain("Supervisor gate expectations");
	});

	test("fails closed when a project check file cannot be read", async () => {
		const cwd = await tempDir();
		const checksDir = path.join(cwd, ".san/checks");
		await fs.mkdir(checksDir, { recursive: true });
		const blockedPath = path.join(checksDir, "blocked.md");
		await Bun.write(blockedPath, "---\nname: blocked\n---\n- body\n");
		await fs.chmod(blockedPath, 0);

		try {
			await expect(discoverSanLoopChecks({ cwd, includeBuiltins: false })).rejects.toThrow(
				/Failed to load San check/,
			);
		} finally {
			await fs.chmod(blockedPath, 0o644);
		}
	});

	test("fails closed when a project check has malformed frontmatter", async () => {
		const cwd = await tempDir();
		await writeCheck(
			cwd,
			".san/checks/malformed.md",
			`---
name: "unterminated
severity: blocker
---

- Invalid metadata must not load.
`,
		);

		await expect(discoverSanLoopChecks({ cwd, includeBuiltins: false })).rejects.toThrow(
			/Failed to load San check.*Failed to parse YAML frontmatter/,
		);
	});
	test("binds only checks whose declared clauses are in the immutable contract", () => {
		const checks: SanLoopCheck[] = [
			{
				name: "allowed",
				description: "allowed check",
				path: "allowed.md",
				content: "assert clause one",
				scope: undefined,
				severity: "error" as const,
				appliesTo: ["worker"],
				source: "project" as const,
				objectiveClauseRefs: ["clause:one"],
			},
			{
				name: "foreign",
				description: "foreign check",
				path: "foreign.md",
				content: "assert clause foreign",
				scope: undefined,
				severity: "error" as const,
				appliesTo: ["worker"],
				source: "project" as const,
				objectiveClauseRefs: ["clause:foreign"],
			},
		];
		const bound = bindSanLoopChecks(checks, {
			objectiveClauseRefs: ["clause:one"],
			contractRevision: 3,
			contractHash: "sha256:contract",
		});
		expect(bound).toHaveLength(1);
		expect(bound[0]).toMatchObject({ name: "allowed", objectiveClauseRefs: ["clause:one"], contractRevision: 3 });
	});
});
