/**
 * TurnDigest orchestration: input collection and fallback digest.
 *
 * M1 only uses the deterministic fallback path. LLM-based digest will be
 * added in a future milestone when summary model resolution is stable.
 *
 * Digest generation is a side request — it never touches the main agent loop,
 * never appends messages to the session, and never triggers new agent_end events.
 */

import { logger } from "@oh-my-pi/pi-utils";

import type { Settings } from "../config/settings";
import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import { generateFallbackDigest, generateTurnId } from "./fallback";
import { appendTurnDigest, hasExistingDigest } from "./session";
import type { ContextSteadySettings, TurnDigest, TurnDigestSource } from "./types";

/**
 * Generate and persist a TurnDigest for a settled turn.
 *
 * M1: always uses deterministic fallback. The LLM path is reserved for later.
 * The caller (#generateTurnDigest in agent-session.ts) checks
 * `persistFallback` before this is reached, so this function can assume M1
 * always persists fallback digests when called.
 *
 * Never throws — errors are logged to the session manager's logger but
 * never propagate to the caller.
 */
export async function generateDigest(
	messages: readonly unknown[],
	source: TurnDigestSource,
	sessionManager: ReadonlySessionManager,
	_settings: Settings,
	steadySettings: ContextSteadySettings,
	_summaryModel?: string,
): Promise<void> {
	if (!steadySettings.enabled || !steadySettings.digest.enabled) return;

	// Dedupe: skip if this source range already has a digest
	const entries = (
		sessionManager as unknown as { getEntries(): Array<Record<string, unknown>> }
	).getEntries() as unknown as readonly SessionEntry[];
	if (hasExistingDigest(entries, source)) return;

	const turnId = generateTurnId();
	const sessionId = source.sessionId;

	// Always use fallback digest for M1
	const digest: TurnDigest = generateFallbackDigest(
		messages as Parameters<typeof generateFallbackDigest>[0],
		source,
		turnId,
		sessionId,
	);

	// Persist the digest
	try {
		appendTurnDigest(sessionManager, digest);
		logger.debug("TurnDigest persisted", {
			turnId: digest.turnId,
			fallback: digest.fallback,
			sessionId: digest.sessionId,
			fromEntryId: source.fromEntryId,
			toEntryId: source.toEntryId,
		});
	} catch (err) {
		logger.warn("Failed to persist TurnDigest", { error: String(err), sessionId: digest.sessionId });
	}
}
