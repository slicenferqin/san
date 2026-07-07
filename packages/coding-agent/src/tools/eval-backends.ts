import { $flag } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	ruby: boolean;
	julia: boolean;
}

/** Read per-backend allowance from settings (py/js default on; rb/jl opt-in, default off). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
		ruby: session.settings.get("eval.rb") ?? false,
		julia: session.settings.get("eval.jl") ?? false,
	};
}

/**
 * Materialize the active eval backend allowance: SAN_PY / SAN_JS / SAN_RB / SAN_JL
 * env flags override the per-key settings; legacy PI_* aliases remain accepted.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("SAN_PY", $flag("PI_PY", settings.python)),
		js: $flag("SAN_JS", $flag("PI_JS", settings.js)),
		ruby: $flag("SAN_RB", $flag("PI_RB", settings.ruby)),
		julia: $flag("SAN_JL", $flag("PI_JL", settings.julia)),
	};
}
