import type { ServiceCatalog } from "./types";

export function loadCatalog(text: string): ServiceCatalog {
	return JSON.parse(text) as ServiceCatalog;
}
