export const meta = {
	name: "managed-sop",
	description: "Run a fixed release SOP",
	version: 3,
	argsSchema: {
		type: "object",
		required: ["branch"],
		properties: { branch: { type: "string" } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 4, agentLimit: 12, tokenLimit: 120000, durationMs: 600000 },
};

phase("baseline");
return await agent(`Check ${args.branch}.`);
