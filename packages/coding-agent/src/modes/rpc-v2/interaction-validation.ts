import type { InteractionRequest, InteractionResponseUnion } from "./dto/interaction";
import { failRpc } from "./protocol/errors";

/** 校验客户端响应与原始 Interaction request union 完全匹配。 */
export function validateInteractionResponse(
	interaction: Pick<InteractionRequest, "interactionId" | "request">,
	value: unknown,
): InteractionResponseUnion {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return invalidResponse(interaction.interactionId, "response.kind", "Expected a typed Interaction response");
	}

	const request = interaction.request;
	switch (request.kind) {
		case "select": {
			if (value.kind !== "selected" || !Array.isArray(value.optionIds) || !value.optionIds.every(isString)) {
				return invalidResponse(
					interaction.interactionId,
					"response",
					"Select Interaction requires selected optionIds",
				);
			}
			const optionIds = [...new Set(value.optionIds)];
			if (optionIds.length !== value.optionIds.length) {
				return invalidResponse(
					interaction.interactionId,
					"response.optionIds",
					"Duplicate option IDs are not allowed",
				);
			}
			const options = new Map(request.options.map(option => [option.id, option]));
			for (const optionId of optionIds) {
				const option = options.get(optionId);
				if (!option)
					return invalidResponse(
						interaction.interactionId,
						"response.optionIds",
						`Unknown option ID: ${optionId}`,
					);
				if (option.disabled)
					return invalidResponse(
						interaction.interactionId,
						"response.optionIds",
						`Option is disabled: ${optionId}`,
					);
			}
			const minimum = request.min ?? (request.multiple ? 0 : 1);
			const maximum = request.max ?? (request.multiple ? request.options.length : 1);
			if (!request.multiple && optionIds.length > 1) {
				return invalidResponse(
					interaction.interactionId,
					"response.optionIds",
					"This Interaction accepts one option",
				);
			}
			if (optionIds.length < minimum || optionIds.length > maximum) {
				return invalidResponse(
					interaction.interactionId,
					"response.optionIds",
					`Expected between ${minimum} and ${maximum} selected options`,
				);
			}
			return { kind: "selected", optionIds };
		}
		case "confirm":
			if (value.kind !== "confirmed" || typeof value.value !== "boolean") {
				return invalidResponse(
					interaction.interactionId,
					"response",
					"Confirm Interaction requires a boolean confirmed response",
				);
			}
			return { kind: "confirmed", value: value.value };
		case "input":
		case "editor": {
			if (value.kind !== "submitted" || typeof value.value !== "string") {
				return invalidResponse(
					interaction.interactionId,
					"response",
					`${request.kind} Interaction requires a submitted string`,
				);
			}
			validateInput(interaction.interactionId, value.value, request.validation);
			return { kind: "submitted", value: value.value };
		}
		case "plan": {
			if (value.kind !== "plan_decision" || typeof value.optionId !== "string") {
				return invalidResponse(
					interaction.interactionId,
					"response",
					"Plan Interaction requires a plan_decision with optionId",
				);
			}
			const option = request.options.find(item => item.id === value.optionId);
			if (!option) {
				return invalidResponse(interaction.interactionId, "response.optionId", `Unknown option ID: ${value.optionId}`);
			}
			if (option.disabled) {
				return invalidResponse(interaction.interactionId, "response.optionId", `Option is disabled: ${value.optionId}`);
			}
			const feedback = "feedback" in value && typeof value.feedback === "string" ? value.feedback : undefined;
			return { kind: "plan_decision", optionId: value.optionId, ...(feedback ? { feedback } : {}) };
		}
		case "open_url":
			if (
				value.kind !== "url_handled" ||
				(value.outcome !== "opened" && value.outcome !== "copied" && value.outcome !== "cancelled")
			) {
				return invalidResponse(
					interaction.interactionId,
					"response",
					"Open URL Interaction requires opened, copied, or cancelled outcome",
				);
			}
			return { kind: "url_handled", outcome: value.outcome };
	}
}

function validateInput(
	interactionId: string,
	value: string,
	validation: { required?: boolean; minLength?: number; maxLength?: number; pattern?: string } | undefined,
): void {
	if (!validation) return;
	if (validation.required && value.length === 0) {
		invalidResponse(interactionId, "response.value", "A value is required");
	}
	if (validation.minLength !== undefined && value.length < validation.minLength) {
		invalidResponse(
			interactionId,
			"response.value",
			`Value must contain at least ${validation.minLength} characters`,
		);
	}
	if (validation.maxLength !== undefined && value.length > validation.maxLength) {
		invalidResponse(interactionId, "response.value", `Value must contain at most ${validation.maxLength} characters`);
	}
	if (validation.pattern !== undefined) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(validation.pattern, "u");
		} catch (error: unknown) {
			throw new Error(`Interaction ${interactionId} contains an invalid validation pattern: ${String(error)}`);
		}
		if (!pattern.test(value))
			invalidResponse(interactionId, "response.value", "Value does not match the required pattern");
	}
}

function invalidResponse(interactionId: string, path: string, message: string): never {
	failRpc({
		reason: "INVALID_PARAMS",
		category: "validation",
		message: `Invalid response for Interaction ${interactionId}: ${message}`,
		fieldErrors: [{ path, reason: "interaction_response_mismatch", message }],
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
