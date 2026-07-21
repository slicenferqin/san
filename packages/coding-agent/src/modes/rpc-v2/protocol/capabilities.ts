/**
 * San RPC v2 capability negotiation types and constants.
 */

export type CapabilityStatus = "available" | "degraded" | "unavailable";

export interface CapabilityDescriptor {
	version: number;
	status: CapabilityStatus;
	reasonCode?: string;
	message?: string;
	details?: Record<string, unknown>;
}

/** Capabilities the client declares during initialize. */
export interface ClientCapabilities {
	"ui.interaction"?: { version: number };
	"host.tools"?: { version: number };
	"host.uri"?: { version: number; schemes: string[] };
	"ui.openUrl"?: { version: number };
	"ui.notifications"?: { version: number };
}

/** Capabilities the server returns in initialize result. */
export interface ServerCapabilities {
	"session.index": CapabilityDescriptor;
	"session.lease": CapabilityDescriptor;
	"session.sync": CapabilityDescriptor;
	"session.recovery": CapabilityDescriptor;
	"event.sequence": CapabilityDescriptor;
	"run.control": CapabilityDescriptor;
	"queue.items": CapabilityDescriptor;
	"approval.structured": CapabilityDescriptor;
	"interaction.structured": CapabilityDescriptor;
	"context.continuity": CapabilityDescriptor;
	"evidence.ledger": CapabilityDescriptor;
	"subagent.stream": CapabilityDescriptor;
	"model.catalog": CapabilityDescriptor;
	"provider.auth": CapabilityDescriptor;
	"execution.profiles": CapabilityDescriptor;
	"input.images": CapabilityDescriptor;
	"input.resources": CapabilityDescriptor;
	"integration.catalog": CapabilityDescriptor;
	"diagnostics.safe": CapabilityDescriptor;
	"host.tools": CapabilityDescriptor;
	"host.uri": CapabilityDescriptor;
	"artifact.read": CapabilityDescriptor;
}

/** Capability keys that Desktop 0.2 requires for startup. */
export const REQUIRED_CAPABILITIES: ReadonlyArray<keyof ServerCapabilities> = [
	"session.index",
	"session.lease",
	"session.sync",
	"session.recovery",
	"event.sequence",
	"run.control",
	"queue.items",
	"approval.structured",
	"interaction.structured",
	"context.continuity",
	"evidence.ledger",
	"subagent.stream",
	"model.catalog",
	"provider.auth",
	"execution.profiles",
	"input.images",
	"input.resources",
	"integration.catalog",
	"diagnostics.safe",
	"host.tools",
	"host.uri",
	"artifact.read",
];

/** Limits negotiated during initialize. */
export interface ProtocolLimits {
	maxFrameBytes: number;
	maxPageSize: number;
	maxInlineTextBytes: number;
	resources: ResourceLimitsConfig;
	eventRetention: "snapshot_or_replay";
}

export interface ResourceLimitsConfig {
	maxResourcesPerRun: number;
	maxResourceBytes: number;
	maxTotalBytesPerRun: number;
	uploadChunkBytes: number;
}

/** Default limits for San RPC v2. */
export const DEFAULT_LIMITS: ProtocolLimits = {
	maxFrameBytes: 1_048_576, // 1 MiB
	maxPageSize: 100,
	maxInlineTextBytes: 262_144, // 256 KiB
	resources: {
		maxResourcesPerRun: 20,
		maxResourceBytes: 26_214_400, // 25 MiB
		maxTotalBytesPerRun: 104_857_600, // 100 MiB
		uploadChunkBytes: 262_144, // 256 KiB
	},
	eventRetention: "snapshot_or_replay",
};

/** Build the full server capabilities with all marked available. */
export function buildServerCapabilities(overrides?: Partial<ServerCapabilities>): ServerCapabilities {
	const available = (details?: Record<string, unknown>): CapabilityDescriptor => ({
		version: 1,
		status: "available",
		...(details && { details }),
	});

	return {
		"session.index": available(),
		"session.lease": available(),
		"session.sync": available(),
		"session.recovery": available(),
		"event.sequence": available(),
		"run.control": available(),
		"queue.items": available(),
		"approval.structured": available({ scopes: ["once", "session", "workspace", "global"] }),
		"interaction.structured": available(),
		"context.continuity": available(),
		"evidence.ledger": available(),
		"subagent.stream": available(),
		"model.catalog": available(),
		"provider.auth": available(),
		"execution.profiles": available(),
		"input.images": available(),
		"input.resources": available(),
		"integration.catalog": available(),
		"diagnostics.safe": available({ redactionProfiles: ["strict"] }),
		"host.tools": available(),
		"host.uri": available(),
		"artifact.read": available(),
		...overrides,
	};
}
