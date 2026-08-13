import { describe, expect, it } from "bun:test";
import {
	commandEvidenceFingerprint,
	deriveSkillSessionContractRef,
	SessionSkillGateState,
} from "../src/execution-control/skill-gate-session";
import type { SkillEvidenceSpec } from "../src/execution-control/types";

const FIX_BUG_EVIDENCE: SkillEvidenceSpec[] = [
	{
		id: "repro",
		phase: "before-fix",
		kind: "command",
		expect: "fail",
		description: "minimal failing command",
	},
	{
		id: "verify",
		phase: "before-done",
		kind: "command",
		expect: "pass",
		sameAs: "repro",
		description: "same command flips to passing",
	},
	{
		id: "regression",
		phase: "before-done",
		kind: "command",
		expect: "pass",
		description: "surrounding checks stay green",
	},
];

function stateWithFixBug(): SessionSkillGateState {
	const state = new SessionSkillGateState("session-1");
	state.activate({ name: "fix-bug", evidence: FIX_BUG_EVIDENCE });
	return state;
}

function gateByspec(state: SessionSkillGateState, specId: string) {
	const tracked = state.chain("fix-bug")?.gates.find(candidate => candidate.spec.id === specId);
	if (!tracked) throw new Error(`tracked gate ${specId} missing`);
	return tracked;
}

describe("SessionSkillGateState activation", () => {
	it("compiles an evidence chain into tracked gates bound to a session-derived contract", () => {
		const state = new SessionSkillGateState("session-1");
		const chain = state.activate({ name: "fix-bug", evidence: FIX_BUG_EVIDENCE });
		expect(chain).toBeDefined();
		expect(state.hasActiveChains).toBe(true);
		expect(chain?.gates.map(tracked => tracked.gate.gateId)).toEqual([
			"gate:skill:fix-bug:repro",
			"gate:skill:fix-bug:verify",
			"gate:skill:fix-bug:regression",
		]);
		expect(chain?.contractRef).toEqual(deriveSkillSessionContractRef("fix-bug", "session-1"));
		// 派生契约对(skill, session)稳定,对不同会话不同。
		expect(deriveSkillSessionContractRef("fix-bug", "session-1").contractHash).toBe(
			deriveSkillSessionContractRef("fix-bug", "session-1").contractHash,
		);
		expect(deriveSkillSessionContractRef("fix-bug", "session-1").contractHash).not.toBe(
			deriveSkillSessionContractRef("fix-bug", "session-2").contractHash,
		);
	});

	it("does not create chains for skills without evidence", () => {
		const state = new SessionSkillGateState("session-1");
		expect(state.activate({ name: "plain" })).toBeUndefined();
		expect(state.activate({ name: "empty", evidence: [] })).toBeUndefined();
		expect(state.hasActiveChains).toBe(false);
	});

	it("keeps existing receipts and reminder state on repeated activation of the same skill", () => {
		const state = stateWithFixBug();
		state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 });
		expect(state.activate({ name: "fix-bug", evidence: FIX_BUG_EVIDENCE })).toBeUndefined();
		expect(gateByspec(state, "repro").satisfied).toBe(true);
	});
});

