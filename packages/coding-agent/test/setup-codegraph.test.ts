import { describe, expect, it } from "bun:test";
import { parseSetupArgs } from "@san/coding-agent/cli/setup-cli";
import {
	type CodeGraphSetupDependencies,
	checkCodeGraphSetup,
	isCodeGraphLocallyUsable,
} from "@san/coding-agent/code-intelligence/codegraph-installation";

const executable = "/opt/bin/codegraph";

function dependencies(
	status: unknown,
	options: { statusExitCode?: number; statusStderr?: string } = {},
): CodeGraphSetupDependencies {
	return {
		which: () => executable,
		run: async command => {
			if (command.includes("--version")) {
				return { exitCode: 0, stdout: "0.9.9\n", stderr: "" };
			}
			return {
				exitCode: options.statusExitCode ?? 0,
				stdout: JSON.stringify(status),
				stderr: options.statusStderr ?? "",
			};
		},
	};
}

describe("CodeGraph optional setup check", () => {
	it("reports a missing binary without disabling the local Explore fallback", async () => {
		const result = await checkCodeGraphSetup("/repo", { which: () => null });

		expect(result).toEqual({
			state: "missing",
			binaryAvailable: false,
			initialized: false,
			localBackend: "lsp-ast-text",
		});
		expect(isCodeGraphLocallyUsable(result)).toBe(false);
	});

	it("distinguishes an installed CLI from an initialized project", async () => {
		const result = await checkCodeGraphSetup("/repo", dependencies({ initialized: false, projectPath: "/repo" }));

		expect(result.state).toBe("unindexed");
		expect(result.version).toBe("0.9.9");
		expect(result.localBackend).toBe("lsp-ast-text");
		expect(isCodeGraphLocallyUsable(result)).toBe(false);
	});

	it("reports a ready index as the local Explore backend", async () => {
		const result = await checkCodeGraphSetup(
			"/repo/src",
			dependencies({
				initialized: true,
				projectPath: "/repo",
				pendingChanges: { added: 0, modified: 0, removed: 0 },
				worktreeMismatch: false,
			}),
		);

		expect(result.state).toBe("ready");
		expect(result.indexRoot).toBe("/repo");
		expect(result.localBackend).toBe("codegraph");
		expect(isCodeGraphLocallyUsable(result)).toBe(true);
	});

	it("surfaces pending file counts while keeping CodeGraph usable", async () => {
		const result = await checkCodeGraphSetup(
			"/repo",
			dependencies({
				initialized: true,
				projectPath: "/repo",
				pendingChanges: { added: 2, modified: 3, removed: 1 },
				worktreeMismatch: null,
			}),
		);

		expect(result.state).toBe("pending");
		expect(result.pendingChanges).toEqual({ added: 2, modified: 3, removed: 1 });
		expect(isCodeGraphLocallyUsable(result)).toBe(true);
	});

	it("surfaces a worktree mismatch as stale but still usable advisory graph data", async () => {
		const result = await checkCodeGraphSetup(
			"/repo",
			dependencies({
				initialized: true,
				projectPath: "/repo",
				pendingChanges: { added: 0, modified: 0, removed: 0 },
				worktreeMismatch: { indexed: "main", current: "feature" },
			}),
		);

		expect(result.state).toBe("stale");
		expect(result.worktreeMismatch).toBe(true);
		expect(isCodeGraphLocallyUsable(result)).toBe(true);
	});

	it("rejects a non-object status response without throwing", async () => {
		const result = await checkCodeGraphSetup("/repo", dependencies(null));

		expect(result.state).toBe("error");
		expect(result.error).toBe("CodeGraph status returned an invalid JSON object");
	});

	it("reports status command failures without throwing", async () => {
		const result = await checkCodeGraphSetup(
			"/repo",
			dependencies({}, { statusExitCode: 1, statusStderr: "database is locked" }),
		);

		expect(result.state).toBe("error");
		expect(result.error).toBe("database is locked");
		expect(result.localBackend).toBe("lsp-ast-text");
	});

	it("accepts codegraph as a setup component", () => {
		expect(parseSetupArgs(["setup", "codegraph", "--check", "--json"])).toEqual({
			component: "codegraph",
			flags: { check: true, json: true },
		});
	});
});
