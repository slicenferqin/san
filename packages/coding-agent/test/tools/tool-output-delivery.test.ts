/**
 * Delivery contracts for wrapped tool results: when the central output wrapper
 * shrinks a result to fit the visible budget, everything the model needs must
 * still be reachable — real bytes through a stable artifact reference, a
 * mutation that ran exactly once, truthful error identity, and no cross-session
 * id leakage.
 *
 * These exercise real `SessionManager` instances, real artifact files on disk
 * and the real `ReadTool` recovery path, because the contracts are about the
 * bytes that survive the round trip.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, type AgentToolContext, countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@san/coding-agent/internal-urls/registry-helpers";
import { SessionManager } from "@san/coding-agent/session/session-manager";
import type { ToolSession } from "@san/coding-agent/tools";
import { stripOutputNotice, wrapToolWithMetaNotice } from "@san/coding-agent/tools/output-meta";
import { ReadTool } from "@san/coding-agent/tools/read";
import { ToolError } from "@san/coding-agent/tools/tool-errors";
import { removeWithRetries } from "@san/utils";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function bodyOf(result: {
	content: Array<{ type: string; text?: string }>;
	details?: { meta?: { truncation?: unknown } };
}): string {
	return stripOutputNotice(getTextOutput(result), result.details?.meta as never);
}

/** A session facade over a real `SessionManager`, shaped like the CLI's. */
function sessionFor(manager: SessionManager, settings: Settings): ToolSession {
	return {
		cwd: manager.getCwd(),
		hasUI: false,
		getSessionFile: () => manager.getSessionFile() ?? path.join(os.tmpdir(), "none.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => manager.getArtifactsDir(),
		allocateOutputArtifact: async (toolType: string) => (await manager.allocateArtifactPath(toolType)) as never,
		getArtifactManager: () => manager.getArtifactManager(),
		settings,
		enableLsp: false,
		localProtocolOptions: { getArtifactsDir: () => manager.getArtifactsDir() },
	} as unknown as ToolSession;
}

function contextFor(manager: SessionManager, settings: Settings, scope: string): AgentToolContext {
	return {
		settings,
		sessionManager: manager,
		executionScopeId: scope,
		model: { contextWindow: 100_000 },
		localProtocolOptions: { getArtifactsDir: () => manager.getArtifactsDir() },
	} as unknown as AgentToolContext;
}

function bashLikeTool(text: () => string): AgentTool {
	return wrapToolWithMetaNotice({
		name: "bash",
		execute: async () => ({ content: [{ type: "text", text: text() }] }),
	} as unknown as AgentTool);
}

/**
 * Spill a payload, then walk the whole thing back out of its artifact with real
 * `ReadTool` calls. Every page must carry content and must not itself be
 * projected down (a page that spills again is the recursive-empty-result
 * failure mode), and the concatenation must be the saved bytes verbatim.
 */
async function recoverAllPages(
	manager: SessionManager,
	settings: Settings,
	scope: string,
	artifactId: string,
	totalLines: number,
	pageLines: number,
): Promise<string> {
	const readTool = wrapToolWithMetaNotice(new ReadTool(sessionFor(manager, settings)));
	const context = contextFor(manager, settings, scope);
	const pages: string[] = [];
	for (let start = 1; start <= totalLines; start += pageLines) {
		const end = Math.min(start + pageLines - 1, totalLines);
		const result = await readTool.execute(
			`page-${start}`,
			{ path: `artifact://${artifactId}:raw:${start}-${end}` },
			undefined,
			undefined,
			context,
		);
		const body = bodyOf(result);
		expect(body.length).toBeGreaterThan(0);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
		pages.push(body);
	}
	return pages.join("\n");
}

/**
 * The visible budget this suite pins: a result over `artifactSpillThreshold`
 * spills, and the preview that stays inline is bounded by `min(threshold,
 * head+tail bytes)` and the token budget — 8 KB / 4 000 tokens here. Recovery
 * pages are therefore sized to fit comfortably inside it, so a page that
 * disappears can only mean the delivery path projected a page of an artifact.
 */
const SPILL_SETTINGS = {
	"tools.artifactSpillThreshold": 16,
	"tools.artifactHeadBytes": 4,
	"tools.artifactTailBytes": 4,
	"tools.artifactTailLines": 50,
	"tools.outputPreviewTokens": 4_000,
};

/** `${label} NNNN: ` followed by padding, so every payload line has a stable width. */
function rows(count: number, label: string, padding = 50): string {
	return Array.from(
		{ length: count },
		(_, index) => `${label} ${String(index + 1).padStart(4, "0")}: ${"x".repeat(padding)}`,
	).join("\n");
}

let root: string;
let persistentDirs: string[] = [];

async function newPersistentManager(name: string): Promise<SessionManager> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	return SessionManager.create(path.join(root, `cwd-${name}`), dir);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	resetRegisteredArtifactDirsForTests();
	persistentDirs = [];
});

