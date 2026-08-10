import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@san/agent";
import type { AssistantMessage, Usage } from "@san/ai";
import { createMockModel, type MockModel } from "@san/ai/providers/mock";
import { ModelRegistry } from "@san/coding-agent/config/model-registry";
import { Settings } from "@san/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@san/coding-agent/session/agent-session";
import { ArtifactManager } from "@san/coding-agent/session/artifacts";
import { AuthStorage } from "@san/coding-agent/session/auth-storage";
import { convertToLlm } from "@san/coding-agent/session/messages";
import {
	isResponseDocumentRecord,
	RESPONSE_DOCUMENT_CUSTOM_TYPE,
	type ResponseDocumentRecord,
	ResponseDocumentRuntime,
} from "@san/coding-agent/session/response-documents";
import type { CustomEntry, SessionMessageEntry } from "@san/coding-agent/session/session-entries";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import { TempDir } from "@san/utils";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	mock: MockModel;
	tempDir: TempDir;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		await harness.session.dispose();
		await harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

function assistantMessage(
	text: string,
	options?: { timestamp?: number; stopReason?: AssistantMessage["stopReason"]; withToolCall?: boolean },
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(options?.withToolCall
				? [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "README.md" } }]
				: []),
		],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: options?.stopReason ?? "stop",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [{ id: `response-${options?.timestamp ?? 1}` }],
		},
		timestamp: options?.timestamp ?? 1,
	};
}

function responseDocumentRecords(sessionManager: SessionManager): ResponseDocumentRecord[] {
	return sessionManager.getBranch().flatMap(entry => {
		if (entry.type !== "custom" || entry.customType !== RESPONSE_DOCUMENT_CUSTOM_TYPE) return [];
		return isResponseDocumentRecord(entry.data) ? [entry.data] : [];
	});
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("");
}

async function createHarness(firstAnswer: string): Promise<Harness> {
	const tempDir = TempDir.createSync("@san-response-documents-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const mock = createMockModel({
		responses: [
			{ content: [firstAnswer], stopReason: "stop" },
			{ content: ["Second answer."], stopReason: "stop" },
		],
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"san.contextSteady.enabled": false,
		"san.responseDocuments.mode": "auto",
		"san.responseDocuments.minBytes": 100,
		"san.responseDocuments.minTokens": 100_000,
		"san.responseDocuments.synopsisMaxBytes": 80,
	});
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	const harness = { session, sessionManager, authStorage, mock, tempDir };
	harnesses.push(harness);
	return harness;
}

