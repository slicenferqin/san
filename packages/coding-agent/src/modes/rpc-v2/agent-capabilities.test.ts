import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcpCapability, deleteMemory, listMcpCapabilities, removeMcpCapability } from "./agent-capabilities";

describe("agent capability handlers", () => {
	test("MCP add/list/remove round trip in a project config", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "san-rpc-g5-"));
		try {
			const configDir = join(cwd, ".san");
			await writeFile(join(cwd, ".gitkeep"), "");
			await addMcpCapability(cwd, "roundtrip", { command: "bun", args: ["run", "server.ts"] }, "project");
			const listed = await listMcpCapabilities(cwd, "project");
			expect(listed.items).toEqual([
				{
					name: "roundtrip",
					scope: "project",
					config: { command: "bun", args: ["run", "server.ts"] },
					enabled: true,
				},
			]);
			await removeMcpCapability(cwd, "roundtrip", "project");
			expect((await listMcpCapabilities(cwd, "project")).items).toEqual([]);
			void configDir;
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	test("memory delete reports a not-found result", async () => {
		expect(await deleteMemory("definitely-missing-memory-id")).toBe(false);
	});

	test("memory delete reports a not-found result", async () => {
		const { deleteMemory } = await import("./agent-capabilities");
		expect(await deleteMemory("definitely-missing-memory-id")).toBe(false);
	});
});
