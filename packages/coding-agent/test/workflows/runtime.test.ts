import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	RestrictedWorkflowRuntime,
	type WorkflowAgentBridge,
	type WorkflowAgentRequest,
	type WorkflowAgentResult,
	type WorkflowLimits,
	WorkflowRuntimeControl,
	workflowSourceHash,
} from "@oh-my-pi/pi-coding-agent/workflows";

const fixtures = path.join(import.meta.dir, "..", "fixtures", "workflows");
const readOnlyPermissions = { writeMode: "read_only", tools: ["read", "grep", "yield"] } as const;

function limits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
	return {
		concurrency: 2,
		agentLimit: 8,
		tokenLimit: 1_000,
		durationMs: 60_000,
		...overrides,
	};
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function result(request: WorkflowAgentRequest, value: WorkflowAgentResult["value"], tokens = 10): WorkflowAgentResult {
	return {
		agentId: request.nodeId,
		value,
		text: typeof value === "string" ? value : JSON.stringify(value),
		usage: usage(tokens),
		durationMs: 1,
	};
}

function runtime(
	sourceText: string,
	bridge: WorkflowAgentBridge,
	options: {
		limits?: WorkflowLimits;
		control?: WorkflowRuntimeControl;
		completedCalls?: ReadonlyMap<string, WorkflowAgentResult>;
		initialAgentsStarted?: number;
		initialAgentsCompleted?: number;
		initialTokensUsed?: number;
		maxSteps?: number;
		maxCollectionSize?: number;
	} = {},
): RestrictedWorkflowRuntime {
	return new RestrictedWorkflowRuntime({
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		scopeKey: process.cwd(),
		bridge,
		permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
		limits: options.limits ?? limits(),
		control: options.control,
		completedCalls: options.completedCalls,
		initialAgentsStarted: options.initialAgentsStarted,
		initialAgentsCompleted: options.initialAgentsCompleted,
		initialTokensUsed: options.initialTokensUsed,
		maxSteps: options.maxSteps,
		maxCollectionSize: options.maxCollectionSize,
	});
}

