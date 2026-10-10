import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@san/utils/fs-error";
import type { StructuredCloneTraceRecord } from "@san/utils/structured-clone-trace";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const TRACE_MODULE = path.resolve(import.meta.dir, "../../utils/src/structured-clone-trace.ts");
const PHASE_MODULE = path.resolve(import.meta.dir, "../../utils/src/loop-phase.ts");
const MAIN_MODULE = path.resolve(import.meta.dir, "../src/main.ts");

interface ProbeTrace {
	text: string;
	bytes: number;
	records: StructuredCloneTraceRecord[];
}

interface ProbeResult {
	exitCode: number;
	signal: string | null;
	stdout: string;
	stderr: string;
	traces: ProbeTrace[];
}

/** Globals, environment, and abrupt termination stay inside one disposable process. */
async function runProbe(body: string, enabled = false): Promise<ProbeResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "san-clone-trace-test-"));
	const logDir = path.join(root, ".san", "logs");
	const probePath = path.join(root, "probe.ts");
	try {
		await Bun.write(
			probePath,
			[
				'import assert from "node:assert/strict";',
				`import { installStructuredCloneTracing } from ${JSON.stringify(TRACE_MODULE)};`,
				`import { pushLoopPhase, popLoopPhase } from ${JSON.stringify(PHASE_MODULE)};`,
				body,
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HOME: root,
				SAN_PROFILE: "",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				SAN_CODING_AGENT_DIR: path.join(root, ".san", "agent"),
				PI_CODING_AGENT_DIR: path.join(root, ".san", "agent"),
				XDG_STATE_HOME: path.join(root, "xdg-state"),
				XDG_DATA_HOME: path.join(root, "xdg-data"),
				XDG_CACHE_HOME: path.join(root, "xdg-cache"),
				SAN_TRACE_STRUCTURED_CLONE: enabled ? "1" : "0",
				TRACE_FILE: path.join(logDir, "probe.structured-clone.jsonl"),
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
		});
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
				proc.exited,
			]);
			let names: string[];
			try {
				names = await fs.readdir(logDir);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				names = [];
			}
			const traces = await Promise.all(
				names
					.filter(name => name.includes("structured-clone") && name.endsWith(".jsonl"))
					.map(async name => {
						const file = Bun.file(path.join(logDir, name));
						const text = await file.text();
						return { text, bytes: file.size, records: Bun.JSONL.parse(text) as StructuredCloneTraceRecord[] };
					}),
			);
			return { exitCode, signal: proc.signalCode, stdout, stderr, traces };
		} finally {
			if (proc.exitCode === null) {
				proc.kill();
				await proc.exited;
			}
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function latestTrace(result: ProbeResult): ProbeTrace {
	expect(result.traces).toHaveLength(1);
	return result.traces[0]!;
}

describe("native structuredClone diagnostics", () => {
	it("preserves native graph, transfer, getter, and exception behavior without logging values", async () => {
		const result = await runProbe(`
			const original = globalThis.structuredClone;
			const trace = installStructuredCloneTracing(process.env.TRACE_FILE);
			let getterReads = 0;
			let tagReads = 0;
			const shared = { value: 7 };
			const input = {
				secret: "PRIVATE_PAYLOAD_NOT_FOR_LOGS",
				left: shared,
				right: shared,
				map: new Map([[shared, shared]]),
				set: new Set([shared]),
				date: new Date(123),
				self: null,
				get nested() {
					getterReads++;
					return structuredClone({ ready: true });
				},
			};
			input.self = input;
			Object.defineProperty(input, Symbol.toStringTag, {
				get() { tagReads++; return "PRIVATE_TAG_NOT_FOR_LOGS"; },
			});
			pushLoopPhase("probe:outer");
			const copy = structuredClone(input);
			popLoopPhase();
			assert.notEqual(copy, input);
			assert.equal(copy.self, copy);
			assert.equal(copy.left, copy.right);
			assert.equal(copy.map.get(copy.left), copy.left);
			assert.equal(copy.set.has(copy.left), true);
			assert.equal(copy.date.getTime(), 123);
			assert.equal(copy.nested.ready, true);
			assert.equal(getterReads, 1);
			assert.equal(tagReads, 0);
			const buffer = new ArrayBuffer(8);
			new Uint8Array(buffer)[0] = 37;
			const transferred = structuredClone({ buffer }, { transfer: [buffer] });
			assert.equal(buffer.byteLength, 0);
			assert.equal(new Uint8Array(transferred.buffer)[0], 37);
			const originalError = new Error("PRIVATE_ERROR_NOT_FOR_LOGS");
			let caught;
			try { structuredClone({ get broken() { throw originalError; } }); }
			catch (error) { caught = error; }
			assert.equal(caught, originalError);
			assert.throws(() => structuredClone(() => 1), { name: "DataCloneError" });
			assert.throws(() => Reflect.apply(structuredClone, undefined, []), { name: "TypeError" });
			assert.throws(() => Reflect.construct(structuredClone, [{}]), { name: "TypeError" });
			assert.equal(structuredClone.length, original.length);
			assert.equal(structuredClone.name, original.name);
			trace.dispose();
			assert.equal(globalThis.structuredClone, original);
		`);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		const trace = latestTrace(result);
		expect(trace.text).not.toContain("PRIVATE_PAYLOAD_NOT_FOR_LOGS");
		expect(trace.text).not.toContain("PRIVATE_TAG_NOT_FOR_LOGS");
		expect(trace.text).not.toContain("PRIVATE_ERROR_NOT_FOR_LOGS");
		const nestedEnter = trace.records.find(record => record.event === "enter" && record.activeCall?.parentId != null);
		expect(nestedEnter?.activeCall?.phase).toBe("probe:outer");
		const nestedReturn = trace.records.find(
			record => record.event === "return" && record.callId === nestedEnter?.callId,
		);
		expect(nestedReturn?.activeCall?.id ?? null).toBe(nestedEnter?.activeCall?.parentId ?? null);
		expect(trace.records.some(record => record.event === "throw" && record.activeCall === null)).toBe(true);
		expect(trace.records.at(-1)?.activeCall).toBeNull();
	});

	it("bounds retained output while keeping the latest call readable", async () => {
		const result = await runProbe(`
			const trace = installStructuredCloneTracing(process.env.TRACE_FILE);
			for (let i = 0; i < 1200; i++) structuredClone({ index: i });
			trace.dispose();
		`);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		const trace = latestTrace(result);
		expect(trace.bytes).toBeLessThanOrEqual(128 * 1024);
		const lastEnter = trace.records.findLast(record => record.event === "enter");
		const lastReturn = trace.records.findLast(record => record.event === "return");
		expect(lastReturn?.callId).toBe(lastEnter?.callId);
		expect(lastReturn?.activeCall).toBeNull();
	});

	for (const enabled of [false, true]) {
		it(`application startup ${enabled ? "retains" : "does not enable"} clone breadcrumbs after an uncatchable kill`, async () => {
			const result = await runProbe(
				`
					import { runRootCommand } from ${JSON.stringify(MAIN_MODULE)};
					function cloneFromKnownCallsite() {
						structuredClone({
							get terminate() {
								structuredClone({ nested: true });
								process.kill(process.pid, "SIGKILL");
								return true;
							},
						});
						throw new Error("Expected process termination inside native clone");
					}
					await runRootCommand({ messages: [], fileArgs: [], print: true, mode: "json" }, [], {
						discoverAuthStorage: async () => {
							pushLoopPhase("probe:native-clone");
							cloneFromKnownCallsite();
							throw new Error("unreachable");
						},
					});
				`,
				enabled,
			);
			expect(result.stderr).toBe("");
			expect(result.signal).toBe("SIGKILL");
			if (!enabled) {
				expect(result.traces).toHaveLength(0);
				return;
			}
			const trace = latestTrace(result);
			// The inner clone completed; the outer native invocation is still active.
			const last = trace.records.at(-1);
			expect(last?.event).toBe("return");
			expect(last?.activeCall?.id).toBeDefined();
			expect(last?.callId).not.toBe(last?.activeCall?.id);
			expect(last?.activeCall?.parentId).toBeNull();
			expect(last?.activeCall?.inputType).toBe("object");
			expect(last?.activeCall?.phase).toBe("probe:native-clone");
			expect(last?.activeCall?.stack).toContain("cloneFromKnownCallsite");
			expect(last?.activeCall?.stack).toContain("probe.ts:");
			expect(trace.records.some(record => record.callId === last?.activeCall?.id && record.event === "return")).toBe(
				false,
			);
		}, 30_000);
	}
});
