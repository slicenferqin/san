import type { TinyMemoryLocalModelKey } from "./models";

export type TinyModelProgressStatus =
	| "initiate"
	| "download"
	| "progress"
	| "progress_total"
	| "done"
	| "ready"
	| "error";

export interface TinyModelProgressEvent {
	modelKey: TinyMemoryLocalModelKey;
	status: TinyModelProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
	task?: string;
	model?: string;
}

export type TinyModelWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "complete"; id: string; modelKey: TinyMemoryLocalModelKey; prompt: string; maxTokens?: number }
	| { type: "download"; id: string; modelKey: TinyMemoryLocalModelKey };

export type TinyModelWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "completion"; id: string; text: string | null }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: TinyModelProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> };

/** Typed IPC transport for the local memory/classifier inference subprocess. */
export interface TinyModelTransport {
	send(message: TinyModelWorkerOutbound): void;
	onMessage(handler: (message: TinyModelWorkerInbound) => void): () => void;
}
