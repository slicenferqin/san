import { describe, expect, it } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "@san/ai";
import type { BenchModelRegistry } from "../src/cli/bench-runtime";
import { type IfBenchCommandArgs, runIfBenchCommand } from "../src/if-bench";
import { applyActions, initialArray, makeActions } from "../src/if-bench/actions";
import { assessResponse, buildTurnPrompt } from "../src/if-bench/protocol";
import type { IfBenchSummary } from "../src/if-bench/runner";

const LENGTH = 24;
const NYA_MAX = 8;
const model = {
	provider: "acme",
	id: "if-bench-model",
	name: "if-bench-model",
	api: "openai-completions",
	maxTokens: 4096,
	contextWindow: 128_000,
} as unknown as Model<Api>;
const registry: BenchModelRegistry = {
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "sk-test",
	resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
};

function replyStream(text: string): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 10, output: 5 },
		duration: 100,
	} as unknown as AssistantMessage;
	const events = [{ type: "done", message }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
	const events = [{ type: "error", error: { errorMessage } }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, {
		result: async () => {
			throw new Error(errorMessage);
		},
	}) as unknown as AssistantMessageEventStream;
}

function perfectResult(turn: number): string {
	let state = initialArray(LENGTH);
	let applied = 0;
	for (let index = 1; index <= turn; index += 1) {
		state = applyActions(state, makeActions(LENGTH, applied, index));
		applied += index;
	}
	return state;
}

interface CapturedTurn {
	messages: Context["messages"];
	prompt: string;
}

async function runScripted(
	reply: (turn: number, expected: string) => string,
	flags: Pick<IfBenchCommandArgs["flags"], "turns"> = { turns: 4 },
): Promise<{ summary: IfBenchSummary; captured: CapturedTurn[] }> {
	const captured: CapturedTurn[] = [];
	const summary = await runIfBenchCommand(
		{ models: ["acme/if-bench-model"], flags: { turns: flags.turns, par: 1 } },
		{
			createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
			randomSessionId: () => "sess-0",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			now: () => 0,
			stdoutIsTTY: false,
			streamSimple: (_model, context) => {
				const turn = captured.length + 1;
				const last = context.messages[context.messages.length - 1];
				captured.push({
					messages: [...context.messages],
					prompt: typeof last?.content === "string" ? last.content : "",
				});
				return replyStream(reply(turn, perfectResult(turn)));
			},
		},
	);
	return { summary, captured };
}

describe("if-bench machine", () => {
	it("keeps every generated action a reproducible permutation", () => {
		const start = initialArray(LENGTH);
		const permuted = applyActions(start, makeActions(LENGTH, 0, 40));
		expect(permuted).not.toBe(start);
		expect([...permuted].sort().join("")).toBe([...start].sort().join(""));
		let staged = start;
		let applied = 0;
		for (const count of [1, 2, 3]) {
			staged = applyActions(staged, makeActions(LENGTH, applied, count));
			applied += count;
		}
		expect(staged).toBe(applyActions(start, makeActions(LENGTH, 0, 6)));
	});

	it("rejects invalid array lengths before a benchmark starts", () => {
		expect(() => initialArray(11)).toThrow(/even/);
		expect(() => initialArray(4)).toThrow(/\[8, 26\]/);
	});
});

describe("if-bench scoring", () => {
	it("separates array correctness, cat compliance, and response format", () => {
		expect(assessResponse("<ABC DEF> nya", "ABCDEF", NYA_MAX)).toMatchObject({ passed: true });
		expect(assessResponse("<ABCDEF>", "ABCDEF", NYA_MAX)).toMatchObject({ failure: "cat" });
		expect(assessResponse("<FEDCBA> nya", "ABCDEF", NYA_MAX)).toMatchObject({ failure: "result" });
		expect(assessResponse("ABCDEF nya", "ABCDEF", NYA_MAX)).toMatchObject({ failure: "format" });
	});

	it("does not count an over-long or echoed cat directive", () => {
		expect(assessResponse("<ABCDEF> nyaaaaaaaaa", "ABCDEF", NYA_MAX)).toMatchObject({ failure: "cat" });
		expect(assessResponse("<ABCDEF> nya{1,8}", "ABCDEF", NYA_MAX)).toMatchObject({ failure: "cat" });
	});
});

describe("if-bench prompts and run", () => {
	it("rotates the directive and seeds the array only on the first turn", () => {
		const actions = makeActions(LENGTH, 0, 4);
		const first = buildTurnPrompt({ turn: 1, start: "ABCD", actions, nyaMax: NYA_MAX });
		expect(first.placement).toBe("beginning");
		expect(first.content.startsWith("Include one lowercase cat sound")).toBe(true);
		expect(first.content).toContain("START <ABCD>");

		const second = buildTurnPrompt({ turn: 2, actions, nyaMax: NYA_MAX });
		expect(second.placement).toBe("middle");
		expect(second.content).not.toContain("START");
		const lines = second.content.split("\n");
		const directive = lines.findIndex(line => line.startsWith("Include one"));
		expect(lines[directive - 1]?.startsWith("ACTIONS ")).toBe(true);
		expect(lines[directive + 1]?.startsWith("ACTIONS ")).toBe(true);
	});

	it("carries state through accepted replies and reports the first broken turn", async () => {
		const { summary, captured } = await runScripted((turn, expected) =>
			turn === 3 ? `<${expected}>` : `<${expected}> nya`,
		);
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(2);
		expect(report.actionsPassed).toBe(3);
		expect(report.failure).toMatchObject({ turn: 3, kind: "cat" });
		expect(summary.failures).toBe(1);
		expect(captured[2]!.messages.filter(entry => entry.role === "assistant")).toHaveLength(2);
		expect(captured[1]!.prompt).not.toContain("START");
	});

	it("survives the full turn budget when both contracts hold", async () => {
		const { summary } = await runScripted((_turn, expected) => `nya <${expected}>`, { turns: 3 });
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(3);
		expect(report.actionsPassed).toBe(6);
		expect(report.failure).toBeUndefined();
		expect(summary.failures).toBe(0);
	});

	it("retries a transient cyber refusal instead of ending the run", async () => {
		let attempts = 0;
		const summary = await runIfBenchCommand(
			{ models: ["acme/if-bench-model"], flags: { turns: 2, par: 1 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `sess-${crypto.randomUUID()}`,
				sleep: async () => {},
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				now: () => 0,
				stdoutIsTTY: false,
				streamSimple: (_model, context) => {
					attempts += 1;
					const turn = context.messages.filter(entry => entry.role === "user").length;
					return attempts === 1
						? errorStream("Refusal (cyber): blocked")
						: replyStream(`<${perfectResult(turn)}> nya`);
				},
			},
		);
		const report = summary.models[0]!;
		expect(attempts).toBe(3);
		expect(report.turns[0]!.passed).toBe(true);
		expect(report.turnsPassed).toBe(2);
		expect(report.failure).toBeUndefined();
	});

	it("ends a run after the bounded refusal retry budget", async () => {
		let attempts = 0;
		const summary = await runIfBenchCommand(
			{ models: ["acme/if-bench-model"], flags: { turns: 1, par: 1 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => "sess-x",
				sleep: async () => {},
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				now: () => 0,
				stdoutIsTTY: false,
				streamSimple: () => {
					attempts += 1;
					return errorStream("Refusal (cyber): blocked");
				},
			},
		);
		const report = summary.models[0]!;
		expect(attempts).toBe(8);
		expect(report.turnsPassed).toBe(0);
		expect(report.failure).toMatchObject({ turn: 1, kind: "provider" });
	});
});
