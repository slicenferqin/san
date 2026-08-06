import { describe, expect, test } from "bun:test";
import { deriveTaskContractIdentity, TaskContractRegistry, taskContractIdentityKey } from "../../src/execution-control";

describe("TaskContractRegistry", () => {
	test("derives stable identity from semantic work and strategy, not display names", () => {
		const first = deriveTaskContractIdentity({
			rootSessionId: "root-1",
			task: "  inspect the task admission flow  ",
			agent: "scout",
		});
		const second = deriveTaskContractIdentity({
			rootSessionId: "root-1",
			task: "inspect the task admission flow",
			agent: "SCOUT",
		});
		const differentStrategy = deriveTaskContractIdentity({
			rootSessionId: "root-1",
			task: "inspect the task admission flow",
			agent: "builder",
		});

		expect(first).toEqual(second);
		expect(taskContractIdentityKey(first)).not.toBe(taskContractIdentityKey(differentStrategy));
		expect(first.scopeId).toBe("root-1");
	});

	test("admits once per scope/work/strategy and reuses duplicate state", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const first = registry.admit({ task: "same work", strategyKey: "research" });
		const duplicate = registry.admit({ task: "same work", strategyKey: "research" });
		const alternate = registry.admit({ task: "same work", strategyKey: "implementation" });

		expect(first.kind).toBe("admitted");
		expect(duplicate.kind).toBe("reused");
		expect(duplicate.accepted).toBe(false);
		expect(duplicate.contract.contractId).toBe(first.contract.contractId);
		expect(alternate.kind).toBe("admitted");
		expect(registry.list()).toHaveLength(2);
	});

	test("advances cursor/revision and wakes waiters on heartbeat changes", async () => {
		let now = 100;
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => now });
		const admission = registry.admit({ workKey: "work-a", strategyKey: "research" });
		const baseline = admission.contract;
		const changed = registry.waitForChange(baseline, {
			cursor: baseline.cursor,
			revision: baseline.revision,
			heartbeatAt: baseline.heartbeatAt,
		});

		now = 250;
		const heartbeat = registry.heartbeat(baseline, now);
		expect(heartbeat.cursor).toBeGreaterThan(baseline.cursor);
		expect(heartbeat.revision).toBeGreaterThan(baseline.revision);
		expect(heartbeat.heartbeatAt).toBe(now);
		expect(await changed).toEqual(heartbeat);
	});

	test("rejects rebinding one contract to a different job", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1" });
		const contract = registry.admit({ task: "one job only", strategyKey: "implementation" }).contract;
		registry.bindJob(contract, "job-1");

		expect(() => registry.bindJob(contract, "job-2")).toThrow("already bound to job job-1");
		expect(registry.getByJobId("job-1")?.jobId).toBe("job-1");
		expect(registry.getByJobId("job-2")).toBeUndefined();
	});

	test("keeps independent root registries isolated", () => {
		const rootA = new TaskContractRegistry({ rootSessionId: "root-a" });
		const rootB = new TaskContractRegistry({ rootSessionId: "root-b" });
		const a = rootA.admit({ task: "same work", strategyKey: "research" });
		const b = rootB.admit({ task: "same work", strategyKey: "research" });

		expect(a.kind).toBe("admitted");
		expect(b.kind).toBe("admitted");
		expect(a.contract.scopeId).not.toBe(b.contract.scopeId);
	});
});
