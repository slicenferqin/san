import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	chromiumExecutableProbeForTest,
	stealthIgnoreDefaultArgsForTest,
} from "@san/coding-agent/tools/browser/launch";
import { TempDir } from "@san/utils";

const EXECUTABLE_PROBE = path.resolve(import.meta.dir, "../fixtures/browser-executable-probe.ts");

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

describe("browser executable selection", () => {
	it.skipIf(process.platform === "win32")(
		"rejects executable wrappers that are not Chromium-family browsers",
		async () => {
			const tempDir = TempDir.createSync("@browser-probe-");
			try {
				const wrapper = path.join(tempDir.path(), "google-chrome");
				const chromium = path.join(tempDir.path(), "chromium");
				await Bun.write(wrapper, "#!/bin/sh\necho browser bridge\n");
				await Bun.write(chromium, "#!/bin/sh\necho Chromium 123.0\n");
				fs.chmodSync(wrapper, 0o755);
				fs.chmodSync(chromium, 0o755);

				await expect(chromiumExecutableProbeForTest(wrapper)).resolves.toBe(false);
				await expect(chromiumExecutableProbeForTest(chromium)).resolves.toBe(true);
			} finally {
				await tempDir.remove();
			}
		},
	);

	it.skipIf(process.platform === "win32")("rejects Chromium candidates without executable permission", async () => {
		const tempDir = TempDir.createSync("@browser-probe-permission-");
		try {
			const nonExecutable = path.join(tempDir.path(), "chromium");
			await Bun.write(nonExecutable, "#!/bin/sh\necho Chromium 123.0\n");
			fs.chmodSync(nonExecutable, 0o644);

			await expect(chromiumExecutableProbeForTest(nonExecutable)).resolves.toBe(false);
		} finally {
			await tempDir.remove();
		}
	});

	it.skipIf(process.platform === "win32")("bounds Chromium version probes that hang", async () => {
		const tempDir = TempDir.createSync("@browser-probe-hanging-");
		try {
			const hangingWrapper = path.join(tempDir.path(), "google-chrome");
			await Bun.write(hangingWrapper, "#!/bin/sh\nsleep 60\n");
			fs.chmodSync(hangingWrapper, 0o755);

			const startedAt = performance.now();
			await expect(chromiumExecutableProbeForTest(hangingWrapper)).resolves.toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(5_000);
		} finally {
			await tempDir.remove();
		}
	});

	it("honors PUPPETEER_EXECUTABLE_PATH before a detected Windows system Chrome", async () => {
		const tempDir = TempDir.createSync("@browser-executable-");
		try {
			const override = path.join(tempDir.path(), "chrome-headless-shell.exe");
			const systemChrome = path.join(tempDir.path(), "Google\\Chrome\\Application\\chrome.exe");
			await Bun.write(override, "override");
			await Bun.write(systemChrome, "system");

			const result = Bun.spawnSync([process.execPath, EXECUTABLE_PROBE], {
				env: {
					...process.env,
					SAN_BROWSER_PROBE_PLATFORM: "win32",
					ProgramFiles: tempDir.path(),
					"ProgramFiles(x86)": path.join(tempDir.path(), "missing-x86"),
					LOCALAPPDATA: path.join(tempDir.path(), "missing-local"),
					PUPPETEER_EXECUTABLE_PATH: override,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = new TextDecoder().decode(result.stderr);

			expect(result.exitCode, stderr).toBe(0);
			expect(new TextDecoder().decode(result.stdout)).toBe(override);
		} finally {
			await tempDir.remove();
		}
	});
});
