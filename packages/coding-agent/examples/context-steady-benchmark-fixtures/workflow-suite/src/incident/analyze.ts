import type { IncidentEvidenceRecord, IncidentReport } from "./types";

export function analyzeIncidentEvidence(records: readonly IncidentEvidenceRecord[]): IncidentReport {
	return {
		totalServices: records.length,
		totalFailures: 0,
		highRiskServiceIds: [],
		idempotencyRequiredServiceIds: [],
		regionFailures: { "ap-south": 0, "eu-west": 0, "us-east": 0, "us-west": 0 },
		constraintCanaries: { first: "", midpoint: "", last: "" },
	};
}
