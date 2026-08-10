/**
 * Cross-session peer broker protocol shared by the client, broker, and tests.
 *
 * Authenticated newline-delimited JSON over a user-global Unix socket or
 * Windows named pipe. The broker binds exactly one registration to one
 * socket.
 */

/** Bound on a single message body measured in UTF-8 bytes. */
export const MAX_PEERS_MESSAGE_BODY_BYTES = 64 * 1024;

/** Bound on the optional replyTo field measured in UTF-8 bytes. */
export const MAX_PEERS_REPLY_TO_BYTES = 4 * 1024;
/** Bound on a single newline-delimited frame measured in UTF-8 bytes. */
export const MAX_PEERS_LINE_BYTES = 512 * 1024;

/** Bound on the session id field of registration metadata in UTF-8 bytes. */
export const MAX_PEERS_SESSION_ID_BYTES = 256;
/** Bound on the display name field of registration metadata in UTF-8 bytes. */
export const MAX_PEERS_DISPLAY_NAME_BYTES = 256;
/** Bound on the cwd field of registration metadata in UTF-8 bytes; normal long paths stay usable. */
export const MAX_PEERS_CWD_BYTES = 4 * 1024;
/** Bound on the branch field of registration metadata in UTF-8 bytes. */
export const MAX_PEERS_BRANCH_BYTES = 256;
/** Bound on the activity field of registration metadata in UTF-8 bytes. */
export const MAX_PEERS_ACTIVITY_BYTES = 512;

/** How long an accepted socket may take to register before the broker closes it. */
export const PEERS_REGISTRATION_TIMEOUT_MS = 15_000;
/** Optional environment key overriding the broker's registration timeout. */
export const PEERS_REGISTRATION_TIMEOUT_ENV = "SAN_PEERS_REGISTRATION_TIMEOUT_MS";

/** Default broker idle shutdown grace after the last client disconnects. */
export const DEFAULT_PEERS_IDLE_GRACE_MS = 3_000;

/** How long the broker waits for a recipient delivery acknowledgment. */
export const PEERS_DELIVERY_ACK_TIMEOUT_MS = 60_000;

/** Stable address format: `san:` plus 12 lowercase hex digits. */
export const PEERS_ID_PATTERN = /^san:[0-9a-f]{12}$/;
/** Hidden CLI selector used to re-enter the detached peers broker worker. */
export const PEERS_BROKER_WORKER_ARG = "__omp_worker_peers_broker";

/** Environment key carrying the peers broker's user-global runtime directory. */
export const PEERS_RUNTIME_DIR_ENV = "SAN_PEERS_RUNTIME_DIR";

/** Optional environment key overriding last-client shutdown grace. */
export const PEERS_IDLE_GRACE_ENV = "SAN_PEERS_IDLE_GRACE_MS";

/** Liveness classification advertised by a registered runtime. */
export type CrossSessionStatus = "running" | "idle";

/** One live top-level runtime visible to other San processes. */
export interface CrossSessionPeer {
	id: string;
	sessionId: string;
	displayName: string;
	cwd: string;
	branch?: string;
	status: CrossSessionStatus;
	activity?: string;
	connectedAt: number;
	lastActivity: number;
}

/** Specialized message kinds; ordinary messages carry no kind. */
export type CrossSessionMessageKind = "handoff";

/** A message routed between two registered runtimes. */
export interface CrossSessionMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
	kind?: CrossSessionMessageKind;
}
/** Outcome of one direct delivery attempt. */
export type CrossSessionDeliveryOutcome = "injected" | "woken" | "failed";

/** Result returned to the sender once the recipient acknowledges delivery. */
export interface CrossSessionDeliveryReceipt {
	to: string;
	outcome: CrossSessionDeliveryOutcome;
	error?: string;
}

/** Narrow sender payload; id/from/ts are stamped by the broker. */
export interface PeerSendWire {
	to: string;
	body: string;
	replyTo?: string;
	kind?: CrossSessionMessageKind;
}
/** Client-supplied registration metadata; id and timestamps are broker-owned. */
export interface PeerRegistrationWire {
	sessionId: string;
	displayName: string;
	cwd: string;
	branch?: string;
	status: CrossSessionStatus;
	activity?: string;
}

