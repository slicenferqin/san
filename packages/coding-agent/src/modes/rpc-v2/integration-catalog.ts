import * as path from "node:path";
import { readMCPConfigFile, updateMCPServer } from "../../mcp/config-writer";
import type { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";
import type { IntegrationSummary } from "./dto/integration";
import type { IntegrationId } from "./protocol/ids";
import type { RpcV2SessionHandle } from "./session-manager";

type OutputFn = (type: "integration.changed" | "integration.health.changed", data: Record<string, unknown>) => void;

/** 当前 Session 的 Skill、MCP 与 Extension 权威目录。 */
export class RpcV2IntegrationCatalog {
	#session: AgentSession | undefined;
	#mcpManager: MCPManager | undefined;
	#output: OutputFn | undefined;
	#revision = 1;

	bind(handle: RpcV2SessionHandle, output: OutputFn): void {
		this.#session = handle.session;
		this.#mcpManager = handle.mcpManager;
		this.#output = output;
		this.#revision++;
	}

	list(params: { kinds?: string[]; statuses?: string[]; cursor?: string; limit?: number } = {}): {
		integrations: IntegrationSummary[];
		revision: number;
		nextCursor: string | null;
	} {
		let integrations = this.#collect();
		if (params.kinds?.length) integrations = integrations.filter(item => params.kinds?.includes(item.kind));
		if (params.statuses?.length)
			integrations = integrations.filter(item => params.statuses?.includes(item.health.status));
		const offset = decodeCursor(params.cursor);
		const limit = params.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Integration page limit must be from 1 to 100");
		const page = integrations.slice(offset, offset + limit);
		return {
			integrations: page,
			revision: this.#revision,
			nextCursor: offset + page.length < integrations.length ? encodeCursor(offset + page.length) : null,
		};
	}

	get(integrationId: string): Record<string, unknown> | undefined {
		const integration = this.#collect().find(item => item.integrationId === integrationId);
		if (!integration) return undefined;
		return {
			...integration,
			managementActions: integration.mutable ? ["set_enabled", "refresh"] : ["refresh"],
			recentErrors: [],
		};
	}

	async setEnabled(params: {
		integrationId: string;
		enabled: boolean;
		expectedRevision?: number;
	}): Promise<Record<string, unknown>> {
		this.#assertRevision(params.expectedRevision);
		const parsed = parseIntegrationId(params.integrationId);
		if (parsed.kind !== "mcp") throw new Error(`Integration is immutable: ${params.integrationId}`);
		const manager = this.#mcpManager;
		if (!manager) throw new Error("MCP manager is unavailable for this Session");
		const source = manager.getSource(parsed.name);
		const config = manager.getServerConfig(parsed.name);
		if (source?.provider !== "native" || !config) {
			throw new Error(`Only MCP integrations from San native configuration are mutable: ${params.integrationId}`);
		}
		const file = await readMCPConfigFile(source.path);
		const stored = file.mcpServers?.[parsed.name];
		if (!stored) throw new Error(`MCP integration is missing from ${source.path}: ${parsed.name}`);
		await updateMCPServer(source.path, parsed.name, { ...stored, enabled: params.enabled } as MCPServerConfig);
		if (!params.enabled) {
			await manager.disconnectServer(parsed.name);
		} else if (manager.getConnectionStatus(parsed.name) !== "connected") {
			await manager.discoverAndConnect();
		}
		this.#revision++;
		const integration = this.#collect().find(item => item.integrationId === params.integrationId) ?? {
			schemaVersion: 1 as const,
			integrationId: params.integrationId as IntegrationId,
			kind: "mcp" as const,
			name: parsed.name,
			displayName: parsed.name,
			source: source.level === "project" ? ("workspace" as const) : ("user" as const),
			enabled: params.enabled,
			mutable: true,
			revision: this.#revision,
			effect: "immediate" as const,
			health: { status: params.enabled ? ("unknown" as const) : ("unknown" as const) },
			auth: { status: "not_required" as const },
		};
		const result = {
			...integration,
			enabled: params.enabled,
			revision: this.#revision,
			effect: "immediate" as const,
		};
		this.#output?.("integration.changed", {
			integration: result,
			action: "enabled_changed",
			revision: this.#revision,
		});
		return result;
	}

	async refresh(integrationId?: string): Promise<{ refreshed: string[]; revision: number }> {
		const manager = this.#mcpManager;
		const refreshed: string[] = [];
		if (integrationId) {
			const parsed = parseIntegrationId(integrationId);
			if (parsed.kind === "mcp") {
				if (!manager) throw new Error("MCP manager is unavailable for this Session");
				if (!manager.getAllServerNames().includes(parsed.name))
					throw new Error(`MCP integration not found: ${parsed.name}`);
				await manager.refreshServerTools(parsed.name);
				refreshed.push(integrationId);
			} else if (this.get(integrationId)) {
				refreshed.push(integrationId);
			} else {
				throw new Error(`Integration not found: ${integrationId}`);
			}
		} else {
			if (manager) await manager.refreshAllTools();
			refreshed.push(...this.#collect().map(item => item.integrationId));
		}
		this.#revision++;
		for (const id of refreshed) {
			const integration = this.get(id);
			if (integration) this.#output?.("integration.health.changed", { integration, revision: this.#revision });
		}
		return { refreshed, revision: this.#revision };
	}

	#collect(): IntegrationSummary[] {
		const session = this.#session;
		if (!session) return [];
		const integrations: IntegrationSummary[] = [];
		for (const skill of session.skills) {
			integrations.push({
				schemaVersion: 1,
				integrationId: `skill:${encodeURIComponent(skill.name)}` as IntegrationId,
				kind: "skill",
				name: skill.name,
				displayName: skill.name,
				source: sourceKind(skill._source?.level, skill.source),
				enabled: true,
				mutable: false,
				revision: this.#revision,
				effect: "restart_required",
				health: { status: "healthy" },
				auth: { status: "not_required" },
			});
		}

		const runner = session.extensionRunner;
		if (runner) {
			const toolsByPath = new Map<string, Array<{ name: string; description?: string }>>();
			for (const tool of runner.getAllRegisteredTools()) {
				const tools = toolsByPath.get(tool.extensionPath) ?? [];
				tools.push({ name: tool.definition.name, description: tool.definition.description });
				toolsByPath.set(tool.extensionPath, tools);
			}
			for (const extensionPath of runner.getExtensionPaths()) {
				integrations.push({
					schemaVersion: 1,
					integrationId: `extension:${stablePathId(extensionPath)}` as IntegrationId,
					kind: "extension",
					name: path.basename(extensionPath),
					displayName: path.basename(extensionPath),
					source: extensionPath.startsWith(session.sessionManager.getCwd()) ? "workspace" : "user",
					enabled: true,
					mutable: false,
					revision: this.#revision,
					effect: "restart_required",
					health: { status: "healthy" },
					auth: { status: "not_required" },
					tools: toolsByPath.get(extensionPath),
				});
			}
		}

		const manager = this.#mcpManager;
		if (manager) {
			for (const name of manager.getAllServerNames()) {
				const status = manager.getConnectionStatus(name);
				const source = manager.getSource(name);
				const config = manager.getServerConfig(name);
				const connection = manager.getConnection(name);
				integrations.push({
					schemaVersion: 1,
					integrationId: `mcp:${encodeURIComponent(name)}` as IntegrationId,
					kind: "mcp",
					name,
					displayName: connection?.serverInfo.name ?? name,
					source: sourceKind(source?.level, source?.provider),
					enabled: config?.enabled !== false,
					mutable: source?.provider === "native",
					revision: this.#revision,
					effect: "immediate",
					health: {
						status: status === "connected" ? "healthy" : status === "connecting" ? "unknown" : "failed",
						checkedAt: new Date().toISOString(),
						...(status === "disconnected"
							? { reasonCode: "MCP_DISCONNECTED", message: "MCP server is disconnected" }
							: {}),
					},
					auth: { status: "not_required" },
					tools: connection?.tools?.map(tool => ({ name: tool.name, description: tool.description })),
				});
			}
		}
		return integrations.sort(
			(left, right) => left.kind.localeCompare(right.kind) || left.displayName.localeCompare(right.displayName),
		);
	}

	#assertRevision(expected: number | undefined): void {
		if (expected !== undefined && expected !== this.#revision) {
			throw new IntegrationRevisionError(expected, this.#revision);
		}
	}
}

