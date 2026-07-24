/** San RPC v2 方法目录。该目录同时驱动路由、能力声明、Schema 和 conformance。 */

export type RpcV2CapabilityKey =
	| "session.index"
	| "session.lease"
	| "session.sync"
	| "session.recovery"
	| "event.sequence"
	| "run.control"
	| "queue.items"
	| "approval.structured"
	| "interaction.structured"
	| "context.continuity"
	| "evidence.ledger"
	| "subagent.stream"
	| "model.catalog"
	| "provider.auth"
	| "provider.config"
	| "usage.analytics"
	| "execution.profiles"
	| "input.images"
	| "input.resources"
	| "integration.catalog"
	| "diagnostics.safe"
	| "host.tools"
	| "host.uri"
	| "artifact.read";

export interface RpcV2MethodDefinition {
	method: string;
	capability?: RpcV2CapabilityKey;
	mutation: boolean;
	requiresSession: boolean;
	requiresWriteLease: boolean;
	preInitialize: boolean;
}

function method(name: string, options: Partial<Omit<RpcV2MethodDefinition, "method">> = {}): RpcV2MethodDefinition {
	return {
		method: name,
		mutation: options.mutation ?? false,
		requiresSession: options.requiresSession ?? false,
		requiresWriteLease: options.requiresWriteLease ?? false,
		preInitialize: options.preInitialize ?? false,
		...(options.capability ? { capability: options.capability } : {}),
	};
}

const sessionRead = { capability: "session.index", requiresSession: true } as const;
const sessionWrite = {
	capability: "session.lease",
	mutation: true,
	requiresSession: true,
	requiresWriteLease: true,
} as const;
const runWrite = {
	capability: "run.control",
	mutation: true,
	requiresSession: true,
	requiresWriteLease: true,
} as const;

export const RPC_V2_METHOD_DEFINITIONS: readonly RpcV2MethodDefinition[] = [
	method("initialize", { preInitialize: true }),
	method("server.getCapabilities"),
	method("server.getHealth", { preInitialize: true }),
	method("server.getDiagnostics", { capability: "diagnostics.safe" }),
	method("server.shutdown", { mutation: true, preInitialize: true }),
	method("stream.configure", { mutation: true }),

	method("session.list", { capability: "session.index" }),
	method("session.get", { capability: "session.index" }),
	method("session.create", { capability: "session.lease", mutation: true }),
	method("session.open", { capability: "session.lease", mutation: true }),
	method("session.sync", { capability: "session.sync", requiresSession: true }),
	method("session.unsync", { capability: "session.sync" }),
	method("session.events.list", sessionRead),
	method("session.rename", sessionWrite),
	method("session.branch", sessionWrite),
	method("session.handoff", sessionWrite),
	method("session.export", sessionWrite),
	method("session.stats", sessionRead),
	method("usage.stats", { capability: "usage.analytics" }),
	method("session.recover", {
		capability: "session.recovery",
		mutation: true,
		requiresSession: true,
	}),
	method("session.delete", { capability: "session.index", mutation: true }),
	method("session.close", sessionWrite),

	method("run.start", runWrite),
	method("run.steer", runWrite),
	method("run.followUp", runWrite),
	method("run.replace", runWrite),
	method("run.abort", runWrite),
	method("retry.cancel", runWrite),
	method("queue.list", { capability: "queue.items", requiresSession: true }),
	method("queue.cancel", {
		capability: "queue.items",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("settings.get"),
	method("settings.update", { mutation: true }),

	method("model.list", { capability: "model.catalog" }),
	method("model.select", { ...sessionWrite, capability: "model.catalog" }),
	method("thinking.set", sessionWrite),
	method("execution.profile.list", { capability: "execution.profiles" }),
	method("auth.provider.list", { capability: "provider.auth" }),
	method("auth.login.start", { capability: "provider.auth", mutation: true }),
	method("auth.login.cancel", { capability: "provider.auth", mutation: true }),
	method("provider.config.create", { capability: "provider.config", mutation: true }),
	method("provider.model.add", { capability: "provider.config", mutation: true }),
	method("command.list", { requiresSession: true }),
	method("todo.set", sessionWrite),

	method("integration.list", { capability: "integration.catalog" }),
	method("integration.get", { capability: "integration.catalog" }),
	method("integration.setEnabled", { capability: "integration.catalog", mutation: true }),
	method("integration.refresh", { capability: "integration.catalog", mutation: true }),

	method("approval.list", { capability: "approval.structured", requiresSession: true }),
	method("approval.decide", {
		capability: "approval.structured",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("approval.rules.list", { capability: "approval.structured" }),
	method("approval.rules.revoke", { capability: "approval.structured", mutation: true }),
	method("approval.policy.get", { capability: "approval.structured" }),
	method("approval.policy.update", { capability: "approval.structured", mutation: true }),

	method("interaction.list", { capability: "interaction.structured", requiresSession: true }),
	method("interaction.respond", {
		capability: "interaction.structured",
		mutation: true,
	}),
	method("interaction.cancel", {
		capability: "interaction.structured",
		mutation: true,
	}),

	method("subagent.list", { capability: "subagent.stream", requiresSession: true }),
	method("subagent.messages.list", { capability: "subagent.stream", requiresSession: true }),
	method("subagent.send", {
		capability: "subagent.stream",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("subagent.abort", {
		capability: "subagent.stream",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),

	method("context.get", { capability: "context.continuity", requiresSession: true }),
	method("context.digests.list", { capability: "context.continuity", requiresSession: true }),
	method("context.checkpoints.list", { capability: "context.continuity", requiresSession: true }),
	method("context.compact", {
		capability: "context.continuity",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("context.maintenance.cancel", {
		capability: "context.continuity",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),

	method("evidence.list", { capability: "evidence.ledger", requiresSession: true }),
	method("evidence.get", { capability: "evidence.ledger", requiresSession: true }),
	method("artifact.read", { capability: "artifact.read", requiresSession: true }),
	method("resource.upload.begin", {
		capability: "input.resources",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("resource.upload.chunk", {
		capability: "input.resources",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("resource.upload.commit", {
		capability: "input.resources",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("resource.registerHostUri", {
		capability: "host.uri",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("resource.release", {
		capability: "input.resources",
		mutation: true,
		requiresSession: true,
		requiresWriteLease: true,
	}),
	method("host.capabilities.update", { mutation: true }),
] as const;

export const RPC_V2_METHODS = RPC_V2_METHOD_DEFINITIONS.map(definition => definition.method);

export const RPC_V2_METHOD_BY_NAME = new Map(
	RPC_V2_METHOD_DEFINITIONS.map(definition => [definition.method, definition] as const),
);

export const RPC_V2_MUTATION_METHODS = new Set(
	RPC_V2_METHOD_DEFINITIONS.filter(definition => definition.mutation).map(definition => definition.method),
);
