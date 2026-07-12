/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
	Ultra = "ultra",
}

/** String-literal form accepted at public provider boundaries. */
export type EffortName = `${Effort}`;

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
	Effort.Ultra,
];
