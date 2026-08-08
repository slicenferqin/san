import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import * as themeModule from "@san/coding-agent/modes/theme/theme";
import { ToolChoiceQueue } from "@san/coding-agent/session/tool-choice-queue";
import { createTools, type Tool, type ToolSession } from "@san/coding-agent/tools";
import { writeToolRenderer } from "@san/coding-agent/tools/write";
import { XdevRegistry } from "@san/coding-agent/tools/xdev";
import { removeWithRetries } from "@san/utils";
import { type } from "arktype";

// xdev mounting is default-on: discoverable tools like ast_edit unmount into
// xd://, and a plain `write xd://ast_edit` dispatches them. These guard the
// resolution-device symbols write.ts pulls from ./resolve — a missing import
// threw `ReferenceError: isResolutionDeviceName is not defined` on *every*
// xd:// write, in both the executor (approval + execute) and the streaming
// renderer (surfacing as the error text inside a generic Write frame).
function xdevSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		...overrides,
	};
}

describe("read and write route xd:// device URLs", () => {
	it("lists, documents, and dispatches an ast_edit device", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				xdevSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
			);
			// xdev on: ast_edit is unmounted into xd://; write stays in the toolset.
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			expect(read).toBeDefined();
			expect(write).toBeDefined();
			expect(tools.some(entry => entry.name === "ast_edit")).toBe(false);

			const listing = await read!.execute("read-xd-list", { path: "xd://" });
			expect(listing.content.find(entry => entry.type === "text")?.text).toContain("xd://ast_edit");
			const docs = await read!.execute("read-xd-docs", { path: "xd://ast_edit" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# ast_edit");

			const content = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});

			// The write gate decodes the device payload and evaluates the mounted
			// tool's own approval. ast_edit is write-tier for a filesystem path.
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval === "function") {
				expect(approval({ path: "xd://ast_edit", content })).toBe("write");
			}

			// Execute dispatches through the xdev registry to the mounted ast_edit,
			// staging a preview (not a direct apply).
			const previewResult = await write!.execute("write-xdev-preview", { path: "xd://ast_edit", content });
			expect(previewResult.isError).toBeUndefined();
			expect(previewResult.details?.xdev?.tool).toBe("ast_edit");
			expect(previewResult.details?.xdev?.mode).toBe("execute");
			const previewText = previewResult.content.find(entry => entry.type === "text")?.text ?? "";
			expect(previewText).toContain("modernWrap");

			// The staged preview applies through the resolve queue and rewrites disk.
			const invoker = queue.peekPendingInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply xdev ast edit" });
			expect(await Bun.file(filePath).text()).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves function-valued device approvals per payload and fails closed on bad content", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-approval-"));
		try {
			const filePath = path.join(tempDir, "target.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const tools = await createTools(xdevSession(tempDir));
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval !== "function") throw new Error("expected a function approval");
			const tier = (path: string, content: string) => approval({ path, content });

			// ast_edit on a filesystem path → write; on internal URLs only → read.
			const astFsPath = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			const astInternalPath = JSON.stringify({
				ops: [{ pat: "a", out: "b" }],
				paths: ["artifact://abc"],
			});
			expect(tier("xd://ast_edit", astFsPath)).toBe("write");
			expect(tier("xd://ast_edit", astInternalPath)).toBe("read");

			// debug: inspection action → read; a real launch → exec (control).
			expect(tier("xd://debug", JSON.stringify({ action: "sessions" }))).toBe("read");
			expect(tier("xd://debug", JSON.stringify({ action: "launch", program: "./app" }))).toBe("exec");

			// Fail closed: malformed JSON, non-object or schema-invalid payloads,
			// missing content, and unknown devices all stay exec so the gate never
			// under-prompts.
			expect(tier("xd://ast_edit", "{ not json")).toBe("exec");
			expect(tier("xd://ast_edit", "[1,2,3]")).toBe("exec");
			expect(tier("xd://ast_edit", '"a string"')).toBe("exec");
			expect(tier("xd://ast_edit", JSON.stringify({ paths: [null] }))).toBe("exec");
			expect(approval({ path: "xd://ast_edit" })).toBe("exec");
			expect(tier("xd://no_such_device", "{}")).toBe("exec");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("renderCall withholds a partial xd:// URL, then delegates once settled", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const options = { expanded: false, isPartial: true };

		const content = JSON.stringify({
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["/tmp/legacy.ts"],
		});

		// Path still streaming (no content field yet): render nothing so the user
		// never sees a half-typed "xd://ast_" frame.
		expect(writeToolRenderer.renderCall({ path: "xd://ast_e" }, options, uiTheme)).toBeUndefined();

		// Path settled + content streaming: delegate to the mounted tool's renderer
		// instead of throwing ReferenceError inside a generic Write frame.
		const rendered = writeToolRenderer.renderCall({ path: "xd://ast_edit", content }, options, uiTheme);
		expect(rendered).toBeDefined();
	});

	it("docsAll inlines small device docs and falls back to a listing past the caps", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-docs-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const mounted = session.xdevRegistry?.list() ?? [];
			expect(mounted.length).toBeGreaterThan(0);

			// One device with a pathological description must fall back to the
			// listing without starving the rest of the catalog.
			const giant = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(giant, "name", { value: "giant_mcp_tool" });
			Object.defineProperty(giant, "description", { value: "x".repeat(XdevRegistry.DOCS_PER_DEVICE_CAP + 1) });
			const registry = new XdevRegistry([...mounted, giant]);

			const docs = registry.docsAll();
			expect(docs.length).toBeLessThan(XdevRegistry.DOCS_TOTAL_BUDGET + XdevRegistry.DOCS_PER_DEVICE_CAP);
			expect(docs).toContain(`## ${mounted[0]!.name}`);
			expect(docs).toContain("## Additional devices (docs on demand)");
			expect(docs).toContain("- xd://giant_mcp_tool —");
			expect(docs).not.toContain("## giant_mcp_tool");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("catalog docs mode lists every device without embedding schemas", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-catalog-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const registry = session.xdevRegistry;
			if (!registry) throw new Error("expected xdev registry");

			const docs = registry.docsAll("catalog");
			for (const tool of registry.list()) expect(docs).toContain(`xd://${tool.name}`);
			expect(docs).toContain("Read xd://<tool> for full docs + JSON schema before first use.");
			expect(docs).not.toContain("## Schema");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("supports inline, builtins, catalog, and allowlisted dynamic-device docs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-external-"));
		try {
			const session = xdevSession(tempDir);
			expect(session.settings.get("tools.xdevDocs")).toBe("builtins");
			await createTools(session);
			const registry = session.xdevRegistry;
			if (!registry) throw new Error("expected xdev registry");
			const mounted = registry.list();

			const longDescription = `LEDE ${"y".repeat(XdevRegistry.EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
			const external = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(external, "name", { value: "mcp_external_tool" });
			Object.defineProperty(external, "description", { value: longDescription });
			registry.reconcile([external]);

			const inlineDocs = registry.docsAll("inline");
			expect(inlineDocs).toContain("## mcp_external_tool");
			expect(inlineDocs).toContain("LEDE ");
			expect(inlineDocs).not.toContain("TAIL");
			expect(inlineDocs).toContain("… (full docs: read xd://mcp_external_tool)");

			const builtinsDocs = registry.docsAll("builtins");
			expect(builtinsDocs).toContain(`## ${mounted[0]!.name}`);
			expect(builtinsDocs).not.toContain("## mcp_external_tool");
			expect(builtinsDocs).toContain("- xd://mcp_external_tool —");

			const catalogDocs = registry.docsAll("catalog");
			expect(catalogDocs).not.toContain(`## ${mounted[0]!.name}`);
			expect(catalogDocs).toContain("- xd://mcp_external_tool —");
			expect(registry.docs("mcp_external_tool")).toContain("TAIL");

			const contextMode = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(contextMode, "name", { value: "mcp__context_mode_ctx_execute" });
			const unrelatedMcp = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(unrelatedMcp, "name", { value: "mcp__other_server_execute" });
			registry.reconcile([contextMode, unrelatedMcp]);

			const allowlistedDocs = registry.docsAll("builtins", ["mcp__context_mode_*"]);
			expect(allowlistedDocs).toContain("## mcp__context_mode_ctx_execute");
			expect(allowlistedDocs).not.toContain("## mcp__other_server_execute");
			expect(allowlistedDocs).toContain("- xd://mcp__other_server_execute —");

			const catalogWithAllowlistDocs = registry.docsAll("catalog", ["mcp__context_mode_*"]);
			expect(catalogWithAllowlistDocs).not.toContain("## mcp__context_mode_ctx_execute");

			const scalarAllowlistDocs = registry.docsAll("builtins", "mcp__context_mode_*" as never);
			expect(scalarAllowlistDocs).toContain("- xd://mcp__context_mode_ctx_execute —");
			const nonStringAllowlistDocs = registry.docsAll("builtins", [123] as never);
			expect(nonStringAllowlistDocs).toContain("- xd://mcp__context_mode_ctx_execute —");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("bounds dynamic summaries in UTF-8 bytes and strips structural controls", () => {
		const multiByteTail = "あ".repeat(XdevRegistry.EXTERNAL_DESCRIPTION_CAP);
		const builtInDevice: Tool = {
			name: "weather",
			label: "Weather",
			description: "Weather for a place.",
			summary: `Gets the weather ${multiByteTail}`,
			parameters: type({ query: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "" }] };
			},
		};
		const dynamicDevice: Tool = {
			...builtInDevice,
			name: "mcp__weather__forecast",
			label: "Forecast",
			summary: `Napoved\u0007\u2028vremena ${multiByteTail}`,
		};
		const registry = new XdevRegistry([builtInDevice]);
		registry.reconcile([dynamicDevice]);
		const entries = new Map(registry.entries().map(entry => [entry.name, entry]));

		const dynamic = entries.get(dynamicDevice.name);
		if (!dynamic) throw new Error("expected dynamic device entry");
		expect(dynamic.dynamic).toBe(true);
		expect(dynamic.summary.startsWith("Napoved vremena ")).toBe(true);
		expect(dynamic.summary.endsWith("…")).toBe(true);
		const summaryBytes = Buffer.byteLength(dynamic.summary, "utf-8");
		expect(summaryBytes).toBeLessThanOrEqual(XdevRegistry.EXTERNAL_DESCRIPTION_CAP);
		expect(summaryBytes).toBeGreaterThan(XdevRegistry.EXTERNAL_DESCRIPTION_CAP - 6);
		expect(dynamic.summary).not.toContain("�");

		const builtIn = entries.get(builtInDevice.name);
		if (!builtIn) throw new Error("expected built-in device entry");
		expect(builtIn.dynamic).toBe(false);
		expect(builtIn.summary).toBe(`Gets the weather ${multiByteTail}`);
	});

	it("forwards mounted-device progress through the xd:// envelope", async () => {
		const updates: AgentToolResult<unknown>[] = [];
		const streamingDevice: Tool = {
			name: "streaming_device",
			label: "Streaming device",
			description: "Streams a preview before completion",
			loadMode: "discoverable",
			parameters: type({ value: "string" }),
			strict: true,
			async execute(_toolCallId, args, _signal, onUpdate) {
				onUpdate?.({
					content: [{ type: "text", text: `preview:${args.value}` }],
					details: { phase: "preview" },
				});
				return {
					content: [{ type: "text", text: `done:${args.value}` }],
					details: { phase: "done" },
				};
			},
		};
		const registry = new XdevRegistry([]);
		registry.reconcile([streamingDevice]);

		const dispatch = await registry.dispatch(
			streamingDevice.name,
			JSON.stringify({ value: "payload" }),
			"streaming-call",
			undefined,
			update => updates.push(update),
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content).toEqual([{ type: "text", text: "preview:payload" }]);
		expect(updates[0]?.details).toMatchObject({
			xdev: {
				tool: streamingDevice.name,
				mode: "execute",
				args: { value: "payload" },
				inner: { phase: "preview" },
			},
		});
		expect(dispatch.result.content).toEqual([{ type: "text", text: "done:payload" }]);
		expect(dispatch.xdev.inner).toEqual({ phase: "done" });
	});

	it("keeps discoverable tools top-level when write was not granted", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-grant-"));
		try {
			const session = xdevSession(tempDir, { strictToolNames: true });
			const tools = await createTools(session, ["read", "ast_edit"]);

			expect(tools.map(tool => tool.name)).toContain("ast_edit");
			expect(tools.map(tool => tool.name)).not.toContain("write");
			expect(session.xdevRegistry).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
