import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionId, UploadId } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/protocol/ids";
import { ResourceUploadManager } from "@oh-my-pi/pi-coding-agent/modes/rpc-v2/resource-upload";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirectories: string[] = [];

afterEach(async () => {
	for (const directory of tempDirectories.splice(0)) await removeWithRetries(directory);
});

test("RPC v2 resource upload resumes, validates hashes, and releases committed bytes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-resource-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	const sessionId = "ses_resource" as SessionId;
	const bytes = Buffer.from("hello resource", "utf8");
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const chunkSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

	const first = new ResourceUploadManager({ chunkLimit: 64 });
	await first.bind({ sessionId, sessionFile });
	const begun = await first.begin({ sessionId, mediaType: "text/plain", byteLength: bytes.length, sha256 });
	await expect(
		first.chunk({ uploadId: begun.uploadId, offset: 0, dataBase64: bytes.toString("base64"), chunkSha256 }),
	).resolves.toEqual({
		acceptedOffset: bytes.length,
	});
	await first.close();

	const resumed = new ResourceUploadManager({ chunkLimit: 64 });
	await resumed.bind({ sessionId, sessionFile });
	expect(resumed.pendingUploadCount).toBe(1);
	await expect(
		resumed.chunk({
			uploadId: begun.uploadId as UploadId,
			offset: 0,
			dataBase64: bytes.toString("base64"),
			chunkSha256,
		}),
	).resolves.toEqual({
		acceptedOffset: bytes.length,
	});
	const resource = await resumed.commit({ uploadId: begun.uploadId, sha256 });
	expect(await resumed.readResource(resource.resourceId, sessionId)).toEqual(new Uint8Array(bytes));
	expect(await resumed.release(resource.resourceId, sessionId)).toBe(true);
	await expect(resumed.readResource(resource.resourceId, sessionId)).rejects.toThrow("Resource not found");
});

test("RPC v2 read-only resource binding neither creates storage nor accepts mutations", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "san-rpc-v2-resource-read-only-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	const resourceDirectory = `${sessionFile}.rpc-v2.resources`;
	const sessionId = "ses_read_only" as SessionId;
	const manager = new ResourceUploadManager();

	await manager.bind({ sessionId, sessionFile, readOnly: true });
	await expect(
		manager.begin({
			sessionId,
			mediaType: "text/plain",
			byteLength: 0,
			sha256: new Bun.CryptoHasher("sha256").update("").digest("hex"),
		}),
	).rejects.toThrow("bound read_only");
	await expect(fs.stat(resourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	await manager.close();
});
