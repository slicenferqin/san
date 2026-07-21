import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	IdempotencyConflictError,
	IdempotencyInProgressError,
	IdempotencyOutcomeUnknownError,
	SessionCreateReceiptStore,
} from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/idempotency";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

async function tempDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-idempotency-"));
	tempDirectories.push(directory);
	return directory;
}

describe("RPC v2 Session create receipts", () => {
	test("persists a completed Session identity across store instances", async () => {
		const directory = await tempDirectory();
		const firstStore = new SessionCreateReceiptStore(directory);
		const first = await firstStore.begin("create-key", { method: "session.create", cwd: "/workspace" });
		if (first.cached) throw new Error("Expected a new reservation");
		await expect(
			firstStore.begin("create-key", { method: "session.create", cwd: "/workspace" }),
		).rejects.toBeInstanceOf(IdempotencyInProgressError);
		await firstStore.complete(first.reservation, "ses_original");

		const replay = await new SessionCreateReceiptStore(directory).begin("create-key", {
			method: "session.create",
			cwd: "/workspace",
		});
		expect(replay).toEqual({ cached: true, sessionId: "ses_original" });
		await expect(
			new SessionCreateReceiptStore(directory).begin("create-key", { method: "session.create", cwd: "/other" }),
		).rejects.toBeInstanceOf(IdempotencyConflictError);
	});

	test("does not repeat a side effect when a previous process died before recording its outcome", async () => {
		const directory = await tempDirectory();
		const store = new SessionCreateReceiptStore(directory);
		const pending = await store.begin("unknown-key", { cwd: "/workspace" });
		if (pending.cached) throw new Error("Expected a new reservation");
		const receipt = JSON.parse(await Bun.file(pending.reservation.path).text()) as Record<string, unknown>;
		await Bun.write(pending.reservation.path, `${JSON.stringify({ ...receipt, pid: 2_147_483_647 })}\n`);

		await expect(
			new SessionCreateReceiptStore(directory).begin("unknown-key", { cwd: "/workspace" }),
		).rejects.toBeInstanceOf(IdempotencyOutcomeUnknownError);
	});
});
