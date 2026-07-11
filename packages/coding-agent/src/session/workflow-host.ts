import type { ToolSession } from "../tools";
import type { AgentSession } from "./agent-session";

const WORKFLOW_TOOL_SESSIONS = new WeakMap<AgentSession, ToolSession>();

/** Register the host capability object without exposing it on the public AgentSession API. */
export function registerWorkflowToolSession(session: AgentSession, toolSession: ToolSession): void {
	WORKFLOW_TOOL_SESSIONS.set(session, toolSession);
}

/** Internal slash-command bridge lookup; the capability remains scoped to the owning session. */
export function getWorkflowToolSession(session: AgentSession): ToolSession | undefined {
	return WORKFLOW_TOOL_SESSIONS.get(session);
}
