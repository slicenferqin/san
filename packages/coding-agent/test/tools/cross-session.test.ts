/**
 * Cross-session hub integration (focused):
 * - IrcBus external ingress: broker id/timestamp preserved, waiter/session/
 *   inbox routing, agent attribution; external outbound fallback for san:*
 *   auto-replies with ownership-safe cleanup;
 * - hub `list` merging and `send` routing (san:* / local / broadcast fan-out);
 * - wait semantics: san:* from-filtered waits are not liveness-killed, bare
 *   waits consider connected remote peers;
 * - SDK registration gating: headless roots stay local-only unless explicitly
 *   configured; interactive roots register and dispose closes the client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@san/coding-agent/async/job-manager";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { type ExternalSender, IrcBus, type IrcMessage } from "@san/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@san/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@san/coding-agent/registry/agent-registry";
import { createAgentSession } from "@san/coding-agent/sdk";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import type { CustomMessage } from "@san/coding-agent/session/messages";
import type { ToolSession } from "@san/coding-agent/tools";
import { type CoordinationDetails, HubTool } from "@san/coding-agent/tools/hub";
import { removeSyncWithRetries, Snowflake } from "@san/utils";
import type { CrossSessionClient, CrossSessionDeliveryReceipt, CrossSessionPeer } from "../../src/peer";
import * as peerModule from "../../src/peer";

const SELF_ID = "0-Main";
const REMOTE_ID = "san:111111111111";

// ────────────────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────────────────

interface FakeSession {
	session: AgentSession;
	delivered: Array<{ msg: IrcMessage; expectsReply?: boolean }>;
	relayed: CustomMessage[];
	setOutcome: (outcome: "injected" | "woken") => void;
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	const delivered: Array<{ msg: IrcMessage; expectsReply?: boolean }> = [];
	const relayed: CustomMessage[] = [];
	const session = {
		deliverIrcMessage: async (msg: IrcMessage, opts?: { expectsReply?: boolean }) => {
			delivered.push({ msg, expectsReply: opts?.expectsReply });
			return outcome;
		},
		emitIrcRelayObservation: (record: CustomMessage) => {
			relayed.push(record);
		},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		relayed,
		setOutcome: value => {
			outcome = value;
		},
	};
}

/** Contract-shaped transport client fake; records every call. */
class FakeClient implements CrossSessionClient {
	readonly id = "san:client0000000000";
	peers: CrossSessionPeer[] = [];
	sendCalls: Array<{ to: string; body: string; replyTo?: string; expectsReply?: boolean }> = [];
	listCalls = 0;
	closeCalls = 0;
	refreshCalls = 0;
	sendResult: Omit<CrossSessionDeliveryReceipt, "to"> = { outcome: "injected" };

	async list(): Promise<CrossSessionPeer[]> {
		this.listCalls++;
		return this.peers;
	}

	async send(input: {
		to: string;
		body: string;
		replyTo?: string;
		expectsReply?: boolean;
	}): Promise<CrossSessionDeliveryReceipt> {
		this.sendCalls.push(input);
		return { to: input.to, ...this.sendResult };
	}

	async refresh(): Promise<void> {
		this.refreshCalls++;
	}

	async close(): Promise<void> {
		this.closeCalls++;
	}
}

