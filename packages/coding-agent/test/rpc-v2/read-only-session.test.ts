import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@san/catalog/models";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { createAgentSession } from "@san/coding-agent/sdk";
import type { AgentSession } from "@san/coding-agent/session/agent-session";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { SESSION_EXIT_CUSTOM_TYPE } from "@san/coding-agent/session/exit-diagnostics";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { removeWithRetries } from "@san/utils";

const tempDirectories: string[] = [];
const authStorages: AuthStorage[] = [];

interface InterruptedSessionFixture {
	session: AgentSession;
	sessionFile: string;
	original: string;
}

async function createInterruptedSessionFixture(): Promise<InterruptedSessionFixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-read-only-"));
	tempDirectories.push(directory);
	const sessionDirectory = path.join(directory, "sessions");
	const source = SessionManager.create(directory, sessionDirectory);
	source.appendMessage({ role: "user", content: "unfinished request", timestamp: Date.now() });
	source.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "SIGTERM",
		kind: "signal",
		recordedAt: new Date().toISOString(),
	});
	await source.ensureOnDisk();
	await source.flush();
	const sessionFile = source.getSessionFile();
	if (!sessionFile) throw new Error("Test Session was not persisted");
	const original = await Bun.file(sessionFile).text();

	const authStorage = await AuthStorage.create(path.join(directory, "auth.db"));
	authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
	const reopened = await SessionManager.open(sessionFile, sessionDirectory, undefined, {
		suppressBreadcrumb: true,
	});
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		authStorage,
		modelRegistry,
		model: getBundledModel("openai", "gpt-4o-mini"),
		sessionManager: reopened,
		sessionAccess: "read_only",
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { session, sessionFile, original };
}

afterEach(async () => {
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

describe("RPC v2 read-only Session startup", () => {
	test("does not repair an interrupted tail or append shutdown diagnostics", async () => {
		const { session, sessionFile, original } = await createInterruptedSessionFixture();
		await session.dispose();
		expect(await Bun.file(sessionFile).text()).toBe(original);
	});

	test("repairs the deferred interrupted tail after recovery enables writes", async () => {
		const { session, sessionFile, original } = await createInterruptedSessionFixture();
		try {
			session.enableSessionWrites();
			session.repairInterruptedTurnAfterRecovery();
			await session.sessionManager.flush();

			expect(await Bun.file(sessionFile).text()).not.toBe(original);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		} finally {
			await session.dispose();
		}
	});
});
