import { parse } from "@babel/parser";
import type {
	ArrayExpression,
	Expression,
	File,
	ObjectExpression,
	ObjectProperty,
	Statement,
	VariableDeclaration,
} from "@babel/types";
import { workflowValueHash } from "./fingerprint";
import { normalizeWorkflowMeta, type WorkflowMetaInput, WorkflowValidationError } from "./schema";
import type { DiscoveredWorkflowSource, ManagedWorkflow, WorkflowJsonValue, WorkflowMeta } from "./types";

const FORBIDDEN_IDENTIFIERS = new Set([
	"Bun",
	"Deno",
	"Function",
	"WebSocket",
	"Worker",
	"document",
	"eval",
	"exports",
	"fetch",
	"globalThis",
	"module",
	"process",
	"require",
	"window",
]);

const FORBIDDEN_MEMBER_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const WORKFLOW_MAX_SOURCE_BYTES = 512 * 1024;
const WORKFLOW_MAX_STATIC_DEPTH = 64;
const FORBIDDEN_NODE_TYPES = new Set([
	"ClassDeclaration",
	"ClassExpression",
	"DebuggerStatement",
	"ImportDeclaration",
	"ImportExpression",
	"MetaProperty",
	"NewExpression",
	"Super",
	"TaggedTemplateExpression",
	"ThisExpression",
	"WithStatement",
	"YieldExpression",
]);

export interface ParsedWorkflowSource {
	ast: File;
	meta: WorkflowMeta;
	violations: string[];
}

export interface WorkflowSourceReviewSummary {
	/** Literal phase labels in source order. */
	stages: string[];
	/** Number of phase() calls whose labels are computed at runtime. */
	dynamicStageCount: number;
	/** Agent instructions grouped under the most recent phase label. */
	steps: Array<{ phase: string; instruction: string }>;
}

function expressionKey(property: ObjectProperty, path: string): string {
	if (property.computed) throw new WorkflowValidationError([`${path} cannot use a computed property`]);
	if (property.key.type === "Identifier") return property.key.name;
	if (property.key.type === "StringLiteral") return property.key.value;
	throw new WorkflowValidationError([`${path} contains an unsupported property key`]);
}

function staticArray(node: ArrayExpression, path: string, depth: number): WorkflowJsonValue[] {
	if (depth > WORKFLOW_MAX_STATIC_DEPTH) {
		throw new WorkflowValidationError([`${path} exceeds the maximum metadata depth`]);
	}
	return node.elements.map((element, index) => {
		if (!element || element.type === "SpreadElement") {
			throw new WorkflowValidationError([`${path}[${index}] cannot be empty or spread`]);
		}
		return staticExpression(element, `${path}[${index}]`, depth + 1);
	});
}

function staticObject(node: ObjectExpression, path: string, depth: number): Record<string, WorkflowJsonValue> {
	if (depth > WORKFLOW_MAX_STATIC_DEPTH) {
		throw new WorkflowValidationError([`${path} exceeds the maximum metadata depth`]);
	}
	const result = Object.create(null) as Record<string, WorkflowJsonValue>;
	for (const property of node.properties) {
		if (property.type !== "ObjectProperty" || property.value.type === "AssignmentPattern") {
			throw new WorkflowValidationError([`${path} may only contain plain properties`]);
		}
		const key = expressionKey(property, path);
		result[key] = staticExpression(property.value as Expression, `${path}.${key}`, depth + 1);
	}
	return result;
}

function staticExpression(node: Expression, path: string, depth: number): WorkflowJsonValue {
	if (depth > WORKFLOW_MAX_STATIC_DEPTH) {
		throw new WorkflowValidationError([`${path} exceeds the maximum metadata depth`]);
	}
	switch (node.type) {
		case "StringLiteral":
		case "BooleanLiteral":
		case "NumericLiteral":
			return node.value;
		case "NullLiteral":
			return null;
		case "ArrayExpression":
			return staticArray(node, path, depth);
		case "ObjectExpression":
			return staticObject(node, path, depth);
		case "TemplateLiteral":
			if (node.expressions.length > 0) {
				throw new WorkflowValidationError([`${path} cannot contain dynamic template expressions`]);
			}
			return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join("");
		case "UnaryExpression":
			if (node.operator === "-" && node.argument.type === "NumericLiteral") return -node.argument.value;
			throw new WorkflowValidationError([`${path} contains an unsupported unary expression`]);
		default:
			throw new WorkflowValidationError([`${path} must be static JSON data`]);
	}
}

