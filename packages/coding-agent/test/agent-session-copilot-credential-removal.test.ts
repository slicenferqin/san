import { expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@san/agent";
import type { AssistantMessage } from "@san/ai";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

it("removes a Copilot credential for 401 but retains account and concurrency caps", async () => {
	const tempDir = TempDir.createSync("@san-copilot-credential-removal-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model to exist");

	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
	const removeSpy = vi.spyOn(authStorage, "remove").mockResolvedValue(undefined);

	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const emitFailure = async (message: AssistantMessage): Promise<void> => {
		agent.emitExternalEvent({ type: "message_end", message });
		agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await session.waitForIdle();
	};

	try {
		const unauthorized: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5-mini",
			stopReason: "error",
			errorMessage: "GitHub Copilot authentication failed (HTTP 401).",
			errorStatus: 401,
			usage,
			timestamp: Date.now(),
		};
		await emitFailure(unauthorized);
		expect(removeSpy).toHaveBeenCalledWith("github-copilot");

		removeSpy.mockClear();
		await emitFailure({
			...unauthorized,
			errorMessage: "Reached overall message rate limit. Your limit will reset in 13 minutes.",
			errorStatus: 403,
			timestamp: unauthorized.timestamp + 1,
		});
		expect(removeSpy).not.toHaveBeenCalled();

		await emitFailure({
			...unauthorized,
			errorMessage: "Online prediction concurrent requests quota exceeded",
			errorStatus: 403,
			timestamp: unauthorized.timestamp + 2,
		});
		expect(removeSpy).not.toHaveBeenCalled();
	} finally {
		await session.dispose();
		removeSpy.mockRestore();
		authStorage.close();
		tempDir.removeSync();
	}
});
