/** RPC v2 handlers for agent capability management (MCP, skills, hooks, memory). */

import { forget, getContext, getStats } from "@san/mnemopi";
import { getMCPConfigPath } from "@san/utils";
import { disableProvider, enableProvider, isProviderEnabled, loadCapability } from "../../capability";
import type { SourceMeta } from "../../capability/types";
import {
	addMCPServer,
	listMCPServers,
	readMCPConfigFile,
	removeMCPServer,
	type SetMcpServerEnabledOptions,
	setMcpServerEnabled,
	validateServerName,
} from "../../mcp/config-writer";
import type { MCPServerConfig } from "../../mcp/types";

export type McpScope = "user" | "project";

export interface McpListItem {
	name: string;
	scope: McpScope;
	config: MCPServerConfig;
	enabled: boolean;
}

export interface CapabilityListItem {
	id: string;
	name: string;
	description?: string;
	source: SourceMeta["level"];
	providerId: string;
	enabled: boolean;
}

interface LoadedCapabilityItem {
	id?: string;
	name?: string;
	description?: string;
	_source: SourceMeta;
}

function mcpPath(scope: McpScope, cwd: string): string {
	return getMCPConfigPath(scope, cwd);
}

async function readMcpScope(scope: McpScope, cwd: string): Promise<McpListItem[]> {
	const filePath = mcpPath(scope, cwd);
	const config = await readMCPConfigFile(filePath);
	const disabled = new Set(config.disabledServers ?? []);
	return Object.entries(config.mcpServers ?? {}).map(([name, serverConfig]) => ({
		name,
		scope,
		config: serverConfig,
		enabled: !disabled.has(name),
	}));
}

export async function listMcpCapabilities(cwd: string, scope?: McpScope): Promise<{ items: McpListItem[] }> {
	const scopes: McpScope[] = scope ? [scope] : ["user", "project"];
	const items = (await Promise.all(scopes.map(currentScope => readMcpScope(currentScope, cwd)))).flat();
	return { items };
}

export async function addMcpCapability(
	cwd: string,
	name: string,
	config: MCPServerConfig,
	scope: McpScope = "project",
): Promise<{ name: string; scope: McpScope }> {
	const nameError = validateServerName(name);
	if (nameError) throw new Error(nameError);
	await addMCPServer(mcpPath(scope, cwd), name, config);
	return { name, scope };
}

export async function removeMcpCapability(
	cwd: string,
	name: string,
	scope: McpScope = "project",
): Promise<{ name: string; scope: McpScope }> {
	const nameError = validateServerName(name);
	if (nameError) throw new Error(nameError);
	await removeMCPServer(mcpPath(scope, cwd), name);
	return { name, scope };
}

export async function setMcpCapabilityEnabled(
	cwd: string,
	name: string,
	enabled: boolean,
	scope: McpScope = "project",
): Promise<{ name: string; scope: McpScope; enabled: boolean }> {
	const paths: SetMcpServerEnabledOptions = {
		userPath: mcpPath("user", cwd),
		projectPath: mcpPath("project", cwd),
		name,
		enabled,
	};
	if (scope === "user") paths.sourcePath = paths.userPath;
	if (scope === "project") paths.sourcePath = paths.projectPath;
	await setMcpServerEnabled(paths);
	return { name, scope, enabled };
}

async function listLoadedCapability(
	cwd: string,
	capabilityId: "skills" | "hooks",
): Promise<{ items: CapabilityListItem[] }> {
	const result = await loadCapability<LoadedCapabilityItem>(capabilityId, { cwd });
	return {
		items: result.items.map((item, index) => {
			const name = item.name ?? item.id ?? `${capabilityId}-${index + 1}`;
			return {
				id: item.id ?? name,
				name,
				...(item.description ? { description: item.description } : {}),
				source: item._source.level,
				providerId: item._source.provider,
				enabled: isProviderEnabled(item._source.provider),
			};
		}),
	};
}

export function listSkillCapabilities(cwd: string): Promise<{ items: CapabilityListItem[] }> {
	return listLoadedCapability(cwd, "skills");
}

export function listHookCapabilities(cwd: string): Promise<{ items: CapabilityListItem[] }> {
	return listLoadedCapability(cwd, "hooks");
}

export function setSkillProviderEnabled(
	providerId: string,
	enabled: boolean,
): { providerId: string; enabled: boolean } {
	if (enabled) enableProvider(providerId);
	else disableProvider(providerId);
	return { providerId, enabled: isProviderEnabled(providerId) };
}

export function setHookProviderEnabled(providerId: string, enabled: boolean): { providerId: string; enabled: boolean } {
	if (enabled) enableProvider(providerId);
	else disableProvider(providerId);
	return { providerId, enabled: isProviderEnabled(providerId) };
}

export async function listMemories(limit = 50): Promise<{ items: unknown[]; stats: unknown }> {
	const items = await getContext(limit);
	const stats = await getStats();
	return { items, stats };
}

export async function deleteMemory(memoryId: string): Promise<boolean> {
	return await forget(memoryId);
}

export async function listMcpServerNames(cwd: string, scope: McpScope): Promise<string[]> {
	return listMCPServers(mcpPath(scope, cwd));
}
