export const meta = {
	name: "one-time-change-review",
	description: "Review one narrowed one-time task boundary",
	version: "2",
	argsSchema: {
		type: "object",
		required: ["objective", "scope"],
		properties: {
			objective: { type: "string", minLength: 1 },
			scope: { type: "string", minLength: 1 },
		},
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 1, agentLimit: 2, tokenLimit: 700, durationMs: 30000 },
};

phase("focused review");
return await agent(`Review only ${args.objective} inside the approved scope ${args.scope}`);
