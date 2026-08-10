import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isEexist, isEnoent, postmortem } from "@san/utils";
import { PEERS_PID_FILE, PEERS_TOKEN_FILE, peersBrokerEndpoint } from "./paths";
import {
	type CrossSessionDeliveryReceipt,
	type CrossSessionMessage,
	type CrossSessionPeer,
	DEFAULT_PEERS_IDLE_GRACE_MS,
	isRecord,
	MAX_PEERS_LINE_BYTES,
	PEERS_DELIVERY_ACK_TIMEOUT_MS,
	PEERS_ID_PATTERN,
	PEERS_IDLE_GRACE_ENV,
	PEERS_REGISTRATION_TIMEOUT_ENV,
	PEERS_REGISTRATION_TIMEOUT_MS,
	PEERS_RUNTIME_DIR_ENV,
	type PeersBrokerMessage,
	type PeersClientMessage,
	parsePeersClientMessage,
} from "./protocol";

interface BrokerLease {
	path: string;
	instanceId: string;
}

interface PeerRecord {
	id: string;
	socket: net.Socket;
	peer: CrossSessionPeer;
}

/** Registration violations that can never be resolved on the offending socket. */
class PeerRegistrationConflictError extends Error {}

function requestIdFromEnvelope(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	if (value.type === "hello") return undefined;
	return value.id;
}

interface PendingDelivery {
	messageId: string;
	recipientId: string;
	recipientSocket: net.Socket;
	senderSocket: net.Socket;
	timer: NodeJS.Timeout | undefined;
	complete: (receipt: CrossSessionDeliveryReceipt) => void;
}

/** How often and how long an unparseable lease file is re-read before stale removal. */
const LEASE_READ_ATTEMPTS = 8;
const LEASE_READ_RETRY_MS = 20;

/**
 * Read an existing lease, tolerating a concurrent creator between its
 * exclusive create and its publication: an empty or partially-written file is
 * given bounded brief retries before it can be treated as stale.
 */
async function readExistingLease(pidPath: string): Promise<{ pid: number } | null> {
	for (let attempt = 0; attempt < LEASE_READ_ATTEMPTS; attempt++) {
		try {
			const raw: unknown = await Bun.file(pidPath).json();
			if (!isRecord(raw) || typeof raw.pid !== "number") return null;
			return { pid: raw.pid };
		} catch {
			if (attempt + 1 < LEASE_READ_ATTEMPTS) await Bun.sleep(LEASE_READ_RETRY_MS);
		}
	}
	return null;
}

async function acquireBrokerLease(runtimeDir: string): Promise<BrokerLease | null> {
	const pidPath = path.join(runtimeDir, PEERS_PID_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(pidPath, "wx", 0o600);
			const instanceId = crypto.randomUUID();
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId }), "utf8");
			} finally {
				await handle.close();
			}
			return { path: pidPath, instanceId };
		} catch (error) {
			if (!isEexist(error)) throw error;
			const existing = await readExistingLease(pidPath);
			if (existing !== null) {
				try {
					process.kill(existing.pid, 0);
					return null; // A live broker owns the lease.
				} catch {
					// The recorded owner is gone. Re-read before removing: a
					// concurrent creator may have replaced the stale file with
					// a fresh lease while we were looking.
					const current = await readExistingLease(pidPath);
					if (current !== null) {
						try {
							process.kill(current.pid, 0);
							return null;
						} catch {
							// Confirmed stale; fall through to removal.
						}
					}
				}
			}
			await fs.rm(pidPath, { force: true });
		}
	}
	return null;
}

