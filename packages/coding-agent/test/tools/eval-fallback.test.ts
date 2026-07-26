import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@san/coding-agent/config/settings";
import * as evalIndex from "@san/coding-agent/eval";
import * as pyKernel from "@san/coding-agent/eval/py/kernel";
import type { ToolSession } from "@san/coding-agent/tools";
import { EvalTool } from "@san/coding-agent/tools/eval";
import { resolveEvalBackends } from "@san/coding-agent/tools/eval-backends";

let originalSanPy: string | undefined;
let originalSanJs: string | undefined;
let originalSanRb: string | undefined;
let originalSanJl: string | undefined;
let originalPiPy: string | undefined;
let originalPiJs: string | undefined;
let originalPiRb: string | undefined;
let originalPiJl: string | undefined;

type EvalEnvFlag = "SAN_PY" | "SAN_JS" | "SAN_RB" | "SAN_JL" | "PI_PY" | "PI_JS" | "PI_RB" | "PI_JL";

function restoreEnv(name: EvalEnvFlag, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool language dispatch", () => {
	beforeEach(() => {
		originalSanPy = Bun.env.SAN_PY;
		originalSanJs = Bun.env.SAN_JS;
		originalSanRb = Bun.env.SAN_RB;
		originalSanJl = Bun.env.SAN_JL;
		originalPiPy = Bun.env.PI_PY;
		originalPiJs = Bun.env.PI_JS;
		originalPiRb = Bun.env.PI_RB;
		originalPiJl = Bun.env.PI_JL;
		delete Bun.env.SAN_PY;
		delete Bun.env.SAN_JS;
		delete Bun.env.SAN_RB;
		delete Bun.env.SAN_JL;
		delete Bun.env.PI_PY;
		delete Bun.env.PI_JS;
		delete Bun.env.PI_RB;
		delete Bun.env.PI_JL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("SAN_PY", originalSanPy);
		restoreEnv("SAN_JS", originalSanJs);
		restoreEnv("SAN_RB", originalSanRb);
		restoreEnv("SAN_JL", originalSanJl);
		restoreEnv("PI_PY", originalPiPy);
		restoreEnv("PI_JS", originalPiJs);
		restoreEnv("PI_RB", originalPiRb);
		restoreEnv("PI_JL", originalPiJl);
	});

	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			language: "js",
			code: "const x = 1;",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			language: "py",
			code: "print('hi')",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("dispatches each call to the backend named by its language", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", { language: "py", code: "x = 1" });
		await tool.execute("call-js", { language: "js", code: "const y = 2;" });

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				language: "py",
				code: "print('hi')",
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("lets SAN_PY override settings for eval backends", () => {
		Bun.env.SAN_PY = "1";
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		settings.set("eval.js", false);

		expect(resolveEvalBackends(makeSession(settings))).toEqual({
			python: true,
			js: false,
			ruby: false,
			julia: false,
		});
	});

	it("lets SAN_JS disable js execution even when eval.js is enabled", async () => {
		Bun.env.SAN_JS = "0";
		const settings = Settings.isolated();
		settings.set("eval.js", true);
		const tool = new EvalTool(makeSession(settings));

		await expect(
			tool.execute("call-js-env-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/SAN_JS=0/);
	});
});
