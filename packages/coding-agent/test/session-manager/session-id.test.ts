import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectUuidV7SessionId(session: SessionManager): string {
	const sessionId = session.getSessionId();
	expect(sessionId).toMatch(UUID_V7_RE);
	const header = session.getHeader();
	if (!header) throw new Error("Expected session header");
	expect(header.id).toBe(sessionId);
	return sessionId;
}

describe("SessionManager session ids", () => {
	it("generates UUIDv7 ids for new in-memory sessions", () => {
		const session = SessionManager.inMemory();

		expectUuidV7SessionId(session);
	});

	it("generates a fresh UUIDv7 when starting a new session", async () => {
		const session = SessionManager.inMemory();
		const firstId = expectUuidV7SessionId(session);
		const changes: Array<{ previousSessionId: string; sessionId: string }> = [];
		session.onSessionIdentityChanged(change => changes.push(change));

		await session.newSession();

		const secondId = expectUuidV7SessionId(session);
		expect(secondId).not.toBe(firstId);
		expect(changes).toEqual([{ previousSessionId: firstId, sessionId: secondId }]);
	});

	it("generates a UUIDv7 when branching a session", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const branchPointId = session.appendMessage({ role: "user", content: "follow up", timestamp: 2 });
		const firstId = expectUuidV7SessionId(session);
		const changes: Array<{ previousSessionId: string; sessionId: string }> = [];
		session.onSessionIdentityChanged(change => changes.push(change));

		session.createBranchedSession(branchPointId);

		const branchedId = expectUuidV7SessionId(session);
		expect(branchedId).not.toBe(firstId);
		expect(changes).toEqual([{ previousSessionId: firstId, sessionId: branchedId }]);
	});

	it("generates a UUIDv7 when forking a persisted session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-fork-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();
		const firstId = expectUuidV7SessionId(session);
		const changes: Array<{ previousSessionId: string; sessionId: string }> = [];
		session.onSessionIdentityChanged(change => changes.push(change));

		const forkResult = await session.fork();
		if (!forkResult) throw new Error("Expected fork result");

		const forkedId = expectUuidV7SessionId(session);
		expect(forkedId).not.toBe(firstId);
		expect(session.getHeader()?.parentSession).toBe(firstId);
		expect(changes).toEqual([{ previousSessionId: firstId, sessionId: forkedId }]);
	});

	it("stops notifying after an identity listener is removed", async () => {
		const session = SessionManager.inMemory();
		let calls = 0;
		const unregister = session.onSessionIdentityChanged(() => calls++);
		unregister();

		await session.newSession();

		expect(calls).toBe(0);
	});

	it("preserves existing session ids when reopening a saved session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-open-");
		const sessionFile = path.join(tempDir.path(), "existing.jsonl");
		const existingId = "existing-session-id";
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ type: "session", id: existingId, timestamp: new Date().toISOString(), cwd: tempDir.path() })}\n`,
		);

		const session = await SessionManager.open(sessionFile, tempDir.path());

		expect(session.getSessionId()).toBe(existingId);
		expect(session.getHeader()?.id).toBe(existingId);
	});
});
