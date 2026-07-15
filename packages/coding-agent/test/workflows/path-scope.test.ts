import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rebaseToolPathScopeForIsolation } from "../../src/task/isolation-runner";
import { assertToolArgumentsWithinPathScope, authorizeToolArgumentsWithinPathScope } from "../../src/tools/path-scope";

const tempDirs: string[] = [];

async function fixture(): Promise<{ root: string; scope: string; outside: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-workflow-scope-"));
	tempDirs.push(root);
	const scope = path.join(root, "repo");
	const outside = path.join(root, "outside");
	await Bun.write(path.join(scope, "src", "inside.ts"), "export const inside = true;\n");
	await Bun.write(path.join(scope, "docs", "guide.md"), "inside\n");
	await Bun.write(path.join(outside, "secret.txt"), "secret\n");
	return { root, scope, outside };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function assertScoped(scope: string, toolName: string, args: Record<string, unknown>): void {
	assertToolArgumentsWithinPathScope({ args, toolName, cwd: scope, scopeRoot: scope });
}

describe("Workflow tool path scope", () => {
	it("allows local files, selectors, scoped search lists and pathless approved tools", async () => {
		const { scope } = await fixture();

		expect(() => assertScoped(scope, "read", { path: "src/inside.ts:1-2" })).not.toThrow();
		expect(() => assertScoped(scope, "grep", { pattern: "inside", path: "src; docs/**/*.md" })).not.toThrow();
		expect(() => assertScoped(scope, "glob", { path: "{src,docs}/**/*" })).not.toThrow();
		expect(() => assertScoped(scope, "ast_grep", { pat: "$A", path: "src/**/*.ts" })).not.toThrow();
		expect(() => assertScoped(scope, "inspect_image", { path: "images/missing.png" })).not.toThrow();
		expect(() => assertScoped(scope, "web_search", { query: "docs" })).not.toThrow();
		expect(() => assertScoped(scope, "yield", { result: "done" })).not.toThrow();
	});

	it("rejects relative, absolute and delimiter-hidden escapes", async () => {
		const { outside, scope } = await fixture();

		expect(() => assertScoped(scope, "read", { path: "../outside/secret.txt" })).toThrow(
			"path escapes the approved directory",
		);
		expect(() => assertScoped(scope, "read", { path: path.join(outside, "secret.txt") })).toThrow(
			"path escapes the approved directory",
		);
		expect(() => assertScoped(scope, "grep", { pattern: "secret", path: "src ../outside" })).toThrow(
			"path escapes the approved directory",
		);
		expect(() => assertScoped(scope, "glob", { path: "src/**/*.ts; ../outside/**/*" })).toThrow(
			"path escapes the approved directory",
		);
		expect(() => assertScoped(scope, "grep", { pattern: "secret", path: { hidden: "../outside" } })).toThrow(
			"path must be a string or string array",
		);
	});

	it("rejects a symlink whose apparent in-scope path resolves outside", async () => {
		const { outside, scope } = await fixture();
		await fs.symlink(outside, path.join(scope, "linked-outside"));

		expect(() => assertScoped(scope, "read", { path: "linked-outside/secret.txt" })).toThrow(
			"path resolves outside the approved directory",
		);
		expect(() => assertScoped(scope, "glob", { path: "linked-outside/**/*.txt" })).toThrow(
			"path resolves outside the approved directory",
		);
	});

	it("binds execution to the authorized canonical target when a symlink is replaced", async () => {
		const { outside, scope } = await fixture();
		const target = path.join(scope, "target");
		const linked = path.join(scope, "linked");
		await Bun.write(path.join(target, "value.txt"), "inside\n");
		await fs.symlink(target, linked);
		const authorized = authorizeToolArgumentsWithinPathScope({
			args: { path: "linked/value.txt" },
			toolName: "read",
			cwd: scope,
			scopeRoot: scope,
		});

		await fs.unlink(linked);
		await fs.symlink(outside, linked);

		expect(authorized.path).toBe(path.join(await fs.realpath(target), "value.txt"));
		expect(await Bun.file(String(authorized.path)).text()).toBe("inside\n");
	});

	it("rejects URL, internal-resource and attachment aliases from filesystem tools", async () => {
		const { scope } = await fixture();

		for (const filePath of [
			"https://example.com/a",
			"local://docs/a",
			"artifact://1",
			"attachment://1",
			"Image #1",
		]) {
			expect(() => assertScoped(scope, "read", { path: filePath })).toThrow("outside the approved filesystem scope");
		}
		expect(() => assertScoped(scope, "inspect_image", { path: "attachment://1" })).toThrow(
			"outside the approved filesystem scope",
		);
	});

	it("guards isolated write tool path shapes and rejects unadapted tools", async () => {
		const { scope } = await fixture();

		expect(() => assertScoped(scope, "write", { path: "src/new.ts", content: "ok" })).not.toThrow();
		expect(() =>
			assertScoped(scope, "ast_edit", { paths: ["src/**/*.ts"], ops: [{ pat: "$A", out: "$B" }] }),
		).not.toThrow();
		expect(() =>
			assertScoped(scope, "apply_patch", {
				input: "*** Begin Patch\n*** Update File: src/inside.ts\n@@\n-old\n+new\n*** End Patch\n",
			}),
		).not.toThrow();
		expect(() =>
			assertScoped(scope, "edit", {
				path: "src/inside.ts",
				edits: [{ op: "update", rename: "../outside/moved.ts" }],
			}),
		).toThrow("path escapes the approved directory");
		expect(() => assertScoped(scope, "bash", { command: "pwd" })).toThrow("tool has no approved path-scope adapter");
	});

	it("fails closed for a non-absolute approval scope", async () => {
		const { scope } = await fixture();
		expect(() =>
			assertToolArgumentsWithinPathScope({
				args: { path: "src/inside.ts" },
				toolName: "read",
				cwd: scope,
				scopeRoot: "user",
			}),
		).toThrow("approved scope must be an absolute directory");
	});

	it("maps a scoped repository subtree into isolation and rejects an outside scope", () => {
		expect(rebaseToolPathScopeForIsolation("/repo/packages/app", "/repo", "/tmp/isolation")).toBe(
			"/tmp/isolation/packages/app",
		);
		expect(() => rebaseToolPathScopeForIsolation("/other", "/repo", "/tmp/isolation")).toThrow(
			"outside the isolated repository",
		);
	});
});
