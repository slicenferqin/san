/** RPC v2 Agent capability DTOs. */

import type { SourceMeta } from "../../../capability/types";
import type { MCPServerConfig } from "../../../mcp/types";

export type McpScope = "user" | "project";

export interface McpCapabilityItem {
	name: string;
	scope: McpScope;
	config: MCPServerConfig;
	enabled: boolean;
}

export interface AgentCapabilityItem {
	id: string;
	name: string;
	description?: string;
	source: SourceMeta["level"];
	providerId: string;
	enabled: boolean;
}
