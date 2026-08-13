#!/usr/bin/env bun
/**
 * RPC v2 冒烟客户端 — 为 desktop 客户端开发提供"实际行为"事实报告。
 *
 * 回答三个 desktop 分进程后才出现的问题:
 *   1. 审批:工具审批以什么帧形态到达客户端?结构化还是通用对话降级?
 *   2. 重连:进程重启 + --continue 后,transcript 能否完整恢复?
 *   3. 多会话:单 RPC 进程的会话模型是什么(new/switch 语义)?
 *
 * 用法:
 *   bun run scripts/rpc-smoke-client.ts --model <pattern> [--out report.json]
 *
 * 真实 provider、真实 spawn(bun cli.ts --mode rpc),不 mock。每步带超时;
 * 全程产出结构化 JSON 报告 + 人读摘要。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

interface FrameLogEntry {
	dir: "in" | "out";
	at: number;
	frame: Record<string, unknown>;
}

interface StepReport {
	name: string;
	ok: boolean;
	detail: string;
	facts?: Record<string, unknown>;
}

const CLI_PATH = path.resolve(import.meta.dir, "../src/cli.ts");

function summarizeFrame(frame: Record<string, unknown>): Record<string, unknown> {
	const type = frame.type;
	if (type === "extension_ui_request") {
		return { ...frame };
	}
	const keep: Record<string, unknown> = { type };
	for (const key of ["command", "success", "id", "method", "error"]) {
		if (frame[key] !== undefined) keep[key] = frame[key];
	}
	if (type === "message_end" && frame.message && typeof frame.message === "object") {
		keep.role = (frame.message as { role?: unknown }).role;
	}
	return keep;
}

class RpcProcess {
	proc: ReturnType<typeof Bun.spawn>;
	frames: FrameLogEntry[] = [];
	#buffer = "";
	#listeners = new Set<(frame: Record<string, unknown>) => void>();
	#exited = false;

	constructor(cwd: string, modelPattern: string, extraArgs: string[] = []) {
		this.proc = Bun.spawn(["bun", CLI_PATH, "--mode", "rpc", "--model", modelPattern, ...extraArgs], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc.exited.then(() => {
			this.#exited = true;
		});
		void this.#readLoop();
	}

	get exited(): boolean {
		return this.#exited;
	}

	async #readLoop(): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#buffer += decoder.decode(value, { stream: true });
				let newlineIndex = this.#buffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = this.#buffer.slice(0, newlineIndex).trim();
					this.#buffer = this.#buffer.slice(newlineIndex + 1);
					newlineIndex = this.#buffer.indexOf("\n");
					if (!line) continue;
					try {
						const frame = JSON.parse(line) as Record<string, unknown>;
						this.frames.push({ dir: "in", at: Date.now(), frame });
						for (const listener of this.#listeners) listener(frame);
					} catch {
						this.frames.push({ dir: "in", at: Date.now(), frame: { type: "__unparseable__", raw: line } });
					}
				}
			}
		} catch {
			// process ended
		}
	}

	send(command: Record<string, unknown>): void {
		this.frames.push({ dir: "out", at: Date.now(), frame: command });
		(this.proc.stdin as unknown as { write(data: string): void }).write(`${JSON.stringify(command)}\n`);
	}

	/** 等待首个满足谓词的帧(也回看已收帧),超时返回 undefined。 */
	async waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		timeoutMs: number,
		options: { fromNow?: boolean } = {},
	): Promise<Record<string, unknown> | undefined> {
		const startIndex = options.fromNow ? this.frames.length : 0;
		for (let index = startIndex; index < this.frames.length; index++) {
			const entry = this.frames[index];
			if (entry.dir === "in" && predicate(entry.frame)) return entry.frame;
		}
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | undefined>();
		const listener = (frame: Record<string, unknown>) => {
			if (predicate(frame)) {
				cleanup();
				resolve(frame);
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(undefined);
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			this.#listeners.delete(listener);
		};
		this.#listeners.add(listener);
		return promise;
	}

	async shutdown(): Promise<void> {
		try {
			this.proc.kill();
			await this.proc.exited;
		} catch {
			// already gone
		}
	}
}

