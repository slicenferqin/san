import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@san/utils";
import { getManagedSkillsDir, writeManagedSkill } from "../autolearn/managed-skills";
import { normalizeContextSteadyRecallItems } from "../context-steady/recall";
import { TURN_DIGEST_CUSTOM_TYPE, TURN_DIGEST_SCHEMA_VERSION, type TurnDigest } from "../context-steady/types";
import type { MemoryBackend } from "../memory-backend/types";
import { SessionManager } from "../session/session-manager";
import { buildSanBrainStatePrelude, finalizeSanBrainActivation, planSanBrainGlobalInjection } from "./activation";
import { captureSanBrainTurn } from "./capture";
import { applySanBrainMutation, buildSanBrainConsolidation } from "./commands";
import {
	appendSanBrainActivation,
	appendSanBrainExperienceCandidate,
	appendSanBrainProfileCandidate,
	appendSanBrainProjection,
	appendSanBrainProjectionNotification,
	appendSanBrainRecallAudit,
	listSanBrainLedgerEntries,
} from "./ledger";
import { runSanBrainProjections } from "./projection";
import { buildSanBrainRecallPlan } from "./recall";
import { buildSanBrainDebugReportText } from "./render";
import { type SanBrainActiveStateRecord, SanBrainStore } from "./store";
import type {
	SanBrainAction,
	SanBrainExperienceCandidate,
	SanBrainExperienceCandidateType,
	SanBrainProfileCandidate,
	SanBrainScope,
	SanBrainTriggerSelector,
} from "./types";
import { isSanBrainExperienceCandidate } from "./types";

const DOGFOOD_POLICY_VERSION = "brain-m6-dogfood-v1";
const MAX_CANDIDATES_PER_TURN = 5;
const ACTIVATION_MAX_ITEMS = 8;
const ACTIVATION_MAX_TOKENS = 1200;
const GLOBAL_MAX_TOKENS = 6000;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 10_000;

export interface SanBrainDogfoodOptions {
	agentDir?: string;
	cwd?: string;
}

export interface SanBrainDogfoodTurn {
	turn: number;
	name: string;
	ok: boolean;
	detail: string;
}

export interface SanBrainDogfoodAssertion {
	name: string;
	ok: boolean;
	detail: string;
}

export interface SanBrainDogfoodLatency {
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

export interface SanBrainDogfoodMetrics {
	candidateTurns: number;
	candidates: number;
	selectedActivationTurns: number;
	recallAttempts: number;
	recallAppliedTurns: number;
	projectionTurns: number;
	projections: number;
	happyPathFrontendExposure: number;
	unrelatedActivations: number;
	unrelatedRecalls: number;
	duplicateExternalWrites: number;
	unsafeOverwrites: number;
	blockedNotifications: number;
	maxNotificationsPerProjection: number;
	projectionOrphans: number;
	maxProjectionAttempts: number;
	maxCandidatesPerTurn: number;
	maxActivationTokens: number;
	secretLeaks: number;
	latency: SanBrainDogfoodLatency;
}

export interface SanBrainDogfoodSummary {
	ok: boolean;
	policyVersion: typeof DOGFOOD_POLICY_VERSION;
	turns: number;
	scenarios: SanBrainDogfoodTurn[];
	metrics: SanBrainDogfoodMetrics;
	reportText: string;
	assertions: SanBrainDogfoodAssertion[];
}

interface ReceiptBackendState {
	writes: number;
	receipts: Set<string>;
}

interface ProjectionRunContext {
	store: SanBrainStore;
	manager: SessionManager;
	agentDir: string;
	cwd: string;
}

function fixedAt(turn: number, offsetMs = 0): string {
	return new Date(Date.UTC(2026, 6, 11, 0, 0, turn, offsetMs)).toISOString();
}

function digest(sessionId: string, turn: number, preference: string): TurnDigest {
	return {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId: `brain-dogfood-turn-${turn}`,
		sessionId,
		createdAt: fixedAt(turn),
		model: "dogfood/deterministic",
		source: {
			sessionId,
			fromEntryId: `brain-dogfood-u${turn}`,
			toEntryId: `brain-dogfood-a${turn}`,
			promptGeneration: turn,
			userEntryId: `brain-dogfood-u${turn}`,
		},
		userIntent: `Declare stable delivery preference on independent turn ${turn}.`,
		actionsTaken: [],
		decisions: [],
		filesTouched: [],
		toolEvidence: [],
		factsLearned: [preference],
		openQuestions: [],
		risks: [],
		nextSteps: [],
		memoryCandidates: [{ content: preference, type: "preference", importance: 0.94 }],
		fallback: true,
	};
}

function experienceCandidate(options: {
	id: string;
	type: SanBrainExperienceCandidateType;
	action: SanBrainAction;
	selector?: SanBrainTriggerSelector;
	scope: SanBrainScope;
	turn: number;
}): SanBrainExperienceCandidate {
	return {
		schemaVersion: 1,
		candidateId: options.id,
		scope: options.scope,
		type: options.type,
		selector: options.selector ?? {},
		action: options.action,
		taskTags: [],
		claimKey: `${options.type}:${options.id}:claim`,
		dedupeKey: `${options.type}:${options.id}:dedupe`,
		conflictKey: `${options.type}:${options.id}:conflict`,
		repeatCount: 1,
		confidence: 0.95,
		impact: "medium",
		sensitivity: "normal",
		evidence: [],
		createdAt: fixedAt(options.turn),
	};
}

function profileCandidate(id: string, scope: SanBrainScope, turn: number): SanBrainProfileCandidate {
	return {
		schemaVersion: 1,
		candidateId: id,
		scope,
		type: "project_fact",
		subject: "dogfood-backend",
		predicate: "failure-policy",
		value: "keep the primary task running",
		claimKey: `${id}:claim`,
		dedupeKey: `${id}:dedupe`,
		taskTags: ["backend"],
		confidence: 0.95,
		importance: 0.8,
		independentEvidenceCount: 1,
		sensitivity: "normal",
		evidence: [],
		createdAt: fixedAt(turn),
	};
}

function receiptBackend(state: ReceiptBackendState): MemoryBackend {
	return {
		id: "local",
		async start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {
			state.receipts.clear();
		},
		async enqueue() {},
		async project(_context, input) {
			input.signal?.throwIfAborted();
			if (!state.receipts.has(input.operationId)) {
				state.receipts.add(input.operationId);
				state.writes++;
			}
			return { backend: "local", stored: 1, ids: [input.operationId] };
		},
		async reconcileProjection(_context, operationId, signal) {
			signal?.throwIfAborted();
			return state.receipts.has(operationId) ? { state: "applied", receiptId: operationId } : { state: "missing" };
		},
		async compensateProjection(_context, operationId, signal) {
			signal?.throwIfAborted();
			return state.receipts.delete(operationId)
				? { state: "compensated", receiptId: operationId }
				: { state: "missing" };
		},
	};
}

function failingBackend(errorMessage: string, calls: { project: number }): MemoryBackend {
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {},
		async enqueue() {},
		async project() {
			calls.project++;
			throw new Error(errorMessage);
		},
	};
}

