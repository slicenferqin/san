/**
 * View usage statistics dashboard.
 */
import { Command, Flags } from "@san/utils/cli";
import { DEFAULT_STATS_HOST, runStatsCommand, type StatsCommandArgs } from "../cli/stats-cli";
import { initTheme } from "../modes/theme/theme";

export default class Stats extends Command {
	static description = "View usage statistics";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the dashboard server", default: 3847 }),
		host: Flags.string({ char: "H", description: "Host to bind the dashboard server", default: DEFAULT_STATS_HOST }),
		token: Flags.string({
			char: "t",
			description: "Auth token required by non-loopback hosts (or SAN_STATS_TOKEN)",
		}),
		json: Flags.boolean({ char: "j", description: "Output stats as JSON", default: false }),
		summary: Flags.boolean({ char: "s", description: "Print summary to console", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Stats);

		const cmd: StatsCommandArgs = {
			port: flags.port,
			host: flags.host ?? DEFAULT_STATS_HOST,
			token: flags.token,
			json: flags.json,
			summary: flags.summary,
		};

		await initTheme();
		await runStatsCommand(cmd);
	}
}
