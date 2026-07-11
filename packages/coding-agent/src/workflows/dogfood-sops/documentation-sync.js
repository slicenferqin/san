export const meta = {
	name: "documentation-sync",
	description: "Check whether implementation and documentation agree",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["feature"],
		properties: { feature: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 2, agentLimit: 8, tokenLimit: 2000, durationMs: 60000 },
};

phase("compare");
const implementation = await agent(`Summarize implemented behavior for ${args.feature}`);
const documentation = await agent(`Summarize documented behavior for ${args.feature}`);
phase("gaps");
return await agent(`Compare implementation ${implementation} with documentation ${documentation}`);