describe("Restricted Workflow runtime", () => {
	it("executes the documented Claude agent/pipeline/filter shape with intermediate results outside the main session", async () => {
		const sourceText = await Bun.file(path.join(fixtures, "allowed", "claude-public.js")).text();
		const requests: WorkflowAgentRequest[] = [];
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				requests.push(request);
				if (request.schema) return result(request, { files: ["a.ts", "b.ts"] });
				return result(request, `checked:${request.label}`);
			},
		};

		const executed = await runtime(sourceText, bridge).execute();

		expect(executed.value).toEqual(["checked:a.ts", "checked:b.ts"]);
		expect(requests.every(request => request.scopeKey === process.cwd())).toBe(true);
		expect(requests.map(request => request.phase)).toEqual(["workflow", "workflow", "workflow"]);
		expect(executed.budget).toMatchObject({ agentsStarted: 3, agentsCompleted: 3, tokensUsed: 30 });
	});

	it("keeps parallel results ordered while enforcing the hard concurrency ceiling", async () => {
		const sourceText = `export const meta = { name: "parallel-order", description: "Parallel order" };
return await parallel([
	() => agent("first"),
	() => agent("second"),
	() => agent("third"),
]);`;
		let active = 0;
		let maximum = 0;
		const pairStarted = Promise.withResolvers<void>();
		let started = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				active++;
				started++;
				maximum = Math.max(maximum, active);
				if (started === 2) pairStarted.resolve();
				await pairStarted.promise;
				active--;
				return result(request, request.prompt);
			},
		};

		const executed = await runtime(sourceText, bridge, { limits: limits({ concurrency: 2 }) }).execute();

		expect(executed.value).toEqual(["first", "second", "third"]);
		expect(maximum).toBe(2);
	});

	it("stops scheduling at the agent hard limit even when a script asks for more", async () => {
		const sourceText = `export const meta = { name: "agent-cap", description: "Agent cap" };
return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);`;
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return result(request, request.prompt);
			},
		};

		await expect(runtime(sourceText, bridge, { limits: limits({ agentLimit: 2 }) }).execute()).rejects.toMatchObject({
			code: "agent_limit",
		});
		expect(calls).toBe(2);
	});

	it("does not schedule more parallel work after the first observed bridge failure", async () => {
		const sourceText = `export const meta = { name: "parallel-failure", description: "Parallel failure" };
return await parallel([
	() => agent("fails"),
	() => agent("already-running"),
	() => agent("must-not-start"),
]);`;
		const firstTwoStarted = Promise.withResolvers<void>();
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				if (calls === 2) firstTwoStarted.resolve();
				await firstTwoStarted.promise;
				if (request.prompt === "fails") throw new Error("bridge failed");
				return result(request, request.prompt);
			},
		};

		await expect(runtime(sourceText, bridge, { limits: limits({ concurrency: 2 }) }).execute()).rejects.toThrow(
			"bridge failed",
		);
		expect(calls).toBe(2);
	});

	it("atomically partitions the hard token budget across concurrent agents", async () => {
		const sourceText = `export const meta = { name: "token-cap", description: "Token cap" };
return await parallel([() => agent("a"), () => agent("b")]);`;
		const allocations: number[] = [];
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				allocations.push(request.remainingTokenBudget);
				return result(request, request.prompt, request.remainingTokenBudget);
			},
		};
		const observedTokens: number[] = [];

		const executed = await new RestrictedWorkflowRuntime({
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			scopeKey: process.cwd(),
			bridge,
			permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
			limits: limits({ tokenLimit: 100 }),
			hooks: { onTokensUsed: tokens => observedTokens.push(tokens) },
		}).execute();
		expect(allocations.reduce((sum, allocation) => sum + allocation, 0)).toBe(100);
		expect(observedTokens.at(-1)).toBe(100);
		expect(executed.budget.tokensUsed).toBe(100);
	});

	it("keeps sequential calls in one parallel branch inside that branch allocation", async () => {
		const sourceText = `export const meta = { name: "nested-token-cap", description: "Nested token cap" };
return await parallel([
	async () => [await agent("a1"), await agent("a2")],
	async () => [await agent("b1"), await agent("b2")],
]);`;
		const allocations = new Map<string, number>();
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				allocations.set(request.prompt, request.remainingTokenBudget);
				return result(request, request.prompt, 25);
			},
		};

		const executed = await runtime(sourceText, bridge, { limits: limits({ tokenLimit: 100 }) }).execute();

		expect(allocations).toEqual(
			new Map([
				["a1", 50],
				["a2", 25],
				["b1", 50],
				["b2", 25],
			]),
		);
		expect(executed.budget.tokensUsed).toBe(100);
	});

	it("rejects provider usage above a reserved allocation without committing it", async () => {
		const sourceText = `export const meta = { name: "token-overrun", description: "Token overrun" };
return await agent("a");`;
		const observedTokens: number[] = [];
		const bridge: WorkflowAgentBridge = {
			run: async request => result(request, request.prompt, request.remainingTokenBudget + 1),
		};

		await expect(
			new RestrictedWorkflowRuntime({
				sourceText,
				sourceHash: workflowSourceHash(sourceText),
				scopeKey: process.cwd(),
				bridge,
				permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
				limits: limits({ tokenLimit: 100 }),
				hooks: { onTokensUsed: tokens => observedTokens.push(tokens) },
			}).execute(),
		).rejects.toMatchObject({ code: "token_limit" });
		expect(observedTokens).toEqual([101]);
	});

	it("rejects unsafe structured-output schemas before any agent starts", async () => {
		const sourceText = `export const meta = { name: "unsafe-schema", description: "Unsafe schema" };
return await agent("inspect", { schema: { type: "string", pattern: "^(a+)+$" } });`;
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return result(request, "safe");
			},
		};

		await expect(runtime(sourceText, bridge).execute()).rejects.toThrow("linear-safe Workflow pattern");
		expect(calls).toBe(0);
	});

	it("replays stable call IDs from committed results without spawning an agent twice", async () => {
		const sourceText = `export const meta = { name: "resume-cache", description: "Resume cache" };
phase("inspect");
return await agent("inspect");`;
		let firstCalls = 0;
		const firstBridge: WorkflowAgentBridge = {
			run: async request => {
				firstCalls++;
				return result(request, "done", 25);
			},
		};
		const first = await runtime(sourceText, firstBridge).execute();
		let resumedCalls = 0;
		const resumedBridge: WorkflowAgentBridge = {
			run: async request => {
				resumedCalls++;
				return result(request, "unexpected");
			},
		};

		const resumed = await runtime(sourceText, resumedBridge, {
			completedCalls: first.completedCalls,
			initialAgentsStarted: first.budget.agentsStarted,
			initialTokensUsed: first.budget.tokensUsed,
		}).execute();

		expect(firstCalls).toBe(1);
		expect(resumedCalls).toBe(0);
		expect(resumed.value).toBe("done");
		expect(resumed.budget).toMatchObject({ agentsStarted: 1, tokensUsed: 25 });
	});

	it("binds replay identities to call inputs when parallel item order changes", async () => {
		const sourceText = `export const meta = { name: "input-replay", description: "Input-bound replay" };
return await pipeline(args.items, async item => agent(item));`;
		const first = await new RestrictedWorkflowRuntime({
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			scopeKey: process.cwd(),
			args: { items: ["alpha", "beta"] },
			bridge: { run: async request => result(request, `${request.prompt}-result`) },
			permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
			limits: limits(),
		}).execute();
		let resumedCalls = 0;
		const resumed = await new RestrictedWorkflowRuntime({
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			scopeKey: process.cwd(),
			args: { items: ["beta", "alpha"] },
			bridge: {
				run: async request => {
					resumedCalls++;
					return result(request, "unexpected");
				},
			},
			permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
			limits: limits(),
			completedCalls: first.completedCalls,
			initialAgentsStarted: first.budget.agentsStarted,
			initialAgentsCompleted: first.budget.agentsCompleted,
			initialTokensUsed: first.budget.tokensUsed,
		}).execute();

		expect(resumedCalls).toBe(0);
		expect(resumed.value).toEqual(["beta-result", "alpha-result"]);
	});

	it("captures a distinct lexical binding for every loop-created callback", async () => {
		const sourceText = `export const meta = { name: "loop-closures", description: "Loop closure bindings" };
const calls = [];
for (let index = 0; index < 3; index++) calls.push(() => agent(String(index)));
return await parallel(calls);`;
		const executed = await runtime(sourceText, {
			run: async request => result(request, request.prompt),
		}).execute();

		expect(executed.value).toEqual(["0", "1", "2"]);
	});

	it("keeps approved arguments and committed agent results immutable outside the interpreter", async () => {
		const sourceText = `export const meta = { name: "host-isolation", description: "Host value isolation" };
args.local = "changed";
const inspected = await agent("inspect");
inspected.local = "changed";
return { args, inspected };`;
		const args = { stable: true };
		const bridgeValue = { stable: true };
		const bridge: WorkflowAgentBridge = {
			run: async request => result(request, bridgeValue),
		};
		const executed = await new RestrictedWorkflowRuntime({
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			scopeKey: process.cwd(),
			args,
			bridge,
			permissions: { writeMode: readOnlyPermissions.writeMode, tools: [...readOnlyPermissions.tools] },
			limits: limits(),
		}).execute();

		expect(executed.value).toEqual({
			args: { stable: true, local: "changed" },
			inspected: { stable: true, local: "changed" },
		});
		expect(args).toEqual({ stable: true });
		expect(bridgeValue).toEqual({ stable: true });
		expect([...executed.completedCalls.values()].map(item => item.value)).toEqual([{ stable: true }]);
	});

	it("rejects a non-JSON bridge value before committing it", async () => {
		const sourceText = `export const meta = { name: "invalid-bridge", description: "Invalid bridge result" };
return await agent("inspect");`;
		const invalid = {
			...result(
				{
					callId: "unused",
					nodeId: "unused",
					inputHash: "unused",
					phase: "workflow",
					prompt: "unused",
					allowedTools: [],
					writeMode: "read_only" as const,
					scopeKey: process.cwd(),
					remainingTokenBudget: 1_000,
					signal: new AbortController().signal,
				},
				"unused",
			),
			value: new Date(),
		} as unknown as WorkflowAgentResult;
		const bridge: WorkflowAgentBridge = { run: async () => invalid };

		await expect(runtime(sourceText, bridge).execute()).rejects.toMatchObject({ code: "invalid_result" });
	});

	it("rejects invalid usage instead of allowing a non-finite token budget", async () => {
		const sourceText = `export const meta = { name: "invalid-usage", description: "Invalid bridge usage" };
return await agent("inspect");`;
		const bridge: WorkflowAgentBridge = {
			run: async request => ({ ...result(request, "done"), usage: usage(Number.NaN) }),
		};

		await expect(runtime(sourceText, bridge).execute()).rejects.toMatchObject({ code: "invalid_result" });
	});

	it("pause prevents every new node until explicit resume", async () => {
		const sourceText = `export const meta = { name: "pause-run", description: "Pause run" };
return await agent("after-resume");`;
		const control = new WorkflowRuntimeControl();
		control.pause();
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return result(request, "resumed");
			},
		};
		const execution = runtime(sourceText, bridge, { control }).execute();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(0);

		control.resume();
		expect((await execution).value).toBe("resumed");
		expect(calls).toBe(1);
	});

	it("cancelling a paused run exits as cancelled and starts zero agents", async () => {
		const sourceText = `export const meta = { name: "cancel-run", description: "Cancel run" };
return await agent("never");`;
		const control = new WorkflowRuntimeControl();
		control.pause();
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return result(request, "unexpected");
			},
		};
		const execution = runtime(sourceText, bridge, { control }).execute();
		control.cancel();

		await expect(execution).rejects.toMatchObject({ code: "cancelled" });
		expect(calls).toBe(0);
	});

	it("blocks direct host access before bridge execution", async () => {
		const sourceText = await Bun.file(path.join(fixtures, "malicious", "direct-process.js")).text();
		let calls = 0;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				calls++;
				return result(request, "unexpected");
			},
		};

		await expect(runtime(sourceText, bridge).execute()).rejects.toMatchObject({ code: "permission_denied" });
		expect(calls).toBe(0);
	});

	it("hard-stops an infinite synchronous loop by interpreter steps", async () => {
		const sourceText = await Bun.file(path.join(fixtures, "malicious", "infinite-loop.js")).text();
		const bridge: WorkflowAgentBridge = {
			run: async request => result(request, "unexpected"),
		};

		await expect(runtime(sourceText, bridge, { maxSteps: 200 }).execute()).rejects.toEqual(
			expect.objectContaining({ code: "step_limit" }),
		);
	});

	it("aborts an in-flight agent when the workflow wall-clock limit expires", async () => {
		const sourceText = `export const meta = { name: "time-cap", description: "Time cap" };
return await agent("wait");`;
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				const aborted = Promise.withResolvers<WorkflowAgentResult>();
				const onAbort = () => aborted.reject(request.signal.reason);
				request.signal.addEventListener("abort", onAbort, { once: true });
				try {
					return await aborted.promise;
				} finally {
					request.signal.removeEventListener("abort", onAbort);
				}
			},
		};

		await expect(runtime(sourceText, bridge, { limits: limits({ durationMs: 25 }) }).execute()).rejects.toMatchObject(
			{
				code: "time_limit",
			},
		);
	});

	it("hard-stops collection growth before a script can exhaust host memory", async () => {
		const sourceText = `export const meta = { name: "memory-cap", description: "Memory cap" };
const values = [];
for (let index = 0; index < 20; index++) values.push(index);
return values;`;
		const bridge: WorkflowAgentBridge = { run: async request => result(request, "unused") };

		await expect(runtime(sourceText, bridge, { maxCollectionSize: 10 }).execute()).rejects.toMatchObject({
			code: "step_limit",
		});
	});
});
