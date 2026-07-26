import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@san/coding-agent";
import {
	appendWorkflowEvent,
	discoverWorkflowSources,
	rebuildWorkflowLedger,
	WORKFLOW_MAX_SOURCE_BYTES,
	type WorkflowEvent,
} from "@san/coding-agent/workflows";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "san-workflow-contract-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Workflow source discovery", () => {
	it("uses closest-project, San-over-Claude, then user precedence while retaining shadowed diagnostics", async () => {
		const root = await tempDir();
		const cwd = path.join(root, "packages", "app");
		const agentDir = path.join(root, "user-san");
		const home = path.join(root, "home");
		await Bun.write(path.join(agentDir, "workflows", "audit.js"), "return 'san-user';");
		await Bun.write(path.join(home, ".claude", "workflows", "audit.js"), "return 'claude-user';");
		await Bun.write(path.join(root, ".san", "workflows", "audit.js"), "return 'san-root';");
		await Bun.write(path.join(cwd, ".claude", "workflows", "audit.js"), "return 'claude-closest';");
		await Bun.write(path.join(cwd, ".san", "workflows", "audit.js"), "return 'san-closest';");
		await Bun.write(path.join(root, ".claude", "workflows", "claude-only.js"), "return 'claude-only';");

		const result = await discoverWorkflowSources({ cwd, repoRoot: root, agentDir, home });
		const audit = result.items.find(item => item.name === "audit");

		expect(audit?.sourceText).toBe("return 'san-closest';");
		expect(audit?.provider).toBe("san");
		expect(audit?.level).toBe("project");
		expect(result.items.find(item => item.name === "claude-only")?.provider).toBe("claude");
		expect(result.all.every(item => path.isAbsolute(item.scopeKey))).toBe(true);
		expect(result.all.filter(item => item.level === "user").every(item => item.scopeKey === cwd)).toBe(true);
		expect(result.all.filter(item => item.name === "audit")).toHaveLength(5);
		expect(result.all.filter(item => item.name === "audit" && item.shadowed)).toHaveLength(4);
	});

	it("ignores unsafe command names and non-regular script entries", async () => {
		const root = await tempDir();
		const workflows = path.join(root, ".san", "workflows");
		await Bun.write(path.join(workflows, "valid-name.js"), "return true;");
		await Bun.write(path.join(workflows, "UPPER.js"), "return false;");
		await fs.symlink(path.join(workflows, "valid-name.js"), path.join(workflows, "linked.js"));

		const result = await discoverWorkflowSources({
			cwd: root,
			repoRoot: root,
			agentDir: path.join(root, "agent"),
			home: path.join(root, "home"),
		});

		expect(result.items.map(item => item.name)).toEqual(["valid-name"]);
		expect(result.warnings.some(warning => warning.includes("linked.js"))).toBe(true);
	});

	it("does not load a Workflow source beyond the parser byte limit", async () => {
		const root = await tempDir();
		await Bun.write(path.join(root, ".san", "workflows", "oversized.js"), " ".repeat(WORKFLOW_MAX_SOURCE_BYTES + 1));

		const result = await discoverWorkflowSources({
			cwd: root,
			repoRoot: root,
			agentDir: path.join(root, "agent"),
			home: path.join(root, "home"),
		});

		expect(result.items).toEqual([]);
		expect(result.warnings.some(warning => warning.includes("source exceeds"))).toBe(true);
	});
});

function event(
	type: WorkflowEvent["type"],
	sequence: number,
	eventId = `event-${sequence}`,
	payload: WorkflowEvent["payload"] = {},
): WorkflowEvent {
	return {
		eventId,
		runId: "run-1",
		sequence,
		type,
		timestamp: `2026-07-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		payload,
	};
}

describe("Workflow append-only ledger", () => {
	it("rebuilds the terminal run state and detects duplicate final delivery", () => {
		const session = SessionManager.inMemory("/repo");
		appendWorkflowEvent(session, event("run_approved", 0));
		appendWorkflowEvent(session, event("run_started", 1));
		appendWorkflowEvent(session, event("run_completed", 2));
		appendWorkflowEvent(session, event("result_delivered", 3));
		appendWorkflowEvent(session, event("result_delivered", 4));

		const run = rebuildWorkflowLedger(session.getEntries()).runs.get("run-1");
		expect(run?.status).toBe("completed");
		expect(run?.deliveryState).toBe("delivered");
		expect(run?.duplicateDeliveryEventIds).toEqual(["event-4"]);
	});

	it("keeps terminal cancellation sticky and reports sequence or transition corruption", () => {
		const session = SessionManager.inMemory("/repo");
		appendWorkflowEvent(session, event("run_started", 0));
		appendWorkflowEvent(session, event("run_cancelled", 1));
		appendWorkflowEvent(session, event("run_resumed", 3));
		appendWorkflowEvent(session, event("run_completed", 4));

		const run = rebuildWorkflowLedger(session.getEntries()).runs.get("run-1");
		expect(run?.status).toBe("cancelled");
		expect(run?.invalidSequenceEventIds).toEqual(["event-3"]);
		expect(run?.invalidTransitionEventIds).toEqual(["event-3", "event-4"]);
	});

	it("reconstructs an interrupted patch application as unknown instead of replaying it", () => {
		const session = SessionManager.inMemory("/repo");
		appendWorkflowEvent(session, event("run_approved", 0));
		appendWorkflowEvent(session, event("run_started", 1));
		appendWorkflowEvent(session, event("run_completed", 2));
		appendWorkflowEvent(session, event("write_captured", 3, "event-3", { artifactId: "artifact-1" }));
		appendWorkflowEvent(session, event("write_reviewed", 4, "event-4", { artifactId: "artifact-1" }));
		appendWorkflowEvent(session, event("write_apply_started", 5, "event-5", { artifactId: "artifact-1" }));

		const run = rebuildWorkflowLedger(session.getEntries()).runs.get("run-1");

		expect(run?.writeArtifacts.get("artifact-1")?.status).toBe("unknown");
		expect(run?.unknownWriteArtifactIds).toEqual(["artifact-1"]);
		expect(run?.invalidTransitionEventIds).toEqual([]);
	});

	it("rejects malformed events before appending any audit state", () => {
		const session = SessionManager.inMemory("/repo");
		expect(() => appendWorkflowEvent(session, event("run_started", -1))).toThrow("invalid Workflow event");
		expect(rebuildWorkflowLedger(session.getEntries()).events).toEqual([]);
	});
});
