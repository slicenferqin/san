import type { AgentToolContext, ToolCallContext } from "@san/agent";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";

declare module "@san/agent" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		toolCall?: ToolCallContext;
		/** Queue source visibility until the main provider projection is final. */
		deferOutputProvenance?(toolCallId: string, commit: (deliveredText: string) => void): void;
		/** Set on `xd://` device dispatches: the write tool's outer approval gate
		 *  already resolved this call at the mounted tool's tier, so the inner
		 *  wrapper must not re-prompt for the same action (explicit per-tool
		 *  policies and overrides still apply). */
		xdevApproved?: boolean;
		/** Reports the effective tier after an extension wrapper resolves approval. */
		xdevTierResolved?(tier: "read" | "write" | "exec"): void;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];

	constructor(
		private readonly getBaseContext: () => CustomToolContext,
		private readonly deferOutputProvenance?: AgentToolContext["deferOutputProvenance"],
	) {}

	getContext(toolCall?: ToolCallContext, deferOutputProvenance = false): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			deferOutputProvenance: deferOutputProvenance ? this.deferOutputProvenance : undefined,
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
