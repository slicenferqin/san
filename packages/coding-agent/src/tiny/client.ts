import { $env, logger } from "@san/utils";
import { settings } from "../config/settings";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import { isTinyMemoryLocalModelKey, type TinyMemoryLocalModelKey } from "./models";
import type { TinyModelProgressEvent, TinyModelWorkerInbound, TinyModelWorkerOutbound } from "./protocol";

type PendingRequest =
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyMemoryLocalModelKey; resolve: (result: TinyModelDownloadResult) => void };

export interface TinyModelDownloadResult {
	ok: boolean;
	error?: string;
}

export interface TinyModelDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyModelProgressEvent) => void;
}

/** Hidden selector that re-enters the main CLI as the local tiny-model worker. */
export const TINY_MODEL_WORKER_ARG = "__omp_worker_tiny_inference";

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (for example, `san --smoke-test`).
		return undefined;
	}
}

/** Resolve persisted device/dtype settings into worker environment variables. */
export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	if (!env.SAN_TINY_DEVICE && !env.PI_TINY_DEVICE) {
		const device = tinyModelDeviceSettingToEnv(deviceSetting);
		if (device) {
			overlay.SAN_TINY_DEVICE = device;
			overlay.PI_TINY_DEVICE = device;
		}
	}
	if (!env.SAN_TINY_DTYPE && !env.PI_TINY_DTYPE) {
		const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
		if (dtype) {
			overlay.SAN_TINY_DTYPE = dtype;
			overlay.PI_TINY_DTYPE = dtype;
		}
	}
	return overlay;
}

export function tinyWorkerEnv(): Record<string, string> {
	return workerEnvFromParent(
		tinyWorkerEnvOverlay(
			$env,
			readTinyModelSetting("providers.tinyModelDevice"),
			readTinyModelSetting("providers.tinyModelDtype"),
		),
	);
}

/** Spawn the local memory/classifier model worker subprocess. */
export function createTinyModelSubprocess(): SpawnedSubprocess<TinyModelWorkerOutbound> {
	return createWorkerSubprocess<TinyModelWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TINY_MODEL_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tiny model subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<TinyModelWorkerOutbound>,
): RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound>(spawned, message =>
			safeSend(proc, message, "tiny-model"),
		),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(
	error: unknown,
): RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> {
	return {
		...createUnavailableWorker<TinyModelWorkerInbound, TinyModelWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnTinyModelWorker(): RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createTinyModelSubprocess()),
		spawnInlineUnavailableWorker,
		"Tiny model worker spawn failed; local memory and classifiers disabled",
	);
}

export class TinyModelClient {
	#worker: RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#failedModels = new Set<TinyMemoryLocalModelKey>();
	#progressListeners = new Set<(event: TinyModelProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound>;

	constructor(
		spawnWorker: () => RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> = spawnTinyModelWorker,
	) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TinyModelProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async complete(
		modelKey: string,
		prompt: string,
		options: { maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "complete", id, modelKey, prompt, maxTokens: options.maxTokens });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyModelDownloadOptions = {}): Promise<TinyModelDownloadResult> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TinyModelDownloadResult>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve({ ok: false });
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tiny-model: local model download failed", { modelKey, error: message });
			return { ok: false, error: message };
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false });
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<TinyModelWorkerInbound, TinyModelWorkerOutbound> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TinyModelWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-model: worker returned error", { error: message.error });
		if (pending.kind === "complete") this.#failedModels.add(pending.modelKey);
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.resolve(null);
		void this.terminate();
	}

	#emitProgress(event: TinyModelProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-model: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false, error: error.message });
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyModelClient = new TinyModelClient();

export async function shutdownTinyModelClient(): Promise<void> {
	await tinyModelClient.terminate();
}

export async function smokeTestTinyModelWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createTinyModelSubprocess()), "tiny model worker", timeoutMs);
}
