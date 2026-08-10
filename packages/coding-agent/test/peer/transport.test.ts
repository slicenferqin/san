import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type CrossSessionClient, createCrossSessionClient, shutdownPeersBroker } from "../../src/peer/client";
import { PEERS_PID_FILE, PEERS_TOKEN_FILE, peersBrokerEndpoint } from "../../src/peer/paths";
import {
	type CrossSessionMessage,
	type CrossSessionStatus,
	MAX_PEERS_ACTIVITY_BYTES,
	MAX_PEERS_BRANCH_BYTES,
	MAX_PEERS_CWD_BYTES,
	MAX_PEERS_DISPLAY_NAME_BYTES,
	MAX_PEERS_LINE_BYTES,
	MAX_PEERS_MESSAGE_BODY_BYTES,
	MAX_PEERS_SESSION_ID_BYTES,
	PEERS_IDLE_GRACE_ENV,
	PEERS_REGISTRATION_TIMEOUT_ENV,
	PEERS_RUNTIME_DIR_ENV,
	type PeersBrokerMessage,
} from "../../src/peer/protocol";

const trackedClients: CrossSessionClient[] = [];
const trackedDirs: string[] = [];

async function runtimeDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "san-peers-test-"));
	trackedDirs.push(dir);
	return dir;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

async function waitForBroker(endpoint: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const attempt = Promise.withResolvers<void>();
		const socket = net.createConnection({ path: endpoint });
		socket.once("connect", () => {
			socket.destroy();
			attempt.resolve();
		});
		socket.once("error", () => {
			socket.destroy();
			attempt.reject();
		});
		try {
			await attempt.promise;
			return true;
		} catch {
			if (Date.now() >= deadline) return false;
			await Bun.sleep(50);
		}
	}
}

/** Spawn a broker worker process directly against a runtime directory. */
async function spawnBrokerWorker(dir: string, extraEnv: Record<string, string>): Promise<PipedChild> {
	const brokerUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "..", "src", "peer", "broker.ts")).href;
	const script = `import(${JSON.stringify(brokerUrl)}).then(({ startPeersBrokerFromEnvironment }) => startPeersBrokerFromEnvironment()).catch(error => { process.stderr.write(String(error) + "\\n"); process.exit(1); });`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		cwd: dir,
		env: childEnv({ [PEERS_RUNTIME_DIR_ENV]: dir, ...extraEnv }),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	void drainStream(child.stdout).catch(() => undefined);
	void drainStream(child.stderr).catch(() => undefined);
	return child;
}

interface TestPeer {
	client: CrossSessionClient;
	cwd: string;
	state: { sessionId: string; displayName: string; cwd: string; status: CrossSessionStatus };
	deliveries: { message: CrossSessionMessage; expectsReply: boolean }[];
}

async function makePeer(
	runtimeDir: string,
	index: number,
	customDeliver?: (message: CrossSessionMessage, options: { expectsReply: boolean }) => Promise<"injected" | "woken">,
	idleGraceMs = 60_000,
): Promise<TestPeer> {
	const cwd = path.join(runtimeDir, `peer-${index}`);
	const state = {
		sessionId: `test-${index}`,
		displayName: `peer ${index}`,
		cwd,
		status: "idle" as CrossSessionStatus,
	};
	const deliveries: TestPeer["deliveries"] = [];
	const client = await createCrossSessionClient({
		runtimeDir,
		idleGraceMs,
		metadata: () => ({ ...state }),
		deliver: async (message, options) => {
			deliveries.push({ message, expectsReply: options.expectsReply });
			if (customDeliver) return customDeliver(message, options);
			return "injected";
		},
	});
	trackedClients.push(client);
	return { client, cwd, state, deliveries };
}

interface RawWirePeer {
	token: string;
	send(message: unknown): void;
	sendRaw(line: string): void;
	next(timeoutMs?: number): Promise<PeersBrokerMessage>;
	closed: Promise<void>;
	close(): void;
}

async function rawWirePeer(runtimeDir: string): Promise<RawWirePeer> {
	const token = (await Bun.file(path.join(runtimeDir, PEERS_TOKEN_FILE)).text()).trim();
	const endpoint = peersBrokerEndpoint(runtimeDir);
	const socket = net.createConnection({ path: endpoint });
	const connected = Promise.withResolvers<void>();
	socket.once("connect", connected.resolve);
	socket.once("error", connected.reject);
	await connected.promise;
	socket.setEncoding("utf8");
	let buffer = "";
	const queue: PeersBrokerMessage[] = [];
	const waiters: {
		resolve: (message: PeersBrokerMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}[] = [];
	const closed = Promise.withResolvers<void>();
	socket.once("close", () => closed.resolve());
	socket.on("data", (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line) as PeersBrokerMessage;
			const waiter = waiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			} else {
				queue.push(message);
			}
		}
	});
	socket.on("error", () => {
		// The close event settles the closed promise.
	});
	return {
		token,
		send: message => socket.write(`${JSON.stringify(message)}\n`),
		sendRaw: line => socket.write(line),
		next: (timeoutMs = 5_000) => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const waiting = Promise.withResolvers<PeersBrokerMessage>();
			const timer = setTimeout(
				() => waiting.reject(new Error("raw peer timed out waiting for a broker message")),
				timeoutMs,
			);
			waiters.push({
				resolve: message => {
					clearTimeout(timer);
					waiting.resolve(message);
				},
				reject: error => {
					clearTimeout(timer);
					waiting.reject(error);
				},
				timer,
			});
			return waiting.promise;
		},
		closed: closed.promise,
		close: () => socket.destroy(),
	};
}

