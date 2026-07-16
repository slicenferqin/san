export * from "./budget";
export * from "./checkpoint";
export * from "./coverage";
export * from "./digest";
export * from "./dogfood";
export * from "./fallback";
export * from "./materialize";
export * from "./normalize";
export {
	appendContextPacketDebugEntry,
	type BuiltContextPacket,
	buildContextPacket,
	type PreviousContextPacketRefs,
} from "./packet";
export * from "./plan-types";
export * from "./planner";
export * from "./prune";
export * from "./quality-gate";
export * from "./segment";
// Legacy ContextPacket / prune engines: read-only compat + regression tests only.
// Active runtime uses ContextPlan (planner + materialize).
// collectDigestRefs lives in session.ts (canonical); packet re-exports it for
// direct packet-module imports in legacy tests, but the barrel only stars session.
export * from "./session";
export * from "./source-index";
export * from "./types";
