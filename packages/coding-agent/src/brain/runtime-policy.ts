import type { Settings } from "../config/settings";

export type SanBrainMode = "review-only" | "activation" | "projection";

export interface SanBrainRuntimePolicy {
	enabled: boolean;
	mode: SanBrainMode;
	captureEnabled: boolean;
	activationEnabled: boolean;
	projectionEnabled: boolean;
	legacyAutoRetainAllowed: boolean;
}

export function resolveSanBrainRuntimePolicy(settings: Settings): SanBrainRuntimePolicy {
	const enabled = settings.get("san.brain.enabled") === true;
	const mode = settings.get("san.brain.mode");
	const compatibility = settings.get("san.brain.compatibility.legacyAutoRetain");
	return {
		enabled,
		mode,
		captureEnabled: enabled && settings.get("san.brain.capture.enabled") === true,
		activationEnabled: enabled && (mode === "activation" || mode === "projection"),
		projectionEnabled: enabled && mode === "projection" && settings.get("san.brain.projections.enabled") === true,
		legacyAutoRetainAllowed: !enabled || (mode !== "projection" && compatibility !== "block"),
	};
}
