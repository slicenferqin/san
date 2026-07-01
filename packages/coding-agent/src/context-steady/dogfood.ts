import { buildSessionContext } from "../session/session-context";
import type { CustomEntry, CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { buildContextPacketReportText } from "../slash-commands/helpers/context-packet-report";
import { buildContextCheckpoint } from "./checkpoint";
import { buildContextPacket } from "./packet";
import {
	CONTEXT_CHECKPOINT_CUSTOM_TYPE,
	CONTEXT_PACKET_CUSTOM_TYPE,
	CONTEXT_PACKET_MESSAGE_TYPE,
	type ContextPacket,
	type ContextPacketSettings,
	type ContextRecallItem,
	TURN_DIGEST_CUSTOM_TYPE,
	TURN_DIGEST_SCHEMA_VERSION,
	type TurnDigest,
} from "./types";

export interface ContextSteadyDogfoodOptions {
	sessionId?: string;
	turns?: number;
	recentDigests?: number;
	packetMaxTokens?: number;
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
	packets: number;
	injectedMessages: number;
	finalPacketId: string;
	finalPacketLayers: string[];
	finalPacketDigestRefs: string[];
	finalPacketCheckpointRef?: string;
	finalPacketRecallRefs: string[];
	finalPacketTokenEstimate: number;
	finalPacketTokenBudget: number;
	reportText: string;
	assertions: Array<{ name: string; ok: boolean; detail: string }>;
}

const DEFAULT_TURNS = 10;
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
		fallback: true,
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

function packetSettings(options: Required<ContextSteadyDogfoodOptions>): ContextPacketSettings {
	return {
		enabled: true,
		recentDigests: options.recentDigests,
		maxTokens: options.packetMaxTokens,
		qualityWindowTokens: options.qualityWindowTokens,
		reserveRatio: options.reserveRatio,
	};
}

function requiredOptions(options: ContextSteadyDogfoodOptions): Required<ContextSteadyDogfoodOptions> {
	return {
		sessionId: options.sessionId ?? DEFAULT_SESSION_ID,
		turns: options.turns ?? DEFAULT_TURNS,
		recentDigests: options.recentDigests ?? 3,
		packetMaxTokens: options.packetMaxTokens ?? 2200,
		qualityWindowTokens: options.qualityWindowTokens ?? 6000,
		reserveRatio: options.reserveRatio ?? 0.25,
		checkpointEveryTurns: options.checkpointEveryTurns ?? 4,
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

function finalPacket(entries: readonly SessionEntry[]): ContextPacket | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== CONTEXT_PACKET_CUSTOM_TYPE) continue;
		return entry.data as ContextPacket;
	}
	return undefined;
}

function packetEntries(entries: readonly SessionEntry[]): Array<CustomEntry<ContextPacket>> {
	return entries.filter(
		(entry): entry is CustomEntry<ContextPacket> =>
			entry.type === "custom" && entry.customType === CONTEXT_PACKET_CUSTOM_TYPE,
	);
}

