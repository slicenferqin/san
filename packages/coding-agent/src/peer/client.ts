import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isEexist, isEnoent } from "@san/utils";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { PEERS_TOKEN_FILE, peersBrokerEndpoint, peersRuntimeDir } from "./paths";
import {
	type CrossSessionDeliveryReceipt,
	type CrossSessionMessage,
	type CrossSessionMessageKind,
	type CrossSessionPeer,
	MAX_PEERS_LINE_BYTES,
	MAX_PEERS_MESSAGE_BODY_BYTES,
	PEERS_BROKER_WORKER_ARG,
	PEERS_DELIVERY_ACK_TIMEOUT_MS,
	PEERS_IDLE_GRACE_ENV,
	PEERS_RUNTIME_DIR_ENV,
	type PeerRegistrationWire,
	type PeerSendWire,
	type PeersBrokerMessage,
	type PeersClientMessage,
	parseCrossSessionDeliveryReceipt,
	parseCrossSessionPeer,
	parsePeerRegistration,
	parsePeersBrokerMessage,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Stable transport identity of one top-level San runtime. */
export interface CrossSessionClient {
	readonly id: string;
	list(signal?: AbortSignal): Promise<CrossSessionPeer[]>;
	send(
		input: {
			to: string;
			body: string;
			replyTo?: string;
			expectsReply?: boolean;
			kind?: CrossSessionMessageKind;
		},
		signal?: AbortSignal,
	): Promise<CrossSessionDeliveryReceipt>;
	refresh(): Promise<void>;
	close(): Promise<void>;
}

/** Transport configuration supplied by the session layer. */
export interface CrossSessionClientOptions {
	/** Runtime directory override; defaults to the user-global config path. */
	runtimeDir?: string;
	/** Last-client shutdown grace override in milliseconds. */
	idleGraceMs?: number;
	/** Fresh registration metadata; called on registration and refresh. */
	metadata(): Omit<CrossSessionPeer, "id" | "connectedAt" | "lastActivity">;
	/** Deliver one inbound message; the returned outcome becomes the sender's receipt. */
	deliver(message: CrossSessionMessage, options: { expectsReply: boolean }): Promise<"injected" | "woken">;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
}

interface RegistrationWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

async function readOrCreateToken(runtimeDir: string): Promise<string> {
	const tokenPath = path.join(runtimeDir, PEERS_TOKEN_FILE);
	const tokenFile = Bun.file(tokenPath);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const token = (await tokenFile.text()).trim();
			if (token.length > 0) {
				if (process.platform !== "win32") await fs.chmod(tokenPath, 0o600);
				return token;
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = randomBytes(32).toString("base64url");
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing peers broker token in ${runtimeDir}`);
}

function openSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to peers broker at ${endpoint}`));
	}, timeoutMs);
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.off("error", onError);
	};
	const onConnect = (): void => {
		cleanup();
		resolve(socket);
	};
	const onError = (error: Error): void => {
		cleanup();
		socket.destroy();
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return promise;
}

function parsePeerList(value: unknown): CrossSessionPeer[] {
	if (!Array.isArray(value)) throw new Error("peer list must be an array");
	const peers: CrossSessionPeer[] = [];
	for (const item of value) peers.push(parseCrossSessionPeer(item));
	return peers;
}

class PeerTransportClient implements CrossSessionClient {
	readonly id: string;
	readonly #options: CrossSessionClientOptions;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #registerWaiters = new Set<RegistrationWaiter>();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#registered = false;
	#buffer = "";
	#closed = false;

	constructor(id: string, options: CrossSessionClientOptions, runtimeDir: string, token: string) {
		this.id = id;
		this.#options = options;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = peersBrokerEndpoint(runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
	}
	static async create(
		options: CrossSessionClientOptions,
		runtimeDir: string,
		token: string,
		id: string,
	): Promise<PeerTransportClient> {
		const client = new PeerTransportClient(id, options, runtimeDir, token);
		await client.#connect();
		return client;
	}

