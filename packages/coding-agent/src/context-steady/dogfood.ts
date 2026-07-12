import { buildSessionContext } from "../session/session-context";
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { buildContextPlanReportText } from "../slash-commands/helpers/context-plan-report";
import { buildContextCheckpoint } from "./checkpoint";
import { materializeContextPlanMessages } from "./materialize";
import { type BuiltContextPlan, CONTEXT_PLAN_CUSTOM_TYPE } from "./plan-types";
import { buildContextPlan } from "./planner";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	type ContextRecallItem,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "./types";

export interface ContextSteadyDogfoodOptions {
	sessionId?: string;
	turns?: number;
	recentDigests?: number;
	planMaxTokens?: number;
	qualityWindowTokens?: number;
	reserveRatio?: number;
	checkpointEveryTurns?: number;
	checkpointMaxTokens?: number;
	recallItems?: readonly ContextRecallItem[];
	recallMaxTokens?: number;
}

export interface ContextSteadyDogfoodSummary {
	ok: boolean;
	sessionId: string;
	turns: number;
	digests: number;
	checkpoints: number;
	plans: number;
	injectedMessages: number;
	finalPlanId: string;
	finalPlanRepresentations: string[];
	finalPlanDigestRefs: string[];
	finalPlanCheckpointRef?: string;
	finalPlanRecallRefs: string[];
	finalPlanTokenEstimate: number;
	finalPlanTokenBudget: number;
	materializedMessageCount: number;
	transcriptMessageCount: number;
	reportText: string;
	assertions: Array<{ name: string; ok: boolean; detail: string }>;
}

const DEFAULT_TURNS = 20;
const DEFAULT_SESSION_ID = "san-dogfood-session";

function iso(index: number): string {
	return new Date(Date.UTC(2026, 5, 30, 0, 0, index)).toISOString();
}

function userEntry(index: number, parentId: string | null): SessionMessageEntry {
	const id = `u${index}`;
	return {
		type: "message",
		id,
		parentId,
		timestamp: iso(index * 3),
		message: {
			role: "user",
			content: `Dogfood turn ${index}: continue San context steady implementation`,
			timestamp: Date.parse(iso(index * 3)),
		},
	};
}

function assistantEntry(index: number, parentId: string): SessionMessageEntry {
	const id = `a${index}`;
	return {
		type: "message",
		id,
		parentId,
		timestamp: iso(index * 3 + 1),
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: `Completed San dogfood turn ${index}. I will keep stable checkpoint content before volatile recall.`,
				},
			],
			api: "anthropic-messages",
			timestamp: Date.parse(iso(index * 3 + 1)),
			provider: "dogfood",
			model: "deterministic",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
		},
	};
}

function digestEntry(index: number, parentId: string, sessionId: string): CustomEntry<TurnDigest> {
	const turnId = `turn_${index}`;
	const digest: TurnDigest = {
		schemaVersion: TURN_DIGEST_SCHEMA_VERSION,
		turnId,
		sessionId,
		createdAt: iso(index * 3 + 2),
		model: "dogfood/deterministic",
		source: {
			sessionId,
			fromEntryId: `u${index}`,
			toEntryId: `a${index}`,
			promptGeneration: index,
			userEntryId: `u${index}`,
		},
		userIntent: `Dogfood turn ${index}: continue San context steady implementation`,
		actionsTaken: [`verified context steady invariant ${index}`],
		decisions: [`keep stable layer before append-only and volatile layers ${index}`],
		filesTouched: [{ path: `packages/coding-agent/src/context-steady/dogfood-${index}.ts`, action: "modified" }],
		toolEvidence: [{ tool: "dogfood", summary: `deterministic dogfood turn ${index}`, entryIds: [`a${index}`] }],
		factsLearned: [`dogfood fact ${index}`],
		openQuestions: [],
		risks: index % 3 === 0 ? [`dogfood risk ${index}`] : [],
		nextSteps: [`continue with dogfood turn ${index + 1}`],
		memoryCandidates: [],
		tokenStats: { input: 100 + index, output: 20 + index, total: 120 + index * 2 },
		fallback: false,
	};
	return {
		type: "custom",
		id: `d${index}`,
		parentId,
		timestamp: iso(index * 3 + 2),
		customType: TURN_DIGEST_CUSTOM_TYPE,
		data: digest,
	};
}

function appendEntry(entries: SessionEntry[], entry: SessionEntry): string {
	entries.push(entry);
	return entry.id;
}

