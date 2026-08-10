/**
 * Session handoff tool — proactively summarize the CURRENT session and push
 * the document to a target `san:*` session (another San runtime on this
 * machine) so work continues there.
 *
 * `hub` remains the discovery/transport base: exact target ids come from
 * `hub op:"list"`, and follow-up coordination stays in hub messaging. This
 * tool adds the model-generated handoff document on top — the caller never
 * supplies the summary body itself.
 *
 * Root sessions only: a subagent must not expose a capability that
 * summarizes and pushes the whole conversation.
 */
import type { AgentTool, AgentToolResult } from "@san/agent";
import { type } from "arktype";
import { type CrossSessionDeliveryReceipt, PEERS_ID_PATTERN } from "../peer";
import sessionHandoffDescription from "../prompts/tools/session-handoff.md" with { type: "text" };
import type { ToolSession } from ".";

const sessionHandoffSchema = type({
	to: type("string").describe(
		'exact target session id from `hub op:"list"` — the precise `san:<12 lowercase hex>` id of another runtime',
	),
	"focus?": type("string").describe("optional focus steering what the generated handoff summary emphasizes"),
});

export type SessionHandoffParams = typeof sessionHandoffSchema.infer;

/** Result details: delivery receipt shape (`to` + outcome), with `error` on failure. */
export interface SessionHandoffDetails {
	to: string;
	outcome: CrossSessionDeliveryReceipt["outcome"];
	error?: string;
}

export class SessionHandoffTool implements AgentTool<typeof sessionHandoffSchema, SessionHandoffDetails> {
	readonly name = "session_handoff";
	readonly approval = "read" as const;
	readonly label = "Session Handoff";
	readonly summary = "Summarize the current session and push it to a target san:* session";
	readonly description = sessionHandoffDescription;
	readonly parameters = sessionHandoffSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SessionHandoffTool | null {
		// Root sessions only (`taskDepth` 0). Subagents must never expose a tool
		// that summarizes and pushes the whole parent conversation.
		if ((session.taskDepth ?? 0) !== 0) return null;
		return new SessionHandoffTool(session);
	}

	async execute(
		_toolCallId: string,
		params: SessionHandoffParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SessionHandoffDetails>> {
		const client = this.session.crossSessionClient;
		if (!client) {
			return this.#error(params, "Cross-session transport is unavailable in this session.");
		}
		const generate = this.session.generateSessionHandoff;
		if (!generate) {
			return this.#error(params, "Handoff generation is unavailable in this session.");
		}
		const to = params.to.trim();
		if (!PEERS_ID_PATTERN.test(to)) {
			return this.#error(
				params,
				`Invalid target "${to}": expected the exact \`san:<12 lowercase hex>\` id of another runtime from hub op:"list".`,
			);
		}
		if (to === client.id) {
			return this.#error(params, "Cannot hand off to this session itself.");
		}

		// The summary always comes from the session's own generator — there is
		// no body/message parameter, so callers can never pass a hand-written
		// summary. The transport's 64 KiB body cap applies; failures surface
		// as error results instead of silent truncation.
		let document: string | undefined;
		try {
			document = await generate(params.focus?.trim() || undefined, signal);
		} catch (error) {
			return this.#error(params, errorMessage(error));
		}
		if (!document) {
			return this.#error(params, "Handoff generation produced no summary.");
		}

		try {
			const receipt = await client.send({ to, body: document, kind: "handoff" }, signal);
			if (receipt.outcome === "failed") {
				return {
					content: [
						{
							type: "text",
							text: `Handoff to ${to} failed: ${receipt.error ?? "unknown transport error"}`,
						},
					],
					details: { to, outcome: "failed", error: receipt.error },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Handoff delivered to ${to} (${receipt.outcome}).` }],
				details: { to, outcome: receipt.outcome },
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: `Handoff to ${to} failed: ${errorMessage(error)}` }],
				details: { to, outcome: "failed", error: errorMessage(error) },
				isError: true,
			};
		}
	}

	#error(params: SessionHandoffParams, text: string): AgentToolResult<SessionHandoffDetails> {
		return {
			content: [{ type: "text", text }],
			details: { to: params.to, outcome: "failed" },
			isError: true,
		};
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
