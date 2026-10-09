import * as fs from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import { getLogsDir } from "./dirs";
import * as logger from "./logger";
import { currentLoopPhase } from "./loop-phase";

const MAX_TRACE_BYTES = 128 * 1024;
const MAX_STACK_CHARS = 4096;
const MAX_PHASE_CHARS = 256;

export interface StructuredCloneTraceCall {
	readonly id: number;
	readonly parentId: number | null;
	readonly startedAt: string;
	readonly argumentCount: number;
	readonly inputType: string;
	readonly phase?: string;
	readonly stack: string;
}

export interface StructuredCloneTraceRecord {
	readonly schemaVersion: 1;
	readonly timestamp: string;
	readonly pid: number;
	readonly threadId: number;
	readonly bunVersion: string;
	readonly event: "enabled" | "enter" | "return" | "throw" | "disabled";
	readonly callId?: number;
	readonly elapsedMs?: number;
	/** Restored to the outer call after a nested clone returns. */
	readonly activeCall: StructuredCloneTraceCall | null;
}

export interface StructuredCloneTrace {
	readonly filePath: string;
	dispose(): void;
}

let installedTrace: StructuredCloneTrace | undefined;

/**
 * Opt-in diagnostics, not a replacement for structuredClone. Each native call
 * has a synchronously written breadcrumb before entry: SIGBUS/SIGTRAP/SIGKILL
 * cannot run a JS exception handler or drain an asynchronous logger afterward.
 * Only callsites and primitive metadata are recorded, never argument contents.
 */
export function installStructuredCloneTracing(filePath?: string): StructuredCloneTrace {
	if (installedTrace) return installedTrace;
	const original = globalThis.structuredClone;
	const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
	if (!originalDescriptor) throw new Error("structuredClone is unavailable for tracing");
	const tracePath = path.resolve(
		filePath ?? path.join(getLogsDir(), `san.structured-clone.${process.pid}.${threadId}.${Date.now()}.jsonl`),
	);
	fs.mkdirSync(path.dirname(tracePath), { recursive: true });
	let fileDescriptor: number | undefined = fs.openSync(tracePath, "wx", 0o600);
	let fileOffset = 0;
	let sequence = 0;
	let recording = false;
	let activeCall: StructuredCloneTraceCall | null = null;

	function close(): void {
		const descriptor = fileDescriptor;
		if (descriptor === undefined) return;
		fileDescriptor = undefined;
		try {
			if (globalThis.structuredClone === traced) {
				Object.defineProperty(globalThis, "structuredClone", originalDescriptor!);
			}
		} catch {
			// A host may have frozen the global meanwhile. The closed proxy
			// still forwards directly to the original native function.
		}
		process.off("exit", trace.dispose);
		if (installedTrace === trace) installedTrace = undefined;
		try {
			fs.closeSync(descriptor);
		} catch {}
	}

	function append(event: StructuredCloneTraceRecord["event"], callId?: number, elapsedMs?: number): void {
		const descriptor = fileDescriptor;
		if (descriptor === undefined || recording) return;
		recording = true;
		try {
			const record: StructuredCloneTraceRecord = {
				schemaVersion: 1,
				timestamp: new Date().toISOString(),
				pid: process.pid,
				threadId,
				bunVersion: Bun.version,
				event,
				callId,
				elapsedMs,
				activeCall,
			};
			const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
			if (bytes.byteLength > MAX_TRACE_BYTES) throw new Error("structuredClone trace record exceeds its byte limit");
			if (fileOffset + bytes.byteLength > MAX_TRACE_BYTES) {
				fs.ftruncateSync(descriptor, 0);
				fileOffset = 0;
			}
			let offset = 0;
			while (offset < bytes.byteLength) {
				const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset, fileOffset + offset);
				if (written === 0) throw new Error("structuredClone trace write made no progress");
				offset += written;
			}
			fileOffset += bytes.byteLength;
		} catch (error) {
			close();
			try {
				logger.warn("Native structuredClone tracing disabled after a write failure", {
					filePath: tracePath,
					error: String(error),
				});
			} catch {}
		} finally {
			recording = false;
		}
	}

	const traced = new Proxy(original, {
		apply(target, thisArg: unknown, args: unknown[]) {
			// Stack formatters/log sinks can themselves clone. Do not recursively
			// trace diagnostic work, but retain real nesting inside input getters.
			if (recording || fileDescriptor === undefined) return Reflect.apply(target, thisArg, args);
			const parent = activeCall;
			const started = performance.now();
			const id = ++sequence;
			let stack = "<stack unavailable>";
			let inputType: string = typeof args[0];
			recording = true;
			try {
				const captured = new Error().stack;
				if (typeof captured === "string") stack = captured.slice(0, MAX_STACK_CHARS);
				if (args.length === 0) inputType = "missing";
				else if (args[0] === null) inputType = "null";
				else if (Array.isArray(args[0])) inputType = "array";
			} catch {
				// In particular, inspecting a revoked Proxy must not replace the
				// native clone's own exception or invoke any input properties.
			} finally {
				recording = false;
			}
			activeCall = {
				id,
				parentId: parent?.id ?? null,
				startedAt: new Date().toISOString(),
				argumentCount: args.length,
				inputType,
				phase: currentLoopPhase()?.slice(0, MAX_PHASE_CHARS),
				stack,
			};
			append("enter", id);
			let outcome: "return" | "throw" = "throw";
			try {
				const result = Reflect.apply(target, thisArg, args);
				outcome = "return";
				return result;
			} finally {
				activeCall = parent;
				append(outcome, id, performance.now() - started);
			}
		},
	});
	const trace: StructuredCloneTrace = {
		filePath: tracePath,
		dispose() {
			append("disabled");
			close();
		},
	};
	try {
		Object.defineProperty(globalThis, "structuredClone", { ...originalDescriptor, value: traced });
	} catch (error) {
		close();
		throw error;
	}
	installedTrace = trace;
	process.once("exit", trace.dispose);
	append("enabled");
	if (fileDescriptor === undefined) throw new Error(`Cannot write native structuredClone trace: ${tracePath}`);
	logger.info("Native structuredClone tracing enabled", { filePath: tracePath, maxBytes: MAX_TRACE_BYTES });
	return trace;
}
