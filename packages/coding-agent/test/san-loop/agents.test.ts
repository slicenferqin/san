import { describe, expect, test } from "bun:test";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";

describe("San loop bundled agents", () => {
	test("registers role agents with expected tool and spawn boundaries", () => {
		clearBundledAgentsCache();
		const agents = loadBundledAgents();
		const byName = new Map(agents.map(agent => [agent.name, agent]));

		expect(byName.get("san-commander")?.spawns).toEqual(["san-worker", "san-supervisor", "san-oracle"]);
		expect(byName.get("san-commander")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-commander")?.tools).toEqual(expect.arrayContaining(["task", "todo", "yield"]));
		expect(byName.get("san-worker")?.spawns).toBeUndefined();
		expect(byName.get("san-worker")?.model).toEqual(["pi/task"]);
		expect(byName.get("san-worker")?.tools).toEqual(expect.arrayContaining(["write", "edit", "bash", "yield"]));
		expect(byName.get("san-supervisor")?.spawns).toEqual(["san-oracle"]);
		expect(byName.get("san-supervisor")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-supervisor")?.tools).toEqual(expect.arrayContaining(["bash", "yield"]));
		expect(byName.get("san-supervisor")?.tools ?? []).not.toContain("write");
		expect(byName.get("san-oracle")?.spawns).toBeUndefined();
		expect(byName.get("san-oracle")?.model).toEqual(["pi/slow"]);
		expect(byName.get("san-oracle")?.tools ?? []).not.toContain("bash");
	});
});