function makeRemotePeer(overrides: Partial<CrossSessionPeer> = {}): CrossSessionPeer {
	return {
		id: REMOTE_ID,
		sessionId: "remote-session-1",
		displayName: "main",
		cwd: "/other/project",
		branch: "feature/x",
		status: "running",
		connectedAt: 1000,
		lastActivity: 2000,
		activity: "reviewing a diff",
		...overrides,
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string, client?: CrossSessionClient): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
		crossSessionClient: client,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// SDK registration-gating helpers: the peer module is namespace-imported and
// spied per-test (no global module-registry mocks), so the real transport is
// never reached while gating assertions run.
// ────────────────────────────────────────────────────────────────────────────

/** Options captured from every createCrossSessionClient call. */
const peerCreateCalls: unknown[] = [];
/** Fake clients handed out by the current spy implementation. */
const peerClients: FakeClient[] = [];
let peerCreateImpl: ((options: unknown) => Promise<CrossSessionClient>) | undefined;

/** Install the recording spy for the whole describe block; restored after. */
function installPeerCreateSpy(): void {
	vi.spyOn(peerModule, "createCrossSessionClient").mockImplementation(async options => {
		peerCreateCalls.push(options);
		if (!peerCreateImpl) throw new Error("cross-session spy has no impl installed");
		return peerCreateImpl(options);
	});
}

/** Default impl: hand out a recording fake client. */
function fakeClientImpl(_options: unknown): Promise<CrossSessionClient> {
	const client = new FakeClient();
	peerClients.push(client);
	return Promise.resolve(client);
}

// ────────────────────────────────────────────────────────────────────────────

describe("IrcBus cross-session ingress", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("preserves broker id/timestamp/replyTo and satisfies a from-filtered wait", async () => {
		const waiting = bus.wait(SELF_ID, { from: REMOTE_ID }, 1000);
		const outcome = await bus.deliverExternal({
			id: "broker-msg-7",
			from: REMOTE_ID,
			to: SELF_ID,
			body: "over the wire",
			ts: 1700000000123,
			replyTo: "local-msg-9",
		});
		expect(outcome).toBe("injected");

		const msg = await waiting;
		expect(msg).toMatchObject({
			id: "broker-msg-7",
			from: REMOTE_ID,
			to: SELF_ID,
			body: "over the wire",
			ts: 1700000000123,
			replyTo: "local-msg-9",
		});
	});

	it("routes to the recipient session with expectsReply forwarded when no waiter is parked", async () => {
		const main = makeFakeSession();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: main.session });

		const outcome = await bus.deliverExternal(
			{ id: "b1", from: REMOTE_ID, to: SELF_ID, body: "which PR?", ts: 111 },
			{ expectsReply: true },
		);
		expect(outcome).toBe("injected");
		expect(main.delivered).toHaveLength(1);
		expect(main.delivered[0]?.msg).toMatchObject({ id: "b1", from: REMOTE_ID, ts: 111 });
		expect(main.delivered[0]?.expectsReply).toBe(true);
	});

	it("routes handoffs past hub waiters and never downgrades them to inbox chat", async () => {
		const main = makeFakeSession();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: main.session });
		const waiting = bus.wait(SELF_ID, { from: REMOTE_ID }, 1_000);

		const outcome = await bus.deliverExternal({
			id: "handoff-1",
			from: REMOTE_ID,
			to: SELF_ID,
			body: "## Goal\nContinue the migration",
			kind: "handoff",
			ts: 211,
		});

		expect(outcome).toBe("injected");
		expect(main.delivered).toHaveLength(1);
		expect(main.delivered[0]?.msg).toMatchObject({ id: "handoff-1", kind: "handoff" });
		expect(bus.inbox(SELF_ID)).toEqual([]);

		await bus.deliverExternal({ id: "chat-1", from: REMOTE_ID, to: SELF_ID, body: "ordinary reply", ts: 212 });
		expect(await waiting).toMatchObject({ id: "chat-1", body: "ordinary reply" });
	});

	it("rejects a handoff when no live recipient can accept continuation context", async () => {
		await expect(
			bus.deliverExternal({
				id: "handoff-missing",
				from: REMOTE_ID,
				to: SELF_ID,
				body: "## Goal\nContinue elsewhere",
				kind: "handoff",
				ts: 213,
			}),
		).rejects.toThrow(`Recipient session "${SELF_ID}" is unavailable for handoff.`);
		expect(bus.inbox(SELF_ID)).toEqual([]);
		expect(bus.unreadCount(SELF_ID)).toBe(0);
	});

	it("buffers to the mailbox when no session exists and a later wait drains it", async () => {
		const outcome = await bus.deliverExternal({
			id: "b2",
			from: REMOTE_ID,
			to: SELF_ID,
			body: "buffered for later",
			ts: 222,
		});
		expect(outcome).toBe("injected");

		const drained = await bus.wait(SELF_ID, { from: REMOTE_ID }, 1000);
		expect(drained).toMatchObject({ id: "b2", from: REMOTE_ID, body: "buffered for later", ts: 222 });
	});

	it("attributes inbound peer text as agent, never user/system", async () => {
		const main = makeFakeSession();
		const worker = makeFakeSession();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Worker", displayName: "task", kind: "sub", session: worker.session });

		await bus.deliverExternal({ id: "b3", from: REMOTE_ID, to: "0-Worker", body: "hi", ts: 333 });
		expect(worker.delivered[0]?.msg.from).toBe(REMOTE_ID);
		expect(main.relayed).toHaveLength(1);
		expect(main.relayed[0]?.attribution).toBe("agent");
		expect(main.relayed[0]?.details).toMatchObject({ from: REMOTE_ID, to: "0-Worker" });
	});
});

