import type { FieldError } from "./envelope";
import { type JsonSchema, type JsonSchemaValue, paramsSchemaForMethod } from "./schema";

const MAX_FIELD_ERRORS = 100;

/** 使用发布 JSON Schema 的同源定义校验请求参数。 */
export function validateRpcV2Params(method: string, params: unknown): FieldError[] {
	const schema = paramsSchemaForMethod(method);
	if (!schema) return [];
	const errors: FieldError[] = [];
	validateValue(params, schema, "params", errors);
	return errors;
}

function validateValue(value: unknown, schema: JsonSchema, location: string, errors: FieldError[]): void {
	if (errors.length >= MAX_FIELD_ERRORS) return;
	const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isSchema) : [];
	if (alternatives.length > 0) {
		const results = alternatives.map(candidate => validateCandidate(value, candidate));
		if (results.some(candidateErrors => candidateErrors.length === 0)) return;
		const bestErrors = results.reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
		errors.push(...bestErrors.slice(0, MAX_FIELD_ERRORS - errors.length));
		return;
	}
	const expectedTypes = schemaTypes(schema.type);
	if (expectedTypes.length > 0 && !expectedTypes.some(type => matchesType(value, type))) {
		pushError(errors, location, "invalid_type", `Expected ${expectedTypes.join(" or ")}`);
		return;
	}

	const constant = schema.const;
	if (constant !== undefined && !sameJsonValue(value, constant)) {
		pushError(errors, location, "invalid_value", `Expected ${JSON.stringify(constant)}`);
		return;
	}
	const choices = Array.isArray(schema.enum) ? schema.enum : undefined;
	if (choices && !choices.some(choice => sameJsonValue(value, choice))) {
		pushError(
			errors,
			location,
			"invalid_enum",
			`Expected one of ${choices.map(choice => JSON.stringify(choice)).join(", ")}`,
		);
		return;
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			pushError(errors, location, "out_of_range", `Expected a value greater than or equal to ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			pushError(errors, location, "out_of_range", `Expected a value less than or equal to ${schema.maximum}`);
		}
	}

	if (Array.isArray(value)) {
		const itemSchema = asSchema(schema.items);
		if (itemSchema) {
			for (const [index, item] of value.entries()) validateValue(item, itemSchema, `${location}[${index}]`, errors);
		}
		return;
	}

	if (!isRecord(value)) return;
	const properties = asSchemaMap(schema.properties);
	const required = Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string")
		: [];
	for (const key of required) {
		if (!(key in value)) pushError(errors, `${location}.${key}`, "required", "Required field is missing");
	}
	for (const [key, item] of Object.entries(value)) {
		const propertySchema = properties?.[key];
		if (propertySchema) validateValue(item, propertySchema, `${location}.${key}`, errors);
		else if (schema.additionalProperties === false) {
			pushError(errors, `${location}.${key}`, "unknown_field", "Unknown field is not allowed");
		}
	}
}

function validateCandidate(value: unknown, schema: JsonSchema): FieldError[] {
	const candidateErrors: FieldError[] = [];
	validateValue(value, schema, "params", candidateErrors);
	return candidateErrors;
}

function isSchema(value: JsonSchemaValue): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypes(value: JsonSchemaValue | undefined): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value);
		default:
			return false;
	}
}

function sameJsonValue(value: unknown, expected: JsonSchemaValue): boolean {
	if (value === expected) return true;
	if (typeof value !== "object" || value === null) return false;
	try {
		return JSON.stringify(value) === JSON.stringify(expected);
	} catch {
		return false;
	}
}

function asSchema(value: JsonSchemaValue | undefined): JsonSchema | undefined {
	return isRecord(value) ? (value as JsonSchema) : undefined;
}

function asSchemaMap(value: JsonSchemaValue | undefined): Record<string, JsonSchema> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, JsonSchema> = {};
	for (const [key, item] of Object.entries(value)) {
		const schema = asSchema(item);
		if (schema) result[key] = schema;
	}
	return result;
}

function pushError(errors: FieldError[], path: string, reason: string, message: string): void {
	if (errors.length < MAX_FIELD_ERRORS) errors.push({ path, reason, message });
}

function isRecord(value: unknown): value is Record<string, JsonSchemaValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
