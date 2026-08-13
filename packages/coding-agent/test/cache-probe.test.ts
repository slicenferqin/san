/**
 * Prompt-cache hit attribution probe (magic-context study §4.2, step one).
 *
 * Contract: every settled assistant turn with real usage produces one
 * deterministic attribution sample on the journal; attribution follows the
 * documented priority (first_request → cache_hit → model_changed →
 * system_prompt_changed → idle_gap → prefix_diverged). Pure observation:
 * disabled setting or zero-usage turns produce nothing.
 */

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@san/agent";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import {
	CACHE_PROBE_CUSTOM_TYPE,
	type CacheProbeRequestFacts,
	type CacheProbeSample,
	classifyCacheProbe,
} from "@san/coding-agent/session/cache-probe";
import { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@san/utils";

function facts(overrides: Partial<CacheProbeRequestFacts> = {}): CacheProbeRequestFacts {
	return {
		provider: "anthropic",
		model: "claude",
		systemPromptHash: "sp-1",
		timestampMs: 1_000_000,
		input: 10_000,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

describe("classifyCacheProbe", () => {
	test("first request and sequence numbering", () => {
		const first = classifyCacheProbe(undefined, facts());
		expect(first.attribution).toBe("first_request");
		expect(first.requestSequence).toBe(1);
		const second = classifyCacheProbe(first, facts({ cacheRead: 9_500, timestampMs: 1_010_000 }));
		expect(second.requestSequence).toBe(2);
	});

	test("high hit ratio wins over every other attribution", () => {
		const previous = classifyCacheProbe(undefined, facts());
		const hit = classifyCacheProbe(
			previous,
			facts({ cacheRead: 9_000, model: "other-model", systemPromptHash: "sp-2", timestampMs: 99_000_000 }),
		);
		expect(hit.attribution).toBe("cache_hit");
		expect(hit.hitRatio).toBeCloseTo(0.9, 3);
	});

	test("attribution priority: model, then system prompt, then idle, then prefix", () => {
		const previous = classifyCacheProbe(undefined, facts());
		expect(classifyCacheProbe(previous, facts({ model: "other", timestampMs: 1_010_000 })).attribution).toBe(
			"model_changed",
		);
		expect(
			classifyCacheProbe(previous, facts({ systemPromptHash: "sp-2", timestampMs: 1_010_000 })).attribution,
		).toBe("system_prompt_changed");
		expect(classifyCacheProbe(previous, facts({ timestampMs: 1_000_000 + 6 * 60_000 })).attribution).toBe(
			"idle_gap",
		);
		expect(classifyCacheProbe(previous, facts({ timestampMs: 1_010_000 })).attribution).toBe("prefix_diverged");
	});

	test("deterministic: same inputs always classify identically", () => {
		const previous = classifyCacheProbe(undefined, facts());
		const input = facts({ timestampMs: 1_010_000, cacheRead: 100 });
		expect(classifyCacheProbe(previous, input)).toEqual(classifyCacheProbe(previous, input));
	});
});

describe("AgentSession cache probe recording", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	async function createSession(options: { settings?: Settings; usageInput?: number } = {}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const usageInput = options.usageInput ?? 8_000;
		mock = createMockModel({
			handler: () => ({
				content: ["Done"],
				usage: usageInput > 0 ? { input: usageInput, cacheRead: 0, cacheWrite: usageInput } : undefined,
			}),
		});
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: options.settings ?? Settings.isolated(),
			modelRegistry,
		});
	}

	function probeEntries(): CacheProbeSample[] {
		return sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === CACHE_PROBE_CUSTOM_TYPE)
			.map(entry => (entry as { data?: unknown }).data as CacheProbeSample);
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `san-cache-probe-test-${Snowflake.next()}`);
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

	it("records one attributed sample per settled assistant turn", async () => {
		await createSession();
		await session.prompt("first request");
		await session.prompt("second request");
		const samples = probeEntries();
		expect(samples).toHaveLength(2);
		expect(samples[0].attribution).toBe("first_request");
		expect(samples[0].requestSequence).toBe(1);
		expect(samples[1].requestSequence).toBe(2);
		// Same model, same system prompt, no idle gap, zero cache read → the
		// probe must blame prefix divergence (the §4.2 optimization target).
		expect(samples[1].attribution).toBe("prefix_diverged");
		expect(samples[0].systemPromptHash).toBe(samples[1].systemPromptHash);
	});

	it("stays silent when disabled or when the turn has no usage", async () => {
		await createSession({ settings: Settings.isolated({ "san.cacheProbe.enabled": false }) });
		await session.prompt("no probe");
		expect(probeEntries()).toHaveLength(0);

		await session.dispose();
		authStorage?.close();
		await createSession({ usageInput: 0 });
		await session.prompt("zero usage");
		expect(probeEntries()).toHaveLength(0);
	});
});