function requiredOptions(options: ContextSteadyDogfoodOptions): Required<ContextSteadyDogfoodOptions> {
	return {
		sessionId: options.sessionId ?? DEFAULT_SESSION_ID,
		turns: options.turns ?? DEFAULT_TURNS,
		recentDigests: options.recentDigests ?? 3,
		planMaxTokens: options.planMaxTokens ?? 2200,
		qualityWindowTokens: options.qualityWindowTokens ?? 6000,
		reserveRatio: options.reserveRatio ?? 0.25,
		checkpointEveryTurns: options.checkpointEveryTurns ?? 6,
		checkpointMaxTokens: options.checkpointMaxTokens ?? 12000,
		recallItems: options.recallItems ?? [
			{
				id: "mem-html-docs",
				content: "San planning and dogfood reports should live under docs/research as HTML documents.",
				source: "dogfood-memory",
				score: 0.97,
			},
			{
				id: "mem-cache-order",
				content: "Cache hit rate depends on keeping stable content before dynamic digest and recall layers.",
				source: "dogfood-memory",
				score: 0.96,
			},
		],
		recallMaxTokens: options.recallMaxTokens ?? 700,
	};
}

function assertResult(name: string, ok: boolean, detail: string): { name: string; ok: boolean; detail: string } {
	return { name, ok, detail };
}

function finalPlan(entries: readonly SessionEntry[]): BuiltContextPlan["audit"] | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== CONTEXT_PLAN_CUSTOM_TYPE) continue;
		return entry.data as BuiltContextPlan["audit"];
	}
	return undefined;
}

function planEntries(entries: readonly SessionEntry[]): Array<CustomEntry<BuiltContextPlan["audit"]>> {
	return entries.filter(
		(entry): entry is CustomEntry<BuiltContextPlan["audit"]> =>
			entry.type === "custom" && entry.customType === CONTEXT_PLAN_CUSTOM_TYPE,
	);
}

function digestEntries(entries: readonly SessionEntry[]): Array<CustomEntry<TurnDigest>> {
	return entries.filter(
		(entry): entry is CustomEntry<TurnDigest> =>
			entry.type === "custom" && entry.customType === TURN_DIGEST_CUSTOM_TYPE,
	);
}

function checkpointEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(entry => entry.type === "custom" && entry.customType === CONTEXT_CHECKPOINT_CUSTOM_TYPE);
}

function messageContainsContent(message: unknown, needle: string): boolean {
	if (typeof message !== "object" || message === null || !("content" in message)) return false;
	return JSON.stringify((message as Record<"content", unknown>).content).includes(needle);
}

function tokenEstimateByEntryRef(entries: readonly SessionEntry[]): Map<string, number> {
	const estimates = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type === "message") estimates.set(entry.id, JSON.stringify(entry.message).length);
	}
	return estimates;
}