describe("Response Documents", () => {
	it("keeps the full current response while the next provider request receives only its artifact envelope", async () => {
		const fullOnlyMarker = `FULL_ONLY_MARKER_${"x".repeat(180)}`;
		const fullAnswer = [
			"# Detailed report",
			"",
			fullOnlyMarker,
			"",
			"## Conclusion",
			"Ship the bounded response-document projection.",
			"",
			"## Verification",
			"The artifact remains exact and readable.",
		].join("\n");
		const { session, sessionManager, mock } = await createHarness(fullAnswer);
		const displayedAnswers: string[] = [];
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				displayedAnswers.push(assistantText(event.message));
			}
			if (event.type === "notice" && event.source === "response-document") notices.push(event);
		});

		await session.prompt("Produce the report.");
		await session.waitForIdle();
		const recordsAfterFirstTurn = responseDocumentRecords(sessionManager);
		expect(recordsAfterFirstTurn).toHaveLength(1);
		const firstRecord = recordsAfterFirstTurn[0]!;
		const artifactPath = await sessionManager.getArtifactPath(firstRecord.artifactId);
		if (!artifactPath) throw new Error("Expected a response-document artifact path.");
		expect(await Bun.file(artifactPath).text()).toBe(fullAnswer);

		await session.prompt("Continue with the next task.");
		await session.waitForIdle();

		expect(displayedAnswers[0]).toBe(fullAnswer);
		const persistedAssistant = sessionManager
			.getBranch()
			.find(
				(entry): entry is SessionMessageEntry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.id === firstRecord.messageEntryId,
			);
		expect(
			persistedAssistant?.message.role === "assistant" ? assistantText(persistedAssistant.message) : undefined,
		).toBe(fullAnswer);
		expect(firstRecord.synopsis).toBe("Ship the bounded response-document projection.");
		expect(firstRecord.headingOutline).toEqual(["Detailed report", "Conclusion", "Verification"]);
		expect(firstRecord.originalBytes).toBe(Buffer.byteLength(fullAnswer, "utf8"));
		expect(firstRecord.contentHash).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(fullAnswer).digest("hex")}`);
		expect(notices).toEqual([
			{
				type: "notice",
				level: "info",
				message: `Response saved as artifact://${firstRecord.artifactId}; later model turns receive a bounded synopsis.`,
				source: "response-document",
			},
		]);
		expect(mock.calls).toHaveLength(2);
		const secondProviderPayload = JSON.stringify(mock.calls[1]!.context.messages);
		expect(secondProviderPayload).toContain(`artifact://${firstRecord.artifactId}`);
		expect(secondProviderPayload).toContain("Ship the bounded response-document projection.");
		expect(secondProviderPayload).not.toContain(fullOnlyMarker);
		expect(responseDocumentRecords(sessionManager)).toHaveLength(1);
	});

	it("saves the visible Markdown, strips native replay payloads, and restores projection after reopen", async () => {
		const tempDir = TempDir.createSync("@san-response-document-reopen-");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const settings = Settings.isolated({
			"san.responseDocuments.mode": "always",
			"san.responseDocuments.synopsisMaxBytes": 64,
		});
		const originalMarkdown = "# Visible report\n\nConclusion: keep #SECRET# hidden.";
		const original = assistantMessage(originalMarkdown, { timestamp: 10 });
		const visibleMarkdown = "# Visible report\n\nConclusion: keep actual-token hidden.";
		const visible = { ...original, content: [{ type: "text" as const, text: visibleMarkdown }] };
		const messageEntryId = sessionManager.appendMessage(original);
		const runtime = new ResponseDocumentRuntime(sessionManager, settings);
		runtime.rememberVisibleAssistant(original, visible);
		let sessionManagerClosed = false;

		try {
			const record = await runtime.externalizeAssistant(original);
			if (!record) throw new Error("Expected a response-document record.");
			expect(record.messageEntryId).toBe(messageEntryId);
			const artifactPath = await sessionManager.getArtifactPath(record.artifactId);
			if (!artifactPath) throw new Error("Expected a response-document artifact path.");
			expect(await Bun.file(artifactPath).text()).toBe(visibleMarkdown);

			const projected = runtime.project(sessionManager.buildSessionContext().messages);
			const projectedAssistant = projected.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			expect(projectedAssistant?.providerPayload).toBeUndefined();
			expect(projectedAssistant ? assistantText(projectedAssistant) : "").toContain(
				`artifact://${record.artifactId}`,
			);
			expect(projectedAssistant ? assistantText(projectedAssistant) : "").toContain(
				"Conclusion: keep #SECRET# hidden.",
			);
			expect(projectedAssistant ? assistantText(projectedAssistant) : "").not.toContain("actual-token");
			expect(await runtime.externalizeAssistant(original)).toBeUndefined();
			expect(responseDocumentRecords(sessionManager)).toHaveLength(1);
			const responseDocumentLeafId = sessionManager.getLeafId();
			if (!responseDocumentLeafId) throw new Error("Expected a response-document branch leaf.");
			sessionManager.branch(messageEntryId);
			const unrecordedBranchAssistant = runtime
				.project(sessionManager.buildSessionContext().messages)
				.find((message): message is AssistantMessage => message.role === "assistant");
			expect(unrecordedBranchAssistant ? assistantText(unrecordedBranchAssistant) : "").toBe(originalMarkdown);
			expect(unrecordedBranchAssistant?.providerPayload).toBeDefined();
			sessionManager.branch(responseDocumentLeafId);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file.");
			await sessionManager.flush();
			expect(await Bun.file(sessionFile).text()).not.toContain("actual-token");
			await sessionManager.close();
			sessionManagerClosed = true;
			const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
				initialCwd: tempDir.path(),
			});
			try {
				const restoredRuntime = new ResponseDocumentRuntime(reopened, settings);
				const restored = restoredRuntime.project(reopened.buildSessionContext().messages);
				const restoredAssistant = restored.find(
					(message): message is AssistantMessage => message.role === "assistant",
				);
				expect(restoredAssistant ? assistantText(restoredAssistant) : "").toContain(
					`artifact://${record.artifactId}`,
				);
				expect(responseDocumentRecords(reopened)).toEqual([record]);
				const restoredArtifactPath = await reopened.getArtifactPath(record.artifactId);
				if (!restoredArtifactPath) throw new Error("Expected the reopened artifact path.");
				expect(await Bun.file(restoredArtifactPath).text()).toBe(visibleMarkdown);
			} finally {
				await reopened.close();
			}
		} finally {
			if (!sessionManagerClosed) await sessionManager.close();
			tempDir.removeSync();
		}
	});

	it("keeps the full response inline when artifact persistence fails", async () => {
		const tempDir = TempDir.createSync("@san-response-document-save-failure-");
		const artifactBlocker = path.join(tempDir.path(), "artifact-blocker");
		await Bun.write(artifactBlocker, "not a directory");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		sessionManager.adoptArtifactManager(new ArtifactManager(artifactBlocker));
		const settings = Settings.isolated({ "san.responseDocuments.mode": "always" });
		const message = assistantMessage("This response must remain inline after the artifact write fails.", {
			timestamp: 30,
		});
		sessionManager.appendMessage(message);
		const runtime = new ResponseDocumentRuntime(sessionManager, settings);

		try {
			expect(await runtime.externalizeAssistant(message)).toBeUndefined();
			expect(responseDocumentRecords(sessionManager)).toHaveLength(0);
			const projected = runtime.project(sessionManager.buildSessionContext().messages);
			const assistant = projected.find((candidate): candidate is AssistantMessage => candidate.role === "assistant");
			expect(assistant ? assistantText(assistant) : "").toBe(
				"This response must remain inline after the artifact write fails.",
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("is default-off and exempts short, tool-call, and unsuccessful assistant messages in auto mode", async () => {
		expect(Settings.isolated().get("san.responseDocuments.mode")).toBe("off");
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"san.responseDocuments.mode": "auto",
			"san.responseDocuments.minBytes": 100,
			"san.responseDocuments.minTokens": 100,
		});
		const runtime = new ResponseDocumentRuntime(sessionManager, settings);
		const messages = [
			assistantMessage("Short answer.", { timestamp: 20 }),
			assistantMessage("x".repeat(500), { timestamp: 21, stopReason: "toolUse", withToolCall: true }),
			assistantMessage("x".repeat(500), { timestamp: 22, stopReason: "error" }),
		];
		for (const message of messages) {
			sessionManager.appendMessage(message);
			expect(await runtime.externalizeAssistant(message)).toBeUndefined();
		}
		const responseEntries = sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === RESPONSE_DOCUMENT_CUSTOM_TYPE,
			);
		expect(responseEntries).toHaveLength(0);
	});
});
