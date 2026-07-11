import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { hindsightBackend } from "../hindsight/backend";
import { HindsightApi } from "../hindsight/client";
import type { HindsightConfig } from "../hindsight/config";
import { HindsightSessionState } from "../hindsight/state";
import { localBackend } from "../memory-backend/local-backend";
import { offBackend } from "../memory-backend/off-backend";
import type { MemoryBackend } from "../memory-backend/types";
import { mnemopiBackend } from "../mnemopi/backend";
import type { MnemopiBackendConfig } from "../mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState, setMnemopiSessionState } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { applySanBrainMutation } from "./commands";
import { appendSanBrainProfileCandidate } from "./ledger";
import { runSanBrainProjections } from "./projection";
import { type SanBrainProjectionRecord, SanBrainStore } from "./store";
import type { SanBrainProfileCandidate } from "./types";

export interface SanBrainBackendDogfoodCase {
	backend: "off" | "local" | "mnemopi" | "hindsight";
	ok: boolean;
	recall: string;
	projection: string;
	compensation: string;
	durationMs: number;
}

export interface SanBrainBackendDogfoodSummary {
	ok: boolean;
	cases: SanBrainBackendDogfoodCase[];
}

interface MemoryProjectionProbe {
	projection: SanBrainProjectionRecord;
	repeatedApplied: number;
	undo?: SanBrainProjectionRecord;
}

function matrixProfile(id: string): SanBrainProfileCandidate {
	return {
		schemaVersion: 1,
		candidateId: id,
		scope: { kind: "repo", key: "/dogfood/backend-matrix", resolverVersion: 1 },
		type: "project_fact",
		subject: "backend-matrix",
		predicate: "receipt",
		value: id,
		claimKey: `${id}:claim`,
		dedupeKey: `${id}:dedupe`,
		taskTags: ["backend"],
		confidence: 0.95,
		importance: 0.8,
		independentEvidenceCount: 1,
		sensitivity: "normal",
		evidence: [],
		createdAt: "2026-07-11T00:00:00.000Z",
	};
}

async function probeMemoryProjection(
	agentDir: string,
	backend: MemoryBackend,
	id: string,
	undo: boolean,
): Promise<MemoryProjectionProbe> {
	const manager = SessionManager.inMemory(agentDir);
	const store = new SanBrainStore(path.join(agentDir, `${id}.sqlite`));
	try {
		const candidate = matrixProfile(id);
		appendSanBrainProfileCandidate(manager, candidate);
		store.syncSessionEntries(manager.getSessionId(), manager.getEntries());
		const approval = applySanBrainMutation(store, manager, {
			action: "approve",
			id,
			createdAt: "2026-07-11T00:00:01.000Z",
		});
		const projectionId = approval.decisions[0]?.projectionIds[0];
		if (!projectionId) throw new Error(`Backend matrix ${backend.id} did not plan a memory projection.`);
		await runSanBrainProjections({
			store,
			sessionManager: manager,
			agentDir,
			cwd: agentDir,
			maxAttempts: 3,
			memoryBackend: backend,
		});
		const projection = store.getProjection(projectionId);
		if (!projection) throw new Error(`Backend matrix ${backend.id} projection audit is missing.`);
		const repeated = await runSanBrainProjections({
			store,
			sessionManager: manager,
			agentDir,
			cwd: agentDir,
			maxAttempts: 3,
			memoryBackend: backend,
		});
		if (!undo || projection.state !== "applied") {
			return { projection, repeatedApplied: repeated.applied };
		}
		const undoMutation = applySanBrainMutation(store, manager, {
			action: "undo",
			id,
			createdAt: "2026-07-11T00:00:02.000Z",
		});
		const undoProjectionId = undoMutation.decisions[0]?.projectionIds[0];
		if (!undoProjectionId) throw new Error(`Backend matrix ${backend.id} did not plan memory compensation.`);
		await runSanBrainProjections({
			store,
			sessionManager: manager,
			agentDir,
			cwd: agentDir,
			maxAttempts: 3,
			memoryBackend: backend,
		});
		return { projection, repeatedApplied: repeated.applied, undo: store.getProjection(undoProjectionId) };
	} finally {
		store.close();
	}
}

function mnemopiConfig(dbPath: string): MnemopiBackendConfig {
	return {
		dbPath,
		bank: "brain-m6-matrix",
		retainBank: "brain-m6-matrix",
		recallBanks: ["brain-m6-matrix"],
		scoping: "global",
		autoRecall: false,
		autoRetain: false,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1000,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
			debug: false,
		},
		llmMode: "none",
	};
}

