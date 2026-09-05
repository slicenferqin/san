import { prompt } from "@san/utils";
import type { Action } from "./actions";
import { encodeAction } from "./actions";
import catDirectiveTemplate from "./prompts/cat-directive.md" with { type: "text" };
import systemTemplate from "./prompts/system.md" with { type: "text" };
import turnTemplate from "./prompts/turn.md" with { type: "text" };

export const CAT_PLACEMENTS = ["beginning", "middle", "end"] as const;
export type CatPlacement = (typeof CAT_PLACEMENTS)[number];
export type IfBenchFailure = "result" | "cat" | "result+cat" | "format" | "provider";
export const DEFAULT_NYA_MAX = 8;

const RESULT_BLOCK = /<([^>]*)>/;

export function catSoundPattern(nyaMax: number): RegExp {
	return new RegExp(`nya{1,${nyaMax}}(?![a{])`);
}

export function buildSystemPrompt(nyaMax: number): string {
	return prompt.render(systemTemplate, { nyaMax }).trim();
}

export interface TurnPrompt {
	content: string;
	placement: CatPlacement;
}

export function buildTurnPrompt(options: {
	turn: number;
	start?: string;
	actions: readonly Action[];
	nyaMax: number;
}): TurnPrompt {
	const placement = CAT_PLACEMENTS[(options.turn - 1) % CAT_PLACEMENTS.length]!;
	const tokens = options.actions.map(encodeAction);
	const split = placement === "middle" ? Math.ceil(tokens.length / 2) : tokens.length;
	const tail = tokens.slice(split);
	const content = prompt
		.render(turnTemplate, {
			catDirective: prompt.render(catDirectiveTemplate, { nyaMax: options.nyaMax }).trim(),
			catBefore: placement === "beginning",
			catMiddle: placement === "middle",
			catAfter: placement === "end",
			start: options.start,
			actionsHead: tokens.slice(0, split).join(" "),
			actionsTail: tail.length > 0 ? tail.join(" ") : undefined,
		})
		.trim();
	return { content, placement };
}

export interface TurnAssessment {
	passed: boolean;
	failure?: IfBenchFailure;
	reported?: string;
}

export function assessResponse(response: string, expected: string, nyaMax: number): TurnAssessment {
	const cat = catSoundPattern(nyaMax);
	const catPresent = cat.test(response);
	const block = RESULT_BLOCK.exec(response);
	if (!block?.[1]) return { passed: false, failure: "format" };
	const reported = block[1].replace(cat, "").replace(/\s/g, "");
	if (reported === expected) {
		return catPresent ? { passed: true, reported } : { passed: false, failure: "cat", reported };
	}
	return { passed: false, failure: catPresent ? "result" : "result+cat", reported };
}
