import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	RpcV2RuntimeSettingsStore,
	RuntimeSettingsRevisionError,
} from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/runtime-settings-store";
import { RpcV2SessionManager } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let root: string;
let agentDir: string;
let workspaceDir: string;

beforeEach(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-rpc-settings-"));
	agentDir = path.join(root, "agent");
	workspaceDir = path.join(root, "workspace");
	await fs.promises.mkdir(workspaceDir, { recursive: true });
	resetSettingsForTest();
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });
});

afterEach(async () => {
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fs.promises.rm(root, { recursive: true, force: true });
});

describe("RPC v2 runtime settings", () => {
	it("persists global settings without an active session and rejects stale revisions", async () => {
		const manager = new RpcV2SessionManager({ runtimeId: "rt_settings_primary" });
		expect(manager.currentSessionId).toBeUndefined();

		const initial = await manager.getScopedSettings("global");
		expect(initial).toMatchObject({
			schemaVersion: 1,
			revision: 0,
			executionProfile: { effective: "solo", source: "builtin" },
			autoRetry: { effective: { enabled: true }, source: "builtin" },
			contextMaintenance: { effective: { mode: "automatic" }, source: "builtin" },
		});

		const updated = await manager.updateScopedSettings(
			"global",
			undefined,
			{
				executionProfile: "solo",
				autoRetry: { enabled: false },
				contextMaintenance: { mode: "manual" },
			},
			0,
		);
		expect(updated).toMatchObject({
			schemaVersion: 1,
			revision: 1,
			executionProfile: { configured: "solo", effective: "solo", source: "global" },
			autoRetry: {
				configured: { enabled: false },
				effective: { enabled: false },
				source: "global",
			},
			contextMaintenance: {
				configured: { mode: "manual" },
				effective: { mode: "manual" },
				source: "global",
			},
		});

		const reloaded = await new RpcV2SessionManager({ runtimeId: "rt_settings_reloaded" }).getScopedSettings("global");
		expect(reloaded).toEqual(updated);

		try {
			await manager.updateScopedSettings("global", undefined, { executionProfile: "team" }, 0);
			expect.unreachable("stale settings revision should fail");
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(RuntimeSettingsRevisionError);
			if (!(error instanceof RuntimeSettingsRevisionError)) throw error;
			expect(error).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
		}
	});

	it("persists workspace overrides and resolves them over global settings", async () => {
		const manager = new RpcV2SessionManager({ runtimeId: "rt_workspace_settings" });
		await manager.updateScopedSettings("global", undefined, { executionProfile: "council" }, 0);

		const updated = await manager.updateScopedSettings(
			"workspace",
			workspaceDir,
			{ autoRetry: { enabled: false }, contextMaintenance: { mode: "disabled" } },
			0,
		);
		expect(updated).toMatchObject({
			revision: 1,
			executionProfile: { effective: "council", source: "global" },
			autoRetry: {
				configured: { enabled: false },
				effective: { enabled: false },
				source: "workspace",
			},
			contextMaintenance: {
				configured: { mode: "disabled" },
				effective: { mode: "disabled" },
				source: "workspace",
			},
		});

		const reloaded = await new RpcV2SessionManager({ runtimeId: "rt_workspace_reloaded" }).getScopedSettings(
			"workspace",
			workspaceDir,
		);
		expect(reloaded).toEqual(updated);

		const global = await manager.getScopedSettings("global");
		expect(global).toMatchObject({
			revision: 1,
			executionProfile: { configured: "council", effective: "council", source: "global" },
			autoRetry: { effective: { enabled: true }, source: "builtin" },
		});
	});

	it("requires an absolute workspace path", async () => {
		const store = new RpcV2RuntimeSettingsStore();
		await expect(store.load("workspace", "relative/path")).rejects.toThrow("absolute cwd");
		await expect(store.update("workspace", "relative/path", { executionProfile: "solo" })).rejects.toThrow(
			"absolute cwd",
		);
	});
});