describe("SessionSkillGateState command receipts", () => {
	it("produces a host receipt for a failing command matching an expect=fail gate, carrying the real exit code and command fingerprint", () => {
		const state = stateWithFixBug();
		const receipts = state.recordCommandObservation({
			command: "bun test repro.test.ts",
			exitCode: 2,
			timestamp: "2026-08-12T00:00:00.000Z",
		});
		expect(receipts).toHaveLength(1);
		const receipt = receipts[0];
		expect(receipt.source).toBe("host");
		expect(receipt.kind).toBe("command");
		expect(receipt.gateId).toBe("gate:skill:fix-bug:repro");
		expect(receipt.exitCode).toBe(2);
		expect(receipt.outcome).toBe("pass");
		expect(receipt.checkId).toBe(commandEvidenceFingerprint("bun test repro.test.ts"));
		const contractRef = deriveSkillSessionContractRef("fix-bug", "session-1");
		expect(receipt.contractHash).toBe(contractRef.contractHash);
		expect(receipt.contractRevision).toBe(contractRef.revision);
		expect(receipt.scopeId).toBe("session:session-1");
		expect(gateByspec(state, "repro").satisfied).toBe(true);
	});

	it("does not satisfy an expect=fail gate with a passing command, nor expect=pass gates awaiting sameAs resolution", () => {
		const state = stateWithFixBug();
		// exit 0:repro(fail 预期)不满足;verify 的 sameAs 引用还未解析,也不
		// 满足;regression(pass、无 sameAs)会被满足。
		const receipts = state.recordCommandObservation({ command: "bun test other.test.ts", exitCode: 0 });
		expect(receipts.map(receipt => receipt.gateId)).toEqual(["gate:skill:fix-bug:regression"]);
		expect(gateByspec(state, "repro").satisfied).toBe(false);
		expect(gateByspec(state, "verify").satisfied).toBe(false);
	});

	it("rejects a different passing command for a sameAs gate and accepts the exact reproduction command", () => {
		const state = stateWithFixBug();
		state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 });

		// 换一条命令“绿了”:verify 不满足(指纹不一致)。
		const substituted = state.recordCommandObservation({ command: "echo ok", exitCode: 0 });
		expect(substituted.some(receipt => receipt.gateId === "gate:skill:fix-bug:verify")).toBe(false);
		expect(gateByspec(state, "verify").satisfied).toBe(false);

		// 同一条复现命令由失败转为通过:verify 满足。
		const same = state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 0 });
		const verifyReceipt = same.find(receipt => receipt.gateId === "gate:skill:fix-bug:verify");
		expect(verifyReceipt).toBeDefined();
		expect(verifyReceipt?.checkId).toBe(commandEvidenceFingerprint("bun test repro.test.ts"));
		expect(gateByspec(state, "verify").satisfied).toBe(true);
	});

	it("treats commands differing only in surrounding whitespace as the same fingerprint", () => {
		const state = stateWithFixBug();
		state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 });
		const same = state.recordCommandObservation({ command: "  bun test repro.test.ts \n", exitCode: 0 });
		expect(same.some(receipt => receipt.gateId === "gate:skill:fix-bug:verify")).toBe(true);
	});

	it("stops producing receipts for an already satisfied gate", () => {
		const state = stateWithFixBug();
		expect(state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 })).toHaveLength(1);
		expect(state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 })).toHaveLength(0);
		expect(gateByspec(state, "repro").receipts).toHaveLength(1);
	});

	it("returns nothing when no chain is active", () => {
		const state = new SessionSkillGateState("session-1");
		expect(state.recordCommandObservation({ command: "bun test", exitCode: 0 })).toEqual([]);
	});
});

describe("SessionSkillGateState before-fix reminders", () => {
	it("returns each unsatisfied before-fix gate exactly once", () => {
		const state = stateWithFixBug();
		const first = state.takeBeforeFixReminders();
		expect(first).toEqual([{ skillName: "fix-bug", spec: FIX_BUG_EVIDENCE[0] }]);
		expect(state.takeBeforeFixReminders()).toEqual([]);
	});

	it("does not remind for gates that already have a satisfying receipt", () => {
		const state = stateWithFixBug();
		state.recordCommandObservation({ command: "bun test repro.test.ts", exitCode: 1 });
		expect(state.takeBeforeFixReminders()).toEqual([]);
	});

	it("never includes before-done gates", () => {
		const state = stateWithFixBug();
		const reminders = state.takeBeforeFixReminders();
		expect(reminders.every(reminder => reminder.spec.phase === "before-fix")).toBe(true);
	});
});

describe("SessionSkillGateState contract echo", () => {
	it("records the echo text with a stable fingerprint retrievable from the chain", () => {
		const state = stateWithFixBug();
		const hash = state.recordContractEcho("fix-bug", "Goal: fix the parser crash");
		expect(hash).toBeDefined();
		expect(state.chain("fix-bug")?.contractEcho).toEqual({
			text: "Goal: fix the parser crash",
			hash: hash!,
		});
		// 同文本同指纹(终态汇报反引依赖稳定性)。
		const again = new SessionSkillGateState("session-1");
		again.activate({ name: "fix-bug", evidence: FIX_BUG_EVIDENCE });
		expect(again.recordContractEcho("fix-bug", "Goal: fix the parser crash")).toBe(hash!);
	});

	it("returns undefined for an unknown chain", () => {
		const state = new SessionSkillGateState("session-1");
		expect(state.recordContractEcho("ghost", "text")).toBeUndefined();
	});
});

describe("SessionSkillGateState San Loop bridge", () => {
	it("exposes active skill declarations for recompilation against a real scope contract", () => {
		const state = stateWithFixBug();
		expect(state.activeSkillDeclarations()).toEqual([{ name: "fix-bug", evidence: FIX_BUG_EVIDENCE }]);
	});
});
