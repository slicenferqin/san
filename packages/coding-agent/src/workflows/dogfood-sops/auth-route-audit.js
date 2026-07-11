export const meta = {
	name: "auth-route-audit",
	description: "Audit route authorization coverage",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["area"],
		properties: { area: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "glob", "yield"] },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 2000, durationMs: 60000 },
};

phase("inventory");
const routes = await agent(`Inventory routes under ${args.area}`);
phase("review");
const reviews = await parallel([
	() => agent(`Audit authorization checks for ${routes}`),
	() => agent(`Independently verify authorization gaps for ${routes}`),
]);
return { area: args.area, routes, reviews };
