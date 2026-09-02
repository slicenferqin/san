import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@san/coding-agent";
import {
	type DiscoveredWorkflowSource,
	type WorkflowAgentBridge,
	type WorkflowAgentRequest,
	type WorkflowCommandContext,
	WorkflowCommandService,
	WorkflowManager,
	type WorkflowRun,
	type WorkflowRunHandle,
	WorkflowStore,
	workflowSourceHash,
} from "@san/coding-agent/workflows";
import { TempDir } from "@san/utils";

let tempDir: TempDir | null = null;
let store: WorkflowStore | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@san-workflow-commands-");
	store = new WorkflowStore(tempDir.join("workflows.sqlite"));
});

afterEach(async () => {
	store?.close();
	store = null;
	if (tempDir) await tempDir.remove().catch(() => {});
	tempDir = null;
});

function requiredTempDir(): TempDir {
	if (!tempDir) throw new Error("Workflow command test temp directory is not initialized.");
	return tempDir;
}

function requiredStore(): WorkflowStore {
	if (!store) throw new Error("Workflow command test store is not initialized.");
	return store;
}

function managedSource(writeMode: "read_only" | "isolated_write" = "read_only"): string {
	const tools = writeMode === "read_only" ? '["read", "grep", "yield"]' : '["read", "edit", "yield"]';
	return `export const meta = {
	name: "release-audit",
	description: "Audit one release",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["branch"],
		properties: { branch: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: ${JSON.stringify(writeMode)}, tools: ${tools} },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 1000, durationMs: 60000 },
};
return await agent(\`audit \${args.branch}\`);`;
}

function adHocSource(): string {
	return `export const meta = {
	name: "route-audit",
	description: "Audit routes once",
	version: "1",
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 1000, durationMs: 60000 },
};
return await agent("audit routes");`;
}

function adHocPathSource(): string {
	return `export const meta = {
	name: "path-audit",
	description: "Audit one approved path",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["path"],
		properties: { path: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 1, agentLimit: 2, tokenLimit: 1000, durationMs: 60000 },
};
phase("inspect approved path");
return await agent(\`audit \${args.path}\`);`;
}

interface Harness {
	service: WorkflowCommandService;
	context: WorkflowCommandContext;
	getCalls(): number;
	getRun(runId: string): WorkflowRun | undefined;
	getObserved(): WorkflowRunHandle | undefined;
	getRequest(): WorkflowAgentRequest | undefined;
	setNow(value: string): void;
}

function createHarness(sourceText = managedSource()): Harness {
	const root = requiredTempDir().path();
	const source: DiscoveredWorkflowSource = {
		name: "release-audit",
		path: requiredTempDir().join(".san", "workflows", "release-audit.js"),
		sourceText,
		sourceHash: workflowSourceHash(sourceText),
		provider: "san",
		level: "project",
		scopeKey: root,
		directoryDepth: 0,
	};
	const discovery = { items: [source], all: [{ ...source, shadowed: false }], warnings: [] };
	const session = SessionManager.inMemory(root);
	let calls = 0;
	let observed: WorkflowRunHandle | undefined;
	let latestRequest: WorkflowAgentRequest | undefined;
	let nowValue: string = "2026-07-11T00:10:00.000Z";
	let id = 0;
	const bridge: WorkflowAgentBridge = {
		run: async request => {
			latestRequest = request;
			calls++;
			return {
				agentId: `agent-${calls}`,
				value: request.prompt,
				text: request.prompt,
				durationMs: 1,
			};
		},
	};
	const manager = new WorkflowManager({
		store: requiredStore(),
		sessionManager: session,
		bridgeFactory: () => bridge,
		now: () => new Date(nowValue),
		idFactory: kind => `${kind}-${++id}`,
	});
	const service = new WorkflowCommandService({
		store: requiredStore(),
		manager,
		discover: async () => discovery,
		now: () => new Date(nowValue),
		challengeIdFactory: () => `challenge-${++id}`,
		home: root,
	});
	const context: WorkflowCommandContext = {
		cwd: root,
		taskRef: "task-current",
		allowIsolatedWrite: false,
		allowAdHoc: true,
		observeRun: handle => {
			observed = handle;
		},
	};
	return {
		service,
		context,
		getCalls: () => calls,
		getRun: runId => manager.getRun(runId),
		getObserved: () => observed,
		getRequest: () => latestRequest,
		setNow: value => {
			nowValue = value;
		},
	};
}

