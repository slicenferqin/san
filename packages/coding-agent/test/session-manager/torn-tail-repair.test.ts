import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFile } from "@san/coding-agent/session/session-loader";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@san/utils";

import { makeAssistantMessage } from "./helpers";

// Durability contract: resuming a file whose tail is torn (a partial append that
// died mid-write) must not append new records onto the garbage — the next append
// full-rewrites the in-memory entries, repairing the file. A transient append
// failure keeps the entries in memory, latches the first persistence error, and
// lets a later append retry the full rewrite instead of losing the entries.

const ISO = "2026-06-29T12:00:00.000Z";

function strictParseLines(raw: string): Array<Record<string, unknown>> {
	return raw
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

function messageTexts(entries: Array<{ type: string }>): string[] {
	return entries
		.filter(entry => entry.type === "message")
		.map(entry => {
			if (typeof entry !== "object" || entry === null || !("message" in entry)) return "";
			const message = entry.message;
			if (typeof message !== "object" || message === null || !("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
					.join("");
			}
			return "";
		});
}

describe("SessionManager torn-tail repair and transient append recovery", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-torn-tail-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("repairs a torn tail on the first append after resuming", async () => {
		const sessionFile = path.join(cwd, "session.jsonl");
		const header = { type: "session", version: 3, id: "sess-1", timestamp: ISO, cwd };
		const kept = {
			type: "message",
			id: "m1",
			parentId: "sess-1",
			timestamp: ISO,
			message: { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 0 },
		};
		// 模拟崩溃中断的追加：最后一行是截断的 JSON（无换行）。
		const torn = '{"type":"message","id":"m2"';
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(kept)}\n${torn}`);

		const manager = await SessionManager.open(sessionFile);
		// 恢复本身不应改动文件 —— 修复发生在下一次 append。
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(`${JSON.stringify(header)}\n${JSON.stringify(kept)}\n${torn}`);

		manager.appendMessage({ role: "user", content: "after resume", timestamp: Date.now() });

		const raw = fs.readFileSync(sessionFile, "utf8");
		// 修复后的文件必须全行可解析——没有撕裂字节残留。
		expect(() => strictParseLines(raw)).not.toThrow();
		const parsed = strictParseLines(raw);
		const loaded = await loadEntriesFromFile(sessionFile);
		expect(loaded.map(entry => entry.type)).toEqual(["session", "message", "message"]);
		expect(messageTexts(loaded as Array<{ type: string }>)).toEqual(["kept", "after resume"]);
		expect(parsed.some(line => JSON.stringify(line).includes("after resume"))).toBe(true);
		await manager.close();
	});

	it("marks a resumed torn file rewrite-required so a title change repairs it too", async () => {
		const sessionFile = path.join(cwd, "session.jsonl");
		const header = { type: "session", version: 3, id: "sess-2", timestamp: ISO, cwd };
		const kept = {
			type: "message",
			id: "m1",
			parentId: "sess-2",
			timestamp: ISO,
			message: { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 0 },
		};
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(kept)}\n{garbage`);

		const manager = await SessionManager.open(sessionFile);
		await manager.setSessionName("Repaired title", "user");

		const raw = fs.readFileSync(sessionFile, "utf8");
		expect(() => strictParseLines(raw)).not.toThrow();
		const loaded = await loadEntriesFromFile(sessionFile);
		expect(messageTexts(loaded as Array<{ type: string }>)).toEqual(["kept"]);
		await manager.close();
	});

	it("keeps entries in memory on a transient append failure and recovers on the next append", async () => {
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const beforeBytes = fs.readFileSync(sessionFile);

		// 注入一次瞬时失败：对包含 FAIL_ME 的行先真实写入 1 字节（模拟部分写入），
		// 下一轮循环抛错；writeTextSync（恢复重写）走 writeFileSync，不受影响。
		const realWriteSync = fs.writeSync.bind(fs);
		let failArmed = false;
		let failInjected = false;
		const writeSyncSpy = vi.spyOn(fs, "writeSync").mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset?: number | null,
			length?: number | null,
			position?: number | null,
		) => {
			const text = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString("utf8");
			const isFailLine = text.includes("FAIL_ME");
			if (isFailLine && !failInjected) {
				if (!failArmed) {
					failArmed = true;
					return realWriteSync(fd, buffer, offset, 1, position);
				}
				failInjected = true;
				throw new Error("injected transient append failure");
			}
			return realWriteSync(fd, buffer, offset, length, position);
		}) as typeof fs.writeSync);

		manager.appendMessage({ role: "user", content: "FAIL_ME entry", timestamp: 2 });
		// 等待 fire-and-forget append 的 rejection 链完成 diskFailure 的锁存。
		for (let i = 0; i < 20; i++) await Promise.resolve();

		// 失败后文件逐字节不变（部分写入被回退），且显式错误表面立即可见。
		expect(fs.readFileSync(sessionFile).equals(beforeBytes)).toBe(true);
		expect(writeSyncSpy).toHaveBeenCalled();
		expect(() => manager.flushSync()).toThrow("injected transient append failure");

		vi.restoreAllMocks();
		manager.appendMessage({ role: "user", content: "recovers", timestamp: 3 });

		// 恢复重写：全部内存条目（含此前失败的条目）都落盘，且文件全行可解析。
		const raw = fs.readFileSync(sessionFile, "utf8");
		expect(() => strictParseLines(raw)).not.toThrow();
		const loaded = await loadEntriesFromFile(sessionFile);
		const texts = messageTexts(loaded as Array<{ type: string }>);
		expect(texts).toEqual(["first", "ok", "FAIL_ME entry", "recovers"]);
		expect(() => manager.flushSync()).not.toThrow();
		await manager.close();
	});
});