describe("IrcBus cross-session outbound (auto-reply fallback)", () => {
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("routes san:* sends through the registered external sender", async () => {
		const sent: Array<{ to: string; body: string; replyTo?: string; expectsReply?: boolean }> = [];
		const sender: ExternalSender = {
			id: "san:client0000000000",
			send: async input => {
				sent.push(input);
				return { to: input.to, outcome: "injected" };
			},
		};
		const disposer = bus.setExternalSender(sender);

		const receipt = await bus.send(
			{ from: "Main", to: REMOTE_ID, body: "auto answer", replyTo: "b1" },
			{ expectsReply: true },
		);
		expect(sent).toEqual([{ to: REMOTE_ID, body: "auto answer", replyTo: "b1", expectsReply: true }]);
		expect(receipt).toEqual({ to: REMOTE_ID, outcome: "injected" });
		disposer();
	});

	it("leaves san:* sends failed without a sender (local-only behavior unchanged)", async () => {
		const receipt = await bus.send({ from: "Main", to: REMOTE_ID, body: "x" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("Unknown agent");
	});

	it("never routes non-san unknown ids through the external sender", async () => {
		let called = false;
		bus.setExternalSender({
			id: "san:client0000000000",
			send: async () => {
				called = true;
				return { to: "", outcome: "injected" };
			},
		});

		const receipt = await bus.send({ from: "Main", to: "0-Ghost", body: "x" });
		expect(receipt.outcome).toBe("failed");
		expect(called).toBe(false);
	});

	it("an older session's disposer does not disconnect a newer sender route", async () => {
		const calls: string[] = [];
		const senderA: ExternalSender = {
			id: "san:aaaa",
			send: async () => {
				calls.push("a");
				return { to: "", outcome: "injected" };
			},
		};
		const senderB: ExternalSender = {
			id: "san:bbbb",
			send: async () => {
				calls.push("b");
				return { to: "", outcome: "injected" };
			},
		};

		const disposeA = bus.setExternalSender(senderA);
		const disposeB = bus.setExternalSender(senderB);
		disposeA(); // older session disposes first — must not clear B's route

		await bus.send({ from: "Main", to: REMOTE_ID, body: "x" });
		expect(calls).toEqual(["b"]);

		disposeB(); // the owning session disposes — route is cleared
		await bus.send({ from: "Main", to: REMOTE_ID, body: "x" });
		expect(calls).toEqual(["b"]);
	});
});

describe("hub list with cross-session peers", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("merges remote peers with scope/sessionId/cwd/branch and keeps local rows unchanged", async () => {
		const worker = makeFakeSession();
		registry.register({ id: "0-Worker", displayName: "task", kind: "sub", session: worker.session });

		const client = new FakeClient();
		client.peers = [
			makeRemotePeer(),
			makeRemotePeer({ id: "san:222222222222", sessionId: "remote-session-2", branch: undefined, status: "idle" }),
		];
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "list" });
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("list");

		const localRow = details.peers?.find(peer => peer.id === "0-Worker");
		expect(localRow?.scope).toBeUndefined();
		expect(localRow?.sessionId).toBeUndefined();

		const remoteRow = details.peers?.find(peer => peer.id === REMOTE_ID);
		expect(remoteRow).toMatchObject({
			scope: "remote",
			kind: "remote",
			sessionId: "remote-session-1",
			cwd: "/other/project",
			branch: "feature/x",
			status: "running",
		});
		expect(details.peers?.some(peer => peer.id === "san:222222222222" && peer.branch === undefined)).toBe(true);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(REMOTE_ID);
		expect(text).toContain("remote session remote-session-1");
		expect(text).toContain("cwd /other/project");
		expect(text).toContain("branch feature/x");
	});

	it("keeps a local roster row when a remote peer has the same id", async () => {
		const local = makeFakeSession();
		registry.register({ id: REMOTE_ID, displayName: "local wins", kind: "sub", session: local.session });
		const client = new FakeClient();
		client.peers = [makeRemotePeer({ displayName: "remote loses" })];
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "list" });
		const rows = (result.details as CoordinationDetails).peers?.filter(peer => peer.id === REMOTE_ID);
		expect(rows).toHaveLength(1);
		expect(rows?.[0]).toMatchObject({ displayName: "local wins", kind: "sub" });
		expect(rows?.[0]?.scope).toBeUndefined();
	});

	it("normalizes remote roster metadata to one line, preserving ordinary content", async () => {
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const client = new FakeClient();
		client.peers = [
			makeRemotePeer({
				displayName: "evil\n- fake roster row\t\u001b[1mred",
				activity: "editing\n\twith tabs",
				cwd: "/very/long/but/ordinary/path",
				branch: "feature\ttwo\nlines",
				sessionId: "sess\none",
			}),
		];
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "list" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		// The hostile text lands inside ONE collapsed roster line — never as a
		// fake extra row — and no tabs, ESC, or control characters survive.
		const lines = text.split("\n");
		expect(lines.filter(line => line.includes("fake roster row"))).toHaveLength(1);
		const peerLine = lines.find(line => line.includes(REMOTE_ID));
		expect(peerLine).toBeDefined();
		expect(peerLine).toContain("evil - fake roster row [1mred");
		expect(peerLine).not.toContain("\t");
		expect(peerLine).not.toContain("\u001b");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\u001b");

		// Details rows carry the same one-line values; ordinary content (the
		// cwd) is preserved verbatim, and no Cc/Cf character leaks into the
		// renderer-facing fields.
		const details = result.details as CoordinationDetails;
		const row = details.peers?.find(peer => peer.id === REMOTE_ID);
		expect(row?.displayName).toBe("evil - fake roster row [1mred");
		expect(row?.activity).toBe("editing with tabs");
		expect(row?.cwd).toBe("/very/long/but/ordinary/path");
		expect(row?.branch).toBe("feature two lines");
		expect(row?.sessionId).toBe("sess one");
		for (const field of [row?.displayName, row?.activity, row?.cwd, row?.branch, row?.sessionId]) {
			expect(field ?? "").not.toMatch(/[\p{Cc}\p{Cf}]/u);
		}
	});

	it("a transport list failure degrades to the local roster only", async () => {
		const worker = makeFakeSession();
		registry.register({ id: "0-Worker", displayName: "task", kind: "sub", session: worker.session });

		const client = new FakeClient();
		client.list = async () => {
			throw new Error("broker unreachable");
		};
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "list" });
		const details = result.details as CoordinationDetails;
		expect(details.peers?.map(peer => peer.id)).toEqual(["0-Worker"]);
		expect(result.isError).not.toBe(true);
	});
});