function confirmationToken(text: string, command: "approve" | "approve-draft"): string {
	const match = text.match(new RegExp(`/workflow ${command} (workflow-approval-[^\\s]+)`));
	if (!match?.[1]) throw new Error(`No ${command} confirmation token in output.`);
	return match[1];
}

describe("Workflow command service", () => {
	it("requires publish, exact two-step approval and explicit Managed start before one agent runs", async () => {
		const harness = createHarness();

		const published = await harness.service.execute("publish release-audit", harness.context);
		expect(published).toContain("not yet approved");
		expect(harness.getCalls()).toBe(0);
		expect(requiredStore().listApprovals()).toEqual([]);

		const review = await harness.service.execute("approve release-audit@1", harness.context);
		expect(review).toContain("no approval has been recorded by this command");
		expect(requiredStore().listApprovals()).toEqual([]);
		const token = confirmationToken(review, "approve");

		const approved = await harness.service.execute(`approve ${token}`, harness.context);
		expect(approved).toContain("Managed Workflow approved");
		expect(requiredStore().listApprovals({ workflowKind: "managed" })).toHaveLength(1);
		expect(harness.getCalls()).toBe(0);

		const started = await harness.service.execute('run release-audit@1 {"branch":"main"}', harness.context);
		expect(started).toContain("Started Managed Workflow release-audit@1");
		const handle = harness.getObserved();
		if (!handle) throw new Error("Managed Workflow run was not observed.");
		expect((await handle.completion).status).toBe("completed");
		expect(harness.getCalls()).toBe(1);
		const prepared = harness.service.prepareCompletedRunDelivery(handle.runId);
		expect(prepared.text).toContain("audit main");
		if (!prepared.receipt) throw new Error("Completed Workflow did not prepare a delivery receipt.");
		await harness.service.execute("list", harness.context);
		const replay = harness.service.prepareCompletedRunDelivery(handle.runId);
		expect(replay.receipt).toEqual(prepared.receipt);
		harness.service.acknowledgeDeliveryReceipt(prepared.receipt);
		expect(() => harness.service.prepareCompletedRunDelivery(handle.runId)).toThrow("already delivered");
	});

	it("converts an SOP into an inert Managed source draft without saving, publishing or running it", async () => {
		const harness = createHarness();
		let suppliedSop = "";
		harness.context.generateManagedDescriptor = async sop => {
			suppliedSop = sop;
			return JSON.stringify({ sourceText: managedSource() });
		};

		const draft = await harness.service.execute("draft-managed inspect then verify the release", harness.context);

		expect(suppliedSop).toBe("inspect then verify the release");
		expect(draft).toContain("Managed SOP draft: release-audit@1");
		expect(draft).toContain("Human-readable plan");
		expect(draft).toContain("Stop conditions:");
		expect(draft).toContain("Expected output:");
		expect(draft).toContain("No file was saved");
		expect(draft).toContain(".san/workflows/release-audit.js");
		expect(requiredStore().listManagedVersions()).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("shows literal Managed phases and hard stop conditions before approval", async () => {
		const sourceText = managedSource().replace(
			"return await agent",
			'phase("inventory");\nphase("risk review");\nreturn await agent',
		);
		const harness = createHarness(sourceText);

		const review = await harness.service.execute("show release-audit", harness.context);

		expect(review).toContain("Stages: inventory -> risk review");
		expect(review).toContain("Maximum scale: 8 Agent starts, 2 running concurrently");
		expect(review).toContain("Stop conditions: 1,000 tokens, 60,000 ms");
		expect(review).toContain("Expected output: a JSON-compatible final result");
	});

	it("keeps Managed available while the separate Ad-hoc rollout switch is off", async () => {
		const harness = createHarness();
		harness.context.allowAdHoc = false;

		expect(await harness.service.execute("publish release-audit", harness.context)).toContain("not yet approved");
		await expect(harness.service.execute("generate inspect routes", harness.context)).rejects.toThrow(
			"san.workflows.adHocEnabled",
		);
		expect(await harness.service.execute("list", harness.context)).not.toContain("Ad-hoc Workflow drafts");
	});

	it("does not record a Managed approval when its confirmation expires", async () => {
		const harness = createHarness();
		await harness.service.execute("publish release-audit", harness.context);
		const review = await harness.service.execute("approve release-audit@1", harness.context);
		const token = confirmationToken(review, "approve");

		harness.setNow("2026-07-11T00:21:00.000Z");
		await expect(harness.service.execute(`approve ${token}`, harness.context)).rejects.toThrow(
			"confirmation has expired",
		);
		expect(requiredStore().listApprovals()).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("binds a Managed confirmation to the reviewed execution scope", async () => {
		const harness = createHarness();
		await harness.service.execute("publish release-audit", harness.context);
		const review = await harness.service.execute("approve release-audit@1", harness.context);
		const token = confirmationToken(review, "approve");
		harness.context.cwd = "/different-project";

		await expect(harness.service.execute(`approve ${token}`, harness.context)).rejects.toThrow(
			"different execution scope",
		);
		expect(requiredStore().listApprovals()).toEqual([]);
	});

	it("approves every Ad-hoc draft separately and consumes it on one explicit run", async () => {
		const harness = createHarness();
		const descriptor = JSON.stringify({
			draftId: "draft-routes-1",
			humanSummary:
				"Purpose: audit routes.\nStages: list, audit, summarize.\nStop conditions: stop on uncertainty.\nExpected output: route findings.",
			sourceText: adHocSource(),
		});

		const created = await harness.service.execute(`draft ${descriptor}`, harness.context);
		expect(created).toContain("No agent has started");
		expect(requiredStore().getAdHocDraft("draft-routes-1")?.status).toBe("draft");
		expect(harness.getCalls()).toBe(0);

		const review = await harness.service.execute("approve-draft draft-routes-1", harness.context);
		expect(review).toContain("Approved arguments:\nnull");
		expect(requiredStore().getAdHocDraft("draft-routes-1")?.status).toBe("draft");
		const token = confirmationToken(review, "approve-draft");
		const approved = await harness.service.execute(`approve-draft ${token}`, harness.context);
		expect(approved).toContain("approved for one run only");
		expect(requiredStore().getAdHocDraft("draft-routes-1")?.status).toBe("approved");
		expect(harness.getCalls()).toBe(0);

		const started = await harness.service.execute("run-draft draft-routes-1", harness.context);
		expect(started).toContain("approval is now consumed");
		const handle = harness.getObserved();
		if (!handle) throw new Error("Ad-hoc Workflow run was not observed.");
		expect((await handle.completion).status).toBe("completed");
		expect(requiredStore().getAdHocDraft("draft-routes-1")).toBeUndefined();
		expect(harness.getCalls()).toBe(1);
		await expect(harness.service.execute("run-draft draft-routes-1", harness.context)).rejects.toThrow(
			"does not exist",
		);
		expect(harness.getCalls()).toBe(1);
	});

	it("turns a model-generated descriptor into an inert Ad-hoc draft before separate approval and run", async () => {
		const harness = createHarness();
		let generatedObjective: string | undefined;
		harness.context.generateAdHocDescriptor = async objective => {
			generatedObjective = objective;
			return JSON.stringify({
				draftId: "draft-generated-1",
				humanSummary:
					"Purpose: audit routes once.\nStages: inspect and summarize.\nStop conditions: stop on uncertainty.\nExpected output: route findings.",
				sourceText: adHocSource(),
			});
		};

		const created = await harness.service.execute("generate audit the current routes once", harness.context);

		expect(generatedObjective).toBe("audit the current routes once");
		expect(created).toContain("draft-generated-1");
		expect(created).toContain("No agent has started");
		expect(requiredStore().getAdHocDraft("draft-generated-1")?.status).toBe("draft");
		expect(harness.getCalls()).toBe(0);

		const review = await harness.service.execute("approve-draft draft-generated-1", harness.context);
		const token = confirmationToken(review, "approve-draft");
		await harness.service.execute(`approve-draft ${token}`, harness.context);
		expect(harness.getCalls()).toBe(0);

		await harness.service.execute("run-draft draft-generated-1", harness.context);
		const handle = harness.getObserved();
		if (!handle) throw new Error("Generated Ad-hoc Workflow run was not observed.");
		expect((await handle.completion).status).toBe("completed");
		expect(harness.getCalls()).toBe(1);
	});

	it("replaces an approved Ad-hoc draft with modified boundaries before only the revision can run", async () => {
		const harness = createHarness();
		const original = JSON.stringify({
			draftId: "draft-wide",
			humanSummary:
				"Purpose: audit a broad path.\nStages: inspect the approved path.\nStop conditions: stop on uncertainty.\nExpected output: path findings.",
			sourceText: adHocPathSource(),
			args: { path: "src" },
		});
		await harness.service.execute(`draft ${original}`, harness.context);
		const originalReview = await harness.service.execute("approve-draft draft-wide", harness.context);
		await harness.service.execute(
			`approve-draft ${confirmationToken(originalReview, "approve-draft")}`,
			harness.context,
		);
		expect(requiredStore().listApprovals({ workflowKind: "ad_hoc", includeInactive: true })).toHaveLength(1);

		const revisedDescriptor = JSON.stringify({
			draftId: "draft-narrow",
			humanSummary:
				"Purpose: audit only one narrow path.\nStages: inspect the approved path.\nStop conditions: stop outside the approved path.\nExpected output: narrow path findings.",
			sourceText: adHocPathSource(),
			args: { path: "src/public" },
		});
		const revised = await harness.service.execute(`revise-draft draft-wide ${revisedDescriptor}`, harness.context);

		expect(revised).toContain("Revised Ad-hoc Workflow draft-wide as draft-narrow");
		expect(revised).toContain("old one-time approval are invalid");
		expect(requiredStore().getAdHocDraft("draft-wide")).toBeUndefined();
		expect(requiredStore().getAdHocDraft("draft-narrow")?.args).toEqual({ path: "src/public" });
		expect(requiredStore().listApprovals({ workflowKind: "ad_hoc", includeInactive: true })).toEqual([]);
		expect(harness.getCalls()).toBe(0);
		await expect(harness.service.execute("run-draft draft-wide", harness.context)).rejects.toThrow("does not exist");

		const review = await harness.service.execute("approve-draft draft-narrow", harness.context);
		await harness.service.execute(`approve-draft ${confirmationToken(review, "approve-draft")}`, harness.context);
		await harness.service.execute("run-draft draft-narrow", harness.context);
		const handle = harness.getObserved();
		if (!handle) throw new Error("Revised Ad-hoc Workflow run was not observed.");
		expect((await handle.completion).status).toBe("completed");
		const prepared = harness.service.prepareCompletedRunDelivery(handle.runId);
		expect(prepared.text).toContain("audit src/public");
		if (prepared.receipt) harness.service.acknowledgeDeliveryReceipt(prepared.receipt);
		expect(harness.getCalls()).toBe(1);
	});

	it("invalidates an outstanding confirmation token when its Ad-hoc draft is revised", async () => {
		const harness = createHarness();
		const original = JSON.stringify({
			draftId: "draft-before-review",
			humanSummary:
				"Purpose: audit broadly.\nStages: inspect.\nStop conditions: stop on uncertainty.\nExpected output: findings.",
			sourceText: adHocPathSource(),
			args: { path: "src" },
		});
		await harness.service.execute(`draft ${original}`, harness.context);
		const review = await harness.service.execute("approve-draft draft-before-review", harness.context);
		const staleToken = confirmationToken(review, "approve-draft");
		const revised = JSON.stringify({
			draftId: "draft-after-review",
			humanSummary:
				"Purpose: audit narrowly.\nStages: inspect.\nStop conditions: stop outside scope.\nExpected output: findings.",
			sourceText: adHocPathSource(),
			args: { path: "src/public" },
		});
		await harness.service.execute(`revise-draft draft-before-review ${revised}`, harness.context);

		await expect(harness.service.execute(`approve-draft ${staleToken}`, harness.context)).rejects.toThrow(
			"no longer approvable",
		);
		expect(requiredStore().getAdHocDraft("draft-after-review")?.status).toBe("draft");
		expect(requiredStore().listApprovals({ includeInactive: true })).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("rejects malformed model output without saving or running an Ad-hoc Workflow", async () => {
		const harness = createHarness();
		harness.context.generateAdHocDescriptor = async () => "I would first inspect the routes.";

		await expect(harness.service.execute("generate inspect routes", harness.context)).rejects.toThrow(
			"returned a non-JSON draft",
		);
		expect(requiredStore().listAdHocDrafts()).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("blocks isolated-write publication until its separate setting is enabled", async () => {
		const harness = createHarness(managedSource("isolated_write"));

		await expect(harness.service.execute("publish release-audit", harness.context)).rejects.toThrow(
			"san.workflows.allowIsolatedWrite is disabled",
		);
		expect(requiredStore().listManagedVersions()).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("sanitizes tabs and the home path in review output", async () => {
		const root = requiredTempDir().path();
		const sourceText = managedSource().replace("Audit one release", `Audit\tone release in ${root}`);
		const harness = createHarness(sourceText);

		const output = await harness.service.execute("show release-audit", harness.context);
		expect(output).not.toContain("\t");
		expect(output).not.toContain(root);
		expect(output).toContain("~/");
	});

	it("strips terminal control sequences from Workflow review output", async () => {
		const sourceText = managedSource().replace("Audit one release", "Audit \u001b[31mred\u001b[0m release");
		const harness = createHarness(sourceText);

		const output = await harness.service.execute("show release-audit", harness.context);

		expect(output).not.toContain("\u001b");
		expect(output).toContain("Audit red release");
	});

	it("wraps approval source without hiding a long-line tail", async () => {
		const sourceText = `${managedSource()}\n// ${"x".repeat(500)} REVIEW_TAIL_SENTINEL`;
		const harness = createHarness(sourceText);
		await harness.service.execute("publish release-audit", harness.context);

		const review = await harness.service.execute("approve release-audit@1", harness.context);

		expect(review.replaceAll("\n", "")).toContain("REVIEW_TAIL_SENTINEL");
	});

	it("rejects an Ad-hoc descriptor symlink that resolves outside the current scope", async () => {
		const harness = createHarness();
		const root = requiredTempDir().path();
		const project = path.join(root, "project");
		const outside = path.join(root, "outside.json");
		const linked = path.join(project, "linked.json");
		await fs.mkdir(project, { recursive: true });
		await Bun.write(
			outside,
			JSON.stringify({
				humanSummary:
					"Purpose: review once.\nStages: inspect.\nStop conditions: stop on uncertainty.\nExpected output: findings.",
				sourceText: adHocSource(),
			}),
		);
		await fs.symlink(outside, linked);
		harness.context.cwd = project;

		await expect(harness.service.execute("draft linked.json", harness.context)).rejects.toThrow(
			"must resolve inside the current project scope",
		);
		expect(harness.getCalls()).toBe(0);
	});

	it("hands off the exact approved plan snapshot through one bounded Ad-hoc run", async () => {
		const harness = createHarness();
		const plan = "# Release plan\n\nInspect the release, then report the result.";
		harness.context.model = "anthropic/claude-sonnet-4-5:high";

		const handle = harness.service.startApprovedPlanHandoff(plan, "Release plan", harness.context);

		expect(harness.getObserved()).toBe(handle);
		expect(requiredStore().listAdHocDrafts()).toEqual([]);
		expect(requiredStore().listApprovals({ workflowKind: "ad_hoc" })).toEqual([]);
		expect((await handle.completion).status).toBe("completed");
		expect(harness.getCalls()).toBe(1);
		const request = harness.getRequest();
		expect(request?.prompt).toBe(plan);
		expect(request?.allowedTools).toContain("yield");
		expect(request?.writeMode).toBe("read_only");
		expect(request?.remainingTokenBudget).toBe(120000);
		expect(request?.model).toBe("anthropic/claude-sonnet-4-5:high");
		const run = harness.getRun(handle.runId);
		expect(run?.workflowKind).toBe("ad_hoc");
		expect(run?.workflowName).toBe("plan-release-plan");
		expect(run?.budget.limits).toMatchObject({
			agentLimit: 1,
			concurrency: 1,
			tokenLimit: 120000,
			durationMs: 1800000,
		});
	});

	it("rejects plan handoff when Ad-hoc Workflows are disabled", () => {
		const harness = createHarness();
		harness.context.allowAdHoc = false;

		expect(() => harness.service.startApprovedPlanHandoff("# Plan\n\nDo it.", "Plan", harness.context)).toThrow(
			"san.workflows.adHocEnabled",
		);
		expect(requiredStore().listAdHocDrafts()).toEqual([]);
		expect(harness.getCalls()).toBe(0);
	});

	it("keeps Ad-hoc list, show and rejection bound to the current task and exact scope", async () => {
		const harness = createHarness();
		const descriptor = JSON.stringify({
			draftId: "private-draft",
			humanSummary:
				"Purpose: inspect.\nStages: inspect evidence.\nStop conditions: stop on uncertainty.\nExpected output: evidence.",
			sourceText: adHocSource(),
			args: { path: "src/private" },
		});
		await harness.service.execute(`draft ${descriptor}`, harness.context);

		const foreignContext = {
			...harness.context,
			taskRef: "foreign-task",
			cwd: path.join(harness.context.cwd, "other"),
		};
		expect(await harness.service.execute("list", foreignContext)).not.toContain("private-draft");
		await expect(harness.service.execute("show private-draft", foreignContext)).rejects.toThrow(
			"does not exist in the current task and scope",
		);
		await expect(harness.service.execute("reject-draft private-draft", foreignContext)).rejects.toThrow(
			"different task or scope",
		);
		expect(requiredStore().getAdHocDraft("private-draft")?.status).toBe("draft");

		expect(await harness.service.execute("reject-draft private-draft", harness.context)).toContain("Rejected");
		expect(requiredStore().getAdHocDraft("private-draft")).toBeUndefined();
	});

	it("rejects a vague Ad-hoc summary before it can reach approval", async () => {
		const harness = createHarness();
		const descriptor = JSON.stringify({
			draftId: "vague-draft",
			humanSummary: "Please audit this carefully.",
			sourceText: adHocSource(),
		});

		await expect(harness.service.execute(`draft ${descriptor}`, harness.context)).rejects.toThrow(
			"labeled Stages, Stop conditions, and Expected output",
		);
		expect(requiredStore().getAdHocDraft("vague-draft")).toBeUndefined();
	});
});
