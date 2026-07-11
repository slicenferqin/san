import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	parseManagedWorkflow,
	rebuildWorkflowLedger,
	type WorkflowAgentBridge,
	type WorkflowAgentResult,
	WorkflowCommandService,
	WorkflowManager,
	WorkflowStore,
	workflowSourceHash,
} from "@oh-my-pi/pi-coding-agent/workflows";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { captureBaseline } from "../../src/task/worktree";
import {
	applyWorkflowWriteArtifact,
	captureWorkflowWriteArtifact,
	reviewWorkflowWriteArtifact,
	WorkflowWriteDeliveryError,
} from "../../src/workflows/delivery";

let tempDir: TempDir | null = null;
let store: WorkflowStore | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@san-workflow-delivery-");
	store = new WorkflowStore(tempDir.join("workflows.sqlite"));
});

afterEach(async () => {
	store?.close();
	store = null;
	if (tempDir) await tempDir.remove().catch(() => {});
	tempDir = null;
});

function requiredTempDir(): TempDir {
	if (!tempDir) throw new Error("Workflow delivery temp directory is not initialized.");
	return tempDir;
}

function requiredStore(): WorkflowStore {
	if (!store) throw new Error("Workflow delivery store is not initialized.");
	return store;
}

async function repository(): Promise<{ repo: string; artifacts: string }> {
	const repo = requiredTempDir().join("repo");
	const artifacts = requiredTempDir().join("artifacts");
	await fs.mkdir(repo, { recursive: true });
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(repo, "tracked.txt"), "old\n");
	await $`git init --initial-branch=main`.cwd(repo).quiet();
	await $`git config user.email workflow@example.invalid`.cwd(repo).quiet();
	await $`git config user.name Workflow`.cwd(repo).quiet();
	await $`git add tracked.txt`.cwd(repo).quiet();
	await $`git commit -m baseline`.cwd(repo).quiet();
	return { repo, artifacts };
}

