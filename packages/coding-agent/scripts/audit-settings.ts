/**
 * Configuration-surface audit (M1 novice-first plan, §3.1).
 *
 * Walks the settings schema and the builtin slash-command registry and emits
 * a JSON inventory used as the working sheet for audience adjudication:
 *
 *   bun run scripts/audit-settings.ts            # JSON to stdout
 *   bun run scripts/audit-settings.ts --out f.json
 *
 * For every schema leaf key: full path, type, default value, audience,
 * UI placement (tab/group/label/description) and whether the settings UI
 * materializes a widget for it. For every builtin slash command: name,
 * aliases, description, audience and dispatcher coverage.
 */

import { parseArgs } from "node:util";
import { getUi, SETTINGS_SCHEMA, type SettingAudience, type SettingPath } from "../src/config/settings-schema";
import { getAllSettingDefs } from "../src/modes/components/settings-defs";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { CommandAudience } from "../src/slash-commands/types";

interface SettingAuditEntry {
	path: string;
	type: string;
	default: unknown;
	audience: SettingAudience | null;
	effectiveAudience: SettingAudience;
	tab: string | null;
	group: string | null;
	label: string | null;
	description: string | null;
	hasUi: boolean;
	/** Whether settings-defs.ts materializes a widget (numbers without options do not). */
	inSettingsUi: boolean;
}

interface CommandAuditEntry {
	name: string;
	aliases: string[];
	description: string;
	audience: CommandAudience | null;
	effectiveAudience: CommandAudience;
	subcommands: string[];
	/** True when the command only has a TUI handler (invisible to ACP clients). */
	tuiOnly: boolean;
}

interface AuditReport {
	generatedAt: string;
	settings: {
		total: number;
		withUi: number;
		inSettingsUi: number;
		daily: number;
		expert: number;
		keys: SettingAuditEntry[];
	};
	commands: {
		total: number;
		daily: number;
		expert: number;
		items: CommandAuditEntry[];
	};
}

function collectSettings(): SettingAuditEntry[] {
	const uiDefPaths = new Set<string>(getAllSettingDefs().map(def => def.path));
	const entries: SettingAuditEntry[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const def = SETTINGS_SCHEMA[path];
		const ui = getUi(path);
		entries.push({
			path,
			type: def.type,
			default: def.default,
			audience: ui?.audience ?? null,
			effectiveAudience: ui?.audience ?? "daily",
			tab: ui?.tab ?? null,
			group: ui?.group ?? null,
			label: ui?.label ?? null,
			description: ui?.description ?? null,
			hasUi: ui !== undefined,
			inSettingsUi: uiDefPaths.has(path),
		});
	}
	return entries;
}

function collectCommands(): CommandAuditEntry[] {
	return BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => ({
		name: command.name,
		aliases: command.aliases ?? [],
		description: command.description,
		audience: command.audience ?? null,
		effectiveAudience: command.audience ?? "daily",
		subcommands: (command.subcommands ?? []).map(sub => sub.name),
		tuiOnly: command.handle === undefined,
	}));
}

function buildReport(): AuditReport {
	const keys = collectSettings();
	const items = collectCommands();
	const uiKeys = keys.filter(key => key.inSettingsUi);
	return {
		generatedAt: new Date().toISOString(),
		settings: {
			total: keys.length,
			withUi: keys.filter(key => key.hasUi).length,
			inSettingsUi: uiKeys.length,
			daily: uiKeys.filter(key => key.effectiveAudience === "daily").length,
			expert: uiKeys.filter(key => key.effectiveAudience === "expert").length,
			keys,
		},
		commands: {
			total: items.length,
			daily: items.filter(item => item.effectiveAudience === "daily").length,
			expert: items.filter(item => item.effectiveAudience === "expert").length,
			items,
		},
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			out: { type: "string" },
		},
	});

	const report = buildReport();
	const json = JSON.stringify(report, null, 2);
	if (values.out) {
		await Bun.write(values.out, `${json}\n`);
		process.stderr.write(
			`Audit written to ${values.out}: ${report.settings.total} setting keys ` +
				`(${report.settings.daily} daily / ${report.settings.expert} expert in UI), ` +
				`${report.commands.total} commands (${report.commands.daily} daily / ${report.commands.expert} expert).\n`,
		);
		return;
	}
	process.stdout.write(`${json}\n`);
}

await main();
