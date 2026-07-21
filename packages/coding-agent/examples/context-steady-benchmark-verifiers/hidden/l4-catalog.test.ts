import { describe, expect, test } from "bun:test";

import { loadCatalog } from "./src/catalog/load";
import { renderCatalogMarkdown } from "./src/catalog/render";

const valid = `{
  // 隐藏 JSON5 测试数据。
  version: 1,
  services: [
    { id: 'zeta', owner: 'platform', docs: './services/zeta.md', tier: 'standard' },
    { id: 'alpha', owner: 'identity', docs: './services/alpha.md', tier: 'critical' },
  ],
}`;

describe("L4 hidden catalog contract", () => {
	test("validates JSON5 and renders a deterministic Markdown table", () => {
		const markdown = renderCatalogMarkdown(loadCatalog(valid));
		expect(renderCatalogMarkdown(loadCatalog(valid))).toBe(markdown);
		expect(markdown).toContain("| Service | Owner | Tier | Docs |\n");
		expect(markdown).toContain("(./services/alpha.md)");
		expect(markdown).toContain("(./services/zeta.md)");
		expect(markdown.indexOf("alpha")).toBeLessThan(markdown.indexOf("zeta"));
		expect(markdown.endsWith("\n")).toBe(true);
	});

	test("rejects duplicate ids and unsafe docs links with concrete identity", () => {
		expect(() => loadCatalog(valid.replace("'zeta'", "'alpha'"))).toThrow(/alpha.*(?:duplicate|重复|unique|唯一)/i);
		expect(() => loadCatalog(valid.replace("./services/zeta.md", "https://example.com/zeta"))).toThrow(/zeta.*docs/i);
	});

	test("rejects unsupported catalog versions", () => {
		expect(() => loadCatalog(valid.replace("version: 1", "version: 2"))).toThrow(/version.*2/i);
	});

	test("documents CLI usage, validation, and generated output ownership", async () => {
		const docs = await Bun.file("docs/catalog.md").text();
		expect(docs).toContain("bun src/catalog/cli.ts");
		expect(docs).toContain("JSON5");
		expect(docs).toMatch(/duplicate|重复|唯一|unique/i);
		expect(docs).toMatch(/generated|生成/i);
	});
});
