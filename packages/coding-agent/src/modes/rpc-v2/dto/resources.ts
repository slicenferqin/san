/**
 * San RPC v2 Resource and Artifact DTOs.
 */

import type { ArtifactId, ResourceId, SessionId } from "../protocol/ids";
import type { Timestamp } from "../protocol/lifecycle";

// ============================================================================
// Input Resources (Desktop → San)
// ============================================================================

export interface InputResourceRef {
	resourceId: ResourceId;
	sessionId: SessionId;
	source: "upload" | "host_uri" | "san_artifact";
	mediaType: string;
	byteLength: number;
	sha256: string;
	fileName?: string;
	hostUri?: string;
	state: "uploading" | "committed" | "rejected" | "released";
	expiresAt?: Timestamp;
}

// ============================================================================
// Artifacts (San → Desktop)
// ============================================================================

export interface ArtifactRef {
	artifactId: ArtifactId;
	mediaType: string;
	byteLength: number;
	sha256: string;
	preview?: string;
	fileName?: string;
	expiresAt?: Timestamp;
}

// ============================================================================
// Upload protocol
// ============================================================================

export interface UploadBeginParams {
	sessionId: SessionId;
	mediaType: string;
	fileName?: string;
	byteLength: number;
	sha256: string;
	meta: { idempotencyKey: string };
}

export interface UploadBeginResult {
	uploadId: string;
	resourceId: ResourceId;
	chunkLimit: number;
}

export interface UploadChunkParams {
	uploadId: string;
	offset: number;
	dataBase64: string;
	chunkSha256: string;
	meta: { idempotencyKey: string };
}

export interface UploadCommitParams {
	uploadId: string;
	sha256: string;
	meta: { idempotencyKey: string };
}

// ============================================================================
// Artifact read
// ============================================================================

export interface ArtifactReadParams {
	artifactId: ArtifactId;
	offset: number;
	limit: number;
}

export interface ArtifactReadResult {
	data: string;
	encoding: "utf-8" | "base64";
	sha256: string;
	eof: boolean;
}
