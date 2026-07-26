import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@san/utils";
import { withFileLock } from "../../config/file-lock";

export type RpcRuntimeSettingsScope = "global" | "workspace";
export type ContextMaintenanceMode = "automatic" | "manual" | "disabled";

export interface RpcRuntimeSettingsPatch {
	executionProfile?: string;
	autoRetry?: { enabled?: boolean };
	contextMaintenance?: { mode?: ContextMaintenanceMode };
}

export interface StoredRpcRuntimeSettings {
	schemaVersion: 1;
	revision: number;
	executionProfile?: string;
	autoRetryEnabled?: boolean;
	contextMaintenanceMode?: ContextMaintenanceMode;
}

const EMPTY_SETTINGS: StoredRpcRuntimeSettings = {
	schemaVersion: 1,
	revision: 0,
};

export class RuntimeSettingsRevisionError extends Error {
	readonly expectedRevision: number;
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Runtime settings revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
		this.name = "RuntimeSettingsRevisionError";
		this.expectedRevision = expectedRevision;
		this.currentRevision = currentRevision;
	}
}

/** RPC v2 的 global/workspace 运行设置覆盖层；Session 覆盖仍保存在 Session sidecar。 */
export class RpcV2RuntimeSettingsStore {
	async load(scope: RpcRuntimeSettingsScope, cwd?: string): Promise<StoredRpcRuntimeSettings> {
		return await this.#loadPath(this.#settingsPath(scope, cwd));
	}

	async update(
		scope: RpcRuntimeSettingsScope,
		cwd: string | undefined,
		patch: RpcRuntimeSettingsPatch,
		expectedRevision?: number,
	): Promise<StoredRpcRuntimeSettings> {
		const settingsPath = this.#settingsPath(scope, cwd);
		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		return await withFileLock(settingsPath, async () => {
			const current = await this.#loadPath(settingsPath);
			if (expectedRevision !== undefined && current.revision !== expectedRevision) {
				throw new RuntimeSettingsRevisionError(expectedRevision, current.revision);
			}
			const next: StoredRpcRuntimeSettings = {
				...current,
				revision: current.revision + 1,
				...(patch.executionProfile !== undefined ? { executionProfile: patch.executionProfile } : {}),
				...(patch.autoRetry?.enabled !== undefined ? { autoRetryEnabled: patch.autoRetry.enabled } : {}),
				...(patch.contextMaintenance?.mode !== undefined
					? { contextMaintenanceMode: patch.contextMaintenance.mode }
					: {}),
			};
			const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await Bun.write(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
				await fs.rename(temporaryPath, settingsPath);
			} finally {
				await fs.rm(temporaryPath, { force: true });
			}
			return structuredClone(next);
		});
	}

	#settingsPath(scope: RpcRuntimeSettingsScope, cwd?: string): string {
		if (scope === "global") return path.join(getAgentDir(), "rpc-v2-runtime-settings.json");
		if (!cwd || !path.isAbsolute(cwd)) throw new Error("Workspace runtime settings require an absolute cwd");
		return path.join(path.resolve(cwd), ".san", "rpc-v2-runtime-settings.json");
	}

	async #loadPath(settingsPath: string): Promise<StoredRpcRuntimeSettings> {
		let value: unknown;
		try {
			value = await Bun.file(settingsPath).json();
		} catch (error: unknown) {
			if (isEnoent(error)) return structuredClone(EMPTY_SETTINGS);
			throw error;
		}
		if (!isRecord(value)) throw new Error(`Invalid RPC runtime settings file: ${settingsPath}`);
		const revision = value.revision;
		if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
			throw new Error(`Invalid RPC runtime settings revision: ${settingsPath}`);
		}
		const contextMaintenanceMode = value.contextMaintenanceMode;
		if (
			contextMaintenanceMode !== undefined &&
			contextMaintenanceMode !== "automatic" &&
			contextMaintenanceMode !== "manual" &&
			contextMaintenanceMode !== "disabled"
		) {
			throw new Error(`Invalid RPC context maintenance mode: ${settingsPath}`);
		}
		if (value.executionProfile !== undefined && typeof value.executionProfile !== "string") {
			throw new Error(`Invalid RPC execution profile: ${settingsPath}`);
		}
		if (value.autoRetryEnabled !== undefined && typeof value.autoRetryEnabled !== "boolean") {
			throw new Error(`Invalid RPC auto retry setting: ${settingsPath}`);
		}
		return {
			schemaVersion: 1,
			revision: revision as number,
			...(typeof value.executionProfile === "string" ? { executionProfile: value.executionProfile } : {}),
			...(typeof value.autoRetryEnabled === "boolean" ? { autoRetryEnabled: value.autoRetryEnabled } : {}),
			...(contextMaintenanceMode ? { contextMaintenanceMode } : {}),
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
