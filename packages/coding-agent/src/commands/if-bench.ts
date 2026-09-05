import { Args, Command, Flags } from "@san/utils/cli";
import { runIfBenchCommand } from "../if-bench";

export default class IfBench extends Command {
	static description = "Benchmark instruction following and working memory with a persistent glyph-action thread";

	static args = {
		models: Args.string({
			description: "One or more model selectors",
			multiple: true,
			required: true,
		}),
	};

	static flags = {
		turns: Flags.integer({ description: "Maximum turns per model" }),
		length: Flags.integer({ description: "Even character-array length" }),
		"max-tokens": Flags.integer({ description: "Maximum output tokens per turn" }),
		"nya-max": Flags.integer({ description: "Maximum number of cat-sound a's" }),
		par: Flags.integer({ description: "Maximum models running concurrently" }),
		json: Flags.boolean({ char: "j", description: "Output the summary as JSON", default: false }),
	};

	static examples = ["san if-bench opus gpt-5.2", "san if-bench --turns 12 --length 16 --json claude-sonnet"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(IfBench);
		await runIfBenchCommand({
			models: args.models ?? [],
			flags: {
				turns: flags.turns,
				length: flags.length,
				maxTokens: flags["max-tokens"],
				nyaMax: flags["nya-max"],
				par: flags.par,
				json: flags.json,
			},
		});
	}
}