/** Authenticated client-to-broker wire message. */
export type PeersClientMessage =
	| { type: "hello"; token: string; id: string; peer: PeerRegistrationWire }
	| { type: "list"; token: string; id: string }
	| { type: "refresh"; token: string; id: string; peer: PeerRegistrationWire }
	| { type: "send"; token: string; id: string; message: PeerSendWire; expectsReply: boolean }
	| { type: "ack"; token: string; messageId: string; outcome: CrossSessionDeliveryOutcome; error?: string }
	| { type: "bye"; token: string }
	| { type: "shutdown"; token: string; id: string };

/** Broker-to-client wire message. */
export type PeersBrokerMessage =
	| { type: "hello-ok" }
	| { type: "result"; id: string; ok: true; result: unknown }
	| { type: "result"; id: string; ok: false; error: string }
	| { type: "message"; message: CrossSessionMessage; expectsReply: boolean }
	| { type: "error"; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
	const text = stringValue(value, label);
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new Error(`${label} exceeds ${maxBytes} bytes`);
	}
	return text;
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number): string | undefined {
	if (value === undefined) return undefined;
	return boundedString(value, label, maxBytes);
}

function rawString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return stringValue(value, label);
}

function optionalMessageKind(value: unknown, label: string): CrossSessionMessageKind | undefined {
	if (value === undefined) return undefined;
	const kind = rawString(value, label);
	if (kind !== "handoff") throw new Error(`Unknown message kind: ${kind}`);
	return kind;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
	return value;
}

function crossSessionStatus(value: unknown): CrossSessionStatus {
	const status = stringValue(value, "peer status");
	if (status === "running" || status === "idle") return status;
	throw new Error(`Unknown peer status: ${status}`);
}

function deliveryOutcome(value: unknown): CrossSessionDeliveryOutcome {
	const outcome = stringValue(value, "delivery outcome");
	if (outcome === "injected" || outcome === "woken" || outcome === "failed") return outcome;
	throw new Error(`Unknown delivery outcome: ${outcome}`);
}

/** Decode and validate the client-supplied registration metadata. */
export function parsePeerRegistration(value: unknown): PeerRegistrationWire {
	const source = record(value, "peer registration");
	return {
		sessionId: boundedString(source.sessionId, "peer.sessionId", MAX_PEERS_SESSION_ID_BYTES),
		displayName: boundedString(source.displayName, "peer.displayName", MAX_PEERS_DISPLAY_NAME_BYTES),
		cwd: boundedString(source.cwd, "peer.cwd", MAX_PEERS_CWD_BYTES),
		branch: optionalBoundedString(source.branch, "peer.branch", MAX_PEERS_BRANCH_BYTES),
		status: crossSessionStatus(source.status),
		activity: optionalBoundedString(source.activity, "peer.activity", MAX_PEERS_ACTIVITY_BYTES),
	};
}

/** Decode and validate one routed message, enforcing the body and replyTo caps. */
export function parseCrossSessionMessage(value: unknown): CrossSessionMessage {
	const source = record(value, "peer message");
	const body = rawString(source.body, "message.body");
	if (Buffer.byteLength(body, "utf8") > MAX_PEERS_MESSAGE_BODY_BYTES) {
		throw new Error(`message body exceeds ${MAX_PEERS_MESSAGE_BODY_BYTES} bytes`);
	}
	const replyTo = optionalString(source.replyTo, "message.replyTo");
	if (replyTo !== undefined && Buffer.byteLength(replyTo, "utf8") > MAX_PEERS_REPLY_TO_BYTES) {
		throw new Error(`message replyTo exceeds ${MAX_PEERS_REPLY_TO_BYTES} bytes`);
	}
	const kind = optionalMessageKind(source.kind, "message.kind");
	const message: CrossSessionMessage = {
		id: stringValue(source.id, "message.id"),
		from: stringValue(source.from, "message.from"),
		to: stringValue(source.to, "message.to"),
		body,
		ts: numberValue(source.ts, "message.ts"),
	};
	if (replyTo !== undefined) message.replyTo = replyTo;
	if (kind !== undefined) message.kind = kind;
	return message;
}

