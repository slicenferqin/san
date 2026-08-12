/**
 * 内置（bundled）skill 来源。
 *
 * 内容通过 `import ... with { type: "text" }` 打包进模块图，编译后的二进制
 * 同样可用（不依赖运行时目录扫描）。加载时把内容幂等物化到
 * `<agentDir>/builtin-skills/<name>/SKILL.md`：`skill://<name>`、bash 的
 * skill URL 替换与 read 工具都假设 skill 是磁盘上的真实文件，物化让所有
 * 既有消费路径无需特判。
 *
 * 优先级最低于一切 authored 来源（user/project/custom 同名覆盖 builtin），
 * 但高于 managed（自动生成的 skill 不得顶替内置的精编 skill）——接线见
 * `skills.ts` 的 `loadSkills`。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@san/utils";
import { compareSkillOrder } from "../discovery/helpers";
import buildWebContent from "./builtin-skills/build-web.md" with { type: "text" };
import fixBugContent from "./builtin-skills/fix-bug.md" with { type: "text" };
import { extractSkillEvidence } from "./skill-evidence";
import type { LoadSkillsResult, Skill, SkillWarning } from "./skills";

/** Provider id stamped on builtin skills (distinguishes them from authored/managed). */
export const BUILTIN_SKILLS_PROVIDER_ID = "san-builtin";

const BUILTIN_SKILL_CONTENTS: ReadonlyMap<string, string> = new Map([
	["fix-bug", fixBugContent],
	["build-web", buildWebContent],
]);

/** Resolve the builtin-skills materialization directory (`~/.san/agent/builtin-skills`). */
export function getBuiltinSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "builtin-skills");
}

/**
 * 把打包内容写到目标路径（仅在缺失或内容变化时写）。目标已存在但不是普通
 * 文件（如符号链接）时拒绝写入，避免经由链接覆盖到目录之外。
 * 返回警告消息；成功时返回 undefined。
 */
async function materializeSkillFile(filePath: string, content: string): Promise<string | undefined> {
	try {
		const stat = await fs.lstat(filePath).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (stat) {
			if (!stat.isFile()) {
				return `builtin skill target exists but is not a regular file; skipping: ${filePath}`;
			}
			const existing = await Bun.file(filePath).text();
			if (existing === content) return undefined;
		}
		await Bun.write(filePath, content);
		return undefined;
	} catch (error) {
		return `failed to materialize builtin skill ${filePath}: ${String(error)}`;
	}
}

/**
 * 加载内置 skill：物化到磁盘并返回可直接进入 skillMap 的 `Skill` 条目。
 * 物化失败的条目整体跳过（消费路径需要真实文件），以 SkillWarning 报告。
 */
export async function loadBuiltinSkills(agentDir: string = getAgentDir()): Promise<LoadSkillsResult> {
	const dir = getBuiltinSkillsDir(agentDir);
	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];

	await Promise.all(
		[...BUILTIN_SKILL_CONTENTS].map(async ([dirName, content]) => {
			const filePath = path.join(dir, dirName, "SKILL.md");
			const failure = await materializeSkillFile(filePath, content);
			if (failure) {
				warnings.push({ skillPath: filePath, message: failure });
				return;
			}
			// 打包内容是权威来源：frontmatter 从内嵌文本解析，不回读磁盘。
			const { frontmatter } = parseFrontmatter(content, { source: filePath });
			const rawName = frontmatter.name;
			const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : dirName;
			const { evidence, warnings: evidenceWarnings } = extractSkillEvidence(frontmatter, filePath);
			warnings.push(...evidenceWarnings);
			skills.push({
				name,
				description: typeof frontmatter.description === "string" ? frontmatter.description : "",
				filePath,
				baseDir: path.dirname(filePath),
				source: `${BUILTIN_SKILLS_PROVIDER_ID}:user`,
				hide: frontmatter.hide === true || frontmatter.disableModelInvocation === true,
				...(evidence ? { evidence } : {}),
				_source: {
					provider: BUILTIN_SKILLS_PROVIDER_ID,
					providerName: "San Builtin",
					path: filePath,
					level: "user",
				},
			});
		}),
	);

	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return { skills, warnings };
}