export class IntegrationRevisionError extends Error {
	readonly expectedRevision: number;
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Integration revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
		this.name = "IntegrationRevisionError";
		this.expectedRevision = expectedRevision;
		this.currentRevision = currentRevision;
	}
}

function parseIntegrationId(value: string): { kind: "skill" | "mcp" | "extension"; name: string } {
	const separator = value.indexOf(":");
	if (separator < 1) throw new Error(`Invalid integration ID: ${value}`);
	const kind = value.slice(0, separator);
	if (kind !== "skill" && kind !== "mcp" && kind !== "extension") throw new Error(`Invalid integration kind: ${kind}`);
	return { kind, name: decodeURIComponent(value.slice(separator + 1)) };
}

function sourceKind(
	level: string | undefined,
	source: string | undefined,
): "builtin" | "user" | "workspace" | "managed" {
	if (source === "managed") return "managed";
	if (level === "project") return "workspace";
	if (level === "native") return "builtin";
	return "user";
}

function stablePathId(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			!isRecord(value) ||
			typeof value.offset !== "number" ||
			!Number.isSafeInteger(value.offset) ||
			value.offset < 0
		) {
			throw new Error("invalid offset");
		}
		return value.offset;
	} catch (error: unknown) {
		throw new Error(`Invalid opaque integration cursor: ${String(error)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