function helloFrame(token: string, id: string, cwd = "/tmp"): Record<string, unknown> {
	return {
		type: "hello",
		token,
		id,
		peer: { sessionId: `raw-${id}`, displayName: `raw ${id}`, cwd, status: "idle" },
	};
}

function hangingDeliver(): Promise<"injected"> {
	return Promise.withResolvers<"injected">().promise;
}
type PipedChild = Bun.Subprocess<"pipe", "pipe", "pipe">;

function childEnv(overlay: Record<string, string>): Record<string, string> {
	const base = process.env as Record<string, string | undefined>;
	const env: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") env[key] = value;
	}
	for (const key in overlay) env[key] = overlay[key];
	return env;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** Consume a child's stdout one newline-delimited JSON line at a time. */
function childLineReader(stream: ReadableStream<Uint8Array>): () => Promise<string | null> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async () => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				return line;
			}
			const { done, value } = await reader.read();
			if (done) {
				const tail = buffer;
				buffer = "";
				return tail.length > 0 ? tail : null;
			}
			buffer += decoder.decode(value, { stream: true });
		}
	};
}

async function nextChildLine(read: () => Promise<string | null>, timeoutMs: number, label: string): Promise<string> {
	const line = await withTimeout(read(), timeoutMs, label);
	if (line === null) throw new Error(`${label}: child exited without reporting`);
	return line;
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

async function terminateChild(child: PipedChild, label: string): Promise<void> {
	try {
		child.stdin.write("quit\n");
		child.stdin.end();
	} catch {
		// stdin is already closed; the kill paths below handle stragglers.
	}
	try {
		await withTimeout(child.exited, 5_000, `${label} exit`);
		return;
	} catch {
		// Fall through to forced termination.
	}
	child.kill();
	try {
		await withTimeout(child.exited, 5_000, `${label} SIGTERM`);
	} catch {
		child.kill("SIGKILL");
		await child.exited.catch(() => undefined);
	}
}

/**
 * Body of each child process in the two-child transport test. The child
 * registers one client against the shared isolated runtime directory and
 * speaks a bounded newline-delimited JSON protocol: it announces readiness,
 * prints every inbound delivery, and answers `send`, `reply`, `list`, and
 * `quit` commands read from stdin. The parent never shells out; it drives
 * both children purely through these pipes.
 */
function childScript(clientUrl: string): string {
	return `
import(${JSON.stringify(clientUrl)}).then(async ({ createCrossSessionClient }) => {
	const runtimeDir = process.env.SAN_PEERS_TEST_RUNTIME;
	if (!runtimeDir) {
		process.stderr.write("missing SAN_PEERS_TEST_RUNTIME\\n");
		process.exit(2);
	}
	const client = await createCrossSessionClient({
		runtimeDir,
		idleGraceMs: 60_000,
		metadata: () => ({
			sessionId: "child",
			displayName: "child",
			cwd: process.cwd(),
			status: "idle",
		}),
		deliver: async message => {
			process.stdout.write(JSON.stringify({ t: "deliver", id: message.id, from: message.from, body: message.body, replyTo: message.replyTo ?? null }) + "\\n");
			return "injected";
		},
	});
	process.stdout.write(JSON.stringify({ t: "ready", id: client.id }) + "\\n");
	const commands = {
		send: async args => {
			const space = args.indexOf(" ");
			const to = space < 0 ? args : args.slice(0, space);
			const body = space < 0 ? "" : args.slice(space + 1);
			try {
				const receipt = await client.send({ to, body });
				process.stdout.write(JSON.stringify({ t: "send", ok: true, outcome: receipt.outcome }) + "\\n");
			} catch (error) {
				process.stdout.write(JSON.stringify({ t: "send", ok: false, error: String(error instanceof Error ? error.message : error) }) + "\\n");
			}
		},
		list: async () => {
			const peers = await client.list();
			process.stdout.write(JSON.stringify({ t: "list", peers: peers.map(peer => ({ id: peer.id, cwd: peer.cwd })) }) + "\\n");
		},
		reply: async args => {
			const parts = args.split(" ");
			const to = parts[0] ?? "";
			const replyTo = parts[1] ?? "";
			const body = parts.slice(2).join(" ");
			try {
				const receipt = await client.send({ to, body, replyTo });
				process.stdout.write(JSON.stringify({ t: "reply", ok: true, outcome: receipt.outcome }) + "\\n");
			} catch (error) {
				process.stdout.write(JSON.stringify({ t: "reply", ok: false, error: String(error instanceof Error ? error.message : error) }) + "\\n");
			}
		},
		quit: async () => {
			await client.close();
			process.exit(0);
		},
	};
	const stdinReader = Bun.stdin.stream().getReader();
	const lineDecoder = new TextDecoder();
	let input = "";
	for (;;) {
		const { done, value } = await stdinReader.read();
		if (done) break;
		input += lineDecoder.decode(value, { stream: true });
		for (;;) {
			const newline = input.indexOf("\\n");
			if (newline < 0) break;
			const line = input.slice(0, newline).trim();
			input = input.slice(newline + 1);
			if (!line) continue;
			const space = line.indexOf(" ");
			const command = space < 0 ? line : line.slice(0, space);
			const args = space < 0 ? "" : line.slice(space + 1);
			const handler = commands[command];
			if (!handler) {
				process.stdout.write(JSON.stringify({ t: "error", error: "unknown command: " + command }) + "\\n");
				continue;
			}
			await handler(args);
		}
	}
	await client.close();
	process.exit(0);
}).catch(error => {
	process.stderr.write(String(error) + "\\n");
	process.exit(1);
});
`;
}

afterEach(async () => {
	for (const client of trackedClients.splice(0)) await client.close();
	for (const dir of trackedDirs.splice(0)) {
		await shutdownPeersBroker(dir);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("cross-session transport", () => {
	it("discovers peers across different cwd values and excludes the caller", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		expect(beta.client.id).toMatch(/^san:[0-9a-f]{12}$/);

		const peers = await alpha.client.list();
		expect(peers.map(peer => peer.id)).toEqual([beta.client.id]);
		const betaRow = peers[0]!;
		expect(betaRow.cwd).toBe(beta.cwd);
		expect(betaRow.sessionId).toBe("test-1");
		expect(betaRow.displayName).toBe("peer 1");
		expect(betaRow.status).toBe("idle");
		expect(betaRow.connectedAt).toBeGreaterThan(0);
		expect(betaRow.lastActivity).toBeGreaterThanOrEqual(betaRow.connectedAt);

		const reverse = await beta.client.list();
		expect(reverse.map(peer => peer.id)).toEqual([alpha.client.id]);
	});

	it("starts one broker when two clients race the first connection", async () => {
		const dir = await runtimeDir();
		const [alpha, beta] = await Promise.all([makePeer(dir, 0), makePeer(dir, 1)]);
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
		expect((await beta.client.list()).map(peer => peer.id)).toEqual([alpha.client.id]);
	});

	it("delivers exactly once with an accurate injected receipt", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		const receipt = await alpha.client.send({ to: beta.client.id, body: "hello once", expectsReply: true });
		expect(receipt).toEqual({ to: beta.client.id, outcome: "injected" });
		expect(beta.deliveries).toHaveLength(1);
		const delivered = beta.deliveries[0]!.message;
		expect(delivered.body).toBe("hello once");
		expect(delivered.from).toBe(alpha.client.id);
		expect(delivered.to).toBe(beta.client.id);
		expect(delivered.ts).toBeGreaterThan(0);
		expect(beta.deliveries[0]!.expectsReply).toBeTrue();
		// Deterministic duplicate-delivery barrier: any extra forward would
		// have been written before the broker answered this request, so by
		// the time the result arrives every forwarded message was delivered.
		await beta.client.list();
		expect(beta.deliveries).toHaveLength(1);
	});

	it("returns accurate woken and failed receipts", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const woken = await makePeer(dir, 1, async () => "woken");
		const failing = await makePeer(dir, 2, async () => {
			throw new Error("deliver boom");
		});
		expect((await alpha.client.send({ to: woken.client.id, body: "wake" })).outcome).toBe("woken");
		const failed = await alpha.client.send({ to: failing.client.id, body: "fail" });
		expect(failed.outcome).toBe("failed");
		expect(failed.error).toBe("deliver boom");
	});

	it("preserves replyTo and supports a reply round trip", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		const receipt = await alpha.client.send({ to: beta.client.id, body: "question", replyTo: "msg-7" });
		expect(receipt.outcome).toBe("injected");
		const inbound = beta.deliveries[0]!.message;
		expect(inbound.replyTo).toBe("msg-7");
		const replyReceipt = await beta.client.send({ to: inbound.from, body: "answer", replyTo: inbound.id });
		expect(replyReceipt.outcome).toBe("injected");
		const reply = alpha.deliveries[0]!.message;
		expect(reply.body).toBe("answer");
		expect(reply.replyTo).toBe(inbound.id);
	});

	it("preserves a handoff kind end to end", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		const receipt = await alpha.client.send({ to: beta.client.id, body: "handoff summary", kind: "handoff" });
		expect(receipt).toEqual({ to: beta.client.id, outcome: "injected" });
		const delivered = beta.deliveries[0]!.message;
		expect(delivered.kind).toBe("handoff");
		expect(delivered.body).toBe("handoff summary");
		expect(delivered.from).toBe(alpha.client.id);
		expect(delivered.to).toBe(beta.client.id);
		expect(delivered.id.length).toBeGreaterThan(20);
		expect(delivered.ts).toBeGreaterThan(0);
	});

	it("omits kind from ordinary send wire frames", async () => {
		const dir = await runtimeDir();
		// Bootstrap the broker and its token file before opening raw sockets.
		const alpha = await makePeer(dir, 0);
		const sender = await rawWirePeer(dir);
		const recipient = await rawWirePeer(dir);
		expect(alpha.client.id).toMatch(/^san:[0-9a-f]{12}$/);
		sender.send(helloFrame(sender.token, "san:aaaabbbbcccc"));
		expect((await sender.next()).type).toBe("hello-ok");
		recipient.send(helloFrame(recipient.token, "san:dddd11112222"));
		expect((await recipient.next()).type).toBe("hello-ok");
		sender.send({
			type: "send",
			token: sender.token,
			id: "plain-1",
			message: { to: "san:dddd11112222", body: "plain" },
			expectsReply: false,
		});
		const forwarded = await recipient.next();
		expect(forwarded.type).toBe("message");
		if (forwarded.type === "message") {
			expect(forwarded.message.kind).toBeUndefined();
			expect("kind" in forwarded.message).toBeFalse();
		}
		// Ack so the sender's pending delivery resolves instead of timing out.
		if (forwarded.type === "message") {
			recipient.send({
				type: "ack",
				token: recipient.token,
				messageId: forwarded.message.id,
				outcome: "injected",
			});
		}
		const result = await sender.next();
		expect(result.type).toBe("result");
		if (result.type === "result") expect(result.ok).toBeTrue();
		sender.close();
		recipient.close();
	});

	it("rejects an unknown message kind with a correlated error and keeps the socket", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, "san:eeee33334444"));
		expect((await raw.next()).type).toBe("hello-ok");
		for (const [requestId, kind] of [
			["bad-kind-1", "bogus"],
			["bad-kind-2", 42],
		] as const) {
			raw.send({
				type: "send",
				token: raw.token,
				id: requestId,
				message: { to: alpha.client.id, body: "x", kind },
				expectsReply: false,
			});
			const result = await raw.next();
			expect(result.type).toBe("result");
			if (result.type === "result") {
				expect(result.ok).toBeFalse();
				if (!result.ok) expect(result.error).toMatch(/kind/);
			}
		}
		expect(alpha.deliveries).toHaveLength(0);
		// The socket survives protocol errors.
		raw.send({ type: "list", token: raw.token, id: "barrier" });
		expect((await raw.next()).type).toBe("result");
		raw.close();
	});

	it("evicts a disconnected peer and fails later sends immediately", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		await beta.client.close();
		const evicted = await waitUntil(async () => {
			const peers = await alpha.client.list();
			return !peers.some(peer => peer.id === beta.client.id);
		}, 5_000);
		expect(evicted).toBeTrue();
		const started = Date.now();
		await expect(alpha.client.send({ to: beta.client.id, body: "ghost" })).rejects.toThrow(/not connected/);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("fails a pending delivery when the recipient disconnects before acking", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1, () => hangingDeliver());
		const sending = alpha.client.send({ to: beta.client.id, body: "hang" });
		// The broker tracks the pending ack before forwarding the message, so
		// the delivery callback running proves the delivery is registered.
		expect(await waitUntil(() => beta.deliveries.length === 1, 5_000)).toBeTrue();
		await beta.client.close();
		const receipt = await sending;
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/disconnected/);
	});

	it("drops a pending delivery when the sender disconnects", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		let releaseDeliver: (() => void) | undefined;
		const beta = await makePeer(dir, 1, () => {
			const waiting = Promise.withResolvers<"injected">();
			releaseDeliver = () => waiting.resolve("injected");
			return waiting.promise;
		});
		const sending = alpha.client.send({ to: beta.client.id, body: "orphan" }).catch(() => undefined);
		expect(await waitUntil(() => beta.deliveries.length === 1, 5_000)).toBeTrue();
		await alpha.client.close();
		releaseDeliver?.();
		// The list barrier proves the broker has already processed both the
		// sender's disconnect and the recipient's ack; the pending is gone.
		await beta.client.list();
		expect(beta.deliveries).toHaveLength(1);
		await sending;
		// The broker stays healthy for the remaining peer.
		expect(await beta.client.list()).toEqual([]);
	});

	it("stamps broker-bound id, from, and ts on routed messages", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, "san:abcdefabcdef"));
		expect((await raw.next()).type).toBe("hello-ok");
		const before = Date.now();
		raw.send({
			type: "send",
			token: raw.token,
			id: "req-1",
			// Spoofed id/from/ts fields must never reach the recipient.
			message: { to: alpha.client.id, body: "stamped", id: "spoofed-id", from: "san:000000000000", ts: 12345 },
			expectsReply: false,
		});
		const receipt = await raw.next();
		expect(receipt.type).toBe("result");
		const delivered = alpha.deliveries[0]!.message;
		expect(delivered.from).toBe("san:abcdefabcdef");
		expect(delivered.id).not.toBe("spoofed-id");
		expect(delivered.id.length).toBeGreaterThan(20);
		expect(delivered.ts).not.toBe(12345);
		expect(delivered.ts).toBeGreaterThanOrEqual(before);
		expect(delivered.ts).toBeLessThanOrEqual(Date.now());
		expect(delivered.body).toBe("stamped");
		raw.close();
	});

	it("ignores acks from any socket other than the recipient", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		let capturedId: string | undefined;
		let releaseDeliver: (() => void) | undefined;
		const beta = await makePeer(dir, 1, message => {
			capturedId = message.id;
			const waiting = Promise.withResolvers<"injected">();
			releaseDeliver = () => waiting.resolve("injected");
			return waiting.promise;
		});
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, "san:111111111111"));
		expect((await raw.next()).type).toBe("hello-ok");

		const sending = alpha.client.send({ to: beta.client.id, body: "secret" });
		let settled = false;
		sending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const captured = await waitUntil(() => capturedId !== undefined, 5_000);
		expect(captured).toBeTrue();
		// A non-recipient ack must not settle the sender's pending request.
		raw.send({ type: "ack", token: raw.token, messageId: capturedId!, outcome: "injected" });
		// Barrier on the raw socket: the broker processes frames in order, so
		// this list answer proves the spoofed ack was already handled.
		raw.send({ type: "list", token: raw.token, id: "barrier" });
		expect((await raw.next()).type).toBe("result");
		// Barrier on alpha's own socket: a wrongly accepted ack would have
		// completed the pending before this list was answered, so once the
		// result arrives the sender's request would already have settled.
		await alpha.client.list();
		expect(settled).toBeFalse();
		releaseDeliver?.();
		const receipt = await sending;
		expect(receipt.outcome).toBe("injected");
		raw.close();
	});

	it("rejects a duplicate live registration and closes the offending socket", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, alpha.client.id));
		const message = await raw.next();
		expect(message.type).toBe("error");
		if (message.type === "error") expect(message.message).toMatch(/already connected/);
		await raw.closed;
	});

	it("fails a send to an unknown target with a correlated error and keeps the socket", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const started = Date.now();
		await expect(alpha.client.send({ to: "san:000000000000", body: "nowhere" })).rejects.toThrow(/not connected/);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await alpha.client.list()).toEqual([]);
	});

	it("answers malformed frames, processes coalesced frames, and fails oversized frames closed", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, "san:222222222222"));
		expect((await raw.next()).type).toBe("hello-ok");
		const token = raw.token;

		raw.sendRaw("not-json\n");
		const malformed = await raw.next();
		expect(malformed.type).toBe("error");

		// Two coalesced complete frames in one write are both processed.
		raw.sendRaw(
			`${JSON.stringify({ type: "list", token, id: "c-1" })}\n${JSON.stringify({ type: "list", token, id: "c-2" })}\n`,
		);
		expect((await raw.next()).type).toBe("result");
		expect((await raw.next()).type).toBe("result");

		// An oversized body fails closed with a correlated error.
		raw.send({
			type: "send",
			token,
			id: "big",
			message: { to: alpha.client.id, body: "x".repeat(MAX_PEERS_MESSAGE_BODY_BYTES + 1) },
			expectsReply: false,
		});
		const bigResult = await raw.next();
		expect(bigResult.type).toBe("result");
		if (bigResult.type === "result") {
			expect(bigResult.ok).toBeFalse();
			if (!bigResult.ok) expect(bigResult.error).toMatch(/exceeds/);
		}

		// A complete oversized frame ending in a newline fails closed.
		const second = await rawWirePeer(dir);
		second.send(helloFrame(second.token, "san:333333333333"));
		expect((await second.next()).type).toBe("hello-ok");
		second.sendRaw(`${"y".repeat(MAX_PEERS_LINE_BYTES + 1)}\n`);
		await second.closed;

		// An oversized partial frame also fails closed.
		const third = await rawWirePeer(dir);
		third.send(helloFrame(third.token, "san:444444444444"));
		expect((await third.next()).type).toBe("hello-ok");
		third.sendRaw("z".repeat(MAX_PEERS_LINE_BYTES + 1));
		await third.closed;
		raw.close();
	});

	it("refreshes metadata with broker-owned nondecreasing timestamps", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		const beforeRow = (await alpha.client.list())[0]!;
		beta.state.status = "running";
		beta.state.displayName = "peer 1 renamed";
		await beta.client.refresh();
		const afterRow = (await alpha.client.list())[0]!;
		expect(afterRow.status).toBe("running");
		expect(afterRow.displayName).toBe("peer 1 renamed");
		expect(afterRow.connectedAt).toBe(beforeRow.connectedAt);
		expect(afterRow.lastActivity).toBeGreaterThanOrEqual(beforeRow.lastActivity);
	});

	it("reconnects and re-registers after the broker exits", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
		await shutdownPeersBroker(dir);
		// The next request spawns a fresh broker and re-registers; concurrent
		// requests must survive the old socket's late close.
		const reconnected = await waitUntil(async () => {
			try {
				return (await alpha.client.list()).length === 0;
			} catch {
				return false;
			}
		}, 15_000);
		expect(reconnected).toBeTrue();
		const burst = await Promise.all([alpha.client.list(), alpha.client.list(), alpha.client.list()]);
		expect(burst.every(peers => peers.length === 0)).toBeTrue();
		expect((await beta.client.list()).map(peer => peer.id)).toEqual([alpha.client.id]);
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
	});

	it("exits after the last client disconnects plus grace", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0, undefined, 300);
		await alpha.client.close();
		const pidPath = path.join(dir, PEERS_PID_FILE);
		const exited = await waitUntil(async () => {
			try {
				await fs.access(pidPath);
				return false;
			} catch {
				return true;
			}
		}, 10_000);
		expect(exited).toBeTrue();
		const connection = Promise.withResolvers<void>();
		const socket = net.createConnection({ path: peersBrokerEndpoint(dir) });
		socket.once("connect", () => {
			socket.destroy();
			connection.resolve();
		});
		socket.once("error", connection.reject);
		await expect(connection.promise).rejects.toThrow();
	});

	it("enforces runtime dir, token, and socket permissions on POSIX", async () => {
		if (process.platform === "win32") return;
		const dir = await runtimeDir();
		// Pre-create permissive runtime dir and token; startup must repair them.
		await fs.chmod(dir, 0o777);
		const tokenPath = path.join(dir, PEERS_TOKEN_FILE);
		await fs.writeFile(tokenPath, "preexisting-token", { mode: 0o666 });
		await fs.chmod(tokenPath, 0o666);
		const alpha = await makePeer(dir, 0);
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(peersBrokerEndpoint(dir))).mode & 0o777).toBe(0o600);
		expect(await alpha.client.list()).toEqual([]);
	});
	it("routes discovery, delivery, reply, and eviction across two independent child processes", async () => {
		const dir = await runtimeDir();
		const alphaCwd = path.join(dir, "alpha-work");
		const betaCwd = path.join(dir, "beta-work");
		await fs.mkdir(alphaCwd, { recursive: true });
		await fs.mkdir(betaCwd, { recursive: true });
		const clientUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "..", "src", "peer", "client.ts")).href;
		const script = childScript(clientUrl);
		const env = childEnv({ SAN_PEERS_TEST_RUNTIME: dir });
		const alpha = Bun.spawn([process.execPath, "-e", script], {
			cwd: alphaCwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const beta = Bun.spawn([process.execPath, "-e", script], {
			cwd: betaCwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Drain stderr so a noisy child can never deadlock on a full pipe.
		void drainStream(alpha.stderr).catch(() => undefined);
		void drainStream(beta.stderr).catch(() => undefined);
		const readAlpha = childLineReader(alpha.stdout);
		const readBeta = childLineReader(beta.stdout);
		try {
			const alphaReady = JSON.parse(await nextChildLine(readAlpha, 20_000, "alpha ready")) as Record<
				string,
				unknown
			>;
			const betaReady = JSON.parse(await nextChildLine(readBeta, 20_000, "beta ready")) as Record<string, unknown>;
			expect(alphaReady.t).toBe("ready");
			expect(betaReady.t).toBe("ready");
			const alphaId = alphaReady.id as string;
			const betaId = betaReady.id as string;
			expect(alphaId).toMatch(/^san:[0-9a-f]{12}$/);
			expect(betaId).toMatch(/^san:[0-9a-f]{12}$/);

			// Discovery: alpha sees the beta child with beta's real cwd.
			alpha.stdin.write("list\n");
			const listed = JSON.parse(await nextChildLine(readAlpha, 15_000, "alpha list")) as Record<string, unknown>;
			expect(listed.t).toBe("list");
			// Bun resolves the spawned child's cwd through symlinks (macOS
			// /tmp -> /private/tmp), so compare the realpath of the parent's
			// view with what the child reported.
			expect(listed.peers).toEqual([{ id: betaId, cwd: await fs.realpath(betaCwd) }]);

			// One message round trip: alpha -> beta, then beta replies via replyTo.
			alpha.stdin.write(`send ${betaId} ping\n`);
			const sent = JSON.parse(await nextChildLine(readAlpha, 15_000, "alpha send result")) as Record<
				string,
				unknown
			>;
			expect(sent.t).toBe("send");
			expect(sent.ok).toBeTrue();
			expect(sent.outcome).toBe("injected");
			const delivered = JSON.parse(await nextChildLine(readBeta, 15_000, "beta delivery")) as Record<
				string,
				unknown
			>;
			expect(delivered.t).toBe("deliver");
			expect(delivered.from).toBe(alphaId);
			expect(delivered.body).toBe("ping");
			beta.stdin.write(`reply ${alphaId} ${delivered.id} answer\n`);
			const replied = JSON.parse(await nextChildLine(readBeta, 15_000, "beta reply result")) as Record<
				string,
				unknown
			>;
			expect(replied.t).toBe("reply");
			expect(replied.ok).toBeTrue();
			expect(replied.outcome).toBe("injected");
			const reply = JSON.parse(await nextChildLine(readAlpha, 15_000, "alpha reply delivery")) as Record<
				string,
				unknown
			>;
			expect(reply.t).toBe("deliver");
			expect(reply.body).toBe("answer");
			expect(reply.replyTo).toBe(delivered.id);

			// Disconnect eviction: beta exits, alpha sees the peer disappear,
			// and a later send fails instead of buffering forever.
			beta.stdin.write("quit\n");
			beta.stdin.end();
			await withTimeout(beta.exited, 10_000, "beta exit");
			const evicted = await waitUntil(async () => {
				alpha.stdin.write("list\n");
				const poll = JSON.parse(await nextChildLine(readAlpha, 10_000, "alpha list poll")) as Record<
					string,
					unknown
				>;
				return poll.t === "list" && Array.isArray(poll.peers) && poll.peers.length === 0;
			}, 15_000);
			expect(evicted).toBeTrue();
			alpha.stdin.write(`send ${betaId} ghost\n`);
			const ghost = JSON.parse(await nextChildLine(readAlpha, 15_000, "alpha ghost send")) as Record<
				string,
				unknown
			>;
			expect(ghost.t).toBe("send");
			expect(ghost.ok).toBeFalse();
			expect(ghost.error).toMatch(/not connected/);
		} finally {
			await terminateChild(alpha, "alpha");
			await terminateChild(beta, "beta");
		}
	});

	it("keeps an accepted connection alive past idle grace while it registers late", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0, undefined, 300);
		const raw = await rawWirePeer(dir);
		// Barrier: the probe response proves the broker accepted the socket
		// before the last registered client disconnects.
		raw.send({ type: "list", token: raw.token, id: "probe" });
		const probe = await raw.next();
		expect(probe.type).toBe("result");
		if (probe.type === "result") expect(probe.ok).toBeFalse();
		await alpha.client.close();
		// Real-wall-clock grace window: the broker's idle timer is a real
		// timer in another process, so fake timers cannot advance it. The
		// unregistered socket must keep the broker alive past the 300ms grace
		// and still complete a delayed registration afterwards.
		await Bun.sleep(450);
		raw.send(helloFrame(raw.token, "san:555555555555"));
		expect((await raw.next()).type).toBe("hello-ok");
		raw.send({ type: "list", token: raw.token, id: "after" });
		const listed = await raw.next();
		expect(listed.type).toBe("result");
		if (listed.type === "result") expect(listed.ok).toBeTrue();
		raw.close();
	});

	it("reaps a silent unregistered socket instead of letting it pin the broker", async () => {
		const dir = await runtimeDir();
		await fs.writeFile(path.join(dir, PEERS_TOKEN_FILE), "silent-test-token");
		// Real grace/registration timers inside the broker process require
		// wall-clock waits; the bounds are generous relative to the timers.
		const broker = await spawnBrokerWorker(dir, {
			[PEERS_IDLE_GRACE_ENV]: "500",
			[PEERS_REGISTRATION_TIMEOUT_ENV]: "400",
		});
		try {
			expect(await waitForBroker(peersBrokerEndpoint(dir), 10_000)).toBeTrue();
			const registered = await rawWirePeer(dir);
			registered.send(helloFrame(registered.token, "san:666666666666"));
			expect((await registered.next()).type).toBe("hello-ok");
			const silent = await rawWirePeer(dir);
			await registered.close();
			// The silent socket is reaped by the registration timeout, not by
			// broker shutdown: the broker must still be alive right after.
			await withTimeout(silent.closed, 5_000, "silent socket reaped");
			const pidPath = path.join(dir, PEERS_PID_FILE);
			await Bun.sleep(100);
			let alive = true;
			try {
				await fs.access(pidPath);
			} catch {
				alive = false;
			}
			expect(alive).toBeTrue();
			const exited = await waitUntil(async () => {
				try {
					await fs.access(pidPath);
					return false;
				} catch {
					return true;
				}
			}, 10_000);
			expect(exited).toBeTrue();
			expect(await withTimeout(broker.exited, 5_000, "spawned broker exit")).toBe(0);
		} finally {
			await terminateChild(broker, "spawned broker");
		}
	});

	it("defers to a lease that is empty only while its creator publishes", async () => {
		const dir = await runtimeDir();
		await fs.writeFile(path.join(dir, PEERS_TOKEN_FILE), "lease-test-token");
		const pidPath = path.join(dir, PEERS_PID_FILE);
		// An empty lease file represents a concurrent creator between its
		// exclusive create and its publication. The broker must wait through
		// its bounded retries and then defer, never taking a second ownership.
		await fs.writeFile(pidPath, "");
		const broker = await spawnBrokerWorker(dir, {});
		await Bun.sleep(50);
		await fs.writeFile(pidPath, JSON.stringify({ pid: process.pid, instanceId: "simulated" }));
		try {
			expect(await withTimeout(broker.exited, 5_000, "deferred broker exit")).toBe(0);
			// The lease was never removed or replaced by the deferred broker.
			expect(await Bun.file(pidPath).json()).toEqual({ pid: process.pid, instanceId: "simulated" });
			expect(await waitForBroker(peersBrokerEndpoint(dir), 500)).toBeFalse();
		} finally {
			await terminateChild(broker, "spawned broker");
		}
	});

	it("claims a genuinely stale empty lease and serves clients", async () => {
		const dir = await runtimeDir();
		await fs.writeFile(path.join(dir, PEERS_TOKEN_FILE), "lease-test-token");
		const pidPath = path.join(dir, PEERS_PID_FILE);
		await fs.writeFile(pidPath, "");
		const broker = await spawnBrokerWorker(dir, {});
		try {
			const claimed = await waitUntil(async () => {
				try {
					const lease = (await Bun.file(pidPath).json()) as { pid?: unknown };
					return lease.pid === broker.pid;
				} catch {
					return false;
				}
			}, 5_000);
			expect(claimed).toBeTrue();
			const raw = await rawWirePeer(dir);
			raw.send(helloFrame(raw.token, "san:777777777777"));
			expect((await raw.next()).type).toBe("hello-ok");
			raw.close();
			await shutdownPeersBroker(dir);
			expect(await withTimeout(broker.exited, 5_000, "spawned broker exit")).toBe(0);
		} finally {
			await terminateChild(broker, "spawned broker");
		}
	});

	it("keeps racing spawns to one broker when the lease file starts empty", async () => {
		const dir = await runtimeDir();
		await fs.writeFile(path.join(dir, PEERS_PID_FILE), "");
		const [alpha, beta] = await Promise.all([makePeer(dir, 0), makePeer(dir, 1)]);
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
		expect((await beta.client.list()).map(peer => peer.id)).toEqual([alpha.client.id]);
	});

	it("rejects a wrong token, closes the offender, and keeps healthy peers usable", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		const raw = await rawWirePeer(dir);
		raw.send({ ...helloFrame(raw.token, "san:888888888888"), token: "wrong-token" });
		const message = await raw.next();
		expect(message.type).toBe("error");
		if (message.type === "error") expect(message.message).toMatch(/authentication failed/);
		await raw.closed;
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
		expect((await alpha.client.send({ to: beta.client.id, body: "still works" })).outcome).toBe("injected");
		// A registered socket sending a wrong-token request also fails closed.
		const raw2 = await rawWirePeer(dir);
		raw2.send(helloFrame(raw2.token, "san:999999999999"));
		expect((await raw2.next()).type).toBe("hello-ok");
		raw2.send({ type: "list", token: "wrong-token", id: "spoofed" });
		const spoofed = await raw2.next();
		expect(spoofed.type).toBe("result");
		if (spoofed.type === "result") {
			expect(spoofed.ok).toBeFalse();
			if (!spoofed.ok) expect(spoofed.error).toMatch(/authentication failed/);
		}
		await raw2.closed;
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
	});

	it("rejects oversized registration metadata locally without socket churn", async () => {
		const dir = await runtimeDir();
		await expect(
			createCrossSessionClient({
				runtimeDir: dir,
				idleGraceMs: 60_000,
				metadata: () => ({
					sessionId: "s".repeat(MAX_PEERS_SESSION_ID_BYTES + 1),
					displayName: "bad",
					cwd: dir,
					status: "idle",
				}),
				deliver: async () => "injected",
			}),
		).rejects.toThrow(/exceeds/);
		expect(await waitForBroker(peersBrokerEndpoint(dir), 250)).toBeFalse();
		await expect(fs.access(path.join(dir, PEERS_PID_FILE))).rejects.toBeDefined();
		const alpha = await makePeer(dir, 0);
		const beta = await makePeer(dir, 1);
		await expect(
			createCrossSessionClient({
				runtimeDir: dir,
				metadata: () => ({ sessionId: "valid", displayName: "bad", cwd: dir, status: "idle", activity: "" }),
				deliver: async () => "injected",
			}),
		).rejects.toThrow(/peer\.activity must be a non-empty string/);
		// A refresh with temporarily invalid metadata fails locally and leaves
		// the client's connection untouched.
		alpha.state.displayName = "n".repeat(MAX_PEERS_DISPLAY_NAME_BYTES + 1);
		await expect(alpha.client.refresh()).rejects.toThrow(/exceeds/);
		alpha.state.displayName = "peer 0 renamed";
		await alpha.client.refresh();
		expect((await beta.client.list())[0]!.displayName).toBe("peer 0 renamed");
		// The cwd cap keeps normal long paths usable and only rejects real abuse.
		alpha.state.cwd = path.join(dir, "a".repeat(2_000));
		await alpha.client.refresh();
		expect((await beta.client.list())[0]!.cwd).toBe(path.join(dir, "a".repeat(2_000)));
		alpha.state.cwd = "b".repeat(MAX_PEERS_CWD_BYTES + 1);
		await expect(alpha.client.refresh()).rejects.toThrow(/exceeds/);
		alpha.state.cwd = path.join(dir, "peer-0");
		await alpha.client.refresh();
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual([beta.client.id]);
	});

	it("rejects oversized metadata from a raw socket and keeps the connection usable", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send({
			type: "hello",
			token: raw.token,
			id: "san:aaaaaaaaaaaa",
			peer: {
				sessionId: "s".repeat(MAX_PEERS_SESSION_ID_BYTES + 1),
				displayName: "big",
				cwd: "/tmp",
				status: "idle",
			},
		});
		const message = await raw.next();
		expect(message.type).toBe("error");
		if (message.type === "error") expect(message.message).toMatch(/exceeds/);
		// The socket survives the rejection and registers with a valid hello.
		raw.send(helloFrame(raw.token, "san:aaaaaaaaaaaa"));
		expect((await raw.next()).type).toBe("hello-ok");
		expect((await alpha.client.list()).map(peer => peer.id)).toEqual(["san:aaaaaaaaaaaa"]);
		raw.close();
	});

	it("fails an oversized list response correlated while keeping both sockets usable", async () => {
		const dir = await runtimeDir();
		const alpha = await makePeer(dir, 0);
		const raw = await rawWirePeer(dir);
		raw.send(helloFrame(raw.token, "san:bbbbbbbbbbbb"));
		expect((await raw.next()).type).toBe("hello-ok");
		const bigPeers: RawWirePeer[] = [];
		try {
			// Maxed metadata per peer; enough peers to overflow the frame cap.
			for (let i = 0; i < 100; i++) {
				const peer = await rawWirePeer(dir);
				peer.send({
					type: "hello",
					token: peer.token,
					id: `san:${i.toString(16).padStart(12, "0")}`,
					peer: {
						sessionId: "s".repeat(MAX_PEERS_SESSION_ID_BYTES),
						displayName: "d".repeat(MAX_PEERS_DISPLAY_NAME_BYTES),
						cwd: "c".repeat(MAX_PEERS_CWD_BYTES),
						branch: "b".repeat(MAX_PEERS_BRANCH_BYTES),
						status: "running",
						activity: "a".repeat(MAX_PEERS_ACTIVITY_BYTES),
					},
				});
				expect((await peer.next()).type).toBe("hello-ok");
				bigPeers.push(peer);
			}
			// The client gets a correlated failure, not a destroyed socket.
			await expect(alpha.client.list()).rejects.toThrow(/exceeds/);
			raw.send({ type: "list", token: raw.token, id: "big-list" });
			const bigResult = await raw.next();
			expect(bigResult.type).toBe("result");
			if (bigResult.type === "result") {
				expect(bigResult.ok).toBeFalse();
				if (!bigResult.ok) expect(bigResult.error).toMatch(/exceeds/);
			}
			// Delivery still works in both directions after the failed list.
			raw.send({
				type: "send",
				token: raw.token,
				id: "s-1",
				message: { to: alpha.client.id, body: "ping" },
				expectsReply: false,
			});
			const sentToAlpha = await raw.next();
			expect(sentToAlpha.type).toBe("result");
			if (sentToAlpha.type === "result") expect(sentToAlpha.ok).toBeTrue();
			const sendingToRaw = alpha.client.send({ to: "san:bbbbbbbbbbbb", body: "ping back" });
			const inbound = await raw.next();
			expect(inbound.type).toBe("message");
			if (inbound.type === "message") {
				raw.send({ type: "ack", token: raw.token, messageId: inbound.message.id, outcome: "injected" });
			}
			expect((await sendingToRaw).outcome).toBe("injected");
			// Shrink the roster; the same socket's list succeeds again.
			for (const peer of bigPeers.splice(0)) peer.close();
			const shrunk = await waitUntil(async () => {
				try {
					const peers = await alpha.client.list();
					return peers.length === 1 && peers[0]!.id === "san:bbbbbbbbbbbb";
				} catch {
					return false;
				}
			}, 5_000);
			expect(shrunk).toBeTrue();
		} finally {
			for (const peer of bigPeers) peer.close();
			raw.close();
		}
	});
});
