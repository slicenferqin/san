/**
 * Setup CLI command handler.
 *
 * Handles `san setup` for onboarding and `san setup <component>` for optional dependencies.
 */

import * as path from "node:path";
import { $which, APP_NAME, getPythonEnvDir } from "@san/utils";
import { $ } from "bun";
import chalk from "chalk";
import { checkCodeGraphSetup, isCodeGraphLocallyUsable } from "../code-intelligence/codegraph-installation";
import { Settings } from "../config/settings";

export type SetupComponent = "python" | "codegraph";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "codegraph"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(): Promise<PythonCheckResult> {
	const result: PythonCheckResult = {
		available: false,
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	const pythonPath = systemPythonPath ?? (hasManagedEnv ? managedPath : undefined);
	if (!pythonPath) {
		return result;
	}
	const probe = await $`${pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow();
	result.pythonPath = pythonPath;
	result.available = probe.exitCode === 0;
	result.usingManagedEnv = pythonPath === managedPath;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `san setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "codegraph":
			await handleCodeGraphSetup(cmd.flags);
			break;
	}
}
async function handleCodeGraphSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const [check, effectiveSettings] = await Promise.all([
		checkCodeGraphSetup(process.cwd()),
		Settings.loadReadOnly({ cwd: process.cwd() }),
	]);
	const usable = isCodeGraphLocallyUsable(check);
	const exploreEnabled = effectiveSettings.get("san.codeIntelligence.enabled");
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ ...check, exploreEnabled }, null, 2)}\n`);
		if (!usable) process.exitCode = 1;
		return;
	}

	if (check.state === "missing") {
		process.stdout.write("CodeGraph: not installed\n");
		process.stdout.write("Local Explore backend: LSP/AST/text fallback\n");
		process.stdout.write("Optional install: npm i -g @colbymchenry/codegraph\n");
		process.stdout.write("Then initialize this project: codegraph init .\n");
	} else if (check.state === "unindexed") {
		process.stdout.write(`CodeGraph: ${check.version ?? "installed"}\n`);
		process.stdout.write("Index: not initialized for this project\n");
		process.stdout.write("Local Explore backend: LSP/AST/text fallback\n");
		process.stdout.write("Initialize: codegraph init .\n");
	} else if (check.state === "ready") {
		const root = check.indexRoot ? path.relative(process.cwd(), check.indexRoot) || "." : ".";
		const indexPath = root === "." ? ".codegraph" : path.join(root, ".codegraph");
		process.stdout.write(`CodeGraph: ${check.version ?? "installed"}\n`);
		process.stdout.write(`Index: ready at ${indexPath}\n`);
		process.stdout.write("Local backend: CodeGraph\n");
	} else if (check.state === "pending") {
		const pending = check.pendingChanges ?? { added: 0, modified: 0, removed: 0 };
		process.stdout.write(`CodeGraph: ${check.version ?? "installed"}\n`);
		process.stdout.write(
			`Index: pending (${pending.added} added, ${pending.modified} modified, ${pending.removed} removed)\n`,
		);
		process.stdout.write(
			"Local Explore backend: CodeGraph; current source is re-read and graph relationships are advisory\n",
		);
		process.stdout.write("Refresh: codegraph sync .\n");
	} else if (check.state === "stale") {
		process.stdout.write(`CodeGraph: ${check.version ?? "installed"}\n`);
		process.stdout.write("Index: stale (worktree mismatch)\n");
		process.stdout.write(
			"Local Explore backend: CodeGraph; current source is re-read and graph relationships are advisory\n",
		);
		process.stdout.write("Rebuild: codegraph index --force .\n");
	} else {
		process.stderr.write(`CodeGraph status check failed: ${check.error ?? "unknown error"}\n`);
		process.stdout.write("Local Explore backend: LSP/AST/text fallback\n");
		process.stdout.write("Diagnose: codegraph status --json .\n");
	}

	if (exploreEnabled) {
		process.stdout.write("Explore tool: enabled\n");
	} else {
		process.stdout.write("Explore tool: disabled\n");
		process.stdout.write(`Enable: ${APP_NAME} config set san.codeIntelligence.enabled true\n`);
	}

	if (!usable) process.exitCode = 1;
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const check = await checkPythonSetup();

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red("Python not found"));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green("\nPython execution is ready"));
		return;
	}

	console.error(chalk.red("\nPython interpreter reported failure"));
	process.exit(1);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Run onboarding or check optional dependencies

${chalk.bold("Usage:")}
  ${APP_NAME} setup                     Run the onboarding wizard
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  python       Verify a Python 3 interpreter is reachable for code execution
  codegraph    Verify the optional CodeGraph CLI and current project index

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup                       Run the onboarding wizard
  ${APP_NAME} setup python --check        Check if Python execution is available
  ${APP_NAME} setup codegraph --check     Check the local CodeGraph/index backend
  ${APP_NAME} setup codegraph --check --json
`);
}
