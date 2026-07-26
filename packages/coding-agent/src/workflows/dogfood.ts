import type { Usage } from "@san/ai";
import { TempDir } from "@san/utils";
import { SessionManager } from "../session/session-manager";
import { WorkflowCommandService } from "./commands";
import adHocReviewSource from "./dogfood-sops/ad-hoc-review.js" with { type: "text" };
import adHocReviewNarrowSource from "./dogfood-sops/ad-hoc-review-narrow.js" with { type: "text" };
import authRouteAuditSource from "./dogfood-sops/auth-route-audit.js" with { type: "text" };
import documentationSyncSource from "./dogfood-sops/documentation-sync.js" with { type: "text" };
import incidentTriageSource from "./dogfood-sops/incident-triage.js" with { type: "text" };
import migrationSafetySource from "./dogfood-sops/migration-safety.js" with { type: "text" };
import releaseReadinessSource from "./dogfood-sops/release-readiness.js" with { type: "text" };
import { workflowSourceHash, workflowValueHash } from "./fingerprint";
import { rebuildWorkflowLedger } from "./ledger";
import { WorkflowManager, type WorkflowRunHandle } from "./manager";
import { parseManagedWorkflow, parseWorkflowSource } from "./source-parser";
import { WorkflowStore } from "./store";
import { buildWorkflowTokenReport } from "./token-report";
import type {
	DiscoveredWorkflowSource,
	ManagedWorkflow,
	WorkflowAgentBridge,
	WorkflowAgentRequest,
	WorkflowAgentResult,
	WorkflowJsonValue,
} from "./types";

const DOGFOOD_SCOPE = "/san-v0.4-dogfood";
const MANAGED_RUNS_PER_SOP = 5;
const AD_HOC_TASKS = 10;
const AD_HOC_DRAFTS_PER_TASK = 2;

interface DogfoodSop {
	sourceText: string;
	args: WorkflowJsonValue;
}

const DOGFOOD_SOPS: readonly DogfoodSop[] = [
	{ sourceText: releaseReadinessSource, args: { branch: "feature/workflows" } },
	{ sourceText: authRouteAuditSource, args: { area: "packages/coding-agent/src" } },
	{ sourceText: migrationSafetySource, args: { migration: "workflow-store-v1" } },
	{ sourceText: documentationSyncSource, args: { feature: "managed-workflows" } },
	{ sourceText: incidentTriageSource, args: { symptom: "workflow-run-blocked" } },
];

interface DogfoodAdHocTask {
	objective: string;
	broadScope: string;
	narrowScope: string;
}

const DOGFOOD_AD_HOC_TASKS: readonly DogfoodAdHocTask[] = [
	{
		objective: "release-note consistency",
		broadScope: "packages/coding-agent",
		narrowScope: "packages/coding-agent/CHANGELOG.md",
	},
	{
		objective: "authorization route coverage",
		broadScope: "packages/coding-agent/src",
		narrowScope: "packages/coding-agent/src/slash-commands",
	},
	{
		objective: "workflow database migration safety",
		broadScope: "packages/coding-agent/src/workflows",
		narrowScope: "packages/coding-agent/src/workflows/store.ts",
	},
	{
		objective: "CLI help completeness",
		broadScope: "packages/coding-agent/src",
		narrowScope: "packages/coding-agent/src/slash-commands/builtin-registry.ts",
	},
	{
		objective: "terminal output sanitization",
		broadScope: "packages/coding-agent/src/tools",
		narrowScope: "packages/coding-agent/src/tools/render-utils.ts",
	},
	{
		objective: "session identity cancellation",
		broadScope: "packages/coding-agent/src/session",
		narrowScope: "packages/coding-agent/src/session/session-manager.ts",
	},
	{
		objective: "isolated patch review",
		broadScope: "packages/coding-agent/src/task",
		narrowScope: "packages/coding-agent/src/task/isolation-runner.ts",
	},
	{
		objective: "token evidence integrity",
		broadScope: "packages/coding-agent/src/workflows",
		narrowScope: "packages/coding-agent/src/workflows/token-report.ts",
	},
	{
		objective: "Claude Workflow discovery precedence",
		broadScope: ".claude",
		narrowScope: ".claude/workflows",
	},
	{
		objective: "cancelled run status accuracy",
		broadScope: "packages/coding-agent/src/workflows/runtime",
		narrowScope: "packages/coding-agent/src/workflows/runtime/control.ts",
	},
];

