import { logger } from "@san/utils";
import { appendSanBrainRecallAudit } from "../brain/ledger";
import type { SanBrainRecallPlan } from "../brain/recall";
import type { SanBrainProjectionErrorCode, SanBrainRecallOutcome } from "../brain/types";
import type { MemoryBackend, MemoryBackendId, MemoryBackendOperationContext } from "../memory-backend/types";
import type { ReadonlySessionManager } from "../session/session-manager";
import { mergeContextSteadyRecallItems, normalizeContextSteadyRecallItems } from "./recall";
import type { ContextPacketRecallLayer, ContextRecallItem } from "./types";

export interface RunContextSteadyRecallOptions {
	baseQuery: string;
	localItems: readonly ContextRecallItem[];
	plan: SanBrainRecallPlan;
	configuredBackend: MemoryBackendId;
	resolveBackend: () => Promise<MemoryBackend>;
	backendContext: MemoryBackendOperationContext;
	sessionManager: ReadonlySessionManager;
	sessionId: string;
	turnId: string;
}

export async function runContextSteadyRecall(
	options: RunContextSteadyRecallOptions,
): Promise<ContextPacketRecallLayer | undefined> {
	const metadata = {
		tokenBudget: options.plan.tokenBudget,
		policyVersion: options.plan.policyVersion,
		selectedPolicyIds: options.plan.selectedPolicyIds,
		...(options.plan.queryTemplateId ? { queryTemplateId: options.plan.queryTemplateId } : {}),
		skipReasons: options.plan.skipReasons,
	};
	const audit = (
		backend: MemoryBackendId,
		outcome: SanBrainRecallOutcome,
		resultCount: number,
		durationMs: number,
		errorCode?: SanBrainProjectionErrorCode,
	): void => {
		appendSanBrainRecallAudit(options.sessionManager, {
			schemaVersion: 1,
			recallId: `brain_recall_${Bun.randomUUIDv7()}`,
			sessionId: options.sessionId,
			turnId: options.turnId,
			policyVersion: options.plan.policyVersion,
			selectedPolicyIds: options.plan.selectedPolicyIds,
			...(options.plan.queryTemplateId ? { queryTemplateId: options.plan.queryTemplateId } : {}),
			backend,
			outcome,
			resultCount,
			durationMs,
			skipReasons: options.plan.skipReasons,
			...(errorCode ? { errorCode } : {}),
			createdAt: new Date().toISOString(),
		});
	};
	const localItems = normalizeContextSteadyRecallItems(options.localItems, {
		maxItems: options.plan.maxItems,
		maxTokens: options.plan.tokenBudget,
	});
	if (!options.plan.query) {
		audit(options.configuredBackend, "suppressed", localItems.length, 0);
		return localItems.length > 0 ? { query: options.baseQuery, items: localItems, ...metadata } : undefined;
	}

	const backend = await options.resolveBackend();
	if (!backend.search) {
		const outcome = backend.id === "off" ? "backend_unavailable" : "search_unsupported";
		const errorCode: SanBrainProjectionErrorCode = outcome;
		audit(backend.id, outcome, localItems.length, 0, errorCode);
		return localItems.length > 0 ? { query: options.baseQuery, items: localItems, ...metadata } : undefined;
	}

	const startedAt = performance.now();
	try {
		const result = await backend.search(options.backendContext, options.plan.query, {
			limit: options.plan.maxItems,
			maxTokens: options.plan.tokenBudget,
			memoryTypes: options.plan.memoryTypes,
			scopeKeys: options.plan.scopeKeys,
		});
		const backendItems = normalizeContextSteadyRecallItems(result.items, {
			maxItems: options.plan.maxItems,
			maxTokens: options.plan.tokenBudget,
			memoryTypes: options.plan.memoryTypes,
			scopeKeys: options.plan.scopeKeys,
		});
		const items = mergeContextSteadyRecallItems(backendItems, localItems, {
			maxItems: options.plan.maxItems,
			maxTokens: options.plan.tokenBudget,
		});
		audit(backend.id, "applied", items.length, Math.max(0, Math.round(performance.now() - startedAt)));
		return items.length > 0 ? { query: result.query, items, ...metadata } : undefined;
	} catch (error) {
		audit(
			backend.id,
			"failed",
			localItems.length,
			Math.max(0, Math.round(performance.now() - startedAt)),
			"external_failure",
		);
		logger.debug("San context steady recall failed", { backend: backend.id, error: String(error) });
		return localItems.length > 0 ? { query: options.baseQuery, items: localItems, ...metadata } : undefined;
	}
}
