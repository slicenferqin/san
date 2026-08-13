import { describe, expect, it } from "bun:test";
import { Settings } from "@san/coding-agent/config/settings";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import type { SessionManager } from "@san/coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@san/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMANDS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	lookupBuiltinSlashCommand,
} from "@san/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@san/coding-agent/slash-commands/types";
import { CombinedAutocompleteProvider } from "@san/tui/autocomplete";

/**
 * Contracts for the M1 command audience split (plan §3): browse-style
 * autocomplete only advertises daily commands, expert commands surface on a
 * typed name prefix, and dispatch by full name never consults the audience
 * marker (muscle memory and scripts keep working).
 */
describe("slash command audience layering", () => {
	it("keeps the daily command list small and the anchors present", () => {
		const daily = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(command => command.audience !== "expert");
		expect(daily.length).toBeLessThanOrEqual(30);
		const dailyNames = new Set(daily.map(command => command.name));
		for (const anchor of ["model", "settings", "resume", "quit", "connect", "compact"]) {
			expect(dailyNames.has(anchor)).toBe(true);
		}
	});

	it("materializes expert commands as unlisted for TUI autocomplete", () => {
		const byName = new Map(BUILTIN_SLASH_COMMANDS.map(command => [command.name, command]));
		expect(byName.get("dump")?.unlisted).toBe(true);
		expect(byName.get("san-loop")?.unlisted).toBe(true);
		expect(byName.get("model")?.unlisted).toBeUndefined();
		expect(byName.get("settings")?.unlisted).toBeUndefined();
	});

	it("hides expert commands from the browse list but surfaces them on a typed name prefix", async () => {
		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());

		const browse = await provider.getSuggestions(["/"], 0, 1);
		expect(browse).not.toBeNull();
		const browseValues = new Set(browse?.items.map(item => item.value));
		expect(browseValues.has("model")).toBe(true);
		expect(browseValues.has("settings")).toBe(true);
		expect(browseValues.has("dump")).toBe(false);
		expect(browseValues.has("san-loop")).toBe(false);

		const typed = await provider.getSuggestions(["/dum"], 0, 4);
		expect(typed?.items.some(item => item.value === "dump")).toBe(true);

		// Enter-submit sync completion follows the same rule, so `/dum` +
		// Enter still resolves to /dump.
		const sync = provider.trySyncSlashCompletion("/dum");
		expect(sync?.items[0]?.value).toBe("dump");
	});

	it("dispatches expert commands by full name regardless of audience", async () => {
		expect(lookupBuiltinSlashCommand("jobs")?.audience).toBe("expert");

		const output: string[] = [];
		const session = {
			getAsyncJobSnapshot: () => null,
		} as unknown as AgentSession;
		const runtime: SlashCommandRuntime = {
			session,
			sessionManager: {} as SessionManager,
			settings: Settings.isolated(),
			cwd: "/tmp",
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});
});
