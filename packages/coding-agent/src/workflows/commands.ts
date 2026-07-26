import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeText } from "@san/utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { createAdHocApprovalKey, createManagedApprovalKey, hashWorkflowApprovalKey } from "./approval";
import { discoverWorkflowSources, type WorkflowDiscoveryResult } from "./discovery";
import { workflowSourceHash, workflowValueHash } from "./fingerprint";
import type { WorkflowManager, WorkflowRunHandle } from "./manager";
import { isWorkflowJsonValue } from "./schema";
import {
	parseManagedWorkflow,
	parseWorkflowSource,
	summarizeWorkflowSource,
	WORKFLOW_MAX_SOURCE_BYTES,
} from "./source-parser";
import type { ManagedWorkflowVersionRecord, WorkflowStore } from "./store";
import type {
	AdHocWorkflowDraft,
	ManagedWorkflow,
	WorkflowApprovalRecord,
	WorkflowJsonValue,
	WorkflowMeta,
	WorkflowRun,
} from "./types";

const APPROVAL_CHALLENGE_TTL_MS = 10 * 60_000;
const AD_HOC_DEFAULT_TTL_MS = 60 * 60_000;
const AD_HOC_MAX_TTL_MS = 24 * 60 * 60_000;
const WORKFLOW_MAX_DESCRIPTOR_BYTES = 2 * WORKFLOW_MAX_SOURCE_BYTES;
const WORKFLOW_MAX_HUMAN_SUMMARY_LENGTH = 20_000;
const WORKFLOW_REVIEW_MAX_STAGES = 24;
const APPROVAL_TOKEN_PREFIX = "workflow-approval-";
const AD_HOC_DRAFT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const AD_HOC_SUMMARY_SECTION =
	/(?:^|\n)\s*(?:purpose|stages?|steps?|limits?|tools?|permissions?|stop(?:\s+conditions?)?|expected(?:\s+final)?\s+(?:output|result))\s*:/gim;

export const WORKFLOW_COMMAND_USAGE = [
	"Usage: /workflow <subcommand>",
	"  list",
	"  show <name|name@version|draft-id>",
	"  publish <discovered-name>",
	"  draft-managed <existing SOP text>",
	"  approve <name@version|confirmation-token>",
	"  revoke <name@version>",
	"  run <name@version> [JSON args]",
	"  draft <JSON descriptor or project-relative .json path>",
	"  generate <plain-language one-time task>",
	"  approve-draft <draft-id|confirmation-token>",
	"  revise-draft <draft-id> <JSON descriptor or project-relative .json path>",
	"  run-draft <draft-id>",
	"  reject-draft <draft-id>",
	"  review-write <artifact-id>",
	"  apply-write <review-token>",
	"  reject-write <artifact-id>",
	"  status [run-id]",
	"  pause|resume|cancel <run-id>",
	"  cancel-node <run-id> <node-id>",
].join("\n");

interface ManagedApprovalChallenge {
	kind: "managed";
	token: string;
	keyHash: string;
	name: string;
	version: string;
	scopeKey: string;
	expiresAtMs: number;
}

interface AdHocApprovalChallenge {
	kind: "ad_hoc";
	token: string;
	keyHash: string;
	draftId: string;
	expiresAtMs: number;
}

type ApprovalChallenge = ManagedApprovalChallenge | AdHocApprovalChallenge;

export interface WorkflowCommandContext {
	cwd: string;
	taskRef: string;
	allowIsolatedWrite: boolean;
	allowAdHoc: boolean;
	observeRun?: (handle: WorkflowRunHandle) => void;
	generateAdHocDescriptor?: (objective: string) => Promise<string>;
	generateManagedDescriptor?: (sop: string) => Promise<string>;
}

export interface WorkflowCommandServiceOptions {
	store: WorkflowStore;
	manager: WorkflowManager;
	discover?: (cwd: string) => Promise<WorkflowDiscoveryResult>;
	now?: () => Date;
	challengeIdFactory?: () => string;
	home?: string;
}

export interface WorkflowDeliveryReceipt {
	runId: string;
	deliveryId: string;
}

export interface WorkflowPreparedRunOutput {
	text: string;
	receipt?: WorkflowDeliveryReceipt;
}

export interface WorkflowPreparedCommandOutput {
	text: string;
	deliveryReceipts: WorkflowDeliveryReceipt[];
}

interface AdHocDraftDescriptor {
	draftId?: string;
	name?: string;
	description?: string;
	humanSummary: string;
	sourceText: string;
	args?: WorkflowJsonValue;
	expiresAt?: string;
}

