/**
 * Focused tests for the `session_handoff` built-in tool:
 * - contract declarations: essential / interruptible / read approval, fixed name+label;
 * - exposure gating: root sessions only (`taskDepth === 0`), subagents get no tool;
 * - execution: generator focus/abort forwarding, `kind: "handoff"` wire shape,
 *   success result reporting target + delivery outcome;
 * - failure paths: missing transport/generator, invalid or self targets,
 *   empty/undefined summaries, failed receipts, generator and transport throws.
 */
import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@san/coding-agent/config/settings";
import { createTools, type ToolSession } from "@san/coding-agent/tools";
import { SessionHandoffTool } from "@san/coding-agent/tools/session-handoff";
import type {
	CrossSessionClient,
	CrossSessionDeliveryReceipt,
	CrossSessionMessageKind,
	CrossSessionPeer,
} from "../../src/peer";

const REMOTE_ID = "san:bbbbbbbbbbbb";

/** Contract-shaped transport client fake; records every send. */
class FakeClient implements CrossSessionClient {
	readonly id = "san:aaaaaaaaaaaa";
	sendCalls: Array<{
		to: string;
		body: string;
		replyTo?: string;
		expectsReply?: boolean;
		kind?: CrossSessionMessageKind;
	}> = [];
	sendResult: Omit<CrossSessionDeliveryReceipt, "to"> = { outcome: "injected" };
	sendError: Error | undefined;

	async list(): Promise<CrossSessionPeer[]> {
		return [];
	}

	async send(input: {
		to: string;
		body: string;
		replyTo?: string;
		expectsReply?: boolean;
		kind?: CrossSessionMessageKind;
	}): Promise<CrossSessionDeliveryReceipt> {
		this.sendCalls.push(input);
		if (this.sendError) throw this.sendError;
		return { to: input.to, ...this.sendResult };
	}

	async refresh(): Promise<void> {}

	async close(): Promise<void> {}
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdev": false }),
		taskDepth: 0,
		...overrides,
	};
}

function makeGenerator(summary?: string): NonNullable<ToolSession["generateSessionHandoff"]> {
	return vi.fn<(focus?: string, signal?: AbortSignal) => Promise<string | undefined>>(
		async (_focus, _signal) => summary,
	);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(item => item.type === "text")
		.map(item => item.text ?? "")
		.join("\n");
}

describe("session_handoff", () => {
	it("declares the fixed contract (essential, interruptible, read approval)", () => {
		const tool = SessionHandoffTool.createIf(makeSession());
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe("session_handoff");
		expect(tool!.label).toBe("Session Handoff");
		expect(tool!.loadMode).toBe("essential");
		expect(tool!.interruptible).toBe(true);
		expect(tool!.approval).toBe("read");
	});

	it("exposes the tool only in root sessions (taskDepth === 0)", async () => {
		expect(SessionHandoffTool.createIf(makeSession({ taskDepth: 0 }))).not.toBeNull();
		expect(SessionHandoffTool.createIf(makeSession({ taskDepth: 1 }))).toBeNull();
		expect(SessionHandoffTool.createIf(makeSession({ taskDepth: 2 }))).toBeNull();

		const rootTools = await createTools(makeSession());
		expect(rootTools.map(tool => tool.name)).toContain("session_handoff");
		const subagentTools = await createTools(makeSession({ taskDepth: 1 }));
		expect(subagentTools.map(tool => tool.name)).not.toContain("session_handoff");
	});

	it("generates the summary and sends it with kind: handoff", async () => {
		const client = new FakeClient();
		const generator = makeGenerator("handoff document body");
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(generator).toHaveBeenCalledTimes(1);
		expect(client.sendCalls).toEqual([{ to: REMOTE_ID, body: "handoff document body", kind: "handoff" }]);
		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "injected" });
		const text = resultText(result);
		expect(text).toContain(REMOTE_ID);
		expect(text).toContain("injected");
	});

	it("reports the delivery outcome on success", async () => {
		const client = new FakeClient();
		client.sendResult = { outcome: "woken" };
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: makeGenerator("doc") }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "woken" });
	});

	it("forwards focus and the abort signal to the generator", async () => {
		const client = new FakeClient();
		const generator = makeGenerator("doc");
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);
		const signal = new AbortController().signal;

		await tool.execute("call-1", { to: REMOTE_ID, focus: "finish the API" }, signal);
		expect(generator).toHaveBeenCalledWith("finish the API", signal);

		await tool.execute("call-2", { to: REMOTE_ID }, signal);
		expect(generator).toHaveBeenLastCalledWith(undefined, signal);
	});

	it("fails fast when the cross-session transport is missing", async () => {
		const generator = makeGenerator("doc");
		const tool = new SessionHandoffTool(makeSession({ generateSessionHandoff: generator }));

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed" });
		expect(resultText(result)).toContain("Cross-session transport is unavailable");
		expect(generator).not.toHaveBeenCalled();
	});

	it("fails fast when the generator is missing", async () => {
		const client = new FakeClient();
		const tool = new SessionHandoffTool(makeSession({ crossSessionClient: client }));

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed" });
		expect(resultText(result)).toContain("Handoff generation is unavailable");
		expect(client.sendCalls).toHaveLength(0);
	});

	it.each([
		"Main",
		"san:",
		"san:123",
		"san:bbbbbbbbbbbbX",
		"san:BBBBBBBBBBBB",
		"san:zzzzzzzzzzzz",
	])("rejects invalid target %s", async to => {
		const client = new FakeClient();
		const generator = makeGenerator("doc");
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);

		const result = await tool.execute("call-1", { to });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to, outcome: "failed" });
		expect(resultText(result)).toContain("Invalid target");
		expect(generator).not.toHaveBeenCalled();
		expect(client.sendCalls).toHaveLength(0);
	});

	it("rejects handing off to this runtime itself", async () => {
		const client = new FakeClient();
		const generator = makeGenerator("doc");
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);

		const result = await tool.execute("call-1", { to: client.id });

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("Cannot hand off to this session itself");
		expect(generator).not.toHaveBeenCalled();
		expect(client.sendCalls).toHaveLength(0);
	});

	it.each([undefined, ""])("errors when the generator yields an empty summary (%p)", async summary => {
		const client = new FakeClient();
		const generator = makeGenerator(summary);
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed" });
		expect(resultText(result)).toContain("produced no summary");
		expect(client.sendCalls).toHaveLength(0);
	});

	it("marks a failed delivery receipt as an error", async () => {
		const client = new FakeClient();
		client.sendResult = { outcome: "failed", error: "peer gone" };
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: makeGenerator("doc") }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed", error: "peer gone" });
		expect(resultText(result)).toContain("peer gone");
	});

	it("reports transport send failures as error results", async () => {
		const client = new FakeClient();
		client.sendError = new Error("broker unreachable");
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: makeGenerator("doc") }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed", error: "broker unreachable" });
		expect(resultText(result)).toContain("broker unreachable");
	});

	it("reports generator failures as error results", async () => {
		const client = new FakeClient();
		const generator = vi.fn<(focus?: string, signal?: AbortSignal) => Promise<string | undefined>>(async () => {
			throw new Error("Nothing to hand off (no messages yet)");
		});
		const tool = new SessionHandoffTool(
			makeSession({ crossSessionClient: client, generateSessionHandoff: generator }),
		);

		const result = await tool.execute("call-1", { to: REMOTE_ID });

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ to: REMOTE_ID, outcome: "failed" });
		expect(resultText(result)).toContain("Nothing to hand off (no messages yet)");
		expect(client.sendCalls).toHaveLength(0);
	});
});