function replacementPatch(next = "new"): string {
	return [
		"diff --git a/tracked.txt b/tracked.txt",
		"--- a/tracked.txt",
		"+++ b/tracked.txt",
		"@@ -1 +1 @@",
		"-old",
		`+${next}`,
		"",
	].join("\n");
}

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("Workflow isolated write delivery", () => {
	it("requires complete review, applies once, and only then delivers the Workflow result", async () => {
		const { artifacts, repo } = await repository();
		const patchPath = path.join(artifacts, "agent.patch");
		await Bun.write(patchPath, replacementPatch());
		const baseline = await captureBaseline(repo);
		const session = SessionManager.inMemory(repo);
		const bridge: WorkflowAgentBridge = {
			run: async request => {
				const result: WorkflowAgentResult = {
					agentId: "writer-1",
					value: "write-ready",
					text: "write-ready",
					usage: usage(),
					durationMs: 1,
					changesApplied: null,
					writeArtifact: {
						repoRoot: repo,
						artifactRoot: artifacts,
						patchPath,
						scopeKey: request.scopeKey,
						baseline,
						nestedPatches: [],
					},
				};
				return result;
			},
		};
		let id = 0;
		const manager = new WorkflowManager({
			store: requiredStore(),
			sessionManager: session,
			bridgeFactory: () => bridge,
			idFactory: kind => `${kind}-${++id}`,
			writeReviewTokenFactory: () => "workflow-write-review-1",
		});
		const sourceText = `export const meta = {
	name: "write-once",
	description: "Create one reviewed patch",
	version: "1",
	permissions: { writeMode: "isolated_write", tools: ["read", "edit", "yield"] },
	limits: { concurrency: 1, agentLimit: 2, tokenLimit: 1000, durationMs: 60000 },
};
return await agent("prepare one isolated change");`;
		const workflow = parseManagedWorkflow({
			name: "write-once",
			path: path.join(repo, ".san", "workflows", "write-once.js"),
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			provider: "san",
			level: "project",
			scopeKey: repo,
			directoryDepth: 0,
		});
		manager.publishManagedVersion(workflow);
		manager.approveManagedVersion(workflow);
		const handle = manager.startManaged({ name: "write-once", version: "1", scopeKey: repo });
		const completed = await handle.completion;
		const artifact = completed.writeArtifacts[0];
		if (!artifact) throw new Error("Workflow did not capture its isolated patch.");

		expect(completed.status).toBe("completed");
		expect(artifact.status).toBe("pending");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("old\n");
		expect(() => manager.deliverResult(handle.runId)).toThrow("unresolved isolated write artifact");
		const service = new WorkflowCommandService({ store: requiredStore(), manager, home: requiredTempDir().path() });
		const context = { cwd: repo, taskRef: "delivery-test", allowIsolatedWrite: true, allowAdHoc: true };
		expect(service.deliverCompletedRun(handle.runId)).toContain("isolated changes still require a decision");

		const review = await service.execute(`review-write ${artifact.artifactId}`, context);
		expect(review).toContain("+new");
		expect(review).toContain("/workflow apply-write workflow-write-review-1");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("old\n");
		const applied = await service.execute("apply-write workflow-write-review-1", context);

		expect(applied).toContain("Applied Workflow patch");
		expect(applied).toContain("write-ready");
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("new\n");
		expect(() => manager.deliverResult(handle.runId)).toThrow("already delivered");
		await expect(service.execute("apply-write workflow-write-review-1", context)).rejects.toThrow("invalid or stale");

		const run = rebuildWorkflowLedger(session.getEntries()).runs.get(handle.runId);
		expect(run?.writeArtifacts.get(artifact.artifactId)?.status).toBe("applied");
		expect(run?.invalidTransitionEventIds).toEqual([]);
		expect(run?.deliveryState).toBe("delivered");
	});

	it("blocks apply when the human working tree changes after review", async () => {
		const { artifacts, repo } = await repository();
		const patchPath = path.join(artifacts, "agent.patch");
		await Bun.write(patchPath, replacementPatch());
		const baseline = await captureBaseline(repo);
		const record = await captureWorkflowWriteArtifact({
			artifactId: "artifact-1",
			nodeId: "node-1",
			callId: "call-1",
			agentRef: "agent-1",
			candidate: { repoRoot: repo, artifactRoot: artifacts, patchPath, scopeKey: repo, baseline, nestedPatches: [] },
			capturedAt: "2026-07-11T00:00:00.000Z",
		});
		const review = await reviewWorkflowWriteArtifact(record, "2026-07-11T00:01:00.000Z", () => "review-1");
		await Bun.write(path.join(repo, "tracked.txt"), "human\n");

		await expect(
			applyWorkflowWriteArtifact({
				record,
				reviewToken: review.reviewToken,
				expectedBaseline: baseline,
				appliedAt: "2026-07-11T00:02:00.000Z",
				onApplyStarted: () => {
					throw new Error("apply must not start");
				},
			}),
		).rejects.toMatchObject({ code: "baseline_changed" });
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("human\n");
	});

	it("rejects artifact tampering and possible credentials before issuing an apply token", async () => {
		const { artifacts, repo } = await repository();
		const patchPath = path.join(artifacts, "agent.patch");
		await Bun.write(patchPath, replacementPatch());
		const baseline = await captureBaseline(repo);
		const record = await captureWorkflowWriteArtifact({
			artifactId: "artifact-1",
			nodeId: "node-1",
			callId: "call-1",
			agentRef: "agent-1",
			candidate: { repoRoot: repo, artifactRoot: artifacts, patchPath, scopeKey: repo, baseline, nestedPatches: [] },
			capturedAt: "2026-07-11T00:00:00.000Z",
		});
		await Bun.write(patchPath, replacementPatch("api_key=sk-1234567890abcdefghijkl"));

		await expect(reviewWorkflowWriteArtifact(record, "2026-07-11T00:01:00.000Z")).rejects.toBeInstanceOf(
			WorkflowWriteDeliveryError,
		);

		await Bun.write(patchPath, replacementPatch("api_key=sk-1234567890abcdefghijkl"));
		const credentialRecord = await captureWorkflowWriteArtifact({
			artifactId: "artifact-2",
			nodeId: "node-2",
			callId: "call-2",
			agentRef: "agent-2",
			candidate: { repoRoot: repo, artifactRoot: artifacts, patchPath, scopeKey: repo, baseline, nestedPatches: [] },
			capturedAt: "2026-07-11T00:00:00.000Z",
		});
		await expect(reviewWorkflowWriteArtifact(credentialRecord, "2026-07-11T00:01:00.000Z")).rejects.toMatchObject({
			code: "secret_detected",
		});
	});
});