export function runContextSteadyDogfood(options: ContextSteadyDogfoodOptions = {}): ContextSteadyDogfoodSummary {
	const resolved = requiredOptions(options);
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;

	for (let index = 1; index <= resolved.turns; index++) {
		parentId = appendEntry(entries, userEntry(index, parentId));
		parentId = appendEntry(entries, assistantEntry(index, parentId));
		parentId = appendEntry(entries, digestEntry(index, parentId, resolved.sessionId));

		const checkpoint = buildContextCheckpoint(entries, resolved.sessionId, {
			enabled: true,
			checkpointEveryTurns: resolved.checkpointEveryTurns,
			checkpointMaxTokens: resolved.checkpointMaxTokens,
		});
		if (checkpoint) {
			parentId = appendEntry(entries, {
				type: "custom",
				id: `ck${checkpointEntries(entries).length + 1}`,
				parentId,
				timestamp: iso(index * 3 + 3),
				customType: CONTEXT_CHECKPOINT_CUSTOM_TYPE,
				data: checkpoint.checkpoint,
			});
		}
	}

	const built = buildContextPlan({
		entries,
		sessionId: resolved.sessionId,
		requestKey: `${resolved.sessionId}:dogfood-final`,
		epochId: `epoch_${resolved.sessionId}`,
		promptGeneration: resolved.turns + 1,
		settings: {
			qualityWindowTokens: resolved.qualityWindowTokens,
			reserveRatio: resolved.reserveRatio,
			planMaxTokens: resolved.planMaxTokens,
		},
		contextWindow: 240000,
		nonMessageTokens: 20000,
		baseRequiredEntryRefs: [],
		currentPromptEntryRefs: [],
		liveTailEntryRefs: [],
		tokenEstimateByEntryRef: tokenEstimateByEntryRef(entries),
		maxDigestMaterials: resolved.recentDigests,
		rebaseReason: "checkpoint",
		createdAt: iso(resolved.turns * 3 + 4),
		recall: {
			query: "Continue San context steady dogfood final verification prompt",
			items: [...resolved.recallItems],
			tokenBudget: resolved.recallMaxTokens,
		},
	});

	parentId = appendEntry(entries, {
		type: "custom",
		id: "plan-final",
		parentId,
		timestamp: iso(resolved.turns * 3 + 4),
		customType: CONTEXT_PLAN_CUSTOM_TYPE,
		data: built.audit,
	});

	const digests = digestEntries(entries);
	const checkpoints = checkpointEntries(entries);
	const plans = planEntries(entries);
	const plan = finalPlan(entries);
	if (!plan) throw new Error("Context steady dogfood did not persist a final ContextPlan.");

	const representations = plan.materials.map(material => material.representation);
	const digestRefs = plan.materials
		.filter(material => material.representation === "digest")
		.flatMap(material => material.entryRefs);
	const checkpointRef = plan.materials.find(material => material.representation === "checkpoint")?.entryRefs[0];
	const recallRefs = plan.materials
		.filter(material => material.representation === "recall")
		.flatMap(material => material.entryRefs);
	const llmContext = buildSessionContext(entries);
	const transcriptContext = buildSessionContext(entries, undefined, undefined, { transcript: true });
	const materializedMessages = materializeContextPlanMessages(llmContext.messages, entries, built);
	const llmHasPersistedPlan = llmContext.messages.some(message =>
		messageContainsContent(message, "<san_context_plan>"),
	);
	const transcriptHasPersistedPlan = transcriptContext.messages.some(message =>
		messageContainsContent(message, "<san_context_plan>"),
	);
	const materializedHasPlan = materializedMessages.some(message =>
		messageContainsContent(message, "<san_context_plan>"),
	);

	const assertions = [
		assertResult("turn digests", digests.length === resolved.turns, `${digests.length}/${resolved.turns} digests`),
		assertResult("checkpoint exists", checkpoints.length > 0, `${checkpoints.length} checkpoints`),
		assertResult("plan persisted", plans.length === 1, `${plans.length} final plan entries`),
		assertResult(
			"materialized request injects plan",
			materializedHasPlan,
			materializedHasPlan ? "provider projection includes ContextPlan" : "provider projection misses ContextPlan",
		),
		assertResult(
			"stable prefix before dynamic layers",
			representations[0] === "checkpoint" && representations.includes("recall"),
			representations.join(" -> "),
		),
		assertResult(
			"volatile recall layer",
			representations.includes("recall"),
			JSON.stringify(plan.materials.find(material => material.representation === "recall") ?? null),
		),
		assertResult(
			"plan within budget",
			built.tokenEstimate <= plan.budget.planTokenBudget,
			`${built.tokenEstimate}/${plan.budget.planTokenBudget} tokens`,
		),
		assertResult(
			"checkpoint covers source",
			plan.coverage.some(item => item.replacementMaterialId.startsWith("checkpoint_")),
			JSON.stringify(plan.coverage),
		),
		assertResult(
			"active context hides persisted plan",
			!llmHasPersistedPlan,
			llmHasPersistedPlan
				? "active context includes persisted ContextPlan"
				: "active context excludes persisted ContextPlan",
		),
		assertResult(
			"transcript avoids injected plan replay",
			!transcriptHasPersistedPlan,
			transcriptHasPersistedPlan ? "transcript includes ContextPlan injection" : "transcript stores audit only",
		),
	];

	const reportText = buildContextPlanReportText(entries, { count: 1 });
	return {
		ok: assertions.every(assertion => assertion.ok),
		sessionId: resolved.sessionId,
		turns: resolved.turns,
		digests: digests.length,
		checkpoints: checkpoints.length,
		plans: plans.length,
		injectedMessages: 0,
		finalPlanId: plan.planId,
		finalPlanRepresentations: representations,
		finalPlanDigestRefs: digestRefs,
		finalPlanCheckpointRef: checkpointRef,
		finalPlanRecallRefs: recallRefs,
		finalPlanTokenEstimate: built.tokenEstimate,
		finalPlanTokenBudget: plan.budget.planTokenBudget,
		materializedMessageCount: materializedMessages.length,
		transcriptMessageCount: transcriptContext.messages.length,
		reportText,
		assertions,
	};
}
