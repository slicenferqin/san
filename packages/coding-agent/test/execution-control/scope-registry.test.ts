import { describe, expect, test } from "bun:test";
import { ExecutionScopeRegistry, type ImmutableObjectiveContract } from "../../src/execution-control";

const NOW = "2026-08-05T00:00:00.000Z";

function contract(revision = 1, turnId = "turn-1"): ImmutableObjectiveContract {
	return {
		ref: {
			contractId: "contract-root",
			revision,
			contractHash: `sha256-contract-${revision}`,
			clauseRefs: ["clause:deliver"],
		},
		authoritativeUserTurnId: turnId,
		source: "authoritative_user",
	};
}

describe("ExecutionScopeRegistry", () => {
	test("re-entering an old authoritative turn re-points the current root scope", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		const a = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const b = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			objectiveContract: contract(1, "turn-2"),
		});
		expect(registry.current("session-1")?.scopeId).toBe(b.scopeId);

		// A→B→重入 A：current 必须指回 A，而不是停留在最新轮次 B。
		const reentered = registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		expect(reentered).toBe(a);
		expect(registry.current("session-1")?.scopeId).toBe(a.scopeId);
		// 无 logicalTurnId 的续接（steering/handoff 等）同样跟随 current。
		expect(registry.resolve({ rootSessionId: "session-1", kind: "steering" })?.scopeId).toBe(a.scopeId);
		expect(registry.resolve({ rootSessionId: "session-1", kind: "handoff" })?.scopeId).toBe(a.scopeId);
	});

	test("resolve authoritative_user also re-points current when re-entering an old turn", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		const first = registry.resolve({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			kind: "authoritative_user",
			objectiveContract: contract(),
		});
		registry.resolve({
			rootSessionId: "session-1",
			logicalTurnId: "turn-2",
			kind: "authoritative_user",
			objectiveContract: contract(1, "turn-2"),
		});
		expect(registry.current("session-1")?.scopeId).not.toBe(first?.scopeId);

		const repeated = registry.resolve({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			kind: "authoritative_user",
			objectiveContract: contract(),
		});
		expect(repeated).toBe(first);
		expect(registry.current("session-1")?.scopeId).toBe(first?.scopeId);
	});

	test("reset restores references with the last reference per root as current", () => {
		const registry = new ExecutionScopeRegistry({ now: () => NOW });
		registry.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-1",
			objectiveContract: contract(),
		});
		const branch = new ExecutionScopeRegistry({ now: () => NOW });
		const older = branch.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-10",
			objectiveContract: contract(1, "turn-10"),
		});
		const newer = branch.startAuthoritativeTurn({
			rootSessionId: "session-1",
			logicalTurnId: "turn-11",
			objectiveContract: contract(1, "turn-11"),
		});
		registry.reset([older, newer]);

		expect(registry.list("session-1").map(reference => reference.scopeId)).toEqual([older.scopeId, newer.scopeId]);
		expect(registry.current("session-1")?.scopeId).toBe(newer.scopeId);
		registry.reset();
		expect(registry.list()).toHaveLength(0);
		expect(registry.current("session-1")).toBeUndefined();
	});
});
