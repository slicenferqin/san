import { analyzeIncidentEvidence } from "./analyze";
import type { IncidentEvidenceRecord } from "./types";

const input = Bun.argv[2];
const output = Bun.argv[3];
if (!input || !output) throw new Error("Usage: bun src/incident/cli.ts <evidence.ndjson> <incident-report.json>");
const records = Bun.JSONL.parse(await Bun.file(input).text()) as IncidentEvidenceRecord[];
await Bun.write(output, `${JSON.stringify(analyzeIncidentEvidence(records), null, 2)}\n`);
