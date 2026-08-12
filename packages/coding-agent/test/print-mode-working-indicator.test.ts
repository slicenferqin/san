import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { runPrintMode } from "@san/coding-agent/modes/print-mode";
import type { AgentSession } from "@san/coding-agent/session/agent-session";

function makeAssistantMessage(text: string): AssistantMessage {
	const timestamp = Date.now();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp,
	};
}

interface DelayedSession {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
	getTextOutputCommitted: () => boolean;
	getTextOutputCommitTransitions: () => boolean[];
}

function createDelayedSession(finalMessage: AssistantMessage, promptError?: Error): DelayedSession {
	const messages: AssistantMessage[] = [];
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	const textOutputCommitTransitions: boolean[] = [];
	let textOutputCommitted = true;

	const session = {
		state: { messages },
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {
			markPromptStarted();
			await promptReleased;
			if (promptError) throw promptError;
			messages.push(finalMessage);
			return true;
		},
		setTextOutputCommitted: (committed: boolean) => {
			textOutputCommitted = committed;
			textOutputCommitTransitions.push(committed);
		},
		dispose: async () => {},
	} as unknown as AgentSession;

	return {
		session,
		promptStarted,
		resolvePrompt,
		getTextOutputCommitted: () => textOutputCommitted,
		getTextOutputCommitTransitions: () => textOutputCommitTransitions,
	};
}

describe("print mode working indicator", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a text-mode working indicator before the prompt resolves and prints the final answer afterward", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toContain("Working");
			expect(stdoutOutput.join("")).toBe("");
			expect(delayed.getTextOutputCommitted()).toBe(false);
		} finally {
			delayed.resolvePrompt();
			await run;
		}

		expect(stdoutOutput.join("")).toBe("final answer\n");
		expect(delayed.getTextOutputCommitted()).toBe(true);
		expect(delayed.getTextOutputCommitTransitions()).toEqual([false, true]);
	});

	it("does not write the text-mode working indicator in JSON mode while the prompt is pending", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("json answer"));
		const run = runPrintMode(delayed.session, { mode: "json", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toBe("");
			expect(delayed.getTextOutputCommitted()).toBe(true);
		} finally {
			delayed.resolvePrompt();
			await run;
		}
		expect(delayed.getTextOutputCommitTransitions()).toEqual([]);
	});

	it("writes the text-mode working indicator once across successive prompts", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, {
			mode: "text",
			initialMessage: "hello",
			messages: ["follow-up"],
		});

		await delayed.promptStarted;
		delayed.resolvePrompt();
		await run;

		expect(stderrOutput.join("")).toBe("Working...\n");
		expect(delayed.getTextOutputCommitTransitions()).toEqual([false, false, true]);
	});

	it("restores committed text state when a text-mode prompt rejects", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("unused"), new Error("prompt failed"));
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "hello" });

		await delayed.promptStarted;
		delayed.resolvePrompt();
		await expect(run).rejects.toThrow("prompt failed");

		expect(delayed.getTextOutputCommitted()).toBe(true);
		expect(delayed.getTextOutputCommitTransitions()).toEqual([false, true]);
	});
});
