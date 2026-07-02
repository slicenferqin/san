import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSanLoopChecks, renderSanLoopChecks, selectSanLoopChecks } from "../../src/san-loop";

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
			".omp/checks/supervisor-gate.md",
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
			".omp/checks/coding-agent-only.md",
			`---
name: coding-agent-only
scope:
  paths: ["packages/coding-agent/**"]
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
});
