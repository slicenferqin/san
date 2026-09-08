export interface ContextMessageShape {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly customType?: unknown;
	readonly error?: unknown;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serialize(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "<unserializable>";
	}
}

/** Render provider-visible message content. Hidden thinking is never surfaced as plain text. */
export function contextContentText(content: unknown, options: { includeAttachments?: boolean } = {}): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			const record = recordValue(block);
			if (!record) return "";
			const type = stringValue(record.type);
			if (type === "text" || type === "input_text" || type === "output_text") {
				return stringValue(record.text) ?? "";
			}
			if (type === "toolCall" || type === "tool_use" || type === "function_call") {
				const name = stringValue(record.name) ?? "tool";
				return `[tool call: ${name} ${serialize(record.arguments ?? record.input ?? {})}]`;
			}
			if (type === "toolResult" || type === "tool_result" || type === "function_result") {
				return serialize(record.content ?? record.output ?? record.result ?? "");
			}
			if (
				options.includeAttachments &&
				(type === "image" || type === "image_url" || type === "file" || type === "artifact")
			) {
				const ref = record.url ?? record.uri ?? record.path ?? record.name ?? "attachment";
				return `[attachment: ${String(ref)}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function contextMessageText(
	message: ContextMessageShape,
	options: { includeAttachments?: boolean; includeError?: boolean } = {},
): string {
	const parts = [contextContentText(message.content, options)];
	if (options.includeError && typeof message.error === "string" && message.error.length > 0) {
		parts.push(`[error: ${message.error}]`);
	}
	return parts.filter(Boolean).join("\n");
}

export function contextMessageRoleLabel(message: ContextMessageShape): string {
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (role === "custom" && typeof message.customType === "string") return `custom:${message.customType}`;
	return role;
}
