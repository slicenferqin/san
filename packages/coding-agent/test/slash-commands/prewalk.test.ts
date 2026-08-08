import { describe, expect, test, vi } from "bun:test";
import { buildModel } from "@san/catalog/build";
import { compileModelRouteRegistry } from "@san/coding-agent/config/model-route-registry";
import { Settings } from "@san/coding-agent/config/settings";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@san/coding-agent/slash-commands/builtin-registry";

describe("/prewalk slash command", () => {
	test("arms the concrete route selected by a logical smol role", async () => {
		const concrete = buildModel({
			id: "fast-model",
			name: "Fast Model",
			api: "openai-responses",
			provider: "runtime",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4096,
		});
		const routeRegistry = compileModelRouteRegistry(
			{
				"logical-smol": {
					routes: [{ id: "primary", model: "runtime/fast-model", equivalence: "exact" }],
				},
			},
			[concrete],
		);
		const settings = Settings.isolated({
			"routing.enabled": true,
			modelRoles: { smol: "logical-smol" },
		});
		const modelRegistry = {
			getAll: () => [concrete],
			getModelRouteRegistry: () => routeRegistry,
			hasConfiguredAuth: () => true,
			isProviderEnabled: () => true,
			isSelectorSuppressed: () => false,
		};
		const armPrewalk = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: { modelRegistry, armPrewalk },
			sessionManager: { getCwd: () => "/repo" },
			settings,
			editor: { setText },
			showStatus,
		} as unknown as InteractiveModeContext;

		const handled = await executeBuiltinSlashCommand("/prewalk", { ctx });

		expect(handled).toBe(true);
		expect(armPrewalk).toHaveBeenCalledWith(concrete, undefined);
		expect(showStatus).toHaveBeenCalledWith(
			"Prewalk on: switching to runtime/fast-model at the next edit/write (todo-gated).",
		);
		expect(setText).toHaveBeenCalledWith("");
	});
});
