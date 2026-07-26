import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
		await fs.rm(path.join(agentDir, "brain", "local-memory-receipts"), { recursive: true, force: true });
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
	async save(context, input) {
		return saveLearnedLesson(context.agentDir, context.cwd, input);
	},
	async project(context, input) {
		input.signal?.throwIfAborted();
		const saved = await saveLearnedLesson(context.agentDir, context.cwd, input);
		input.signal?.throwIfAborted();
		if (saved.stored < 1) return saved;
		await Bun.write(
			localProjectionReceiptPath(context.agentDir, input.operationId),
			JSON.stringify({ operationId: input.operationId, appliedAt: new Date().toISOString() }),
		);
		return { ...saved, ids: [input.operationId] };
	},
	async reconcileProjection(context, operationId, signal) {
		signal?.throwIfAborted();
		try {
			const value: unknown = await Bun.file(localProjectionReceiptPath(context.agentDir, operationId)).json();
			if (
				value !== null &&
				typeof value === "object" &&
				"operationId" in value &&
				value.operationId === operationId
			) {
				return { state: "applied", receiptId: operationId };
			}
			return { state: "missing" };
		} catch (error) {
			if (isEnoent(error)) return { state: "missing" };
			throw error;
		}
	},
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
		};
	},
};

function localProjectionReceiptPath(agentDir: string, operationId: string): string {
	return path.join(agentDir, "brain", "local-memory-receipts", `${Bun.hash(operationId).toString(36)}.json`);
}
