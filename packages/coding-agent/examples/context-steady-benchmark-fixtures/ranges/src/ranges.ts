export interface Range {
	start: number;
	end: number;
}

export function normalizeRanges(ranges: readonly Range[]): Range[] {
	return [...ranges].sort((left, right) => left.start - right.start);
}
