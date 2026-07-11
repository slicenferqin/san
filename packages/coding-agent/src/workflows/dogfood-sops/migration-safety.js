export const meta = {
	name: "migration-safety",
	description: "Review a database migration for rollout safety",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["migration"],
		properties: { migration: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 3, agentLimit: 8, tokenLimit: 2000, durationMs: 60000 },
};

phase("risk-review");
const findings = await parallel([
	() => agent(`Check forward compatibility of ${args.migration}`),
	() => agent(`Check rollback safety of ${args.migration}`),
	() => agent(`Check locking and data-volume risk of ${args.migration}`),
]);
return { migration: args.migration, findings };
