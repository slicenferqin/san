import * as path from "node:path";
import type { ProgressInfo, TextGenerationPipeline, TextGenerationStringOutput } from "@huggingface/transformers";
import { getTinyModelsCacheDir } from "@san/utils";
import {
	errorMessage,
	errorText,
	formatOnnxRuntimeCudaDiagnostics,
	getTransformersVersionSpec,
	loadTransformersRuntime,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
	type TransformersRuntimeMetadata,
} from "../subprocess/worker-runtime";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "./device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "./dtype";
import { getTinyLocalModelSpec, type TinyLocalModelKey, type TinyMemoryLocalModelSpec } from "./models";
import type { TinyModelTransport, TinyModelWorkerInbound } from "./protocol";

const MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS = 256;
const COMPLETION_MAX_NEW_TOKENS = 1024;
const tinyModelDevicePreference = resolveTinyModelDevicePreference();
const tinyModelDtypeOverride = resolveTinyModelDtypeOverride();

interface TransformersRuntime extends TransformersRuntimeMetadata {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
	};
	LogLevel: {
		ERROR: unknown;
	};
	pipeline: (
		task: "text-generation",
		model: string,
		options: {
			device: TinyModelDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<TextGenerationPipeline>;
}

const pipelines = new Map<TinyLocalModelKey, Promise<TextGenerationPipeline>>();

let generateQueue = Promise.resolve();
const transformersRuntime = new MemoizedRuntime<TransformersRuntime>();

function getTinyModelRuntimeDir(): string {
	return path.join(
		path.dirname(getTinyModelsCacheDir()),
		"tiny-model-runtime",
		`transformers-${getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_")}`,
	);
}

async function loadPipelineOnDevice(
	transformers: TransformersRuntime,
	spec: TinyMemoryLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyModelTransport,
	requestId: string,
	device: TinyModelDevice,
): Promise<TextGenerationPipeline> {
	return transformers.pipeline("text-generation", spec.repo, {
		device,
		dtype: tinyModelDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadPipelineWithDeviceFallback(
	transformers: TransformersRuntime,
	spec: TinyMemoryLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyModelTransport,
	requestId: string,
): Promise<{ generator: TextGenerationPipeline; device: TinyModelDevice }> {
	const devices = tinyModelDeviceLoadOrder(tinyModelDevicePreference);
	if (devices[0] !== tinyModelDevicePreference.device) {
		sendLog(transport, "warn", "tiny-model: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: tinyModelDevicePreference.device,
			device: devices[0],
		});
	}
	let cudaDiagnostics: string | null = null;
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return {
				generator: await loadPipelineOnDevice(transformers, spec, modelKey, transport, requestId, device),
				device,
			};
		} catch (error) {
			const deviceDiagnostics = await formatOnnxRuntimeCudaDiagnostics(transformers, device, error);
			if (deviceDiagnostics) cudaDiagnostics = deviceDiagnostics;
			if (i === devices.length - 1) {
				if (cudaDiagnostics) throw new Error(`${errorText(error)}\n${cudaDiagnostics}`);
				throw error;
			}
			const fallbackDevice = devices[i + 1]!;
			const meta: Record<string, unknown> = {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			};
			if (deviceDiagnostics) meta.cudaDiagnostics = deviceDiagnostics;
			sendLog(transport, "warn", "tiny-model: accelerated device failed; falling back", meta);
		}
	}
	throw new Error("No tiny model devices configured");
}

async function loadPipeline(
	modelKey: TinyLocalModelKey,
	transport: TinyModelTransport,
	requestId: string,
): Promise<TextGenerationPipeline> {
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	if (spec.unsupportedReason) throw new Error(`${modelKey} is unavailable: ${spec.unsupportedReason}`);
	const cached = replayCachedReady(pipelines, modelKey, transport, requestId, "text-generation", spec.repo);
	if (cached) return cached;

	const transformers = await loadTransformersRuntime(
		transformersRuntime,
		transport,
		requestId,
		modelKey,
		getTinyModelRuntimeDir,
	);
	const startedAt = performance.now();
	const loaded = loadPipelineWithDeviceFallback(transformers, spec, modelKey, transport, requestId).then(
		({ generator, device }) => {
			sendLog(transport, "debug", "tiny-model: local model loaded", {
				modelKey,
				repo: spec.repo,
				device,
				requestedDevice: tinyModelDevicePreference.device,
				dtype: tinyModelDtypeOverride ?? spec.dtype,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: "text-generation", model: spec.repo },
			});
			return generator;
		},
		error => {
			pipelines.delete(modelKey);
			throw error;
		},
	);
	pipelines.set(modelKey, loaded);
	return loaded;
}

function buildCompletionPrompt(generator: TextGenerationPipeline, promptText: string): string {
	const chat = [{ role: "user", content: promptText }];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${generator.tokenizer.apply_chat_template(chat, chatTemplateOptions)}`;
}

/**
 * Generic single-turn completion used by Mnemopi memory tasks and local
 * classifiers. The caller supplies the full task prompt; we wrap it as one
 * user turn, decode greedily, and return raw text for the caller's parser.
 */
async function generateCompletion(
	transport: TinyModelTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
	promptText: string,
	maxTokens: number | undefined,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport, requestId);
	const text = buildCompletionPrompt(generator, promptText);
	const requested = maxTokens ?? MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS;
	const maxNewTokens = Math.min(Math.max(1, requested), COMPLETION_MAX_NEW_TOKENS);
	const output = (await generator(text, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
	})) as TextGenerationStringOutput;
	const generated = (output[0]?.generated_text ?? "").trim();
	return generated === "" ? null : generated;
}

function enqueueRequest(
	transport: TinyModelTransport,
	request: Extract<TinyModelWorkerInbound, { type: "complete" | "download" }>,
): void {
	generateQueue = generateQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TinyModelTransport,
	request: Extract<TinyModelWorkerInbound, { type: "complete" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadPipeline(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const text = await generateCompletion(transport, request.id, request.modelKey, request.prompt, request.maxTokens);
		transport.send({ type: "completion", id: request.id, text });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

export function startTinyModelWorker(transport: TinyModelTransport): void {
	transport.onMessage(message => {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		enqueueRequest(transport, message);
	});
}
