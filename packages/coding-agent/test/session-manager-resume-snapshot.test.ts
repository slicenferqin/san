import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resumeSnapshotPath } from "@san/coding-agent/session/resume-snapshot";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@san/coding-agent/session/session-storage";

const cleanups: string[] = [];
afterEach(async () => {
	while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});
async function root(): Promise<string> {
	const value = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "san-resume-snapshot-"));
	cleanups.push(value);
	return value;
}

describe("SessionManager ResumeSnapshot", () => {
	it("keeps the last usable snapshot and journal when a newer runtime exceeds the cache limit", async () => {
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("缺少会话文件");
		const sidecar = resumeSnapshotPath(file);
		const previous = await Bun.file(sidecar).text();
		const content = "x".repeat(400_000);
		let appended = "";
		for (let index = 0; index < 44; index++) {
			appended = manager.appendMessage({ role: "user", content, timestamp: index + 2 });
		}
		await manager.flush();
		await manager.refreshResumeSnapshot();
		expect(await Bun.file(sidecar).text()).toBe(previous);
		const resumed = await SessionManager.open(file, path.dirname(file));
		const restored = resumed.getEntry(appended);
		if (restored?.type !== "message" || restored.message.role !== "user") throw new Error("恢复后缺少新增用户消息");
		expect(restored.message.content).toBe(content);
		await resumed.close();
		await manager.close();
	});

	it("replays only the tail after an explicit snapshot publication", async () => {
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const first = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		expect(await Bun.file(resumeSnapshotPath(file)).exists()).toBe(true);
		const tail = manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");
		await manager.flush();
		const resumed = await SessionManager.open(file, path.dirname(file));
		const ids = resumed.getBranch().map(entry => entry.id);
		expect(ids).toContain(first);
		expect(ids).toContain(tail);
		expect(resumed.getLastModelChangeRole()).toBe("slow");
		expect(resumed.getRuntimeBranch().map(entry => entry.id)).toEqual(ids);
		await resumed.close();
		await manager.close();
	});

	it("uses complete journal fallback for corrupt, truncated, or missing sidecars", async () => {
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const id = manager.appendModelChange("provider/model", "default");
		manager.appendModelChange("provider/model", "default");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		const sidecar = resumeSnapshotPath(file);
		for (const body of ["{truncated", '\n{"schemaVersion":1}']) {
			await fs.writeFile(sidecar, body);
			const reopened = await SessionManager.open(file, path.dirname(file));
			expect(reopened.getBranch().map(entry => entry.id)).toContain(id);
			await reopened.close();
		}
		await fs.rm(sidecar);
		const missing = await SessionManager.open(file, path.dirname(file));
		expect(missing.getBranch().map(entry => entry.id)).toContain(id);
		await missing.close();
		await manager.close();
	});

	it("opens through MemorySessionStorage and retains full history after fork", async () => {
		const storage = new MemorySessionStorage();
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), storage);
		const id = manager.appendModelChange("provider/model", "default");
		manager.appendModelChange("provider/model", "slow");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		const reopened = await SessionManager.open(file, path.dirname(file), storage);
		expect(reopened.getBranch().map(entry => entry.id)).toContain(id);
		const fork = await SessionManager.forkFrom(file, path.join(cwd, "other"), path.join(cwd, "fork"), storage);
		expect(fork.getBranch().length).toBe(reopened.getBranch().length);
		await fork.close();
		await reopened.close();
		await manager.close();
	});

	it("keeps custom entries and cumulative usage across snapshot resume", async () => {
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const user = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const custom = manager.appendCustomEntry("artifact_marker", { namespace: "run-1", value: 7 });
		manager.appendMessage({ role: "assistant", content: "answer", timestamp: 2 } as never);
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		manager.appendCustomEntry("artifact_marker", { namespace: "run-1", value: 8 });
		await manager.flush();
		const resumed = await SessionManager.open(file, path.dirname(file));
		expect(resumed.getEntry(user)?.id).toBe(user);
		const restoredCustom = resumed.getEntry(custom);
		expect(restoredCustom?.type).toBe("custom");
		if (restoredCustom?.type !== "custom") throw new Error("恢复后缺少 artifact_marker 条目");
		expect(restoredCustom.data).toEqual({ namespace: "run-1", value: 7 });
		expect(resumed.getEntries().filter(entry => entry.type === "custom").length).toBe(2);
		expect(resumed.getTree().length).toBeGreaterThan(0);
		await resumed.close();
		await manager.close();
	});

	it("hydrates compact runtime while preserving complete history on demand", async () => {
		const cwd = await root();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		let firstId = "";
		for (let i = 0; i < 230; i++) {
			const id = manager.appendMessage({
				role: "user",
				content: `history-${i}-${"x".repeat(14_000)}`,
				timestamp: i,
			});
			if (i === 0) firstId = id;
		}
		const firstKeptId = manager.getBranch()[220]?.id;
		if (!firstKeptId) throw new Error("first kept entry missing");
		const compactionId = manager.appendCompaction("historical summary", undefined, firstKeptId, 1000);
		const currentUser = manager.appendMessage({ role: "user", content: "current request", timestamp: 231 });
		const pendingAssistant = manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "pending-1", name: "Read", arguments: { path: "notes.md" } }],
			timestamp: 232,
		} as never);
		const currentModel = manager.appendModelChange("provider/model", "current");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.refreshResumeSnapshot();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session file missing");
		expect((await fs.stat(file)).size).toBeGreaterThan(3_000_000);

		const resumed = await SessionManager.open(file, path.dirname(file));
		const full = resumed.getBranch();
		expect(full.map(entry => entry.id)).toContain(firstId);
		expect(full.map(entry => entry.id)).toContain(firstKeptId);
		expect(full.map(entry => entry.id)).toContain(compactionId);
		expect(full.map(entry => entry.id)).toContain(currentUser);
		expect(full.map(entry => entry.id)).toContain(currentModel);
		expect(resumed.getEntry(firstKeptId)?.id).toBe(firstKeptId);
		const runtime = resumed.getRuntimeBranch();
		expect(runtime.map(entry => entry.id)).toContain(firstKeptId);
		expect(runtime.map(entry => entry.id)).toContain(compactionId);
		expect(full.map(entry => entry.id)).toContain(pendingAssistant);
		expect(runtime.map(entry => entry.id)).toContain(pendingAssistant);
		expect(runtime.map(entry => entry.id)).toContain(currentUser);
		expect(runtime.map(entry => entry.id)).toContain(currentModel);
		expect(JSON.stringify(runtime)).not.toContain("history-0-");
		await resumed.close();
		await manager.close();
	});
});
