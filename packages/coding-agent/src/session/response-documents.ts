import { type AgentMessage, countTokens } from "@san/agent";
import type { AssistantMessage } from "@san/ai";
import { isRecord, logger, prompt } from "@san/utils";
import type { Settings } from "../config/settings";
import responseDocumentEnvelopeTemplate from "../prompts/system/response-document-envelope.md" with { type: "text" };
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";

export const RESPONSE_DOCUMENT_CUSTOM_TYPE = "san.response_document";
export const RESPONSE_DOCUMENT_SCHEMA_VERSION = 1;

const RESPONSE_DOCUMENT_MEDIA_TYPE = "text/markdown";
const RESPONSE_DOCUMENT_ARTIFACT_TYPE = "response-document";
const MAX_OUTLINE_HEADINGS = 24;
const MAX_OUTLINE_HEADING_BYTES = 160;
const MARKDOWN_FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const CONCLUSION_LEAD = /^\s*(?:\*{0,2})?(?:结论|总结|Conclusion|Summary|Outcome)(?:\*{0,2})?(?:\s*[:：-]|\s|$)/i;

export type ResponseDocumentMode = "off" | "auto" | "always";

export interface ResponseDocumentRecord {
	schemaVersion: typeof RESPONSE_DOCUMENT_SCHEMA_VERSION;
	messageEntryId: string;
	artifactId: string;
	mediaType: typeof RESPONSE_DOCUMENT_MEDIA_TYPE;
	originalBytes: number;
	originalVisibleTokens: number;
	contentHash: string;
	synopsis: string;
	headingOutline: string[];
	createdAt: string;
}

interface ResponseDocumentOptions {
	mode: ResponseDocumentMode;
	minBytes: number;
	minTokens: number;
	synopsisMaxBytes: number;
}

interface MarkdownStructure {
	paragraphs: string[];
	headings: string[];
	conclusionLead?: string;
}

