/**
 * 扩展模块导入可以并行，但 factory 必须按输入顺序串行绑定；导入或 factory
 * 失败只隔离当前扩展，并保留 provider 注册回滚合同。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@san/coding-agent/extensibility/extensions/loader";
import { TempDir } from "@san/utils";

const STATE_KEY = "__sanExtensionLoaderConcurrencyState";

interface ConcurrencyState {
	events: string[];
	slowImportGate: Promise<void>;
	slowFactoryGate: Promise<void>;
	markFastImported: () => void;
	markSlowImportStarted: () => void;
	markSlowFactoryStarted: () => void;
}

interface ExtensionLoaderGlobal {
	__sanExtensionLoaderConcurrencyState?: ConcurrencyState;
}

const extensionGlobal = globalThis as ExtensionLoaderGlobal;

describe("extension loader concurrency", () => {
	let project: TempDir | undefined;

	beforeEach(() => {
		project = TempDir.createSync("@san-ext-concurrency-");
	});

	afterEach(() => {
		project?.removeSync();
		project = undefined;
		delete extensionGlobal[STATE_KEY];
	});

	async function writeModule(relativePath: string, source: string): Promise<string> {
		expect(project).toBeDefined();
		const filePath = path.join(project!.path(), relativePath);
		await Bun.write(filePath, source);
		return filePath;
	}

	it("imports concurrently while binding factories sequentially in input order", async () => {
		const slowImport = Promise.withResolvers<void>();
		const slowFactory = Promise.withResolvers<void>();
		const fastImported = Promise.withResolvers<void>();
		const slowImportStarted = Promise.withResolvers<void>();
		const slowFactoryStarted = Promise.withResolvers<void>();
		extensionGlobal[STATE_KEY] = {
			events: [],
			slowImportGate: slowImport.promise,
			slowFactoryGate: slowFactory.promise,
			markFastImported: fastImported.resolve,
			markSlowImportStarted: slowImportStarted.resolve,
			markSlowFactoryStarted: slowFactoryStarted.resolve,
		};

		const slowPath = await writeModule(
			"slow.js",
			`const state = globalThis.${STATE_KEY};
state.events.push("slow:import:start");
state.markSlowImportStarted();
await state.slowImportGate;
state.events.push("slow:import:end");
export default async function slowExtension() {
	state.events.push("slow:factory:start");
	state.markSlowFactoryStarted();
	await state.slowFactoryGate;
	state.events.push("slow:factory:end");
}
`,
		);
		const fastPath = await writeModule(
			"fast.js",
			`const state = globalThis.${STATE_KEY};
state.events.push("fast:import");
state.markFastImported();
export default function fastExtension() {
	state.events.push("fast:factory");
}
`,
		);

		const loading = loadExtensions([slowPath, fastPath], project!.path());
		await Promise.all([slowImportStarted.promise, fastImported.promise]);

		const state = extensionGlobal[STATE_KEY]!;
		expect(state.events).toContain("slow:import:start");
		expect(state.events).toContain("fast:import");
		expect(state.events).not.toContain("slow:import:end");
		expect(state.events.some(event => event.includes(":factory"))).toBe(false);

		slowImport.resolve();
		await slowFactoryStarted.promise;
		expect(state.events).not.toContain("fast:factory");

		slowFactory.resolve();
		const result = await loading;

		expect(result.errors).toEqual([]);
		expect(result.extensions.map(extension => extension.path)).toEqual([slowPath, fastPath]);
		expect(state.events.indexOf("slow:factory:end")).toBeLessThan(state.events.indexOf("fast:factory"));
	});

	it("isolates an import failure without blocking later factory binding", async () => {
		const brokenPath = await writeModule("broken.js", 'throw new Error("boom at import time");\n');
		const okPath = await writeModule(
			"ok.js",
			`export default function okExtension() {
	globalThis.${STATE_KEY}.events.push("ok:factory");
}
`,
		);
		extensionGlobal[STATE_KEY] = {
			events: [],
			slowImportGate: Promise.resolve(),
			slowFactoryGate: Promise.resolve(),
			markFastImported: () => {},
			markSlowImportStarted: () => {},
			markSlowFactoryStarted: () => {},
		};

		const result = await loadExtensions([brokenPath, okPath], project!.path());

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ path: brokenPath });
		expect(result.errors[0]?.error).toContain("boom at import time");
		expect(result.extensions.map(extension => extension.path)).toEqual([okPath]);
		expect(extensionGlobal[STATE_KEY]?.events).toEqual(["ok:factory"]);
	});

	it("rolls back provider registrations from a failed factory and continues in order", async () => {
		const firstPath = await writeModule(
			"first.js",
			`export default function firstExtension(pi) {
	pi.registerProvider("before", { baseUrl: "https://before.invalid/v1" });
}
`,
		);
		const brokenPath = await writeModule(
			"broken-factory.js",
			`export default function brokenExtension(pi) {
	pi.unregisterProvider("before");
	pi.registerProvider("leaked", { baseUrl: "https://leaked.invalid/v1" });
	throw new Error("boom in factory");
}
`,
		);
		const lastPath = await writeModule(
			"last.js",
			`export default function lastExtension(pi) {
	pi.registerProvider("after", { baseUrl: "https://after.invalid/v1" });
}
`,
		);

		const result = await loadExtensions([firstPath, brokenPath, lastPath], project!.path());

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ path: brokenPath });
		expect(result.errors[0]?.error).toContain("boom in factory");
		expect(result.extensions.map(extension => extension.path)).toEqual([firstPath, lastPath]);
		expect(result.runtime.pendingProviderRegistrations.map(registration => registration.name)).toEqual([
			"before",
			"after",
		]);
	});
});
