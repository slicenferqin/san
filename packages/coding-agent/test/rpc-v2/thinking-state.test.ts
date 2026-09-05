import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "@san/coding-agent/modes/rpc-v2/dto/events";
import { readLines, removeWithRetries } from "@san/utils";
import type { Server, Subprocess } from "bun";

interface RpcFrame {
	id?: string;
	method?: string;
	params?: SessionEvent;
	result?: unknown;
	error?: { message: string };
}

interface ThinkingState {
	configured: string | null;
	effective: string | null;
}

const roots: string[] = [];
const children: Array<Subprocess<"pipe", "pipe", "pipe">> = [];
const servers: Server<undefined>[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const server of servers.splice(0)) await server.stop(true);
	for (const root of roots.splice(0)) await removeWithRetries(root);
});

test("RPC model switching keeps displayed thinking equal to the outgoing effort and replays changes", async () => {
	const requests: Array<{ model: string; reasoning_effort?: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) {
				return new Response("Unexpected fixture request", { status: 404 });
			}
			const body = (await request.json()) as { model: string; reasoning_effort?: string };
			requests.push(body);
			const chunk = { id: "local-reply", object: "chat.completion.chunk", created: 1, model: body.model };
			return new Response(
				[
					`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Verified." }, finish_reason: null }] })}\n\n`,
					`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
					"data: [DONE]\n\n",
				].join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	servers.push(server);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-thinking-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.mkdir(cwd);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		Bun.YAML.stringify({
			disabledProviders: ["ollama", "llama.cpp", "lm-studio", "vllm"],
			modelRoles: { default: "local-thinking/source" },
			compaction: { enabled: false },
		}),
	);
	const common = {
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 4096,
		input: ["text"],
		compat: { supportsReasoningEffort: true },
	};
	const efforts = ["low", "medium", "high", "xhigh"];
	await Bun.write(
		path.join(agentDir, "models.yml"),
		Bun.YAML.stringify({
			providers: {
				"local-thinking": {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					api: "openai-completions",
					apiKey: "local-test-key",
					models: [
						{ ...common, id: "source", thinking: { mode: "effort", efforts, defaultLevel: "medium" } },
						{ ...common, id: "target", thinking: { mode: "effort", efforts, defaultLevel: "high" } },
						{
							...common,
							id: "limited",
							thinking: { mode: "effort", efforts: ["low", "medium"], defaultLevel: "low" },
						},
						{ ...common, id: "plain", reasoning: false },
					],
				},
			},
		}),
	);
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "../../src/cli.ts"), "--mode", "rpc", "--rpc-protocol", "2"],
		{
			cwd,
			env: { ...process.env, SAN_CONFIG_DIR: agentDir, SAN_CODING_AGENT_DIR: agentDir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	children.push(child);
	const stderr = new Response(child.stderr).text();
	const frames = readLines(child.stdout)[Symbol.asyncIterator]();
	const decoder = new TextDecoder();
	const events: SessionEvent[] = [];
	let sequence = 0;
	async function nextFrame(): Promise<RpcFrame> {
		const next = await frames.next();
		if (next.done) throw new Error(`RPC exited: ${await stderr}`);
		const frame = JSON.parse(decoder.decode(next.value)) as RpcFrame;
		if (frame.method === "session.event" && frame.params) events.push(frame.params);
		return frame;
	}
	async function request<T>(method: string, params: object): Promise<T> {
		const id = String(++sequence);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		for (;;) {
			const frame = await nextFrame();
			if (frame.id !== id) continue;
			if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
			return frame.result as T;
		}
	}
	async function mutate<T>(method: string, params: object): Promise<T> {
		return request<T>(method, { ...params, meta: { idempotencyKey: `${method}-${sequence}` } });
	}
	await request("initialize", { protocolVersion: "2.0", client: { name: "thinking-contract-test", version: "1.0" } });
	const session = await mutate<{ sessionId: string; leaseId: string }>("session.create", { cwd });
	const sessionParams = { sessionId: session.sessionId, leaseId: session.leaseId };
	async function snapshotThinking(): Promise<{ configured?: string; effective?: string }> {
		const sync = await request<{ snapshot: { thinking: { configured?: string; effective?: string } } }>(
			"session.sync",
			{ ...sessionParams, afterSequence: null },
		);
		return sync.snapshot.thinking;
	}
	async function select(modelId: string): Promise<{ thinkingState: ThinkingState }> {
		return mutate("model.select", { ...sessionParams, provider: "local-thinking", modelId });
	}
	await snapshotThinking();
	await select("source");
	await mutate("thinking.set", { ...sessionParams, level: "low" });
	const selected = await select("target");
	expect(selected.thinkingState).toEqual({ configured: "low", effective: "low" });
	expect(await snapshotThinking()).toEqual({ configured: "low", effective: "low" });
	const run = await mutate<{ runId: string }>("run.start", {
		...sessionParams,
		content: [{ type: "text", text: "Reply briefly." }],
	});
	while (!events.some(event => event.runId === run.runId && ["run.completed", "run.failed"].includes(event.type)))
		await nextFrame();
	expect(events.find(event => event.runId === run.runId && event.type === "run.completed")).toBeDefined();
	expect(new Set(requests.filter(body => body.model === "target").map(body => body.reasoning_effort))).toEqual(
		new Set(["low"]),
	);

	await mutate("thinking.set", { ...sessionParams, level: "xhigh" });
	const beforeFallback = (
		await request<{ lastSequence: number }>("session.events.list", { sessionId: session.sessionId })
	).lastSequence;
	expect((await select("limited")).thinkingState).toEqual({ configured: "low", effective: "low" });
	expect(await snapshotThinking()).toEqual({ configured: "low", effective: "low" });
	const changed = await request<{ events: SessionEvent[] }>("session.events.list", {
		sessionId: session.sessionId,
		afterSequence: beforeFallback,
		types: ["thinking.changed"],
	});
	expect(changed.events.map(event => event.data)).toEqual([{ configured: "low", effective: "low" }]);
	expect(changed.events[0].durability).toBe("durable");
	expect(
		events
			.filter(event => event.type === "thinking.changed" && event.sequence > beforeFallback)
			.map(event => event.data),
	).toEqual([{ configured: "low", effective: "low" }]);

	const beforeClear = changed.events[0].sequence;
	expect((await select("plain")).thinkingState).toEqual({ configured: null, effective: null });
	expect(await snapshotThinking()).toEqual({});
	const cleared = await request<{ events: SessionEvent[] }>("session.events.list", {
		sessionId: session.sessionId,
		afterSequence: beforeClear,
		types: ["thinking.changed"],
	});
	expect(cleared.events.map(event => event.data)).toEqual([{ configured: null, effective: null }]);
	expect(
		events
			.filter(event => event.type === "thinking.changed" && event.sequence > beforeClear)
			.map(event => event.data),
	).toEqual([{ configured: null, effective: null }]);
}, 30000);