interface ProjectableResponseDocument {
	record: ResponseDocumentRecord;
	message: AssistantMessage;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function clampNonNegativeInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function clampPositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function resolveOptions(settings: Settings): ResponseDocumentOptions {
	return {
		mode: settings.get("san.responseDocuments.mode"),
		minBytes: clampNonNegativeInteger(settings.get("san.responseDocuments.minBytes"), 16_384),
		minTokens: clampNonNegativeInteger(settings.get("san.responseDocuments.minTokens"), 3_000),
		synopsisMaxBytes: clampPositiveInteger(settings.get("san.responseDocuments.synopsisMaxBytes"), 4_096),
	};
}

function visibleMarkdown(message: AssistantMessage): string {
	let markdown = "";
	for (const content of message.content) {
		if (content.type === "text") markdown += content.text;
	}
	return markdown.trim();
}

function isEligibleTerminalResponse(message: AssistantMessage, markdown: string): boolean {
	if (message.stopReason !== "stop" || markdown.length === 0) return false;
	return !message.content.some(content => content.type === "toolCall" || content.type === "image");
}

function shouldExternalize(options: ResponseDocumentOptions, bytes: number, tokens: number): boolean {
	if (options.mode === "off") return false;
	if (options.mode === "always") return true;
	return bytes >= options.minBytes || tokens >= options.minTokens;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const ellipsis = "…";
	const ellipsisBytes = byteLength(ellipsis);
	if (maxBytes < ellipsisBytes) return "";
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = byteLength(character);
		if (bytes + characterBytes + ellipsisBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return `${result.trimEnd()}${ellipsis}`;
}

function extractMarkdownStructure(markdown: string): MarkdownStructure {
	const paragraphs: string[] = [];
	const headings: string[] = [];
	let conclusionLead: string | undefined;
	let paragraphLines: string[] = [];
	let fenceMarker: "`" | "~" | undefined;
	let nextParagraphIsConclusion = false;

	const flushParagraph = () => {
		const paragraph = paragraphLines.join("\n").trim();
		if (paragraph.length > 0) {
			paragraphs.push(paragraph);
			if (nextParagraphIsConclusion && !conclusionLead) conclusionLead = paragraph;
		}
		if (paragraph.length > 0) nextParagraphIsConclusion = false;
		paragraphLines = [];
	};

	for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
		const fence = MARKDOWN_FENCE.exec(line);
		if (fence) {
			const marker = fence[1]?.[0];
			if (!fenceMarker && (marker === "`" || marker === "~")) {
				flushParagraph();
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				fenceMarker = undefined;
			}
			continue;
		}
		if (fenceMarker) continue;

		const heading = MARKDOWN_HEADING.exec(line);
		if (heading) {
			flushParagraph();
			const text = heading[2]?.trim();
			if (text) {
				headings.push(text);
				nextParagraphIsConclusion = CONCLUSION_LEAD.test(text);
			}
			continue;
		}
		if (line.trim().length === 0) {
			flushParagraph();
			continue;
		}
		paragraphLines.push(line.trimEnd());
	}
	flushParagraph();
	return { paragraphs, headings, conclusionLead };
}

function buildSynopsis(paragraphs: readonly string[], maxBytes: number, conclusionLead?: string): string {
	if (paragraphs.length === 0) return "";
	const conclusion = conclusionLead ?? paragraphs.find(paragraph => CONCLUSION_LEAD.test(paragraph));
	const prioritized = conclusion
		? [conclusion, ...paragraphs.filter(paragraph => paragraph !== conclusion)]
		: [...paragraphs];
	const selected: string[] = [];
	let usedBytes = 0;
	for (const paragraph of prioritized) {
		const separatorBytes = selected.length > 0 ? 2 : 0;
		const paragraphBytes = byteLength(paragraph);
		if (usedBytes + separatorBytes + paragraphBytes <= maxBytes) {
			selected.push(paragraph);
			usedBytes += separatorBytes + paragraphBytes;
			continue;
		}
		if (selected.length === 0) selected.push(truncateUtf8(paragraph, maxBytes));
		break;
	}
	return selected.join("\n\n");
}

function buildHeadingOutline(headings: readonly string[]): string[] {
	return headings
		.slice(0, MAX_OUTLINE_HEADINGS)
		.map(heading => truncateUtf8(heading, MAX_OUTLINE_HEADING_BYTES))
		.filter(heading => heading.length > 0);
}

export function isResponseDocumentRecord(value: unknown): value is ResponseDocumentRecord {
	return (
		isRecord(value) &&
		value.schemaVersion === RESPONSE_DOCUMENT_SCHEMA_VERSION &&
		typeof value.messageEntryId === "string" &&
		typeof value.artifactId === "string" &&
		value.mediaType === RESPONSE_DOCUMENT_MEDIA_TYPE &&
		typeof value.originalBytes === "number" &&
		typeof value.originalVisibleTokens === "number" &&
		typeof value.contentHash === "string" &&
		typeof value.synopsis === "string" &&
		Array.isArray(value.headingOutline) &&
		value.headingOutline.every((heading: unknown) => typeof heading === "string") &&
		typeof value.createdAt === "string"
	);
}

function responseDocumentEntries(entries: readonly CustomEntry[]): ResponseDocumentRecord[] {
	return entries.flatMap(entry => (isResponseDocumentRecord(entry.data) ? [entry.data] : []));
}

function findPersistedAssistantEntry(
	entries: readonly SessionEntry[],
	message: AssistantMessage,
): SessionMessageEntry | undefined {
	const key = sessionMessagePersistenceKey(message);
	if (!key) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (sessionMessagePersistenceKey(entry.message) !== key) continue;
		if (sameMessageContent(entry.message, message)) return entry;
	}
	return undefined;
}

function renderEnvelope(record: ResponseDocumentRecord): string {
	return prompt.render(responseDocumentEnvelopeTemplate, {
		artifactUrl: `artifact://${record.artifactId}`,
		synopsis: record.synopsis,
		headingOutline: record.headingOutline,
	});
}

/**
 * Persists full terminal responses as artifacts while leaving transcript and
 * UI messages untouched. Only provider-bound context receives the compact
 * envelope, and only for records present on the active session branch.
 */
export class ResponseDocumentRuntime {
	readonly #sessionManager: SessionManager;
	readonly #settings: Settings;
	readonly #visibleMarkdown = new WeakMap<AssistantMessage, string>();

	constructor(sessionManager: SessionManager, settings: Settings) {
		this.#sessionManager = sessionManager;
		this.#settings = settings;
	}

