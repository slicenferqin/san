export const meta = {
	name: "release-readiness",
	description: "Check a release branch before deployment",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["branch"],
		properties: { branch: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 3, agentLimit: 8, tokenLimit: 2000, durationMs: 60000 },
};

phase("baseline");
const checks = await parallel([
	() => agent(`Inspect tests for release branch ${args.branch}`),
	() => agent(`Inspect type-check risks for release branch ${args.branch}`),
	() => agent(`Inspect changelog coverage for release branch ${args.branch}`),
]);
phase("summary");
return { branch: args.branch, checks };