function splitSubcommand(input: string): { verb: string; rest: string } {
	const trimmed = input.trim();
	if (!trimmed) return { verb: "list", rest: "" };
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { verb: trimmed.toLowerCase(), rest: "" };
	return {
		verb: trimmed.slice(0, separator).toLowerCase(),
		rest: trimmed.slice(separator + 1).trim(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, label: string, maxLength = WORKFLOW_MAX_SOURCE_BYTES): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	if (value.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character limit.`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, label);
}

function parseManagedRef(value: string): { name: string; version: string } {
	const separator = value.lastIndexOf("@");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error("Managed Workflow reference must use <name>@<version>.");
	}
	return { name: value.slice(0, separator), version: value.slice(separator + 1) };
}

function splitFirstToken(value: string): { token: string; rest: string } {
	const trimmed = value.trim();
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { token: trimmed, rest: "" };
	return { token: trimmed.slice(0, separator), rest: trimmed.slice(separator + 1).trim() };
}

function isScopeVisibleFrom(scopeKey: string, cwd: string): boolean {
	const relative = path.relative(path.resolve(scopeKey), path.resolve(cwd));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function scopeRank(scopeKey: string): number {
	return path.resolve(scopeKey).length;
}

function formatLimits(workflow: Pick<ManagedWorkflow, "meta"> | AdHocWorkflowDraft): string {
	const limits = "meta" in workflow ? workflow.meta.limits : workflow.limits;
	return `${limits.concurrency} concurrent · ${limits.agentLimit} agents · ${limits.tokenLimit.toLocaleString()} tokens · ${limits.durationMs.toLocaleString()} ms`;
}

function formatManagedPlan(meta: WorkflowMeta, sourceText: string): string[] {
	const summary = summarizeWorkflowSource(sourceText);
	const shownStages = summary.stages.slice(0, WORKFLOW_REVIEW_MAX_STAGES);
	const omittedStages = Math.max(0, summary.stages.length - shownStages.length);
	const stageParts = shownStages.length > 0 ? shownStages : ["default phase"];
	if (omittedStages > 0) stageParts.push(`+${omittedStages} more literal stages`);
	if (summary.dynamicStageCount > 0) {
		stageParts.push(`+${summary.dynamicStageCount} stage labels computed by the reviewed script`);
	}
	const shownSteps = summary.steps.slice(0, WORKFLOW_REVIEW_MAX_STAGES);
	const stepLines =
		shownSteps.length === 0
			? ["  Steps: no Agent calls; the reviewed script computes its result directly"]
			: [
					"  Steps:",
					...shownSteps.map(
						(step, index) =>
							`    ${index + 1}. [${step.phase}] ${truncateToWidth(step.instruction.replace(/\s+/g, " ").trim(), TRUNCATE_LENGTHS.LINE)}`,
					),
					...(summary.steps.length > shownSteps.length
						? [`    +${summary.steps.length - shownSteps.length} more Agent steps in the raw script`]
						: []),
				];
	const expectedOutput =
		meta.permissions.writeMode === "isolated_write"
			? "a JSON-compatible final result; any captured patch remains unapplied until separate human review"
			: "a JSON-compatible final result returned by the reviewed script";
	return [
		"Human-readable plan (derived from this exact script and the hard runtime policy):",
		`  Stages: ${stageParts.join(" -> ")}`,
		...stepLines,
		`  Maximum scale: ${meta.limits.agentLimit} Agent starts, ${meta.limits.concurrency} running concurrently`,
		`  Stop conditions: ${meta.limits.tokenLimit.toLocaleString()} tokens, ${meta.limits.durationMs.toLocaleString()} ms, user cancellation, node failure, or a permission violation`,
		`  Expected output: ${expectedOutput}`,
	];
}

/**
 * Explicit command application service shared by TUI and ACP dispatch. It has
 * no prompt-trigger path: every mutation and run begins at one of these verbs.
 */
export class WorkflowCommandService {
	#store: WorkflowStore;
	#manager: WorkflowManager;
	#discover: (cwd: string) => Promise<WorkflowDiscoveryResult>;
	#now: () => Date;
	#challengeIdFactory: () => string;
	#home: string;
	#challenges = new Map<string, ApprovalChallenge>();
	#deliveryReceipts = new AsyncLocalStorage<WorkflowDeliveryReceipt[]>();

	constructor(options: WorkflowCommandServiceOptions) {
		this.#store = options.store;
		this.#manager = options.manager;
		this.#discover = options.discover ?? (cwd => discoverWorkflowSources({ cwd }));
		this.#now = options.now ?? (() => new Date());
		this.#challengeIdFactory = options.challengeIdFactory ?? (() => crypto.randomUUID());
		this.#home = options.home ?? os.homedir();
	}

	async execute(input: string, context: WorkflowCommandContext): Promise<string> {
		const prepared = await this.prepareCommandOutput(input, context);
		this.acknowledgeDeliveryReceipts(prepared.deliveryReceipts);
		return prepared.text;
	}

	async prepareCommandOutput(input: string, context: WorkflowCommandContext): Promise<WorkflowPreparedCommandOutput> {
		const deliveryReceipts: WorkflowDeliveryReceipt[] = [];
		const text = await this.#deliveryReceipts.run(deliveryReceipts, () => this.#executeCommand(input, context));
		return { text, deliveryReceipts };
	}

	async #executeCommand(input: string, context: WorkflowCommandContext): Promise<string> {
		const { verb, rest } = splitSubcommand(input);
		this.#manager.cleanupExpiredAdHocDrafts(context.taskRef, path.resolve(context.cwd));
		if (
			["draft", "generate", "approve-draft", "revise-draft", "run-draft", "reject-draft"].includes(verb) &&
			!context.allowAdHoc
		) {
			throw new Error("Ad-hoc Workflows are disabled by san.workflows.adHocEnabled.");
		}
		switch (verb) {
			case "list":
				return this.#list(context);
			case "show":
				return this.#show(rest, context);
			case "publish":
				return this.#publish(rest, context);
			case "draft-managed":
				return this.#draftManaged(rest, context);
			case "approve":
				return this.#approveManaged(rest, context);
			case "revoke":
				return this.#revoke(rest, context);
			case "run":
				return this.#runManaged(rest, context);
			case "draft":
				return this.#createAdHocDraft(rest, context);
			case "generate":
				return this.#generateAdHocDraft(rest, context);
			case "approve-draft":
				return this.#approveAdHoc(rest, context);
			case "revise-draft":
				return this.#reviseAdHoc(rest, context);
			case "run-draft":
				return this.#runAdHoc(rest, context);
			case "reject-draft":
				return this.#rejectAdHoc(rest, context);
			case "review-write":
				return this.#reviewWrite(rest);
			case "apply-write":
				return this.#applyWrite(rest);
			case "reject-write":
				return this.#rejectWrite(rest);
			case "status":
				return this.#status(rest);
			case "pause":
				return this.#control("pause", rest);
			case "resume":
				return this.#control("resume", rest);
			case "cancel":
				return this.#control("cancel", rest);
			case "cancel-node":
				return this.#cancelNode(rest);
			case "help":
				return WORKFLOW_COMMAND_USAGE;
			default:
				throw new Error(`Unknown Workflow subcommand ${verb}.\n${WORKFLOW_COMMAND_USAGE}`);
		}
	}

	prepareCompletedRunDelivery(runId: string): WorkflowPreparedRunOutput {
		const run = this.#manager.getRun(runId);
		if (!run) throw new Error(`Workflow run ${runId} does not exist in this session.`);
		if (run.status !== "completed") return { text: this.#formatTerminalRun(run) };
		const unresolved = run.writeArtifacts.filter(
			artifact => artifact.status !== "applied" && artifact.status !== "rejected",
		);
		if (unresolved.length > 0) {
			return {
				text: this.#sanitize(
					[
						`Workflow ${run.runId} completed its Agent phases, but isolated changes still require a decision.`,
						...unresolved.map(
							artifact =>
								`  ${artifact.artifactId} · ${artifact.status} · /workflow review-write ${artifact.artifactId}`,
						),
					].join("\n"),
				),
			};
		}
		const delivery = this.#manager.prepareResultDelivery(runId);
		return {
			text: this.#sanitize(
				[`Workflow ${run.runId} completed.`, "Result:", JSON.stringify(delivery.result, null, 2)].join("\n"),
			),
			receipt: { runId, deliveryId: delivery.deliveryId },
		};
	}

	acknowledgeDeliveryReceipt(receipt: WorkflowDeliveryReceipt): void {
		this.#manager.acknowledgeResultDelivery(receipt.runId, receipt.deliveryId);
	}

	acknowledgeDeliveryReceipts(receipts: readonly WorkflowDeliveryReceipt[]): void {
		for (const receipt of receipts) this.acknowledgeDeliveryReceipt(receipt);
	}

	#renderCompletedRun(runId: string): string {
		const prepared = this.prepareCompletedRunDelivery(runId);
		if (prepared.receipt) this.#deliveryReceipts.getStore()?.push(prepared.receipt);
		return prepared.text;
	}

	async #list(context: WorkflowCommandContext): Promise<string> {
		const discovery = await this.#discover(context.cwd);
		const lines = ["Managed SOP Workflows:"];
		if (discovery.items.length === 0) lines.push("  (none discovered)");
		for (const source of discovery.items) {
			try {
				const workflow = parseManagedWorkflow(source);
				const published = this.#store.getManagedVersion(
					workflow.meta.name,
					workflow.meta.version,
					workflow.source.scopeKey,
				);
				const approved = published ? this.#store.findManagedApproval(published.workflow) : undefined;
				const state = published ? (approved ? "approved" : "published, approval required") : "not published";
				lines.push(
					`  ${workflow.meta.name}@${workflow.meta.version} · ${state} · ${workflow.meta.permissions.writeMode}`,
				);
			} catch (error) {
				lines.push(`  ${source.name} · invalid: ${this.#error(error)}`);
			}
		}
		if (context.allowAdHoc) {
			const scopeKey = path.resolve(context.cwd);
			const drafts = this.#store.listAdHocDrafts({ taskRef: context.taskRef, scopeKey, limit: 20 });
			lines.push("", "Ad-hoc Workflow drafts:");
			if (drafts.length === 0) lines.push("  (none)");
			for (const draft of drafts) {
				lines.push(`  ${draft.draftId} · ${draft.name} · ${draft.status} · expires ${draft.expiresAt}`);
			}
		}
		if (discovery.warnings.length > 0) {
			lines.push("", "Discovery warnings:", ...discovery.warnings.map(warning => `  ${warning}`));
		}
		return this.#sanitize(lines.join("\n"));
	}

	async #show(target: string, context: WorkflowCommandContext): Promise<string> {
		if (!target) throw new Error("Usage: /workflow show <name|name@version|draft-id>");
		const draft = this.#store.getAdHocDraft(target);
		if (draft) {
			if (draft.taskRef !== context.taskRef || draft.scopeKey !== path.resolve(context.cwd)) {
				throw new Error(`Ad-hoc Workflow draft ${target} does not exist in the current task and scope.`);
			}
			return this.#formatAdHocDraft(draft);
		}

		if (target.includes("@")) {
			const ref = parseManagedRef(target);
			const version = this.#findManagedVersion(ref.name, ref.version, context.cwd);
			if (!version) throw new Error(`Managed Workflow ${target} is not published in the current scope.`);
			return this.#formatManagedWorkflow(version.workflow, `Published ${version.publishedAt}`);
		}

		const discovery = await this.#discover(context.cwd);
		const source = discovery.items.find(item => item.name === target);
		if (!source) throw new Error(`Workflow ${target} is not discoverable from the current directory.`);
		return this.#formatManagedWorkflow(parseManagedWorkflow(source), "Discovered, not necessarily published");
	}

	async #publish(name: string, context: WorkflowCommandContext): Promise<string> {
		if (!name) throw new Error("Usage: /workflow publish <discovered-name>");
		const discovery = await this.#discover(context.cwd);
		const source = discovery.items.find(item => item.name === name);
		if (!source) throw new Error(`Workflow ${name} is not discoverable from the current directory.`);
		const workflow = parseManagedWorkflow(source);
		this.#assertWriteAllowed(workflow.meta.permissions.writeMode, context);
		const published = this.#manager.publishManagedVersion(workflow);
		return [
			this.#formatManagedWorkflow(published.workflow, `Published ${published.publishedAt}; not yet approved`),
			"",
			`Next: /workflow approve ${workflow.meta.name}@${workflow.meta.version}`,
		].join("\n");
	}

	async #draftManaged(sop: string, context: WorkflowCommandContext): Promise<string> {
		if (!sop.trim()) throw new Error("Usage: /workflow draft-managed <existing SOP text>");
		if (!context.generateManagedDescriptor) {
			throw new Error("Managed Workflow SOP conversion is unavailable in this session.");
		}
		const descriptorText = await context.generateManagedDescriptor(sop.trim());
		if (!descriptorText.trimStart().startsWith("{")) {
			throw new Error("Managed Workflow generator returned a non-JSON draft.");
		}
		const descriptor = this.#parseJson(descriptorText, "Managed Workflow draft");
		if (!isRecord(descriptor) || Object.keys(descriptor).some(key => key !== "sourceText")) {
			throw new Error("Managed Workflow draft must contain only sourceText.");
		}
		const sourceText = requiredString(descriptor.sourceText, "Managed Workflow sourceText");
		const parsed = parseWorkflowSource(sourceText);
		if (parsed.violations.length > 0) {
			throw new Error(`Managed Workflow source is unsafe: ${parsed.violations.join("; ")}`);
		}
		this.#assertWriteAllowed(parsed.meta.permissions.writeMode, context);
		return this.#sanitizeReview(
			[
				`Managed SOP draft: ${parsed.meta.name}@${parsed.meta.version}`,
				`Purpose: ${parsed.meta.description}`,
				...formatManagedPlan(parsed.meta, sourceText),
				`Permissions: ${parsed.meta.permissions.writeMode} · tools ${parsed.meta.permissions.tools.join(", ") || "none"}`,
				`Limits: ${formatLimits({ meta: parsed.meta })}`,
				"No file was saved, no version was published, no approval was recorded, and no Agent started.",
				"",
				`Save this exact script as .san/workflows/${parsed.meta.name}.js, then run /workflow publish ${parsed.meta.name}.`,
				"",
				"Raw script (long lines are wrapped, never truncated; tabs are displayed as spaces):",
				sourceText,
			].join("\n"),
		);
	}

	#approveManaged(target: string, context: WorkflowCommandContext): string {
		if (!target) throw new Error("Usage: /workflow approve <name@version|confirmation-token>");
		if (target.startsWith(APPROVAL_TOKEN_PREFIX)) {
			const challenge = this.#consumeManagedChallenge(target);
			if (!isScopeVisibleFrom(challenge.scopeKey, context.cwd)) {
				throw new Error("The Managed Workflow confirmation belongs to a different execution scope.");
			}
			const version = this.#store.getManagedVersion(challenge.name, challenge.version, challenge.scopeKey);
			if (!version || version.revokedAt)
				throw new Error("The Managed Workflow changed or was revoked after review.");
			const keyHash = hashWorkflowApprovalKey(createManagedApprovalKey(version.workflow));
			if (keyHash !== challenge.keyHash) throw new Error("The Managed Workflow boundaries changed after review.");
			this.#assertWriteAllowed(version.workflow.meta.permissions.writeMode, context);
			const approval = this.#manager.approveManagedVersion(version.workflow);
			return this.#formatApproval(
				approval,
				"Managed Workflow approved. It still runs only through an explicit command.",
			);
		}

		const ref = parseManagedRef(target);
		const version = this.#findManagedVersion(ref.name, ref.version, context.cwd);
		if (!version || version.revokedAt)
			throw new Error(`Managed Workflow ${target} is not an active published version.`);
		this.#assertWriteAllowed(version.workflow.meta.permissions.writeMode, context);
		const keyHash = hashWorkflowApprovalKey(createManagedApprovalKey(version.workflow));
		const token = this.#issueManagedChallenge({
			keyHash,
			name: version.workflow.meta.name,
			version: version.workflow.meta.version,
			scopeKey: version.workflow.source.scopeKey,
		});
		return [
			this.#formatManagedWorkflow(
				version.workflow,
				"Approval review; no approval has been recorded by this command",
			),
			"",
			`Approval boundary: ${keyHash}`,
			`Confirmation expires in 10 minutes: /workflow approve ${token}`,
		].join("\n");
	}

	#revoke(target: string, context: WorkflowCommandContext): string {
		if (!target) throw new Error("Usage: /workflow revoke <name@version>");
		const ref = parseManagedRef(target);
		const version = this.#findManagedVersion(ref.name, ref.version, context.cwd, true);
		if (!version) throw new Error(`Managed Workflow ${target} is not published in the current scope.`);
		const revoked = this.#manager.revokeManagedVersion(version.workflow);
		return revoked ? `Revoked Managed Workflow ${target}.` : `Managed Workflow ${target} was already revoked.`;
	}

	#runManaged(input: string, context: WorkflowCommandContext): string {
		const { token: target, rest } = splitFirstToken(input);
		if (!target) throw new Error("Usage: /workflow run <name@version> [JSON args]");
		const ref = parseManagedRef(target);
		const version = this.#findManagedVersion(ref.name, ref.version, context.cwd);
		if (!version) throw new Error(`Managed Workflow ${target} is not an active published version.`);
		this.#assertWriteAllowed(version.workflow.meta.permissions.writeMode, context);
		const args = rest ? this.#parseJsonValue(rest, "Workflow arguments") : undefined;
		const handle = this.#manager.startManaged({
			name: ref.name,
			version: ref.version,
			scopeKey: version.workflow.source.scopeKey,
			args,
		});
		context.observeRun?.(handle);
		return `Started Managed Workflow ${target} as ${handle.runId}. Use /workflow status ${handle.runId} to inspect it.`;
	}

	async #createAdHocDraft(input: string, context: WorkflowCommandContext): Promise<string> {
		if (!input) throw new Error("Usage: /workflow draft <JSON descriptor or project-relative .json path>");
		const descriptor = await this.#loadDraftDescriptor(input, context.cwd);
		const saved = this.#manager.saveAdHocDraft(this.#buildAdHocDraft(descriptor, context));
		return [
			this.#formatAdHocDraft(saved),
			"",
			`No agent has started. Review again with /workflow approve-draft ${saved.draftId}, revise it with /workflow revise-draft ${saved.draftId} <descriptor>, or reject it with /workflow reject-draft ${saved.draftId}.`,
		].join("\n");
	}

	#buildAdHocDraft(descriptor: AdHocDraftDescriptor, context: WorkflowCommandContext): AdHocWorkflowDraft {
		const parsed = parseWorkflowSource(descriptor.sourceText);
		if (parsed.violations.length > 0)
			throw new Error(`Ad-hoc Workflow source is unsafe: ${parsed.violations.join("; ")}`);
		if (descriptor.name !== undefined && descriptor.name !== parsed.meta.name) {
			throw new Error("Ad-hoc descriptor name does not match the script metadata.");
		}
		if (descriptor.description !== undefined && descriptor.description !== parsed.meta.description) {
			throw new Error("Ad-hoc descriptor description does not match the script metadata.");
		}
		this.#assertWriteAllowed(parsed.meta.permissions.writeMode, context);
		const now = this.#validNow();
		const expiresAt = descriptor.expiresAt
			? this.#canonicalFutureTimestamp(descriptor.expiresAt, now)
			: new Date(now.getTime() + AD_HOC_DEFAULT_TTL_MS).toISOString();
		const draftId = descriptor.draftId ?? `ad-hoc-${this.#challengeIdFactory()}`;
		if (!AD_HOC_DRAFT_ID.test(draftId)) {
			throw new Error("Ad-hoc draftId must contain only letters, numbers, underscores and hyphens.");
		}
		return {
			kind: "ad_hoc",
			draftId,
			taskRef: context.taskRef,
			name: parsed.meta.name,
			description: parsed.meta.description,
			humanSummary: descriptor.humanSummary,
			sourceText: descriptor.sourceText,
			sourceHash: workflowSourceHash(descriptor.sourceText),
			...(descriptor.args !== undefined ? { args: descriptor.args } : {}),
			argsHash: workflowValueHash(descriptor.args ?? null),
			...(parsed.meta.argsSchema ? { argsSchema: parsed.meta.argsSchema } : {}),
			argsSchemaHash: workflowValueHash(parsed.meta.argsSchema ?? null),
			permissions: parsed.meta.permissions,
			permissionManifestHash: workflowValueHash(parsed.meta.permissions),
			limits: parsed.meta.limits,
			scopeKey: path.resolve(context.cwd),
			createdAt: now.toISOString(),
			expiresAt,
			status: "draft",
		};
	}

	async #generateAdHocDraft(objective: string, context: WorkflowCommandContext): Promise<string> {
		if (!objective.trim()) throw new Error("Usage: /workflow generate <plain-language one-time task>");
		if (!context.generateAdHocDescriptor) {
			throw new Error("Ad-hoc Workflow model generation is unavailable in this session.");
		}
		const descriptor = await context.generateAdHocDescriptor(objective.trim());
		if (!descriptor.trimStart().startsWith("{")) {
			throw new Error("Ad-hoc Workflow generator returned a non-JSON draft.");
		}
		return this.#createAdHocDraft(descriptor, context);
	}

	async #reviseAdHoc(input: string, context: WorkflowCommandContext): Promise<string> {
		const { token: originalDraftId, rest } = splitFirstToken(input);
		if (!originalDraftId || !rest) {
			throw new Error("Usage: /workflow revise-draft <draft-id> <JSON descriptor or project-relative .json path>");
		}
		const original = this.#store.getAdHocDraft(originalDraftId);
		if (!original) throw new Error(`Ad-hoc Workflow draft ${originalDraftId} does not exist.`);
		if (original.status !== "draft" && original.status !== "approved") {
			throw new Error(`Ad-hoc Workflow draft ${originalDraftId} cannot be revised from ${original.status}.`);
		}
		if (original.taskRef !== context.taskRef || original.scopeKey !== path.resolve(context.cwd)) {
			throw new Error("The Ad-hoc Workflow draft belongs to a different task or scope.");
		}

		const descriptor = await this.#loadDraftDescriptor(rest, context.cwd);
		if (descriptor.draftId === originalDraftId) {
			throw new Error("A revised Ad-hoc Workflow must use a new draftId and a new approval boundary.");
		}
		const revisedDraft = this.#buildAdHocDraft(descriptor, context);
		if (revisedDraft.draftId === originalDraftId) {
			throw new Error("A revised Ad-hoc Workflow must use a new draftId and a new approval boundary.");
		}
		if (this.#store.getAdHocDraft(revisedDraft.draftId)) {
			throw new Error(`Ad-hoc Workflow draft ${revisedDraft.draftId} already exists.`);
		}
		// Fail closed: invalidate the broad/old boundary before making the replacement visible.
		this.#manager.rejectAdHocDraft(originalDraftId, revisedDraft.draftId);
		const revised = this.#manager.saveAdHocDraft(revisedDraft);
		return [
			`Revised Ad-hoc Workflow ${originalDraftId} as ${revised.draftId}.`,
			"The old draft, confirmation tokens, and any old one-time approval are invalid. No Agent started.",
			"",
			this.#formatAdHocDraft(revised),
			"",
			`Review the modified boundaries with /workflow approve-draft ${revised.draftId}.`,
		].join("\n");
	}

	#approveAdHoc(target: string, context: WorkflowCommandContext): string {
		if (!target) throw new Error("Usage: /workflow approve-draft <draft-id|confirmation-token>");
		if (target.startsWith(APPROVAL_TOKEN_PREFIX)) {
			const challenge = this.#consumeAdHocChallenge(target);
			const draft = this.#store.getAdHocDraft(challenge.draftId);
			if (draft?.status !== "draft") throw new Error("The Ad-hoc Workflow draft is no longer approvable.");
			const keyHash = hashWorkflowApprovalKey(createAdHocApprovalKey(draft));
			if (keyHash !== challenge.keyHash) throw new Error("The Ad-hoc Workflow boundaries changed after review.");
			if (draft.taskRef !== context.taskRef || draft.scopeKey !== path.resolve(context.cwd)) {
				throw new Error("The Ad-hoc Workflow approval belongs to a different task or scope.");
			}
			this.#assertWriteAllowed(draft.permissions.writeMode, context);
			const approval = this.#manager.approveAdHocDraft(draft);
			return this.#formatApproval(
				approval,
				`Ad-hoc Workflow ${draft.draftId} approved for one run only. Start it explicitly with /workflow run-draft ${draft.draftId}.`,
			);
		}

		const draft = this.#store.getAdHocDraft(target);
		if (!draft) throw new Error(`Ad-hoc Workflow draft ${target} does not exist.`);
		if (draft.status !== "draft") throw new Error(`Ad-hoc Workflow draft ${target} is ${draft.status}, not draft.`);
		if (draft.taskRef !== context.taskRef || draft.scopeKey !== path.resolve(context.cwd)) {
			throw new Error("The Ad-hoc Workflow draft belongs to a different task or scope.");
		}
		this.#assertWriteAllowed(draft.permissions.writeMode, context);
		const keyHash = hashWorkflowApprovalKey(createAdHocApprovalKey(draft));
		const token = this.#issueAdHocChallenge({ keyHash, draftId: draft.draftId });
		return [
			this.#formatAdHocDraft(draft),
			"",
			`Approval boundary: ${keyHash}`,
			`Confirmation expires in 10 minutes: /workflow approve-draft ${token}`,
		].join("\n");
	}

	#runAdHoc(draftId: string, context: WorkflowCommandContext): string {
		if (!draftId) throw new Error("Usage: /workflow run-draft <draft-id>");
		const draft = this.#store.getAdHocDraft(draftId);
		if (!draft) throw new Error(`Ad-hoc Workflow draft ${draftId} does not exist.`);
		if (draft.taskRef !== context.taskRef || draft.scopeKey !== path.resolve(context.cwd)) {
			throw new Error("The Ad-hoc Workflow draft belongs to a different task or scope.");
		}
		this.#assertWriteAllowed(draft.permissions.writeMode, context);
		const approval = this.#store.findAdHocApproval(draft, this.#validNow());
		if (!approval) throw new Error(`Ad-hoc Workflow draft ${draftId} has no valid one-time approval.`);
		const handle = this.#manager.startAdHoc({
			draftId,
			approvalId: approval.approvalId,
			taskRef: context.taskRef,
			scopeKey: path.resolve(context.cwd),
		});
		context.observeRun?.(handle);
		return `Started one-time Ad-hoc Workflow ${draftId} as ${handle.runId}. Its approval is now consumed.`;
	}

	#rejectAdHoc(draftId: string, context: WorkflowCommandContext): string {
		if (!draftId) throw new Error("Usage: /workflow reject-draft <draft-id>");
		const draft = this.#store.getAdHocDraft(draftId);
		if (!draft) throw new Error(`Ad-hoc Workflow draft ${draftId} does not exist.`);
		if (draft.taskRef !== context.taskRef || draft.scopeKey !== path.resolve(context.cwd)) {
			throw new Error("The Ad-hoc Workflow draft belongs to a different task or scope.");
		}
		const rejected = this.#manager.rejectAdHocDraft(draftId);
		return `Rejected Ad-hoc Workflow draft ${rejected.draftId}.`;
	}

	async #reviewWrite(input: string): Promise<string> {
		const [artifactId, extra] = input.trim().split(/\s+/);
		if (!artifactId || extra) {
			throw new Error("Usage: /workflow review-write <artifact-id>");
		}
		const review = await this.#manager.reviewWriteArtifact(artifactId);
		return this.#sanitizeReview(
			[
				`Workflow isolated patch: ${review.artifactId}`,
				`Patch hash: ${review.patchHash}`,
				`Baseline hash: ${review.baselineHash}`,
				`Size: ${review.byteLength.toLocaleString()} bytes`,
				"No change has been applied.",
				"",
				"Complete patch (long lines are wrapped, never truncated; tabs are displayed as spaces):",
				review.patchText,
				"",
				`Apply exactly this review: /workflow apply-write ${review.reviewToken}`,
				`Reject it: /workflow reject-write ${artifactId}`,
			].join("\n"),
		);
	}

	async #applyWrite(input: string): Promise<string> {
		const [reviewToken, extra] = input.trim().split(/\s+/);
		if (!reviewToken || extra) {
			throw new Error("Usage: /workflow apply-write <review-token>");
		}
		const applied = await this.#manager.applyWriteArtifact(reviewToken);
		const lines = [`Applied Workflow patch ${applied.artifact.artifactId} exactly once.`];
		const run = this.#manager.getRun(applied.runId);
		if (
			run?.status === "completed" &&
			run.writeArtifacts.every(artifact => artifact.status === "applied" || artifact.status === "rejected")
		) {
			lines.push("", this.#renderCompletedRun(applied.runId));
		}
		return this.#sanitize(lines.join("\n"));
	}

	#rejectWrite(input: string): string {
		const [artifactId, extra] = input.trim().split(/\s+/);
		if (!artifactId || extra) {
			throw new Error("Usage: /workflow reject-write <artifact-id>");
		}
		const rejected = this.#manager.rejectWriteArtifact(artifactId);
		const lines = [`Rejected Workflow patch ${rejected.artifact.artifactId}; no change was applied.`];
		const run = this.#manager.getRun(rejected.runId);
		if (
			run?.status === "completed" &&
			run.writeArtifacts.every(artifact => artifact.status === "applied" || artifact.status === "rejected")
		) {
			lines.push("", this.#renderCompletedRun(rejected.runId));
		}
		return this.#sanitize(lines.join("\n"));
	}

	#status(runId: string): string {
		if (runId) {
			const run = this.#manager.getRun(runId);
			if (!run) throw new Error(`Workflow run ${runId} does not exist in this session.`);
			return this.#formatRun(run);
		}
		const runs = this.#manager.listRuns();
		if (runs.length === 0) return "No Workflow runs exist in this session.";
		return this.#sanitize(runs.map(run => this.#formatRun(run)).join("\n\n"));
	}

	#control(action: "pause" | "resume" | "cancel", runId: string): string {
		if (!runId) throw new Error(`Usage: /workflow ${action} <run-id>`);
		const changed = this.#manager[action](runId);
		if (!changed) {
			const run = this.#manager.getRun(runId);
			return run
				? `Workflow ${runId} cannot ${action} from status ${run.status}.`
				: `Workflow run ${runId} does not exist in this session.`;
		}
		return `Workflow ${runId} ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`;
	}

	#cancelNode(input: string): string {
		const [runId, nodeId, extra] = input.trim().split(/\s+/);
		if (!runId || !nodeId || extra) throw new Error("Usage: /workflow cancel-node <run-id> <node-id>");
		if (!this.#manager.cancelNode(runId, nodeId)) {
			throw new Error(`Workflow Agent ${nodeId} is not actively running in ${runId}.`);
		}
		return `Cancelled Workflow Agent ${nodeId} in ${runId}; the run will settle without reporting completion.`;
	}

	#findManagedVersion(
		name: string,
		version: string,
		cwd: string,
		includeRevoked = false,
	): ManagedWorkflowVersionRecord | undefined {
		return this.#store
			.listManagedVersions({ name, includeRevoked, limit: 500 })
			.filter(
				record =>
					record.workflow.meta.version === version && isScopeVisibleFrom(record.workflow.source.scopeKey, cwd),
			)
			.sort(
				(left, right) => scopeRank(right.workflow.source.scopeKey) - scopeRank(left.workflow.source.scopeKey),
			)[0];
	}

	#issueManagedChallenge(input: Omit<ManagedApprovalChallenge, "kind" | "token" | "expiresAtMs">): string {
		return this.#issueChallenge({ ...input, kind: "managed" });
	}

	#issueAdHocChallenge(input: Omit<AdHocApprovalChallenge, "kind" | "token" | "expiresAtMs">): string {
		return this.#issueChallenge({ ...input, kind: "ad_hoc" });
	}

	#issueChallenge(
		input:
			| Omit<ManagedApprovalChallenge, "token" | "expiresAtMs">
			| Omit<AdHocApprovalChallenge, "token" | "expiresAtMs">,
	): string {
		const token = `${APPROVAL_TOKEN_PREFIX}${this.#challengeIdFactory()}`;
		const challenge: ApprovalChallenge = {
			...input,
			token,
			expiresAtMs: this.#validNow().getTime() + APPROVAL_CHALLENGE_TTL_MS,
		};
		this.#challenges.set(token, challenge);
		return token;
	}

	#consumeManagedChallenge(token: string): ManagedApprovalChallenge {
		const challenge = this.#consumeChallenge(token);
		if (challenge.kind !== "managed") throw new Error("Workflow approval confirmation has the wrong kind.");
		return challenge;
	}

	#consumeAdHocChallenge(token: string): AdHocApprovalChallenge {
		const challenge = this.#consumeChallenge(token);
		if (challenge.kind !== "ad_hoc") throw new Error("Workflow approval confirmation has the wrong kind.");
		return challenge;
	}

	#consumeChallenge(token: string): ApprovalChallenge {
		const challenge = this.#challenges.get(token);
		this.#challenges.delete(token);
		if (!challenge) throw new Error("Workflow approval confirmation is invalid or already used.");
		if (challenge.expiresAtMs <= this.#validNow().getTime()) {
			throw new Error("Workflow approval confirmation has expired; review the exact boundaries again.");
		}
		return challenge;
	}

	async #loadDraftDescriptor(input: string, cwd: string): Promise<AdHocDraftDescriptor> {
		let value: unknown;
		if (input.trimStart().startsWith("{")) {
			if (input.length > WORKFLOW_MAX_DESCRIPTOR_BYTES) {
				throw new Error(`Ad-hoc Workflow descriptor exceeds ${WORKFLOW_MAX_DESCRIPTOR_BYTES} characters.`);
			}
			value = this.#parseJson(input, "Ad-hoc Workflow descriptor");
		} else {
			const descriptorPath = path.resolve(cwd, input);
			try {
				const [canonicalCwd, canonicalPath] = await Promise.all([fs.realpath(cwd), fs.realpath(descriptorPath)]);
				const relative = path.relative(canonicalCwd, canonicalPath);
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
					throw new Error("Ad-hoc Workflow descriptor must resolve inside the current project scope.");
				}
				const stat = await fs.stat(canonicalPath);
				if (!stat.isFile()) throw new Error("Ad-hoc Workflow descriptor must be a regular file.");
				if (stat.size > WORKFLOW_MAX_DESCRIPTOR_BYTES) {
					throw new Error(`Ad-hoc Workflow descriptor exceeds ${WORKFLOW_MAX_DESCRIPTOR_BYTES} bytes.`);
				}
				value = await Bun.file(canonicalPath).json();
			} catch (error) {
				throw new Error(
					`Cannot read Ad-hoc Workflow descriptor ${shortenPath(descriptorPath, this.#home)}: ${this.#error(error)}`,
				);
			}
		}
		if (!isRecord(value)) throw new Error("Ad-hoc Workflow descriptor must be a JSON object.");
		const allowedKeys = new Set([
			"draftId",
			"name",
			"description",
			"humanSummary",
			"sourceText",
			"args",
			"expiresAt",
		]);
		const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key));
		if (unknownKeys.length > 0) {
			throw new Error(`Ad-hoc Workflow descriptor contains unsupported keys: ${unknownKeys.sort().join(", ")}.`);
		}
		const draftId = optionalString(value.draftId, "Ad-hoc Workflow draftId");
		const name = optionalString(value.name, "Ad-hoc Workflow name");
		const description = optionalString(value.description, "Ad-hoc Workflow description");
		const humanSummary = requiredString(
			value.humanSummary,
			"Ad-hoc Workflow humanSummary",
			WORKFLOW_MAX_HUMAN_SUMMARY_LENGTH,
		);
		const summarySections = new Set(
			[...humanSummary.matchAll(AD_HOC_SUMMARY_SECTION)].map(match =>
				match[0].trim().split(/\s*:/)[0]?.toLowerCase(),
			),
		);
		const hasStage = [...summarySections].some(
			section => section === "stage" || section === "stages" || section === "step" || section === "steps",
		);
		const hasStop = [...summarySections].some(section => section?.startsWith("stop"));
		const hasOutput = [...summarySections].some(section => section?.startsWith("expected"));
		if (!hasStage || !hasStop || !hasOutput) {
			throw new Error(
				"Ad-hoc Workflow humanSummary must include labeled Stages, Stop conditions, and Expected output sections.",
			);
		}
		const sourceText = requiredString(value.sourceText, "Ad-hoc Workflow sourceText");
		const expiresAt = optionalString(value.expiresAt, "Ad-hoc Workflow expiresAt");
		if (value.args !== undefined && !isWorkflowJsonValue(value.args)) {
			throw new Error("Ad-hoc Workflow args must be JSON-compatible.");
		}
		return {
			...(draftId ? { draftId } : {}),
			...(name ? { name } : {}),
			...(description ? { description } : {}),
			humanSummary,
			sourceText,
			...(value.args !== undefined ? { args: value.args } : {}),
			...(expiresAt ? { expiresAt } : {}),
		};
	}

	#parseJson(input: string, label: string): unknown {
		try {
			return JSON.parse(input);
		} catch (error) {
			throw new Error(`${label} contains invalid JSON: ${this.#error(error)}`);
		}
	}

	#parseJsonValue(input: string, label: string): WorkflowJsonValue {
		const value = this.#parseJson(input, label);
		if (!isWorkflowJsonValue(value)) throw new Error(`${label} must be JSON-compatible.`);
		return value;
	}

	#canonicalFutureTimestamp(value: string, now: Date): string {
		const time = Date.parse(value);
		if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
			throw new Error("Ad-hoc Workflow expiresAt must be a canonical ISO timestamp.");
		}
		if (time <= now.getTime()) throw new Error("Ad-hoc Workflow expiresAt must be in the future.");
		if (time - now.getTime() > AD_HOC_MAX_TTL_MS) {
			throw new Error("Ad-hoc Workflow expiresAt must be within 24 hours.");
		}
		return value;
	}

	#assertWriteAllowed(
		writeMode: ManagedWorkflow["meta"]["permissions"]["writeMode"],
		context: WorkflowCommandContext,
	): void {
		if (writeMode === "isolated_write" && !context.allowIsolatedWrite) {
			throw new Error("This Workflow requests isolated writes, but san.workflows.allowIsolatedWrite is disabled.");
		}
	}

	#formatManagedWorkflow(workflow: ManagedWorkflow, state: string): string {
		const approvalKeyHash = hashWorkflowApprovalKey(createManagedApprovalKey(workflow));
		return this.#sanitizeReview(
			[
				`Managed SOP Workflow: ${workflow.meta.name}@${workflow.meta.version}`,
				`State: ${state}`,
				`Purpose: ${workflow.meta.description}`,
				...formatManagedPlan(workflow.meta, workflow.sourceText),
				`Scope: ${shortenPath(workflow.source.scopeKey, this.#home)}`,
				`Source: ${workflow.source.path ? shortenPath(workflow.source.path, this.#home) : "stored session source"}`,
				`Permissions: ${workflow.meta.permissions.writeMode} · tools ${workflow.meta.permissions.tools.join(", ") || "none"}`,
				`Limits: ${formatLimits(workflow)}`,
				`Source hash: ${workflow.sourceHash}`,
				`Approval boundary: ${approvalKeyHash}`,
				"",
				"Raw script (long lines are wrapped, never truncated; tabs are displayed as spaces):",
				workflow.sourceText,
			].join("\n"),
		);
	}

	#formatAdHocDraft(draft: AdHocWorkflowDraft): string {
		const approvalKeyHash = hashWorkflowApprovalKey(createAdHocApprovalKey(draft));
		return this.#sanitizeReview(
			[
				`Ad-hoc Workflow draft: ${draft.draftId}`,
				`Name: ${draft.name}`,
				`Status: ${draft.status}`,
				`Purpose: ${draft.description}`,
				`Human-readable steps: ${draft.humanSummary}`,
				`Current task: ${draft.taskRef}`,
				`Scope: ${shortenPath(draft.scopeKey, this.#home)}`,
				`Permissions: ${draft.permissions.writeMode} · tools ${draft.permissions.tools.join(", ") || "none"}`,
				`Limits: ${formatLimits(draft)}`,
				`Expires: ${draft.expiresAt}`,
				`Source hash: ${draft.sourceHash}`,
				"Approved arguments:",
				JSON.stringify(draft.args ?? null, null, 2),
				`Args hash: ${draft.argsHash}`,
				`Approval boundary: ${approvalKeyHash}`,
				"",
				"Raw script (long lines are wrapped, never truncated; tabs are displayed as spaces):",
				draft.sourceText,
			].join("\n"),
		);
	}

	#formatApproval(approval: WorkflowApprovalRecord, heading: string): string {
		return [heading, `Approval: ${approval.approvalId}`, `Exact boundary: ${approval.keyHash}`].join("\n");
	}

	#formatRun(run: WorkflowRun): string {
		return this.#sanitize(
			[
				`${run.runId} · ${run.workflowKind} · ${run.workflowName}${run.workflowVersion ? `@${run.workflowVersion}` : ""}`,
				`Status: ${run.status} · phase ${run.currentPhase} · delivery ${run.deliveryState}`,
				`Budget: ${run.budget.agentsCompleted}/${run.budget.agentsStarted} agents · ${run.budget.tokensUsed.toLocaleString()}/${run.budget.limits.tokenLimit.toLocaleString()} tokens · ${run.budget.elapsedMs.toLocaleString()}/${run.budget.limits.durationMs.toLocaleString()} ms`,
				`Nodes: ${run.nodes.length}`,
				...run.nodes.map(
					node =>
						`  ${node.nodeId} · ${node.status} · phase ${node.phase}${node.agentRef ? ` · ${node.agentRef}` : ""}`,
				),
				...(run.writeArtifacts.length > 0
					? [
							"Write artifacts:",
							...run.writeArtifacts.map(
								artifact =>
									`  ${artifact.artifactId} · ${artifact.status} · ${artifact.byteLength.toLocaleString()} bytes`,
							),
						]
					: []),
				...(run.error ? [`Error: ${run.error}`] : []),
			].join("\n"),
		);
	}

	#formatTerminalRun(run: WorkflowRun): string {
		return this.#sanitize(
			`Workflow ${run.runId} finished with status ${run.status}.${run.error ? `\nReason: ${run.error}` : ""}`,
		);
	}

	#sanitize(value: string): string {
		const safe = sanitizeText(value);
		const homeSafe = this.#home ? safe.replaceAll(this.#home, "~") : safe;
		return replaceTabs(homeSafe)
			.split("\n")
			.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE))
			.join("\n");
	}

	#sanitizeReview(value: string): string {
		const safe = sanitizeText(value);
		const homeSafe = this.#home ? safe.replaceAll(this.#home, "~") : safe;
		return replaceTabs(homeSafe)
			.split("\n")
			.map(line =>
				line.length === 0
					? ""
					: Bun.wrapAnsi(line, TRUNCATE_LENGTHS.LINE, { hard: true, wordWrap: false, trim: false }),
			)
			.join("\n");
	}

	#error(error: unknown): string {
		return this.#sanitize(error instanceof Error ? error.message : String(error));
	}

	#validNow(): Date {
		const now = this.#now();
		if (!Number.isFinite(now.getTime())) throw new Error("Workflow command clock returned an invalid time.");
		return now;
	}
}