	rememberVisibleAssistant(original: AssistantMessage, visible: AssistantMessage): void {
		this.#visibleMarkdown.set(original, visibleMarkdown(visible));
	}

	async externalizeAssistant(message: AssistantMessage): Promise<ResponseDocumentRecord | undefined> {
		const options = resolveOptions(this.#settings);
		if (options.mode === "off") return undefined;
		const markdown = this.#visibleMarkdown.get(message) ?? visibleMarkdown(message);
		if (!isEligibleTerminalResponse(message, markdown)) return undefined;
		const originalBytes = byteLength(markdown);
		const originalVisibleTokens = countTokens(markdown);
		if (!shouldExternalize(options, originalBytes, originalVisibleTokens)) return undefined;

		const branch = this.#sessionManager.getBranch();
		const messageEntry = findPersistedAssistantEntry(branch, message);
		if (!messageEntry) {
			logger.warn("Response document skipped because the assistant message is not persisted", {
				sessionId: this.#sessionManager.getSessionId(),
				messageTimestamp: message.timestamp,
			});
			return undefined;
		}
		const existing = responseDocumentEntries(
			branch.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === RESPONSE_DOCUMENT_CUSTOM_TYPE,
			),
		).find(record => record.messageEntryId === messageEntry.id);
		if (existing) return undefined;

		try {
			const artifactId = await this.#sessionManager.saveArtifact(markdown, RESPONSE_DOCUMENT_ARTIFACT_TYPE);
			if (!artifactId) return undefined;
			// Keep the artifact byte-identical to what the user saw, but derive the
			// session-journal synopsis from the persisted message. Secret
			// deobfuscation is display-only; copying that text into a custom entry
			// would leak plaintext values back into the JSONL session.
			const contextSafeMarkdown = visibleMarkdown(message) || markdown;
			const structure = extractMarkdownStructure(contextSafeMarkdown);
			const record: ResponseDocumentRecord = {
				schemaVersion: RESPONSE_DOCUMENT_SCHEMA_VERSION,
				messageEntryId: messageEntry.id,
				artifactId,
				mediaType: RESPONSE_DOCUMENT_MEDIA_TYPE,
				originalBytes,
				originalVisibleTokens,
				contentHash: `sha256:${new Bun.CryptoHasher("sha256").update(markdown).digest("hex")}`,
				synopsis: buildSynopsis(structure.paragraphs, options.synopsisMaxBytes, structure.conclusionLead),
				headingOutline: buildHeadingOutline(structure.headings),
				createdAt: new Date().toISOString(),
			};
			this.#sessionManager.appendCustomEntry(RESPONSE_DOCUMENT_CUSTOM_TYPE, record);
			return record;
		} catch (error) {
			logger.warn("Failed to save response document", {
				sessionId: this.#sessionManager.getSessionId(),
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	project(messages: AgentMessage[]): AgentMessage[] {
		if (this.#settings.get("san.responseDocuments.mode") === "off") return messages;
		const branch = this.#sessionManager.getBranch();
		const messageEntries = new Map(
			branch
				.filter((entry): entry is SessionMessageEntry => entry.type === "message")
				.map(entry => [entry.id, entry] as const),
		);
		const documentsByKey = new Map<string, ProjectableResponseDocument[]>();
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== RESPONSE_DOCUMENT_CUSTOM_TYPE) continue;
			if (!isResponseDocumentRecord(entry.data)) continue;
			const source = messageEntries.get(entry.data.messageEntryId)?.message;
			if (source?.role !== "assistant") continue;
			const key = sessionMessagePersistenceKey(source);
			if (!key) continue;
			const documents = documentsByKey.get(key);
			const document = { record: entry.data, message: source };
			if (documents) documents.push(document);
			else documentsByKey.set(key, [document]);
		}
		if (documentsByKey.size === 0) return messages;

		return messages.map(message => {
			if (message.role !== "assistant") return message;
			const key = sessionMessagePersistenceKey(message);
			if (!key) return message;
			const document = documentsByKey.get(key)?.find(candidate => sameMessageContent(candidate.message, message));
			if (!document) return message;
			return {
				...message,
				content: [{ type: "text", text: renderEnvelope(document.record) }],
				providerPayload: undefined,
			};
		});
	}
}