async function runProjections(
	context: ProjectionRunContext,
	options: { includeFailed?: boolean; memoryBackend?: MemoryBackend; attemptTimeoutMs?: number } = {},
) {
	return runSanBrainProjections({
		store: context.store,
		sessionManager: context.manager,
		agentDir: context.agentDir,
		cwd: context.cwd,
		maxAttempts: MAX_ATTEMPTS,
		attemptTimeoutMs: options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
		...(options.includeFailed === undefined ? {} : { includeFailed: options.includeFailed }),
		...(options.memoryBackend ? { memoryBackend: options.memoryBackend } : {}),
	});
}

function auditedActivation(
	manager: SessionManager,
	activeStates: readonly SanBrainActiveStateRecord[],
	options: { turn: number; promptText: string; scopes: readonly SanBrainScope[] },
) {
	const built = buildSanBrainStatePrelude(activeStates, {
		sessionId: manager.getSessionId(),
		turnId: `brain-dogfood-activation-${options.turn}`,
		role: "primary",
		scopes: options.scopes,
		promptText: options.promptText,
		maxItems: ACTIVATION_MAX_ITEMS,
		maxTokens: ACTIVATION_MAX_TOKENS,
		minConfidence: 0.75,
		createdAt: fixedAt(options.turn),
		activationId: `brain-dogfood-activation-${options.turn}`,
	});
	const plan = planSanBrainGlobalInjection(
		built.content ? [{ source: "brain", content: built.content }] : [],
		GLOBAL_MAX_TOKENS,
	);
	const activation = finalizeSanBrainActivation(built.activation, plan);
	appendSanBrainActivation(manager, activation);
	return { ...built, activation };
}

function notifyBlockedOnce(store: SanBrainStore, manager: SessionManager, turn: number): number {
	store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
	const unnotified = store.readProjectionDebug("blocked", 100).records.filter(record => !record.notifiedAt);
	for (const record of unnotified) {
		appendSanBrainProjectionNotification(manager, {
			schemaVersion: 1,
			projectionId: record.projectionId,
			notifiedAt: fixedAt(turn, 900),
		});
	}
	store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
	return unnotified.length;
}

