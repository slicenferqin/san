/**
 * Bun `--preload` shim for the San development launcher (`scripts/san`).
 *
 * The launcher starts Bun from an empty, bunfig-free directory so a foreign
 * project's `bunfig.toml` preload cannot run inside the San CLI. This shim is
 * loaded before the entrypoint imports, then restores the user's original
 * working directory for import-time path snapshots.
 */
const launchCwd = process.env.SAN_LAUNCH_CWD;
if (launchCwd) {
	delete process.env.SAN_LAUNCH_CWD;
	try {
		process.chdir(launchCwd);
	} catch {}
}
