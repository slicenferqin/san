import type { MemoryBackendSearchItem, MemoryBackendSearchOptions } from "./types";

export function filterMemorySearchItemsByScope(
	items: readonly MemoryBackendSearchItem[],
	options?: MemoryBackendSearchOptions,
): MemoryBackendSearchItem[] {
	const scopeKeys = new Set(options?.scopeKeys ?? []);
	if (scopeKeys.size === 0) return [...items];
	return items.filter(item => item.scope !== undefined && scopeKeys.has(item.scope));
}
