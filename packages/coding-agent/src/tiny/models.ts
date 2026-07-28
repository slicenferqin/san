/** Default memory model: the online path (the configured smol / remote LLM; no local download). */
export const ONLINE_MEMORY_MODEL_KEY = "online";
/** Recommended local model for memory tasks when none is named. */
export const DEFAULT_MEMORY_LOCAL_MODEL_KEY = "lfm2-1.2b";
export interface TinyMemoryLocalModelSpec {
	key: string;
	repo: string;
	dtype: "q4";
	label: string;
	description: string;
	contextNote: string;
	/** Model family emits hidden reasoning unless the chat template disables it. */
	reasoning?: boolean;
	/** Reason this model is blocked before loading the ONNX runtime. */
	unsupportedReason?: string;
}

/**
 * Local models for Mnemopi memory extraction/consolidation and local
 * classifiers. All shipped weights use q4. Ranking and recipe rationale live
 * in docs/local-models.md.
 */
export const TINY_MEMORY_LOCAL_MODELS = [
	{
		key: "qwen3-1.7b",
		repo: "onnx-community/Qwen3-1.7B-ONNX",
		dtype: "q4",
		label: "Qwen3 1.7B",
		description:
			"Disabled for local inference: onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
		contextNote: "Blocked before load to avoid the unsupported RotaryEmbedding runtime path.",
		reasoning: true,
		unsupportedReason:
			"onnxruntime-node does not support Qwen3 RotaryEmbedding cache updates in onnx-community/Qwen3-1.7B-ONNX",
	},
	{
		key: "llama3.2:3b",
		repo: "onnx-community/Llama-3.2-3B-Instruct-ONNX",
		dtype: "q4",
		label: "Llama 3.2 3B",
		description:
			"Larger Llama 3.2 option for local memory/classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
		contextNote: "Use when larger model capacity is preferred over faster load times.",
	},
	{
		key: "gemma-3-1b",
		repo: "onnx-community/gemma-3-1b-it-ONNX",
		dtype: "q4",
		label: "Gemma 3 1B",
		description: "Best consolidation/dedup; lighter footprint, but leaks small talk during extraction.",
		contextNote: "Use when consolidation quality and size matter most.",
	},
	{
		key: "qwen2.5-1.5b",
		repo: "onnx-community/Qwen2.5-1.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 1.5B",
		description: "Best extraction granularity (atomic facts); weaker consolidation.",
		contextNote: "Use when fine-grained, deduplicatable facts matter more than summaries.",
	},
	{
		key: "lfm2-1.2b",
		repo: "onnx-community/LFM2-1.2B-ONNX",
		dtype: "q4",
		label: "LFM2 1.2B",
		description: "Fastest load; solid all-rounder, slightly noisier extraction labels.",
		contextNote: "Use when local startup cost is the priority.",
	},
] as const satisfies readonly TinyMemoryLocalModelSpec[];

export const TINY_MEMORY_MODEL_VALUES = [
	ONLINE_MEMORY_MODEL_KEY,
	"qwen3-1.7b",
	"llama3.2:3b",
	"gemma-3-1b",
	"qwen2.5-1.5b",
	"lfm2-1.2b",
] as const;

export type TinyMemoryModelKey = (typeof TINY_MEMORY_MODEL_VALUES)[number];
export type TinyMemoryLocalModelKey = (typeof TINY_MEMORY_LOCAL_MODELS)[number]["key"];

type MissingTinyMemoryModelValue = Exclude<
	typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey,
	TinyMemoryModelKey
>;
type ExtraTinyMemoryModelValue = Exclude<TinyMemoryModelKey, typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey>;
const TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY: MissingTinyMemoryModelValue extends never
	? ExtraTinyMemoryModelValue extends never
		? true
		: never
	: never = true;
void TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_MEMORY_MODEL_OPTIONS = [
	{
		value: ONLINE_MEMORY_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Use the online model: the TINY role from /models when set, otherwise @smol. No local model download or on-device inference.",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyMemoryModelKey; label: string; description: string }>;

export function isTinyMemoryLocalModelKey(value: string): value is TinyMemoryLocalModelKey {
	return TINY_MEMORY_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyMemoryModelSpec(key: TinyMemoryLocalModelKey): (typeof TINY_MEMORY_LOCAL_MODELS)[number] {
	const spec = TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny memory model: ${key}`);
	return spec;
}

/** Return whether a memory local model may emit reasoning tokens before answers. */
export function isTinyMemoryReasoningModelKey(key: TinyMemoryLocalModelKey): boolean {
	const spec = getTinyMemoryModelSpec(key);
	return "reasoning" in spec && spec.reasoning === true;
}

/** Any local memory/classifier model key used by the inference worker. */
export type TinyLocalModelKey = TinyMemoryLocalModelKey;

/** Resolve a local memory/classifier model spec by key. */
export function getTinyLocalModelSpec(key: string): TinyMemoryLocalModelSpec | undefined {
	return TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key);
}

export const isTinyLocalModelKey = isTinyMemoryLocalModelKey;

/** Local memory/classifier models accepted by the shared inference worker. */
export const TINY_LOCAL_MODELS = TINY_MEMORY_LOCAL_MODELS;

/**
 * Difficulty-classifier model for the `auto` thinking level. Defaults to the
 * online smol path; local options reuse the memory-model registry because
 * structured classification needs the same 1B+ models.
 */
export const ONLINE_AUTO_THINKING_MODEL_KEY = ONLINE_MEMORY_MODEL_KEY;
export const AUTO_THINKING_MODEL_VALUES = TINY_MEMORY_MODEL_VALUES;
export type AutoThinkingModelKey = TinyMemoryModelKey;

export const AUTO_THINKING_MODEL_OPTIONS = [
	{
		value: ONLINE_AUTO_THINKING_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Classify prompt difficulty online with the TINY role model (set one in /models) or @smol; no local download or on-device inference.",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: AutoThinkingModelKey; label: string; description: string }>;
