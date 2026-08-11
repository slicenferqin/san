import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { runPrintMode } from "@san/coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@san/coding-agent/session/agent-session";

interface FlushHarness {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	emit: (event: AgentSessionEvent) => void;
	disposed: () => boolean;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function createFlushHarness(finalMessage?: AssistantMessage): FlushHarness {
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let disposed = false;
	const messages: AssistantMessage[] = [];

	const session = {
		state: { messages },
		sessionManager: { getHeader: () => undefined },
		extensionRunner: undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async () => {
			markPromptStarted();
			await promptReleased;
			if (finalMessage) messages.push(finalMessage);
			return true;
		},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;

	return {
		session,
		promptStarted,
		resolvePrompt,
		emit: event => subscriber?.(event),
		disposed: () => disposed,
	};
}

function agentEnd(payload: string): AgentSessionEvent {
	return {
		type: "agent_end",
		messages: [assistantMessage(payload)],
	} as unknown as AgentSessionEvent;
}

async function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("print mode stdout 排空", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("JSON 模式等待最终大记录的写入回调后才退出", async () => {
		const writes: string[] = [];
		let releaseFinalWrite: (() => void) | undefined;
		const { promise: finalWriteIssued, resolve: markFinalWriteIssued } = Promise.withResolvers<void>();
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
			writes.push(text);
			const callback = args[args.length - 1];
			const done = typeof callback === "function" ? (callback as (err?: Error | null) => void) : undefined;
			if (text.includes('"type":"agent_end"')) {
				releaseFinalWrite = () => done?.(null);
				markFinalWriteIssued();
			} else {
				done?.(null);
			}
			return true;
		});

		const payload = "x".repeat(1_500_000);
		const harness = createFlushHarness();
		const run = runPrintMode(harness.session, { mode: "json", initialMessage: "hello" });
		let settled = false;
		void run.then(() => {
			settled = true;
		});

		await harness.promptStarted;
		harness.emit(agentEnd(payload));
		harness.resolvePrompt();
		await finalWriteIssued;
		await nextMacrotask();

		expect(settled).toBe(false);
		expect(harness.disposed()).toBe(false);
		releaseFinalWrite?.();
		await run;

		expect(harness.disposed()).toBe(true);
		const finalLine = writes.find(line => line.includes('"type":"agent_end"'));
		expect(finalLine?.endsWith("\n")).toBe(true);
		expect(finalLine).toContain(payload);
		expect(JSON.parse(finalLine as string)).toMatchObject({ type: "agent_end" });
	});

	it("文本模式等待最终大响应的写入回调后才 dispose", async () => {
		let releaseFinalWrite: (() => void) | undefined;
		const { promise: finalWriteIssued, resolve: markFinalWriteIssued } = Promise.withResolvers<void>();
		const payload = "y".repeat(1_500_000);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const callback = args[args.length - 1];
			const done = typeof callback === "function" ? (callback as (err?: Error | null) => void) : undefined;
			releaseFinalWrite = () => done?.(null);
			markFinalWriteIssued();
			return true;
		});

		const harness = createFlushHarness(assistantMessage(payload));
		const run = runPrintMode(harness.session, { mode: "text", initialMessage: "hello" });
		await harness.promptStarted;
		harness.resolvePrompt();
		await finalWriteIssued;
		await nextMacrotask();

		expect(harness.disposed()).toBe(false);
		releaseFinalWrite?.();
		await run;
		expect(harness.disposed()).toBe(true);
	});
});
