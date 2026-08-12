import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@san/coding-agent/discovery";
import { getManagedSkillsDir } from "@san/coding-agent/autolearn/managed-skills";
import { buildSkillPromptMessage, loadSkills, loadSkillsFromDir } from "@san/coding-agent/extensibility/skills";
import { removeWithRetries, Snowflake } from "@san/utils";
import { getAgentDir, setAgentDir } from "@san/utils/dirs";
import buildWebContent from "../src/extensibility/builtin-skills/build-web.md" with { type: "text" };
import fixBugContent from "../src/extensibility/builtin-skills/fix-bug.md" with { type: "text" };

async function writeSkillFile(root: string, name: string, frontmatter: string[], body = `# ${name}`): Promise<string> {
	const file = path.join(root, name, "SKILL.md");
	await Bun.write(file, ["---", ...frontmatter, "---", "", body, ""].join("\n"));
	return file;
}

describe("skill evidence frontmatter parsing", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), `san-skill-evidence-${Snowflake.next()}-`));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("parses a valid evidence chain into structured specs (kebab-case same-as included)", async () => {
		await writeSkillFile(root, "with-evidence", [
			"name: with-evidence",
			"description: Valid evidence chain.",
			"evidence:",
			"  - id: repro",
			"    phase: before-fix",
			"    kind: command",
			"    expect: fail",
			"    description: minimal failing command",
			"  - id: verify",
			"    phase: before-done",
			"    kind: command",
			"    expect: pass",
			"    same-as: repro",
			"    description: same command flips to passing",
		]);

		const { skills, warnings } = await loadSkillsFromDir({ dir: root, source: "test" });
		expect(warnings).toHaveLength(0);
		const skill = skills.find(s => s.name === "with-evidence");
		expect(skill?.evidence).toEqual([
			{
				id: "repro",
				phase: "before-fix",
				kind: "command",
				expect: "fail",
				description: "minimal failing command",
			},
			{
				id: "verify",
				phase: "before-done",
				kind: "command",
				expect: "pass",
				sameAs: "repro",
				description: "same command flips to passing",
			},
		]);
	});

	it("keeps skills without an evidence section exactly as before", async () => {
		await writeSkillFile(root, "plain", ["name: plain", "description: No evidence here."]);

		const { skills, warnings } = await loadSkillsFromDir({ dir: root, source: "test" });
		const skill = skills.find(s => s.name === "plain");
		expect(skill).toBeDefined();
		expect(skill?.evidence).toBeUndefined();
		expect(warnings).toHaveLength(0);
	});

	it.each([
		{
			label: "duplicate id",
			lines: [
				"  - id: repro",
				"    phase: before-fix",
				"    kind: command",
				"    expect: fail",
				"    description: first",
				"  - id: repro",
				"    phase: before-done",
				"    kind: command",
				"    expect: pass",
				"    description: second",
			],
			reason: 'duplicates id "repro"',
		},
		{
			label: "unknown phase",
			lines: [
				"  - id: repro",
				"    phase: during-fix",
				"    kind: command",
				"    expect: fail",
				"    description: bad phase",
			],
			reason: "unknown phase",
		},
		{
			label: "unknown kind",
			lines: [
				"  - id: repro",
				"    phase: before-fix",
				"    kind: telepathy",
				"    expect: fail",
				"    description: bad kind",
			],
			reason: "unknown kind",
		},
		{
			label: "dangling sameAs",
			lines: [
				"  - id: verify",
				"    phase: before-done",
				"    kind: command",
				"    expect: pass",
				"    sameAs: missing",
				"    description: dangling reference",
			],
			reason: 'sameAs references unknown id "missing"',
		},
		{
			label: "self-referencing sameAs",
			lines: [
				"  - id: verify",
				"    phase: before-done",
				"    kind: command",
				"    expect: pass",
				"    sameAs: verify",
				"    description: self reference",
			],
			reason: "sameAs must reference another spec",
		},
	])("drops the whole evidence section on $label but keeps the skill usable", async ({ lines, reason }) => {
		const skillPath = await writeSkillFile(root, "broken-evidence", [
			"name: broken-evidence",
			"description: Broken evidence chain.",
			"evidence:",
			...lines,
		]);

		const { skills, warnings } = await loadSkillsFromDir({ dir: root, source: "test" });
		const skill = skills.find(s => s.name === "broken-evidence");
		// Skill itself stays loaded and reachable — a YAML mistake never kills the skill.
		expect(skill).toBeDefined();
		expect(skill?.description).toBe("Broken evidence chain.");
		expect(skill?.evidence).toBeUndefined();
		const warning = warnings.find(w => w.message.includes("invalid evidence declaration"));
		expect(warning?.skillPath).toBe(skillPath);
		expect(warning?.message).toContain(reason);
	});
});