describe("hub send with cross-session peers", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("routes exact san:* targets through the transport, not the bus", async () => {
		const client = new FakeClient();
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "send", to: REMOTE_ID, message: "ping" });
		expect(client.sendCalls).toEqual([{ to: REMOTE_ID, body: "ping", replyTo: undefined, expectsReply: undefined }]);
		const details = result.details as CoordinationDetails;
		expect(details.receipts).toEqual([{ to: REMOTE_ID, outcome: "injected" }]);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("- san:111111111111: injected");
	});

	it("keeps local ids on the bus and never touches the transport", async () => {
		const sub = makeFakeSession();
		registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
		const client = new FakeClient();
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "local ping" });
		expect(client.sendCalls).toHaveLength(0);
		expect(sub.delivered).toHaveLength(1);
		expect(sub.delivered[0]!.msg.body).toBe("local ping");
		expect(result.isError).not.toBe(true);
	});

	it("routes a san:-prefixed id to a local ref when one exists", async () => {
		const localSan = "san:000000000000";
		const local = makeFakeSession();
		registry.register({ id: localSan, displayName: "local san agent", kind: "sub", session: local.session });
		const client = new FakeClient();
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "send", to: localSan, message: "hi local" });
		// The local ref wins: the transport is never touched.
		expect(client.sendCalls).toHaveLength(0);
		expect(local.delivered).toHaveLength(1);
		expect(local.delivered[0]!.msg.to).toBe(localSan);
		expect(local.delivered[0]!.msg.body).toBe("hi local");
		expect((result.details as CoordinationDetails).receipts).toEqual([{ to: localSan, outcome: "injected" }]);
		expect(result.isError).not.toBe(true);
	});

	it("broadcast fans out to local and remote without duplicating ids", async () => {
		const a = makeFakeSession();
		const b = makeFakeSession();
		registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
		registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
		const localCollision = makeFakeSession();
		registry.register({ id: REMOTE_ID, displayName: "local san peer", kind: "sub", session: localCollision.session });

		const client = new FakeClient();
		client.peers = [makeRemotePeer(), makeRemotePeer({ id: "san:222222222222" })];
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "send", to: "all", message: "heads up" });
		const details = result.details as CoordinationDetails;
		const receiptIds = details.receipts?.map(receipt => receipt.to) ?? [];
		expect(receiptIds.sort()).toEqual(["0-A", "0-B", REMOTE_ID, "san:222222222222"]);
		expect(new Set(receiptIds).size).toBe(4);
		expect(localCollision.delivered).toHaveLength(1);
		expect(client.sendCalls.map(call => call.to)).toEqual(["san:222222222222"]);
	});

	it("rejects san:* sends without a cross-session client", async () => {
		const tool = new HubTool(makeToolSession(registry, SELF_ID));
		const result = await tool.execute("call-1", { op: "send", to: REMOTE_ID, message: "ping" });
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Cross-session messaging is unavailable");
	});

	it("surfaces remote failed receipts", async () => {
		const client = new FakeClient();
		client.sendResult = { outcome: "failed", error: "peer disconnected" };
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "send", to: REMOTE_ID, message: "ping" });
		expect(result.isError).toBe(true);
		expect((result.details as CoordinationDetails).receipts).toEqual([
			{ to: REMOTE_ID, outcome: "failed", error: "peer disconnected" },
		]);
	});

	it("await:true round-trips a reply arriving over external ingress", async () => {
		const client = new FakeClient();
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const pending = tool.execute("call-1", {
			op: "send",
			to: REMOTE_ID,
			message: "which PR?",
			await: true,
			timeoutMs: 1000,
		});
		// The remote answers: its reply lands in the local bus via deliverExternal.
		await IrcBus.global().deliverExternal({
			id: "remote-reply-1",
			from: REMOTE_ID,
			to: SELF_ID,
			body: "PR #42",
			ts: 5000,
			replyTo: "local-msg-1",
		});

		const result = await pending;
		expect(result.isError).not.toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Reply from san:111111111111:");
		expect(text).toContain("PR #42");
	});
});

