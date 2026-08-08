import { describe, expect, it } from "bun:test";
import { type Api, Effort, type Model } from "@san/ai";
import { buildModel } from "@san/catalog/build";
import { Settings } from "@san/coding-agent/config/settings";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import {
	appendSessionSubagentModelOverride,
	getSessionSubagentModelOverride,
	resolveSessionSubagentModelSelector,
} from "@san/coding-agent/session/subagent-model-override";
import { userMsg } from "./utilities";

function model(provider: string, id: string, efforts: readonly Effort[]): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: true,
		thinking: { mode: "effort", efforts: [...efforts] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

describe("session subagent model override", () => {
	it("uses the latest valid event on the current branch and treats null as an explicit clear", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("start"));
		const inheritedOverrideId = appendSessionSubagentModelOverride(session, "cpa/kl/deepseek-v4-flash:max");
		expect(getSessionSubagentModelOverride(session.getBranch())).toBe("cpa/kl/deepseek-v4-flash:max");

		const clearId = appendSessionSubagentModelOverride(session, null);
		expect(getSessionSubagentModelOverride(session.getBranch())).toBeUndefined();

		session.branch(inheritedOverrideId);
		expect(getSessionSubagentModelOverride(session.getBranch())).toBe("cpa/kl/deepseek-v4-flash:max");
		appendSessionSubagentModelOverride(session, "cpa/kl/deepseek-v4-flash:high");
		expect(getSessionSubagentModelOverride(session.getBranch())).toBe("cpa/kl/deepseek-v4-flash:high");

		session.branch(clearId);
		expect(getSessionSubagentModelOverride(session.getBranch())).toBeUndefined();
	});

	it("canonicalizes supported effort and rejects unsupported effort without appending state", () => {
		const settings = Settings.isolated();
		const target = model("cpa", "kl/deepseek-v4-flash", [Effort.Low, Effort.High, Effort.Max]);
		const limited = model("test", "limited-reasoner", [Effort.Low, Effort.High]);

		const resolved = resolveSessionSubagentModelSelector("cpa/kl/deepseek-v4-flash:max", [target, limited], settings);
		expect(resolved).toMatchObject({
			ok: true,
			selector: "cpa/kl/deepseek-v4-flash:max",
			thinkingLevel: Effort.Max,
		});

		const rejected = resolveSessionSubagentModelSelector("test/limited-reasoner:max", [target, limited], settings);
		expect(rejected).toEqual({
			ok: false,
			error: "Model test/limited-reasoner does not support effort max. Supported: low, high.",
		});

		const session = SessionManager.inMemory();
		if (rejected.ok) appendSessionSubagentModelOverride(session, rejected.selector);
		expect(session.getEntries()).toHaveLength(0);
	});
});
