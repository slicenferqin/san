/**
 * 北极星 benchmark 固定样本集(打磨规划 3.1,指标经 goal-fidelity 研究修正)。
 *
 * 每条样本自包含:fixture 文件、任务 prompt、**确定性验收命令**(目标保真度
 * 的主信号——通过即产出与契约一致)、预算上限。样本必须稳定:同一 commit
 * 上重复运行,fixture 与验收逐字节一致。
 *
 * kinds:
 * - fix-bug(5):有失败测试的缺陷修复,验收 = 同一测试转绿;
 * - add-feature(3):测试先行的小功能,验收 = 预写测试转绿;
 * - fuzzy(1):模糊需求但验收可判定;
 * - steering(1):介入效率场景 — 任务中途注入一次纠偏,验收检查最终实现
 *   遵循纠偏(测的是"一次介入能否回正轨")。
 */

export interface NorthStarSample {
	readonly id: string;
	readonly kind: "fix-bug" | "add-feature" | "fuzzy" | "steering";
	/** 写入 fixture 的文件(路径 → 内容)。 */
	readonly files: Readonly<Record<string, string>>;
	/** 交给 agent 的任务(单条,无人值守语义)。 */
	readonly prompt: string;
	/** 中途纠偏消息(仅 steering 样本;在首个回合 settle 后注入)。 */
	readonly steer?: string;
	/** 确定性验收命令(fixture cwd 内执行,exit 0 = 目标达成)。 */
	readonly acceptance: string;
	/** 墙钟上限(毫秒);超时按"预算外"记。 */
	readonly timeoutMs: number;
}

const PKG = `${JSON.stringify({ name: "bench-fixture", type: "module", private: true }, null, "\t")}\n`;

