import type {
	WorkflowEvent,
	WorkflowEventType,
	WorkflowJsonSchema,
	WorkflowJsonValue,
	WorkflowLimits,
	WorkflowMeta,
	WorkflowPermissionManifest,
	WorkflowWriteMode,
} from "./types";

export const WORKFLOW_DEFAULT_LIMITS: Readonly<WorkflowLimits> = {
	concurrency: 8,
	agentLimit: 25,
	tokenLimit: 120_000,
	durationMs: 30 * 60 * 1000,
};

export const WORKFLOW_HARD_LIMITS: Readonly<WorkflowLimits> = {
	concurrency: 16,
	agentLimit: 100,
	tokenLimit: 2_000_000,
	durationMs: 4 * 60 * 60 * 1000,
};

export const WORKFLOW_MAX_JSON_DEPTH = 64;
export const WORKFLOW_MAX_JSON_NODES = 10_000;
export const WORKFLOW_MAX_STRING_LENGTH = 65_536;
export const WORKFLOW_MAX_JSON_TEXT_LENGTH = 4 * 1024 * 1024;
const WORKFLOW_MAX_SCHEMA_DEPTH = 32;
const WORKFLOW_MAX_SCHEMA_NODES = 1_000;
const WORKFLOW_MAX_PATTERN_LENGTH = 256;

/** Conservative default: excludes shell, edits, memory mutation, messaging, jobs and user prompts. */
export const WORKFLOW_READ_ONLY_TOOLS: readonly string[] = [
	"ast_grep",
	"glob",
	"grep",
	"inspect_image",
	"read",
	"web_search",
	"yield",
];

export interface WorkflowMetaInput {
	name?: unknown;
	description?: unknown;
	version?: unknown;
	argsSchema?: unknown;
	permissions?: unknown;
	limits?: unknown;
}

export class WorkflowValidationError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(`Invalid workflow: ${problems.join("; ")}`);
		this.name = "WorkflowValidationError";
		this.problems = problems;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value: unknown, fallback: number, hardMax: number, field: string, problems: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		problems.push(`${field} must be a positive integer`);
		return fallback;
	}
	if (value > hardMax) {
		problems.push(`${field} exceeds the hard limit ${hardMax}`);
		return fallback;
	}
	return value;
}

function normalizeLimits(value: unknown, problems: string[]): WorkflowLimits {
	if (value !== undefined && !isRecord(value)) problems.push("limits must be an object");
	const limits = isRecord(value) ? value : {};
	return {
		concurrency: positiveInteger(
			limits.concurrency,
			WORKFLOW_DEFAULT_LIMITS.concurrency,
			WORKFLOW_HARD_LIMITS.concurrency,
			"limits.concurrency",
			problems,
		),
		agentLimit: positiveInteger(
			limits.agentLimit,
			WORKFLOW_DEFAULT_LIMITS.agentLimit,
			WORKFLOW_HARD_LIMITS.agentLimit,
			"limits.agentLimit",
			problems,
		),
		tokenLimit: positiveInteger(
			limits.tokenLimit,
			WORKFLOW_DEFAULT_LIMITS.tokenLimit,
			WORKFLOW_HARD_LIMITS.tokenLimit,
			"limits.tokenLimit",
			problems,
		),
		durationMs: positiveInteger(
			limits.durationMs,
			WORKFLOW_DEFAULT_LIMITS.durationMs,
			WORKFLOW_HARD_LIMITS.durationMs,
			"limits.durationMs",
			problems,
		),
	};
}

function normalizePermissions(value: unknown, problems: string[]): WorkflowPermissionManifest {
	if (value !== undefined && !isRecord(value)) problems.push("permissions must be an object");
	const permissions = isRecord(value) ? value : {};
	const rawWriteMode = permissions.writeMode;
	let writeMode: WorkflowWriteMode = "read_only";
	if (rawWriteMode !== undefined) {
		if (rawWriteMode === "read_only" || rawWriteMode === "isolated_write") writeMode = rawWriteMode;
		else problems.push("permissions.writeMode must be read_only or isolated_write");
	}
	let tools = [...WORKFLOW_READ_ONLY_TOOLS];
	if (permissions.tools !== undefined) {
		if (
			!Array.isArray(permissions.tools) ||
			permissions.tools.some(tool => typeof tool !== "string" || !tool.trim())
		) {
			problems.push("permissions.tools must be an array of non-empty strings");
		} else {
			tools = [...new Set(permissions.tools.map(tool => String(tool).trim()))].sort();
		}
	}
	if (writeMode === "read_only") {
		const readOnly = new Set(WORKFLOW_READ_ONLY_TOOLS);
		const unsafe = tools.filter(tool => !readOnly.has(tool));
		if (unsafe.length > 0) problems.push(`read_only permissions include non-read-only tools: ${unsafe.join(", ")}`);
	}
	return { writeMode, tools };
}

