/** RPC v2 Session 级 Artifact 目录与有界读取。 */
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import type { ArtifactReadResult, ArtifactRef } from "./dto/resources";
import type { ArtifactId, SessionId } from "./protocol/ids";
import { newArtifactId } from "./protocol/ids";

interface StoredArtifact {
	artifactId: ArtifactId;
	sessionId: SessionId;
	internalId: string;
	mediaType: string;
	byteLength: number;
	sha256: string;
	fileName?: string;
}

export class RpcArtifactError extends Error {
	readonly reason: "not_found" | "invalid";

	constructor(reason: "not_found" | "invalid", message: string) {
		super(message);
		this.name = "RpcArtifactError";
		this.reason = reason;
	}
}

export class RpcArtifactStore {
	#session: AgentSession | undefined;
	#sessionId: SessionId | undefined;
	#artifacts = new Map<string, StoredArtifact>();

	bind(params: {
		session: AgentSession;
		sessionId: SessionId;
		persistedArtifacts?: readonly Record<string, unknown>[];
	}): void {
		this.#session = params.session;
		this.#sessionId = params.sessionId;
		this.#artifacts.clear();
		for (const value of params.persistedArtifacts ?? []) {
			const artifact = reviveArtifact(value, params.sessionId);
			if (artifact) this.#artifacts.set(artifact.artifactId, artifact);
		}
	}

	entries(): Record<string, unknown>[] {
		return [...this.#artifacts.values()].map(artifact => ({ ...artifact }));
	}

	async saveText(text: string, options: { mediaType: string; fileName?: string; kind: string }): Promise<ArtifactRef> {
		const { session, sessionId } = this.#assertBound();
		const internalId = await session.sessionManager.saveArtifact(text, options.kind);
		if (!internalId) throw new RpcArtifactError("invalid", "Session artifact storage is unavailable");
		const bytes = new TextEncoder().encode(text);
		const artifact: StoredArtifact = {
			artifactId: newArtifactId(),
			sessionId,
			internalId,
			mediaType: options.mediaType,
			byteLength: bytes.byteLength,
			sha256: sha256(bytes),
			...(options.fileName ? { fileName: options.fileName } : {}),
		};
		this.#artifacts.set(artifact.artifactId, artifact);
		return toRef(artifact, text.slice(0, 512));
	}

	async read(params: {
		artifactId: string;
		offset: number;
		limit: number;
		maxChunkBytes: number;
	}): Promise<ArtifactReadResult & { nextOffset: number }> {
		const { session, sessionId } = this.#assertBound();
		const artifact = this.#artifacts.get(params.artifactId);
		if (!artifact || artifact.sessionId !== sessionId) {
			throw new RpcArtifactError("not_found", `Artifact not found: ${params.artifactId}`);
		}
		if (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > artifact.byteLength) {
			throw new RpcArtifactError("invalid", `Artifact offset is outside 0..${artifact.byteLength}`);
		}
		if (!Number.isSafeInteger(params.limit) || params.limit <= 0 || params.limit > params.maxChunkBytes) {
			throw new RpcArtifactError("invalid", `Artifact limit must be between 1 and ${params.maxChunkBytes}`);
		}
		const artifactPath = await session.sessionManager.getArtifactPath(artifact.internalId);
		if (!artifactPath) throw new RpcArtifactError("not_found", `Artifact bytes not found: ${params.artifactId}`);
		const end = Math.min(artifact.byteLength, params.offset + params.limit);
		const bytes = await Bun.file(artifactPath).slice(params.offset, end).bytes();
		const textMedia = isTextMediaType(artifact.mediaType);
		let data: string;
		let nextOffset = end;
		let encoding: "utf-8" | "base64";
		if (textMedia) {
			const decoded = decodeUtf8Prefix(bytes);
			data = decoded.text;
			nextOffset = params.offset + decoded.byteLength;
			encoding = "utf-8";
		} else {
			data = Buffer.from(bytes).toString("base64");
			encoding = "base64";
		}
		return { data, encoding, sha256: artifact.sha256, eof: nextOffset >= artifact.byteLength, nextOffset };
	}

	get(artifactId: string): ArtifactRef | undefined {
		const artifact = this.#artifacts.get(artifactId);
		return artifact ? toRef(artifact) : undefined;
	}

	#assertBound(): { session: AgentSession; sessionId: SessionId } {
		if (!this.#session || !this.#sessionId)
			throw new RpcArtifactError("invalid", "Artifact store is not bound to a Session");
		return { session: this.#session, sessionId: this.#sessionId };
	}
}

function reviveArtifact(value: unknown, sessionId: SessionId): StoredArtifact | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.sessionId !== sessionId ||
		typeof value.artifactId !== "string" ||
		typeof value.internalId !== "string" ||
		typeof value.mediaType !== "string" ||
		typeof value.byteLength !== "number" ||
		typeof value.sha256 !== "string"
	)
		return undefined;
	return {
		artifactId: value.artifactId as ArtifactId,
		sessionId,
		internalId: value.internalId,
		mediaType: value.mediaType,
		byteLength: value.byteLength,
		sha256: value.sha256,
		...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
	};
}

function toRef(artifact: StoredArtifact, preview?: string): ArtifactRef {
	return {
		artifactId: artifact.artifactId,
		mediaType: artifact.mediaType,
		byteLength: artifact.byteLength,
		sha256: artifact.sha256,
		...(preview ? { preview } : {}),
		...(artifact.fileName ? { fileName: artifact.fileName } : {}),
	};
}

function decodeUtf8Prefix(bytes: Uint8Array): { text: string; byteLength: number } {
	for (let length = bytes.byteLength; length >= Math.max(0, bytes.byteLength - 3); length--) {
		try {
			return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, length)), byteLength: length };
		} catch {}
	}
	throw new RpcArtifactError("invalid", "Artifact text contains invalid UTF-8");
}

function isTextMediaType(mediaType: string): boolean {
	return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/x-ndjson";
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inferArtifactMediaType(fileName: string): string {
	const extension = path.extname(fileName).toLowerCase();
	if (extension === ".html") return "text/html";
	if (extension === ".json") return "application/json";
	if (extension === ".jsonl" || extension === ".ndjson") return "application/x-ndjson";
	return "text/plain";
}
