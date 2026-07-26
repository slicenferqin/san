/** RPC v2 Session 级输入资源上传、恢复与完整性校验。 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@san/utils";
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
	state: "uploading" | "rejected";
}

interface ResourceManifest {
	schemaVersion: 1;
	uploads: ActiveUpload[];
	resources: InputResourceRef[];
}

export interface HostResourceMetadata {
	mediaType?: string;
	fileName?: string;
	byteLength?: number;
	sha256?: string;
}

export type ResourceUploadErrorReason = "not_found" | "invalid";

export class ResourceUploadError extends Error {
	readonly reason: ResourceUploadErrorReason;

	constructor(reason: ResourceUploadErrorReason, message: string) {
		super(message);
		this.name = "ResourceUploadError";
		this.reason = reason;
	}
}

const DEFAULT_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"text/plain",
	"application/json",
	"application/octet-stream",
] as const;

export class ResourceUploadManager {
	#uploads = new Map<string, ActiveUpload>();
	#resources = new Map<string, InputResourceRef>();
	#uploadDir: string | undefined;
	#manifestPath: string | undefined;
	#sessionId: SessionId | undefined;
	#readOnly = false;
	readonly #chunkLimit: number;
	readonly #maxResourceBytes: number;
	readonly #acceptedMediaTypes: ReadonlySet<string>;

	constructor(options?: {
		chunkLimit?: number;
		maxResourceBytes?: number;
		acceptedMediaTypes?: readonly string[];
	}) {
		this.#chunkLimit = options?.chunkLimit ?? 262_144;
		this.#maxResourceBytes = options?.maxResourceBytes ?? 26_214_400;
		this.#acceptedMediaTypes = new Set(options?.acceptedMediaTypes ?? DEFAULT_MEDIA_TYPES);
	}

	get chunkLimit(): number {
		return this.#chunkLimit;
	}

	get entries(): InputResourceRef[] {
		return [...this.#resources.values()].map(resource => structuredClone(resource));
	}

	get pendingUploadCount(): number {
		return this.#uploads.size;
	}

	/** 切换到当前 Session；manifest 与 state sidecar 共同恢复已提交元数据。 */
	async bind(params: {
		sessionId: SessionId;
		sessionFile?: string;
		persistedResources?: readonly Record<string, unknown>[];
		readOnly?: boolean;
	}): Promise<void> {
		await this.close();
		this.#sessionId = params.sessionId;
		this.#readOnly = params.readOnly === true;
		this.#uploadDir = params.sessionFile
			? `${params.sessionFile}.rpc-v2.resources`
			: path.join(os.tmpdir(), "san-rpc-v2", params.sessionId, "resources");
		this.#manifestPath = path.join(this.#uploadDir, "manifest.json");
		if (!this.#readOnly) await fs.mkdir(this.#uploadDir, { recursive: true });

		let manifest: ResourceManifest | undefined;
		try {
			manifest = validateManifest(await Bun.file(this.#manifestPath).json(), params.sessionId);
		} catch (error: unknown) {
			if (!isEnoent(error)) {
				throw new Error(`Failed to load RPC v2 resource manifest ${this.#manifestPath}: ${String(error)}`);
			}
		}

		this.#uploads.clear();
		this.#resources.clear();
		for (const upload of manifest?.uploads ?? []) this.#uploads.set(upload.uploadId, upload);
		for (const resource of manifest?.resources ?? []) this.#resources.set(resource.resourceId, resource);
		for (const value of params.persistedResources ?? []) {
			const resource = reviveResource(value, params.sessionId);
			if (resource && !this.#resources.has(resource.resourceId)) this.#resources.set(resource.resourceId, resource);
		}
		if (!this.#readOnly) await this.#saveManifest();
	}

	async begin(params: {
		sessionId: SessionId;
		mediaType: string;
		fileName?: string;
		byteLength: number;
		sha256: string;
	}): Promise<{ uploadId: UploadId; resourceId: ResourceId; chunkLimit: number; acceptedOffset: number }> {
		this.#assertBoundSession(params.sessionId);
		this.#assertWritable();
		if (
			!Number.isSafeInteger(params.byteLength) ||
			params.byteLength < 0 ||
			params.byteLength > this.#maxResourceBytes
		) {
			throw new ResourceUploadError(
				"invalid",
				`Resource byteLength must be between 0 and ${this.#maxResourceBytes}`,
			);
		}
		assertSha256(params.sha256, "Resource sha256");
		if (!this.#acceptedMediaTypes.has(params.mediaType)) {
			throw new ResourceUploadError("invalid", `Unsupported resource media type: ${params.mediaType}`);
		}

		const uploadId = newUploadId();
		const resourceId = newResourceId();
		const upload: ActiveUpload = {
			uploadId,
			resourceId,
			sessionId: params.sessionId,
			mediaType: params.mediaType,
			...(params.fileName ? { fileName: params.fileName } : {}),
			expectedByteLength: params.byteLength,
			expectedSha256: params.sha256.toLowerCase(),
			receivedBytes: 0,
			state: "uploading",
		};
		this.#uploads.set(uploadId, upload);
		await Bun.write(this.#partPath(uploadId), new Uint8Array());
		await this.#saveManifest();
		return { uploadId, resourceId, chunkLimit: this.#chunkLimit, acceptedOffset: 0 };
	}

	/** chunk 必须连续；完全重复的已接收 chunk 按字节一致性幂等接受。 */
	async chunk(params: {
		uploadId: UploadId;
		offset: number;
		dataBase64: string;
		chunkSha256?: string;
	}): Promise<{ acceptedOffset: number }> {
		this.#assertWritable();
		const upload = this.#uploads.get(params.uploadId);
		if (upload?.state !== "uploading") {
			throw new ResourceUploadError("not_found", `Upload ${params.uploadId} is not active`);
		}
		if (!Number.isSafeInteger(params.offset) || params.offset < 0) {
			throw new ResourceUploadError("invalid", `Chunk offset must be a non-negative safe integer: ${params.offset}`);
		}
		const data = decodeBase64(params.dataBase64);
		if (data.length === 0 && upload.expectedByteLength !== 0) {
			throw new ResourceUploadError("invalid", "Resource chunks cannot be empty");
		}
		if (data.length > this.#chunkLimit) {
			throw new ResourceUploadError("invalid", `Chunk exceeds limit: ${data.length} > ${this.#chunkLimit}`);
		}
		if (params.chunkSha256) {
			assertSha256(params.chunkSha256, "chunkSha256");
			const actual = sha256Bytes(data);
			if (actual !== params.chunkSha256.toLowerCase()) {
				throw new ResourceUploadError("invalid", `Chunk SHA-256 mismatch: computed ${actual}`);
			}
		}

		if (params.offset < upload.receivedBytes) {
			if (params.offset + data.length > upload.receivedBytes) {
				throw new ResourceUploadError("invalid", "Chunk overlaps the accepted boundary");
			}
			const existing = await readRange(this.#partPath(upload.uploadId), params.offset, data.length);
			if (!Buffer.from(existing).equals(data)) {
				throw new ResourceUploadError("invalid", "Repeated chunk bytes do not match the accepted upload content");
			}
			return { acceptedOffset: upload.receivedBytes };
		}
		if (params.offset !== upload.receivedBytes) {
			throw new ResourceUploadError(
				"invalid",
				`Chunk offset mismatch: expected ${upload.receivedBytes}, got ${params.offset}`,
			);
		}
		if (upload.receivedBytes + data.length > upload.expectedByteLength) {
			throw new ResourceUploadError("invalid", `Chunk exceeds declared byteLength ${upload.expectedByteLength}`);
		}

		await fs.appendFile(this.#partPath(upload.uploadId), data);
		upload.receivedBytes += data.length;
		await this.#saveManifest();
		return { acceptedOffset: upload.receivedBytes };
	}

	async commit(params: { uploadId: UploadId; sha256: string }): Promise<InputResourceRef> {
		this.#assertWritable();
		const upload = this.#uploads.get(params.uploadId);
		if (upload?.state !== "uploading") {
			throw new ResourceUploadError("not_found", `Upload ${params.uploadId} is not active`);
		}
		assertSha256(params.sha256, "Resource sha256");
		if (upload.receivedBytes !== upload.expectedByteLength) {
			throw new ResourceUploadError(
				"invalid",
				`Length mismatch: received ${upload.receivedBytes}, expected ${upload.expectedByteLength}`,
			);
		}

		const partPath = this.#partPath(upload.uploadId);
		const hash = await sha256File(partPath);
		if (hash !== params.sha256.toLowerCase() || hash !== upload.expectedSha256) {
			throw new ResourceUploadError(
				"invalid",
				`SHA-256 mismatch: computed ${hash}, expected ${upload.expectedSha256}`,
			);
		}
		await validateMediaSignature(partPath, upload.mediaType);

		const committedPath = this.#resourcePath(upload.resourceId);
		await fs.rename(partPath, committedPath);
		const resource: InputResourceRef = {
			resourceId: upload.resourceId,
			sessionId: upload.sessionId,
			source: "upload",
			mediaType: upload.mediaType,
			byteLength: upload.expectedByteLength,
			sha256: hash,
			...(upload.fileName ? { fileName: upload.fileName } : {}),
			state: "committed",
		};
		this.#uploads.delete(params.uploadId);
		this.#resources.set(resource.resourceId, resource);
		await this.#saveManifest();
		return structuredClone(resource);
	}

	async registerHostUri(params: {
		sessionId: SessionId;
		uri: string;
		metadata?: HostResourceMetadata;
		allowedSchemes: readonly string[];
	}): Promise<InputResourceRef> {
		this.#assertBoundSession(params.sessionId);
		this.#assertWritable();
		let parsed: URL;
		try {
			parsed = new URL(params.uri);
		} catch {
			throw new ResourceUploadError("invalid", `Invalid host URI: ${params.uri}`);
		}
		const scheme = parsed.protocol.slice(0, -1).toLowerCase();
		if (!params.allowedSchemes.includes(scheme)) {
			throw new ResourceUploadError("invalid", `Host URI scheme is not registered: ${scheme}`);
		}
		if (parsed.username || parsed.password) {
			throw new ResourceUploadError("invalid", "Host URI must not contain embedded credentials");
		}
		const mediaType = params.metadata?.mediaType ?? "application/octet-stream";
		if (!this.#acceptedMediaTypes.has(mediaType)) {
			throw new ResourceUploadError("invalid", `Unsupported host resource media type: ${mediaType}`);
		}
		if (params.metadata?.byteLength === undefined || !params.metadata.sha256) {
			throw new ResourceUploadError("invalid", "Host resource metadata requires byteLength and sha256");
		}
		const byteLength = params.metadata.byteLength;
		if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.#maxResourceBytes) {
			throw new ResourceUploadError("invalid", `Invalid host resource byteLength: ${byteLength}`);
		}
		assertSha256(params.metadata.sha256, "Host resource sha256");
		const resource: InputResourceRef = {
			resourceId: newResourceId(),
			sessionId: params.sessionId,
			source: "host_uri",
			mediaType,
			byteLength,
			sha256: params.metadata.sha256.toLowerCase(),
			...(params.metadata?.fileName ? { fileName: params.metadata.fileName } : {}),
			hostUri: params.uri,
			state: "committed",
		};
		this.#resources.set(resource.resourceId, resource);
		await this.#saveManifest();
		return structuredClone(resource);
	}

	getResource(resourceId: string, sessionId?: SessionId): InputResourceRef | undefined {
		const resource = this.#resources.get(resourceId);
		if (!resource || (sessionId && resource.sessionId !== sessionId)) return undefined;
		return structuredClone(resource);
	}

	async readResource(resourceId: string, sessionId: SessionId): Promise<Uint8Array> {
		const resource = this.#resources.get(resourceId);
		if (!resource || resource.sessionId !== sessionId || resource.state !== "committed") {
			throw new ResourceUploadError("not_found", `Resource not found: ${resourceId}`);
		}
		if (resource.source !== "upload") {
			throw new ResourceUploadError("invalid", "Host URI resources must be read through host.uri.read");
		}
		try {
			return await Bun.file(this.#resourcePath(resource.resourceId)).bytes();
		} catch (error: unknown) {
			if (isEnoent(error)) throw new ResourceUploadError("not_found", `Resource bytes not found: ${resourceId}`);
			throw error;
		}
	}

	async release(resourceId: string, sessionId?: SessionId): Promise<boolean> {
		this.#assertWritable();
		const resource = this.#resources.get(resourceId);
		if (!resource || (sessionId && resource.sessionId !== sessionId)) return false;
		this.#resources.delete(resourceId);
		if (resource.source === "upload") await fs.rm(this.#resourcePath(resource.resourceId), { force: true });
		await this.#saveManifest();
		return true;
	}

	/** 保存上传现场；正常断线不得丢弃可恢复的 partial。 */
	async close(): Promise<void> {
		if (this.#manifestPath && !this.#readOnly) await this.#saveManifest();
	}

	/** 显式清理只用于 Session 删除或不可恢复的 Runtime teardown。 */
	async cleanup(): Promise<void> {
		this.#assertWritable();
		if (!this.#uploadDir) return;
		for (const upload of this.#uploads.values()) await fs.rm(this.#partPath(upload.uploadId), { force: true });
		this.#uploads.clear();
		await this.#saveManifest();
	}

	#assertBoundSession(sessionId: SessionId): void {
		if (!this.#sessionId || this.#sessionId !== sessionId || !this.#uploadDir) {
			throw new ResourceUploadError("invalid", `Resource manager is not bound to Session ${sessionId}`);
		}
	}

	#assertWritable(): void {
		if (this.#readOnly) throw new ResourceUploadError("invalid", "Resource manager is bound read_only");
	}

	#partPath(uploadId: UploadId): string {
		if (!this.#uploadDir) throw new ResourceUploadError("invalid", "Resource manager is not bound to a Session");
		return path.join(this.#uploadDir, `${uploadId}.part`);
	}

	#resourcePath(resourceId: ResourceId): string {
		if (!this.#uploadDir) throw new ResourceUploadError("invalid", "Resource manager is not bound to a Session");
		return path.join(this.#uploadDir, `${resourceId}.bin`);
	}

	async #saveManifest(): Promise<void> {
		if (!this.#manifestPath) return;
		this.#assertWritable();
		const manifest: ResourceManifest = {
			schemaVersion: 1,
			uploads: [...this.#uploads.values()],
			resources: [...this.#resources.values()],
		};
		const temporary = `${this.#manifestPath}.${process.pid}.${Date.now()}.tmp`;
		await Bun.write(temporary, `${JSON.stringify(manifest)}\n`);
		await fs.rename(temporary, this.#manifestPath);
	}
}

function validateManifest(value: unknown, sessionId: SessionId): ResourceManifest {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.uploads) ||
		!Array.isArray(value.resources)
	) {
		throw new Error("Resource manifest has an invalid envelope");
	}
	const uploads = value.uploads.map(item => reviveUpload(item, sessionId));
	const resources = value.resources.map(item => reviveResource(item, sessionId));
	if (uploads.some(item => !item) || resources.some(item => !item)) {
		throw new Error("Resource manifest contains invalid Session-scoped entries");
	}
	return { schemaVersion: 1, uploads: uploads as ActiveUpload[], resources: resources as InputResourceRef[] };
}

function reviveUpload(value: unknown, sessionId: SessionId): ActiveUpload | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.sessionId !== sessionId ||
		typeof value.uploadId !== "string" ||
		typeof value.resourceId !== "string" ||
		typeof value.mediaType !== "string" ||
		typeof value.expectedByteLength !== "number" ||
		typeof value.expectedSha256 !== "string" ||
		typeof value.receivedBytes !== "number" ||
		(value.state !== "uploading" && value.state !== "rejected")
	)
		return undefined;
	return {
		uploadId: value.uploadId as UploadId,
		resourceId: value.resourceId as ResourceId,
		sessionId,
		mediaType: value.mediaType,
		...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
		expectedByteLength: value.expectedByteLength,
		expectedSha256: value.expectedSha256,
		receivedBytes: value.receivedBytes,
		state: value.state,
	};
}

function reviveResource(value: unknown, sessionId: SessionId): InputResourceRef | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.sessionId !== sessionId ||
		typeof value.resourceId !== "string" ||
		(value.source !== "upload" && value.source !== "host_uri" && value.source !== "san_artifact") ||
		typeof value.mediaType !== "string" ||
		typeof value.byteLength !== "number" ||
		typeof value.sha256 !== "string" ||
		(value.state !== "committed" &&
			value.state !== "released" &&
			value.state !== "rejected" &&
			value.state !== "uploading")
	)
		return undefined;
	return {
		resourceId: value.resourceId as ResourceId,
		sessionId,
		source: value.source,
		mediaType: value.mediaType,
		byteLength: value.byteLength,
		sha256: value.sha256,
		...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
		...(typeof value.hostUri === "string" ? { hostUri: value.hostUri } : {}),
		state: value.state,
		...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
	};
}

function assertSha256(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/i.test(value))
		throw new ResourceUploadError("invalid", `${label} must be a 64-character hex digest`);
}

function decodeBase64(value: string): Buffer {
	if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new ResourceUploadError("invalid", "dataBase64 is not canonical base64");
	}
	return Buffer.from(value, "base64");
}

function sha256Bytes(value: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function readRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		if (bytesRead !== length) throw new ResourceUploadError("invalid", "Accepted upload bytes are truncated");
		return buffer;
	} finally {
		await handle.close();
	}
}

async function validateMediaSignature(filePath: string, mediaType: string): Promise<void> {
	const bytes = await Bun.file(filePath).slice(0, 32).bytes();
	const matches =
		mediaType === "image/png"
			? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			: mediaType === "image/jpeg"
				? startsWith(bytes, [0xff, 0xd8, 0xff])
				: mediaType === "image/gif"
					? startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
						startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
					: mediaType === "image/webp"
						? startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
						: true;
	if (!matches)
		throw new ResourceUploadError("invalid", `Resource bytes do not match declared media type ${mediaType}`);
	if (mediaType === "text/plain" || mediaType === "application/json") {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(await Bun.file(filePath).bytes());
		} catch {
			throw new ResourceUploadError("invalid", `${mediaType} resource is not valid UTF-8`);
		}
		if (mediaType === "application/json") {
			try {
				JSON.parse(text);
			} catch {
				throw new ResourceUploadError("invalid", "application/json resource is not valid JSON");
			}
		}
	}
}

function startsWith(value: Uint8Array, prefix: readonly number[]): boolean {
	return prefix.every((byte, index) => value[index] === byte);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