interface SchemaValidationContext {
	nodes: number;
}

function isSafeWorkflowPattern(pattern: string): boolean {
	if (pattern.length > WORKFLOW_MAX_PATTERN_LENGTH || !pattern.startsWith("^") || !pattern.endsWith("$")) return false;
	let escaped = false;
	let inClass = false;
	let quantifiers = 0;
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]!;
		if (escaped) {
			if (!inClass && /[1-9k]/.test(character)) return false;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") {
			if (inClass) return false;
			inClass = true;
			continue;
		}
		if (character === "]") {
			if (!inClass) return false;
			inClass = false;
			continue;
		}
		if (inClass) continue;
		if (character === "." || character === "(" || character === ")" || character === "|") return false;
		if (character === "*" || character === "+" || character === "?") quantifiers++;
		if (character === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close < 0 || !/^\d+(?:,\d*)?$/.test(pattern.slice(index + 1, close))) return false;
			quantifiers++;
			index = close;
		}
		if (quantifiers > 1) return false;
	}
	if (escaped || inClass) return false;
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function validateSchemaShape(
	schema: unknown,
	path: string,
	problems: string[],
	depth = 0,
	context: SchemaValidationContext = { nodes: 0 },
): schema is WorkflowJsonSchema {
	context.nodes++;
	if (depth > WORKFLOW_MAX_SCHEMA_DEPTH || context.nodes > WORKFLOW_MAX_SCHEMA_NODES) {
		problems.push(`${path} exceeds the Workflow schema complexity limit`);
		return false;
	}
	if (!isRecord(schema)) {
		problems.push(`${path} must be an object`);
		return false;
	}
	const allowedTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
	if (schema.type !== undefined && (typeof schema.type !== "string" || !allowedTypes.has(schema.type))) {
		problems.push(`${path}.type is not supported`);
	}
	const allowedKeys = new Set([
		"type",
		"title",
		"description",
		"properties",
		"required",
		"items",
		"additionalProperties",
		"enum",
		"const",
		"minItems",
		"maxItems",
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"pattern",
		"anyOf",
		"oneOf",
	]);
	const unknownKeys = Object.keys(schema).filter(key => !allowedKeys.has(key));
	if (unknownKeys.length > 0) problems.push(`${path} contains unsupported keys: ${unknownKeys.sort().join(", ")}`);
	for (const textKey of ["title", "description"] as const) {
		const value = schema[textKey];
		if (value !== undefined && (typeof value !== "string" || value.length > 1_000)) {
			problems.push(`${path}.${textKey} must be a string of at most 1000 characters`);
		}
	}
	if (schema.required !== undefined) {
		if (
			!Array.isArray(schema.required) ||
			schema.required.length > WORKFLOW_MAX_SCHEMA_NODES ||
			schema.required.some(item => typeof item !== "string" || item.length > 256)
		) {
			problems.push(`${path}.required must be an array of strings`);
		}
	}
	if (schema.properties !== undefined) {
		if (!isRecord(schema.properties)) problems.push(`${path}.properties must be an object`);
		else {
			for (const [key, child] of Object.entries(schema.properties)) {
				if (key.length > 256) problems.push(`${path} contains an overlong property name`);
				validateSchemaShape(child, `${path}.${key}`, problems, depth + 1, context);
			}
		}
	}
	if (schema.items !== undefined) validateSchemaShape(schema.items, `${path}.items`, problems, depth + 1, context);
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		validateSchemaShape(schema.additionalProperties, `${path}.additionalProperties`, problems, depth + 1, context);
	}
	for (const unionKey of ["anyOf", "oneOf"] as const) {
		const union = schema[unionKey];
		if (union !== undefined) {
			if (!Array.isArray(union) || union.length === 0 || union.length > 32)
				problems.push(`${path}.${unionKey} must be a non-empty array`);
			else {
				union.forEach((child, index) => {
					validateSchemaShape(child, `${path}.${unionKey}[${index}]`, problems, depth + 1, context);
				});
			}
		}
	}
	for (const integerKey of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
		const value = schema[integerKey];
		if (
			value !== undefined &&
			(typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > WORKFLOW_MAX_JSON_NODES)
		) {
			problems.push(`${path}.${integerKey} must be a non-negative bounded integer`);
		}
	}
	for (const numberKey of ["minimum", "maximum"] as const) {
		const value = schema[numberKey];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
			problems.push(`${path}.${numberKey} must be a finite number`);
		}
	}
	if (schema.const !== undefined && !isWorkflowJsonValue(schema.const)) {
		problems.push(`${path}.const must be bounded JSON data`);
	}
	if (
		schema.enum !== undefined &&
		(!Array.isArray(schema.enum) ||
			schema.enum.length > WORKFLOW_MAX_SCHEMA_NODES ||
			schema.enum.some(value => !isWorkflowJsonValue(value)))
	) {
		problems.push(`${path}.enum must be an array of bounded JSON values`);
	}
	if (schema.pattern !== undefined) {
		if (typeof schema.pattern !== "string") problems.push(`${path}.pattern must be a string`);
		else if (!isSafeWorkflowPattern(schema.pattern))
			problems.push(`${path}.pattern must be an anchored, linear-safe Workflow pattern`);
	}
	return true;
}

