/**
 * Goal recitation cadence (goal-fidelity plan B).
 *
 * Contract: within one turn, every Nth completed tool call folds a one-shot
 * objective recitation (host-pinned goal text from the immutable contract)
 * into the tool result — pushing the goal back into the recency window on
 * long loops. Sessions without an active scope contract never recite.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AfterToolCallContext, Agent, type AgentToolCall } from "@san/agent";
import type { AssistantMessage } from "@san/ai";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { createExecutionRuntime, type ExecutionRuntime } from "@san/coding-agent/execution-control/execution-runtime";
import { ProviderHealthRegistry } from "@san/coding-agent/execution-control/provider-health";
import { TaskContractRegistry } from "@san/coding-agent/execution-control/task-contract";
import type { ImmutableObjectiveContract } from "@san/coding-agent/execution-control/types";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

const RECITATION_MARKER = "[Objective recitation";

function toolContext(index: number): AfterToolCallContext {
	return {
		assistantMessage: { role: "assistant", content: [], timestamp: Date.now() } as unknown as AssistantMessage,
		toolCall: {
			type: "toolCall",
			id: `call-${index}-${Snowflake.next()}`,
			name: "bash",
			arguments: { command: `echo step-${index}` },
		} as AgentToolCall,
		args: { command: `echo step-${index}` },
		result: { content: [{ type: "text", text: `step-${index}` }] },
		isError: false,
		context: {} as AfterToolCallContext["context"],
	};
}

function foldedText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	if (!content) return "";
	return content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("AgentSession goal recitation", () => {
	let session: AgentSession;
	let runtime: ExecutionRuntime;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	async function createSession(options: { withScope?: boolean } = {}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const rootSessionId = sessionManager.getSessionId() || "goal-recitation-session";
		runtime = createExecutionRuntime({
			rootSessionId,
			branchEntries: sessionManager.getBranch(),
			sessionManager,
			taskRegistry: new TaskContractRegistry({ rootSessionId }),
			providerRegistry: new ProviderHealthRegistry({ now: () => 0 }),
			now: () => new Date().toISOString(),
		});
		if (options.withScope !== false) {
			// The contract's authoritative turn must be a real journal user entry —
			// that is where the anchor's objective text comes from.
			const entryId = sessionManager.appendMessage({
				role: "user",
				content: "migrate the parser to the new tokenizer without breaking tests",
				timestamp: Date.now(),
			});
			const contract: ImmutableObjectiveContract = {
				ref: {
					contractId: "contract:goal-recitation",
					revision: 1,
					contractHash: "sha256:goal-recitation",
					clauseRefs: ["clause:goal-recitation"],
				},
				authoritativeUserTurnId: entryId,
				source: "authoritative_user",
			};
			runtime.startScope({ rootSessionId, logicalTurnId: entryId, objectiveContract: contract });
		}
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			executionRuntime: runtime,
		});
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-goal-recitation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("recites the host-pinned objective every 20th tool call within a turn", async () => {
		await createSession();
		const recitations: number[] = [];
		for (let call = 1; call <= 45; call++) {
			const folded = session.agent.afterToolCall?.(toolContext(call));
			if (foldedText(folded).includes(RECITATION_MARKER)) recitations.push(call);
		}
		expect(recitations).toEqual([20, 40]);
	});

	it("carries the objective text and never recites without an active scope contract", async () => {
		await createSession();
		let recitationText = "";
		for (let call = 1; call <= 20; call++) {
			const folded = session.agent.afterToolCall?.(toolContext(call));
			const text = foldedText(folded);
			if (text.includes(RECITATION_MARKER)) recitationText = text;
		}
		expect(recitationText).toContain("migrate the parser to the new tokenizer");

		await session.dispose();
		authStorage?.close();
		await createSession({ withScope: false });
		for (let call = 1; call <= 45; call++) {
			const folded = session.agent.afterToolCall?.(toolContext(call));
			expect(foldedText(folded)).not.toContain(RECITATION_MARKER);
		}
	});
});
