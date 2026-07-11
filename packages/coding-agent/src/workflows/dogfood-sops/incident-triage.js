export const meta = {
	name: "incident-triage",
	description: "Triage an incident from existing repository evidence",
	version: "1",
	argsSchema: {
		type: "object",
		required: ["symptom"],
		properties: { symptom: { type: "string", minLength: 1 } },
		additionalProperties: false,
	},
	permissions: { writeMode: "read_only", tools: ["read", "grep", "yield"] },
	limits: { concurrency: 3, agentLimit: 8, tokenLimit: 2000, durationMs: 60000 },
};

phase("hypotheses");
const evidence = await parallel([
	() => agent(`Find code paths related to incident symptom ${args.symptom}`),
	() => agent(`Find recent risk points related to incident symptom ${args.symptom}`),
	() => agent(`Find missing safeguards related to incident symptom ${args.symptom}`),
]);
phase("triage");
return { symptom: args.symptom, evidence };
