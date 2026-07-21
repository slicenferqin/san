export interface CatalogService {
	id: string;
	owner: string;
	docs: string;
	tier: "critical" | "standard";
}

export interface ServiceCatalog {
	version: 1;
	services: CatalogService[];
}