/** Validates and clones the bounded JSON Schema subset accepted at runtime. */
export function validateWorkflowJsonSchema(input: unknown, path = "schema"): WorkflowJsonSchema {
	const problems: string[] = [];
	if (!validateSchemaShape(input, path, problems) || problems.length > 0) {
		throw new WorkflowValidationError(problems);
	}
	return structuredClone(input);
}

export function normalizeWorkflowMeta(input: WorkflowMetaInput): WorkflowMeta {
	const problems: string[] = [];
	const name = typeof input.name === "string" ? input.name.trim() : "";
	const description = typeof input.description === "string" ? input.description.trim() : "";
	if (!name) problems.push("meta.name is required");
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
		problems.push("meta.name must use lowercase letters, digits and hyphens (maximum 64 characters)");
	}
	if (!description) problems.push("meta.description is required");
	if (description.length > 2_000) problems.push("meta.description must be at most 2000 characters");
	let version = "1";
	if (typeof input.version === "string" || typeof input.version === "number") version = String(input.version).trim();
	else if (input.version !== undefined) problems.push("meta.version must be a string or number");
	if (!version) problems.push("meta.version must not be empty");
	if (version.length > 64) problems.push("meta.version must be at most 64 characters");

	let argsSchema: WorkflowJsonSchema | undefined;
	if (input.argsSchema !== undefined && validateSchemaShape(input.argsSchema, "meta.argsSchema", problems)) {
		argsSchema = structuredClone(input.argsSchema);
	}
	const permissions = normalizePermissions(input.permissions, problems);
	const limits = normalizeLimits(input.limits, problems);
	if (limits.agentLimit < limits.concurrency) {
		problems.push("limits.agentLimit must be greater than or equal to limits.concurrency");
	}
	if (problems.length > 0) throw new WorkflowValidationError(problems);
	return { name, description, version, ...(argsSchema ? { argsSchema } : {}), permissions, limits };
}

function typeMatches(value: WorkflowJsonValue, expected: NonNullable<WorkflowJsonSchema["type"]>): boolean {
	switch (expected) {
		case "array":
			return Array.isArray(value);
		case "boolean":
			return typeof value === "boolean";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "null":
			return value === null;
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "string":
			return typeof value === "string";
	}
}

