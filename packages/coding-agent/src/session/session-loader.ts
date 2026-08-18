import type { AgentMessage } from "@san/agent";
import { getBlobsDir, isEnoent, parseJsonlLenientDetailed } from "@san/utils";
import { BlobStore, isBlobRef, resolveImageData, resolveImageDataUrl } from "./blob-store";
import { buildSessionContext } from "./session-context";
import {
	type CompactionEntry,
	type FileEntry,
	type RawFileEntry,
	SESSION_TITLE_SLOT_BYTES,
	type SessionEntry,
	type SessionHeader,
	type SessionTitleSlotEntry,
} from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const ELIDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided during session load]";
const ELIDED_COMPACTION_SHORT_SUMMARY = "Superseded compaction elided";

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function foldTitleSlot(entries: FileEntry[], slot: SessionTitleUpdate | undefined): FileEntry[] {
	if (!slot || entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") return entries;
	if (slot.title && slot.title.length > 0) {
		header.title = slot.title;
	} else {
		delete header.title;
	}
	if (slot.source) {
		header.titleSource = slot.source;
	} else {
		delete header.titleSource;
	}
	return entries;
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	/** 非空白格式错误的 JSONL 记录数（含文件尾部的截断记录）；title slot 不计入。 */
	malformedCount: number;
} {
	const { body, slot } = splitTitleSlot(content);
	const { entries, malformedCount } = parseJsonlLenientDetailed<RawFileEntry>(body);
	return { entries: foldTitleSlot(entries as FileEntry[], slot), titleSlot: slot, malformedCount };
}

function elideCompactionSummary(entry: CompactionEntry | undefined): boolean {
	if (!entry) return false;
	if (
		entry.summary === ELIDED_COMPACTION_SUMMARY &&
		entry.shortSummary === ELIDED_COMPACTION_SHORT_SUMMARY &&
		entry.preserveData === undefined
	) {
		return false;
	}
	entry.summary = ELIDED_COMPACTION_SUMMARY;
	entry.shortSummary = ELIDED_COMPACTION_SHORT_SUMMARY;
	entry.preserveData = undefined;
	return true;
}

function collectActiveBranchIds(entries: FileEntry[]): Set<string> {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		const id = (entry as SessionEntry).id;
		if (typeof id === "string") byId.set(id, entry as SessionEntry);
	}
	const branchIds = new Set<string>();
	let cursor = entries[entries.length - 1] as SessionEntry | undefined;
	while (cursor && typeof cursor.id === "string" && !branchIds.has(cursor.id)) {
		branchIds.add(cursor.id);
		const parentId = cursor.parentId;
		cursor = parentId ? byId.get(parentId) : undefined;
	}
	return branchIds;
}

