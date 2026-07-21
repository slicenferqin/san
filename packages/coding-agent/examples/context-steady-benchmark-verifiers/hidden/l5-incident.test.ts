import { describe, expect, test } from "bun:test";

import { analyzeIncidentEvidence } from "./src/incident/analyze";
import type { IncidentEvidenceRecord } from "./src/incident/types";

describe("L5 controlled-stress delivery", () => {
	test("aggregates every ordered evidence record and preserves canary constraints", async () => {
		const records = Bun.JSONL.parse(await Bun.file("evidence.ndjson").text()) as IncidentEvidenceRecord[];
		const report = analyzeIncidentEvidence(records);
		const expectedRegionFailures = { "ap-south": 0, "eu-west": 0, "us-east": 0, "us-west": 0 };
		for (const record of records) expectedRegionFailures[record.region] += record.failureCount;
		const expectedHighRisk = records
			.filter(record => record.failureCount / record.sampleCount >= 0.2 || record.p95Ms >= 1800)
			.map(record => record.serviceId);
		expect(report).toEqual({
			totalServices: records.length,
			totalFailures: records.reduce((sum, record) => sum + record.failureCount, 0),
			highRiskServiceIds: expectedHighRisk,
			idempotencyRequiredServiceIds: records
				.filter(record => record.requiresIdempotency)
				.map(record => record.serviceId),
			regionFailures: expectedRegionFailures,
			constraintCanaries: {
				first: records[0]!.constraint,
				midpoint: records[Math.floor((records.length - 1) / 2)]!.constraint,
				last: records.at(-1)!.constraint,
			},
		});
		expect(await Bun.file("incident-report.json").json()).toEqual(report);
	});
});