describe("autoload prompt rendering with evidence", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), `san-skill-render-${Snowflake.next()}-`));
		filePath = path.join(dir, "SKILL.md");
		await Bun.write(filePath, "---\nname: render-me\ndescription: Render test.\n---\n\n# Render Me\n\nBody line.\n");
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	it("renders evidence requirements grouped by phase", async () => {
		const built = await buildSkillPromptMessage(
			{
				name: "render-me",
				filePath,
				baseDir: dir,
				evidence: [
					{ id: "repro", phase: "before-fix", kind: "command", expect: "fail", description: "failing repro" },
					{
						id: "verify",
						phase: "before-done",
						kind: "command",
						expect: "pass",
						sameAs: "repro",
						description: "same path passes",
					},
					{
						id: "regression",
						phase: "before-done",
						kind: "command",
						expect: "pass",
						description: "impacted tests stay green",
					},
				],
			},
			"",
			"autoload",
		);

		expect(built.message).toContain("Evidence requirements declared by this skill.");
		expect(built.message).toContain(
			"- Phase `before-fix` (this evidence MUST exist before you start modifying anything):",
		);
		expect(built.message).toContain("- Phase `before-done` (this evidence MUST exist before you report completion):");
		expect(built.message).toContain("  - `repro` [command] expected outcome: fail — failing repro");
		expect(built.message).toContain(
			"  - `verify` [command] expected outcome: pass — same path passes (MUST reuse the exact same command/path as `repro`; do not substitute a different check)",
		);
		expect(built.message).toContain("  - `regression` [command] expected outcome: pass — impacted tests stay green");
		// Phase groups keep the fixed before-fix -> before-done order.
		expect(built.message.indexOf("Phase `before-fix`")).toBeLessThan(built.message.indexOf("Phase `before-done`"));
		// The evidence block renders between the body and the provenance footer.
		expect(built.message.indexOf("Body line.")).toBeLessThan(built.message.indexOf("Evidence requirements"));
		expect(built.message.indexOf("Evidence requirements")).toBeLessThan(built.message.indexOf("---"));
	});

	it("renders skills without evidence byte-identically to the pre-evidence format", async () => {
		const built = await buildSkillPromptMessage({ name: "render-me", filePath, baseDir: dir }, "", "autoload");

		expect(built.message).toBe(
			[
				"[Host runtime: San. Platform-specific defaults MUST target San. Only an explicit user request may select another or multiple runtimes; skill paths and project markers NEVER override the host runtime.]",
				"",
				"# Render Me",
				"",
				"Body line.",
				"",
				"---",
				"",
				`Skill: ${filePath}`,
			].join("\n"),
		);
	});
});

