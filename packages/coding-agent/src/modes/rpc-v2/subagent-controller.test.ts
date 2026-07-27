import { describe, expect, it } from "bun:test";
import type { RpcSubagentSnapshot } from "../rpc/rpc-types";
import { projectSubagentSnapshot } from "./subagent-controller";

function makeSnapshot(overrides: Partial<RpcSubagentSnapshot> = {}): RpcSubagentSnapshot {
	return {
		id: "sub_1",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		lastUpdate: Date.parse("2026-07-26T14:00:00.000Z"),
		...overrides,
	};
}

describe("projectSubagentSnapshot", () => {
	it("redacts secrets and local home paths from descriptive fields", () => {
		const home = process.env.HOME ?? "/Users/tester";
		const secret = "sk-abcdefghijklmnopqrstuvwx";
		const projected = projectSubagentSnapshot(
			makeSnapshot({
				description: `working in ${home}/private authorization=${secret}`,
				task: `inspect ${home}/private token=${secret}`,
				assignment: `repair ${home}/private password=${secret}`,
			}),
		);
		const serialized = JSON.stringify(projected);
		expect(projected.description).toBe("working in ~/private authorization=[REDACTED]");
		expect(projected.task).toBe("inspect ~/private token=[REDACTED]");
		expect(projected.assignment).toBe("repair ~/private password=[REDACTED]");
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(home);
	});
});