describe("hub wait with cross-session peers", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("a from-filtered wait for a san:* sender is not aborted by local registry liveness", async () => {
		// Only the caller is registered — no local ref exists for the remote
		// sender, so liveness would abort the wait instantly if it applied.
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const client = new FakeClient();
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const pending = tool.execute("call-1", { op: "wait", from: REMOTE_ID, timeoutMs: 1000 });
		await bus.deliverExternal({ id: "w1", from: REMOTE_ID, to: SELF_ID, body: "here I am", ts: 1 });

		const result = await pending;
		expect(result.isError).not.toBe(true);
		expect((result.details as CoordinationDetails).waited).toMatchObject({
			id: "w1",
			from: REMOTE_ID,
			body: "here I am",
		});
	});

	it("bare wait blocks when remote peers are connected and resolves on their message", async () => {
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const client = new FakeClient();
		client.peers = [makeRemotePeer()];
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const pending = tool.execute("call-1", { op: "wait" });
		await bus.deliverExternal({ id: "w2", from: REMOTE_ID, to: SELF_ID, body: "from another machine", ts: 2 });

		const result = await pending;
		expect(result.isError).not.toBe(true);
		expect((result.details as CoordinationDetails).waited?.body).toBe("from another machine");
	});

	it("bare wait still returns nothing when no local or remote peers exist", async () => {
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		const client = new FakeClient(); // list() → []
		const tool = new HubTool(makeToolSession(registry, SELF_ID, client));

		const result = await tool.execute("call-1", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});
});

