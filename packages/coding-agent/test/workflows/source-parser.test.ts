import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	parseManagedWorkflow,
	parseWorkflowSource,
	summarizeWorkflowSource,
	WORKFLOW_MAX_SOURCE_BYTES,
	WorkflowValidationError,
	workflowSourceHash,
} from "@san/coding-agent/workflows";

const fixtures = path.join(import.meta.dir, "..", "fixtures", "workflows");

async function fixture(group: "allowed" | "malicious", name: string): Promise<string> {
	return Bun.file(path.join(fixtures, group, name)).text();
}

describe("Workflow static source parsing", () => {
	it("accepts the documented Claude public shape without executing it", async () => {
		const sourceText = await fixture("allowed", "claude-public.js");
		const parsed = parseWorkflowSource(sourceText);

		expect(parsed.meta.name).toBe("claude-public");
		expect(parsed.meta.version).toBe("1");
		expect(parsed.meta.permissions.writeMode).toBe("read_only");
		expect(parsed.violations).toEqual([]);
	});

	it("materializes a Managed version with hashes bound to the static manifest", async () => {
		const sourceText = await fixture("allowed", "managed-sop.js");
		const workflow = parseManagedWorkflow({
			name: "managed-sop",
			path: "/repo/.san/workflows/managed-sop.js",
			sourceText,
			sourceHash: workflowSourceHash(sourceText),
			provider: "san",
			level: "project",
			scopeKey: "/repo",
			directoryDepth: 0,
		});

		expect(workflow.meta.version).toBe("3");
		expect(workflow.meta.limits).toEqual({
			concurrency: 4,
			agentLimit: 12,
			tokenLimit: 120_000,
			durationMs: 600_000,
		});
		expect(workflow.argsSchemaHash).toHaveLength(64);
		expect(workflow.permissionManifestHash).toHaveLength(64);
	});

	it("derives reviewable phases and Agent steps without executing the script", async () => {
		const summary = summarizeWorkflowSource(await fixture("allowed", "managed-sop.js"));

		expect(summary.stages).toEqual(["baseline"]);
		expect(summary.dynamicStageCount).toBe(0);
		expect(summary.steps).toEqual([
			{
				phase: "baseline",
				instruction: "Check {approved input or prior result}.",
			},
		]);
	});

	it("finds every direct host escape fixture without running its body", async () => {
		for (const name of ["import-fs.js", "direct-process.js", "constructor-escape.js", "direct-network.js"]) {
			const parsed = parseWorkflowSource(await fixture("malicious", name));
			expect(parsed.violations.length).toBeGreaterThan(0);
		}
	});

	it("leaves loops to the runtime hard budget instead of executing during discovery", async () => {
		const parsed = parseWorkflowSource(await fixture("malicious", "infinite-loop.js"));
		expect(parsed.meta.name).toBe("infinite-loop");
		expect(parsed.violations).toEqual([]);
	});

	it("rejects a filename/meta mismatch before approval", async () => {
		const sourceText = await fixture("allowed", "managed-sop.js");
		expect(() =>
			parseManagedWorkflow({
				name: "different-name",
				path: "/repo/.san/workflows/different-name.js",
				sourceText,
				sourceHash: workflowSourceHash(sourceText),
				provider: "san",
				level: "project",
				scopeKey: "/repo",
				directoryDepth: 0,
			}),
		).toThrow(WorkflowValidationError);
	});

	it("rejects oversized scripts before Babel parsing", () => {
		expect(() => parseWorkflowSource(" ".repeat(WORKFLOW_MAX_SOURCE_BYTES + 1))).toThrow(
			`${WORKFLOW_MAX_SOURCE_BYTES}-byte source limit`,
		);
	});
});
