/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `san -p "prompt"` - text output
 * - `san --mode json "prompt"` - JSON event stream
 */
import type { AgentMessage } from "@san/agent";
import type { AssistantMessage, ImageContent } from "@san/ai";
import { logger, sanitizeText } from "@san/utils";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
}

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/**
 * Shape an event for `--mode json` output.
 *
 * Removes two classes of bloat so transcripts grow linearly with conversation
 * size instead of quadratically (a single long turn used to re-serialize its
 * whole in-progress message on every streamed delta, producing multi-GB logs):
 * - `message_update` snapshots (`message`, `assistantMessageEvent.partial`,
 *   and the `done`/`error` payloads) are dropped; only the incremental delta
 *   is printed. The authoritative message follows in `message_end`.
 * - `providerPayload` is transport-native replay state, opaque and useless
 *   outside this process.
 */
export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	let textOutputBuffered = false;
	const beginTextPrompt = (): void => {
		if (options.mode !== "text" || typeof session.setTextOutputCommitted !== "function") return;
		textOutputBuffered = true;
		session.setTextOutputCommitted(false);
	};
	try {
		await runPrintModeInternal(session, options, beginTextPrompt);
	} finally {
		if (textOutputBuffered) session.setTextOutputCommitted?.(true);
	}
}

async function runPrintModeInternal(
	session: AgentSession,
	options: PrintModeOptions,
	beginTextPrompt: () => void,
): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts } = options;
	// stdout.write 不会等待管道排空。将所有记录按回调完成顺序串起来，确保大体积
	// agent_end 或最终文本在进程退出前完整写出，并保持事件原有顺序。
	let stdoutTail: Promise<void> = Promise.resolve();
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(async () => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) {
					reject(new Error(`Print mode stdout write failed: ${err.message}`, { cause: err }));
					return;
				}
				resolve();
			});
			await promise;
		});
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeStdoutLine(`${JSON.stringify(header)}\n`);
		}
	}
	// Set up extensions for print mode (no UI, no command context)
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		beginTextPrompt();
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	// Send remaining messages
	for (const message of messages) {
		writeTextWorkingIndicator();
		beginTextPrompt();
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	// In text mode, output final response
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// Check for error/aborted — skip silent-abort (plan-mode compaction transition)
			if (
				(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
				!isSilentAbort(assistantMsg)
			) {
				const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				// This branch hard-exits, bypassing the `await session.dispose()` at
				// the end of runPrintMode. Flush telemetry and dispose the session
				// HERE so error spans reach the exporter (the postmortem `exit`
				// handler can't await) and the browser reaper installed in
				// `dispose()` (releaseTabsForOwner) actually runs — otherwise an
				// San-owned Chromium survives this exit (issue #5643). `dispose()`
				// is idempotent, so the unreachable call below is a harmless no-op.
				await flushTelemetryExport();
				await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
				const flushed = process.stderr.write(`${errorLine}\n`);
				if (flushed) {
					process.exit(1);
				} else {
					process.stderr.once("drain", () => process.exit(1));
				}
			}

			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					writeStdoutLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
	}

	// 等待已排队的最终记录自身完成，空写入不能充当前序大记录的排空屏障。
	await stdoutTail;

	await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
}