describe("wrapped tool result delivery", () => {
	it("recovers exactly the saved bytes across 24+ successive pages of one stable artifact", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-pages-"));
		const manager = await newPersistentManager("pages");
		persistentDirs.push(root);
		const settings = Settings.isolated(SPILL_SETTINGS);
		const context = contextFor(manager, settings, "pages");
		const original = rows(3_000, "record", 50);
		const originalLines = original.split("\n");

		const spilled = await bashLikeTool(() => original).execute("spill", {}, undefined, undefined, context);
		const artifactId = spilled.details?.meta?.truncation?.artifactId;
		expect(typeof artifactId).toBe("string");
		if (typeof artifactId !== "string") return;
		expect(getTextOutput(spilled)).toContain(`artifact://${artifactId}`);
		expect(countTokens(bodyOf(spilled))).toBeLessThanOrEqual(SPILL_SETTINGS["tools.outputPreviewTokens"]);

		// Projecting the result must not have changed the saved bytes.
		const artifactsDir = manager.getArtifactsDir() as string;
		expect(await Bun.file(path.join(artifactsDir, `${artifactId}.bash.log`)).text()).toBe(original);

		// 30 successive pages, each bounded, each with real content, all through
		// the same stable reference instead of a chain of fresh artifacts.
		expect(await recoverAllPages(manager, settings, "pages", artifactId, originalLines.length, 100)).toBe(original);
		expect(await fs.readdir(artifactsDir)).toEqual([`${artifactId}.bash.log`]);

		// One oversized page still resolves to the same artifact and is bounded
		// by the visible budget rather than duplicating the payload.
		const readTool = wrapToolWithMetaNotice(new ReadTool(sessionFor(manager, settings)));
		const big = await readTool.execute(
			"big-page",
			{ path: `artifact://${artifactId}:raw:1-400` },
			undefined,
			undefined,
			context,
		);
		const bigBody = bodyOf(big);
		expect(bigBody.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(bigBody, "utf-8")).toBeLessThan(Buffer.byteLength(original, "utf-8"));
		expect(big.details?.meta?.truncation?.artifactId).toBe(artifactId);
		expect(getTextOutput(big)).toContain(`artifact://${artifactId}`);
		expect(await fs.readdir(artifactsDir)).toEqual([`${artifactId}.bash.log`]);
	});

	it("executes a filesystem mutation once and replays its confirmation from the artifact", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-side-effect-"));
		const manager = await newPersistentManager("side-effect");
		persistentDirs.push(root);
		const settings = Settings.isolated(SPILL_SETTINGS);
		const context = contextFor(manager, settings, "side-effect");
		const target = path.join(root, "written-once.txt");
		const stored = `${rows(600, "apply step", 30)}\nwrote ${target}`;

		let runs = 0;
		const tool = wrapToolWithMetaNotice({
			name: "bash",
			execute: async () => {
				runs++;
				await Bun.write(target, "written once\n");
				return { content: [{ type: "text", text: stored }] };
			},
		} as unknown as AgentTool);

		const first = await tool.execute("mutate", {}, undefined, undefined, context);
		expect(runs).toBe(1);
		expect(await Bun.file(target).text()).toBe("written once\n");
		const artifactId = first.details?.meta?.truncation?.artifactId;
		expect(typeof artifactId).toBe("string");
		if (typeof artifactId !== "string") return;

		// The confirmation comes back from the stored bytes, never by re-running.
		expect(await recoverAllPages(manager, settings, "side-effect", artifactId, stored.split("\n").length, 120)).toBe(
			stored,
		);
		expect(runs).toBe(1);
		expect(await Bun.file(target).text()).toBe("written once\n");
	});

	it("keeps thrown failures, returned errors and partial failures truthful and recoverable", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-errors-"));
		const manager = await newPersistentManager("errors");
		persistentDirs.push(root);
		const settings = Settings.isolated(SPILL_SETTINGS);

		// A thrown error surfaces its rendered, locating text — the wrapper must
		// not swallow it into a sanitized generic message.
		const throwing = wrapToolWithMetaNotice({
			name: "read",
			execute: async () => {
				throw new ToolError("E_DELIVERY_ANCHOR: could not resolve line 41 of report.txt", { line: 41 });
			},
		} as unknown as AgentTool);
		await expect(
			throwing.execute("boom", {}, undefined, undefined, contextFor(manager, settings, "boom")),
		).rejects.toThrow(/E_DELIVERY_ANCHOR: could not resolve line 41 of report\.txt/);

		// A returned error keeps its error identity, and its full text stays
		// byte-exactly recoverable through the artifact.
		const failureText = rows(240, "failed record: E_PARTIAL_FAILURE detail", 150);
		const failing = wrapToolWithMetaNotice({
			name: "bash",
			execute: async () => ({ isError: true, content: [{ type: "text", text: failureText }] }),
		} as unknown as AgentTool);
		const failure = await failing.execute(
			"partial",
			{},
			undefined,
			undefined,
			contextFor(manager, settings, "partial"),
		);
		expect(failure.isError).toBe(true);
		const failureArtifact = failure.details?.meta?.truncation?.artifactId;
		expect(typeof failureArtifact).toBe("string");
		if (typeof failureArtifact !== "string") return;
		expect(getTextOutput(failure)).toContain(`artifact://${failureArtifact}`);
		expect(
			await recoverAllPages(manager, settings, "partial", failureArtifact, failureText.split("\n").length, 30),
		).toBe(failureText);

		// Ordinary truncation is not an error: the successful result stays a
		// success and still points at its recoverable bytes.
		const ok = await bashLikeTool(() => rows(600, "ok", 50)).execute(
			"ok",
			{},
			undefined,
			undefined,
			contextFor(manager, settings, "ok"),
		);
		expect(ok.isError).toBeUndefined();
		expect(typeof ok.details?.meta?.truncation?.artifactId).toBe("string");
	});

	it("keeps the only copy of the text when artifact capture rejects or returns nothing", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-save-failure-"));
		persistentDirs.push(root);
		const settings = Settings.isolated(SPILL_SETTINGS);
		const recovery = rows(120, "E_RECOVERY_READY: the only copy of diagnostic", 40);

		for (const saveArtifact of [
			async () => {
				throw new Error("disk full");
			},
			async () => undefined,
		]) {
			const context = contextFor({ saveArtifact } as unknown as SessionManager, settings, "save-failure");
			const result = await bashLikeTool(() => recovery).execute("recover", {}, undefined, undefined, context);
			expect(result.details?.meta?.truncation).toBeUndefined();
			expect(getTextOutput(result)).toBe(recovery);
			expect(getTextOutput(result)).not.toContain("artifact://");
		}
	});

	it("never resolves one session's numeric artifact id against another, and survives adopt/resume", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-session-isolation-"));
		const managerA = await newPersistentManager("session-a");
		const managerB = await newPersistentManager("session-b");
		persistentDirs.push(root);
		const settings = Settings.isolated(SPILL_SETTINGS);
		const originalA = rows(400, "SESSION-A-ORIGINAL", 40);
		const originalB = rows(400, "SESSION-B-ORIGINAL", 40);

		const spilledA = await bashLikeTool(() => originalA).execute(
			"spill-a",
			{},
			undefined,
			undefined,
			contextFor(managerA, settings, "a"),
		);
		const spilledB = await bashLikeTool(() => originalB).execute(
			"spill-b",
			{},
			undefined,
			undefined,
			contextFor(managerB, settings, "b"),
		);
		const idA = spilledA.details?.meta?.truncation?.artifactId;
		const idB = spilledB.details?.meta?.truncation?.artifactId;
		expect(typeof idA).toBe("string");
		expect(typeof idB).toBe("string");
		if (typeof idA !== "string" || typeof idB !== "string") return;
		expect(managerA.getArtifactsDir()).not.toBe(managerB.getArtifactsDir());

		const readTool = wrapToolWithMetaNotice(new ReadTool(sessionFor(managerA, settings)));
		const fromA = await readTool.execute(
			"read-a",
			{ path: `artifact://${idA}:raw:1-5` },
			undefined,
			undefined,
			contextFor(managerA, settings, "a"),
		);
		expect(bodyOf(fromA)).toBe(originalA.split("\n").slice(0, 5).join("\n"));
		expect(bodyOf(fromA)).not.toContain("SESSION-B-ORIGINAL");

		// A numeric id absent from this session must not fall through to another
		const missingId = String(Number(idB) + 1000);
		const missing = await readTool
			.execute(
				"read-missing",
				{ path: `artifact://${missingId}:raw:1-2` },
				undefined,
				undefined,
				contextFor(managerA, settings, "missing"),
			)
			.then(
				result => bodyOf(result),
				error => (error instanceof Error ? error.message : String(error)),
			);
		expect(missing).not.toContain("SESSION-B-ORIGINAL");
		expect(missing).toContain("not found");

		// An adopted manager (subagent layout) resolves the parent's artifacts.
		const adopted = SessionManager.inMemory(path.join(root, "cwd-adopted"));
		const parentArtifacts = managerA.getArtifactManager();
		expect(parentArtifacts).not.toBeNull();
		if (parentArtifacts) adopted.adoptArtifactManager(parentArtifacts);
		expect(adopted.getArtifactsDir()).toBe(managerA.getArtifactsDir());
		const fromAdopted = await wrapToolWithMetaNotice(new ReadTool(sessionFor(adopted, settings))).execute(
			"read-adopted",
			{ path: `artifact://${idA}:raw:1-5` },
			undefined,
			undefined,
			contextFor(adopted, settings, "adopted"),
		);
		expect(bodyOf(fromAdopted)).toBe(originalA.split("\n").slice(0, 5).join("\n"));

		// A restored session keeps the same directory and therefore the reference.
		const sessionFileA = managerA.getSessionFile() as string;
		const resumed = await SessionManager.open(sessionFileA, path.dirname(sessionFileA));
		expect(resumed.getArtifactsDir()).toBe(managerA.getArtifactsDir());
		const fromResumed = await wrapToolWithMetaNotice(new ReadTool(sessionFor(resumed, settings))).execute(
			"read-resumed",
			{ path: `artifact://${idA}:raw:1-5` },
			undefined,
			undefined,
			contextFor(resumed, settings, "resumed"),
		);
		expect(bodyOf(fromResumed)).toBe(originalA.split("\n").slice(0, 5).join("\n"));
	});

	it("delivers content through an ephemeral (non-persisting) session's manager and wrapper", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-ephemeral-"));
		persistentDirs.push(root);
		const manager = SessionManager.inMemory(path.join(root, "cwd-ephemeral"));
		expect(manager.getSessionFile()).toBeUndefined();
		const settings = Settings.isolated(SPILL_SETTINGS);
		const context = contextFor(manager, settings, "ephemeral");
		const original = rows(600, "EPHEMERAL-ORIGINAL", 40);

		const spilled = await bashLikeTool(() => original).execute("ephemeral", {}, undefined, undefined, context);
		const artifactId = spilled.details?.meta?.truncation?.artifactId;
		expect(typeof artifactId).toBe("string");
		if (typeof artifactId !== "string") return;
		expect(bodyOf(spilled).length).toBeGreaterThan(0);
		expect(countTokens(bodyOf(spilled))).toBeLessThanOrEqual(SPILL_SETTINGS["tools.outputPreviewTokens"]);

		expect(await recoverAllPages(manager, settings, "ephemeral", artifactId, original.split("\n").length, 120)).toBe(
			original,
		);
	});

	it("closes an ephemeral session without leaving its artifact directory behind", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-ephemeral-close-"));
		persistentDirs.push(root);
		const manager = SessionManager.inMemory(path.join(root, "cwd-ephemeral-close"));
		const settings = Settings.isolated(SPILL_SETTINGS);
		const spilled = await bashLikeTool(() => rows(400, "CLOSE", 40)).execute(
			"spill",
			{},
			undefined,
			undefined,
			contextFor(manager, settings, "ephemeral-close"),
		);
		const artifactsDir = manager.getArtifactsDir();
		expect(artifactsDir).toBeTypeOf("string");
		expect(typeof spilled.details?.meta?.truncation?.artifactId).toBe("string");

		await manager.close();
		await expect(fs.access(artifactsDir as string)).rejects.toThrow();
		await removeWithRetries(root).catch(() => {});
	});
});
