import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { getUserPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getAgentDir } from "@oh-my-pi/pi-utils";

describe("SAN_CONFIG_DIR", () => {
	const originalSan = process.env.SAN_CONFIG_DIR;
	const originalPi = process.env.PI_CONFIG_DIR;
	afterEach(() => {
		if (originalSan === undefined) {
			delete process.env.SAN_CONFIG_DIR;
		} else {
			process.env.SAN_CONFIG_DIR = originalSan;
		}
		if (originalPi === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalPi;
		}
	});

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".san/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects SAN_CONFIG_DIR for user base", () => {
		process.env.SAN_CONFIG_DIR = ".config/san";
		delete process.env.PI_CONFIG_DIR;
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/san", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".san", level: "user" });
	});
});