function metaDeclaration(statement: Statement): VariableDeclaration | undefined {
	if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") {
		return undefined;
	}
	return statement.declaration.declarations.some(
		declaration => declaration.id.type === "Identifier" && declaration.id.name === "meta",
	)
		? statement.declaration
		: undefined;
}

function extractMeta(ast: File): WorkflowMeta {
	let metaValue: WorkflowJsonValue | undefined;
	for (const statement of ast.program.body) {
		const declaration = metaDeclaration(statement);
		if (!declaration) continue;
		for (const item of declaration.declarations) {
			if (item.id.type !== "Identifier" || item.id.name !== "meta") continue;
			if (item.init?.type !== "ObjectExpression") {
				throw new WorkflowValidationError(["exported meta must be a static object literal"]);
			}
			if (metaValue !== undefined) throw new WorkflowValidationError(["workflow exports meta more than once"]);
			metaValue = staticObject(item.init, "meta", 0);
		}
	}
	if (!metaValue || Array.isArray(metaValue) || typeof metaValue !== "object") {
		throw new WorkflowValidationError(["workflow must export const meta = { ... }"]);
	}
	return normalizeWorkflowMeta(metaValue as WorkflowMetaInput);
}

function memberKey(value: Record<string, unknown>): string | undefined {
	const property = value.property;
	if (
		!value.computed &&
		property &&
		typeof property === "object" &&
		(property as { type?: unknown }).type === "Identifier"
	) {
		return (property as { name?: string }).name;
	}
	if (property && typeof property === "object" && (property as { type?: unknown }).type === "StringLiteral") {
		return (property as { value?: string }).value;
	}
	return undefined;
}

function collectSafetyViolations(value: unknown, violations: Set<string>): void {
	const pending: unknown[] = [value];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		const node = current as Record<string, unknown>;
		const type = typeof node.type === "string" ? node.type : undefined;
		if (type && FORBIDDEN_NODE_TYPES.has(type)) violations.add(`${type} is not allowed in Workflow scripts`);
		if (type === "Identifier" && typeof node.name === "string" && FORBIDDEN_IDENTIFIERS.has(node.name)) {
			violations.add(`identifier ${node.name} is not available in Workflow scripts`);
		}
		if (type === "MemberExpression" || type === "OptionalMemberExpression") {
			const key = memberKey(node);
			if (key && FORBIDDEN_MEMBER_KEYS.has(key))
				violations.add(`member ${key} is not available in Workflow scripts`);
		}
		for (const [key, child] of Object.entries(node)) {
			if (key === "loc" || key === "start" || key === "end" || key === "comments" || key === "errors") continue;
			pending.push(child);
		}
	}
}

function staticReviewText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const node = value as Record<string, unknown>;
	if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
	if (node.type !== "TemplateLiteral" || !Array.isArray(node.expressions) || node.expressions.length > 0) {
		return undefined;
	}
	if (!Array.isArray(node.quasis)) return undefined;
	const parts: string[] = [];
	for (const quasi of node.quasis) {
		if (!quasi || typeof quasi !== "object") return undefined;
		const valueNode = (quasi as Record<string, unknown>).value;
		if (!valueNode || typeof valueNode !== "object") return undefined;
		const cooked = (valueNode as Record<string, unknown>).cooked;
		const raw = (valueNode as Record<string, unknown>).raw;
		if (typeof cooked === "string") parts.push(cooked);
		else if (typeof raw === "string") parts.push(raw);
		else return undefined;
	}
	return parts.join("");
}

function agentReviewText(value: unknown): string | undefined {
	const literal = staticReviewText(value);
	if (literal !== undefined) return literal;
	if (!value || typeof value !== "object") return undefined;
	const node = value as Record<string, unknown>;
	if (node.type !== "TemplateLiteral" || !Array.isArray(node.expressions) || !Array.isArray(node.quasis)) {
		return undefined;
	}
	const parts: string[] = [];
	for (let index = 0; index < node.quasis.length; index++) {
		const quasi = node.quasis[index];
		if (!quasi || typeof quasi !== "object") return undefined;
		const valueNode = (quasi as Record<string, unknown>).value;
		if (!valueNode || typeof valueNode !== "object") return undefined;
		const cooked = (valueNode as Record<string, unknown>).cooked;
		const raw = (valueNode as Record<string, unknown>).raw;
		if (typeof cooked === "string") parts.push(cooked);
		else if (typeof raw === "string") parts.push(raw);
		else return undefined;
		if (index < node.expressions.length) parts.push("{approved input or prior result}");
	}
	return parts.join("");
}