export interface WorkflowDogfoodCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export interface WorkflowDogfoodSummary {
	ok: boolean;
	managedSops: number;
	managedRuns: number;
	adHocDrafts: number;
	adHocRevisions: number;
	adHocRuns: number;
	agentsStarted: number;
	unapprovedAgentsStarted: number;
	rejectedDraftAgentsStarted: number;
	stableManagedNodeGraphs: boolean;
	duplicateDeliveries: number;
	adHocApprovalReuses: number;
	tokenRolloutStatus: "insufficient_data";
	checks: WorkflowDogfoodCheck[];
	reportText: string;
}

function dogfoodUsage(): Usage {
	return {
		input: 20,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 25,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function bridgeResult(request: WorkflowAgentRequest): WorkflowAgentResult {
	const value = `evidence:${workflowValueHash({ prompt: request.prompt }).slice(0, 12)}`;
	return {
		agentId: `dogfood-${request.nodeId}`,
		value,
		text: value,
		usage: dogfoodUsage(),
		durationMs: 1,
	};
}

function managedWorkflow(sourceText: string): ManagedWorkflow {
	const parsed = parseWorkflowSource(sourceText);
	if (!parsed.meta) throw new Error("Workflow dogfood SOP has no metadata.");
	const sourceHash = workflowSourceHash(sourceText);
	const source: DiscoveredWorkflowSource = {
		name: parsed.meta.name,
		path: `${DOGFOOD_SCOPE}/.san/workflows/${parsed.meta.name}.js`,
		sourceText,
		sourceHash,
		provider: "san",
		level: "project",
		scopeKey: DOGFOOD_SCOPE,
		directoryDepth: 0,
	};
	return parseManagedWorkflow(source);
}

function adHocDescriptor(draftId: string, task: DogfoodAdHocTask, narrow: boolean): string {
	return JSON.stringify({
		draftId,
		humanSummary: narrow
			? `Purpose: Review ${task.objective} once.\nStages: inspect only the narrowed scope, verify, summarize.\nStop conditions: stop outside ${task.narrowScope}, on uncertainty, or at the smaller budget.\nExpected output: a scoped read-only evidence summary.`
			: `Purpose: Review ${task.objective} broadly.\nStages: inventory the broad scope, compare evidence, summarize.\nStop conditions: stop on uncertainty or at the broad budget.\nExpected output: a broad read-only evidence summary.`,
		sourceText: narrow ? adHocReviewNarrowSource : adHocReviewSource,
		args: {
			objective: task.objective,
			scope: narrow ? task.narrowScope : task.broadScope,
		},
	});
}

function approvalToken(output: string): string {
	const match = output.match(/\/workflow approve-draft (workflow-approval-[^\s]+)/);
	if (!match?.[1]) throw new Error("Workflow dogfood approval review did not issue a confirmation token.");
	return match[1];
}

function reportText(summary: Omit<WorkflowDogfoodSummary, "reportText">): string {
	return [
		`San v0.4 deterministic Workflow dogfood: ${summary.ok ? "PASS" : "FAIL"}`,
		`Managed SOPs: ${summary.managedSops}`,
		`Managed runs: ${summary.managedRuns}`,
		`Ad-hoc drafts/revisions/runs: ${summary.adHocDrafts}/${summary.adHocRevisions}/${summary.adHocRuns}`,
		`Agents started without approval: ${summary.unapprovedAgentsStarted}`,
		`Agents started after draft rejection: ${summary.rejectedDraftAgentsStarted}`,
		`Stable Managed node graphs: ${summary.stableManagedNodeGraphs ? "yes" : "no"}`,
		`Duplicate deliveries: ${summary.duplicateDeliveries}`,
		`Ad-hoc approval reuses: ${summary.adHocApprovalReuses}`,
		"Real-model token rollout gate: insufficient_data (deterministic usage is not accepted as rollout evidence)",
	].join("\n");
}

/**
 * Credential-free, deterministic acceptance probe for execution and approval
 * invariants. It deliberately does not claim the real-model token gate.
 */
export async function runWorkflowDeterministicDogfood(): Promise<WorkflowDogfoodSummary> {
	const tempDir = TempDir.createSync("@san-v0.4-workflow-dogfood-");
	const store = new WorkflowStore(tempDir.join("workflows.sqlite"));
	const session = SessionManager.inMemory(DOGFOOD_SCOPE);
	let agentsStarted = 0;
	const bridge: WorkflowAgentBridge = {
		run: async request => {
			agentsStarted++;
			return bridgeResult(request);
		},
	};
	let id = 0;
	let tick = 0;
	const now = () => new Date(Date.parse("2026-07-11T00:10:00.000Z") + tick++);
	const manager = new WorkflowManager({
		store,
		sessionManager: session,
		bridgeFactory: () => bridge,
		now,
		idFactory: kind => `dogfood-${kind}-${++id}`,
	});
	const service = new WorkflowCommandService({
		store,
		manager,
		discover: async () => ({ items: [], all: [], warnings: [] }),
		now,
		challengeIdFactory: () => `dogfood-challenge-${++id}`,
		home: DOGFOOD_SCOPE,
	});
	let unapprovedAgentsStarted = 0;
	let rejectedDraftAgentsStarted = 0;
	let duplicateDeliveries = 0;
	let adHocApprovalReuses = 0;
	let adHocRevisions = 0;
	let managedRuns = 0;
	let stableManagedNodeGraphs = true;

	try {
		for (const definition of DOGFOOD_SOPS) {
			const workflow = managedWorkflow(definition.sourceText);
			const beforeUnapproved = agentsStarted;
			try {
				manager.startManaged({
					name: workflow.meta.name,
					version: workflow.meta.version,
					scopeKey: workflow.source.scopeKey,
					args: definition.args,
				});
			} catch {}
			unapprovedAgentsStarted += agentsStarted - beforeUnapproved;
			manager.publishManagedVersion(workflow);
			manager.approveManagedVersion(workflow);

			let expectedGraph: string[] | undefined;
			for (let run = 0; run < MANAGED_RUNS_PER_SOP; run++) {
				const handle = manager.startManaged({
					name: workflow.meta.name,
					version: workflow.meta.version,
					scopeKey: workflow.source.scopeKey,
					args: definition.args,
				});
				const completed = await handle.completion;
				managedRuns++;
				const graph = completed.nodes.map(node => node.nodeId);
				if (!expectedGraph) expectedGraph = graph;
				else if (JSON.stringify(graph) !== JSON.stringify(expectedGraph)) stableManagedNodeGraphs = false;
				manager.deliverResult(handle.runId);
				try {
					manager.deliverResult(handle.runId);
					duplicateDeliveries++;
				} catch {}
			}
		}

		let adHocRuns = 0;
		for (const [index, task] of DOGFOOD_AD_HOC_TASKS.entries()) {
			const taskNumber = index + 1;
			const taskRef = `dogfood-task-${taskNumber}`;
			const broadDraftId = `task-${taskNumber}-draft-1`;
			const narrowDraftId = `task-${taskNumber}-draft-2`;
			let observed: WorkflowRunHandle | undefined;
			const context = {
				cwd: DOGFOOD_SCOPE,
				taskRef,
				allowIsolatedWrite: false,
				allowAdHoc: true,
				observeRun: (handle: WorkflowRunHandle) => {
					observed = handle;
				},
			};
			await service.execute(`draft ${adHocDescriptor(broadDraftId, task, false)}`, context);
			const beforeRejected = agentsStarted;
			await service.execute(`revise-draft ${broadDraftId} ${adHocDescriptor(narrowDraftId, task, true)}`, context);
			adHocRevisions++;
			try {
				await service.execute(`run-draft ${broadDraftId}`, context);
			} catch {}
			rejectedDraftAgentsStarted += agentsStarted - beforeRejected;

			const review = await service.execute(`approve-draft ${narrowDraftId}`, context);
			await service.execute(`approve-draft ${approvalToken(review)}`, context);
			await service.execute(`run-draft ${narrowDraftId}`, context);
			const handle = observed;
			if (!handle) throw new Error(`Workflow dogfood did not observe ${narrowDraftId}.`);
			await handle.completion;
			adHocRuns++;
			const delivery = service.prepareCompletedRunDelivery(handle.runId);
			if (delivery.receipt) service.acknowledgeDeliveryReceipt(delivery.receipt);
			try {
				await service.execute(`run-draft ${narrowDraftId}`, context);
				adHocApprovalReuses++;
			} catch {}
		}

		const ledger = rebuildWorkflowLedger(session.getEntries());
		const ledgerHealthy =
			ledger.invalidEntryIds.length === 0 &&
			ledger.duplicateEventIds.length === 0 &&
			[...ledger.runs.values()].every(
				run =>
					run.invalidSequenceEventIds.length === 0 &&
					run.invalidTransitionEventIds.length === 0 &&
					run.duplicateDeliveryEventIds.length === 0,
			);
		const tokenReport = await buildWorkflowTokenReport([]);
		const checks: WorkflowDogfoodCheck[] = [
			{ name: "five_managed_sops", ok: DOGFOOD_SOPS.length === 5, detail: `${DOGFOOD_SOPS.length} SOPs` },
			{
				name: "five_runs_each",
				ok: managedRuns === DOGFOOD_SOPS.length * MANAGED_RUNS_PER_SOP,
				detail: `${managedRuns} Managed runs`,
			},
			{
				name: "stable_node_graphs",
				ok: stableManagedNodeGraphs,
				detail: "Repeated versions retained identical node identities and ordering.",
			},
			{
				name: "zero_unapproved_execution",
				ok: unapprovedAgentsStarted === 0 && rejectedDraftAgentsStarted === 0,
				detail: `${unapprovedAgentsStarted + rejectedDraftAgentsStarted} agents started outside approval`,
			},
			{
				name: "ad_hoc_once",
				ok:
					DOGFOOD_AD_HOC_TASKS.length === AD_HOC_TASKS &&
					adHocRevisions === AD_HOC_TASKS &&
					adHocApprovalReuses === 0 &&
					adHocRuns === AD_HOC_TASKS,
				detail: `${adHocRuns} runs and ${adHocRevisions} narrowed replacements across ${AD_HOC_TASKS} distinct tasks; ${adHocApprovalReuses} reused approvals`,
			},
			{
				name: "exactly_once_delivery",
				ok: duplicateDeliveries === 0,
				detail: `${duplicateDeliveries} duplicate deliveries accepted`,
			},
			{ name: "ledger_integrity", ok: ledgerHealthy, detail: "All run sequences and transitions are valid." },
			{
				name: "real_token_gate_not_fabricated",
				ok: tokenReport.status === "insufficient_data",
				detail: "Deterministic usage is excluded from rollout evidence.",
			},
		];
		const withoutText: Omit<WorkflowDogfoodSummary, "reportText"> = {
			ok: checks.every(check => check.ok),
			managedSops: DOGFOOD_SOPS.length,
			managedRuns,
			adHocDrafts: AD_HOC_TASKS * AD_HOC_DRAFTS_PER_TASK,
			adHocRevisions,
			adHocRuns,
			agentsStarted,
			unapprovedAgentsStarted,
			rejectedDraftAgentsStarted,
			stableManagedNodeGraphs,
			duplicateDeliveries,
			adHocApprovalReuses,
			tokenRolloutStatus: "insufficient_data",
			checks,
		};
		return { ...withoutText, reportText: reportText(withoutText) };
	} finally {
		store.close();
		await tempDir.remove().catch(() => {});
	}
}
