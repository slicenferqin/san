/**
 * Focused：外层 mutationTail 串行 vs 嵌套控制面 mutation。
 * 覆盖 worktree.setup.start 等待 approval.decide 时不得死锁的调度契约，
 * 以及 bypass 后可继续触发 host.tool.invoke。
 */
import { describe, expect, test } from "bun:test";
import { RPC_V2_METHOD_BY_NAME } from "../../src/modes/rpc-v2/protocol/methods";
import { shouldSerializeRpcMutation } from "../../src/modes/rpc-v2/rpc-v2-mode";

/** 与 rpc-v2-mode scheduleRequest 相同的 mutation 串行语义（抽出便于断言）。 */
function createMutationScheduler() {
	let mutationTail = Promise.resolve();
	const schedule = (method: string, execute: () => Promise<void>): Promise<void> => {
		const serialize = shouldSerializeRpcMutation(method);
		const task = serialize ? mutationTail.then(execute) : execute();
		if (serialize) mutationTail = task.catch(() => undefined);
		return task;
	};
	return { schedule };
}

describe("RPC v2 mutationTail nested control", () => {
	test("ordinary mutations stay serialized", () => {
		for (const method of [
			"worktree.create",
			"worktree.setup.start",
			"worktree.setup.cancel",
			"worktree.apply",
			"worktree.archive",
			"session.create",
			"run.start",
			"host.capabilities.update",
			"approval.rules.revoke",
			"approval.policy.update",
		]) {
			expect(RPC_V2_METHOD_BY_NAME.get(method)?.mutation).toBe(true);
			expect(shouldSerializeRpcMutation(method)).toBe(true);
		}
	});

	test("approval.decide and interaction control bypass mutationTail", () => {
		for (const method of ["approval.decide", "interaction.respond", "interaction.cancel"]) {
			expect(RPC_V2_METHOD_BY_NAME.get(method)?.mutation).toBe(true);
			expect(shouldSerializeRpcMutation(method)).toBe(false);
		}
	});

	test("non-mutations never serialize on mutationTail", () => {
		for (const method of ["worktree.get", "worktree.list", "initialize", "server.getHealth", "approval.list"]) {
			expect(shouldSerializeRpcMutation(method)).toBe(false);
		}
	});

	test("setup.start awaiting nested approval.decide does not deadlock and reaches host.tool.invoke", async () => {
		const { schedule } = createMutationScheduler();
		const order: string[] = [];
		const approvalGate = Promise.withResolvers<void>();
		const hostInvoke = Promise.withResolvers<{ toolName: string; processId: string }>();

		const setupStart = schedule("worktree.setup.start", async () => {
			order.push("setup.start:enter");
			// 真实路径：setupPort.start → requestHostActionApproval，等待 client approval.decide
			await approvalGate.promise;
			order.push("approval.resolved");
			// 审批通过后 invokeHostAction → host.tool.invoke
			const invoke = { toolName: "desktop.action.start.v1", processId: "proc-nested" };
			order.push("host.tool.invoke");
			hostInvoke.resolve(invoke);
			order.push("setup.start:exit");
		});

		// 若错误地把 approval.decide 串进 tail，下面永远不会进入 execute → setup 挂死。
		const decide = schedule("approval.decide", async () => {
			order.push("approval.decide");
			approvalGate.resolve();
		});

		const [invokeResult] = await Promise.all([hostInvoke.promise, setupStart, decide]);

		expect(invokeResult).toEqual({
			toolName: "desktop.action.start.v1",
			processId: "proc-nested",
		});
		// enter 与 decide 可因微任务交错任一侧先跑；关键是 decide 能在 setup 等待期间执行，
		// 随后到达 host.tool.invoke，而非卡在 mutationTail 死锁。
		expect(order).toContain("setup.start:enter");
		expect(order).toContain("approval.decide");
		expect(order.indexOf("approval.decide")).toBeLessThan(order.indexOf("approval.resolved"));
		expect(order.indexOf("approval.resolved")).toBeLessThan(order.indexOf("host.tool.invoke"));
		expect(order.indexOf("host.tool.invoke")).toBeLessThan(order.indexOf("setup.start:exit"));
		expect(order.filter(step => step === "host.tool.invoke")).toHaveLength(1);
	});

	test("ordinary mutations still serialize against each other", async () => {
		const { schedule } = createMutationScheduler();
		const order: string[] = [];
		const firstGate = Promise.withResolvers<void>();

		const first = schedule("worktree.create", async () => {
			order.push("create:enter");
			await firstGate.promise;
			order.push("create:exit");
		});
		let secondEntered = false;
		const second = schedule("worktree.archive", async () => {
			secondEntered = true;
			order.push("archive");
		});

		// 推进微任务：archive 不得在 create 完成前进入
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["create:enter"]);
		expect(secondEntered).toBe(false);

		firstGate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["create:enter", "create:exit", "archive"]);
		expect(secondEntered).toBe(true);
	});

	test("failed mutation does not poison already queued mutations", async () => {
		const { schedule } = createMutationScheduler();
		const order: string[] = [];

		const failed = schedule("worktree.create", async () => {
			order.push("create:enter");
			throw new Error("create failed");
		});
		const following = schedule("worktree.archive", async () => {
			order.push("archive:enter");
		});

		await expect(failed).rejects.toThrow("create failed");
		await following;
		expect(order).toEqual(["create:enter", "archive:enter"]);
	});
});
