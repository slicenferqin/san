import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_TOOL_NAMES } from "@san/coding-agent/tools/builtin-names";

// Every shipped built-in tool that is exposed to the model in normal sessions
// must have a docs/tools/<name>.md root doc served by `omp://`. File names use
// underscores or hyphens; the test accepts either form so renaming the on-disk
// page does not require coordinating with the wire name.
const docsToolsDir = path.resolve(import.meta.dir, "../../../../docs/tools");

const expectedDocPaths = (name: string): string[] => [
	path.join(docsToolsDir, `${name}.md`),
	path.join(docsToolsDir, `${name.replace(/_/g, "-")}.md`),
];

// Custom tools injected by the SDK when enabled. Built-in tool factories live
// in BUILTIN_TOOLS, so coverage for injected tools is explicit.
const CUSTOM_TOOL_NAMES = ["generate_image"] as const;

describe("omp:// root docs coverage", () => {
	it.each([...BUILTIN_TOOL_NAMES])("documents builtin tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(
			present,
			`Missing docs/tools/<name>.md for built-in tool "${name}". Tried: ${candidates.join(", ")}.`,
		).toBeDefined();
	});

	it.each([...CUSTOM_TOOL_NAMES])("documents injected custom tool %s", name => {
		const candidates = expectedDocPaths(name);
		const present = candidates.find(candidate => fs.existsSync(candidate));
		expect(present, `Missing docs/tools/<name>.md for injected custom tool "${name}".`).toBeDefined();
	});
});
