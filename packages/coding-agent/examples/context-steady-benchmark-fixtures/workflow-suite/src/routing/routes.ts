import type { LegacyRouteDefinition } from "./types";

export const ROUTES: readonly LegacyRouteDefinition[] = [
	{ id: "accounts.read", method: "get", path: "accounts/:id/", timeoutSeconds: 2, retryLimit: 2, owner: "identity" },
	{
		id: "accounts.patch",
		method: "patch",
		path: "/accounts/:id",
		timeoutSeconds: 3,
		retryLimit: 1,
		owner: "identity",
	},
	{ id: "catalog.list", method: "GET", path: "//catalog", timeoutSeconds: 4, retryLimit: 2, owner: "catalog" },
	{ id: "catalog.create", method: "post", path: "/catalog/", timeoutSeconds: 8, retryLimit: 0, owner: "catalog" },
	{ id: "orders.read", method: "get", path: "orders/:id", timeoutSeconds: 2, retryLimit: 3, owner: "orders" },
	{ id: "orders.create", method: "POST", path: "/orders", timeoutSeconds: 10, retryLimit: 0, owner: "orders" },
	{ id: "orders.replace", method: "put", path: "orders/:id/", timeoutSeconds: 12, retryLimit: 1, owner: "orders" },
	{ id: "orders.delete", method: "delete", path: "/orders/:id", timeoutSeconds: 6, retryLimit: 1, owner: "orders" },
	{
		id: "billing.invoice",
		method: "post",
		path: "billing/invoices",
		timeoutSeconds: 15,
		retryLimit: 0,
		owner: "billing",
	},
	{
		id: "billing.read",
		method: "get",
		path: "/billing/invoices/:id/",
		timeoutSeconds: 5,
		retryLimit: 2,
		owner: "billing",
	},
	{
		id: "billing.patch",
		method: "patch",
		path: "billing/invoices/:id",
		timeoutSeconds: 7,
		retryLimit: 1,
		owner: "billing",
	},
	{ id: "health", method: "GET", path: "/", timeoutSeconds: 1, retryLimit: 0, owner: "platform" },
];
