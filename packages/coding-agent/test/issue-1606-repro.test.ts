/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1606
 *
 * On Windows, `onnxruntime-node`'s NAPI finalizer segfaults Bun during
 * shutdown after `@huggingface/transformers` loads a local tiny model in a
 * Worker thread. The worker therefore lives in a child process and is killed
 * with SIGKILL on shutdown so the finalizer never runs in the agent process.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createTinyModelSubprocess } from "@san/coding-agent/tiny/client";

describe("issue #1606 — tiny model lives in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// Run the smoke probe in a child Bun process: the test runner owns its own
		// IPC channel and can starve nested subprocess IPC on some Bun builds.
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const script =
			'const { smokeTestTinyModelWorker } = await import("@san/coding-agent/tiny/client"); await smokeTestTinyModelWorker({ timeoutMs: 15000 });';
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(`${stdout}${stderr}`).toBe("");
		expect(exitCode).toBe(0);
	}, 30_000);

	it("surfaces unexpected signal exits so in-flight callers do not await forever", async () => {
		const sub = createTinyModelSubprocess();
		try {
			const { promise, resolve } = Promise.withResolvers<Error>();
			sub.errors.add(resolve);
			sub.proc.kill("SIGKILL");
			const err = await promise;
			expect(err.message).toMatch(/signal/i);
		} finally {
			try {
				sub.proc.kill("SIGKILL");
			} catch {}
			await sub.proc.exited;
		}
	}, 15_000);

	it("does not surface intentional terminate SIGKILLs as worker errors", async () => {
		const sub = createTinyModelSubprocess();
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		await sub.proc.exited;
		await Bun.sleep(20);
		expect(errored).toBe(false);
	}, 10_000);
});
