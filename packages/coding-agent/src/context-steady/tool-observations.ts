interface ToolCallSource {
	toolName: string;
	paths: string[];
	condition: string;
	position: number;
}

export interface ContextToolObservation extends ToolCallSource {
	entryId: string;
	toolCallId: string;
	outcome: "success" | "failure" | "unknown";
}

export interface ContextToolSourceIndex {
	resultsById: Map<string, ContextToolObservation[]>;
	mutations: ContextToolObservation[];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function normalizeSourcePath(value: string): string {
	return value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/");
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
	if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "<circular>";
	seen.add(value);
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) output[key] = canonicalize(input[key], seen);
	seen.delete(value);
	return output;
}

function stableArguments(value: Record<string, unknown>): string {
	try {
		return JSON.stringify(canonicalize(value, new Set())) ?? "";
	} catch {
		return "";
	}
}

export function contextSourcePathsOverlap(left: string, right: string): boolean {
	const normalizedLeft = normalizeSourcePath(left);
	const normalizedRight = normalizeSourcePath(right);
	return (
		normalizedLeft === normalizedRight ||
		normalizedLeft.endsWith(`/${normalizedRight}`) ||
		normalizedRight.endsWith(`/${normalizedLeft}`)
	);
}

function extractSourcePaths(value: Record<string, unknown>): string[] {
	const paths = new Set<string>();
	const details = recordValue(value.details);
	const meta = recordValue(details?.meta);
	const args = recordValue(value.args) ?? recordValue(value.arguments);
	for (const source of [value, details, meta, args]) {
		if (!source) continue;
		for (const key of ["sourcePath", "path", "filePath", "file", "targetPath", "destination"]) {
			const candidate = stringField(source, key);
			if (candidate) paths.add(normalizeSourcePath(candidate));
		}
		const input = stringField(source, "input");
		if (input) {
			for (const match of input.matchAll(/^\[([^#\]\r\n]+)#[0-9a-f]{4}\]$/gim)) {
				const candidate = match[1]?.trim();
				if (candidate) paths.add(normalizeSourcePath(candidate));
			}
		}
		const command = stringField(source, "command");
		if (command) {
			for (const match of command.matchAll(/(?:^|[\s"'`])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+)(?=$|[\s"'`,:])/g)) {
				const candidate = match[1]?.trim();
				if (candidate) paths.add(normalizeSourcePath(candidate));
			}
		}
	}
	return [...paths].filter(Boolean).sort();
}

function isMutationTool(toolName: string): boolean {
	return /^(write|edit|patch|apply_patch|replace|delete|rm|mv|rename|mkdir|touch|insert|update|save|create)/i.test(
		toolName,
	);
}

function unwrapEntryMessage(entry: unknown, index: number): { entryId: string; message: Record<string, unknown> } {
	const wrapper = recordValue(entry) ?? {};
	const message = recordValue(wrapper.message) ?? wrapper;
	return {
		entryId: stringField(wrapper, "id") ?? stringField(message, "entryId") ?? `entry:${index}`,
		message,
	};
}

function toolCondition(toolName: string, args: Record<string, unknown>, paths: readonly string[]): string {
	const target = paths.length > 0 ? paths.join(", ") : stableArguments(args).slice(0, 300);
	return `${toolName}(${target})`;
}

function toolCallsFromMessage(
	message: Record<string, unknown>,
	position: number,
): Array<{ toolCallId: string; source: ToolCallSource }> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const result: Array<{ toolCallId: string; source: ToolCallSource }> = [];
	for (const block of message.content) {
		const candidate = recordValue(block);
		if (candidate?.type !== "toolCall") continue;
		const toolCallId = stringField(candidate, "id");
		const toolName = stringField(candidate, "name");
		if (!toolCallId || !toolName) continue;
		const args = recordValue(candidate.arguments) ?? {};
		const paths = extractSourcePaths(args);
		result.push({
			toolCallId,
			source: { toolName, paths, condition: toolCondition(toolName, args, paths), position },
		});
	}
	return result;
}

export function inspectContextToolSources(entries: readonly unknown[]): ContextToolSourceIndex {
	const calls = new Map<string, ToolCallSource>();
	const resultsById = new Map<string, ContextToolObservation[]>();
	for (const [position, entry] of entries.entries()) {
		const { entryId, message } = unwrapEntryMessage(entry, position);
		for (const call of toolCallsFromMessage(message, position)) calls.set(call.toolCallId, call.source);

		const toolCallId = stringField(message, "toolCallId");
		if (!toolCallId || (message.role !== "toolResult" && message.type !== "toolResult")) continue;
		const call = calls.get(toolCallId);
		const toolName = call?.toolName ?? stringField(message, "toolName") ?? "unknown";
		const paths = [...new Set([...(call?.paths ?? []), ...extractSourcePaths(message)])];
		const outcome = call
			? message.isError === true
				? "failure"
				: message.isError === false
					? "success"
					: "unknown"
			: "unknown";
		resultsById.set(entryId, [
			{
				entryId,
				toolCallId,
				toolName,
				outcome,
				paths,
				condition: call?.condition ?? `${toolName}(source:${entryId})`,
				position,
			},
		]);
	}
	const mutations = [...resultsById.values()].flat().filter(item => isMutationTool(item.toolName));
	return { resultsById, mutations };
}
