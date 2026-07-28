import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);
export type CodingAgentBuildProfile = "full" | "core";

const CORE_EXCLUDED_MODULE_NAMESPACE = "san-core-excluded-module";

interface CoreExcludedModule {
	readonly filter: RegExp;
	readonly loader: "js" | "ts";
	readonly contents: string;
}

const CORE_EXCLUDED_MODULES: readonly CoreExcludedModule[] = [
	{
		filter: /(?:^|[\\/])export[\\/]html$/,
		loader: "js",
		contents: `
export function exportFromFile() {
	throw new Error("HTML export is not included in the San core binary; use the full binary.");
}
export function exportSessionToHtml() {
	throw new Error("HTML export is not included in the San core binary; use the full binary.");
}
`,
	},
	{
		loader: "ts",
		filter: /^\.\/converters\/pdf$/,
		contents: `
import type { ConversionResult, Converter, StreamInfo } from "../../types";

const CORE_PDF_ERROR =
	"PDF conversion is not included in the San core binary; use the full binary or a dedicated PDF reader.";

export class PdfConverter implements Converter {
	name = "pdf";

	accepts(streamInfo: StreamInfo): boolean {
		return streamInfo.extension === ".pdf" || streamInfo.mimetype?.startsWith("application/pdf") === true ||
			streamInfo.mimetype?.startsWith("application/x-pdf") === true;
	}

	async convert(): Promise<ConversionResult> {
		throw new Error(CORE_PDF_ERROR);
	}
}
`,
	},
];

function createCoreExcludedModulePlugin(): Bun.BunPlugin {
	return {
		name: "san:core-excluded-modules",
		setup(build) {
			for (const [index, module] of CORE_EXCLUDED_MODULES.entries()) {
				const namespace = `${CORE_EXCLUDED_MODULE_NAMESPACE}-${index}`;
				build.onResolve({ filter: module.filter }, args => ({ path: args.path, namespace }));
				build.onLoad({ filter: /.*/, namespace }, () => ({ contents: module.contents, loader: module.loader }));
			}
		},
	};
}

const CORE_MODELS_FILTER = /(?:^|[\\/])packages[\\/]catalog[\\/]src[\\/]models\.json$/;

function createCoreModelCatalogPlugin(): Bun.BunPlugin {
	return {
		name: "san:core-model-catalog",
		setup(build) {
			build.onLoad({ filter: CORE_MODELS_FILTER }, async args => {
				const compressed = Buffer.from(Bun.gzipSync(await Bun.file(args.path).bytes(), { level: 9 })).toString(
					"base64",
				);
				return {
					contents: `export default ${JSON.stringify(compressed)};`,
					loader: "js",
				};
			});
		},
	};
}

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Binary feature profile. Full preserves all compatibility surfaces; core keeps daily coding paths only. */
	readonly buildProfile?: CodingAgentBuildProfile;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Match release builds that minify identifiers while retaining names. Core builds always enable all safe minifiers. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
	/** Optional JSON path for Bun's compile-time module graph. */
	readonly metafilePath?: string;
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const buildProfile = options.buildProfile ?? "full";
	const docsEmbed = buildProfile === "full" ? (await buildDocsIndexPayload()).payload : "";
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			metafile: options.metafilePath !== undefined,
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.SAN_BUILD_PROFILE": JSON.stringify(buildProfile),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docsEmbed),
			},
			minify: {
				identifiers: buildProfile === "core" || (options.minifyIdentifiers ?? false),
				syntax: buildProfile === "core",
				whitespace: buildProfile === "core",
				keepNames: true,
			},
			plugins: [
				...(buildProfile === "core" ? [createCoreExcludedModulePlugin(), createCoreModelCatalogPlugin()] : []),
				await createLegacyPiVirtualModulePlugin(),
			],
			compile: {
				...(options.target ? { target: options.target } : {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
		if (options.metafilePath && output.metafile) {
			await Bun.write(options.metafilePath, JSON.stringify(output.metafile, null, 2));
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