function validateValue(
	value: WorkflowJsonValue,
	schema: WorkflowJsonSchema,
	path: string,
	problems: string[],
	depth = 0,
): void {
	if (depth > WORKFLOW_MAX_JSON_DEPTH) {
		problems.push(`${path} exceeds the maximum Workflow JSON depth`);
		return;
	}
	if (schema.anyOf && !schema.anyOf.some(candidate => validateWorkflowArgs(value, candidate).length === 0)) {
		problems.push(`${path} does not match any allowed schema`);
	}
	if (schema.oneOf) {
		const matches = schema.oneOf.filter(candidate => validateWorkflowArgs(value, candidate).length === 0).length;
		if (matches !== 1) problems.push(`${path} must match exactly one allowed schema`);
	}
	if (schema.type && !typeMatches(value, schema.type)) {
		problems.push(`${path} must be ${schema.type}`);
		return;
	}
	if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
		problems.push(`${path} must equal the schema constant`);
	}
	if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
		problems.push(`${path} is not one of the allowed values`);
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} is too short`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} is too long`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value))
			problems.push(`${path} does not match the pattern`);
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} is below the minimum`);
		if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} exceeds the maximum`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path} has too few items`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} has too many items`);
		const itemSchema = schema.items;
		if (itemSchema) {
			value.forEach((item, index) => {
				validateValue(item, itemSchema, `${path}[${index}]`, problems, depth + 1);
			});
		}
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const properties = schema.properties ?? {};
		for (const required of schema.required ?? []) {
			if (!Object.hasOwn(value, required)) problems.push(`${path}.${required} is required`);
		}
		for (const [key, child] of Object.entries(value)) {
			const propertySchema = properties[key];
			if (propertySchema) validateValue(child, propertySchema, `${path}.${key}`, problems, depth + 1);
			else if (schema.additionalProperties === false) problems.push(`${path}.${key} is not allowed`);
			else if (isRecord(schema.additionalProperties)) {
				validateValue(
					child,
					schema.additionalProperties as WorkflowJsonSchema,
					`${path}.${key}`,
					problems,
					depth + 1,
				);
			}
		}
	}
}

export function validateWorkflowArgs(value: WorkflowJsonValue, schema: WorkflowJsonSchema): string[] {
	const problems: string[] = [];
	if (!isWorkflowJsonValue(value)) return ["args must be bounded JSON data"];
	validateValue(value, schema, "args", problems);
	return problems;
}

export function assertWorkflowArgs(value: WorkflowJsonValue, schema: WorkflowJsonSchema | undefined): void {
	if (!isWorkflowJsonValue(value)) throw new WorkflowValidationError(["args must be bounded JSON data"]);
	if (!schema) return;
	const problems = validateWorkflowArgs(value, schema);
	if (problems.length > 0) throw new WorkflowValidationError(problems);
}

export function isWorkflowJsonValue(value: unknown): value is WorkflowJsonValue {
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	const seen = new Set<object>();
	let nodes = 0;
	let textLength = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		nodes++;
		if (nodes > WORKFLOW_MAX_JSON_NODES || current.depth > WORKFLOW_MAX_JSON_DEPTH) return false;
		if (current.value === null || typeof current.value === "boolean") continue;
		if (typeof current.value === "string") {
			if (current.value.length > WORKFLOW_MAX_STRING_LENGTH) return false;
			textLength += current.value.length;
			if (textLength > WORKFLOW_MAX_JSON_TEXT_LENGTH) return false;
			continue;
		}
		if (typeof current.value === "number") {
			if (!Number.isFinite(current.value)) return false;
			continue;
		}
		if (!Array.isArray(current.value) && !isRecord(current.value)) return false;
		if (seen.has(current.value)) return false;
		seen.add(current.value);
		if (!Array.isArray(current.value)) {
			textLength += Object.keys(current.value).reduce((total, key) => total + key.length, 0);
			if (textLength > WORKFLOW_MAX_JSON_TEXT_LENGTH) return false;
		}
		const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
		if (children.length + nodes > WORKFLOW_MAX_JSON_NODES) return false;
		for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
	}
	return true;
}

const WORKFLOW_EVENT_TYPES: ReadonlySet<WorkflowEventType> = new Set([
	"draft_created",
	"draft_rejected",
	"draft_expired",
	"version_published",
	"version_revoked",
	"run_approved",
	"run_started",
	"phase_started",
	"node_scheduled",
	"agent_started",
	"agent_completed",
	"agent_failed",
	"node_committed",
	"write_captured",
	"write_reviewed",
	"write_apply_started",
	"write_applied",
	"write_rejected",
	"write_blocked",
	"write_unknown",
	"run_paused",
	"run_resumed",
	"run_cancelled",
	"run_blocked",
	"run_completed",
	"run_failed",
	"result_delivery_prepared",
	"result_delivered",
]);

export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
	if (!isRecord(value)) return false;
	if (typeof value.eventId !== "string" || !value.eventId) return false;
	if (value.runId !== undefined && (typeof value.runId !== "string" || !value.runId)) return false;
	if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return false;
	if (typeof value.type !== "string" || !WORKFLOW_EVENT_TYPES.has(value.type as WorkflowEventType)) return false;
	if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return false;
	return isRecord(value.payload) && isWorkflowJsonValue(value.payload);
}