describe("builtin skills loading", () => {
	let tempHome: string;
	let tempCwd: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "san-builtin-skills-home-"));
		// cwd lives under the fake home so the ancestor walk stays bounded (full-suite-safe).
		tempCwd = path.join(tempHome, "work");
		await fs.mkdir(tempCwd, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".san", "agent"));
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("loads fix-bug and build-web with parsed evidence and materialized files", async () => {
		const { skills, warnings } = await loadSkills({ cwd: tempCwd });

		const fixBug = skills.find(s => s.name === "fix-bug");
		expect(fixBug?.source).toBe("san-builtin:user");
		expect(fixBug?.evidence?.map(spec => spec.id)).toEqual(["repro", "verify", "regression"]);
		const verify = fixBug?.evidence?.find(spec => spec.id === "verify");
		expect(verify).toMatchObject({ phase: "before-done", kind: "command", expect: "pass", sameAs: "repro" });

		const buildWeb = skills.find(s => s.name === "build-web");
		expect(buildWeb?.source).toBe("san-builtin:user");
		expect(buildWeb?.evidence?.some(spec => spec.phase === "before-fix" && spec.kind === "review")).toBe(true);

		// No warnings may come from the builtin source itself: the bundled
		// declarations must always parse (guards against shipping a broken chain).
		expect(warnings.filter(w => w.skillPath.includes("builtin-skills"))).toHaveLength(0);

		// skill:// resolution and bash URL replacement read the skill from disk, so
		// the materialized file must exist and match the bundled content exactly.
		expect(fixBug?.filePath).toBe(path.join(getAgentDir(), "builtin-skills", "fix-bug", "SKILL.md"));
		expect(await Bun.file(fixBug!.filePath).text()).toBe(fixBugContent);
		expect(await Bun.file(buildWeb!.filePath).text()).toBe(buildWebContent);
	});

	it("injects the evidence chain when a builtin skill is autoloaded", async () => {
		const { skills } = await loadSkills({ cwd: tempCwd });
		const fixBug = skills.find(s => s.name === "fix-bug");
		expect(fixBug).toBeDefined();

		const built = await buildSkillPromptMessage(fixBug!, "", "autoload");
		expect(built.message).toContain("- Phase `before-fix`");
		expect(built.message).toContain("`repro` [command] expected outcome: fail");
		expect(built.message).toContain("MUST reuse the exact same command/path as `repro`");
	});

	it("lets a project-level skill with the same name override builtin", async () => {
		await writeSkillFile(
			path.join(tempCwd, ".san", "skills"),
			"fix-bug",
			["name: fix-bug", "description: Project override."],
			"# project fix-bug",
		);

		const { skills } = await loadSkills({ cwd: tempCwd });
		const matches = skills.filter(s => s.name === "fix-bug");
		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe("native:project");
		expect(matches[0].description).toBe("Project override.");
	});

	it("lets a user custom-directory skill with the same name override builtin", async () => {
		const customDir = path.join(tempHome, "custom-skills");
		await writeSkillFile(customDir, "build-web", ["name: build-web", "description: Custom override."]);

		const { skills } = await loadSkills({ cwd: tempCwd, customDirectories: [customDir] });
		const matches = skills.filter(s => s.name === "build-web");
		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe("custom:user");
	});

	it("keeps builtin ahead of managed for the same name", async () => {
		await writeSkillFile(getManagedSkillsDir(), "fix-bug", ["name: fix-bug", "description: Managed impostor."]);

		const { skills } = await loadSkills({ cwd: tempCwd });
		const matches = skills.filter(s => s.name === "fix-bug");
		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe("san-builtin:user");
	});

	it("materializes under an explicitly provided agentDir (SDK sessions pass their own)", async () => {
		const sessionAgentDir = path.join(tempHome, "session-agent");
		const { skills } = await loadSkills({ cwd: tempCwd, agentDir: sessionAgentDir });
		const fixBug = skills.find(s => s.name === "fix-bug");
		expect(fixBug?.filePath).toBe(path.join(sessionAgentDir, "builtin-skills", "fix-bug", "SKILL.md"));
		expect(await Bun.file(fixBug!.filePath).text()).toBe(fixBugContent);
	});

	it("honors ignoredSkills for individual builtin skills", async () => {
		const { skills } = await loadSkills({ cwd: tempCwd, ignoredSkills: ["fix-bug"] });
		expect(skills.some(s => s.name === "fix-bug")).toBe(false);
		expect(skills.some(s => s.name === "build-web")).toBe(true);
	});

	it("does not load or materialize anything when enableBuiltin is false", async () => {
		const { skills } = await loadSkills({ cwd: tempCwd, enableBuiltin: false });
		expect(skills.some(s => s.source.startsWith("san-builtin"))).toBe(false);
		const dirExists = await fs.stat(path.join(getAgentDir(), "builtin-skills")).then(
			() => true,
			() => false,
		);
		expect(dirExists).toBe(false);
	});
});