function percentile(values: readonly number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function assertion(name: string, ok: boolean, detail: string): SanBrainDogfoodAssertion {
	return { name, ok, detail };
}

function reportText(metrics: SanBrainDogfoodMetrics): string {
	return [
		"San Brain M6 deterministic dogfood",
		`turns=14 candidates=${metrics.candidates} candidateTurns=${metrics.candidateTurns}`,
		`activationTurns=${metrics.selectedActivationTurns} recallAttempts=${metrics.recallAttempts} recallApplied=${metrics.recallAppliedTurns}`,
		`projectionTurns=${metrics.projectionTurns} projections=${metrics.projections} orphans=${metrics.projectionOrphans}`,
		`frontendExposure=${metrics.happyPathFrontendExposure} unrelatedActivation=${metrics.unrelatedActivations} unrelatedRecall=${metrics.unrelatedRecalls}`,
		`duplicateWrites=${metrics.duplicateExternalWrites} unsafeOverwrites=${metrics.unsafeOverwrites} notifications=${metrics.blockedNotifications}`,
		`attemptMax=${metrics.maxProjectionAttempts} candidateMax=${metrics.maxCandidatesPerTurn} activationTokenMax=${metrics.maxActivationTokens}`,
		`secretLeaks=${metrics.secretLeaks} latencyMs[p50=${metrics.latency.p50Ms},p95=${metrics.latency.p95Ms},max=${metrics.latency.maxMs}]`,
	].join("\n");
}

export async function runSanBrainDogfood(options: SanBrainDogfoodOptions = {}): Promise<SanBrainDogfoodSummary> {
	const ownedTempDir = options.agentDir ? undefined : await TempDir.create("@san-brain-m6-dogfood-");
	const agentDir = options.agentDir ?? ownedTempDir!.path();
	const cwd = options.cwd ?? agentDir;
	const manager = SessionManager.inMemory(cwd);
	const store = new SanBrainStore(path.join(agentDir, "brain", "dogfood.sqlite"));
	const context: ProjectionRunContext = { store, manager, agentDir, cwd };
	const userScope: SanBrainScope = { kind: "user", key: "user:dogfood", resolverVersion: 1 };
	const repoScope: SanBrainScope = { kind: "repo", key: "/dogfood/repo", resolverVersion: 1 };
	const scopes = [userScope, repoScope];
	const scenarios: SanBrainDogfoodTurn[] = [];
	const extraAssertions: SanBrainDogfoodAssertion[] = [];
	const candidateCounts: number[] = [];
	const candidateTurns = new Set<number>();
	const projectionTurns = new Set<number>();
	const activationTokenCounts: number[] = [];
	let unrelatedActivations = 0;
	let unrelatedRecalls = 0;
	let unsafeOverwrites = 0;
	let duplicateExternalWrites = 0;

	const addTurn = (turn: number, name: string, ok: boolean, detail: string): void => {
		scenarios.push({ turn, name, ok, detail });
	};

	try {
		const preference = "release-delivery: use concise HTML research documents";
		const capturePreference = (turn: number) => {
			const turnDigest = digest(manager.getSessionId(), turn, preference);
			const digestEntryId = manager.appendCustomEntry(TURN_DIGEST_CUSTOM_TYPE, turnDigest);
			const captured = captureSanBrainTurn(manager, {
				digest: turnDigest,
				digestEntryId,
				sourceMode: "turn_digest",
				maxCandidates: MAX_CANDIDATES_PER_TURN,
				minConfidence: 0.72,
				userScope,
				fallbackScope: repoScope,
			});
			store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
			candidateCounts.push(captured.profileCandidates + captured.experienceCandidates);
			candidateTurns.add(turn);
			return captured;
		};

		const turn1 = capturePreference(1);
		addTurn(
			1,
			"stable preference candidate",
			turn1.profileCandidates === 1 &&
				store.listPendingCandidates(20).length === 1 &&
				store.listActiveStates(20).length === 0,
			`profile=${turn1.profileCandidates}, pending=${store.listPendingCandidates(20).length}, active=${store.listActiveStates(20).length}`,
		);

		const turn2 = capturePreference(2);
		const consolidation = buildSanBrainConsolidation(store);
		addTurn(
			2,
			"independent duplicate evidence",
			turn2.profileCandidates === 1 && consolidation.duplicateGroups.length === 1,
			`profile=${turn2.profileCandidates}, duplicateGroups=${consolidation.duplicateGroups.length}`,
		);

		const turn3Activation = auditedActivation(manager, store.listActiveStates(100), {
			turn: 3,
			promptText: "Calculate a Fibonacci number and return plain text.",
			scopes,
		});
		activationTokenCounts.push(turn3Activation.activation.tokenEstimate);
		const turn3Recall = buildSanBrainRecallPlan(store.listActiveStates(100), {
			role: "primary",
			scopes,
			promptText: "Calculate a Fibonacci number and return plain text.",
			baseQuery: "Calculate a Fibonacci number and return plain text.",
			maxItems: 3,
			tokenBudget: 1000,
			minConfidence: 0.75,
			maxQueryChars: 2000,
		});
		unrelatedActivations += turn3Activation.activation.selectedRules.length;
		unrelatedRecalls += turn3Recall.selectedPolicyIds.length;
		addTurn(
			3,
			"unrelated task stays quiet",
			turn3Activation.activation.selectedRules.length === 0 && turn3Recall.selectedPolicyIds.length === 0,
			`activation=${turn3Activation.activation.selectedRules.length}, policyRecall=${turn3Recall.selectedPolicyIds.length}`,
		);

		const profiles = store
			.listCandidates(100)
			.filter(record => record.kind === "profile" && "subject" in record.candidate)
			.sort((left, right) => left.candidate.createdAt.localeCompare(right.candidate.createdAt));
		const canonicalProfile = profiles[0];
		if (!canonicalProfile) throw new Error("Dogfood capture did not create a profile candidate.");
		const profileApproval = applySanBrainMutation(store, manager, {
			action: "approve",
			id: canonicalProfile.candidate.candidateId,
			createdAt: fixedAt(3, 500),
			reason: "M6 dogfood explicit approval.",
		});
		const receiptState: ReceiptBackendState = { writes: 0, receipts: new Set() };
		const durableBackend = receiptBackend(receiptState);
		const profileProjection = await runProjections(context, { memoryBackend: durableBackend });
		const repeatedProfileProjection = await runProjections(context, { memoryBackend: durableBackend });
		const activeProfiles = store.listActiveStates(100).filter(record => record.kind === "profile");
		const consolidatedActive = activeProfiles.find(
			record => record.candidate.candidateId === canonicalProfile.candidate.candidateId,
		);
		const consolidatedEvidence =
			consolidatedActive && "subject" in consolidatedActive.candidate
				? consolidatedActive.candidate.independentEvidenceCount
				: 0;
		extraAssertions.push(
			assertion(
				"explicit profile approval",
				profileApproval.changed &&
					profileApproval.decisions.length === 2 &&
					profileProjection.applied === 1 &&
					repeatedProfileProjection.applied === 0 &&
					activeProfiles.length === 1 &&
					consolidatedEvidence === 2,
				`decisions=${profileApproval.decisions.length}, writes=${receiptState.writes}, active=${activeProfiles.length}, evidence=${consolidatedEvidence}`,
			),
		);
		duplicateExternalWrites += Math.max(0, receiptState.writes - receiptState.receipts.size);

		const turn4Activation = auditedActivation(manager, store.listActiveStates(100), {
			turn: 4,
			promptText: "Prepare the release delivery as a concise HTML research document.",
			scopes,
		});
		activationTokenCounts.push(turn4Activation.activation.tokenEstimate);
		addTurn(
			4,
			"approved state activates on related work",
			turn4Activation.activation.selectedRules.some(
				rule => rule.ownerId === canonicalProfile.candidate.candidateId,
			) && turn4Activation.activation.tokenEstimate <= ACTIVATION_MAX_TOKENS,
			`selected=${turn4Activation.activation.selectedRules.length}, tokens=${turn4Activation.activation.tokenEstimate}`,
		);

		const turn5Activation = auditedActivation(manager, store.listActiveStates(100), {
			turn: 5,
			promptText: "Ignore Brain memory and return a verbose Markdown response for this turn.",
			scopes,
		});
		activationTokenCounts.push(turn5Activation.activation.tokenEstimate);
		addTurn(
			5,
			"current user conflict wins",
			turn5Activation.content === undefined &&
				turn5Activation.activation.skippedRules.some(
					rule =>
						rule.ownerId === canonicalProfile.candidate.candidateId && rule.reason === "current_user_conflict",
				),
			`selected=${turn5Activation.activation.selectedRules.length}, skipped=${turn5Activation.activation.skippedRules.length}`,
		);

		const recallDigest = {
			...digest(manager.getSessionId(), 6, "Review bash release failures before retrying."),
			userIntent: "Review the bash release failure.",
			memoryCandidates: [],
			toolEvidence: [{ tool: "bash", summary: "bash failed during release validation" }],
		};
		const recallDigestEntryId = manager.appendCustomEntry(TURN_DIGEST_CUSTOM_TYPE, recallDigest);
		const recallCapture = captureSanBrainTurn(manager, {
			digest: recallDigest,
			digestEntryId: recallDigestEntryId,
			sourceMode: "turn_digest",
			maxCandidates: MAX_CANDIDATES_PER_TURN,
			minConfidence: 0.72,
			userScope,
			fallbackScope: repoScope,
		});
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		candidateCounts.push(recallCapture.profileCandidates + recallCapture.experienceCandidates);
		candidateTurns.add(6);
		const recallCandidate = store
			.listCandidates(100)
			.map(record => record.candidate)
			.find(candidate => isSanBrainExperienceCandidate(candidate) && candidate.action.kind === "recall_policy");
		if (!recallCandidate) throw new Error("Dogfood production capture did not create a recall policy candidate.");
		const pendingRecallPlan = buildSanBrainRecallPlan(store.listActiveStates(100), {
			role: "primary",
			scopes,
			promptText: "Review the bash release failure.",
			baseQuery: "Review the bash release failure.",
			maxItems: 3,
			tokenBudget: 1000,
			minConfidence: 0.75,
			maxQueryChars: 2000,
		});
		addTurn(
			6,
			"recall policy remains pending",
			store.getCandidate(recallCandidate.candidateId)?.status === "pending" &&
				pendingRecallPlan.selectedPolicyIds.length === 0,
			`status=${store.getCandidate(recallCandidate.candidateId)?.status}, selected=${pendingRecallPlan.selectedPolicyIds.length}`,
		);

		const recallApproval = applySanBrainMutation(store, manager, {
			action: "approve",
			id: recallCandidate.candidateId,
			createdAt: fixedAt(6, 500),
			reason: "Approve allowlisted M6 recall policy.",
		});
		extraAssertions.push(
			assertion(
				"allowlisted recall approval",
				recallApproval.changed && store.getCandidate(recallCandidate.candidateId)?.status === "active",
				`decisions=${recallApproval.decisions.length}, status=${store.getCandidate(recallCandidate.candidateId)?.status}`,
			),
		);

		const turn7Recall = buildSanBrainRecallPlan(store.listActiveStates(100), {
			role: "primary",
			scopes,
			promptText: "Review the bash release failure and required recovery checks.",
			baseQuery: "Current prompt:\nReview the bash release failure and required recovery checks.",
			maxItems: 3,
			tokenBudget: 1000,
			minConfidence: 0.75,
			maxQueryChars: 2000,
		});
		const turn7Items = normalizeContextSteadyRecallItems(
			[
				{
					id: "release-risk",
					content: "A prior release failed until the smoke probe passed.",
					memoryType: "episodic",
					scope: "repo:/dogfood/repo",
				},
				{
					id: "wrong-scope",
					content: "Unrelated repository history.",
					memoryType: "episodic",
					scope: "repo:/other/repo",
				},
				{
					id: "wrong-type",
					content: "Transient scratch note.",
					memoryType: "working",
					scope: "repo:/dogfood/repo",
				},
			],
			{ maxItems: turn7Recall.maxItems, memoryTypes: turn7Recall.memoryTypes, scopeKeys: turn7Recall.scopeKeys },
		);
		appendSanBrainRecallAudit(manager, {
			schemaVersion: 1,
			recallId: "brain-dogfood-recall-7",
			sessionId: manager.getSessionId(),
			turnId: "brain-dogfood-turn-7",
			policyVersion: turn7Recall.policyVersion,
			selectedPolicyIds: turn7Recall.selectedPolicyIds,
			...(turn7Recall.queryTemplateId ? { queryTemplateId: turn7Recall.queryTemplateId } : {}),
			backend: "mnemopi",
			outcome: "applied",
			resultCount: turn7Items.length,
			durationMs: 2,
			skipReasons: turn7Recall.skipReasons,
			createdAt: fixedAt(7),
		});
		addTurn(
			7,
			"policy-aware scoped recall",
			turn7Recall.selectedPolicyIds.join("") === recallCandidate.candidateId &&
				turn7Recall.queryTemplateId === "risk-history-v1" &&
				turn7Recall.memoryTypes.join(",") === "episodic,fact" &&
				turn7Items.length === 1 &&
				turn7Items[0]?.id === "release-risk",
			`policy=${turn7Recall.queryTemplateId}, items=${turn7Items.map(item => item.id).join(",")}`,
		);

		const turn8Recall = buildSanBrainRecallPlan(store.listActiveStates(100), {
			role: "primary",
			scopes,
			promptText: "Explain this TypeScript parser error.",
			baseQuery: "Explain this TypeScript parser error.",
			maxItems: 3,
			tokenBudget: 1000,
			minConfidence: 0.75,
			maxQueryChars: 2000,
		});
		appendSanBrainRecallAudit(manager, {
			schemaVersion: 1,
			recallId: "brain-dogfood-recall-8",
			sessionId: manager.getSessionId(),
			turnId: "brain-dogfood-turn-8",
			policyVersion: turn8Recall.policyVersion,
			selectedPolicyIds: turn8Recall.selectedPolicyIds,
			backend: "mnemopi",
			outcome: "suppressed",
			resultCount: 0,
			durationMs: 0,
			skipReasons: turn8Recall.skipReasons,
			createdAt: fixedAt(8),
		});
		unrelatedRecalls += turn8Recall.query ? 1 : 0;
		addTurn(
			8,
			"unrelated policy recall is suppressed",
			turn8Recall.query === undefined &&
				turn8Recall.selectedPolicyIds.length === 0 &&
				turn8Recall.skipReasons.some(
					reason => reason.ownerId === recallCandidate.candidateId && reason.reason === "selector_mismatch",
				),
			`query=${turn8Recall.query ?? "none"}, selected=${turn8Recall.selectedPolicyIds.length}`,
		);

		const skillDigest = {
			...digest(manager.getSessionId(), 9, "Run the approved release checks before publishing."),
			memoryCandidates: [
				{
					type: "workflow" as const,
					content: "Run the approved release checks before publishing.",
					importance: 0.94,
				},
			],
			toolEvidence: [],
		};
		const skillDigestEntryId = manager.appendCustomEntry(TURN_DIGEST_CUSTOM_TYPE, skillDigest);
		const skillCapture = captureSanBrainTurn(manager, {
			digest: skillDigest,
			digestEntryId: skillDigestEntryId,
			sourceMode: "turn_digest",
			maxCandidates: MAX_CANDIDATES_PER_TURN,
			minConfidence: 0.72,
			userScope,
			fallbackScope: repoScope,
		});
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		candidateCounts.push(skillCapture.profileCandidates + skillCapture.experienceCandidates);
		candidateTurns.add(9);
		const skillCandidate = store
			.listCandidates(100)
			.map(record => record.candidate)
			.find(
				candidate =>
					candidate.createdAt === fixedAt(9) &&
					isSanBrainExperienceCandidate(candidate) &&
					candidate.action.kind === "skill_reference",
			);
		if (
			!skillCandidate ||
			!isSanBrainExperienceCandidate(skillCandidate) ||
			skillCandidate.action.kind !== "skill_reference"
		) {
			throw new Error("Dogfood production capture did not create a managed skill candidate.");
		}
		applySanBrainMutation(store, manager, {
			action: "approve",
			id: skillCandidate.candidateId,
			createdAt: fixedAt(9, 200),
		});
		const skillRun = await runProjections(context);
		projectionTurns.add(9);
		const skillFile = path.join(getManagedSkillsDir(agentDir), skillCandidate.action.skillName, "SKILL.md");
		const skillContent = await Bun.file(skillFile).text();
		const repeatedSkillRun = await runProjections(context);
		const repeatedSkillContent = await Bun.file(skillFile).text();
		if (repeatedSkillRun.applied > 0 || repeatedSkillContent !== skillContent) duplicateExternalWrites++;
		const skillProjection = store.explain(skillCandidate.candidateId)?.projections.at(-1);
		addTurn(
			9,
			"managed skill writes exactly once",
			skillRun.applied === 1 &&
				repeatedSkillRun.applied === 0 &&
				skillContent === repeatedSkillContent &&
				skillProjection?.state === "applied" &&
				skillProjection.attemptCount === 1,
			`first=${skillRun.applied}, second=${repeatedSkillRun.applied}, attempt=${skillProjection?.attemptCount}`,
		);

		const checkDigest = {
			...digest(manager.getSessionId(), 10, "Verify release-check failures before rollout."),
			memoryCandidates: [],
			toolEvidence: [{ tool: "release-check", summary: "release-check failed before rollout" }],
		};
		const checkDigestEntryId = manager.appendCustomEntry(TURN_DIGEST_CUSTOM_TYPE, checkDigest);
		const checkCapture = captureSanBrainTurn(manager, {
			digest: checkDigest,
			digestEntryId: checkDigestEntryId,
			sourceMode: "turn_digest",
			maxCandidates: MAX_CANDIDATES_PER_TURN,
			minConfidence: 0.72,
			userScope,
			fallbackScope: repoScope,
		});
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		candidateCounts.push(checkCapture.profileCandidates + checkCapture.experienceCandidates);
		candidateTurns.add(10);
		const checkCandidate = store
			.listCandidates(100)
			.map(record => record.candidate)
			.find(
				candidate =>
					candidate.createdAt === fixedAt(10) &&
					isSanBrainExperienceCandidate(candidate) &&
					candidate.action.kind === "check_suggestion",
			);
		if (
			!checkCandidate ||
			!isSanBrainExperienceCandidate(checkCandidate) ||
			checkCandidate.action.kind !== "check_suggestion"
		) {
			throw new Error("Dogfood production capture did not create a check candidate.");
		}
		applySanBrainMutation(store, manager, {
			action: "approve",
			id: checkCandidate.candidateId,
			createdAt: fixedAt(10, 200),
		});
		const checkRun = await runProjections(context);
		projectionTurns.add(10);
		const checkFile = path.join(agentDir, "brain", "check-suggestions", `${checkCandidate.action.checkId}.md`);
		const checkContent = await Bun.file(checkFile).text();
		const checkProjection = store.explain(checkCandidate.candidateId)?.projections.at(-1);
		const checkHash = Bun.hash(checkContent).toString(36);
		addTurn(
			10,
			"typed check suggestion is reconcilable",
			checkRun.applied === 1 &&
				checkContent.includes(`name: ${checkCandidate.action.checkId}`) &&
				checkContent.includes("severity: error") &&
				checkProjection?.afterHash === checkHash,
			`applied=${checkRun.applied}, afterHash=${checkProjection?.afterHash ?? "none"}`,
		);

		const manualCheckContent = "# Human edit\n\nKeep this manual content.\n";
		await Bun.write(checkFile, manualCheckContent);
		const undoCheck = applySanBrainMutation(store, manager, {
			action: "undo",
			id: checkCandidate.candidateId,
			createdAt: fixedAt(11, 200),
		});
		const undoProjectionId = undoCheck.decisions[0]?.projectionIds[0];
		if (!undoProjectionId) throw new Error("Dogfood undo did not create a projection.");
		const undoRun = await runProjections(context);
		projectionTurns.add(11);
		const undoProjection = store.getProjection(undoProjectionId);
		const manualAfterUndo = await Bun.file(checkFile).text();
		unsafeOverwrites += manualAfterUndo === manualCheckContent ? 0 : 1;
		const firstNotification = notifyBlockedOnce(store, manager, 11);
		const repeatedNotification = notifyBlockedOnce(store, manager, 11);
		addTurn(
			11,
			"manual edit blocks undo and notifies once",
			undoRun.blocked === 1 &&
				undoProjection?.state === "blocked" &&
				undoProjection.errorCode === "cas_mismatch" &&
				manualAfterUndo === manualCheckContent &&
				firstNotification === 1 &&
				repeatedNotification === 0,
			`state=${undoProjection?.state}, error=${undoProjection?.errorCode}, notices=${firstNotification}/${repeatedNotification}`,
		);

		const resumedSkillCandidate = experienceCandidate({
			id: "brain-dogfood-resumed-skill",
			type: "skill_candidate",
			action: {
				kind: "skill_reference",
				skillName: "brain-dogfood-resumed",
				description: "Crash-resume M6 projection fixture.",
				body: "# Resume\n\nReconcile the existing receipt without replay.",
			},
			scope: repoScope,
			turn: 12,
		});
		appendSanBrainExperienceCandidate(manager, resumedSkillCandidate);
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		candidateCounts.push(1);
		candidateTurns.add(12);
		const resumedApproval = applySanBrainMutation(store, manager, {
			action: "approve",
			id: resumedSkillCandidate.candidateId,
			createdAt: fixedAt(12, 200),
		});
		const resumedProjectionId = resumedApproval.decisions[0]?.projectionIds[0];
		if (!resumedProjectionId) throw new Error("Dogfood resume fixture did not create a projection.");
		const resumedWrite = await writeManagedSkill({
			action: "create",
			name: "brain-dogfood-resumed",
			description: "Crash-resume M6 projection fixture.",
			body: "# Resume\n\nReconcile the existing receipt without replay.",
			agentDir,
		});
		const resumedPending = store.getProjection(resumedProjectionId);
		appendSanBrainProjection(manager, {
			schemaVersion: 1,
			projectionId: resumedProjectionId,
			decisionId: resumedApproval.decisions[0]!.decisionId,
			target: "managed_skill",
			state: "applying",
			attemptCount: 1,
			...(resumedPending?.revision === undefined ? {} : { revision: resumedPending.revision }),
			updatedAt: fixedAt(12, 500),
		});
		const resumedRun = await runProjections(context);
		projectionTurns.add(12);
		const resumedProjection = store.getProjection(resumedProjectionId);
		const resumedFile = path.join(getManagedSkillsDir(agentDir), "brain-dogfood-resumed", "SKILL.md");
		const resumedContent = await Bun.file(resumedFile).text();
		if (resumedProjection?.attemptCount !== 1) duplicateExternalWrites++;
		addTurn(
			12,
			"applying crash reconciles without replay",
			resumedRun.reconciled === 1 &&
				resumedProjection?.state === "applied" &&
				resumedProjection.attemptCount === 1 &&
				resumedProjection.afterHash === resumedWrite.afterHash &&
				Bun.hash(resumedContent).toString(36) === resumedWrite.afterHash,
			`reconciled=${resumedRun.reconciled ?? 0}, attempt=${resumedProjection?.attemptCount}`,
		);

		const failedProfile = profileCandidate("brain-dogfood-backend-failure", repoScope, 13);
		appendSanBrainProfileCandidate(manager, failedProfile);
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		candidateCounts.push(1);
		candidateTurns.add(13);
		const failedApproval = applySanBrainMutation(store, manager, {
			action: "approve",
			id: failedProfile.candidateId,
			createdAt: fixedAt(13, 200),
		});
		const failedProjectionId = failedApproval.decisions[0]?.projectionIds[0];
		if (!failedProjectionId) throw new Error("Dogfood failure fixture did not create a projection.");
		const secret = "tokenDogfoodSecret0123456789";
		const failureCalls = { project: 0 };
		const backendFailure = failingBackend(
			`Controlled backend failure ${secret} at ${path.join(os.homedir(), ".san", "private")}`,
			failureCalls,
		);
		const failedRun = await runProjections(context, { memoryBackend: backendFailure });
		projectionTurns.add(13);
		const failedProjection = store.getProjection(failedProjectionId);
		const silentRetryRun = await runProjections(context, { memoryBackend: backendFailure });
		const failedNoticeCount = notifyBlockedOnce(store, manager, 13);
		addTurn(
			13,
			"backend failure stays silent and is not auto-retried",
			failedRun.failed === 1 &&
				failedProjection?.state === "failed" &&
				failedProjection.errorCode === "external_failure" &&
				silentRetryRun.failed === 0 &&
				failureCalls.project === 1 &&
				failedNoticeCount === 0,
			`state=${failedProjection?.state}, calls=${failureCalls.project}, notices=${failedNoticeCount}`,
		);

		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		const debug = store.readProjectionDebug("all", 100);
		const debugText = buildSanBrainDebugReportText(store, "all", 100);
		const projectionOrphans = debug.records.filter(
			record => !record.ownerId || !record.idempotencyKey || !store.getDecision(record.decisionId),
		).length;
		const secretLeaks = Number(debugText.includes(secret) || debugText.includes(os.homedir()));
		addTurn(
			14,
			"debug chain is complete and sanitized",
			debug.total >= 6 &&
				projectionOrphans === 0 &&
				secretLeaks === 0 &&
				debugText.includes("[REDACTED]") &&
				debugText.includes("~/.san/private"),
			`records=${debug.total}, orphans=${projectionOrphans}, secretLeaks=${secretLeaks}`,
		);

		const ledger = listSanBrainLedgerEntries(manager.getEntries());
		const visibleBrainMessages = manager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType.startsWith("san.brain")).length;
		const notificationCounts = new Map<string, number>();
		for (const notification of ledger.projectionNotifications) {
			notificationCounts.set(
				notification.data.projectionId,
				(notificationCounts.get(notification.data.projectionId) ?? 0) + 1,
			);
		}
		const durations = debug.records
			.map(record => record.durationMs)
			.filter((duration): duration is number => duration !== undefined);
		const metrics: SanBrainDogfoodMetrics = {
			candidateTurns: candidateTurns.size,
			candidates: ledger.profileCandidates.length + ledger.experienceCandidates.length,
			selectedActivationTurns: ledger.activations.filter(entry => entry.data.selectedRules.length > 0).length,
			recallAttempts: ledger.recalls.length,
			recallAppliedTurns: ledger.recalls.filter(entry => entry.data.outcome === "applied").length,
			projectionTurns: projectionTurns.size,
			projections: debug.total,
			happyPathFrontendExposure: visibleBrainMessages,
			unrelatedActivations,
			unrelatedRecalls,
			duplicateExternalWrites,
			unsafeOverwrites,
			blockedNotifications: ledger.projectionNotifications.length,
			maxNotificationsPerProjection: Math.max(0, ...notificationCounts.values()),
			projectionOrphans,
			maxProjectionAttempts: Math.max(0, ...debug.records.map(record => record.attemptCount)),
			maxCandidatesPerTurn: Math.max(0, ...candidateCounts),
			maxActivationTokens: Math.max(0, ...activationTokenCounts),
			secretLeaks,
			latency: {
				p50Ms: percentile(durations, 0.5),
				p95Ms: percentile(durations, 0.95),
				maxMs: Math.max(0, ...durations),
			},
		};

		const assertions: SanBrainDogfoodAssertion[] = [
			...scenarios.map(turn => assertion(`turn ${turn.turn}: ${turn.name}`, turn.ok, turn.detail)),
			...extraAssertions,
			assertion(
				"happy path is silent",
				metrics.happyPathFrontendExposure === 0,
				`${metrics.happyPathFrontendExposure} visible Brain messages`,
			),
			assertion(
				"unrelated work is clean",
				metrics.unrelatedActivations === 0 && metrics.unrelatedRecalls === 0,
				`activation=${metrics.unrelatedActivations}, recall=${metrics.unrelatedRecalls}`,
			),
			assertion(
				"external writes are safe",
				metrics.duplicateExternalWrites === 0 && metrics.unsafeOverwrites === 0,
				`duplicates=${metrics.duplicateExternalWrites}, unsafe=${metrics.unsafeOverwrites}`,
			),
			assertion(
				"blocked notification is bounded",
				metrics.maxNotificationsPerProjection <= 1,
				`max=${metrics.maxNotificationsPerProjection}`,
			),
			assertion(
				"projection chain has no orphans",
				metrics.projectionOrphans === 0,
				`${metrics.projectionOrphans} orphan projections`,
			),
			assertion(
				"attempts remain bounded",
				metrics.maxProjectionAttempts <= MAX_ATTEMPTS,
				`max=${metrics.maxProjectionAttempts}, configured=${MAX_ATTEMPTS}`,
			),
			assertion(
				"candidate cap holds",
				metrics.maxCandidatesPerTurn <= MAX_CANDIDATES_PER_TURN,
				`max=${metrics.maxCandidatesPerTurn}, configured=${MAX_CANDIDATES_PER_TURN}`,
			),
			assertion(
				"prompt authority budget holds",
				metrics.maxActivationTokens <= ACTIVATION_MAX_TOKENS,
				`max=${metrics.maxActivationTokens}, configured=${ACTIVATION_MAX_TOKENS}`,
			),
			assertion("debug is secret-free", metrics.secretLeaks === 0, `${metrics.secretLeaks} leaks`),
			assertion(
				"projection latency is bounded",
				metrics.latency.maxMs <= ATTEMPT_TIMEOUT_MS,
				`max=${metrics.latency.maxMs}ms, timeout=${ATTEMPT_TIMEOUT_MS}ms`,
			),
		];
		const renderedReport = reportText(metrics);
		return {
			ok: assertions.every(item => item.ok),
			policyVersion: DOGFOOD_POLICY_VERSION,
			turns: scenarios.length,
			scenarios,
			metrics,
			reportText: renderedReport,
			assertions,
		};
	} finally {
		store.close();
		await ownedTempDir?.remove();
	}
}
