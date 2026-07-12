#!/usr/bin/env bun

import { runContextSteadyDogfood } from "@oh-my-pi/pi-coding-agent/context-steady/dogfood";

const summary = runContextSteadyDogfood();
const lines: string[] = [];

for (const assertion of summary.assertions) {
	const marker = assertion.ok ? "ok" : "fail";
	lines.push(`${marker}: ${assertion.name} - ${assertion.detail}`);
}

lines.push("");
lines.push(
	`Context steady dogfood: ${summary.ok ? "PASS" : "FAIL"} ` +
		`(${summary.turns} turns, ${summary.digests} digests, ${summary.checkpoints} checkpoints, ` +
		`${summary.plans} plan, ${summary.injectedMessages} injected message)`,
);
lines.push(
	`Final plan ${summary.finalPlanId}: ${summary.finalPlanTokenEstimate}/${summary.finalPlanTokenBudget} tokens; ` +
		`representations=${summary.finalPlanRepresentations.join(" -> ")}`,
);
lines.push("");
lines.push(summary.reportText);

await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);

process.exit(summary.ok ? 0 : 1);
