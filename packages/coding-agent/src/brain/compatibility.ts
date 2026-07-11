import type { Settings } from "../config/settings";
import { resolveSanBrainRuntimePolicy } from "./runtime-policy";

export interface SanBrainLegacyAutoRetainResolution {
	effective: boolean;
	warning?: string;
}

export function resolveSanBrainLegacyAutoRetain(
	settings: Settings,
	backend: "mnemopi" | "hindsight",
	configured: boolean,
): SanBrainLegacyAutoRetainResolution {
	if (!configured) return { effective: false };
	const runtime = resolveSanBrainRuntimePolicy(settings);
	if (!runtime.enabled) return { effective: true };
	const policy = settings.get("san.brain.compatibility.legacyAutoRetain");
	if (runtime.mode === "projection") {
		return {
			effective: false,
			warning: `San Brain projection mode disabled ${backend}.autoRetain for this session; durable writes must use the Brain outbox.`,
		};
	}
	if (!runtime.legacyAutoRetainAllowed) {
		return {
			effective: false,
			warning: `San Brain compatibility policy blocked ${backend}.autoRetain for this session.`,
		};
	}
	if (policy === "warn") {
		return {
			effective: true,
			warning: `San Brain detected ${backend}.autoRetain=true. Review-only/activation mode keeps it for compatibility; disable it explicitly before dogfooding Brain capture.`,
		};
	}
	return { effective: true };
}
