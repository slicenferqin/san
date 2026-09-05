import { describe, expect, test } from "bun:test";
import { TaskContractRegistry } from "../../src/execution-control";
import { TaskAdmissionService } from "../../src/task";

function request(overrides: Partial<Parameters<TaskAdmissionService["preflight"]>[0]> = {}) {
	return {
		ownerId: "owner-1",
		assignment: "Inspect the admission boundary",
		agent: "scout",
		...overrides,
	};
}

describe("TaskAdmissionService", () => {
	test("passes through requests when no contract registry is wired", () => {
		const service = new TaskAdmissionService({});
		const input = request();

		expect(service.preflight(input)).toEqual({ request: input });
	});

	test("uses explicit scope and contract identity fields before source defaults", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const service = new TaskAdmissionService({
			taskContractRegistry: registry,
			executionScopeId: "scope-source",
		});

		const plan = service.preflight(
			request({
				scopeId: "scope-request",
				rootSessionId: "root-request",
				contract: {
					contractId: "contract-explicit",
					workKey: "work-explicit",
					strategyKey: "strategy-explicit",
					taskId: "task-explicit",
				},
			}),
		);

		expect(plan.contract).toEqual({
			contractId: "contract-explicit",
			scopeId: "scope-request",
			workKey: "work-explicit",
			strategyKey: "strategy-explicit",
			taskId: "task-explicit",
		});
		expect(plan.admission?.kind).toBe("admitted");
		expect(plan.snapshot?.status).toBe("queued");
		expect(plan.snapshot?.scopeId).toBe("scope-request");
	});

	test("reuses the existing contract without creating a second admission", () => {
		const registry = new TaskContractRegistry({ rootSessionId: "root-1", now: () => 100 });
		const service = new TaskAdmissionService({ taskContractRegistry: registry });
		const input = request({ scopeId: "scope-1", contract: { strategyKey: "research" } });

		const first = service.preflight(input);
		const duplicate = service.preflight(input);

		expect(first.admission?.kind).toBe("admitted");
		expect(duplicate.admission?.kind).toBe("reused");
		expect(duplicate.admission?.accepted).toBe(false);
		expect(duplicate.contract).toEqual(first.contract);
		expect(registry.list()).toHaveLength(1);
	});
});
