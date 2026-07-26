import * as path from "node:path";
import { getLegacyConfigPath, isEnoent, LEGACY_PLUGIN_LOCKFILE_NAME, PLUGIN_LOCKFILE_NAME } from "@san/utils";

import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}

/**
 * Read a plugin runtime lock from a canonical plugin root.
 * Canonical files win; legacy basenames and `.omp` roots are read-only fallbacks.
 */
export async function loadPluginRuntimeConfig(root: string): Promise<PluginRuntimeConfig> {
	const legacyRoot = getLegacyConfigPath(root);
	const candidates = [
		path.join(root, PLUGIN_LOCKFILE_NAME),
		path.join(root, LEGACY_PLUGIN_LOCKFILE_NAME),
		...(legacyRoot
			? [path.join(legacyRoot, PLUGIN_LOCKFILE_NAME), path.join(legacyRoot, LEGACY_PLUGIN_LOCKFILE_NAME)]
			: []),
	];

	for (const candidate of candidates) {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(candidate).json());
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
	}

	return normalizePluginRuntimeConfig({});
}