function hindsightConfig(): HindsightConfig {
	return {
		hindsightApiUrl: "http://127.0.0.1:1",
		hindsightApiToken: null,
		bankId: "brain-m6-matrix",
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: false,
		retainMode: "last-turn",
		retainEveryNTurns: 3,
		retainOverlapTurns: 1,
		retainContext: "brain-m6-matrix",
		recallBudget: "mid",
		recallMaxTokens: 1000,
		recallTypes: ["fact", "episodic"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "Controlled M6 matrix memory.",
		debug: false,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 300_000,
		mentalModelMaxRenderChars: 16_000,
	};
}

async function runOffCase(agentDir: string): Promise<SanBrainBackendDogfoodCase> {
	const startedAt = performance.now();
	const status = await offBackend.status!({ agentDir, cwd: agentDir });
	const probe = await probeMemoryProjection(agentDir, offBackend, "matrix-off", false);
	const ok =
		status.searchable === false &&
		offBackend.search === undefined &&
		probe.projection.state === "blocked" &&
		probe.projection.errorCode === "backend_unavailable" &&
		probe.repeatedApplied === 0;
	return {
		backend: "off",
		ok,
		recall: "safe skip (backend unavailable)",
		projection: `${probe.projection.state}:${probe.projection.errorCode}`,
		compensation: "not applicable",
		durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
	};
}

async function runLocalCase(agentDir: string): Promise<SanBrainBackendDogfoodCase> {
	const startedAt = performance.now();
	const status = await localBackend.status!({ agentDir, cwd: agentDir });
	const probe = await probeMemoryProjection(agentDir, localBackend, "matrix-local", true);
	const ok =
		status.searchable === false &&
		localBackend.search === undefined &&
		probe.projection.state === "applied" &&
		Boolean(probe.projection.receiptId) &&
		probe.repeatedApplied === 0 &&
		probe.undo?.state === "blocked" &&
		probe.undo.errorCode === "unsafe_undo";
	return {
		backend: "local",
		ok,
		recall: "search_unsupported",
		projection: `${probe.projection.state}:receipt=${probe.projection.receiptId ? "present" : "missing"}`,
		compensation: `${probe.undo?.state}:${probe.undo?.errorCode}`,
		durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
	};
}

async function runMnemopiCase(agentDir: string): Promise<SanBrainBackendDogfoodCase> {
	const startedAt = performance.now();
	await Promise.all([loadMnemopi(), loadMnemopiCore()]);
	const settings = Settings.isolated({ "memory.backend": "mnemopi", "mnemopi.autoRetain": false });
	const session = {
		sessionId: "brain-m6-mnemopi-matrix",
		settings,
		sessionManager: { getEntries: () => [], getCwd: () => agentDir },
		emitNotice() {},
		getHindsightSessionState: () => undefined,
	} as unknown as AgentSession;
	const state = new MnemopiSessionState({
		sessionId: session.sessionId,
		config: mnemopiConfig(path.join(agentDir, "mnemopi.sqlite")),
		session,
	});
	setMnemopiSessionState(session, state);
	const context = { agentDir, cwd: agentDir, session };
	try {
		const first = await mnemopiBackend.project!(context, {
			content: "M6 backend matrix scoped receipt alpha",
			context: "repo:/matrix/alpha",
			operationId: "m6-mnemopi-alpha",
		});
		await mnemopiBackend.project!(context, {
			content: "M6 backend matrix scoped receipt beta",
			context: "repo:/matrix/beta",
			operationId: "m6-mnemopi-beta",
		});
		const receipt = await mnemopiBackend.reconcileProjection!(context, "m6-mnemopi-alpha");
		const missing = await mnemopiBackend.reconcileProjection!(context, "m6-mnemopi-missing");
		const search = await mnemopiBackend.search!(context, "M6 backend matrix scoped receipt", { limit: 10 });
		const alpha = search.items.filter(item => item.scope === "repo:/matrix/alpha");
		const beta = search.items.filter(item => item.scope === "repo:/matrix/beta");
		const compensated = await mnemopiBackend.compensateProjection!(context, "m6-mnemopi-alpha");
		const afterUndo = await mnemopiBackend.reconcileProjection!(context, "m6-mnemopi-alpha");
		const ok =
			state.config.autoRetain === false &&
			first.stored === 1 &&
			receipt.state === "applied" &&
			missing.state === "missing" &&
			alpha.length >= 1 &&
			beta.length >= 1 &&
			compensated.state === "compensated" &&
			afterUndo.state === "missing";
		return {
			backend: "mnemopi",
			ok,
			recall: `structured=${search.count}, alpha=${alpha.length}, beta=${beta.length}`,
			projection: `${receipt.state}:receipt=${receipt.receiptId ? "present" : "missing"}; missing=${missing.state}`,
			compensation: `${compensated.state}; reconcile=${afterUndo.state}`,
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
		};
	} finally {
		setMnemopiSessionState(session, undefined);
		await state.dispose({ consolidate: false });
	}
}

async function runHindsightCase(agentDir: string): Promise<SanBrainBackendDogfoodCase> {
	const startedAt = performance.now();
	const client = new HindsightApi({ baseUrl: "http://127.0.0.1:1" });
	const documents = new Map<string, { content: string; context?: string }>();
	let controlledFailure = false;
	let observedTypes: string[] = [];
	client.retain = async (_bankId, content, options) => {
		if (options?.documentId) documents.set(options.documentId, { content, context: options.context });
		return {};
	};
	client.recall = async (_bankId, _query, options) => {
		if (controlledFailure) throw new Error("controlled Hindsight outage");
		observedTypes = options?.types ?? [];
		return {
			results: [
				{
					id: "hindsight-matrix-memory",
					text: "M6 Hindsight scoped recall",
					type: "fact",
					context: "repo:/matrix/hindsight",
					score: 0.97,
				},
			],
		};
	};
	client.getDocument = async (_bankId, documentId) => documents.get(documentId) ?? null;
	client.deleteDocument = async (_bankId, documentId) => documents.delete(documentId);

	const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.autoRetain": false });
	let state: HindsightSessionState | undefined;
	const session = {
		sessionId: "brain-m6-hindsight-matrix",
		settings,
		sessionManager: { getEntries: () => [], getCwd: () => agentDir },
		emitNotice() {},
		getHindsightSessionState: () => state,
		setHindsightSessionState(next: HindsightSessionState | undefined) {
			const previous = state;
			state = next;
			return previous;
		},
	} as unknown as AgentSession;
	state = new HindsightSessionState({
		sessionId: session.sessionId,
		client,
		bankId: "brain-m6-matrix",
		config: hindsightConfig(),
		session,
		banksSet: new Set(),
	});
	const context = { agentDir, cwd: agentDir, session };
	try {
		const search = await hindsightBackend.search!(context, "M6 Hindsight", {
			limit: 3,
			maxTokens: 1000,
			memoryTypes: ["fact", "episodic"],
		});
		const projected = await hindsightBackend.project!(context, {
			content: "M6 Hindsight projection",
			context: "repo:/matrix/hindsight",
			operationId: "m6-hindsight-operation",
		});
		const receipt = await hindsightBackend.reconcileProjection!(context, "m6-hindsight-operation");
		const compensated = await hindsightBackend.compensateProjection!(context, "m6-hindsight-operation");
		const afterUndo = await hindsightBackend.reconcileProjection!(context, "m6-hindsight-operation");
		controlledFailure = true;
		let failureContinued = false;
		try {
			await hindsightBackend.search!(context, "controlled outage");
		} catch {
			failureContinued = true;
		}
		const ok =
			state.config.autoRetain === false &&
			search.count === 1 &&
			search.items[0]?.scope === "repo:/matrix/hindsight" &&
			observedTypes.join(",") === "fact,episodic" &&
			projected.stored === 1 &&
			receipt.state === "applied" &&
			compensated.state === "compensated" &&
			afterUndo.state === "missing" &&
			failureContinued;
		return {
			backend: "hindsight",
			ok,
			recall: `structured=${search.count}; controlled-unavailable=${failureContinued ? "continued" : "failed"}`,
			projection: `${receipt.state}:receipt=${receipt.receiptId ? "present" : "missing"}`,
			compensation: `${compensated.state}; reconcile=${afterUndo.state}`,
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
		};
	} finally {
		state.retainQueue.dispose();
	}
}

export async function runSanBrainBackendDogfood(): Promise<SanBrainBackendDogfoodSummary> {
	await using tempDir = await TempDir.create("@san-brain-m6-backend-matrix-");
	const cases = [
		await runOffCase(tempDir.join("off")),
		await runLocalCase(tempDir.join("local")),
		await runMnemopiCase(tempDir.join("mnemopi")),
		await runHindsightCase(tempDir.join("hindsight")),
	];
	return { ok: cases.every(item => item.ok), cases };
}
