import type { ServiceCatalog } from "./types";

export function renderCatalogMarkdown(catalog: ServiceCatalog): string {
	return catalog.services.map(service => service.id).join("\n");
}
