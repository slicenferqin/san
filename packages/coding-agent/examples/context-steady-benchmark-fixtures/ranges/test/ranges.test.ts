import { describe, expect, test } from "bun:test";

import { normalizeRanges, type Range } from "../src/ranges";

describe("normalizeRanges", () => {
	test("合并重叠和相邻区间并保持输入不变", () => {
		const input: Range[] = [
			{ start: 8, end: 10 },
			{ start: 1, end: 3 },
			{ start: 3, end: 6 },
			{ start: 12, end: 12 },
			{ start: 11, end: 11 },
		];
		const snapshot = structuredClone(input);

		expect(normalizeRanges(input)).toEqual([
			{ start: 1, end: 6 },
			{ start: 8, end: 12 },
		]);
		expect(input).toEqual(snapshot);
	});

	test("非法区间返回带下标的错误", () => {
		expect(() => normalizeRanges([{ start: 5, end: 4 }])).toThrow("0");
	});
});