	async list(signal?: AbortSignal): Promise<CrossSessionPeer[]> {
		const result = await this.#request(
			{ type: "list", token: this.#token, id: crypto.randomUUID() },
			REQUEST_TIMEOUT_MS,
			signal,
		);
		return parsePeerList(result);
	}

	async send(
		input: {
			to: string;
			body: string;
			replyTo?: string;
			expectsReply?: boolean;
			kind?: CrossSessionMessageKind;
		},
		signal?: AbortSignal,
	): Promise<CrossSessionDeliveryReceipt> {
		if (Buffer.byteLength(input.body, "utf8") > MAX_PEERS_MESSAGE_BODY_BYTES) {
			throw new Error(`Peer message body exceeds ${MAX_PEERS_MESSAGE_BODY_BYTES} bytes`);
		}
		const message: PeerSendWire = { to: input.to, body: input.body };
		if (input.replyTo !== undefined) message.replyTo = input.replyTo;
		if (input.kind !== undefined) message.kind = input.kind;
		const result = await this.#request(
			{
				type: "send",
				token: this.#token,
				id: crypto.randomUUID(),
				message,
				expectsReply: input.expectsReply ?? false,
			},
			PEERS_DELIVERY_ACK_TIMEOUT_MS + 15_000,
			signal,
		);
		return parseCrossSessionDeliveryReceipt(result);
	}

	async refresh(): Promise<void> {
		// Same local validation as registration: invalid metadata must fail
		// before it can reach the broker and trigger a reconnect cycle.
		const peer = parsePeerRegistration(this.#options.metadata());
		await this.#request({ type: "refresh", token: this.#token, id: crypto.randomUUID(), peer }, REQUEST_TIMEOUT_MS);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const socket = this.#socket;
		if (socket && !socket.destroyed) {
			try {
				socket.write(`${JSON.stringify({ type: "bye", token: this.#token } satisfies PeersClientMessage)}\n`);
			} catch {
				// The socket teardown below still rejects pending requests.
			}
		}
		socket?.destroy();
		this.#socket = undefined;
		this.#registered = false;
		this.#failPending(new Error("Peer transport client closed"));
	}

	async #connect(): Promise<void> {
		if (this.#closed) throw new Error("Peer transport client is closed");
		if (this.#socket && !this.#socket.destroyed && this.#registered) return;
		if (this.#connectPromise) return this.#connectPromise;
		// Validate before opening a socket or spawning a broker. Invalid local
		// metadata must not create transport churn, and this exact validated
		// snapshot is what the eventual hello publishes.
		const peer = parsePeerRegistration(this.#options.metadata());
		this.#connectPromise = this.#connectOnce(peer);
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(peer: PeerRegistrationWire): Promise<void> {
		let socket: net.Socket;
		try {
			socket = await openSocket(this.#endpoint, 250);
		} catch {
			// No live broker. Multiple clients may race to spawn; the broker's
			// PID lease selects one winner before any candidate binds the socket.
			this.#spawnBroker();
			const deadline = Date.now() + CONNECT_TIMEOUT_MS;
			let lastError: Error | undefined;
			for (;;) {
				if (Date.now() >= deadline) {
					throw new Error(`Failed to start peers broker: ${lastError?.message ?? "socket unavailable"}`);
				}
				try {
					socket = await openSocket(this.#endpoint, 250);
					break;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					await Bun.sleep(CONNECT_RETRY_MS);
				}
			}
		}
		if (this.#closed) {
			socket.destroy();
			throw new Error("Peer transport client is closed");
		}
		await this.#register(socket, peer);
	}

	async #register(socket: net.Socket, peer: PeerRegistrationWire): Promise<void> {
		this.#bindSocket(socket);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter: RegistrationWaiter = { resolve, reject };
		this.#registerWaiters.add(waiter);
		const timer = setTimeout(() => {
			this.#registerWaiters.delete(waiter);
			reject(new Error("Peer transport registration timed out"));
		}, REGISTRATION_TIMEOUT_MS);
		try {
			socket.write(`${JSON.stringify({ type: "hello", token: this.#token, id: this.id, peer })}\n`);
			await promise;
			clearTimeout(timer);
			this.#registerWaiters.delete(waiter);
		} catch (error) {
			clearTimeout(timer);
			this.#registerWaiters.delete(waiter);
			socket.destroy();
			if (this.#socket === socket) this.#socket = undefined;
			this.#registered = false;
			throw error;
		}
	}

	async #request(
		message: Extract<PeersClientMessage, { id: string }>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.#closed) throw new Error("Peer transport client is closed");
		if (signal?.aborted) throw new Error("Peer transport request aborted");
		await this.#connect();
		const socket = this.#socket;
		if (!socket || socket.destroyed || !this.#registered) throw new Error("Peer transport socket is unavailable");

		const id = message.id;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.removeAbort?.();
			reject(new Error("Peer transport request timed out"));
		}, timeoutMs);
		const pending: PendingRequest = { resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Peer transport request aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		if (socket.destroyed) {
			this.#pending.delete(id);
			clearTimeout(timer);
			pending.removeAbort?.();
			reject(new Error("Peer transport socket is unavailable"));
			return promise;
		}
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			this.#pending.delete(id);
			clearTimeout(timer);
			pending.removeAbort?.();
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	#spawnBroker(): void {
		const spawn = resolveWorkerSpawnCmd(PEERS_BROKER_WORKER_ARG);
		const overlay: Record<string, string> = { [PEERS_RUNTIME_DIR_ENV]: this.#runtimeDir };
		if (this.#idleGraceMs !== undefined) overlay[PEERS_IDLE_GRACE_ENV] = String(this.#idleGraceMs);
		try {
			const child = Bun.spawn(spawn.cmd, {
				cwd: spawn.cwd,
				env: workerEnvFromParent(overlay),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
			});
			child.unref();
		} catch {
			// A racing client may already have started the broker; the connect
			// retry loop below attaches to it, so a spawn failure is not fatal.
		}
	}

	#bindSocket(socket: net.Socket): void {
		if (this.#socket && !this.#socket.destroyed) this.#socket.destroy();
		this.#socket = socket;
		this.#buffer = "";
		this.#registered = false;
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			if (this.#socket !== socket) return;
			this.#onData(chunk);
		});
		socket.on("error", () => {
			// The close handler rejects pending requests with one stable error.
		});
		socket.on("close", () => {
			// Socket-identity guard: a stale close from a previous connection
			// must not tear down the replacement socket.
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#registered = false;
			this.#failPending(new Error("Peer transport connection closed"));
		});
	}

	#onData(chunk: string | Buffer): void {
		this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length === 0) continue;
			if (Buffer.byteLength(line, "utf8") > MAX_PEERS_LINE_BYTES) {
				this.#failPending(new Error("Peers broker response exceeds size limit"));
				this.#socket?.destroy();
				return;
			}
			let message: PeersBrokerMessage;
			try {
				message = parsePeersBrokerMessage(JSON.parse(line));
			} catch (error) {
				// Malformed broker response: fail closed; the next request reconnects.
				this.#failPending(error instanceof Error ? error : new Error(String(error)));
				this.#socket?.destroy();
				continue;
			}
			switch (message.type) {
				case "hello-ok":
					this.#registered = true;
					for (const waiter of this.#registerWaiters) waiter.resolve();
					this.#registerWaiters.clear();
					break;
				case "result": {
					const pending = this.#pending.get(message.id);
					if (!pending) continue;
					this.#pending.delete(message.id);
					clearTimeout(pending.timer);
					pending.removeAbort?.();
					if (!message.ok) {
						pending.reject(new Error(message.error));
						continue;
					}
					pending.resolve(message.result);
					break;
				}
				case "message":
					void this.#handleInbound(message.message, message.expectsReply);
					break;
				case "error":
					// Protocol-level failure (auth, duplicate registration): fail
					// closed; the next request reconnects and re-registers.
					this.#failPending(new Error(message.message));
					this.#socket?.destroy();
					break;
			}
		}
		if (Buffer.byteLength(this.#buffer, "utf8") > MAX_PEERS_LINE_BYTES) {
			this.#failPending(new Error("Peers broker response exceeds size limit"));
			this.#socket?.destroy();
		}
	}

	async #handleInbound(message: CrossSessionMessage, expectsReply: boolean): Promise<void> {
		let outcome: CrossSessionDeliveryReceipt["outcome"];
		let error: string | undefined;
		try {
			outcome = await this.#options.deliver(message, { expectsReply });
		} catch (err) {
			outcome = "failed";
			error = err instanceof Error ? err.message : String(err);
		}
		const socket = this.#socket;
		if (this.#closed || !socket || socket.destroyed || !this.#registered) return;
		const ack: PeersClientMessage = { type: "ack", token: this.#token, messageId: message.id, outcome };
		if (error !== undefined) ack.error = error;
		socket.write(`${JSON.stringify(ack)}\n`);
	}

	#failPending(error: Error): void {
		for (const waiter of this.#registerWaiters) waiter.reject(error);
		this.#registerWaiters.clear();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

/** Create a cross-session transport client and register it with the live broker. */
export async function createCrossSessionClient(options: CrossSessionClientOptions): Promise<CrossSessionClient> {
	const runtimeDir = options.runtimeDir ?? peersRuntimeDir();
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(runtimeDir, 0o700);
	const token = await readOrCreateToken(runtimeDir);
	const id = `san:${randomBytes(6).toString("hex")}`;
	const client = await PeerTransportClient.create(options, runtimeDir, token, id);
	return client;
}

/** Best-effort request for the broker to shut down; no-op when it is already gone. */
export async function shutdownPeersBroker(runtimeDir: string): Promise<void> {
	let socket: net.Socket;
	try {
		const token = (await Bun.file(path.join(runtimeDir, PEERS_TOKEN_FILE)).text()).trim();
		if (!token) throw new Error("Peers broker token is empty");
		socket = await openSocket(peersBrokerEndpoint(runtimeDir), 250);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Peers broker shutdown timed out"));
		}, SHUTDOWN_TIMEOUT_MS);
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (!buffer.includes("\n")) return;
			clearTimeout(timer);
			resolve();
		});
		socket.on("error", () => {
			// The close handler settles the shutdown promise.
		});
		socket.on("close", () => {
			clearTimeout(timer);
			reject(new Error("Peers broker connection closed before shutdown result"));
		});
		socket.write(`${JSON.stringify({ type: "shutdown", token, id: crypto.randomUUID() })}\n`);
		await promise;
		socket.destroy();
	} catch {
		// No live broker; nothing to shut down.
	}
}

/** Exercise worker-host broker startup, discovery, and delivery for distribution smoke tests. */
export async function smokeTestCrossSessionBroker(): Promise<void> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "san-peers-smoke-run-"));
	const betaCwd = path.join(runtimeDir, "beta");
	try {
		const received: string[] = [];
		const alpha = await createCrossSessionClient({
			runtimeDir,
			idleGraceMs: 60_000,
			metadata: () => ({ sessionId: "smoke-alpha", displayName: "smoke alpha", cwd: runtimeDir, status: "idle" }),
			deliver: async () => "injected",
		});
		try {
			const beta = await createCrossSessionClient({
				runtimeDir,
				idleGraceMs: 60_000,
				metadata: () => ({ sessionId: "smoke-beta", displayName: "smoke beta", cwd: betaCwd, status: "running" }),
				deliver: async message => {
					received.push(message.body);
					return "injected";
				},
			});
			try {
				const peers = await alpha.list();
				if (!peers.some(peer => peer.id === beta.id && peer.cwd === betaCwd)) {
					throw new Error("cross-session peer discovery failed");
				}
				if (peers.some(peer => peer.id === alpha.id)) throw new Error("cross-session list leaked the caller");
				const receipt = await alpha.send({ to: beta.id, body: "smoke-ping" });
				if (receipt.outcome !== "injected") {
					throw new Error(
						`cross-session delivery failed: ${receipt.outcome}${receipt.error ? `: ${receipt.error}` : ""}`,
					);
				}
				if (!received.includes("smoke-ping")) throw new Error("cross-session message was not delivered");
				await beta.refresh();
			} finally {
				await beta.close();
			}
		} finally {
			await alpha.close();
		}
	} finally {
		await shutdownPeersBroker(runtimeDir);
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}
