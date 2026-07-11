import type { WorkflowJsonValue } from "./types";

function normalizedJson(value: unknown, ancestors: Set<object>, path: string): WorkflowJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Workflow fingerprint value at ${path} must be finite.`);
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value !== "object") {
		throw new Error(`Workflow fingerprint value at ${path} is not JSON-compatible.`);
	}
	if (ancestors.has(value)) throw new Error(`Workflow fingerprint value at ${path} contains a cycle.`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) => normalizedJson(item, ancestors, `${path}[${index}]`));
		}
		const normalized = Object.create(null) as Record<string, WorkflowJsonValue>;
		for (const key of Object.keys(value).sort()) {
			normalized[key] = normalizedJson((value as Record<string, unknown>)[key], ancestors, `${path}.${key}`);
		}
		return normalized;
	} finally {
		ancestors.delete(value);
	}
}

/** Stable JSON encoding used for approval, schema, permission and argument fingerprints. */
export function canonicalWorkflowJson(value: unknown): string {
	return JSON.stringify(normalizedJson(value, new Set(), "$"));
}

/** SHA-256 is required because source and approval fingerprints are trust boundaries. */
export function workflowSourceHash(source: string): string {
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

export function workflowValueHash(value: unknown): string {
	return workflowSourceHash(canonicalWorkflowJson(value));
}

/** Claude-compatible naming retained for callers constructing Workflow records. */
export const hashWorkflowText = workflowSourceHash;
export const hashWorkflowJson = workflowValueHash;
