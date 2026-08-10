import * as path from "node:path";
import { getConfigRootDir } from "@san/utils";

/** Token file authenticating every socket client of the peers broker. */
export const PEERS_TOKEN_FILE = "peers.token";

/** PID lease file selecting the live broker among racing spawns. */
export const PEERS_PID_FILE = "broker.pid";

/** Resolve the user-global runtime directory shared by every cross-session peer broker. */
export function peersRuntimeDir(configRoot: string = getConfigRootDir()): string {
	return path.join(configRoot, "run", "peers");
}

/** Resolve the Unix socket or Windows named pipe used by the peers broker. */
export function peersBrokerEndpoint(runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(runtimeDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\san-peers-${key}`;
	}
	return path.join(runtimeDir, "peers.sock");
}
