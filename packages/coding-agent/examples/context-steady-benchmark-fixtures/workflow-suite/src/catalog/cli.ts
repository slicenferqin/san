import { loadCatalog } from "./load";
import { renderCatalogMarkdown } from "./render";

const input = Bun.argv[2];
const output = Bun.argv[3];
if (!input || !output) throw new Error("Usage: bun src/catalog/cli.ts <catalog.json5> <output.md>");
const catalog = loadCatalog(await Bun.file(input).text());
await Bun.write(output, renderCatalogMarkdown(catalog));
