/**
 * 端到端契约：客户端在会话进行中关闭 stdout 消费端（EPIPE）属于正常 transport
 * 断开，San RPC v2 必须：
 *   1. 不因 uncaughtException / unhandledRejection 而退出（无 EPIPE fatal）；
 *   2. 走正常 teardown，按时释放 session lease；
 *   3. 后续进程可无 SESSION_LOCKED 地重新打开同一会话。
 * 本测试为真实子进程集成测试：断管、teardown、lease 落盘都依赖真实平台时钟与
 * 内核管道时序，无法用假时钟驱动，因此 waitFor 使用真实时间轮询。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@san/utils";
import type { Subprocess } from "bun";

type RpcChild = Subprocess<"pipe", "pipe", "pipe">;

const tempDirectories: string[] = [];
const childProcesses: RpcChild[] = [];

afterEach(async () => {
	for (const child of childProcesses.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited.catch(() => undefined);
	}
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

async function prepareDirs(): Promise<{ agentDir: string; sessionDir: string; cwd: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-disconnect-"));
	tempDirectories.push(root);
	const agentDir = path.join(root, "agent");
	// 不带 --session-dir：会话文件与 RPC v2 的 session.open 索引（默认 agent 目录下的
	// sessions/）保持一致，否则 create 与 open 会指向两个目录。
	const sessionDir = path.join(agentDir, "sessions");
	const cwd = path.join(root, "cwd");
	await fs.mkdir(cwd, { recursive: true });
	// 关闭本地 keyless provider 发现：隔离环境下避免探测 localhost 的 Ollama 等。
	await Bun.write(path.join(agentDir, "config.yml"), "disabledProviders: [ollama, llama.cpp, lm-studio, vllm]\n");
	return { agentDir, sessionDir, cwd };
}

function spawnRpcV2(agentDir: string, cwd: string): RpcChild {
	const proc = Bun.spawn([process.execPath, cliPath, "--mode", "rpc", "--rpc-protocol", "2"], {
		cwd,
		env: { ...process.env, SAN_CODING_AGENT_DIR: agentDir, SAN_CONFIG_DIR: agentDir },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});
	childProcesses.push(proc);
	return proc;
}

interface RpcFrame {
	id?: string;
	result?: Record<string, unknown>;
	error?: { reason?: string; message?: string };
}

interface ClientHandle {
	proc: RpcChild;
	request: (id: string, method: string, params: unknown) => Promise<RpcFrame>;
	closeStdout: () => Promise<void>;
	stderrSoFar: () => string;
	endStdin: () => Promise<void>;
}

function connect(proc: RpcChild): ClientHandle {
	const decoder = new TextDecoder();
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
	let buffer = "";
	let stderrText = "";
	const pendingResponses = new Map<string, (frame: RpcFrame) => void>();

	void (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				try {
					const frame = JSON.parse(line) as RpcFrame;
					if (frame.id && pendingResponses.has(frame.id)) {
						pendingResponses.get(frame.id)?.(frame);
						pendingResponses.delete(frame.id);
					}
				} catch {
					// 通知帧无 id，忽略
				}
				nl = buffer.indexOf("\n");
			}
		}
	})();
	void (async () => {
		for (;;) {
			const { done, value } = await stderrReader.read();
			if (done) return;
			if (value) stderrText += decoder.decode(value);
		}
	})();

	return {
		proc,
		request(id, method, params) {
			const { promise, resolve } = Promise.withResolvers<RpcFrame>();
			pendingResponses.set(id, resolve);
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return promise;
		},
		closeStdout: async () => {
			await reader.cancel("test: client disconnected").catch(() => undefined);
		},
		stderrSoFar: () => stderrText,
		endStdin: async () => {
			await proc.stdin.end();
		},
	};
}

function initializeParams(cwd: string) {
	return {
		protocolVersion: "2.0",
		client: { name: "disconnect-test", version: "1.0" },
		cwd,
		capabilities: {
			"ui.interaction": { version: 1 },
			"host.tools": { version: 1 },
			"host.uri": { version: 1, schemes: ["file"] },
		},
	};
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(100);
	}
	return false;
}

describe("RPC v2 client disconnect", () => {
	test("stdout consumer loss is a clean teardown: no EPIPE fatal, lease released, session reopenable", async () => {
		const { agentDir, sessionDir, cwd } = await prepareDirs();
		const client = connect(spawnRpcV2(agentDir, cwd));
		// --- 阶段 1：建立会话后关闭 stdout 消费端 ---
		const init = await client.request("init", "initialize", initializeParams(cwd));
		expect(init.error).toBeUndefined();

		const created = await client.request("create-1", "session.create", {
			cwd,
			meta: { idempotencyKey: "create-1" },
		});
		expect(created.error).toBeUndefined();
		const sessionId = created.result?.sessionId as string;
		const leaseId = created.result?.leaseId as string;
		expect(sessionId).toBeTruthy();

		// 默认布局下会话文件位于 sessions/<encoded-cwd>/<file>.jsonl。
		const sessionFiles = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(sessionDir));
		expect(sessionFiles.length).toBeGreaterThan(0);
		const sessionFile = sessionFiles[0];
		const leaseFile = path.join(sessionDir, `${sessionFile}.rpc-v2.lease.json`);

		// 关闭 stdout 消费端（模拟 Desktop reader 释放管道），随后触发一次响应写入。
		await client.closeStdout();
		await Bun.sleep(300);
		void client.request("sync-1", "session.sync", { sessionId, leaseId, afterSequence: null }).catch(() => undefined);
		await client.endStdin();

		// 契约 1：无 EPIPE fatal —— 若进程退出，退出码必须是 0。
		const exited = await Promise.race([client.proc.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
		if (exited) expect(client.proc.exitCode, "clean exit expected").toBe(0);
		// 契约 2：lease 按时释放（与进程是否 linger 无关）。
		expect(
			await waitFor(async () => !(await Bun.file(leaseFile).exists()), 15_000),
			"session lease must be released after disconnect",
		).toBe(true);
		expect(client.stderrSoFar()).not.toContain("Uncaught Exception");
		expect(client.stderrSoFar()).not.toContain("EPIPE");

		// --- 阶段 2：新进程可重新打开同一会话（无 SESSION_LOCKED） ---
		const second = connect(spawnRpcV2(agentDir, cwd));
		const secondInit = await second.request("init", "initialize", initializeParams(cwd));
		expect(secondInit.error).toBeUndefined();
		const reopened = await second.request("open-2", "session.open", {
			sessionId,
			meta: { idempotencyKey: "open-2" },
		});
		expect(reopened.error, "session must not stay locked after disconnect").toBeUndefined();
		await second.endStdin();
	}, 120_000);
});
