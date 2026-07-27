import { countTokens } from "@san/agent";
import { Settings } from "@san/coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@san/coding-agent/modes/utils/context-usage";
import { buildSystemPrompt } from "@san/coding-agent/system-prompt";
import { BUILTIN_TOOLS, createTools, type Tool, type ToolSession } from "@san/coding-agent/tools";

interface ToolTokenRow {
	name: string;
	loadMode: Tool["loadMode"];
	descriptionBytes: number;
	tokens: number;
}

interface ToolGroupMeasurement {
	count: number;
	tokens: number;
	tools: ToolTokenRow[];
}

interface PromptTokenMeasurement {
	cwd: string;
	xdev: {
		enabled: boolean;
		docsMode: "full" | "catalog";
		deviceCount: number;
		docs: {
			tokens: number;
			bytes: number;
		};
	};
	groups: {
		topLevelBuiltins: ToolGroupMeasurement;
		xdevBuiltins: ToolGroupMeasurement;
		allAvailableBuiltins: ToolGroupMeasurement;
	};
	systemPrompt: {
		tokens: number;
		bytes: number;
	};
	systemContext: {
		tokens: number;
		bytes: number;
	};
	fixedInput: {
		tokens: number;
	};
}

function createSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function toolRows(tools: readonly Tool[]): ToolTokenRow[] {
	return tools
		.map(tool => ({
			name: tool.name,
			loadMode: tool.loadMode,
			descriptionBytes: Buffer.byteLength(tool.description ?? "", "utf-8"),
			tokens: estimateToolSchemaTokens([tool]),
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

function toolGroup(tools: readonly Tool[]): ToolGroupMeasurement {
	return {
		count: tools.length,
		tokens: estimateToolSchemaTokens(tools),
		tools: toolRows(tools),
	};
}

function printRows(label: string, tools: readonly Tool[]): void {
	console.log(`${label} (${tools.length} tools, ${estimateToolSchemaTokens(tools)} tokens)`);
	console.log("  name                 mode            tokens  description bytes");
	for (const row of toolRows(tools)) {
		console.log(
			`  ${row.name.padEnd(20)} ${(row.loadMode ?? "unclassified").padEnd(15)} ${String(row.tokens).padStart(6)}  ${String(row.descriptionBytes).padStart(17)}`,
		);
	}
	console.log();
}

const args = Bun.argv.slice(2);
const jsonOutput = args.includes("--json");
const unsupportedArgs = args.filter(arg => arg !== "--json");
if (unsupportedArgs.length > 0) {
	throw new Error(`Unsupported arguments: ${unsupportedArgs.join(", ")}. Supported: --json`);
}

const cwd = process.cwd();
const settings = await Settings.loadReadOnly({ cwd });
const initialSession = createSession(cwd, settings);
const topLevelTools = await createTools(initialSession);
const xdevTools = initialSession.xdevRegistry?.list() ?? [];
const xdevEntries = initialSession.xdevRegistry?.entries() ?? [];
const xdevDocsMode = settings.get("tools.xdevDocs");
const xdevDocs = initialSession.xdevRegistry?.docsAll(xdevDocsMode) ?? "";

const allAvailableSession = createSession(cwd, settings);
const allAvailableTools = await createTools(allAvailableSession, Object.keys(BUILTIN_TOOLS));

const toolsMap = new Map<string, Tool>(topLevelTools.map(tool => [tool.name, tool]));
const built = await buildSystemPrompt({
	tools: toolsMap,
	toolNames: topLevelTools.map(tool => tool.name),
	inlineToolDescriptors: false,
	nativeTools: true,
	cwd,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	xdevTools: xdevEntries,
	xdevDocs,
});
const part0 = built.systemPrompt[0] ?? "";
const rest = built.systemPrompt.slice(1).join("\n");
const topLevelSchemaTokens = estimateToolSchemaTokens(topLevelTools);
const measurement: PromptTokenMeasurement = {
	cwd,
	xdev: {
		enabled: settings.get("tools.xdev"),
		docsMode: xdevDocsMode,
		deviceCount: xdevTools.length,
		docs: {
			tokens: countTokens(xdevDocs),
			bytes: Buffer.byteLength(xdevDocs, "utf-8"),
		},
	},
	groups: {
		topLevelBuiltins: toolGroup(topLevelTools),
		xdevBuiltins: toolGroup(xdevTools),
		allAvailableBuiltins: toolGroup(allAvailableTools),
	},
	systemPrompt: {
		tokens: countTokens(part0),
		bytes: Buffer.byteLength(part0, "utf-8"),
	},
	systemContext: {
		tokens: countTokens(rest),
		bytes: Buffer.byteLength(rest, "utf-8"),
	},
	fixedInput: {
		tokens: countTokens(part0) + countTokens(rest) + topLevelSchemaTokens,
	},
};

if (jsonOutput) {
	console.log(JSON.stringify(measurement, null, 2));
} else {
	console.log(`cwd: ${cwd}`);
	console.log(
		`xd:// transport: ${measurement.xdev.enabled ? "enabled" : "disabled"} (${measurement.xdev.docsMode} docs)`,
	);
	console.log(`xd:// embedded docs: ${measurement.xdev.docs.tokens} tokens  (bytes=${measurement.xdev.docs.bytes})\n`);
	printRows("TOP-LEVEL BUILTINS", topLevelTools);
	printRows("XD:// BUILTINS", xdevTools);
	printRows("ALL AVAILABLE BUILTINS", allAvailableTools);
	console.log(
		`SYSTEM PROMPT tokens (no skills): ${measurement.systemPrompt.tokens}  (bytes=${measurement.systemPrompt.bytes})`,
	);
	console.log(
		`SYSTEM CONTEXT tokens: ${measurement.systemContext.tokens}  (bytes=${measurement.systemContext.bytes})`,
	);
	console.log(`FIXED INPUT tokens (system + native tool schemas): ${measurement.fixedInput.tokens}`);
}