describe("SDK cross-session registration gating", () => {
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "san-cross-session-sdk-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		peerCreateCalls.length = 0;
		peerClients.length = 0;
		peerCreateImpl = undefined;
		installPeerCreateSpy();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function spawnSession(options: {
		hasUI?: boolean;
		extraSettings?: Record<string, unknown>;
		parentTaskPrefix?: string;
	}): Promise<AgentSession> {
		const { extraSettings, ...sessionOptions } = options;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `san-cross-session-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const result = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "async.enabled": false, ...(extraSettings ?? {}) }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			...sessionOptions,
		});
		sessions.push(result.session);
		return result.session;
	}

	it("headless SDK roots do not register even though the default is enabled", async () => {
		await spawnSession({});
		expect(peerCreateCalls).toHaveLength(0);
	});

	it("interactive roots register after session attachment and dispose closes the client", async () => {
		peerCreateImpl = fakeClientImpl;
		const session = await spawnSession({ hasUI: true });

		expect(peerCreateCalls).toHaveLength(1);
		const client = peerClients[0];
		expect(client.closeCalls).toBe(0);

		const options = peerCreateCalls[0] as {
			metadata: () => Record<string, unknown>;
			deliver: (...args: unknown[]) => Promise<unknown>;
		};
		const metadata = options.metadata();
		expect(typeof metadata.sessionId).toBe("string");
		expect(metadata.cwd).toContain("project");
		expect(metadata.displayName).toBe("main");
		expect(metadata.status).toBe("running");
		// Not a git repo under the OS temp dir: branch metadata resolves to
		// undefined (or a string when the temp root happens to sit in a repo) —
		// the contract is that resolution never throws.
		expect(metadata.branch === undefined || typeof metadata.branch === "string").toBe(true);

		await session.dispose();
		expect(client.closeCalls).toBe(1);
	});

	it("interactive roots with crossSession.enabled explicitly false do not register", async () => {
		await spawnSession({ hasUI: true, extraSettings: { "crossSession.enabled": false } });
		expect(peerCreateCalls).toHaveLength(0);
	});

	it("headless roots register when crossSession.enabled is explicitly configured", async () => {
		peerCreateImpl = fakeClientImpl;
		await spawnSession({ extraSettings: { "crossSession.enabled": true } });
		expect(peerCreateCalls).toHaveLength(1);
	});

	it("subagent roots never register even with crossSession.enabled explicitly true", async () => {
		peerCreateImpl = fakeClientImpl;
		await spawnSession({
			hasUI: true,
			parentTaskPrefix: "ParentTask",
			extraSettings: { "crossSession.enabled": true },
		});
		expect(peerCreateCalls).toHaveLength(0);
	});

	it("a status change refreshes the peer record and metadata reflects it", async () => {
		peerCreateImpl = fakeClientImpl;
		const session = await spawnSession({ hasUI: true });
		const client = peerClients[0];
		const options = peerCreateCalls[0] as {
			metadata: () => Record<string, unknown>;
		};
		expect(client.refreshCalls).toBe(0);

		AgentRegistry.global().setStatus("Main", "idle");
		expect(client.refreshCalls).toBe(1);
		expect(options.metadata().status).toBe("idle");

		AgentRegistry.global().setStatus("Main", "running");
		expect(client.refreshCalls).toBe(2);
		expect(options.metadata().status).toBe("running");

		await session.dispose();
	});

	it("dispose unsubscribes the status and activity refresh callbacks", async () => {
		peerCreateImpl = fakeClientImpl;
		const session = await spawnSession({ hasUI: true });
		const client = peerClients[0];

		// Live subscriptions: both event paths refresh the peer record.
		AgentRegistry.global().setActivity("Main", "editing foo");
		expect(client.refreshCalls).toBe(1);
		AgentRegistry.global().setStatus("Main", "idle");
		expect(client.refreshCalls).toBe(2);

		await session.dispose();
		expect(client.closeCalls).toBe(1);
		const frozen = client.refreshCalls;

		// Re-register the same root id (dispose unregistered or parked the old
		// ref) and fire every event type again: the disposed session's
		// subscriptions must never reach the closed client.
		AgentRegistry.global().register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: null,
			status: "running",
		});
		AgentRegistry.global().setStatus("Main", "idle");
		AgentRegistry.global().setStatus("Main", "running");
		AgentRegistry.global().setActivity("Main", "editing bar");
		expect(client.refreshCalls).toBe(frozen);
	});

	it("an activity gist change is advertised through refresh and metadata", async () => {
		peerCreateImpl = fakeClientImpl;
		const session = await spawnSession({ hasUI: true });

		const client = peerClients[0];
		const options = peerCreateCalls[0] as {
			metadata: () => Record<string, unknown>;
		};
		expect(client.refreshCalls).toBe(0);
		expect(options.metadata().activity).toBeUndefined();

		// setActivity emits on the change-only activity listener path, so the
		// broker record refresh fires even though the status never changed.
		AgentRegistry.global().setActivity("Main", "editing foo");
		expect(client.refreshCalls).toBe(1);
		expect(options.metadata().activity).toBe("editing foo");

		// An unchanged gist is a heartbeat, not a change: no refresh spam.
		AgentRegistry.global().setActivity("Main", "editing foo");
		expect(client.refreshCalls).toBe(1);

		await session.dispose();
	});

	it("transport startup failure logs a warning and leaves the session usable", async () => {
		peerCreateImpl = async () => {
			throw new Error("broker unreachable");
		};
		const session = await spawnSession({ hasUI: true });
		expect(peerCreateCalls).toHaveLength(1);
		await session.dispose(); // must not throw
	});
});
