import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalRuleStore, generateFingerprint } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/approval-rules";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

async function policyPath(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-approval-"));
	tempDirectories.push(directory);
	return path.join(directory, "approval-policy.json");
}

describe("RPC v2 approval policy", () => {
	test("uses canonical fingerprints that bind workspace and normalized arguments", () => {
		const first = generateFingerprint({
			requestAction: "tool_execute",
			toolName: "bash",
			operationKind: "exec",
			targetCanonical: '{"command":"git status","timeout":30}',
			riskTier: "exec",
			workspaceRoot: "/workspace",
		});
		const same = generateFingerprint({
			requestAction: "tool_execute",
			toolName: "bash",
			operationKind: "exec",
			targetCanonical: '{"command":"git status","timeout":30}',
			riskTier: "exec",
			workspaceRoot: "/workspace",
		});
		const differentCommand = generateFingerprint({
			requestAction: "tool_execute",
			toolName: "bash",
			operationKind: "exec",
			targetCanonical: '{"command":"git clean -fd","timeout":30}',
			riskTier: "exec",
			workspaceRoot: "/workspace",
		});
		expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(same).toBe(first);
		expect(differentCommand).not.toBe(first);
	});

	test("persists scoped rules and applies request overrides before stored policy", async () => {
		const storagePath = await policyPath();
		const context = { sessionId: "ses_1", cwd: "/workspace" };
		const fingerprint = generateFingerprint({
			requestAction: "tool_execute",
			toolName: "write",
			operationKind: "write",
			targetCanonical: '{"path":"README.md"}',
			riskTier: "write",
			workspaceRoot: context.cwd,
		});
		const store = new ApprovalRuleStore(storagePath);
		await store.load();
		await store.updateDefaults({ scope: "global", patch: { write: "deny" } });
		const rule = await store.addRule({
			scope: "workspace",
			context,
			decision: "allow",
			fingerprint,
			toolName: "write",
			operationKind: "write",
		});

		const restored = new ApprovalRuleStore(storagePath);
		await restored.load();
		expect(
			restored.resolve({ fingerprint, tier: "write", requestOverride: false, canPersistRule: true, context }),
		).toMatchObject({
			scope: "workspace",
			snapshot: { source: "workspace", ruleId: rule.ruleId, effectiveDecision: "allow" },
		});
		expect(
			restored.resolve({ fingerprint, tier: "write", requestOverride: true, canPersistRule: true, context }),
		).toMatchObject({
			scope: "once",
			snapshot: { source: "request_override", effectiveDecision: "ask", canPersistRule: false },
		});
	});
});
