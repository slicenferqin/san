import type { Model } from "@san/ai";
import type { Dialect } from "@san/ai/dialect";
import { FALLBACK_DIALECT, preferredDialect } from "@san/catalog/identity";

export type DialectFormat = "auto" | "native" | Dialect;

export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}