function elideSupersededCompactionEntries(entries: FileEntry[]): void {
	const branchIds = collectActiveBranchIds(entries);
	let previousCompaction: CompactionEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		if (!branchIds.has(entry.id)) continue;
		elideCompactionSummary(previousCompaction);
		previousCompaction = entry;
	}
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(filePath: string): Promise<{
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	/** 非空白格式错误的 JSONL 记录数；title slot、空行不计入，跨 chunk 的坏行只计一次。 */
	malformedCount: number;
}> {
	const entries: FileEntry[] = [];
	let titleSlot: SessionTitleUpdate | undefined;
	let malformedCount = 0;
	let sawFirstLine = false;
	// Byte buffer (NOT a decoded string): multibyte UTF-8 sequences that straddle
	// a stream-chunk boundary stay intact, and Bun.JSONL.parseChunk accepts typed
	// arrays directly. Only the unconsumed remainder is held (≤ one record + a
	// chunk), so the ≥8MiB memory guard is preserved (the file is never fully
	// loaded into memory).
	let buffer: Uint8Array = new Uint8Array();
	const decoder = new TextDecoder();

	const drain = (atEof: boolean) => {
		while (buffer.length > 0) {
			const { values, error, read, done } = Bun.JSONL.parseChunk(buffer);
			if (values.length > 0) {
				for (const value of values) entries.push(value as FileEntry);
			}
			if (error) {
				// Malformed record. read 落在上一行末尾的换行上时（nextNewline ===
				// read）说明坏行尚未终止，只前进一个字节继续扫描、不计数；只有越过
				// 本行终止换行（nextNewline > read）才计一次，避免重复计数。
				const nextNewline = buffer.indexOf(0x0a, read);
				if (nextNewline === -1) {
					// 坏行的结束换行尚未收到：丢弃已消费的好前缀（否则下一 chunk 会
					// 重复产出这些值），保留坏行前缀等更多数据；计数留给其终止时。
					buffer = buffer.subarray(read);
					break;
				}
				if (nextNewline > read) malformedCount++;
				buffer = buffer.subarray(nextNewline + 1);
				continue;
			}
			if (read === 0) {
				// 纯空白（done）或未完成的记录。流中途可能还有数据，不计数；只有
				// EOF（atEof）残留、解析器又未完成的内容才是撕裂的尾部记录，计一次。
				if (atEof && !done) malformedCount++;
				break;
			}
			buffer = buffer.subarray(read);
			if (done) {
				buffer = new Uint8Array();
				break;
			}
		}
	};

	try {
		for await (const chunk of Bun.file(filePath).stream()) {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			// The optional fixed-width title slot is a physical first line that is
			// NOT JSON; peel it before the parser would (correctly) reject it. The
			// first line ends at a '\n' byte, so it is a complete UTF-8 sequence and
			// safe to decode. A non-slot first line is a real entry and is left for
			// the parser; a blank first line is left for the parser to skip.
			if (!sawFirstLine) {
				const newline = buffer.indexOf(0x0a);
				if (newline !== -1) {
					sawFirstLine = true;
					const firstLine = decoder.decode(buffer.subarray(0, newline)).trim();
					if (firstLine) {
						const slot = parseTitleSlotLine(firstLine);
						if (slot) {
							titleSlot = titleUpdateFromSlot(slot);
							buffer = buffer.subarray(newline + 1);
						}
					}
				}
			}
			drain(false);
		}
		// A trailing record without a final newline: terminate it so the parser
		// can complete it (readline yielded it; parseChunk needs the delimiter).
		if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
			buffer = Buffer.concat([buffer, new Uint8Array([0x0a])]);
		}
		drain(true);
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined, malformedCount: 0 };
		throw err;
	}

	return { entries: foldTitleSlot(entries, titleSlot), titleSlot, malformedCount };
}

/** Read only the fixed-size head window to detect a physical title slot. */
export async function readTitleSlotFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionTitleSlotEntry | undefined> {
	let head: string;
	try {
		[head] = await storage.readTextSlices(filePath, SESSION_TITLE_SLOT_BYTES, 0);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const newlineIndex = head.indexOf("\n");
	if (newlineIndex < 0) return undefined;
	return parseTitleSlotLine(head.slice(0, newlineIndex));
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

export interface LoadEntriesFromFileResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	/** 非空白格式错误的 JSONL 记录数（含文件尾部的截断记录）。 */
	malformedCount: number;
}

/**
 * Load a session file with corruption metadata. Callers that resume a writable
 * session (e.g. SessionManager) use `malformedCount > 0` to force a full rewrite
 * before the next append, repairing torn tails instead of appending onto them.
 */
export async function loadEntriesFromFileWithMetadata(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<LoadEntriesFromFileResult> {
	let loaded: LoadEntriesFromFileResult;
	try {
		const stat = storage.statSync(filePath);
		loaded =
			storage instanceof FileSessionStorage && stat.size >= STREAM_LOAD_THRESHOLD_BYTES
				? await loadEntriesFromFileStream(filePath)
				: parseSessionContent(await storage.readText(filePath));
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined, malformedCount: 0 };
		throw err;
	}
	const { entries } = loaded;
	elideSupersededCompactionEntries(entries);

	// Validate session header
	if (entries.length === 0) return loaded;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") {
		return { entries: [], titleSlot: loaded.titleSlot, malformedCount: loaded.malformedCount };
	}

	return loaded;
}

/** Exported for testing */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	return (await loadEntriesFromFileWithMetadata(filePath, storage)).entries;
}

/**
 * Resolve blob references in loaded entries, restoring both session image blocks and persisted
 * provider image URLs back to the inline data expected by downstream transports. Mutates entries in place.
 */
function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<void> {
	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data);
		return;
	}

	if (Array.isArray(value)) {
		await Promise.all(value.map(item => resolvePersistedBlobRefs(item, blobStore, key)));
		return;
	}

	if (typeof value !== "object" || value === null) return;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		value.result = await resolveImageData(blobStore, value.result);
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url);
	}

	await Promise.all(
		Object.entries(value).map(([childKey, item]) => resolvePersistedBlobRefs(item, blobStore, childKey)),
	);
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await Promise.all(
		entries.filter(entry => entry.type !== "session").map(entry => resolvePersistedBlobRefs(entry, blobStore)),
	);
}

/**
 * Read-only message view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the context along the
 * persisted leaf path (last entry). Does NOT create a writer or take the
 * session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries).messages;
}
