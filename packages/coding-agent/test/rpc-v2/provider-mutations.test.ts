import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, removeWithRetries } from "@san/utils";
import type { Subprocess } from "bun";

interface RpcFrame {
	id?: string;
	result?: unknown;
	error?: {
		message: string;
		data: { reason: string; fieldErrors?: Array<{ path: string; reason: string }> };
	};
}

interface StoredModels {
	providers: Record<string, { baseUrl: string; models: Array<{ id: string; contextWindow?: number }> }>;
}

const roots: string[] = [];
const children: Array<Subprocess<"pipe", "pipe", "pipe">> = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const root of roots.splice(0)) await removeWithRetries(root);
});

describe("RPC v2 provider mutations over stdio", () => {
	test("validates metadata, persists model management, and replays removals without deleting another model", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-provider-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "cwd");
		await fs.mkdir(cwd);
		await Bun.write(path.join(agentDir, "config.yml"), "disabledProviders: [ollama, llama.cpp, lm-studio, vllm]\n");
		const modelsFile = Bun.file(path.join(agentDir, "models.yml"));
		await Bun.write(
			modelsFile,
			Bun.YAML.stringify({
				providers: {
					custom: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						auth: "none",
						models: [
							{ id: "remove-me", contextWindow: 800000, maxTokens: 128000, input: ["text", "image"] },
							{ id: "keep-me", contextWindow: 800000, maxTokens: 128000, input: ["text"] },
						],
					},
				},
			}),
		);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../../src/cli.ts"), "--mode", "rpc", "--rpc-protocol", "2"],
			{
				cwd,
				env: { ...process.env, SAN_CODING_AGENT_DIR: agentDir, SAN_CONFIG_DIR: agentDir },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		children.push(child);
		const stderr = new Response(child.stderr).text();
		const frames = readLines(child.stdout)[Symbol.asyncIterator]();
		const decoder = new TextDecoder();
		let sequence = 0;
		async function request(method: string, params: object): Promise<RpcFrame> {
			const id = String(++sequence);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			for (;;) {
				const next = await frames.next();
				if (next.done) throw new Error(`RPC exited before ${method}: ${await stderr}`);
				const frame = JSON.parse(decoder.decode(next.value)) as RpcFrame;
				if (frame.id === id) return frame;
			}
		}
		async function mutate(method: string, params: object): Promise<unknown> {
			const response = await request(method, { ...params, meta: { idempotencyKey: `${method}-${sequence}` } });
			expect(response.error).toBeUndefined();
			return response.result;
		}
		async function stored(): Promise<StoredModels> {
			return Bun.YAML.parse(await modelsFile.text()) as StoredModels;
		}

		const initialized = await request("initialize", {
			protocolVersion: "2.0",
			client: { name: "provider-contract-test", version: "1.0" },
		});
		expect(initialized.error).toBeUndefined();
		const remove = { providerId: "custom", modelId: "remove-me" };
		const original = await modelsFile.text();
		for (const params of [remove, { ...remove, meta: {} }, { ...remove, meta: { idempotencyKey: " " } }]) {
			const response = await request("provider.model.remove", params);
			expect(response.error?.data.reason).toBe("INVALID_PARAMS");
		}
		const unknownField = await request("provider.model.remove", {
			...remove,
			meta: { idempotencyKey: "remove" },
			force: true,
		});
		expect(unknownField.error?.data.fieldErrors).toContainEqual(
			expect.objectContaining({ path: "params.force", reason: "unknown_field" }),
		);
		expect(await modelsFile.text()).toBe(original);

		const params = { ...remove, meta: { idempotencyKey: "remove" } };
		expect((await request("provider.model.remove", params)).result).toEqual({ removed: true });
		const afterRemoval = await modelsFile.text();
		expect((await stored()).providers.custom.models.map(model => model.id)).toEqual(["keep-me"]);
		expect((await request("provider.model.remove", params)).result).toEqual({ removed: true });
		const conflict = await request("provider.model.remove", { ...params, modelId: "keep-me" });
		expect(conflict.error?.data.reason).toBe("IDEMPOTENCY_CONFLICT");
		expect(await modelsFile.text()).toBe(afterRemoval);

		await mutate("provider.model.add", { providerId: "custom", modelId: "added", contextWindow: 100000 });
		await mutate("provider.model.update", { providerId: "custom", modelId: "added", contextWindow: 800000 });
		expect((await stored()).providers.custom.models.find(model => model.id === "added")?.contextWindow).toBe(800000);
		expect(await mutate("provider.models.refresh", { providerId: "custom" })).toMatchObject({
			providerId: "custom",
			modelCount: 2,
		});
		await mutate("provider.config.update", { providerId: "custom", baseUrl: "http://127.0.0.1:2/v1" });
		expect((await stored()).providers.custom.baseUrl).toBe("http://127.0.0.1:2/v1");
		await mutate("provider.config.create", { providerId: "created", baseUrl: "http://127.0.0.1:1/v1", auth: "none" });
		expect((await stored()).providers.created.baseUrl).toBe("http://127.0.0.1:1/v1");
		expect(await mutate("provider.config.delete", { providerId: "created" })).toEqual({ removed: true });
		expect((await stored()).providers.created).toBeUndefined();
		expect((await stored()).providers.custom.models.map(model => model.id)).toEqual(["keep-me", "added"]);
	}, 30000);
});
