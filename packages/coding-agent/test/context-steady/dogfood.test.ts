import { describe, expect, test } from "bun:test";
import { runContextSteadyDogfood } from "../../src/context-steady/dogfood";

describe("Context steady dogfood verifier", () => {
	test("passes the deterministic M7 dogfood acceptance checks", () => {
		const summary = runContextSteadyDogfood();

		expect(summary.ok).toBe(true);
		expect(summary.turns).toBe(10);
		expect(summary.digests).toBe(10);
		expect(summary.checkpoints).toBeGreaterThanOrEqual(1);
		expect(summary.packets).toBe(1);
		expect(summary.injectedMessages).toBe(1);
		expect(summary.finalPacketLayers).toEqual(["stable_checkpoint", "turn_digest_ledger", "retrieved_context"]);
		expect(summary.finalPacketDigestRefs.length).toBeGreaterThan(0);
		expect(summary.finalPacketCheckpointRef).toBeDefined();
		expect(summary.finalPacketRecallRefs).toEqual(["mem-html-docs", "mem-cache-order"]);
		expect(summary.finalPacketTokenEstimate).toBeLessThanOrEqual(summary.finalPacketTokenBudget);
		expect(summary.reportText).toContain("San ContextPacket debug view (1/1 shown)");
		expect(summary.reportText).toContain("Injected message: packet-final-injected");
		expect(summary.reportText).toContain("Checkpoint ref:");
		expect(summary.reportText).toContain("Recall refs: mem-html-docs, mem-cache-order");
		expect(summary.reportText).toContain("Budget:");
	});

	test("surfaces failed acceptance checks without throwing", () => {
		const summary = runContextSteadyDogfood({ turns: 2, checkpointEveryTurns: 10 });

		expect(summary.ok).toBe(false);
		expect(summary.assertions).toContainEqual({
			name: "checkpoint exists",
			ok: false,
			detail: "0 checkpoints",
		});
		expect(
			summary.assertions.some(
				assertion => assertion.name === "stable prefix before dynamic layers" && !assertion.ok,
			),
		).toBe(true);
	});
});