async function releaseBrokerLease(lease: BrokerLease): Promise<void> {
	try {
		const raw: unknown = await Bun.file(lease.path).json();
		if (typeof raw === "object" && raw !== null && "instanceId" in raw && raw.instanceId === lease.instanceId) {
			await fs.rm(lease.path, { force: true });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

class PeersBroker {
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number;
	readonly #registrationTimeoutMs: number;
	readonly #peers = new Map<string, PeerRecord>();
	readonly #socketIds = new Map<net.Socket, string>();
	readonly #sockets = new Set<net.Socket>();
	readonly #pendingDeliveries = new Map<string, PendingDelivery>();
	readonly #registrationTimers = new WeakMap<net.Socket, NodeJS.Timeout>();
	readonly #finished = Promise.withResolvers<void>();
	#server: net.Server | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#shuttingDown = false;

	constructor(runtimeDir: string, token: string, idleGraceMs: number, registrationTimeoutMs: number) {
		this.#endpoint = peersBrokerEndpoint(runtimeDir);
		this.#token = token;
		this.#idleGraceMs = idleGraceMs;
		this.#registrationTimeoutMs = registrationTimeoutMs;
	}

	async run(): Promise<void> {
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(this.#endpoint);
		await listening;
		if (process.platform !== "win32") await fs.chmod(this.#endpoint, 0o600);
		this.#scheduleIdleShutdown();
		await this.#finished.promise;
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return this.#finished.promise;
		this.#shuttingDown = true;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		for (const pending of this.#pendingDeliveries.values()) {
			clearTimeout(pending.timer);
			pending.complete({ to: pending.recipientId, outcome: "failed", error: "peers broker shut down" });
		}
		this.#pendingDeliveries.clear();
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#socketIds.clear();
		this.#peers.clear();
		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		this.#finished.resolve();
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		// A fresh connection cancels any pending idle shutdown: the socket is
		// alive even before it registers, so a grace timer must never kill the
		// broker while a client is mid-registration.
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const registrationTimer = setTimeout(() => {
			this.#registrationTimers.delete(socket);
			socket.destroy(new Error("Peers broker registration timed out"));
		}, this.#registrationTimeoutMs);
		this.#registrationTimers.set(socket, registrationTimer);
		let buffer = "";
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				if (Buffer.byteLength(line, "utf8") > MAX_PEERS_LINE_BYTES) {
					socket.destroy(new Error("Peers broker message exceeds size limit"));
					return;
				}
				this.#handleLine(socket, line);
			}
			// Cap only the leftover partial frame so coalesced complete frames
			// are processed before an oversized tail fails the socket.
			if (Buffer.byteLength(buffer, "utf8") > MAX_PEERS_LINE_BYTES) {
				socket.destroy(new Error("Peers broker message exceeds size limit"));
			}
		});
		socket.on("error", () => {
			// Socket closure performs peer eviction and delivery accounting.
		});
		socket.on("close", () => {
			this.#sockets.delete(socket);
			const registrationTimer = this.#registrationTimers.get(socket);
			if (registrationTimer) {
				clearTimeout(registrationTimer);
				this.#registrationTimers.delete(socket);
			}
			const id = this.#socketIds.get(socket);
			if (id) this.#evict(id, "peer disconnected");
			// Cancel deliveries whose sender disconnected; the ack can never be
			// delivered and their timers must not linger.
			for (const [messageId, pending] of this.#pendingDeliveries) {
				if (pending.senderSocket !== socket) continue;
				this.#pendingDeliveries.delete(messageId);
				clearTimeout(pending.timer);
			}
			this.#scheduleIdleShutdown();
		});
	}

	#handleLine(socket: net.Socket, line: string): void {
		let requestId: string | undefined;
		try {
			const decoded: unknown = JSON.parse(line);
			requestId = requestIdFromEnvelope(decoded);
			const message = parsePeersClientMessage(decoded);
			if (message.token !== this.#token) throw new Error("Peers broker authentication failed");
			this.#dispatch(socket, message);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (requestId !== undefined) {
				this.#write(socket, { type: "result", id: requestId, ok: false, error: text });
			} else {
				this.#write(socket, { type: "error", message: text });
			}
			if (error instanceof PeerRegistrationConflictError || text === "Peers broker authentication failed") {
				socket.destroy();
			}
		}
	}

	#dispatch(socket: net.Socket, message: PeersClientMessage): void {
		switch (message.type) {
			case "hello": {
				if (this.#socketIds.has(socket)) throw new PeerRegistrationConflictError("Peer already registered");
				if (!PEERS_ID_PATTERN.test(message.id)) throw new Error(`Invalid peer id: ${message.id}`);
				if (this.#peers.has(message.id)) {
					throw new PeerRegistrationConflictError(`Peer ${message.id} is already connected`);
				}
				const now = Date.now();
				this.#peers.set(message.id, {
					id: message.id,
					socket,
					peer: { ...message.peer, id: message.id, connectedAt: now, lastActivity: now },
				});
				this.#socketIds.set(socket, message.id);
				const registrationTimer = this.#registrationTimers.get(socket);
				if (registrationTimer) {
					clearTimeout(registrationTimer);
					this.#registrationTimers.delete(socket);
				}
				clearTimeout(this.#idleTimer);
				this.#idleTimer = undefined;
				this.#write(socket, { type: "hello-ok" });
				return;
			}
			case "list": {
				const senderId = this.#socketIds.get(socket);
				if (!senderId) throw new Error("Peer not registered");
				const peers = [...this.#peers.values()]
					.filter(record => record.id !== senderId)
					.map(record => record.peer)
					.sort((left, right) => left.connectedAt - right.connectedAt);
				const line = JSON.stringify({
					type: "result",
					id: message.id,
					ok: true,
					result: peers,
				} satisfies PeersBrokerMessage);
				if (Buffer.byteLength(line, "utf8") > MAX_PEERS_LINE_BYTES) {
					// An oversized roster must never reach a healthy client:
					// the client would fail its socket on the giant frame, so
					// answer with a small correlated failure instead.
					this.#write(socket, {
						type: "result",
						id: message.id,
						ok: false,
						error: `peer list response exceeds ${MAX_PEERS_LINE_BYTES} bytes`,
					});
					return;
				}
				if (!socket.destroyed) socket.write(`${line}\n`);
				return;
			}
			case "refresh": {
				const record = this.#registeredRecord(socket);
				record.peer = {
					...message.peer,
					id: record.peer.id,
					connectedAt: record.peer.connectedAt,
					lastActivity: Date.now(),
				};
				this.#write(socket, { type: "result", id: message.id, ok: true, result: null });
				return;
			}
			case "send": {
				const sender = this.#registeredRecord(socket);
				sender.peer.lastActivity = Date.now();
				// The broker stamps id/from/ts; wire-supplied identity and
				// timestamp fields are never trusted.
				const delivered: CrossSessionMessage = {
					id: crypto.randomUUID(),
					from: sender.id,
					to: message.message.to,
					body: message.message.body,
					ts: Date.now(),
				};
				if (message.message.replyTo !== undefined) delivered.replyTo = message.message.replyTo;
				if (message.message.kind !== undefined) delivered.kind = message.message.kind;
				const recipient = this.#peers.get(message.message.to);
				if (!recipient || recipient.socket === socket)
					throw new Error(`Peer ${message.message.to} is not connected`);
				if (this.#pendingDeliveries.has(delivered.id))
					throw new Error(`Message ${delivered.id} is already pending`);
				const pending: PendingDelivery = {
					messageId: delivered.id,
					recipientId: recipient.id,
					recipientSocket: recipient.socket,
					senderSocket: socket,
					timer: undefined,
					complete: receipt => this.#write(socket, { type: "result", id: message.id, ok: true, result: receipt }),
				};
				pending.timer = setTimeout(
					() =>
						this.#failDelivery(pending, {
							to: pending.recipientId,
							outcome: "failed",
							error: "delivery acknowledgment timed out",
						}),
					PEERS_DELIVERY_ACK_TIMEOUT_MS,
				);
				this.#pendingDeliveries.set(delivered.id, pending);
				this.#write(recipient.socket, {
					type: "message",
					message: delivered,
					expectsReply: message.expectsReply,
				} satisfies PeersBrokerMessage);
				return;
			}
			case "ack": {
				const pending = this.#pendingDeliveries.get(message.messageId);
				if (!pending || pending.recipientSocket !== socket) return; // unknown or spoofed ack
				this.#pendingDeliveries.delete(pending.messageId);
				clearTimeout(pending.timer);
				const receipt: CrossSessionDeliveryReceipt = { to: pending.recipientId, outcome: message.outcome };
				if (message.error !== undefined) receipt.error = message.error;
				pending.complete(receipt);
				const record = this.#peers.get(pending.recipientId);
				if (record) record.peer.lastActivity = Date.now();
				return;
			}
			case "bye": {
				const id = this.#socketIds.get(socket);
				if (id) this.#evict(id, "peer disconnected");
				socket.destroy();
				return;
			}
			case "shutdown": {
				this.#write(socket, { type: "result", id: message.id, ok: true, result: null });
				setTimeout(() => void this.shutdown(), 10);
				return;
			}
		}
	}

	#registeredRecord(socket: net.Socket): PeerRecord {
		const id = this.#socketIds.get(socket);
		const record = id ? this.#peers.get(id) : undefined;
		if (!record || record.socket !== socket) throw new Error("Peer not registered");
		return record;
	}

	#evict(id: string, error: string): void {
		const record = this.#peers.get(id);
		if (!record) return;
		this.#peers.delete(id);
		this.#socketIds.delete(record.socket);
		for (const [messageId, pending] of this.#pendingDeliveries) {
			if (pending.recipientSocket !== record.socket) continue;
			this.#pendingDeliveries.delete(messageId);
			clearTimeout(pending.timer);
			pending.complete({ to: pending.recipientId, outcome: "failed", error });
		}
	}

	#failDelivery(pending: PendingDelivery, receipt: CrossSessionDeliveryReceipt): void {
		if (this.#pendingDeliveries.get(pending.messageId) !== pending) return;
		this.#pendingDeliveries.delete(pending.messageId);
		clearTimeout(pending.timer);
		pending.complete(receipt);
	}

	#write(socket: net.Socket, message: PeersBrokerMessage): void {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(message)}\n`);
	}

	#scheduleIdleShutdown(): void {
		// Any accepted socket — registered or not — keeps the broker busy, so
		// idle eligibility is keyed on sockets, not peers; silent sockets are
		// bounded by the registration timeout instead of pinning the broker.
		if (this.#shuttingDown || this.#sockets.size > 0) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (this.#sockets.size === 0) void this.shutdown();
		}, this.#idleGraceMs);
	}
}

