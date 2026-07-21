/**
 * San RPC v2 Resource Upload Manager.
 *
 * Handles chunked resource uploads with hash verification.
 * Resources are session-scoped and immutable after commit.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InputResourceRef } from "./dto/resources";
import type { ResourceId, SessionId, UploadId } from "./protocol/ids";
import { newResourceId, newUploadId } from "./protocol/ids";

interface ActiveUpload {
	uploadId: UploadId;
	resourceId: ResourceId;
	sessionId: SessionId;
	mediaType: string;
	fileName?: string;
	expectedByteLength: number;
	expectedSha256: string;
	receivedBytes: number;
	tmpPath: string;
	state: "uploading" | "committed" | "rejected";
}

export class ResourceUploadManager {
	#uploads = new Map<string, ActiveUpload>();
	#resources = new Map<string, InputResourceRef>();
	#uploadDir: string;
	#chunkLimit: number;

	constructor(options?: { uploadDir?: string; chunkLimit?: number }) {
		this.#uploadDir = options?.uploadDir ?? path.join(import.meta.dir, ".uploads");
		this.#chunkLimit = options?.chunkLimit ?? 262_144; // 256 KiB
	}

	get chunkLimit(): number {
		return this.#chunkLimit;
	}

	/** Begin a new upload. Returns uploadId and resourceId. */
	async begin(params: {
		sessionId: SessionId;
		mediaType: string;
		fileName?: string;
		byteLength: number;
		sha256: string;
	}): Promise<{ uploadId: UploadId; resourceId: ResourceId; chunkLimit: number }> {
		const uploadId = newUploadId();
		const resourceId = newResourceId();

		await fs.mkdir(this.#uploadDir, { recursive: true });
		const tmpPath = path.join(this.#uploadDir, `${uploadId}.part`);

		this.#uploads.set(uploadId, {
			uploadId,
			resourceId,
			sessionId: params.sessionId,
			mediaType: params.mediaType,
			fileName: params.fileName,
			expectedByteLength: params.byteLength,
			expectedSha256: params.sha256,
			receivedBytes: 0,
			tmpPath,
			state: "uploading",
		});

		return { uploadId, resourceId, chunkLimit: this.#chunkLimit };
	}

	/** Accept a chunk at the given offset. Chunks must be sequential. */
	async chunk(params: {
		uploadId: UploadId;
		offset: number;
		dataBase64: string;
	}): Promise<{ acceptedOffset: number }> {
		const upload = this.#uploads.get(params.uploadId);
		if (upload?.state !== "uploading") {
			throw new Error(`Upload ${params.uploadId} not found or not in uploading state`);
		}
		if (params.offset !== upload.receivedBytes) {
			throw new Error(`Chunk offset mismatch: expected ${upload.receivedBytes}, got ${params.offset}`);
		}

		const data = Buffer.from(params.dataBase64, "base64");
		if (data.length > this.#chunkLimit) {
			throw new Error(`Chunk exceeds limit: ${data.length} > ${this.#chunkLimit}`);
		}

		await fs.appendFile(upload.tmpPath, data);
		upload.receivedBytes += data.length;

		return { acceptedOffset: upload.receivedBytes };
	}

	/** Commit an upload after all chunks are received. Verifies length and hash. */
	async commit(params: { uploadId: UploadId; sha256: string }): Promise<InputResourceRef> {
		const upload = this.#uploads.get(params.uploadId);
		if (upload?.state !== "uploading") {
			throw new Error(`Upload ${params.uploadId} not found or not in uploading state`);
		}
		if (upload.receivedBytes !== upload.expectedByteLength) {
			upload.state = "rejected";
			throw new Error(`Length mismatch: received ${upload.receivedBytes}, expected ${upload.expectedByteLength}`);
		}

		// Verify hash
		const fileData = await fs.readFile(upload.tmpPath);
		const hash = Buffer.from(await crypto.subtle.digest("SHA-256", fileData)).toString("hex");
		if (hash !== params.sha256) {
			upload.state = "rejected";
			throw new Error(`SHA-256 mismatch: computed ${hash}, expected ${params.sha256}`);
		}

		upload.state = "committed";
		this.#uploads.delete(params.uploadId);

		const resource: InputResourceRef = {
			resourceId: upload.resourceId,
			sessionId: upload.sessionId,
			source: "upload",
			mediaType: upload.mediaType,
			byteLength: upload.expectedByteLength,
			sha256: params.sha256,
			fileName: upload.fileName,
			state: "committed",
		};

		this.#resources.set(upload.resourceId, resource);
		return resource;
	}

	/** Get a committed resource by ID. */
	getResource(resourceId: string): InputResourceRef | undefined {
		return this.#resources.get(resourceId);
	}

	/** Release a resource. */
	release(resourceId: string): boolean {
		const resource = this.#resources.get(resourceId);
		if (!resource) return false;
		resource.state = "released";
		this.#resources.delete(resourceId);
		return true;
	}

	/** Clean up all pending uploads. */
	async cleanup(): Promise<void> {
		for (const [, upload] of this.#uploads) {
			if (upload.state === "uploading") {
				await fs.rm(upload.tmpPath, { force: true }).catch(() => {});
			}
		}
		this.#uploads.clear();
	}
}
