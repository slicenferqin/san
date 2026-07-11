export const meta = {
	name: "one-time-change-review",
	description: "Review a broad one-time task boundary",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["objective", "scope"],
		properties: {
			objective: { type: "string", minLength: 1 },
			scope: { type: "string", minLength: 1 },
		},
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "glob", "yield"] },
	limits: { concurrency: 3, agentLimit: 6, tokenLimit: 1600, durationMs: 60000 },
};

phase("broad inventory");
return await parallel([
	() => agent(`Inventory evidence for ${args.objective} under ${args.scope}`),
	() => agent(`Independently identify risks for ${args.objective} under ${args.scope}`),
]);
