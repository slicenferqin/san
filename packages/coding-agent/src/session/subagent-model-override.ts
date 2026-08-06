import { ThinkingLevel } from "@san/agent";
import type { Model } from "@san/ai";
import { getSupportedEfforts } from "@san/catalog/model-thinking";
import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

export const SUBAGENT_MODEL_OVERRIDE_CUSTOM_TYPE = "subagent_model_override";
export const SUBAGENT_MODEL_OVERRIDE_ROLE = "task";

export interface SubagentModelOverrideData {
	role: typeof SUBAGENT_MODEL_OVERRIDE_ROLE;
	selector: string | null;
}

export type SubagentModelSelectorResolution =
	| {
			ok: true;
			selector: string;
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
	  }
	| { ok: false; error: string };

function isSubagentModelOverrideData(value: unknown): value is SubagentModelOverrideData {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	return (
		data.role === SUBAGENT_MODEL_OVERRIDE_ROLE &&
		(data.selector === null || (typeof data.selector === "string" && data.selector.trim().length > 0))
	);
}

/** Resolve the task-role override in force at the current branch leaf. */
export function getSessionSubagentModelOverride(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== SUBAGENT_MODEL_OVERRIDE_CUSTOM_TYPE ||
			!isSubagentModelOverrideData(entry.data)
		) {
			continue;
		}
		return entry.data.selector?.trim() || undefined;
	}
	return undefined;
}

/** Append a session-local task-role override; null explicitly clears older branch state. */
export function appendSessionSubagentModelOverride(sessionManager: SessionManager, selector: string | null): string {
	const normalized = selector?.trim() ?? null;
	if (selector !== null && !normalized) {
		throw new Error("Subagent model selector cannot be empty");
	}
	return sessionManager.appendCustomEntry(SUBAGENT_MODEL_OVERRIDE_CUSTOM_TYPE, {
		role: SUBAGENT_MODEL_OVERRIDE_ROLE,
		selector: normalized,
	} satisfies SubagentModelOverrideData);
}

function supportedEffortLabel(model: Model): string {
	const efforts = getSupportedEfforts(model);
	return efforts.length > 0 ? efforts.join(", ") : "none";
}

/** Resolve and canonicalize a user-provided selector without silently clamping explicit effort. */
export function resolveSessionSubagentModelSelector(
	input: string,
	availableModels: readonly Model[],
	settings: Settings,
): SubagentModelSelectorResolution {
	const requestedSelector = input.trim();
	if (!requestedSelector) return { ok: false, error: "Model selector cannot be empty." };

	const literalMatch = availableModels.some(model => `${model.provider}/${model.id}` === requestedSelector);
	if (requestedSelector.endsWith(`:${AUTO_THINKING}`) && !literalMatch) {
		return {
			ok: false,
			error: "Auto effort cannot be stored in a subagent model selector; choose a concrete effort.",
		};
	}

	const models = [...availableModels];
	const resolved = resolveModelRoleValue(requestedSelector, models, { settings });
	if (!resolved.model) {
		return {
			ok: false,
			error: resolved.warning ?? `Unknown model selector: ${requestedSelector}`,
		};
	}

	const requestedThinkingLevel = extractExplicitThinkingSelector(requestedSelector, settings, {
		isLiteralModelId: (provider, id) => models.some(model => model.provider === provider && model.id === id),
	});
	if (requestedThinkingLevel === AUTO_THINKING) {
		return {
			ok: false,
			error: "Auto effort cannot be stored in a subagent model selector; choose a concrete effort.",
		};
	}
	if (
		requestedThinkingLevel !== undefined &&
		requestedThinkingLevel !== ThinkingLevel.Off &&
		requestedThinkingLevel !== ThinkingLevel.Inherit &&
		!getSupportedEfforts(resolved.model).includes(requestedThinkingLevel)
	) {
		return {
			ok: false,
			error: `Model ${resolved.model.provider}/${resolved.model.id} does not support effort ${requestedThinkingLevel}. Supported: ${supportedEffortLabel(resolved.model)}.`,
		};
	}

	const thinkingLevel = resolved.explicitThinkingLevel
		? (requestedThinkingLevel ?? resolved.thinkingLevel)
		: undefined;
	return {
		ok: true,
		selector: formatModelSelectorValue(formatModelStringWithRouting(resolved.model), thinkingLevel),
		model: resolved.model,
		thinkingLevel,
	};
}