function collectReviewCalls(
	value: unknown,
	calls: Array<{ position: number; kind: "agent" | "phase"; title?: string }>,
	seen: Set<object>,
): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const child of value) collectReviewCalls(child, calls, seen);
		return;
	}

	const node = value as Record<string, unknown>;
	if (node.type === "CallExpression") {
		const callee = node.callee;
		if (
			callee &&
			typeof callee === "object" &&
			(callee as Record<string, unknown>).type === "Identifier" &&
			((callee as Record<string, unknown>).name === "phase" || (callee as Record<string, unknown>).name === "agent")
		) {
			const kind = (callee as Record<string, unknown>).name === "phase" ? "phase" : "agent";
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			const title = kind === "phase" ? staticReviewText(args[0]) : agentReviewText(args[0]);
			calls.push({
				position: typeof node.start === "number" ? node.start : Number.MAX_SAFE_INTEGER,
				kind,
				...(title !== undefined ? { title } : {}),
			});
		}
	}

	for (const [key, child] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end" || key === "comments" || key === "errors") continue;
		collectReviewCalls(child, calls, seen);
	}
}

export function parseWorkflowSource(sourceText: string): ParsedWorkflowSource {
	if (
		sourceText.length > WORKFLOW_MAX_SOURCE_BYTES ||
		new TextEncoder().encode(sourceText).byteLength > WORKFLOW_MAX_SOURCE_BYTES
	) {
		throw new WorkflowValidationError([`script exceeds the ${WORKFLOW_MAX_SOURCE_BYTES}-byte source limit`]);
	}
	let ast: File;
	try {
		ast = parse(sourceText, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			plugins: ["topLevelAwait"],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkflowValidationError([`script cannot be parsed: ${message}`]);
	}
	const meta = extractMeta(ast);
	const violations = new Set<string>();
	collectSafetyViolations(ast.program, violations);
	return { ast, meta, violations: [...violations].sort() };
}

/** Derives a review aid from the exact parsed script without executing it. */
export function summarizeWorkflowSource(sourceText: string): WorkflowSourceReviewSummary {
	const parsed = parseWorkflowSource(sourceText);
	const calls: Array<{ position: number; kind: "agent" | "phase"; title?: string }> = [];
	collectReviewCalls(parsed.ast.program, calls, new Set());
	calls.sort((left, right) => left.position - right.position);
	const stages: string[] = [];
	const steps: Array<{ phase: string; instruction: string }> = [];
	let dynamicStageCount = 0;
	let currentPhase = "default phase";
	for (const call of calls) {
		if (call.kind === "phase") {
			if (call.title === undefined) {
				dynamicStageCount++;
				currentPhase = "stage label computed by the reviewed script";
			} else {
				stages.push(call.title);
				currentPhase = call.title;
			}
			continue;
		}
		steps.push({
			phase: currentPhase,
			instruction: call.title ?? "Agent instruction computed by the reviewed script",
		});
	}
	return {
		stages,
		dynamicStageCount,
		steps,
	};
}

export function parseManagedWorkflow(source: DiscoveredWorkflowSource): ManagedWorkflow {
	const parsed = parseWorkflowSource(source.sourceText);
	if (parsed.violations.length > 0) throw new WorkflowValidationError(parsed.violations);
	if (parsed.meta.name !== source.name) {
		throw new WorkflowValidationError([
			`meta.name ${parsed.meta.name} must match the filename command name ${source.name}`,
		]);
	}
	return {
		kind: "managed",
		meta: parsed.meta,
		source: {
			provider: source.provider,
			level: source.level,
			path: source.path,
			scopeKey: source.scopeKey,
		},
		sourceText: source.sourceText,
		sourceHash: source.sourceHash,
		argsSchemaHash: workflowValueHash(parsed.meta.argsSchema ?? null),
		permissionManifestHash: workflowValueHash(parsed.meta.permissions),
	};
}
