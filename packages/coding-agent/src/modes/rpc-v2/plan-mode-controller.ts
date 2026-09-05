/**
 * RPC v2 plan mode controller.
 *
 * Session-layer twin of InteractiveMode's plan mode (#enterPlanMode /
 * #exitPlanMode / #handlePlanProposal), minus the terminal-only concerns
 * (status line, plan-role model slider, mode persistence). The read-only
 * guarantee itself lives in the session: plan-mode-guard.ts gates write/edit
 * on getPlanModeState().enabled, and the agent loop injects the
 * plan-mode-active instructions and forces an ask/propose decision at settle.
 * This controller only has to:
 *
 *   enter  — save the tool set, ensure built-in `write` is active (the plan
 *            file and the xd://propose dispatch are writes), mark plan-mode
 *            state, register the proposal handler, and notify the client.
 *   exit   — restore the tool set, clear state/handler, notify the client.
 *   propose— validate the plan file, present it to the user as a recoverable
 *            interaction, and translate the decision into a tool result that
 *            steers the model (approve → exit + implement; refine → feedback;
 *            exit → leave plan mode without implementing).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@san/agent";
import { resolveLocalUrlToPath } from "../../internal-urls";
import { resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { normalizeLocalScheme } from "../../tools/path-utils";
import { ToolError } from "../../tools/tool-errors";
import type { RpcV2UIContext } from "./ui-context";

/** Minimal session surface the controller needs — satisfied by AgentSession. */
interface PlanModeSession {
	isStreaming: boolean;
	getEnabledToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	setActiveToolsByName(names: string[]): Promise<void>;
	getPlanModeState(): { enabled: boolean; planFilePath: string } | undefined;
	setPlanModeState(state: { enabled: boolean; planFilePath: string; workflow: "parallel" } | undefined): void;
	setPlanProposalHandler(handler: ((title: string) => Promise<AgentToolResult<unknown>>) | null): void;
	sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
	sessionManager: {
		getArtifactsDir(): string | null;
		getSessionId(): string | null;
		getCwd(): string;
	};
}

export interface PlanModeControllerDeps {
	getUIContext: () => RpcV2UIContext | undefined;
	/** Emits planMode.changed so clients track the toggle live. */
	emit: (data: { enabled: boolean }) => void;
}

const PLAN_OPTIONS = [
	{ id: "approve", label: "批准并执行", description: "退出计划模式，按方案实施" },
	{ id: "refine", label: "继续讨论", description: "附反馈意见，让模型修改方案" },
	{ id: "exit", label: "退出计划模式", description: "不采纳方案，恢复正常模式" },
];

export class PlanModeController {
	#deps: PlanModeControllerDeps;
	#previousTools = new Map<string, string[]>();

	constructor(deps: PlanModeControllerDeps) {
		this.#deps = deps;
	}

	isEnabled(session: PlanModeSession): boolean {
		return session.getPlanModeState()?.enabled === true;
	}

	async enter(sessionKey: string, session: PlanModeSession): Promise<void> {
		if (this.isEnabled(session)) return;
		const previousTools = session.getEnabledToolNames();
		// Same augmentation rule as InteractiveMode: only re-activate the
		// built-in write tool; a shadowing extension `write` must stay inactive
		// or the read-only guarantee is gone.
		const augmentations = session.hasBuiltInTool("write") ? ["write"] : [];
		this.#previousTools.set(sessionKey, previousTools);
		await session.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });
		session.setPlanProposalHandler(title => this.#handleProposal(sessionKey, session, title));
		if (session.isStreaming) {
			await session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#deps.emit({ enabled: true });
	}

	async exit(sessionKey: string, session: PlanModeSession): Promise<void> {
		if (!this.isEnabled(session)) return;
		const previousTools = this.#previousTools.get(sessionKey);
		session.setPlanModeState(undefined);
		try {
			if (previousTools) {
				await session.setActiveToolsByName(previousTools);
			}
		} finally {
			this.#previousTools.delete(sessionKey);
			session.setPlanProposalHandler(null);
			this.#deps.emit({ enabled: false });
		}
	}

	async #handleProposal(
		sessionKey: string,
		session: PlanModeSession,
		suppliedTitle: string,
	): Promise<AgentToolResult<unknown>> {
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const { planFilePath, title } = await resolveApprovedPlan({
			suppliedTitle,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readPlanFile(session, url),
			listPlanFiles: () => this.#listLocalPlanFiles(session),
		});
		const content = (await this.#readPlanFile(session, planFilePath)) ?? "";
		const ui = this.#deps.getUIContext();
		if (!ui) {
			throw new ToolError("Plan review requires a connected UI client.");
		}
		const decision = await ui.requestPlanDecision({
			title: `方案待审批：${title}`,
			planFilePath,
			planTitle: title,
			content,
			options: PLAN_OPTIONS,
		});
		if (!decision) {
			return {
				content: [
					{
						type: "text" as const,
						text: "The user dismissed the plan review without deciding. Stay in plan mode and wait for further direction — do not propose again unprompted.",
					},
				],
				details: { planFilePath, title, planExists: true },
			};
		}
		if (decision.optionId === "approve") {
			await this.exit(sessionKey, session);
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan approved by the user. Plan mode is now off and your full toolset is restored. Implement the plan at ${planFilePath} now.`,
					},
				],
				details: { planFilePath, title, planExists: true },
			};
		}
		if (decision.optionId === "refine") {
			const feedback = decision.feedback?.trim();
			return {
				content: [
					{
						type: "text" as const,
						text: feedback
							? `The user requests changes to the plan:\n\n${feedback}\n\nUpdate ${planFilePath} accordingly and propose again.`
							: "The user wants to discuss the plan before approving. Ask what should change via the ask tool, then update the plan and propose again.",
					},
				],
				details: { planFilePath, title, planExists: true, feedback },
			};
		}
		// "exit"
		await this.exit(sessionKey, session);
		return {
			content: [
				{
					type: "text" as const,
					text: "The user exited plan mode without approving the plan. Do not implement it; wait for the user's next instruction.",
				},
			],
			details: { planFilePath, title, planExists: true },
		};
	}

	#resolvePlanFilePath(session: PlanModeSession, planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			return resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
		}
		return path.resolve(session.sessionManager.getCwd(), planFilePath);
	}

	async #readPlanFile(session: PlanModeSession, planFilePath: string): Promise<string | null> {
		try {
			return await fs.promises.readFile(this.#resolvePlanFilePath(session, planFilePath), "utf8");
		} catch {
			return null;
		}
	}

	async #listLocalPlanFiles(session: PlanModeSession): Promise<string[]> {
		const localRoot = this.#resolvePlanFilePath(session, "local://");
		try {
			const entries = await fs.promises.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.promises.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}
}