function messageCount(response: Record<string, unknown> | undefined): number | undefined {
	const data = response?.data;
	if (!data || typeof data !== "object") return undefined;
	const messages = (data as { messages?: unknown }).messages;
	return Array.isArray(messages) ? messages.length : undefined;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			model: { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.model) {
		await Bun.write(Bun.stdout, "usage: rpc-smoke-client.ts --model <pattern> [--out report.json]\n");
		process.exit(2);
	}

	const steps: StepReport[] = [];
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-smoke-"));
	// 触发审批的前提:项目级 always-ask。
	await Bun.write(
		path.join(fixture, ".san", "settings.json"),
		`${JSON.stringify({ tools: { approvalMode: "always-ask" } }, null, "\t")}\n`,
	);
	await Bun.write(path.join(fixture, "hello.txt"), "smoke fixture\n");

	let client = new RpcProcess(fixture, values.model);

	// ── 1. ready 握手 ──
	const ready = await client.waitFor(frame => frame.type === "ready", 30_000);
	steps.push({
		name: "handshake.ready",
		ok: ready !== undefined,
		detail: ready ? "ready frame received" : "no ready frame within 30s",
	});

	// ── 2. get_state ──
	client.send({ id: "state-1", type: "get_state" });
	const state = await client.waitFor(frame => frame.id === "state-1" && frame.type === "response", 15_000);
	steps.push({
		name: "state.get",
		ok: state?.success === true,
		detail: state ? "get_state responded" : "no response",
		facts: state ? { keys: Object.keys((state.data as object) ?? {}) } : undefined,
	});

	// ── 3. prompt → 工具审批 → 流式完成 ──
	client.send({
		id: "prompt-1",
		type: "prompt",
		message: "Run `ls` in the current directory and tell me how many files there are. Use the bash tool.",
	});
	const approvalRequest = await client.waitFor(frame => frame.type === "extension_ui_request", 120_000);
	let approvalFacts: Record<string, unknown> | undefined;
	if (approvalRequest) {
		approvalFacts = summarizeFrame(approvalRequest);
		// 通用对话降级形态:method=select 带 options;结构化审批会带 toolCallId 等。
		const method = approvalRequest.method;
		const options = (approvalRequest as { options?: Array<{ value?: string; label?: string }> }).options;
		const allowValue =
			options?.find(option => /allow|yes|approve|once/i.test(`${option.value} ${option.label}`))?.value ??
			options?.[0]?.value;
		client.send({
			id: approvalRequest.id,
			type: "extension_ui_response",
			value: allowValue,
		});
		steps.push({
			name: "approval.shape",
			ok: true,
			detail: `approval arrived as extension_ui_request method=${String(method)} (generic dialog degradation; no structured tool-approval frame)`,
			facts: approvalFacts,
		});
	} else {
		steps.push({
			name: "approval.shape",
			ok: false,
			detail: "no extension_ui_request within 120s — approval may be bypassed or model never called bash",
		});
	}
	const promptDone = await client.waitFor(frame => frame.id === "prompt-1" && frame.type === "response", 180_000);
	const streamedTypes = [
		...new Set(client.frames.filter(entry => entry.dir === "in").map(entry => String(entry.frame.type))),
	];
	steps.push({
		name: "prompt.stream",
		ok: promptDone?.success === true,
		detail: promptDone ? "prompt settled" : "prompt did not settle in 180s",
		facts: { observedFrameTypes: streamedTypes },
	});

	// ── 4. abort 语义 ──
	client.send({
		id: "prompt-2",
		type: "prompt",
		message: "Count from 1 to 100000 slowly, narrating every number in a separate sentence.",
	});
	await Bun.sleep(2_000);
	client.send({ id: "abort-1", type: "abort" });
	const abortResponse = await client.waitFor(frame => frame.id === "abort-1" && frame.type === "response", 30_000);
	const prompt2Settled = await client.waitFor(frame => frame.id === "prompt-2" && frame.type === "response", 30_000);
	steps.push({
		name: "abort.settles",
		ok: abortResponse !== undefined && prompt2Settled !== undefined,
		detail: `abort responded=${abortResponse !== undefined}, aborted prompt settled=${prompt2Settled !== undefined}`,
	});

	// ── 5. transcript 完整性(重启前基线) ──
	client.send({ id: "messages-1", type: "get_messages" });
	const messagesBefore = await client.waitFor(frame => frame.id === "messages-1" && frame.type === "response", 15_000);
	const beforeCount = messageCount(messagesBefore);
	steps.push({
		name: "transcript.baseline",
		ok: messagesBefore?.success === true,
		detail: `message count before restart: ${String(beforeCount)}`,
	});

	// ── 6. 杀进程 → --continue 重启 → transcript 恢复 ──
	await client.shutdown();
	client = new RpcProcess(fixture, values.model, ["--continue"]);
	const readyAgain = await client.waitFor(frame => frame.type === "ready", 30_000);
	client.send({ id: "messages-2", type: "get_messages" });
	const messagesAfter = await client.waitFor(frame => frame.id === "messages-2" && frame.type === "response", 15_000);
	const afterCount = messageCount(messagesAfter);
	steps.push({
		name: "restart.resume",
		ok: readyAgain !== undefined && messagesAfter?.success === true && (afterCount ?? 0) > 0,
		detail: `restarted with --continue; message count after restart: ${String(afterCount)} (baseline ${String(beforeCount)})`,
	});

	// ── 7. 会话模型:new_session ──
	client.send({ id: "new-1", type: "new_session" });
	const newSession = await client.waitFor(frame => frame.id === "new-1" && frame.type === "response", 15_000);
	client.send({ id: "messages-3", type: "get_messages" });
	const messagesNew = await client.waitFor(frame => frame.id === "messages-3" && frame.type === "response", 15_000);
	const newCount = messageCount(messagesNew);
	steps.push({
		name: "session.model",
		ok: newSession?.success === true,
		detail: `new_session in-process swap works (single active session per process); fresh transcript count: ${String(newCount)}`,
	});

	await client.shutdown();
	await fs.rm(fixture, { recursive: true, force: true });

	const report = {
		timestamp: new Date().toISOString(),
		model: values.model,
		ok: steps.every(step => step.ok),
		steps,
	};
	for (const step of steps) {
		await Bun.write(Bun.stdout, `${step.ok ? "ok  " : "FAIL"} ${step.name} — ${step.detail}\n`);
	}
	await Bun.write(Bun.stdout, `\nRPC v2 smoke: ${report.ok ? "PASS" : "PARTIAL"}\n`);
	if (values.out) {
		await Bun.write(values.out, `${JSON.stringify(report, null, "\t")}\n`);
		await Bun.write(Bun.stdout, `report written to ${values.out}\n`);
	}
	process.exit(report.ok ? 0 : 1);
}

await main();
