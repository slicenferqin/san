#!/usr/bin/env bun

import { runSanLoopDogfood } from "../src/san-loop/dogfood";

const summary = await runSanLoopDogfood();
const lines: string[] = [];

for (const assertion of summary.assertions) {
	const marker = assertion.ok ? "ok" : "fail";
	lines.push(`${marker}: ${assertion.name} - ${assertion.detail}`);
}

lines.push("");
lines.push(
	`San loop dogfood: ${summary.ok ? "PASS" : "FAIL"} ` +
		`(${summary.runs} runs, ${summary.passedRuns} passed, ${summary.blockedRuns} blocked, ` +
		`${summary.abortedRuns} aborted, ${summary.recoveredRuns} recovered, ` +
		`${summary.reviewReports} reviews, ${summary.events} events)`,
);
lines.push("");
for (const scenario of summary.scenarios) {
	lines.push(
		`${scenario.name}: ${scenario.status}; mode=${scenario.mode}; retry=${scenario.retryCount}; ` +
			`events=${scenario.events.join(" -> ")}`,
	);
}
lines.push("");
lines.push(summary.reportText);

await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);

process.exit(summary.ok ? 0 : 1);
