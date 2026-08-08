import { describe, expect, test, vi } from "bun:test";
import { logger } from "@san/utils";
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

	test("reset replaces the branch state and restores supplied contracts", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const oldA = registry.admit({ workKey: "work-a", strategyKey: "research" }).contract;
		const oldB = registry.admit({ workKey: "work-b", strategyKey: "research" }).contract;
		registry.bindJob(oldA, "job-old");

		const events: string[] = [];
		registry.subscribe(change => events.push(change.type));

		const nextBranch = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 200 });
		const freshB = nextBranch.admit({ workKey: "work-b", strategyKey: "research" }).contract;
		const freshC = nextBranch.bindJob(
			nextBranch.admit({ workKey: "work-c", strategyKey: "implementation" }).contract,
			"job-new",
		);
		registry.reset([freshB, freshC]);

		expect(registry.get(oldA)).toBeUndefined();
		// work-b keeps its stable identity key, so the restored branch snapshot
		// replaces the old-branch entry under the same key.
		expect(registry.get(oldB)).toEqual(freshB);
		expect(registry.getByJobId("job-old")).toBeUndefined();
		expect(registry.list().map(contract => contract.contractId)).toEqual([freshB.contractId, freshC.contractId]);
		expect(registry.getByJobId("job-new")?.contractId).toBe(freshC.contractId);
		expect(events).toEqual(["reset"]);

		const duplicate = registry.admit({ workKey: "work-b", strategyKey: "research" });
		expect(duplicate.kind).toBe("reused");
		expect(duplicate.contract.contractId).toBe(freshB.contractId);
		expect(events).toEqual(["reset"]);
	});

	test("reset emits no notification when the branch state is unchanged", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const admitted = registry.admit({ workKey: "work-a", strategyKey: "research" });
		const events: string[] = [];
		registry.subscribe(change => events.push(change.type));

		registry.reset([admitted.contract]);

		expect(events).toEqual([]);
		expect(registry.list()).toHaveLength(1);
	});

	test("subscribers survive reset and later lifecycle events still arrive", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		registry.admit({ workKey: "work-a", strategyKey: "research" });
		const events: string[] = [];
		registry.subscribe(change => events.push(change.type));

		const nextBranch = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 200 });
		const fresh = nextBranch.admit({ workKey: "work-b", strategyKey: "implementation" }).contract;
		registry.reset([fresh]);
		expect(events).toEqual(["reset"]);

		const admitted = registry.admit({ workKey: "work-c", strategyKey: "research" });
		expect(events).toEqual(["reset", "admitted"]);
		expect(admitted.kind).toBe("admitted");
	});

	test("reset settles stale waiters deterministically", async () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const baseline = registry.admit({ workKey: "work-a", strategyKey: "research" }).contract;
		const controller = new AbortController();
		const pending = registry.waitForChange(baseline, {
			cursor: baseline.cursor,
			revision: baseline.revision,
			heartbeatAt: baseline.heartbeatAt,
		});
		const aborting = registry.waitForChange(baseline, { revision: baseline.revision }, controller.signal);

		const nextBranch = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 200 });
		registry.reset([nextBranch.admit({ workKey: "work-b", strategyKey: "research" }).contract]);

		const pendingError = await pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((pendingError as Error).message).toBe("Task contract registry was reset.");
		const abortingError = await aborting.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((abortingError as Error).message).toBe("Task contract registry was reset.");
		controller.abort();
		expect(registry.list()).toHaveLength(1);
	});

	test("a throwing subscriber does not block state, other listeners, or the log", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		try {
			const received: string[] = [];
			registry.subscribe(() => {
				throw new Error("listener boom");
			});
			registry.subscribe(change => received.push(change.type));

			const admitted = registry.admit({ workKey: "work-a", strategyKey: "research" });

			expect(admitted.kind).toBe("admitted");
			expect(received).toEqual(["admitted"]);
			const matching = errorSpy.mock.calls.find(call => {
				const ctx = call[1] as Record<string, unknown> | undefined;
				return (
					call[0] === "Task contract subscriber failed" &&
					ctx?.type === "admitted" &&
					ctx?.contractId === admitted.contract.contractId &&
					ctx?.scopeId === admitted.contract.scopeId &&
					ctx?.error === "listener boom"
				);
			});
			expect(matching).toBeDefined();
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("a no-op reset leaves pending waiters undisturbed", async () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const baseline = registry.admit({ workKey: "work-a", strategyKey: "research" }).contract;
		const pending = registry.waitForChange(baseline, { revision: baseline.revision });

		registry.reset([baseline]);

		let settled = false;
		pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);

		const heartbeat = registry.heartbeat(baseline);
		expect((await pending).revision).toBe(heartbeat.revision);
	});

	test("force equal reset rejects waiters and publishes exactly one reset", async () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const baseline = registry.admit({ workKey: "work-a", strategyKey: "research" }).contract;
		const events: string[] = [];
		registry.subscribe(change => events.push(change.type));
		const pending = registry.waitForChange(baseline, { revision: baseline.revision });

		registry.reset([baseline], { force: true });

		// 即使是相等分支，force 也拒绝旧 waiter 并恰好发布一次 reset。
		expect(events).toEqual(["reset"]);
		expect(registry.list()).toHaveLength(1);
		const error = await pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((error as Error).message).toBe("Task contract registry was reset.");
	});
});
