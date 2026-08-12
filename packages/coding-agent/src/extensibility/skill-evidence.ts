/**
 * SKILL.md frontmatter `evidence` 段的解析与校验。
 *
 * 校验失败时整段丢弃并产出原因（进入 SkillWarning 通道），skill 本体仍正常
 * 可用 — 作者的 YAML 失误不能炸掉 skill。无 `evidence` 段的 skill 行为与
 * 引入该特性前完全一致。
 */
import type { EvidenceVerifierKind, SkillEvidencePhase, SkillEvidenceSpec } from "../execution-control/types";
import type { SkillWarning } from "./skills";

/** Record 形式的枚举查表：新增 kind/phase 时由类型系统强制补全。 */
const EVIDENCE_KIND_LOOKUP: Record<EvidenceVerifierKind, true> = {
	command: true,
	browser: true,
	api: true,
	artifact: true,
	review: true,
	external: true,
};

const EVIDENCE_PHASE_LOOKUP: Record<SkillEvidencePhase, true> = {
	"before-fix": true,
	"before-done": true,
};

const EVIDENCE_EXPECT_LOOKUP: Record<SkillEvidenceSpec["expect"], true> = {
	pass: true,
	fail: true,
};

function isEvidenceKind(value: unknown): value is EvidenceVerifierKind {
	return typeof value === "string" && value in EVIDENCE_KIND_LOOKUP;
}

function isEvidencePhase(value: unknown): value is SkillEvidencePhase {
	return typeof value === "string" && value in EVIDENCE_PHASE_LOOKUP;
}

function isEvidenceExpect(value: unknown): value is SkillEvidenceSpec["expect"] {
	return typeof value === "string" && value in EVIDENCE_EXPECT_LOOKUP;
}

function enumValues(lookup: Record<string, true>): string {
	return Object.keys(lookup).join("|");
}

/** 折叠多行/多余空白，保证渲染进 prompt 的说明是单行。 */
function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export interface ParsedSkillEvidence {
	/** 校验通过的证据链；缺失或非法时为 undefined。 */
	evidence?: readonly SkillEvidenceSpec[];
	/** 整段被丢弃的具体原因；合法或缺失时为空。 */
	issues: string[];
}

/**
 * 解析 frontmatter 中的 `evidence` 值。任何一环非法则整段丢弃（sameAs 使链
 * 内声明互相依赖，残链会误导模型），并返回全部问题原因。
 */
export function parseSkillEvidenceValue(raw: unknown): ParsedSkillEvidence {
	if (raw === undefined || raw === null) return { issues: [] };
	if (!Array.isArray(raw)) {
		return { issues: [`evidence must be a list of specs, got ${typeof raw}`] };
	}
	if (raw.length === 0) return { issues: [] };

	const issues: string[] = [];
	const specs: SkillEvidenceSpec[] = [];
	const seenIds = new Set<string>();

	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		const label = `evidence[${i}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			issues.push(`${label} must be a mapping with id/phase/kind/expect/description`);
			continue;
		}
		const record = entry as Record<string, unknown>;

		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) {
			issues.push(`${label} is missing a non-empty string "id"`);
		} else if (seenIds.has(id)) {
			issues.push(`${label} duplicates id "${id}"`);
		} else {
			seenIds.add(id);
		}

		if (!isEvidencePhase(record.phase)) {
			issues.push(
				`${label} has unknown phase ${JSON.stringify(record.phase)} (expected ${enumValues(EVIDENCE_PHASE_LOOKUP)})`,
			);
		}
		if (!isEvidenceKind(record.kind)) {
			issues.push(
				`${label} has unknown kind ${JSON.stringify(record.kind)} (expected ${enumValues(EVIDENCE_KIND_LOOKUP)})`,
			);
		}
		if (!isEvidenceExpect(record.expect)) {
			issues.push(
				`${label} has unknown expect ${JSON.stringify(record.expect)} (expected ${enumValues(EVIDENCE_EXPECT_LOOKUP)})`,
			);
		}

		const description = typeof record.description === "string" ? collapseWhitespace(record.description) : "";
		if (!description) {
			issues.push(`${label} is missing a non-empty string "description"`);
		}

		let sameAs: string | undefined;
		if (record.sameAs !== undefined) {
			if (typeof record.sameAs !== "string" || !record.sameAs.trim()) {
				issues.push(`${label} has a non-string "sameAs"`);
			} else {
				sameAs = record.sameAs.trim();
			}
		}

		if (issues.length > 0) continue;
		specs.push({
			id,
			phase: record.phase as SkillEvidencePhase,
			kind: record.kind as EvidenceVerifierKind,
			expect: record.expect as SkillEvidenceSpec["expect"],
			...(sameAs !== undefined ? { sameAs } : {}),
			description,
		});
	}

	if (issues.length === 0) {
		for (const spec of specs) {
			if (spec.sameAs === undefined) continue;
			if (spec.sameAs === spec.id) {
				issues.push(`evidence "${spec.id}" sameAs must reference another spec, not itself`);
			} else if (!seenIds.has(spec.sameAs)) {
				issues.push(`evidence "${spec.id}" sameAs references unknown id "${spec.sameAs}"`);
			}
		}
	}

	if (issues.length > 0) return { issues };
	return { evidence: specs, issues: [] };
}

/**
 * 从 skill frontmatter 提取 evidence 声明。非法声明整段丢弃并转成带
 * skillPath 的 {@link SkillWarning}；无 `evidence` 键时零开销直通。
 */
export function extractSkillEvidence(
	frontmatter: Record<string, unknown> | undefined,
	skillPath: string,
): { evidence?: readonly SkillEvidenceSpec[]; warnings: SkillWarning[] } {
	const raw = frontmatter?.evidence;
	if (raw === undefined) return { warnings: [] };
	const parsed = parseSkillEvidenceValue(raw);
	if (parsed.issues.length > 0) {
		return {
			warnings: parsed.issues.map(issue => ({
				skillPath,
				message: `invalid evidence declaration (section dropped): ${issue}`,
			})),
		};
	}
	return parsed.evidence !== undefined ? { evidence: parsed.evidence, warnings: [] } : { warnings: [] };
}

/** 按 phase 分组后的证据链，供注入模板渲染。 */
export interface SkillEvidencePhaseGroup {
	phase: SkillEvidencePhase;
	/** 模板据此渲染 phase 的语义提示（提示文案留在模板内，不进代码）。 */
	isBeforeFix: boolean;
	isBeforeDone: boolean;
	specs: readonly SkillEvidenceSpec[];
}

const PHASE_ORDER: readonly SkillEvidencePhase[] = ["before-fix", "before-done"];

/** 把证据链按固定 phase 顺序分组；无证据时返回 undefined（模板条件段不渲染）。 */
export function groupSkillEvidenceByPhase(
	evidence: readonly SkillEvidenceSpec[] | undefined,
): readonly SkillEvidencePhaseGroup[] | undefined {
	if (!evidence?.length) return undefined;
	const groups = PHASE_ORDER.map(phase => ({
		phase,
		isBeforeFix: phase === "before-fix",
		isBeforeDone: phase === "before-done",
		specs: evidence.filter(spec => spec.phase === phase),
	})).filter(group => group.specs.length > 0);
	return groups.length > 0 ? groups : undefined;
}
