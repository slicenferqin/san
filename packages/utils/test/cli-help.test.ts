import { describe, expect, it, spyOn } from "bun:test";
import { Args, Command, type CommandEntry, Flags, run } from "../src/cli";

class GoodCommand extends Command {
	static description = "prints good things";
	static flags = {
		verbose: Flags.boolean({ description: "be loud" }),
	};
	async run(): Promise<void> {}
}

class ExportLikeCommand extends Command {
	static description = "exports sessions";
	static args = {
		sessions: Args.string({ description: "session selectors", required: true, multiple: true }),
	};
	static flags = {
		format: Flags.string({ description: "output format", default: "json" }),
	};
	async run(): Promise<void> {
		await this.parse(ExportLikeCommand);
	}
}

describe("run() per-command help", () => {
	// Contract: `omp <cmd> --help` must load only the requested command module.
	// Loading the whole table would let any unrelated command whose import
	// hangs or crashes take down every per-command help invocation.
	it("loads only the requested command", async () => {
		let brokenLoads = 0;
		const commands: CommandEntry[] = [
			{ name: "good", load: async () => GoodCommand },
			{
				name: "broken",
				load: async () => {
					brokenLoads++;
					throw new Error("import-time crash");
				},
			},
		];
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await run({ bin: "omp", version: "0.0.0", argv: ["good", "--help"], commands });
		} finally {
			stdoutSpy.mockRestore();
		}
		expect(brokenLoads).toBe(0);
		expect(writes.join("")).toContain("prints good things");
		expect(writes.join("")).toContain("--verbose");
	});
});

describe("run() usage errors", () => {
	// Contract: a missing required arg prints a concise `error:` + USAGE line to
	// stderr and exits 1 — it must NOT throw past run() (which would dump a
	// minified `dist/cli.js` code frame). Regression for #5369.
	it("prints a concise usage error instead of throwing on a missing required arg", async () => {
		const commands: CommandEntry[] = [{ name: "export", load: async () => ExportLikeCommand }];
		const errs: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
			errs.push(String(chunk));
			return true;
		});
		const prevExitCode = process.exitCode;
		try {
			await expect(run({ bin: "san", version: "0.0.0", argv: ["export"], commands })).resolves.toBeUndefined();
		} finally {
			stderrSpy.mockRestore();
			process.exitCode = prevExitCode ?? 0;
		}
		const out = errs.join("");
		expect(out).toContain("error: Missing required argument: sessions");
		expect(out).toContain("$ san export SESSIONS... [FLAGS]");
		expect(out).not.toContain("dist/cli.js");
	});

	// Contract: `--help` USAGE renders a required variadic as `SESSIONS...`, never
	// the misleading optional `[SESSIONS]`. Regression for #5369.
	it("renders a required variadic arg without optional brackets", async () => {
		const commands: CommandEntry[] = [{ name: "export", load: async () => ExportLikeCommand }];
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await run({ bin: "san", version: "0.0.0", argv: ["export", "--help"], commands });
		} finally {
			stdoutSpy.mockRestore();
		}
		const out = writes.join("");
		expect(out).toContain("$ san export SESSIONS... [FLAGS]");
		expect(out).not.toContain("[SESSIONS]");
	});

	it("prints a concise usage error for an unknown flag", async () => {
		const commands: CommandEntry[] = [{ name: "export", load: async () => ExportLikeCommand }];
		const errs: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
			errs.push(String(chunk));
			return true;
		});
		const prevExitCode = process.exitCode;
		try {
			await expect(
				run({ bin: "san", version: "0.0.0", argv: ["export", "--unknown"], commands }),
			).resolves.toBeUndefined();
		} finally {
			stderrSpy.mockRestore();
			process.exitCode = prevExitCode ?? 0;
		}
		const out = errs.join("");
		expect(out).toContain("error: Unknown option '--unknown'");
		expect(out).toContain("$ san export SESSIONS... [FLAGS]");
	});
});