/** Start the detached user-global peers broker selected by the CLI worker host. */
export async function startPeersBrokerFromEnvironment(): Promise<void> {
	const runtimeDir = process.env[PEERS_RUNTIME_DIR_ENV];
	if (!runtimeDir) throw new Error("Peers broker environment is incomplete");
	delete process.env[PEERS_RUNTIME_DIR_ENV];
	const rawGrace = process.env[PEERS_IDLE_GRACE_ENV];
	delete process.env[PEERS_IDLE_GRACE_ENV];
	const parsedGrace = rawGrace === undefined ? DEFAULT_PEERS_IDLE_GRACE_MS : Number.parseInt(rawGrace, 10);
	const idleGraceMs = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : DEFAULT_PEERS_IDLE_GRACE_MS;
	const rawRegistrationTimeout = process.env[PEERS_REGISTRATION_TIMEOUT_ENV];
	delete process.env[PEERS_REGISTRATION_TIMEOUT_ENV];
	const parsedRegistrationTimeout =
		rawRegistrationTimeout === undefined
			? PEERS_REGISTRATION_TIMEOUT_MS
			: Number.parseInt(rawRegistrationTimeout, 10);
	const registrationTimeoutMs =
		Number.isFinite(parsedRegistrationTimeout) && parsedRegistrationTimeout > 0
			? parsedRegistrationTimeout
			: PEERS_REGISTRATION_TIMEOUT_MS;
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(runtimeDir, 0o700);
	const lease = await acquireBrokerLease(runtimeDir);
	if (!lease) return;
	process.title = "san peers broker";
	const token = (await Bun.file(path.join(runtimeDir, PEERS_TOKEN_FILE)).text()).trim();
	if (!token) throw new Error("Peers broker token is empty");
	const broker = new PeersBroker(runtimeDir, token, idleGraceMs, registrationTimeoutMs);
	const cancelCleanup = postmortem.register("peers-broker", () => broker.shutdown());
	try {
		await broker.run();
	} finally {
		cancelCleanup();
		await releaseBrokerLease(lease);
	}
}