/** Decode the narrow sender payload before the broker stamps identity and time. */
export function parsePeerSendWire(value: unknown): PeerSendWire {
	const source = record(value, "peer send");
	const body = rawString(source.body, "send.body");
	if (Buffer.byteLength(body, "utf8") > MAX_PEERS_MESSAGE_BODY_BYTES) {
		throw new Error(`message body exceeds ${MAX_PEERS_MESSAGE_BODY_BYTES} bytes`);
	}
	const replyTo = optionalString(source.replyTo, "send.replyTo");
	if (replyTo !== undefined && Buffer.byteLength(replyTo, "utf8") > MAX_PEERS_REPLY_TO_BYTES) {
		throw new Error(`message replyTo exceeds ${MAX_PEERS_REPLY_TO_BYTES} bytes`);
	}
	const kind = optionalMessageKind(source.kind, "send.kind");
	const wire: PeerSendWire = { to: stringValue(source.to, "send.to"), body };
	if (replyTo !== undefined) wire.replyTo = replyTo;
	if (kind !== undefined) wire.kind = kind;
	return wire;
}

/** Decode one peer record returned by `list`. */
export function parseCrossSessionPeer(value: unknown): CrossSessionPeer {
	const source = record(value, "peer");
	return {
		id: stringValue(source.id, "peer.id"),
		sessionId: stringValue(source.sessionId, "peer.sessionId"),
		displayName: stringValue(source.displayName, "peer.displayName"),
		cwd: stringValue(source.cwd, "peer.cwd"),
		branch: optionalString(source.branch, "peer.branch"),
		status: crossSessionStatus(source.status),
		activity: optionalString(source.activity, "peer.activity"),
		connectedAt: numberValue(source.connectedAt, "peer.connectedAt"),
		lastActivity: numberValue(source.lastActivity, "peer.lastActivity"),
	};
}

/** Decode a delivery receipt returned to the sender. */
export function parseCrossSessionDeliveryReceipt(value: unknown): CrossSessionDeliveryReceipt {
	const source = record(value, "delivery receipt");
	const receipt: CrossSessionDeliveryReceipt = {
		to: stringValue(source.to, "receipt.to"),
		outcome: deliveryOutcome(source.outcome),
	};
	if (source.error !== undefined) receipt.error = rawString(source.error, "receipt.error");
	return receipt;
}

/** Decode a socket request before the broker acts on it. */
export function parsePeersClientMessage(value: unknown): PeersClientMessage {
	const source = record(value, "peers client message");
	const type = stringValue(source.type, "message.type");
	const token = stringValue(source.token, "message.token");
	switch (type) {
		case "hello":
			return {
				type: "hello",
				token,
				id: stringValue(source.id, "hello.id"),
				peer: parsePeerRegistration(source.peer),
			};
		case "list":
			return { type: "list", token, id: stringValue(source.id, "list.id") };
		case "refresh":
			return {
				type: "refresh",
				token,
				id: stringValue(source.id, "refresh.id"),
				peer: parsePeerRegistration(source.peer),
			};
		case "send":
			return {
				type: "send",
				token,
				id: stringValue(source.id, "send.id"),
				message: parsePeerSendWire(source.message),
				expectsReply:
					source.expectsReply === undefined ? false : booleanValue(source.expectsReply, "send.expectsReply"),
			};
		case "ack": {
			const ack: PeersClientMessage = {
				type: "ack",
				token,
				messageId: stringValue(source.messageId, "ack.messageId"),
				outcome: deliveryOutcome(source.outcome),
			};
			if (source.error !== undefined) ack.error = rawString(source.error, "ack.error");
			return ack;
		}
		case "bye":
			return { type: "bye", token };
		case "shutdown":
			return { type: "shutdown", token, id: stringValue(source.id, "shutdown.id") };
		default:
			throw new Error(`Unknown peers client message type: ${type}`);
	}
}

/** Decode a socket response envelope before resolving a pending call. */
export function parsePeersBrokerMessage(value: unknown): PeersBrokerMessage {
	const source = record(value, "peers broker message");
	const type = stringValue(source.type, "message.type");
	switch (type) {
		case "hello-ok":
			return { type: "hello-ok" };
		case "result": {
			const id = stringValue(source.id, "result.id");
			if (source.ok === true) return { type: "result", id, ok: true, result: source.result };
			if (source.ok === false)
				return { type: "result", id, ok: false, error: stringValue(source.error, "result.error") };
			throw new Error("result.ok must be a boolean");
		}
		case "message":
			return {
				type: "message",
				message: parseCrossSessionMessage(source.message),
				expectsReply:
					source.expectsReply === undefined ? false : booleanValue(source.expectsReply, "message.expectsReply"),
			};
		case "error":
			return { type: "error", message: stringValue(source.message, "error.message") };
		default:
			throw new Error(`Unknown peers broker message type: ${type}`);
	}
}