export const NORTH_STAR_SAMPLES: readonly NorthStarSample[] = [
	{
		id: "bug-off-by-one",
		kind: "fix-bug",
		files: {
			"package.json": PKG,
			"range-sum.ts": [
				"/** Sum of integers in the inclusive range [start, end]. */",
				"export function rangeSum(start: number, end: number): number {",
				"\tlet total = 0;",
				"\tfor (let i = start; i < end; i++) total += i;",
				"\treturn total;",
				"}",
				"",
			].join("\n"),
			"range-sum.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { rangeSum } from "./range-sum";',
				"",
				'test("rangeSum includes both endpoints", () => {',
				"\texpect(rangeSum(1, 3)).toBe(6);",
				"\texpect(rangeSum(4, 4)).toBe(4);",
				"});",
				"",
			].join("\n"),
		},
		prompt: "range-sum.test.ts 的测试失败了,修复 range-sum.ts 里的缺陷让测试通过。不要修改测试文件。",
		acceptance: "bun test range-sum.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "bug-empty-input",
		kind: "fix-bug",
		files: {
			"package.json": PKG,
			"stats.ts": [
				"/** Average of a list of numbers. */",
				"export function average(values: number[]): number {",
				"\tconst sum = values.reduce((a, b) => a + b);",
				"\treturn sum / values.length;",
				"}",
				"",
			].join("\n"),
			"stats.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { average } from "./stats";',
				"",
				'test("average of numbers", () => {',
				"\texpect(average([2, 4, 6])).toBe(4);",
				"});",
				"",
				'test("average of empty list is 0, not a crash", () => {',
				"\texpect(average([])).toBe(0);",
				"});",
				"",
			].join("\n"),
		},
		prompt: "跑一下 stats.test.ts,有个用例挂了。修复 stats.ts,不要改测试。",
		acceptance: "bun test stats.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "bug-missing-await",
		kind: "fix-bug",
		files: {
			"package.json": PKG,
			"loader.ts": [
				'import * as fs from "node:fs/promises";',
				"",
				"/** Load and parse a JSON file, returning its `items` array length. */",
				"export async function countItems(path: string): Promise<number> {",
				'\tconst text = fs.readFile(path, "utf8");',
				"\tconst data = JSON.parse(text as unknown as string);",
				"\treturn data.items.length;",
				"}",
				"",
			].join("\n"),
			"loader.test.ts": [
				'import { expect, test } from "bun:test";',
				'import * as fs from "node:fs/promises";',
				'import { countItems } from "./loader";',
				"",
				'test("counts items from a JSON file", async () => {',
				'\tawait fs.writeFile("data.json", JSON.stringify({ items: [1, 2, 3] }));',
				'\texpect(await countItems("data.json")).toBe(3);',
				"});",
				"",
			].join("\n"),
		},
		prompt: "loader.test.ts 失败,loader.ts 里有个异步处理的错误,修好它。不要改测试。",
		acceptance: "bun test loader.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "bug-string-concat",
		kind: "fix-bug",
		files: {
			"package.json": PKG,
			"cart.ts": [
				"interface Item { price: string; qty: number }",
				"",
				"/** Total price of cart items (price arrives as a decimal string). */",
				"export function cartTotal(items: Item[]): number {",
				"\tlet total = 0;",
				"\tfor (const item of items) {",
				"\t\ttotal += (item.price as unknown as number) * item.qty;",
				"\t}",
				"\treturn total;",
				"}",
				"",
			].join("\n"),
			"cart.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { cartTotal } from "./cart";',
				"",
				'test("totals decimal string prices", () => {',
				'\texpect(cartTotal([{ price: "1.50", qty: 2 }, { price: "0.25", qty: 4 }])).toBe(4);',
				"});",
				"",
			].join("\n"),
		},
		prompt: "cart.test.ts 的合计金额算错了,修复 cart.ts。不要改测试。",
		acceptance: "bun test cart.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "bug-regex-anchor",
		kind: "fix-bug",
		files: {
			"package.json": PKG,
			"validate.ts": [
				"/** A handle is 3-12 lowercase letters or digits, nothing else. */",
				"export function isValidHandle(handle: string): boolean {",
				"\treturn /[a-z0-9]{3,12}/.test(handle);",
				"}",
				"",
			].join("\n"),
			"validate.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { isValidHandle } from "./validate";',
				"",
				'test("accepts plain handles", () => {',
				'\texpect(isValidHandle("alice42")).toBe(true);',
				"});",
				"",
				'test("rejects handles with extra characters", () => {',
				'\texpect(isValidHandle("bad handle!")).toBe(false);',
				'\texpect(isValidHandle("UPPER")).toBe(false);',
				'\texpect(isValidHandle("x")).toBe(false);',
				"});",
				"",
			].join("\n"),
		},
		prompt: "validate.test.ts 有用例失败,isValidHandle 的校验有漏洞。修复 validate.ts,不要改测试。",
		acceptance: "bun test validate.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "feat-slugify",
		kind: "add-feature",
		files: {
			"package.json": PKG,
			"slug.ts": ["// TODO: implement slugify", "export {};", ""].join("\n"),
			"slug.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { slugify } from "./slug";',
				"",
				'test("lowercases and hyphenates", () => {',
				'\texpect(slugify("Hello World")).toBe("hello-world");',
				"});",
				"",
				'test("strips punctuation and collapses spaces", () => {',
				'\texpect(slugify("  A --- Messy,  Title! ")).toBe("a-messy-title");',
				"});",
				"",
			].join("\n"),
		},
		prompt: "按 slug.test.ts 里的用例实现 slug.ts 的 slugify 函数,让测试通过。不要改测试。",
		acceptance: "bun test slug.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "feat-cli-flag",
		kind: "add-feature",
		files: {
			"package.json": PKG,
			"greet.ts": [
				"const args = process.argv.slice(2);",
				'const name = args[0] ?? "world";',
				"console.log(`hello ${name}`);",
				"",
			].join("\n"),
			"greet.test.ts": [
				'import { expect, test } from "bun:test";',
				"",
				'test("--shout flag uppercases the greeting", async () => {',
				'\tconst proc = Bun.spawn(["bun", "greet.ts", "sam", "--shout"], { stdout: "pipe" });',
				"\tconst out = await new Response(proc.stdout).text();",
				'\texpect(out.trim()).toBe("HELLO SAM");',
				"});",
				"",
				'test("default greeting stays lowercase", async () => {',
				'\tconst proc = Bun.spawn(["bun", "greet.ts", "sam"], { stdout: "pipe" });',
				"\tconst out = await new Response(proc.stdout).text();",
				'\texpect(out.trim()).toBe("hello sam");',
				"});",
				"",
			].join("\n"),
		},
		prompt: "给 greet.ts 加一个 --shout 参数支持,规格见 greet.test.ts。让测试通过,不要改测试。",
		acceptance: "bun test greet.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "feat-csv-row",
		kind: "add-feature",
		files: {
			"package.json": PKG,
			"csv.ts": ["// TODO: implement parseRow", "export {};", ""].join("\n"),
			"csv.test.ts": [
				'import { expect, test } from "bun:test";',
				'import { parseRow } from "./csv";',
				"",
				'test("splits a simple row", () => {',
				'\texpect(parseRow("a,b,c")).toEqual(["a", "b", "c"]);',
				"});",
				"",
				'test("honors double-quoted fields with commas", () => {',
				'\texpect(parseRow(\'x,"y,z",w\')).toEqual(["x", "y,z", "w"]);',
				"});",
				"",
			].join("\n"),
		},
		prompt: "实现 csv.ts 的 parseRow(单行 CSV 解析,支持双引号字段),规格见 csv.test.ts。不要改测试。",
		acceptance: "bun test csv.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "fuzzy-readable-report",
		kind: "fuzzy",
		files: {
			"package.json": PKG,
			"report.ts": [
				"const data = [",
				'\t{ name: "alpha", passed: 12, failed: 1 },',
				'\t{ name: "beta", passed: 7, failed: 0 },',
				'\t{ name: "gamma", passed: 3, failed: 5 },',
				"];",
				"for (const row of data) console.log(JSON.stringify(row));",
				"",
			].join("\n"),
			"report.test.ts": [
				'import { expect, test } from "bun:test";',
				"",
				'test("report output is a readable aligned table, not JSON lines", async () => {',
				'\tconst proc = Bun.spawn(["bun", "report.ts"], { stdout: "pipe" });',
				"\tconst out = await new Response(proc.stdout).text();",
				'\tconst lines = out.trim().split("\\n");',
				"\t// A human-readable table: has a header naming the columns, no raw JSON braces,",
				"\t// and one row per dataset entry after the header.",
				"\texpect(lines[0]).toMatch(/name/i);",
				"\texpect(lines[0]).toMatch(/passed/i);",
				'\texpect(out).not.toContain("{");',
				"\texpect(lines.length).toBeGreaterThanOrEqual(4);",
				"});",
				"",
			].join("\n"),
		},
		prompt: "report.ts 的输出太难读了,让它变得人类可读一些。验收标准在 report.test.ts 里。不要改测试。",
		acceptance: "bun test report.test.ts",
		timeoutMs: 6 * 60_000,
	},
	{
		id: "steering-method-switch",
		kind: "steering",
		files: {
			"package.json": PKG,
			"dedupe.ts": ["// TODO: implement dedupe", "export {};", ""].join("\n"),
			"dedupe.test.ts": [
				'import { expect, test } from "bun:test";',
				'import * as fs from "node:fs";',
				'import { dedupe } from "./dedupe";',
				"",
				'test("removes duplicates preserving first occurrence", () => {',
				"\texpect(dedupe([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);",
				"});",
				"",
				'test("implementation uses a Set, per the steering correction", () => {',
				'\tconst source = fs.readFileSync("dedupe.ts", "utf8");',
				'\texpect(source).toContain("Set");',
				'\texpect(source).not.toContain("indexOf");',
				"});",
				"",
			].join("\n"),
		},
		prompt: "实现 dedupe.ts 的 dedupe 函数(数组去重,保留首次出现顺序)。先用 indexOf 过滤的方式实现。",
		steer: "改一下:不要用 indexOf 的方式,改用 Set 实现,性能更好。",
		acceptance: "bun test dedupe.test.ts",
		timeoutMs: 8 * 60_000,
	},
];