function injectedEntries(entries: readonly SessionEntry[]): Array<CustomMessageEntry<{ packetId: string }>> {
	return entries.filter(
		(entry): entry is CustomMessageEntry<{ packetId: string }> =>
			entry.type === "custom_message" && entry.customType === CONTEXT_PACKET_MESSAGE_TYPE,
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

	const built = buildContextPacket(
		entries,
		resolved.sessionId,
		"Dogfood final verification prompt",
		packetSettings(resolved),
		{
			query: "Dogfood final verification prompt",
			items: [...resolved.recallItems],
			tokenBudget: resolved.recallMaxTokens,
		},
	);
	if (!built) {
		throw new Error("Context steady dogfood failed to build a final ContextPacket.");
	}

	parentId = appendEntry(entries, {
		type: "custom",
		id: "packet-final",
		parentId,
		timestamp: iso(resolved.turns * 3 + 4),
		customType: CONTEXT_PACKET_CUSTOM_TYPE,
		data: built.packet,
	});
	appendEntry(entries, {
		type: "custom_message",
		id: "packet-final-injected",
		parentId,
		timestamp: iso(resolved.turns * 3 + 5),
		customType: CONTEXT_PACKET_MESSAGE_TYPE,
		content: built.content,
		display: false,
		details: { packetId: built.packet.packetId, digestRefs: built.packet.digestRefs },
		attribution: "agent",
	});

	const digests = digestEntries(entries);
	const checkpoints = checkpointEntries(entries);
	const packets = packetEntries(entries);
	const injected = injectedEntries(entries);
	const packet = finalPacket(entries);
	if (!packet) throw new Error("Context steady dogfood did not persist a final ContextPacket.");

	const layerNames = packet.layers.map(layer => layer.name);
	const llmContext = buildSessionContext(entries);
	const transcriptContext = buildSessionContext(entries, undefined, undefined, { transcript: true });
	const llmHasInjectedPacket = llmContext.messages.some(message =>
		messageContainsContent(message, "<san_context_packet>"),
	);
	const transcriptHasInjectedPacket = transcriptContext.messages.some(message =>
		messageContainsContent(message, "<san_context_packet>"),
	);

	const assertions = [
		assertResult("turn digests", digests.length === resolved.turns, `${digests.length}/${resolved.turns} digests`),
		assertResult("checkpoint exists", checkpoints.length > 0, `${checkpoints.length} checkpoints`),
		assertResult("packet persisted", packets.length === 1, `${packets.length} final packet entries`),
		assertResult("injected message persisted", injected.length === 1, `${injected.length} injected entries`),
		assertResult(
			"packet links injected message",
			injected[0]?.details?.packetId === packet.packetId,
			`packet=${packet.packetId}, injected=${injected[0]?.details?.packetId ?? "none"}`,
		),
		assertResult(
			"stable prefix before dynamic layers",
			layerNames[0] === "stable_checkpoint" && layerNames.at(-1) === "retrieved_context",
			layerNames.join(" -> "),
		),
		assertResult(
			"volatile recall layer",
			packet.layers.some(layer => layer.name === "retrieved_context" && layer.stability === "volatile"),
			JSON.stringify(packet.layers.find(layer => layer.name === "retrieved_context") ?? null),
		),
		assertResult(
			"packet within budget",
			packet.tokenEstimate <= packet.tokenBudget,
			`${packet.tokenEstimate}/${packet.tokenBudget} tokens`,
		),
		assertResult(
			"covered digests trimmed",
			packet.trimDecisions.some(decision => decision.reason === "checkpoint_covered"),
			JSON.stringify(packet.trimDecisions),
		),
		assertResult(
			"active context hides injected packet",
			!llmHasInjectedPacket,
			llmHasInjectedPacket ? "active context includes ContextPacket" : "active context excludes ContextPacket",
		),
		assertResult(
			"transcript retains injected packet",
			transcriptHasInjectedPacket,
			transcriptHasInjectedPacket ? "transcript includes ContextPacket" : "transcript excludes ContextPacket",
		),
	];

	const reportText = buildContextPacketReportText(entries, { count: 1 });
	return {
		ok: assertions.every(assertion => assertion.ok),
		sessionId: resolved.sessionId,
		turns: resolved.turns,
		digests: digests.length,
		checkpoints: checkpoints.length,
		packets: packets.length,
		injectedMessages: injected.length,
		finalPacketId: packet.packetId,
		finalPacketLayers: layerNames,
		finalPacketDigestRefs: packet.digestRefs,
		finalPacketCheckpointRef: packet.checkpointRef,
		finalPacketRecallRefs: packet.recallRefs,
		finalPacketTokenEstimate: packet.tokenEstimate,
		finalPacketTokenBudget: packet.tokenBudget,
		reportText,
		assertions,
	};
}
