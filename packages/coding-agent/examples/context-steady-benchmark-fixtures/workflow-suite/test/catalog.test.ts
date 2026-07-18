import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog/load";
import { renderCatalogMarkdown } from "../src/catalog/render";

describe("service catalog", () => {
	test("loads JSON5 and renders a stable table", async () => {
		const catalog = loadCatalog(await Bun.file("examples/catalog.json5").text());
		const markdown = renderCatalogMarkdown(catalog);
		expect(markdown).toContain("| Service | Owner | Tier | Docs |");
		expect(markdown.indexOf("catalog")).toBeLessThan(markdown.indexOf("orders"));
	});
});
