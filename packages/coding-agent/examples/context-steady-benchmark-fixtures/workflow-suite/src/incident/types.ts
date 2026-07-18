export interface IncidentEvidenceRecord {
	step: number;
	serviceId: string;
	region: "ap-south" | "eu-west" | "us-east" | "us-west";
	owner: "billing" | "catalog" | "identity" | "orders";
	targetRoute: string;
	sampleCount: number;
	failureCount: number;
	p95Ms: number;
	retryLimit: number;
	requiresIdempotency: boolean;
	constraint: string;
}

export interface IncidentReport {
	totalServices: number;
	totalFailures: number;
	highRiskServiceIds: string[];
	idempotencyRequiredServiceIds: string[];
	regionFailures: Record<IncidentEvidenceRecord["region"], number>;
	constraintCanaries: { first: string; midpoint: string; last: string };
}
